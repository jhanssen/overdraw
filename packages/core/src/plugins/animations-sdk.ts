// Worker-side sdk.animations surface (core-plugin-api.md §9). Submits
// an AnimationSpec to core's evaluator and returns a Promise that
// resolves when the animation completes or is cancelled.
//
// Specs are structured-clone-safe by construction (all fields are
// numbers / strings / nested objects / arrays); they cross the SDK
// boundary unchanged for either in-thread or Worker transport. The
// per-frame evaluation runs in core, not in the plugin Worker -- the
// plugin's only IPC is the one run() call and any explicit cancel().

import type { Endpoint, Json } from "./protocol.js";
import type {
  AnimationHandle, AnimationSpec, TargetRef,
} from "@overdraw/animation-types";

// Result of start(): the animation is registered and its `from` value
// applied in core by the time start() resolves. `settled` resolves on
// natural completion, preemption, or cancel (same terms as run()).
export interface StartedAnimation {
  readonly handle: AnimationHandle;
  readonly settled: Promise<void>;
}

export interface PluginAnimations {
  // Run an animation. Resolves on natural completion OR when the
  // animation is preempted by another animation on the same target or
  // explicitly cancelled via cancel(target). Throws TypeError on a
  // structurally invalid spec.
  run(spec: AnimationSpec): Promise<void>;
  // Start an animation. Resolves as soon as core has registered it and
  // applied the spec's `from` value -- so a caller can order "the start
  // value is live" against its next call (releasing an opening gate,
  // returning from an interceptor) without waiting out the animation.
  // Use run() when only the completion matters.
  start(spec: AnimationSpec): Promise<StartedAnimation>;
  // Cancel the active animation (if any) on the given target. Resolves
  // immediately; the original run()'s Promise also settles.
  cancel(target: TargetRef): Promise<void>;
}

export function createPluginAnimations(endpoint: Endpoint): PluginAnimations {
  return {
    async run(spec: AnimationSpec): Promise<void> {
      validateSpec(spec);
      // The spec is structurally a Json (all numbers / strings / nested
      // shapes); cast through the wire type. Worker transport will
      // structured-clone it; in-thread delivers by reference.
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("animations.run", { spec: spec as unknown as Json });
    },
    async start(spec: AnimationSpec): Promise<StartedAnimation> {
      validateSpec(spec);
      // eslint-disable-next-line no-restricted-syntax
      const res = await endpoint.request("animations.start", { spec: spec as unknown as Json });
      const handle = (res as { handle: number }).handle;
      const settled = endpoint.request("animations.settled", { handle })
        .then(() => undefined);
      // Pre-observe: a caller may drop `settled` (fire-and-forget); a
      // preempted/failed animation must not become an unhandled rejection.
      settled.catch(() => {});
      return { handle, settled };
    },
    async cancel(target: TargetRef): Promise<void> {
      validateTarget(target);
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("animations.cancel", { target: target as unknown as Json });
    },
  };
}

function validateTarget(t: TargetRef): void {
  if (typeof t !== "object" || t === null) {
    throw new TypeError("target must be an object");
  }
  const kind = (t as { kind?: unknown }).kind;
  if (kind === "output-camera") {
    const oid = (t as { outputId?: unknown }).outputId;
    if (typeof oid !== "number") {
      throw new TypeError("target.outputId must be a number");
    }
    return;
  }
  if (kind !== "window-opacity"
      && kind !== "window-transform"
      && kind !== "window-output-margin") {
    throw new TypeError(`target.kind must be one of window-opacity / window-transform / window-output-margin / output-camera (got '${String(kind)}')`);
  }
  const wid = (t as { windowId?: unknown }).windowId;
  if (typeof wid !== "number") {
    throw new TypeError("target.windowId must be a number");
  }
}

function validateSpec(spec: AnimationSpec): void {
  if (typeof spec !== "object" || spec === null) {
    throw new TypeError("spec must be an object");
  }
  const t = (spec as { type?: unknown }).type;
  switch (t) {
    case "tween":
    case "spring":
      validateTarget((spec as { target: TargetRef }).target);
      return;
    case "sequence":
    case "parallel": {
      const items = (spec as { items?: unknown }).items;
      if (!Array.isArray(items)) {
        throw new TypeError(`${t}: items must be an array`);
      }
      for (const item of items) validateSpec(item as AnimationSpec);
      return;
    }
    default:
      throw new TypeError(`spec.type must be tween / spring / sequence / parallel (got '${String(t)}')`);
  }
}
