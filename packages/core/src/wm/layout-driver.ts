// Layout driver. Sits between the WM (which owns the window list +
// structural state) and the layout plugin (which owns the geometry policy).
// core-plugin-api.md §13.
//
// Responsibilities:
//   - Coalesce relayout requests (at most one compute() in flight per
//     output; subsequent invalidations queue and replace).
//   - Build LayoutInputs from the WM's current state.
//   - Invoke compute() on the active layout plugin via the runtime.
//   - Apply the result: hand outer rects back to the WM for it to push to
//     the compositor + fire xdg_toplevel.configure where size changed.
//
// On compute failure (plugin throws, no plugin registered after timeout,
// permanent restart-budget exhaustion), the driver logs and leaves windows
// at their previous geometry. A retry happens on the next relayout.
//
// The plugin contract is async. Tests inject a synchronous fake driver to
// stay deterministic without spinning up a worker.

import type { LayoutInputs, LayoutResult, LayoutWindow, LayoutReason } from "@overdraw/layout-types";
import { OUTPUT_DEFAULT } from "../protocols/ctx.js";

export type { LayoutInputs, LayoutResult, LayoutReason } from "@overdraw/layout-types";

// Snapshot the driver needs from the WM to build LayoutInputs. The WM
// produces this on demand; the driver consumes it and never holds onto
// references.
export interface LayoutSnapshot {
  output: { width: number; height: number };
  // Ordered windows (master-front; index 0 is the layout's master).
  // Only the fields the layout might need: id + hint state + currentRect
  // (so a future layout can interpolate from the current position).
  windows: ReadonlyArray<LayoutWindow>;
}

// What the driver does with the layout result. The WM provides this so the
// driver doesn't reach into WM internals.
export interface LayoutApplyTarget {
  // Apply this set of (id, outer) rects. The WM updates its records, pushes
  // setSurfaceLayout to the compositor for windows with content, and fires
  // configure for windows whose content size changed. Returns a Promise so
  // the WM can await interceptors (window.relayout) before mutating
  // geometry; tests with no bus may still return synchronously.
  apply(result: LayoutResult, reason: LayoutReason): void | Promise<void>;
}

// The function the driver uses to invoke the layout plugin. In production
// this wraps runtime.invokeNamespace('layout', 'compute', [inputs]). Unit
// tests can inject a synchronous fake (e.g. running master-stack inline).
export type ComputeFn = (inputs: LayoutInputs) => Promise<LayoutResult>;

export interface LayoutDriver {
  // Schedule a relayout for the given reason. The driver coalesces: if a
  // compute is in flight, the request is recorded and re-run once the
  // current one finishes. Idempotent + safe to call from any path that
  // changes layout-relevant state.
  schedule(reason: LayoutReason): void;

  // Resolves when the layout has settled (no in-flight + no pending
  // compute). Used by tests + by code that wants to await the next layout
  // pass (e.g. window-bring-up tests).
  settled(): Promise<void>;
}

export interface LayoutDriverDeps {
  // Snapshot the WM's current layout-relevant state. Called immediately
  // before each compute(); the driver never caches state across invocations.
  snapshot(): LayoutSnapshot;
  // Apply layout results back to the WM.
  target: LayoutApplyTarget;
  // The function that actually runs the layout. Per the discussion above:
  // wraps runtime.invokeNamespace in production; inline algorithm in tests.
  compute: ComputeFn;
  // Diagnostic sink. Default: console.warn so layout errors are visible.
  log?: (msg: string) => void;
}

export function createLayoutDriver(deps: LayoutDriverDeps): LayoutDriver {
  const log = deps.log ?? ((m) => console.warn(`[layout] ${m}`));

  // State machine:
  //   idle:    no compute pending or in-flight.
  //   running: compute is in flight. If a schedule() arrives, set pending=true.
  // After running completes, if pending, transition back to running with
  // pending=false; else go idle.
  let running = false;
  let pendingReason: LayoutReason | null = null;
  // Waiters resolved when settled() is called and the queue drains.
  let settleWaiters: Array<() => void> = [];

  function schedule(reason: LayoutReason): void {
    if (running) {
      // Coalesce: keep the most recent reason. (A 'mapped' followed by
      // 'output-resized' should report as 'output-resized'; the result is
      // the same -- one compute -- but plugins that branch on reason see
      // the latest cause.)
      pendingReason = reason;
      return;
    }
    void runOnce(reason);
  }

  async function runOnce(reason: LayoutReason): Promise<void> {
    running = true;
    try {
      const snap = deps.snapshot();
      const inputs: LayoutInputs = {
        output: {
          id: OUTPUT_DEFAULT,
          rect: { x: 0, y: 0, width: snap.output.width, height: snap.output.height },
          scale: 1,
        },
        windows: snap.windows,
        reason,
      };
      const result = await deps.compute(inputs);
      await deps.target.apply(result, reason);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`compute(${reason}) failed: ${msg}`);
      // Intentional: leave geometry untouched on failure. The next
      // schedule() retries.
    } finally {
      running = false;
      const next = pendingReason;
      pendingReason = null;
      if (next !== null) {
        // Tail-call into the next compute. Use setImmediate so the stack
        // doesn't grow unbounded for rapid-fire schedules.
        setImmediate(() => { void runOnce(next); });
      } else {
        // Settled: notify waiters.
        const waiters = settleWaiters;
        settleWaiters = [];
        for (const w of waiters) w();
      }
    }
  }

  function settled(): Promise<void> {
    if (!running && pendingReason === null) return Promise.resolve();
    return new Promise<void>((resolve) => { settleWaiters.push(resolve); });
  }

  return { schedule, settled };
}
