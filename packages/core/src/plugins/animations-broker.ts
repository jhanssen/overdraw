// Animations broker: routes plugin animations.* requests to the core
// evaluator (core-plugin-api.md §9). The evaluator is constructed in
// main.ts; the broker is a thin dispatch shim like the windows broker.
//
// Two submission shapes:
//   animations.run     -- one request whose response arrives at settle.
//   animations.start   -- responds immediately after registration (the
//                         evaluator has applied the `from` value by
//                         then) with a handle; animations.settled with
//                         that handle resolves at settle. Lets a plugin
//                         sequence "start value is live" against other
//                         calls (gate release, interceptor return)
//                         without waiting out the animation.

import type { AnimationEvaluator } from "../animations/evaluator.js";
import type { AnimationSpec, TargetRef } from "@overdraw/animation-types";

export const NOT_HANDLED = Symbol("animations-broker:not-handled");

export type AnimationsBroker = (
  pluginName: string, method: string, params: unknown,
) => Promise<unknown> | unknown | typeof NOT_HANDLED;

export interface AnimationsBrokerOptions {
  // Gate for output-camera targets: return a denial reason (e.g.
  // "pointer grab active") to reject the run, null to allow. A camera
  // animation during an interactive grab would move the world under the
  // grab's pointer->world feedback loop every frame; callers that get
  // denied fall back to setting the camera instantly.
  readonly cameraGate?: (outputId: number) => string | null;
}

export function createAnimationsBroker(
  evaluator: AnimationEvaluator,
  opts: AnimationsBrokerOptions = {},
): AnimationsBroker {
  // Settle promises for started-but-not-yet-claimed animations, keyed by
  // handle. An entry is removed when the animation settles, so the map
  // stays bounded even if a plugin dies between start and claim; a
  // settled claim for a handle no longer present resolves immediately
  // (the animation is already over -- if it FAILED within that one
  // round-trip window the rejection reason is lost to the claimant,
  // though it was pre-observed here so it never surfaces as an
  // unhandled rejection).
  const settles = new Map<number, Promise<void>>();
  let nextHandle = 1;

  return (pluginName: string, method: string, params: unknown) => {
    void pluginName;  // reserved for future capability gating / audit
    if (method === "animations.run") return handleRun(params);
    if (method === "animations.start") return handleStart(params);
    if (method === "animations.settled") return handleSettled(params);
    if (method === "animations.cancel") return handleCancel(params);
    return NOT_HANDLED;
  };

  function gateAndRun(spec: AnimationSpec, label: string): Promise<void> {
    if (opts.cameraGate) {
      for (const outputId of cameraTargetsOf(spec)) {
        const denied = opts.cameraGate(outputId);
        if (denied !== null) {
          throw new Error(`${label}: camera animation denied: ${denied}`);
        }
      }
    }
    return evaluator.run(spec);
  }

  function handleRun(p: unknown): Promise<void> {
    if (!isRunPayload(p)) throw new Error("animations.run: malformed payload");
    return gateAndRun(p.spec, "animations.run");
  }

  function handleStart(p: unknown): { handle: number } {
    if (!isRunPayload(p)) throw new Error("animations.start: malformed payload");
    const settle = gateAndRun(p.spec, "animations.start");
    const handle = nextHandle++;
    settles.set(handle, settle);
    void settle.then(undefined, () => {}).then(() => { settles.delete(handle); });
    return { handle };
  }

  function handleSettled(p: unknown): Promise<void> {
    const handle = (p as { handle?: unknown } | null)?.handle;
    if (typeof handle !== "number") {
      throw new Error("animations.settled: malformed payload");
    }
    return settles.get(handle) ?? Promise.resolve();
  }

  function handleCancel(p: unknown): Promise<void> {
    if (!isCancelPayload(p)) throw new Error("animations.cancel: malformed payload");
    return evaluator.cancel(p.target);
  }
}

function isRunPayload(d: unknown): d is { spec: AnimationSpec } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.spec !== "object" || o.spec === null) return false;
  const t = (o.spec as { type?: unknown }).type;
  return t === "tween" || t === "spring" || t === "sequence" || t === "parallel";
}

function isCancelPayload(d: unknown): d is { target: TargetRef } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.target !== "object" || o.target === null) return false;
  const target = o.target as { kind?: unknown; windowId?: unknown; outputId?: unknown };
  if (target.kind === "output-camera") return typeof target.outputId === "number";
  return (target.kind === "window-opacity"
       || target.kind === "window-transform"
       || target.kind === "window-output-margin")
    && typeof target.windowId === "number";
}

// Collect the outputIds of every output-camera leaf in a spec tree.
function cameraTargetsOf(spec: AnimationSpec, out: number[] = []): number[] {
  if (spec.type === "sequence" || spec.type === "parallel") {
    for (const item of spec.items) cameraTargetsOf(item, out);
    return out;
  }
  const t = spec.target as { kind?: unknown; outputId?: unknown };
  if (t.kind === "output-camera" && typeof t.outputId === "number") {
    out.push(t.outputId);
  }
  return out;
}
