// sdk.transitions -- transitions namespace (core-plugin-api.md §8).
//
// Plugin holds two SceneHandles (from compose.scene); transitions.run
// extracts their ids, sends the request to core's transitions broker
// over the endpoint, awaits completion. For in-thread plugins a commit
// callback can run synchronously inside the completion tick so the
// next renderFrame draws the post-transition state with no glitch.
// Worker plugins can't pass functions over postMessage; commit is
// silently ignored for them (use a chained .then() on the returned
// Promise for non-atomic post-transition work).

import type { Endpoint, Json } from "./protocol.js";
import type { SceneHandle } from "./compose-sdk.js";
import type { TransitionKind } from "@overdraw/transition-types";
import type { EasingSpec } from "@overdraw/animation-types";

// Declarative commit instructions run synchronously inside the
// transition's completion tick, BEFORE the next renderFrame, so the
// frame that immediately follows the transition draws the post-
// transition state with no glitch. Declarative (not a function) so
// it survives postMessage -- works equally for in-thread and Worker
// plugins. Each field describes ONE kind of sync mutation; the
// broker applies them in the order listed.
//
// Today's surface is limited to what the bundled workspace plugin
// needs. New atomic-commit operations should be added to this shape
// (and the broker's interpreter), not to the SDK boundary.
export interface TransitionCommit {
  // Set per-output content stack overrides on the compositor. Applied
  // in array order. Same shape as sdk.windows.setOutputStack:
  // ids=null clears the override.
  readonly setOutputStack?: ReadonlyArray<{
    outputId: number;
    ids: readonly number[] | null;
  }>;
}

export interface TransitionRunOpts {
  outputId: number;
  kind: TransitionKind;
  // Duration in ms. Must be > 0.
  duration: number;
  easing?: EasingSpec;
  // Scenes to blend. Both must come from sdk.compose.scene; their .id
  // fields carry the broker-side reference. Both scenes must have
  // matching outW/outH (the transition shader assumes a single output
  // size).
  from: SceneHandle;
  to: SceneHandle;
  // Atomic-with-transition-end state changes. The broker applies
  // these synchronously inside the evaluator's completion tick,
  // before the next renderFrame draws -- so the new state is visible
  // on the frame immediately following the transition (no glitch).
  // Survives postMessage; identical for in-thread and Worker plugins.
  commit?: TransitionCommit;
}

export interface PluginTransitions {
  // Run a transition. Resolves when the transition completes.
  // Throws if a transition is already in progress on the same output,
  // if either scene's .id is unknown to the broker, or if the scenes'
  // dims don't match.
  run(opts: TransitionRunOpts): Promise<void>;
}

// Single SDK implementation -- the commit data is declarative
// (structured-clone-safe) so in-thread and Worker share the same
// shape. The previous in-thread/worker split was to handle the
// glitch-free property for in-thread function callbacks; declarative
// commit makes that the broker's job and applies equally on both
// transports.
export function createTransitions(endpoint: Endpoint): PluginTransitions {
  return {
    async run(opts: TransitionRunOpts): Promise<void> {
      validate(opts);
      const params = {
        outputId: opts.outputId,
        kind: opts.kind,
        duration: opts.duration,
        easing: opts.easing,
        fromSceneId: opts.from.id,
        toSceneId: opts.to.id,
        commit: opts.commit,
      };
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("transitions.run", params as unknown as Json);
    },
  };
}

function validate(opts: TransitionRunOpts): void {
  if (typeof opts !== "object" || opts === null) {
    throw new TypeError("sdk.transitions.run: opts must be an object");
  }
  if (typeof opts.outputId !== "number") {
    throw new TypeError("sdk.transitions.run: opts.outputId must be a number");
  }
  if (typeof opts.kind !== "string") {
    throw new TypeError("sdk.transitions.run: opts.kind must be a string");
  }
  if (typeof opts.duration !== "number" || !(opts.duration > 0)) {
    throw new TypeError(
      `sdk.transitions.run: opts.duration must be > 0 (got ${opts.duration})`);
  }
  if (typeof opts.from !== "object" || opts.from === null
      || typeof opts.from.id !== "number") {
    throw new TypeError("sdk.transitions.run: opts.from must be a SceneHandle");
  }
  if (typeof opts.to !== "object" || opts.to === null
      || typeof opts.to.id !== "number") {
    throw new TypeError("sdk.transitions.run: opts.to must be a SceneHandle");
  }
  if (opts.from.id === 0 || opts.to.id === 0) {
    throw new TypeError(
      "sdk.transitions.run: scene .id is 0 -- the compose-sdk was " +
      "constructed without a shared sceneRegistry, so this scene cannot " +
      "be used in transitions. Wire the shared registry through main.ts.");
  }
  if (opts.commit !== undefined) {
    if (typeof opts.commit !== "object" || opts.commit === null) {
      throw new TypeError("sdk.transitions.run: opts.commit must be an object");
    }
    if (opts.commit.setOutputStack !== undefined
        && !Array.isArray(opts.commit.setOutputStack)) {
      throw new TypeError(
        "sdk.transitions.run: opts.commit.setOutputStack must be an array");
    }
  }
}
