// Window-state change coalescing. Producers (set_title/set_app_id, keyboard-focus
// changes) call markWindowChanged to record a dirty field; the per-frame sweep
// (dispatchFrameCallbacks) calls flushWindowChanges to emit one window.change per
// affected surface. Coalescing to the frame boundary gives consumers a consistent
// snapshot rather than the intermediate state between rapid requests.

import type { CompositorState } from "./ctx.js";
import { titleAppId } from "../query.js";
import { WINDOW_EVENT } from "../events/types.js";
import type { WindowChangeField } from "../events/types.js";

// Record that `field` of the window backing `surfaceId` changed. Only meaningful
// for a mapped toplevel; the flush re-checks mapped state before emitting.
export function markWindowChanged(state: CompositorState, surfaceId: number,
                                  field: WindowChangeField): void {
  // No bus -> no observers -> skip the bookkeeping entirely.
  if (!state.bus) return;
  const map = (state.pendingWindowChanges ??= new Map());
  let fields = map.get(surfaceId);
  if (!fields) { fields = new Set(); map.set(surfaceId, fields); }
  fields.add(field);
}

// Emit one window.change per surface with pending changes, then clear. Skips
// surfaces that are no longer mapped (e.g. destroyed in the same frame).
export function flushWindowChanges(state: CompositorState): void {
  const pending = state.pendingWindowChanges;
  if (!pending || pending.size === 0) return;
  const bus = state.bus;
  const activeId = state.seat?.kbFocus?.surfaceId ?? null;

  for (const [surfaceId, fields] of pending) {
    if (fields.size === 0) continue;
    if (!isMappedToplevel(state, surfaceId)) continue;   // unmapped/destroyed since recorded
    const ta = titleAppId(state, surfaceId);
    bus?.emit(WINDOW_EVENT.change, {
      surfaceId,
      changed: [...fields],
      appId: ta.appId,
      title: ta.title,
      activated: surfaceId === activeId,
    });
  }
  pending.clear();
}

// True if `surfaceId` is a currently-mapped toplevel. xwayland windows enter
// the WM the same way xdg toplevels do (they are application windows from a
// plugin's standpoint), so window.change must flush for them too.
function isMappedToplevel(state: CompositorState, surfaceId: number): boolean {
  for (const s of state.surfaces.values()) {
    if (s.id === surfaceId) {
      return s.mapped === true && (s.role === "xdg_toplevel" || s.role === "xwayland");
    }
  }
  return false;
}
