// Animations broker: routes plugin animations.run / animations.cancel
// requests to the core evaluator (core-plugin-api.md §9). The evaluator
// is constructed in main.ts; the broker is a thin dispatch shim like
// the windows broker.

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
  return (pluginName: string, method: string, params: unknown) => {
    void pluginName;  // reserved for future capability gating / audit
    if (method === "animations.run") return handleRun(params);
    if (method === "animations.cancel") return handleCancel(params);
    return NOT_HANDLED;
  };

  function handleRun(p: unknown): Promise<void> {
    if (!isRunPayload(p)) throw new Error("animations.run: malformed payload");
    if (opts.cameraGate) {
      for (const outputId of cameraTargetsOf(p.spec)) {
        const denied = opts.cameraGate(outputId);
        if (denied !== null) {
          throw new Error(`animations.run: camera animation denied: ${denied}`);
        }
      }
    }
    return evaluator.run(p.spec);
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
