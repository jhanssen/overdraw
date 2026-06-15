// Transition evaluator (core-plugin-api.md §8). Owns the lifecycle of
// ONE active transition: start time, duration, easing, progress, commit
// callback, and the run() Promise. Decoupled from the compositor (which
// owns the GPU textures + WGSL pipeline) and from the broker (which
// owns the SceneHandle pinning + plugin SDK wiring); this object is
// purely the time math + state machine + Promise.
//
// Lifecycle:
//   idle -> install() -> running -> [first tick latches startMs] ->
//   running (progress advances) -> [tick where progress >= 1] ->
//   commit() (sync, before resolve) -> resolve() -> idle.
//
// Cancel is reserved for v2 (per build-order.md and the design's "no
// cancellation in v1" decision). install() throws synchronously if
// another transition is already active.

import type { EasingSpec } from "@overdraw/animation-types";
import { resolveEasing, type EasingFn } from "../animations/easing.js";
import { log } from "../log.js";

export interface TransitionInstallOpts {
  // Duration in ms. Must be > 0.
  readonly durationMs: number;
  // Easing applied to normalized time before publishing progress.
  // Defaults to "linear".
  readonly easing?: EasingSpec;
  // Synchronous callback fired on the completion tick, BEFORE the
  // run() Promise resolves. Used by the workspace plugin to flip
  // setOutputStack atomically with transition end so renderFrame draws
  // the post-transition state on the very next frame (no glitch).
  readonly commit?: () => void;
}

export interface TransitionEvaluator {
  // Install a transition. Throws synchronously if one is already
  // running (the broker pre-validates and reports the conflict to the
  // plugin as an Error). Returns a Promise that resolves on
  // completion. Never rejects in v1 (no cancellation).
  install(opts: TransitionInstallOpts): Promise<void>;
  // Per-frame tick. timeMs is the same value the animations evaluator
  // and dispatchFrameCallbacks see. No-op when idle.
  tick(timeMs: number): void;
  // Eased progress in [0, 1], or null when idle. The compositor reads
  // this once per frame via the callback installed in setActiveTransition.
  getProgress(): number | null;
  // True when a transition is running. The broker checks this in
  // install() to enforce no-overlap, and tests rely on it.
  isActive(): boolean;
  // Diagnostics for tests.
  durationMs(): number | null;
}

interface ActiveTransition {
  readonly durationMs: number;
  readonly easing: EasingFn;
  readonly commit: (() => void) | undefined;
  readonly resolve: () => void;
  // First tick after install latches startMs. We don't use the install
  // timestamp because installs may happen between frames (e.g. inside a
  // plugin's microtask) and we want the very next compositor frame to
  // count as t=0 -- otherwise a transition installed 5ms before the
  // next frame would already be 5ms in when first rendered.
  startMs: number | null;
  // Last computed eased progress (0..1). Read by the compositor's
  // per-frame setActiveTransition.getProgress callback.
  progress: number;
}

export function createTransitionEvaluator(): TransitionEvaluator {
  let active: ActiveTransition | null = null;

  return {
    install(opts: TransitionInstallOpts): Promise<void> {
      if (active !== null) {
        throw new Error("transitions.install: a transition is already active");
      }
      if (!(opts.durationMs > 0) || !Number.isFinite(opts.durationMs)) {
        throw new Error(
          `transitions.install: durationMs must be > 0 (got ${opts.durationMs})`);
      }
      // Resolve easing synchronously so a bad spec (unknown preset)
      // throws to the caller at install time rather than later.
      const easing = resolveEasing(opts.easing);
      return new Promise<void>((resolve) => {
        active = {
          durationMs: opts.durationMs,
          easing,
          commit: opts.commit,
          resolve,
          startMs: null,
          progress: 0,
        };
      });
    },

    tick(timeMs: number): void {
      if (active === null) return;
      if (active.startMs === null) {
        active.startMs = timeMs;
        active.progress = active.easing(0);
        return;
      }
      const rawT = (timeMs - active.startMs) / active.durationMs;
      if (rawT >= 1) {
        active.progress = active.easing(1);
        // Snapshot the current active transition; clear FIRST so the
        // commit callback (which may install a follow-up transition)
        // sees an idle evaluator. Resolving second lets observers
        // chained to the run() Promise see the idle state too.
        const a = active;
        active = null;
        if (a.commit) {
          try { a.commit(); }
          catch (e) { log.err("core", "transitions: commit threw: %o", e); }
        }
        a.resolve();
        return;
      }
      // Clamp negative t (clock went backwards) to 0; otherwise pass
      // through the easing function.
      active.progress = active.easing(rawT < 0 ? 0 : rawT);
    },

    getProgress(): number | null {
      return active === null ? null : active.progress;
    },

    isActive(): boolean { return active !== null; },

    durationMs(): number | null {
      return active === null ? null : active.durationMs;
    },
  };
}
