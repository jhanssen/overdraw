// Phase 9a closing driver: captures a phantom of an unmapping toplevel
// and arms its lifetime. Called from wl_surface's
// unmapAndTeardownSurface BEFORE the WM/compositor teardown of the
// original surface, so the surface's render state is still sampleable
// for the snapshot.
//
// When no plugin claims the 'window-closing' namespace, beforeUnmap()
// returns false and the caller proceeds with the normal instant-unmap
// path (no phantom; same behavior as before phase 9a). When a plugin
// IS registered, the driver:
//
//   - Allocates a fresh surfaceId for the phantom.
//   - Calls compositor.createClosingPhantom() to composite the
//     toplevel + its decoration + its subsurfaces into a fresh
//     core-owned texture and mint a compositor surface entry.
//   - Emits window.closing on the bus with the phantom's id + the
//     closing window's metadata (rect, appId, title, originalSurfaceId).
//   - Arms a backstop timer; on expiry the phantom is force-destroyed
//     so a stuck / buggy plugin can't leak the phantom indefinitely.
//
// The plugin manipulates the phantom via the regular per-surface SDK
// (setOpacity / setTransform / animations.run / etc.) and releases
// it by calling sdk.windows.destroyPhantom (added in this phase).

import type { Resource } from "../types.js";
import type { CompositorState, SurfaceRecord, SubsurfaceRecord } from "./ctx.js";
import { WINDOW_EVENT } from "../events/types.js";
import type { WindowClosingEvent } from "../events/types.js";

// Closing-driver dependencies. Wired by installProtocols when the
// surrounding harness/launcher provides them; absent means "no closing
// driver" and beforeUnmap is a no-op.
export interface ClosingDriverDeps {
  // Predicate: is anyone registered to drive closing animations? The
  // launcher wires this to the plugin runtime's NamespaceRegistry
  // (registry.active('window-closing') !== null). When false the
  // driver returns false from beforeUnmap and no phantom is created.
  hasPluginHandler: () => boolean;
  // Per-phantom backstop timeout (ms). Defaults to 10000.
  backstopMs?: number;
}

export interface ClosingDriver {
  // Capture a phantom for the closing window (mapped toplevel). The
  // caller passes the toplevel's SurfaceRecord BEFORE running the
  // normal unmap teardown -- the surface's render state must still
  // be sampleable.
  //
  // Returns true if a phantom was captured (so a window.closing
  // event was emitted + a backstop is armed); false if no plugin
  // is registered (caller proceeds with instant unmap, no event).
  beforeUnmap(state: CompositorState, s: SurfaceRecord): boolean;
  // For tests: enumerate the surfaceIds of phantoms whose backstop
  // is still armed.
  activeBackstopIds(): number[];
  // Cancel a phantom's backstop. Called by the windows broker's
  // destroyPhantom path so the timer doesn't fire after the plugin
  // already cleaned up.
  cancelBackstop(phantomSurfaceId: number): void;
}

const DEFAULT_BACKSTOP_MS = 10_000;

export function createClosingDriver(deps: ClosingDriverDeps): ClosingDriver {
  const backstopMs = deps.backstopMs ?? DEFAULT_BACKSTOP_MS;
  // phantomSurfaceId -> the Node timer handle. setTimeout's return type
  // varies between environments; use the standard ReturnType pattern.
  const backstops = new Map<number, ReturnType<typeof setTimeout>>();

  return {
    beforeUnmap(state, s): boolean {
      if (!deps.hasPluginHandler()) return false;
      if (s.role !== "xdg_toplevel" || !s.mapped) return false;
      if (!state.wm || !state.compositor.createClosingPhantom) return false;
      const outer = state.wm.outerRectOf(s.id);
      if (!outer || outer.width <= 0 || outer.height <= 0) return false;

      // Gather the surface set: decoration (if any) at the bottom of
      // the local z, then the toplevel, then its subsurface subtree.
      // Order matches what computeBaseStack emits for an on-screen
      // composite of this window.
      const surfaceIds: number[] = [];
      const wmWin = state.wm.state.windows.find((w) => w.surfaceId === s.id);
      if (wmWin?.decorationSurfaceId !== undefined) {
        surfaceIds.push(wmWin.decorationSurfaceId);
      }
      surfaceIds.push(s.id);
      collectSubsurfaceIds(state, s.resource, surfaceIds);

      // Mint a fresh surfaceId for the phantom and snapshot.
      const phantomSurfaceId = state.serial();
      try {
        state.compositor.createClosingPhantom({
          phantomSurfaceId,
          surfaceIds,
          outerRect: { x: outer.x, y: outer.y, w: outer.width, h: outer.height },
        });
      } catch (e) {
        console.error("[closing-driver] createClosingPhantom threw:", e);
        return false;
      }

      // Pull title + appId from the toplevel record. Both may be null
      // (client never set them, or never finished its first commit).
      let appId: string | null = null;
      let title: string | null = null;
      const toplevelRes = s.xdgSurface?.toplevel;
      if (toplevelRes && state.toplevels) {
        const tl = state.toplevels.get(toplevelRes);
        if (tl) { appId = tl.appId; title = tl.title; }
      }

      const payload: WindowClosingEvent = {
        phantomSurfaceId,
        originalSurfaceId: s.id,
        rect: { x: outer.x, y: outer.y, width: outer.width, height: outer.height },
        appId, title,
      };
      // Emit window.closing on the typed bus. Subscribers (the
      // closing-animation plugin via main.ts's bus-to-pluginBus
      // republish) get the phantomSurfaceId and queue their
      // animations against it. emit() is synchronous on the
      // TypedBus -- there's nothing to intercept here; we just
      // notify the plugin so it can start animating.
      try {
        state.bus?.emit(WINDOW_EVENT.closing, payload);
      } catch (e) {
        console.error("[closing-driver] window.closing subscriber threw:", e);
      }

      // Arm the backstop. If the plugin's animation completes and
      // destroyPhantom is called, the broker will cancel this timer.
      // If nothing cancels, fire after backstopMs and destroy the
      // phantom ourselves.
      const timer = setTimeout(() => {
        backstops.delete(phantomSurfaceId);
        // The compositor sink may have torn down already (test
        // teardown, etc.); call the optional destroy guarded.
        try { state.compositor.destroyClosingPhantom?.(phantomSurfaceId); }
        catch (e) {
          console.error("[closing-driver] backstop destroy threw:", e);
        }
      }, backstopMs);
      // Some test runners reference timers; mark unref'd so the
      // backstop alone doesn't keep the process alive.
      timer.unref?.();
      backstops.set(phantomSurfaceId, timer);
      return true;
    },

    activeBackstopIds(): number[] {
      return [...backstops.keys()];
    },

    cancelBackstop(phantomSurfaceId): void {
      const t = backstops.get(phantomSurfaceId);
      if (t) {
        clearTimeout(t);
        backstops.delete(phantomSurfaceId);
      }
    },
  };
}

// Walk a surface's subsurface tree in z order and append each child's
// surface id to `out`. Mirrors the order computeBaseStack uses for a
// window, but only the ids -- no placement / rect computation
// (createClosingPhantom reads each surface's absolute screen
// position from its compositor state).
function collectSubsurfaceIds(
  state: CompositorState, parent: Resource, out: number[],
): void {
  if (!state.subsurfaces) return;
  // Iterate subsurfaces whose parent is `parent`, in z order. The
  // existing subsurface ordering is by insertion (place_above /
  // place_below would alter it; today both are no-ops per "Read
  // first"). Match that order.
  const children: SubsurfaceRecord[] = [];
  for (const sub of state.subsurfaces.values()) {
    if (sub.parent === parent) children.push(sub);
  }
  for (const sub of children) {
    const child = state.surfaces.get(sub.surface);
    if (!child) continue;
    out.push(child.id);
    // Recurse into nested subsurfaces.
    collectSubsurfaceIds(state, sub.surface, out);
  }
}
