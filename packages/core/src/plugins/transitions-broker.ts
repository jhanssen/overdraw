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
import { log } from "../log.js";

export const NOT_HANDLED = Symbol("transitions-broker:not-handled");

// Minimal slice of JsCompositor the broker calls. Implemented by
// JsCompositor in production; tests pass a mock. The two methods are
// optional on CompositorSink (the native compositor doesn't have
// them) -- the broker validates at construction.
//
// resolveTextures' return shape carries optional per-frame bracket
// hooks (beginRead/endRead). For ring-backed inputs (Worker-live)
// the compositor must call beginRead BEFORE encoding the transition
// pass and endRead AFTER the submit so the GPU process holds the
// STM-backed texture's access open across the sample. Stable inputs
// (in-thread, Worker snapshot) leave the hooks undefined.
export interface TransitionCompositorSink {
  setActiveTransition?: (opts: {
    fromTex: GPUTexture;
    toTex: GPUTexture;
    kind: TransitionKind;
    getProgress: () => number;
    resolveTextures?: () => {
      fromTex: GPUTexture;
      toTex: GPUTexture;
      beginRead?: () => void;
      endRead?: () => void;
    } | null;
  }) => void;
  clearActiveTransition?: () => void;
  // Phase 8 commit interpreter dependency: the broker applies
  // setOutputStack instructions on the completion tick directly
  // against the compositor, bypassing the SDK's postMessage hop
  // (which would resolve too late to be visible on the next frame).
  setOutputStack?: (outputId: number, ids: number[] | null) => void;
}

export interface TransitionsBrokerDeps {
  compositor: TransitionCompositorSink;
  evaluator: TransitionEvaluator;
  sceneRegistry: SceneRegistry;
}

export type TransitionsBroker = (
  pluginName: string, method: string, params: unknown,
) => Promise<unknown> | unknown | typeof NOT_HANDLED;

// Atomic-commit instructions the broker applies synchronously inside
// the evaluator's completion tick. Mirror of TransitionCommit in
// transitions-sdk; defined here too because the broker is the
// consumer + we don't want a cross-import. Plugin sends this as
// part of transitions.run; broker interprets each field in order
// before resolve() fires.
interface BrokerCommit {
  readonly setOutputStack?: ReadonlyArray<{
    outputId: number;
    ids: readonly number[] | null;
  }>;
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
  const setOutputStack = compositor.setOutputStack?.bind(compositor);

  // Apply declarative commit instructions. Each kind is independent;
  // the broker runs them in array order. Errors are caught + logged
  // (the run() Promise still resolves; a partial commit is bad but
  // throwing would leave the compositor in an inconsistent state too).
  function applyCommit(c: BrokerCommit): void {
    if (c.setOutputStack && setOutputStack) {
      for (const item of c.setOutputStack) {
        try {
          setOutputStack(item.outputId,
            item.ids === null ? null : item.ids.slice());
        } catch (e) {
          log.err("plugin",
            `transitions: commit setOutputStack(${item.outputId}) threw: %o`, e);
        }
      }
    }
  }

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

    // Resolve the commit instructions. Declarative shape; the broker
    // applies each instruction synchronously inside the completion
    // tick. p.commit was validated by the SDK on the plugin side;
    // re-check structurally here at the trust boundary.
    const commit = parseCommit(p.commit);

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
    // scenes (Worker-live), each scene's resolveTexture returns the
    // latest PRESENTED slot's texture plus per-frame Begin/End wire
    // brackets; the broker composes the two sides' brackets so the
    // compositor sees a single beginRead/endRead pair that wraps
    // both sample sources.
    const usesResolver = from.resolveTexture || to.resolveTexture;
    const resolveTextures = usesResolver
      ? (): {
          fromTex: GPUTexture; toTex: GPUTexture;
          beginRead?: () => void; endRead?: () => void;
        } | null => {
          const fRes = from.resolveTexture
            ? from.resolveTexture()
            : { texture: from.texture };
          const tRes = to.resolveTexture
            ? to.resolveTexture()
            : { texture: to.texture };
          if (!fRes || !tRes) return null;
          // Compose brackets across the two sides. Both sides being
          // bracketed (Worker-live <-> Worker-live) is the most common
          // ring case; the snapshot+live or live+snapshot mixes also
          // work because the snapshot side's resolveTexture is
          // undefined and we fall through to the stable texture.
          const beginAll = (fRes.beginRead || tRes.beginRead)
            ? (): void => {
                fRes.beginRead?.();
                tRes.beginRead?.();
              }
            : undefined;
          const endAll = (fRes.endRead || tRes.endRead)
            ? (): void => {
                // End in reverse order: last opened, first closed.
                // GPU process FIFO-orders per-surfaceBufId so this is
                // mainly hygiene, but matches Begin/End pairing rules.
                tRes.endRead?.();
                fRes.endRead?.();
              }
            : undefined;
          return {
            fromTex: fRes.texture, toTex: tRes.texture,
            beginRead: beginAll, endRead: endAll,
          };
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
          // Order: apply the declarative commit (atomic with
          // transition end, BEFORE the next renderFrame, so the post-
          // transition state is visible on the very next frame), THEN
          // clear the compositor's transition slot so the next frame
          // draws via the normal composite path, THEN release the
          // scene pins (deferred-teardown gates the underlying
          // surfaceBuf release). All synchronous; evaluator's resolve
          // fires after this returns.
          if (commit) applyCommit(commit);
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
  commit?: unknown;
}

function isRunPayload(d: unknown): d is RunPayload {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.outputId !== "number") return false;
  if (typeof o.kind !== "string") return false;
  if (typeof o.duration !== "number") return false;
  if (typeof o.fromSceneId !== "number" || o.fromSceneId <= 0) return false;
  if (typeof o.toSceneId !== "number" || o.toSceneId <= 0) return false;
  // commit is validated structurally by parseCommit; the type guard
  // here just accepts any value (including undefined).
  // easing is validated by resolveEasing at install time; we don't
  // duplicate the closed-set check here.
  return true;
}

// Structurally validate the declarative commit payload at the trust
// boundary. Returns null if the field was omitted; throws on bad
// shape (the run() Promise rejects, the install never happens).
function parseCommit(raw: unknown): BrokerCommit | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`transitions.run: commit must be an object`);
  }
  const o = raw as { [k: string]: unknown };
  const out: { setOutputStack?: BrokerCommit["setOutputStack"] } = {};
  if (o.setOutputStack !== undefined) {
    if (!Array.isArray(o.setOutputStack)) {
      throw new TypeError(
        `transitions.run: commit.setOutputStack must be an array`);
    }
    const items: Array<{ outputId: number; ids: number[] | null }> = [];
    for (const item of o.setOutputStack) {
      if (typeof item !== "object" || item === null) {
        throw new TypeError(
          `transitions.run: commit.setOutputStack[*] must be objects`);
      }
      const i = item as { [k: string]: unknown };
      if (typeof i.outputId !== "number") {
        throw new TypeError(
          `transitions.run: commit.setOutputStack[*].outputId must be a number`);
      }
      let ids: number[] | null;
      if (i.ids === null) {
        ids = null;
      } else if (Array.isArray(i.ids) && i.ids.every((v) => typeof v === "number")) {
        ids = (i.ids as number[]).slice();
      } else {
        throw new TypeError(
          `transitions.run: commit.setOutputStack[*].ids must be number[] or null`);
      }
      items.push({ outputId: i.outputId, ids });
    }
    out.setOutputStack = items;
  }
  return out;
}
