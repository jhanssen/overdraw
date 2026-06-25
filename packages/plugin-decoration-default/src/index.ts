// Bundled decoration plugin: a rounded-corner frame with a configurable
// solid-or-gradient fill, paced by focus changes (no per-frame animation).
//
// Architecture:
//   - Registers as a decoration provider for the configured app_id pattern
//     (default ".*", every window).
//   - On onAssigned: reserves additive insets (= border width on every edge),
//     allocates a decoration Surface ring at the resulting outer rect, sets
//     analytic shapes on BOTH surfaces (decoration outer rounded rect, window
//     content inner rounded rect = outer minus borderWidth), draws the frame
//     once, presents.
//   - On windows.onChange(activated): redraw the frame with the focused vs.
//     unfocused fill. Single draw per focus flip; no frame loop.
//   - On onResized: tear down the old ring + draw (its size is fixed at
//     alloc), allocate a new one at the new outer rect, re-apply shapes,
//     redraw.
//   - On onUnmap / onDeregistered: drop per-window state; destroy the ring.

import type {
  DecorationAssignedEvent, DecorationResizedEvent, DecorationDeregisteredEvent,
} from "../../core/dist/events/types.js";
// Re-typed via the plugin SDK surface so we don't pull in a relative path
// to the core's internal module. (sdk.windows is the contract; the events
// import above is type-only and would normally be inlined.)
import type { PluginSdk } from "../../core/dist/plugins/sdk.js";
import type { Surface } from "../../core/dist/plugins/gpu.js";

import {
  validateConfig, insetShape,
  type ResolvedConfig, type ResolvedFill,
} from "./config.js";
import {
  createDecorationPipeline, createDecorationDraw, destroyDecorationDraw,
  writeUniforms, recordDraw,
  type DecorationPipeline, type DecorationDraw,
} from "./render.js";

interface PerWindow {
  surface: Surface;
  draw: DecorationDraw;
  // The window's currently-applied focus state, so a windows.onChange that
  // doesn't actually flip activation is a cheap no-op.
  focused: boolean;
}

export default async function init(sdk: PluginSdk, rawConfig?: unknown): Promise<void> {
  const config = validateConfig(rawConfig);
  if (!sdk.gpu || !sdk.decorations) {
    // The runtime gates sdk.gpu / sdk.decorations on GPU bring-up. A bundled
    // plugin without them shouldn't have been loaded; surface the failure
    // explicitly so init throws (a clear startup error beats a silent no-op).
    throw new Error(
      "decoration-default: requires sdk.gpu + sdk.decorations -- the GPU "
      + "subsystem must be wired in this configuration",
    );
  }
  const gpu = sdk.gpu;
  const windowsSdk = sdk.windows;
  const decorationsSdk = sdk.decorations;

  const pipeline = createDecorationPipeline(gpu.device);
  const perWindow = new Map<number, PerWindow>();

  await decorationsSdk.register(config.appIdPattern, config.appIdFlags);
  sdk.log(`decoration-default: registered (pattern=${JSON.stringify(config.appIdPattern)}`
    + `, border=${config.borderWidth}, shape=${JSON.stringify(config.outerShape)})`);

  decorationsSdk.onAssigned(async (ev: DecorationAssignedEvent) => {
    try { await onAssigned(ev); }
    catch (e) {
      sdk.log(`onAssigned failed for ${ev.surfaceId}: ${(e as Error).message ?? e}`);
    }
  });

  decorationsSdk.onResized(async (ev: DecorationResizedEvent) => {
    try { await onResized(ev); }
    catch (e) {
      sdk.log(`onResized failed for ${ev.windowId}: ${(e as Error).message ?? e}`);
    }
  });

  decorationsSdk.onDeregistered((ev: DecorationDeregisteredEvent) => {
    sdk.log(`decoration-default deregistered (${ev.reason}); tearing down ${perWindow.size} window(s)`);
    // Reset the windows' shapes back to rectangle; the windows themselves
    // outlive this plugin (only its decorations go away).
    for (const [windowId, w] of perWindow) {
      void windowsSdk.setShape(windowId, null).catch(() => { /* race; ignore */ });
      teardownWindow(w);
    }
    perWindow.clear();
  });

  windowsSdk.onUnmap((ev: { surfaceId: number }) => {
    const w = perWindow.get(ev.surfaceId);
    if (!w) return;
    teardownWindow(w);
    perWindow.delete(ev.surfaceId);
    // No need to clear setShape on the window: the surface is unmapped, the
    // compositor's removeSurface drops the per-surface fx state. (If a
    // future caller reuses the surface id for a different window, it gets a
    // fresh fx via blankSurface.)
  });

  // Focus-driven redraw: a window.change with a flipped `activated` flag
  // restyles the frame with the focused vs. unfocused fill.
  windowsSdk.onChange((ev: { surfaceId: number; activated: boolean }) => {
    const w = perWindow.get(ev.surfaceId);
    if (!w || w.focused === ev.activated) return;
    w.focused = ev.activated;
    void redraw(w, config).catch((e) => {
      sdk.log(`focus redraw failed for ${ev.surfaceId}: ${(e as Error).message ?? e}`);
    });
  });

  sdk.onShutdown(() => {
    for (const [windowId, w] of perWindow) {
      void windowsSdk.setShape(windowId, null).catch(() => { /* race; ignore */ });
      teardownWindow(w);
    }
    perWindow.clear();
  });

  async function onAssigned(ev: DecorationAssignedEvent,
                             opts: { initialFocused?: boolean } = {}): Promise<void> {
    const windowId = ev.surfaceId;
    if (perWindow.has(windowId)) return;   // defensive; broker doesn't double-assign

    const insets = {
      top: config.borderWidth, right: config.borderWidth,
      bottom: config.borderWidth, left: config.borderWidth,
    };
    const surface = await decorationsSdk.createDecoration(windowId, {
      insets,
      layer: "below",
    });
    const draw = createDecorationDraw(pipeline);
    const w: PerWindow = { surface, draw, focused: opts.initialFocused ?? false };
    perWindow.set(windowId, w);

    // Apply analytic shapes: decoration takes the OUTER shape; the
    // window's content surface takes the inset INNER shape (every
    // radius / extent shrunk by borderWidth, floored at 0). The
    // compositor's SDF clips both. When outerShape is null (rectangle)
    // skip the calls entirely -- the compositor's default is rectangle
    // and an explicit null still walks the SDF early-out, but skipping
    // saves two round-trip messages on every map.
    if (config.outerShape !== null) {
      const inner = insetShape(config.outerShape, config.borderWidth);
      await windowsSdk.setShape(surface.surfaceId, config.outerShape);
      await windowsSdk.setShape(windowId, inner);
    }

    await redraw(w, config);
  }

  async function onResized(ev: DecorationResizedEvent): Promise<void> {
    const windowId = ev.windowId;
    const prev = perWindow.get(windowId);
    const wasFocused = prev?.focused ?? false;
    if (prev) {
      teardownWindow(prev);
      perWindow.delete(windowId);
    }
    // Re-assign via the existing onAssigned flow (it allocates a new ring at
    // the new outer rect and redraws). createDecoration is the one path that
    // reserves the insets in the WM; recreating it is what onResized is for.
    // Carry over the focused state so a window that's focused at resize/
    // workspace-move time keeps its focused frame rendered (otherwise the
    // re-created surface defaults to unfocused until the next activation
    // event, which doesn't fire because the seat's focus didn't change).
    await onAssigned({
      surfaceId: windowId, appId: null, title: null,
      rect: { x: ev.outerRect.x, y: ev.outerRect.y,
              width: ev.outerRect.width, height: ev.outerRect.height },
    }, { initialFocused: wasFocused });
  }

  function teardownWindow(w: PerWindow): void {
    destroyDecorationDraw(w.draw);
    void w.surface.destroy().catch(() => { /* shutdown race */ });
  }

  async function redraw(w: PerWindow, cfg: ResolvedConfig): Promise<void> {
    const fill: ResolvedFill = w.focused ? cfg.focused : cfg.unfocused;
    const tex = await w.surface.getCurrentTexture();
    writeUniforms(pipeline.device, w.draw, w.surface.width, w.surface.height, fill);
    recordDraw(pipeline, w.draw, tex.createView());
    await w.surface.present();
  }
}
