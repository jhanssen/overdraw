// Decide whether a surface's armed wl_surface.frame callbacks should be
// delivered on an idle compositor tick (dispatchFrameCallbacks) rather than
// waiting for an output flip-complete.
//
// A frame callback is normally delivered when its output presents -- the flip-
// complete path (dispatchFrameCallbacksForOutput). A surface can arm a callback
// with a commit that produces no present: a bare frame-callback-only commit
// (no attached buffer, hence no damage), or one whose buffer is still being
// applied. No flip-complete is coming for it, so while the output is otherwise
// idle the callback would strand. Those are delivered on the idle tick instead
// -- but ONLY when no present is on its way, so a drawing client keeps its
// flip-complete pacing and does not free-run:
//   - the surface has no buffer still being applied (shm upload / dmabuf import);
//   - none of its outputs has a flip in flight (awaitingFlip) or queued damage.

export interface IdleFrameCallbackDeps {
  surfaceHasContentInFlight?(surfaceId: number): boolean;
  surfaceOutputs?(surfaceId: number): number[];
  isOutputDirty?(outputId: number): boolean;
}

export function shouldDeliverFrameCallbackIdle(
  surfaceId: number,
  deps: IdleFrameCallbackDeps,
  awaitingFlip: ReadonlySet<number>,
): boolean {
  // A present is coming for this surface's content; its callback rides that
  // present's flip-complete.
  if (deps.surfaceHasContentInFlight?.(surfaceId)) return false;
  // null = compositor reports no residency (stub/harness): deliver. An empty
  // array = mapped but off-screen, so there is no idle output to pace against;
  // leave it for a flip-complete when it re-enters an output. Otherwise every
  // resident output must be idle (no flip in flight, no queued damage).
  const outs = deps.surfaceOutputs ? deps.surfaceOutputs(surfaceId) : null;
  if (outs !== null) {
    if (outs.length === 0) return false;
    if (outs.some((o) => awaitingFlip.has(o) || deps.isOutputDirty?.(o))) return false;
  }
  return true;
}
