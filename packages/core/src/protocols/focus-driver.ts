// Focus driver. Dispatches focus-relevant coarse events to the active
// 'focus' plugin's decide() and applies the result via the seat. See
// core-plugin-api.md §14 for the design.
//
// Fire-and-forget: dispatch() is synchronous. The wl_seat hot path does
// not await; the result applies on the next tick once decide() resolves.
// A monotonic sequence number discards stale results -- a result for
// request N is dropped if N+1 was dispatched before N resolved (a slow
// decide() must not overwrite a newer one's decision).
//
// On decide() failure (no plugin, plugin throws) the dispatch is logged
// and focus stays where it was.

import type {
  FocusReason, FocusInputs, FocusResult,
} from "@overdraw/focus-types";
import { log as coreLog } from "../log.js";

export type { FocusReason, FocusInputs, FocusResult } from "@overdraw/focus-types";

export interface DispatchArgs {
  reason: FocusReason;
  pointer: FocusInputs["pointer"];
  currentKeyboardFocus: number | null;
  trigger?: number;
}

export interface FocusApplyTarget {
  // null clears focus. The seat resolves the surface id to its current
  // SeatFocus and sends the wl_keyboard leave/enter pair.
  applyKeyboardFocus(surfaceId: number | null): void;
}

// Production wraps runtime.invokeNamespace('focus', 'decide', [inputs]);
// tests pass a synchronous fake.
export type DecideFn = (inputs: FocusInputs) => Promise<FocusResult>;

export interface FocusDriver {
  dispatch(args: DispatchArgs): void;
  // For tests: resolves when no dispatches are in flight.
  settled(): Promise<void>;
}

export interface FocusDriverDeps {
  decide: DecideFn;
  target: FocusApplyTarget;
  log?: (msg: string) => void;
}

export function createFocusDriver(deps: FocusDriverDeps): FocusDriver {
  const log = deps.log ?? ((m) => coreLog.warn("core", `focus: ${m}`));

  let seq = 0;
  let latestSeq = 0;
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
        if (mySeq !== latestSeq) return;                  // superseded; drop
        if (result.keyboardFocus === undefined) return;   // leave unchanged
        deps.target.applyKeyboardFocus(result.keyboardFocus);
      },
      (err: unknown) => {
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
