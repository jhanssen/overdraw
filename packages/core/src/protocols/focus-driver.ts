// Focus driver. Translates focus-relevant coarse events into decide() calls
// on the active 'focus' namespace plugin, and applies the result via the
// seat's setKeyboardFocus. core-plugin-api.md §14.
//
// Fire-and-forget: dispatch() returns synchronously after kicking off
// decide(). The hot path (wl_seat.ts handleInput) does NOT await -- the
// returned promise applies the focus change on the next tick. Sequencing
// by a monotonic counter discards stale results (a result from request N
// is dropped if request N+1 has been issued before N resolved).
//
// Failure handling: if no 'focus' plugin is registered, or compute() throws
// / rejects, the dispatch is logged and the seat's keyboard focus stays
// untouched. The compositor remains usable (input still routes; keys go
// to whatever surface currently has kb focus).

import type {
  FocusReason, FocusInputs, FocusResult,
} from "@overdraw/focus-types";

export type { FocusReason, FocusInputs, FocusResult } from "@overdraw/focus-types";

// What the seat hands the driver to dispatch one coarse event.
export interface DispatchArgs {
  reason: FocusReason;
  pointer: FocusInputs["pointer"];
  currentKeyboardFocus: number | null;
  trigger?: number;
}

// What the seat exposes for the driver to apply a focus result.
export interface FocusApplyTarget {
  // Apply a keyboard-focus change. The id refers to a wl_surface (the same
  // SurfaceId the seat already tracks). null clears focus. The seat is
  // responsible for resolving the id to its current SeatFocus structure
  // and sending the appropriate wl_keyboard leave/enter events.
  applyKeyboardFocus(surfaceId: number | null): void;
}

// The compute function the driver uses. Production: wraps
// runtime.invokeNamespace('focus', 'decide', [inputs]). Tests can inject a
// synchronous fake.
export type DecideFn = (inputs: FocusInputs) => Promise<FocusResult>;

export interface FocusDriver {
  // Dispatch a coarse event. Synchronous: kicks off decide() and returns;
  // the result applies on the next tick (or is dropped if stale).
  dispatch(args: DispatchArgs): void;
  // Used by tests to wait for outstanding dispatches to settle.
  settled(): Promise<void>;
}

export interface FocusDriverDeps {
  decide: DecideFn;
  target: FocusApplyTarget;
  log?: (msg: string) => void;
}

export function createFocusDriver(deps: FocusDriverDeps): FocusDriver {
  const log = deps.log ?? ((m) => console.warn(`[focus] ${m}`));

  // Monotonic sequence. Each dispatch() bumps this and tags its in-flight
  // request; on resolve we apply only if our seq is still the latest. This
  // is the "discard stale results" pattern from core-plugin-api.md §14.
  let seq = 0;
  // The most-recently-issued seq across all dispatches. A resolving request
  // checks: am I still the latest? If not, drop my result.
  let latestSeq = 0;
  // Outstanding (not yet resolved) request promises. settled() awaits these.
  const inflight = new Set<Promise<void>>();

  function dispatch(args: DispatchArgs): void {
    const mySeq = ++seq;
    latestSeq = mySeq;
    const inputs: FocusInputs = {
      reason: args.reason,
      pointer: args.pointer,
      currentKeyboardFocus: args.currentKeyboardFocus,
      ...(args.trigger !== undefined ? { trigger: args.trigger } : {}),
    };
    const p = deps.decide(inputs).then(
      (result) => {
        // Stale: a newer dispatch has been issued. Drop the result so we
        // don't apply outdated focus decisions (e.g. an old hover that
        // resolved after the pointer moved past).
        if (mySeq !== latestSeq) return;
        if (result.keyboardFocus === undefined) return;   // leave unchanged
        deps.target.applyKeyboardFocus(result.keyboardFocus);
      },
      (err: unknown) => {
        // decide() failed -- typically "no active plugin for namespace
        // 'focus'" or the plugin's decide threw. Log + leave focus alone.
        const msg = err instanceof Error ? err.message : String(err);
        log(`decide(${args.reason}) failed: ${msg}`);
      },
    ).finally(() => { inflight.delete(p); });
    inflight.add(p);
  }

  function settled(): Promise<void> {
    if (inflight.size === 0) return Promise.resolve();
    return Promise.allSettled([...inflight]).then(() => undefined);
  }

  return { dispatch, settled };
}
