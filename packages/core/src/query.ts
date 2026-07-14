// State-query channel: an in-process snapshot of compositor state for tests and
// introspection. An integration harness uses it to assert on geometry / focus /
// stacking WITHOUT reading pixels. Pure read of CompositorState + Wm state; no
// side effects, no GPU.

import type { CompositorState } from "./protocols/ctx.js";

export interface WindowSnapshot {
  surfaceId: number;
  rect: { x: number; y: number; width: number; height: number };
  title: string | null;
  appId: string | null;
  role: string | null;
  mapped: boolean;
}

export interface OutputSummary {
  id: number;
  // Position in the global logical coordinate space.
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  // Content-camera offset (docs/canvas-design.md §4). (0, 0) = identity:
  // the output shows the world at its arrangement position.
  cameraX: number;
  cameraY: number;
}

export interface StateSnapshot {
  // Every WM output, ordered by id ascending. The first entry is the
  // primary; an empty array indicates a misconfigured harness (the WM
  // always has ≥1 output in production).
  outputs: OutputSummary[];
  // Windows in WM layout order (index 0 = master/front; tiling does not overlap,
  // so this is the layout order, not a z-stack).
  windows: WindowSnapshot[];
  // surfaceIds in WM layout order (mirror of wm.state.windows).
  stack: number[];
  // Focused surface ids (or null). Pointer focus follows the pointer; keyboard
  // focus is governed by the seat's focus policy.
  pointerFocus: number | null;
  keyboardFocus: number | null;
}

// Look up a surface's title/app_id. Both xdg_toplevels (via the
// xdg_surface -> ToplevelRecord chain) and xwayland windows (via the active
// XWM) carry these; this helper hides the role split from callers.
export function titleAppId(state: CompositorState, surfaceId: number): { title: string | null; appId: string | null } {
  for (const s of state.surfaces.values()) {
    if (s.id !== surfaceId) continue;
    if (s.role === "xwayland") {
      const xw = state.xwm?.findBySurfaceId(surfaceId);
      return xw
        ? { title: xw.title, appId: xw.appId }
        : { title: null, appId: null };
    }
    const tl = s.xdgSurface?.toplevel;
    if (tl) {
      const rec = state.toplevels?.get(tl);
      if (rec) return { title: rec.title ?? null, appId: rec.appId ?? null };
    }
    return { title: null, appId: null };
  }
  return { title: null, appId: null };
}

// Snapshot the current compositor state. Stable, serializable, GPU-free.
export function queryState(state: CompositorState): StateSnapshot {
  const wm = state.wm;
  const outputs: OutputSummary[] = wm
    ? [...wm.state.outputs.values()]
        .sort((a, b) => a.id - b.id)
        .map((o) => ({
          id: o.id,
          x: o.rect.x, y: o.rect.y,
          width: o.rect.width, height: o.rect.height,
          scale: o.scale,
          cameraX: state.outputCameras?.get(o.id)?.x ?? 0,
          cameraY: state.outputCameras?.get(o.id)?.y ?? 0,
        }))
    : [];

  const windows: WindowSnapshot[] = (wm?.state.windows ?? []).map((w) => {
    const ta = titleAppId(state, w.surfaceId);
    // Resolve the surface record for role/mapped (windows in the WM are mapped
    // by definition; role comes from the surface record).
    let role: string | null = null;
    for (const s of state.surfaces.values()) {
      if (s.id === w.surfaceId) { role = s.role; break; }
    }
    return {
      surfaceId: w.surfaceId,
      rect: { x: w.rect.x, y: w.rect.y, width: w.rect.width, height: w.rect.height },
      title: ta.title,
      appId: ta.appId,
      role,
      mapped: true,
    };
  });

  return {
    outputs,
    windows,
    stack: (wm?.state.windows ?? []).map((w) => w.surfaceId),
    pointerFocus: state.seat?.focus?.surfaceId ?? null,
    keyboardFocus: state.seat?.kbFocus?.surfaceId ?? null,
  };
}
