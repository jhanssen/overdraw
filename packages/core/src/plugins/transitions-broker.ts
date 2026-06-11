// Transitions broker: routes plugin transitions.run requests to the
// core transition evaluator + compositor (core-plugin-api.md §8).
//
// The plugin calls sdk.transitions.run(outputId, {kind, duration, easing,
// fromSceneId, toSceneId, commit?}). The broker:
//   1. Resolves fromSceneId/toSceneId via the SceneRegistry to core-side
//      GPUTextures + outW/outH.
//   2. Pins both registry entries so a buggy plugin's SceneHandle.release()
//      during the transition defers, not yanks the textures.
//   3. Installs the transition on the compositor (setActiveTransition).
//   4. Installs the time machine on the evaluator (install()).
//   5. On completion (evaluator's commit callback): runs the plugin's
//      commit, clears the compositor's transition slot, unpins both
//      scenes, resolves the plugin's run() Promise.
//
// Conflict policy: reject overlapping transitions on the same output.
// Today we only validate against the evaluator's "already active" check
// (single-output compositor); when multi-output lands, this becomes a
// per-output evaluator + active map.

import type { TransitionEvaluator } from "../transitions/evaluator.js";
import type { SceneRegistry } from "./scene-registry.js";
import type { TransitionKind } from "@overdraw/transition-types";
import { TRANSITION_KINDS } from "@overdraw/transition-types";
import type { EasingSpec } from "@overdraw/animation-types";
import { OUTPUT_DEFAULT } from "../protocols/ctx.js";

export const NOT_HANDLED = Symbol("transitions-broker:not-handled");

// Minimal slice of JsCompositor the broker calls. Implemented by
// JsCompositor in production; tests pass a mock. The two methods are
// optional on CompositorSink (the native compositor doesn't have
// them) -- the broker validates at construction.
export interface TransitionCompositorSink {
  setActiveTransition?: (opts: {
    fromTex: GPUTexture;
    toTex: GPUTexture;
    kind: TransitionKind;
    getProgress: () => number;
    resolveTextures?: () => { fromTex: GPUTexture; toTex: GPUTexture } | null;
  }) => void;
  clearActiveTransition?: () => void;
}

export interface TransitionsBrokerDeps {
  compositor: TransitionCompositorSink;
  evaluator: TransitionEvaluator;
  sceneRegistry: SceneRegistry;
}

export type TransitionsBroker = (
  pluginName: string, method: string, params: unknown,
) => Promise<unknown> | unknown | typeof NOT_HANDLED;

// In-thread plugins can pass a function to be called synchronously
// inside the completion tick (so the next renderFrame draws the
// post-transition state with no glitch). Worker plugins can't pass
// functions over postMessage; their commit is undefined. A Worker
// plugin that needs atomic post-transition state can express it as
// a follow-up action invocation by chaining .then() on the run
// Promise -- one frame later, but still correct for most use cases.
export type InThreadCommit = () => void;

// Broker-internal: in-thread plugins can stash a pre-resolved commit
// function on a side-table keyed by a token. The transitions-sdk
// (in-thread variant) puts the function here and sends only the
// token over the wire. (Worker plugins lack this side-table entirely;
// they always omit commit.)
const inThreadCommits = new Map<number, InThreadCommit>();
let nextCommitToken = 1;

// Public helper for the in-thread SDK: stash a commit callback,
// returning the token to send to the broker.
export function stashInThreadCommit(cb: InThreadCommit): number {
  const tok = nextCommitToken++;
  inThreadCommits.set(tok, cb);
  return tok;
}

export function createTransitionsBroker(
  deps: TransitionsBrokerDeps,
): TransitionsBroker {
  const { compositor, evaluator, sceneRegistry } = deps;
  if (!compositor.setActiveTransition || !compositor.clearActiveTransition) {
    throw new Error(
      "createTransitionsBroker: compositor lacks setActiveTransition / " +
      "clearActiveTransition (JS compositor required for phase 8)");
  }
  const setActiveTransition = compositor.setActiveTransition.bind(compositor);
  const clearActiveTransition = compositor.clearActiveTransition.bind(compositor);

  return (pluginName: string, method: string, params: unknown) => {
    void pluginName;
    if (method === "transitions.run") return handleRun(params);
    return NOT_HANDLED;
  };

  async function handleRun(p: unknown): Promise<void> {
    if (!isRunPayload(p)) {
      throw new Error("transitions.run: malformed payload");
    }
    if (p.outputId !== OUTPUT_DEFAULT) {
      throw new Error(
        `transitions.run: outputId=${p.outputId} not recognized ` +
        `(only OUTPUT_DEFAULT=${OUTPUT_DEFAULT} exists today)`,
      );
    }
    if (!TRANSITION_KINDS.includes(p.kind)) {
      throw new Error(`transitions.run: unknown kind '${p.kind}'`);
    }
    const from = sceneRegistry.lookup(p.fromSceneId);
    const to = sceneRegistry.lookup(p.toSceneId);
    if (!from) {
      throw new Error(
        `transitions.run: fromSceneId=${p.fromSceneId} not found ` +
        `(scene released? .id is 0 when constructed without a shared sceneRegistry)`,
      );
    }
    if (!to) {
      throw new Error(
        `transitions.run: toSceneId=${p.toSceneId} not found`,
      );
    }
    if (from.outW !== to.outW || from.outH !== to.outH) {
      throw new Error(
        `transitions.run: scene dims must match ` +
        `(from=${from.outW}x${from.outH}, to=${to.outW}x${to.outH})`,
      );
    }

    // Resolve the commit callback. In-thread plugins send a token
    // they stashed in the side-table; Worker plugins always omit.
    let commit: InThreadCommit | undefined;
    if (typeof p.commitToken === "number") {
      commit = inThreadCommits.get(p.commitToken);
      // The token is single-use; clear it now whether or not we found
      // a callback (a missing entry was probably already consumed).
      inThreadCommits.delete(p.commitToken);
      if (!commit) {
        throw new Error(
          `transitions.run: commitToken=${p.commitToken} not found ` +
          `(double-run or token lifetime bug)`,
        );
      }
    }

    // Pin the scenes BEFORE installing on the compositor. Failure to
    // pin (entry being torn down) throws here and the install never
    // happens.
    sceneRegistry.pin(p.fromSceneId);
    try {
      sceneRegistry.pin(p.toSceneId);
    } catch (e) {
      sceneRegistry.unpin(p.fromSceneId);
      throw e;
    }

    // Build the per-frame resolver. For stable scenes (no resolveTexture
    // on either entry) skip the callback entirely; the compositor uses
    // the install-time fromTex/toTex every frame. For ring-backed
    // scenes (Worker-live), resolveTexture returns the latest
    // PRESENTED slot's core-side texture; if either side has nothing
    // PRESENTED yet, the callback returns null and the compositor
    // clears to opaque-black for that frame.
    const usesResolver = from.resolveTexture || to.resolveTexture;
    const resolveTextures = usesResolver
      ? (): { fromTex: GPUTexture; toTex: GPUTexture } | null => {
          const f = from.resolveTexture ? from.resolveTexture() : from.texture;
          const t = to.resolveTexture ? to.resolveTexture() : to.texture;
          if (!f || !t) return null;
          return { fromTex: f, toTex: t };
        }
      : undefined;

    // Build the unpin closure once; the same path runs whether we
    // succeed normally or fail after install. Idempotent.
    let unpinned = false;
    const unpinScenes = (): void => {
      if (unpinned) return;
      unpinned = true;
      sceneRegistry.unpin(p.fromSceneId);
      sceneRegistry.unpin(p.toSceneId);
    };

    // Install on compositor + evaluator. Both throw synchronously on
    // conflict; we must roll back the OTHER if one fails.
    try {
      setActiveTransition({
        fromTex: from.texture,
        toTex: to.texture,
        kind: p.kind,
        getProgress: () => evaluator.getProgress() ?? 0,
        resolveTextures,
      });
    } catch (e) {
      unpinScenes();
      throw e;
    }
    let runPromise: Promise<void>;
    try {
      runPromise = evaluator.install({
        durationMs: p.duration,
        easing: p.easing,
        commit: () => {
          // Order: run the plugin's commit (atomic with transition
          // end), THEN clear the compositor's transition slot so the
          // next frame draws normally, THEN release the scene pins
          // (which may fire the underlying surfaceBuf release on a
          // deferred-teardown path). All synchronous; the evaluator's
          // resolve fires after this returns.
          if (commit) {
            try { commit(); }
            catch (err) {
              console.error(
                `[transitions] plugin commit threw:`, err);
            }
          }
          clearActiveTransition();
          unpinScenes();
        },
      });
    } catch (e) {
      clearActiveTransition();
      unpinScenes();
      throw e;
    }

    // The run promise resolves when the evaluator's commit returns
    // (after our wrapper above). Plugin awaits this.
    await runPromise;
  }
}

interface RunPayload {
  outputId: number;
  kind: TransitionKind;
  duration: number;
  easing?: EasingSpec;
  fromSceneId: number;
  toSceneId: number;
  commitToken?: number;
}

function isRunPayload(d: unknown): d is RunPayload {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.outputId !== "number") return false;
  if (typeof o.kind !== "string") return false;
  if (typeof o.duration !== "number") return false;
  if (typeof o.fromSceneId !== "number" || o.fromSceneId <= 0) return false;
  if (typeof o.toSceneId !== "number" || o.toSceneId <= 0) return false;
  if (o.commitToken !== undefined && typeof o.commitToken !== "number") return false;
  // easing is validated by resolveEasing at install time; we don't
  // duplicate the closed-set check here.
  return true;
}
