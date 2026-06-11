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
import { stashInThreadCommit } from "./transitions-broker.js";

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
  // Synchronous commit callback fired on the completion tick BEFORE
  // the run() Promise resolves. Use this to atomically flip
  // post-transition state (e.g. setOutputStack) so the very next
  // renderFrame draws the new state with no glitch. IN-THREAD ONLY:
  // Worker plugins set the field but the function silently won't be
  // called -- the SDK can't transport a function over postMessage.
  // The Worker variant of this SDK rejects a commit set on a non-
  // in-thread plugin to surface the limitation loudly.
  commit?: () => void;
}

export interface PluginTransitions {
  // Run a transition. Resolves when the transition completes.
  // Throws if a transition is already in progress on the same output,
  // if either scene's .id is unknown to the broker, or if the scenes'
  // dims don't match.
  run(opts: TransitionRunOpts): Promise<void>;
}

// In-thread SDK: commit is a sync function in the SAME process as the
// broker; stash it on a side-table and send only the token. This is
// the path bundled plugins (workspace, future ones) use.
export function createInThreadTransitions(endpoint: Endpoint): PluginTransitions {
  return {
    async run(opts: TransitionRunOpts): Promise<void> {
      validate(opts);
      const commitToken = opts.commit
        ? stashInThreadCommit(opts.commit)
        : undefined;
      // The request bag is structured-clone-safe (numbers + a string
      // kind + an easing preset/object). Json's structural type doesn't
      // narrow cleanly across optional fields, so cast at the boundary.
      const params = {
        outputId: opts.outputId,
        kind: opts.kind,
        duration: opts.duration,
        easing: opts.easing,
        fromSceneId: opts.from.id,
        toSceneId: opts.to.id,
        commitToken,
      };
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("transitions.run", params as unknown as Json);
    },
  };
}

// Worker SDK: a commit function CANNOT cross postMessage; reject loudly
// if one is set (a plugin author who needs atomic commit must write an
// in-thread plugin). Otherwise the request shape is identical.
export function createWorkerTransitions(endpoint: Endpoint): PluginTransitions {
  return {
    async run(opts: TransitionRunOpts): Promise<void> {
      validate(opts);
      if (opts.commit) {
        throw new TypeError(
          "sdk.transitions.run: commit is not supported for Worker plugins " +
          "(functions don't cross postMessage). Chain .then() on the run() " +
          "Promise for non-atomic post-transition work, or use an in-thread " +
          "bundled plugin if atomic commit is required."
        );
      }
      const params = {
        outputId: opts.outputId,
        kind: opts.kind,
        duration: opts.duration,
        easing: opts.easing,
        fromSceneId: opts.from.id,
        toSceneId: opts.to.id,
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
}
