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
import type { AnimationSpec, TargetRef } from "@overdraw/animation-types";

export interface PluginAnimations {
  // Run an animation. Resolves on natural completion OR when the
  // animation is preempted by another animation on the same target or
  // explicitly cancelled via cancel(target). Throws TypeError on a
  // structurally invalid spec.
  run(spec: AnimationSpec): Promise<void>;
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
  if (kind !== "window-opacity"
      && kind !== "window-transform"
      && kind !== "window-output-margin") {
    throw new TypeError(`target.kind must be one of window-opacity / window-transform / window-output-margin (got '${String(kind)}')`);
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
