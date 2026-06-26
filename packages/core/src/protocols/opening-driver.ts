// Opening driver: mirror of closing-driver on the map side. Called from
// wm.windowHasContent at the first-content edge of a mapped toplevel,
// BEFORE the window enters the draw stack. When a 'window-opening'
// plugin is registered, the driver:
//
//   - Engages the WM content gate (the same primitive decorations use)
//     so the window is held out of the compositor's stack.
//   - Emits window.opening on the typed bus with the window's outer
//     rect + appId + title.
//   - Arms a backstop timer; on expiry the gate is force-released so a
//     stuck / buggy plugin can't keep a window invisible indefinitely.
//
// The plugin manipulates the surface via the regular per-surface SDK
// (setOpacity / setTransform / animations.run / etc.) and releases the
// gate by calling sdk.windows.releaseOpeningGate(surfaceId). The
// release-gate path cancels the backstop timer; the backstop firing
// also clears the gate but logs a warning so a regression in the
// plugin is visible.
//
// When no plugin is registered, beforeMap() returns false and the
// caller proceeds with the normal instant-map path (no gate, no
// event). Default behavior is unchanged.

import type { CompositorState, SurfaceRecord } from "./ctx.js";
import { WINDOW_EVENT } from "../events/types.js";
import type { WindowOpeningEvent } from "../events/types.js";
import { log } from "../log.js";
import { titleAppId } from "../query.js";

// Opening-driver dependencies. Wired by main.ts when the runtime is
// up; absent means "no opening driver" and beforeMap is a no-op.
export interface OpeningDriverDeps {
  // Predicate: is anyone registered to drive opening animations? The
  // launcher wires this to the plugin runtime's NamespaceRegistry
  // (registry.active('window-opening') !== null). When false the
  // driver returns false from beforeMap and no gate is engaged.
  hasPluginHandler: () => boolean;
  // Per-window backstop timeout (ms). Defaults to 10000.
  backstopMs?: number;
}

export interface OpeningDriver {
  // Engage the content gate for the opening window and emit
  // window.opening. The caller passes the toplevel's SurfaceRecord at
  // the first-content edge -- after wm.windowHasContent has been
  // marked true on the WM's window record but BEFORE pushStack puts
  // it in the compositor's draw stack.
  //
  // Returns true if the gate was engaged (and a window.opening event
  // was emitted + a backstop is armed); false if no plugin is
  // registered (caller proceeds with instant map, no event).
  beforeMap(state: CompositorState, s: SurfaceRecord): boolean;
  // For tests: enumerate the surfaceIds whose backstop is still armed.
  activeBackstopIds(): number[];
  // Cancel a window's backstop. Called by the windows broker's
  // releaseOpeningGate path so the timer doesn't fire after the
  // plugin already cleared the gate.
  cancelBackstop(surfaceId: number): void;
}

const DEFAULT_BACKSTOP_MS = 10_000;

export function createOpeningDriver(deps: OpeningDriverDeps): OpeningDriver {
  const backstopMs = deps.backstopMs ?? DEFAULT_BACKSTOP_MS;
  const backstops = new Map<number, ReturnType<typeof setTimeout>>();

  return {
    beforeMap(state, s): boolean {
      if (!deps.hasPluginHandler()) return false;
      if (s.role !== "xdg_toplevel" && s.role !== "xwayland") return false;
      if (!state.wm) return false;
      const outer = state.wm.outerRectOf(s.id);
      if (!outer || outer.width <= 0 || outer.height <= 0) return false;

      // Engage the gate under our own owner key so we stack
      // cleanly with other gate owners (notably the decoration
      // broker, which engages from window.map for windows that
      // match a decoration provider). The window stays out of the
      // draw stack until ALL owners release.
      state.wm.engageContentGate(s.id, "opening");

      const ta = titleAppId(state, s.id);
      // Resolve the output the window mapped on. Falls back to the
      // primary output if the surface never had a spawnOutputId set
      // (defensive; shouldn't happen for a real toplevel that reached
      // first content). The output's rect is in compositor coords --
      // plugins use it to compute slide distances ("from the output
      // edge to the tile") without a separate outputs lookup.
      const outputId = s.spawnOutputId ?? state.wm.primaryOutputId();
      const wmOutput = state.wm.state.outputs.get(outputId);
      const outputRect = wmOutput
        ? { x: wmOutput.rect.x, y: wmOutput.rect.y,
            width: wmOutput.rect.width, height: wmOutput.rect.height }
        : { x: 0, y: 0, width: outer.width, height: outer.height };
      const tiling = state.wm.getWindowState?.(s.id)?.tiling ?? "managed";
      const payload: WindowOpeningEvent = {
        surfaceId: s.id,
        outerRect: {
          x: outer.x, y: outer.y,
          width: outer.width, height: outer.height,
        },
        outputId,
        outputRect,
        tiling,
        appId: ta.appId, title: ta.title,
      };
      try {
        state.bus?.emit(WINDOW_EVENT.opening, payload);
      } catch (e) {
        log.err("core", "opening-driver: window.opening subscriber threw: %o", e);
      }

      // Arm the backstop. If the plugin calls releaseOpeningGate, the
      // broker cancels this timer. If nothing cancels, fire after
      // backstopMs and clear the gate ourselves so the window
      // becomes visible (a stuck plugin should never leave a window
      // permanently invisible).
      const timer = setTimeout(() => {
        backstops.delete(s.id);
        log.warn("core",
          `opening-driver: backstop fired for surfaceId=${s.id} `
          + `(plugin did not call releaseOpeningGate within ${backstopMs}ms); `
          + `forcing visible`);
        try { state.wm?.releaseContentGate(s.id, "opening"); }
        catch (e) {
          log.err("core", "opening-driver: backstop ungate threw: %o", e);
        }
      }, backstopMs);
      timer.unref?.();
      backstops.set(s.id, timer);
      return true;
    },

    activeBackstopIds(): number[] {
      return [...backstops.keys()];
    },

    cancelBackstop(surfaceId): void {
      const t = backstops.get(surfaceId);
      if (t) {
        clearTimeout(t);
        backstops.delete(surfaceId);
      }
    },
  };
}
