// Vblank-paced frame ticks for plugin overlay surfaces (surface.onFrame, the
// rAF analog -- architecture.md "Plugin pacing"). One service instance holds
// the pending-tick state for BOTH plugin transports: the Worker GPU broker
// arms on surface.requestFrame (delivery = a postMessage event to the owning
// plugin), the in-thread GPU SDK arms directly (delivery = invoking the
// plugin's callback on the core thread).
//
// Pacing mirrors wl_surface.frame exactly:
//   - A tick is delivered from the flip-complete of the surface's output
//     (dispatchForOutput, wired to addon.setOnFlipComplete), so an overlay on
//     a 60Hz output ticks at 60Hz even when a 240Hz output is also flipping.
//     A surface with no output binding (outputId null) ticks on the next flip
//     of any output.
//   - An armed surface on a fully idle output would strand (no damage -> no
//     present -> no flip). idleTick (wired into the per-tick housekeeping,
//     before renderFrame) force-presents the surface's current content via
//     requestPresentForCallback, gated by shouldDeliverFrameCallbackIdle so a
//     presenting surface keeps its flip-complete pacing and nothing free-runs
//     past the refresh rate.

import { shouldDeliverFrameCallbackIdle } from "../protocols/frame-callbacks.js";

export interface FrameTicksCompositor {
  isOutputDirty?(outputId: number): boolean;
  requestPresentForCallback?(surfaceId: number): void;
}

export interface FrameTicksDeps {
  compositor: FrameTicksCompositor;
  // Outputs with a flip in flight (the protocol layer's awaitingFlip set,
  // published as state.awaitingFlipOutputs). Live view, read per call.
  awaitingFlip: () => ReadonlySet<number>;
  // All live output ids (for surfaces with no output binding).
  outputIds: () => number[];
}

export interface OverlayFrameTicks {
  // Arm a one-shot tick for a surface. `deliver` fires on the next
  // flip-complete of `outputId` (null = any output). Re-arming before
  // delivery replaces the deliver function; the surface stays single-shot.
  arm(surfaceId: number, outputId: number | null, deliver: (timeMs: number) => void): void;
  // Discard a surface's pending tick (surface destroyed / output removed).
  drop(surfaceId: number): void;
  dispatchForOutput(outputId: number, timeMs: number): void;
  idleTick(): void;
}

export function createOverlayFrameTicks(deps: FrameTicksDeps): OverlayFrameTicks {
  interface Pending {
    outputId: number | null;
    deliver: (timeMs: number) => void;
  }
  const pending = new Map<number, Pending>();

  return {
    arm(surfaceId, outputId, deliver) {
      pending.set(surfaceId, { outputId, deliver });
    },

    drop(surfaceId) {
      pending.delete(surfaceId);
    },

    dispatchForOutput(outputId, timeMs) {
      for (const [surfaceId, p] of [...pending]) {
        if (p.outputId !== null && p.outputId !== outputId) continue;
        pending.delete(surfaceId);
        p.deliver(timeMs);
      }
    },

    idleTick() {
      if (pending.size === 0) return;
      const awaiting = deps.awaitingFlip();
      for (const [surfaceId, p] of pending) {
        const outs = p.outputId !== null ? [p.outputId] : deps.outputIds();
        const idle = shouldDeliverFrameCallbackIdle(surfaceId, {
          surfaceOutputs: () => outs,
          isOutputDirty: (o) => deps.compositor.isOutputDirty?.(o) ?? false,
        }, awaiting);
        if (!idle) continue;
        deps.compositor.requestPresentForCallback?.(surfaceId);
      }
    },
  };
}
