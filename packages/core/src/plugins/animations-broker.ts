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

export function createAnimationsBroker(
  evaluator: AnimationEvaluator,
): AnimationsBroker {
  return (pluginName: string, method: string, params: unknown) => {
    void pluginName;  // reserved for future capability gating / audit
    if (method === "animations.run") return handleRun(params);
    if (method === "animations.cancel") return handleCancel(params);
    return NOT_HANDLED;
  };

  function handleRun(p: unknown): Promise<void> {
    if (!isRunPayload(p)) throw new Error("animations.run: malformed payload");
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
  const target = o.target as { kind?: unknown; windowId?: unknown };
  return (target.kind === "window-opacity"
       || target.kind === "window-transform"
       || target.kind === "window-output-margin")
    && typeof target.windowId === "number";
}
