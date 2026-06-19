// Transitions broker: routes plugin transitions.run requests to the
// core transition evaluator + compositor (core-plugin-api.md §8).
//
// The plugin calls sdk.transitions.run({outputId, kind, duration, easing,
// from, to, commit?}). The broker:
//   1. Resolves fromSceneId/toSceneId via the SceneRegistry to core-side
//      GPUTextures + outW/outH.
//   2. Pins both registry entries so a buggy plugin's SceneHandle.release()
//      during the transition defers, not yanks the textures.
//   3. Installs the transition on the compositor for that output
//      (setActiveTransition(outputId, ...)).
//   4. Allocates a per-output TransitionEvaluator and installs the time
//      machine on it (install()).
//   5. On completion (evaluator's commit callback): runs the plugin's
//      commit, clears the compositor's transition slot for that output,
//      releases the evaluator, unpins both scenes, resolves the plugin's
//      run() Promise.
//
// Conflict policy: per-output. Two simultaneous transitions on different
// outputs are allowed (each output owns its own active-transition slot
// and its own evaluator). A second install on an output that already has
// an active transition throws.
//
// Worker-live scene sharing: when two outputs' transitions sample the
// same scene (e.g. b->a on output 0, c->b on output 1, sharing b), the
// compositor dedups the producer Begin/End brackets across outputs in
// the same frame via the per-side fromBracket/toBracket carrying the
// sceneId. This broker emits per-side brackets keyed by sceneId; it does
// not compose the two sides' brackets into a single pair (that would
// defeat the cross-output dedup).

import type { TransitionEvaluator } from "../transitions/evaluator.js";
import { createTransitionEvaluator } from "../transitions/evaluator.js";
import type { SceneRegistry } from "./scene-registry.js";
import type { TransitionKind } from "@overdraw/transition-types";
import { TRANSITION_KINDS } from "@overdraw/transition-types";
import type { EasingSpec } from "@overdraw/animation-types";
import { log } from "../log.js";

export const NOT_HANDLED = Symbol("transitions-broker:not-handled");

// Per-side scene bracket: producer Begin/End on one scene's surfaceBufId
// for one frame. The compositor groups Begins by sceneId so simultaneous
// per-output transitions sharing a scene open it exactly once per frame.
interface TransitionBracket {
  sceneId: number;
  beginRead: () => void;
  endRead: () => void;
}

// Minimal slice of JsCompositor the broker calls. Implemented by
// JsCompositor in production; tests pass a mock. The two methods are
// optional on CompositorSink (the native compositor doesn't have
// them) -- the broker validates at construction.
export interface TransitionCompositorSink {
  setActiveTransition?: (outputId: number, opts: {
    fromTex: GPUTexture;
    toTex: GPUTexture;
    kind: TransitionKind;
    getProgress: () => number;
    resolveTextures?: () => {
      fromTex: GPUTexture;
      toTex: GPUTexture;
      fromBracket?: TransitionBracket;
      toBracket?: TransitionBracket;
    } | null;
  }) => void;
  clearActiveTransition?: (outputId: number) => void;
  // The broker applies setOutputStack instructions on the completion tick
  // directly against the compositor, bypassing the SDK's postMessage hop
  // (which would resolve too late to be visible on the next frame).
  setOutputStack?: (outputId: number, ids: number[] | null) => void;
}

export interface TransitionsBrokerDeps {
  compositor: TransitionCompositorSink;
  sceneRegistry: SceneRegistry;
  // Predicate the broker uses to validate transitions.run's outputId at
  // the trust boundary. Today the live registry is state.outputs; the
  // broker accepts a predicate so it does not couple to CompositorState.
  hasOutput: (outputId: number) => boolean;
  // Optional post-commit hook fired AFTER the broker applies a setOutputStack
  // instruction in the transition's commit phase. The host wires this to
  // sync state.outputToplevelStacks + schedule a relayout so the layout-
  // driver picks up the new visible set on the next pass. Without it, the
  // workspace plugin's transition-driven swap would update only the
  // compositor's stack filter; the layout-driver would still see the old
  // ids (the workspace plugin's normal setOutputStack path is bypassed).
  onSetOutputStackCommit?: (outputId: number, ids: number[] | null) => void;
}

// The broker is both a request handler (for plugin transitions.* calls)
// and a per-output evaluator pool the host ticks each frame.
export interface TransitionsBroker {
  // Request handler. Returns NOT_HANDLED for unknown methods.
  handle(pluginName: string, method: string, params: unknown):
    Promise<unknown> | unknown | typeof NOT_HANDLED;
  // Tick every active per-output evaluator. Called from beforeRender each
  // frame with the same timeMs all evaluators consume.
  tick(timeMs: number): void;
  // True iff any output has an active transition. Drives wakeIfActive.
  anyActive(): boolean;
}

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
  const { compositor, sceneRegistry, hasOutput } = deps;
  if (!compositor.setActiveTransition || !compositor.clearActiveTransition) {
    throw new Error(
      "createTransitionsBroker: compositor lacks setActiveTransition / " +
      "clearActiveTransition (JS compositor required)");
  }
  const setActiveTransition = compositor.setActiveTransition.bind(compositor);
  const clearActiveTransition = compositor.clearActiveTransition.bind(compositor);
  const setOutputStack = compositor.setOutputStack?.bind(compositor);

  // Per-output evaluator pool. Allocated lazily on first transition for an
  // outputId; removed when that output's transition completes (commit
  // callback) or its install fails. Each evaluator is a pure single-active
  // state machine, oblivious to output identity -- the pool layer here
  // turns N independent transitions into N independent evaluators.
  const evaluators = new Map<number, TransitionEvaluator>();

  // Apply declarative commit instructions. Each kind is independent;
  // the broker runs them in array order. Errors are caught + logged
  // (the run() Promise still resolves; a partial commit is bad but
  // throwing would leave the compositor in an inconsistent state too).
  function applyCommit(c: BrokerCommit): void {
    if (c.setOutputStack && setOutputStack) {
      for (const item of c.setOutputStack) {
        try {
          const idsCopy = item.ids === null ? null : item.ids.slice();
          setOutputStack(item.outputId, idsCopy);
          deps.onSetOutputStackCommit?.(item.outputId, idsCopy);
        } catch (e) {
          log.err("plugin",
            `transitions: commit setOutputStack(${item.outputId}) threw: %o`, e);
        }
      }
    }
  }

  async function handleRun(p: unknown): Promise<void> {
    if (!isRunPayload(p)) {
      throw new Error("transitions.run: malformed payload");
    }
    if (!hasOutput(p.outputId)) {
      throw new Error(
        `transitions.run: outputId=${p.outputId} is not a known output`);
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
    // applies each instruction synchronously inside the completion tick.
    // p.commit was validated by the SDK on the plugin side; re-check
    // structurally here at the trust boundary.
    const commit = parseCommit(p.commit);

    // Allocate the per-output evaluator. A pre-existing entry means this
    // output already has an in-flight transition -- reject before pinning
    // scenes or touching the compositor.
    if (evaluators.has(p.outputId)) {
      throw new Error(
        `transitions.run: a transition is already active on output ${p.outputId}`);
    }
    const evaluator = createTransitionEvaluator();
    evaluators.set(p.outputId, evaluator);

    // Pin the scenes BEFORE installing on the compositor. Failure to pin
    // (entry being torn down) throws here and the install never happens.
    sceneRegistry.pin(p.fromSceneId);
    try {
      sceneRegistry.pin(p.toSceneId);
    } catch (e) {
      sceneRegistry.unpin(p.fromSceneId);
      evaluators.delete(p.outputId);
      throw e;
    }

    // Per-frame resolver. Stable scenes (no resolveTexture on either side)
    // skip the callback entirely; the compositor uses fromTex/toTex every
    // frame. Worker-live scenes return per-frame textures plus producer
    // Begin/End brackets KEYED BY sceneId so the compositor dedups Begins
    // across simultaneous per-output transitions sharing a scene.
    const usesResolver = from.resolveTexture || to.resolveTexture;
    const resolveTextures = usesResolver
      ? (): {
          fromTex: GPUTexture; toTex: GPUTexture;
          fromBracket?: TransitionBracket;
          toBracket?: TransitionBracket;
        } | null => {
          const fRes = from.resolveTexture
            ? from.resolveTexture()
            : { texture: from.texture };
          const tRes = to.resolveTexture
            ? to.resolveTexture()
            : { texture: to.texture };
          if (!fRes || !tRes) return null;
          // The two sides flow as independent brackets; the compositor
          // groups them by sceneId per frame. A side without beginRead/
          // endRead (snapshot scene) contributes no bracket -- it's
          // sampled freely.
          const fromBracket: TransitionBracket | undefined =
            fRes.beginRead && fRes.endRead
              ? { sceneId: p.fromSceneId,
                  beginRead: fRes.beginRead, endRead: fRes.endRead }
              : undefined;
          const toBracket: TransitionBracket | undefined =
            tRes.beginRead && tRes.endRead
              ? { sceneId: p.toSceneId,
                  beginRead: tRes.beginRead, endRead: tRes.endRead }
              : undefined;
          return {
            fromTex: fRes.texture, toTex: tRes.texture,
            fromBracket, toBracket,
          };
        }
      : undefined;

    // Idempotent unpin used on success and on rollback paths.
    let unpinned = false;
    const unpinScenes = (): void => {
      if (unpinned) return;
      unpinned = true;
      sceneRegistry.unpin(p.fromSceneId);
      sceneRegistry.unpin(p.toSceneId);
    };

    // Install on compositor + evaluator. Either may throw synchronously
    // on conflict; the rollback path mirrors success.
    try {
      setActiveTransition(p.outputId, {
        fromTex: from.texture,
        toTex: to.texture,
        kind: p.kind,
        getProgress: () => evaluator.getProgress() ?? 0,
        resolveTextures,
      });
    } catch (e) {
      unpinScenes();
      evaluators.delete(p.outputId);
      throw e;
    }
    let runPromise: Promise<void>;
    try {
      runPromise = evaluator.install({
        durationMs: p.duration,
        easing: p.easing,
        commit: () => {
          // Order: apply the declarative commit (atomic with transition
          // end, BEFORE the next renderFrame, so the post-transition
          // state is visible on the very next frame), THEN clear the
          // compositor's transition slot for this output, THEN release
          // the scene pins, THEN drop the evaluator from the pool. All
          // synchronous; evaluator's resolve fires after this returns.
          if (commit) applyCommit(commit);
          clearActiveTransition(p.outputId);
          unpinScenes();
          evaluators.delete(p.outputId);
        },
      });
    } catch (e) {
      clearActiveTransition(p.outputId);
      unpinScenes();
      evaluators.delete(p.outputId);
      throw e;
    }

    // The run promise resolves when the evaluator's commit returns
    // (after our wrapper above). Plugin awaits this.
    await runPromise;
  }

  return {
    handle(pluginName, method, params) {
      void pluginName;
      if (method === "transitions.run") return handleRun(params);
      return NOT_HANDLED;
    },
    tick(timeMs) {
      // Snapshot before tick: commit callbacks may mutate the map (delete
      // their own entry) and a Map's iteration over concurrent deletes is
      // implementation-defined enough to avoid relying on.
      const all = [...evaluators.values()];
      for (const ev of all) ev.tick(timeMs);
    },
    anyActive() {
      return evaluators.size > 0;
    },
  };
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
