// Bundled window/layer animation plugin. Claims three namespaces at the
// priority floor; a user plugin claiming any of them at a higher priority
// displaces the corresponding seams wholesale (each activation callback
// registers its handlers, so a displaced claim registers nothing and
// there is no double-animation):
//
//   window-opening    OPEN: window.opening (intercept) fires at first
//                     content with the opening gate engaged, so the
//                     window is held out of the draw stack until we
//                     release it. Tiled windows slide in from the
//                     nearest output edge; floating windows fade/scale
//                     in. Claiming the namespace is what activates the
//                     opening driver at all.
//   window-closing    CLOSE: window.closing (subscribe) receives the
//                     phantom the closing-driver minted from the
//                     window's last visible state. Tiled phantoms slide
//                     out toward the nearest edge; floating ones
//                     fade/scale out; the phantom is destroyed when
//                     done. Claiming activates the driver.
//   window-animations RETILE + LAYER GLIDE: the geometry seams.
//                     window.relayout presnaps immediately-applied rect
//                     changes; stack.relayout-apply presnaps
//                     transaction-held (reorder / param-changed)
//                     batches as they land; layer.resize-announce +
//                     layer.relayout run the two-phase layer-resize
//                     glide (start toward the announced rect before the
//                     client renders; re-base onto the new rect when
//                     the buffer lands). compose:"relative" keeps every
//                     retarget continuous from the current value.
//
// Config (the `animations` slice of config.mjs): `enabled` false skips
// every claim (no gates engaged, no phantoms minted -- windows pop and
// layer resizes step). `window.duration`/`window.easing` drive
// open/close/retile; `layer.{enabled,duration,easing}` drive the glide.
// An easing is a CSS preset name or {x1, y1, x2, y2} cubic-bezier
// points; the layer default mirrors a Hyprland-style easeOutQuint.
//
// sdk.animations.start(spec) resolves once core has registered the
// animation and applied its `from` value, so awaiting it is the
// ordering primitive: for OPEN, the start value is live before the gate
// releases; for the geometry seams, before the interceptor resolves and
// the emitter proceeds.

import { tween, target } from "@overdraw/sdk-anim";
import type { PluginSdkShape, PluginAnimationsLike } from "@overdraw/plugin-sdk-types";
import type { EasingSpec } from "@overdraw/animation-types";

interface Rect { x: number; y: number; width: number; height: number }

interface SeamConfig { duration: number; easing: EasingSpec }
interface AnimationsConfig {
  enabled: boolean;
  window: SeamConfig;
  layer: SeamConfig & { enabled: boolean };
}

const EASING_PRESETS = new Set(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]);
const DEFAULTS: AnimationsConfig = {
  enabled: true,
  window: { duration: 200, easing: "ease-out" },
  layer: {
    enabled: true,
    duration: 380,
    easing: { kind: "cubic-bezier", x1: 0.23, y1: 1, x2: 0.32, y2: 1 },
  },
};

function parseEasing(v: unknown, fallback: EasingSpec, warn: (m: string) => void): EasingSpec {
  if (v === undefined) return fallback;
  if (typeof v === "string") {
    if (EASING_PRESETS.has(v)) return v as EasingSpec;
    warn(`unknown easing preset '${v}'`);
    return fallback;
  }
  if (typeof v === "object" && v !== null) {
    const o = v as { x1?: unknown; y1?: unknown; x2?: unknown; y2?: unknown };
    if ([o.x1, o.y1, o.x2, o.y2].every((n) => typeof n === "number" && Number.isFinite(n))) {
      return {
        kind: "cubic-bezier",
        x1: o.x1 as number, y1: o.y1 as number,
        x2: o.x2 as number, y2: o.y2 as number,
      };
    }
  }
  warn("easing must be a preset name or {x1, y1, x2, y2}");
  return fallback;
}

function parseDuration(v: unknown, fallback: number, warn: (m: string) => void): number {
  if (v === undefined) return fallback;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  warn("duration must be a positive number of milliseconds");
  return fallback;
}

function validateConfig(raw: unknown, log: (m: string) => void): AnimationsConfig {
  const out: AnimationsConfig = {
    enabled: DEFAULTS.enabled,
    window: { ...DEFAULTS.window },
    layer: { ...DEFAULTS.layer },
  };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object") {
    log("window-animations: config must be an object; using defaults");
    return out;
  }
  const c = raw as { enabled?: unknown; window?: unknown; layer?: unknown };
  if (c.enabled !== undefined) {
    if (typeof c.enabled === "boolean") out.enabled = c.enabled;
    else log("window-animations: enabled must be a boolean");
  }
  if (c.window !== undefined && typeof c.window === "object" && c.window !== null) {
    const w = c.window as { duration?: unknown; easing?: unknown };
    out.window.duration = parseDuration(w.duration, out.window.duration,
      (m) => log(`window-animations: window.${m}`));
    out.window.easing = parseEasing(w.easing, out.window.easing,
      (m) => log(`window-animations: window.${m}`));
  }
  if (c.layer !== undefined && typeof c.layer === "object" && c.layer !== null) {
    const l = c.layer as { enabled?: unknown; duration?: unknown; easing?: unknown };
    if (l.enabled !== undefined) {
      if (typeof l.enabled === "boolean") out.layer.enabled = l.enabled;
      else log("window-animations: layer.enabled must be a boolean");
    }
    out.layer.duration = parseDuration(l.duration, out.layer.duration,
      (m) => log(`window-animations: layer.${m}`));
    out.layer.easing = parseEasing(l.easing, out.layer.easing,
      (m) => log(`window-animations: layer.${m}`));
  }
  return out;
}

// Slide distance for a tiled window: one tile-width toward/away from the
// output edge NEAREST the tile, so a left-half tile enters/exits left and
// a right-half tile enters/exits right. Keeps a newcomer's leading edge
// tracking a retiling sibling's vacating edge instead of crossing it.
function nearestEdgeSlideX(rect: Rect, outputRect: Rect): number {
  const tileCenter = rect.x + rect.width / 2;
  const outCenter = outputRect.x + outputRect.width / 2;
  return tileCenter < outCenter ? -rect.width : rect.width;
}

const IDENTITY = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default async function init(sdk: PluginSdkShape, rawConfig?: unknown): Promise<void> {
  const cfg = validateConfig(rawConfig, (m) => sdk.log(m));
  const anims = sdk.animations;
  if (!cfg.enabled || !anims) {
    // No claims: the opening/closing drivers stay inert (windows pop
    // in/out instantly) and the geometry seams apply without motion.
    sdk.log(`window-animations: disabled (${!anims ? "no animations capability" : "config"})`);
    return;
  }

  await sdk.registerPlugin("window-opening", () => {
    activateOpening(sdk, anims, cfg);
    return {};
  });
  await sdk.registerPlugin("window-closing", () => {
    activateClosing(sdk, anims, cfg);
    return {};
  });
  await sdk.registerPlugin("window-animations", () => {
    activateGeometry(sdk, anims, cfg);
    return {};
  });
  sdk.log("window-animations: registered");
}

// OPEN. The gate -- not event-await -- is the synchronization: the
// window does not draw until releaseOpeningGate, so the first visible
// frame is already mid-animation.
function activateOpening(
  sdk: PluginSdkShape, anims: PluginAnimationsLike, cfg: AnimationsConfig,
): void {
  const { duration, easing } = cfg.window;
  sdk.events.intercept("window.opening", async (_name, payload) => {
    const ev = payload as {
      surfaceId: number; tiling: string; outerRect: Rect; outputRect: Rect;
    };
    const id = ev.surfaceId;
    try {
      if (ev.tiling === "managed") {
        const slideX = nearestEdgeSlideX(ev.outerRect, ev.outputRect);
        await anims.start(tween(target.windowTransform(id), {
          from: { ...IDENTITY, translateX: slideX },
          to: IDENTITY,
          duration, easing,
        }));
      } else {
        // Floating: fade + scale-up from 90% so the window appears in place.
        await Promise.all([
          anims.start(tween(target.windowOpacity(id), {
            from: 0, to: 1, duration, easing,
          })),
          anims.start(tween(target.windowTransform(id), {
            from: { ...IDENTITY, scaleX: 0.9, scaleY: 0.9 },
            to: IDENTITY,
            duration, easing,
          })),
        ]);
      }
    } catch (e) {
      sdk.log(`window-animations: opening setup failed for ${id}: ${errMsg(e)}`);
    } finally {
      // Start values are applied; make the window visible. On error this
      // still runs so a failed setup can't leave the window gated.
      try { await sdk.windows.releaseOpeningGate(id); } catch { /* gone */ }
    }
    return undefined;
  });
}

// CLOSE. The phantom starts at the window's last visible state
// (identity transform, full opacity), so run() suffices -- there is
// no start value to sequence, only the completion (destroyPhantom).
function activateClosing(
  sdk: PluginSdkShape, anims: PluginAnimationsLike, cfg: AnimationsConfig,
): void {
  const { duration, easing } = cfg.window;
  sdk.events.subscribe("window.closing", async (_name, payload) => {
    const ev = payload as { phantomSurfaceId: number; tiling: string; rect: Rect; outputRect: Rect };
    const phantomId = ev.phantomSurfaceId;
    try {
      if (ev.tiling === "managed") {
        const slideX = nearestEdgeSlideX(ev.rect, ev.outputRect);
        await anims.run(tween(target.windowTransform(phantomId), {
          from: IDENTITY,
          to: { ...IDENTITY, translateX: slideX },
          duration, easing,
        }));
      } else {
        await Promise.all([
          anims.run(tween(target.windowOpacity(phantomId), {
            from: 1, to: 0, duration, easing,
          })),
          anims.run(tween(target.windowTransform(phantomId), {
            from: IDENTITY,
            to: { ...IDENTITY, scaleX: 0.9, scaleY: 0.9 },
            duration, easing,
          })),
        ]);
      }
    } catch (e) {
      sdk.log(`window-animations: closing anim threw for ${phantomId}: ${errMsg(e)}`);
    } finally {
      // Always destroy the phantom so it doesn't leak. If the
      // closing-driver's backstop fires before us that's a no-op via
      // the runtime's already-destroyed guard.
      try { await sdk.windows.destroyPhantom(phantomId); } catch { /* gone */ }
    }
  });
}

// RETILE + LAYER GLIDE (the geometry seams).
function activateGeometry(
  sdk: PluginSdkShape, anims: PluginAnimationsLike, cfg: AnimationsConfig,
): void {
  const win = cfg.window;

  // The presnap shared by the retile seams: make the surface look like
  // it's still at oldOuter even though its placement is (about to be)
  // newOuter, then tween to identity. compose:"relative" folds the
  // offset onto the current value, so rapid retiles chase continuously.
  // Awaiting start() means the presnap is live before the emitting seam
  // proceeds.
  async function presnap(surfaceId: number, oldOuter: Rect, newOuter: Rect): Promise<void> {
    if (oldOuter.x === newOuter.x && oldOuter.y === newOuter.y
        && oldOuter.width === newOuter.width && oldOuter.height === newOuter.height) {
      return;
    }
    try {
      await anims.start(tween(target.windowTransform(surfaceId), {
        from: {
          translateX: oldOuter.x - newOuter.x,
          translateY: oldOuter.y - newOuter.y,
          scaleX: oldOuter.width / newOuter.width,
          scaleY: oldOuter.height / newOuter.height,
        },
        to: IDENTITY,
        duration: win.duration, easing: win.easing,
        compose: "relative",
      }));
    } catch (e) {
      sdk.log(`window-animations: retile setup failed for ${surfaceId}: ${errMsg(e)}`);
    }
  }

  // RETILE (immediate reasons). CREATED / DESTROYED entries are left to
  // the opening / closing seams. Reorder / param-changed geometry is
  // HELD by the WM's resize transaction until clients re-render -- the
  // surface still shows oldOuter, so a presnap now would displace it;
  // those retiles animate from stack.relayout-apply below, in the same
  // instant their held rects land.
  sdk.events.intercept("window.relayout", async (_name, payload) => {
    const ev = payload as {
      surfaceId: number; oldOuter: Rect | null; newOuter: Rect | null; reason: string;
    };
    if (ev.oldOuter === null || ev.newOuter === null) return undefined;
    if (ev.reason === "reorder" || ev.reason === "param-changed") return undefined;
    await presnap(ev.surfaceId, ev.oldOuter, ev.newOuter);
    return undefined;
  });

  // RETILE (transaction-held). The batch's held rects are about to land
  // atomically; oldOuter is the rect each surface still shows. Priming
  // every presnap before returning means the whole batch slides from its
  // pre-swap arrangement in one coordinated motion.
  sdk.events.intercept("stack.relayout-apply", async (_name, payload) => {
    const ev = payload as { windows?: Array<{ surfaceId: number; oldOuter: Rect; newOuter: Rect }> };
    const wins = Array.isArray(ev?.windows) ? ev.windows : [];
    await Promise.all(wins.map((w) => presnap(w.surfaceId, w.oldOuter, w.newOuter)));
    return undefined;
  });

  if (!cfg.layer.enabled) return;
  const layer = cfg.layer;

  // LAYER GLIDE, phase 1 (announce): a size-changing configure just went
  // out; start gliding toward the announced rect before the client has
  // rendered, so the frame moves in phase with the incoming buffers and
  // each buffer draws near 1:1 (the edge glides; text stays crisp).
  sdk.events.subscribe("layer.resize-announce", async (_name, payload) => {
    const ev = payload as { surfaceId: number; fromRect: Rect; toRect: Rect };
    const o = ev.fromRect, n = ev.toRect;
    if (!o || !n || o.width <= 0 || o.height <= 0) return;
    try {
      await anims.start(tween(target.windowTransform(ev.surfaceId), {
        from: IDENTITY,   // composes to the current value
        to: {
          translateX: n.x - o.x, translateY: n.y - o.y,
          scaleX: n.width / o.width, scaleY: n.height / o.height,
        },
        duration: layer.duration, easing: layer.easing,
        compose: "relative",
      }));
    } catch (e) {
      sdk.log(`window-animations: layer announce glide failed for ${ev.surfaceId}: ${errMsg(e)}`);
    }
  });

  // LAYER GLIDE, phase 2 (land): the buffer arrived and the displayed
  // rect swaps old -> new. Re-base the in-flight glide onto the new
  // rect -- from = (old - new) composed with the current value keeps the
  // visual continuous; to = identity.
  sdk.events.intercept("layer.relayout", async (_name, payload) => {
    const ev = payload as { surfaceId: number; oldRect: Rect; newRect: Rect };
    const o = ev.oldRect, n = ev.newRect;
    if (!o || !n || n.width <= 0 || n.height <= 0) return undefined;
    try {
      await anims.start(tween(target.windowTransform(ev.surfaceId), {
        from: {
          translateX: o.x - n.x, translateY: o.y - n.y,
          scaleX: o.width / n.width, scaleY: o.height / n.height,
        },
        to: IDENTITY,
        duration: layer.duration, easing: layer.easing,
        compose: "relative",
      }));
    } catch (e) {
      sdk.log(`window-animations: layer glide failed for ${ev.surfaceId}: ${errMsg(e)}`);
    }
    return undefined;
  });
}
