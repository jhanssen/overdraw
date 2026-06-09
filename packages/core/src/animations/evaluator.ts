// Core animation evaluator (core-plugin-api.md §9). Holds the active
// animation list, ticks them once per compositor frame from
// protocols/index.ts dispatchFrameCallbacks, and writes the new values
// through the CompositorSink. v1 supports tween + spring leaves; the
// composite specs sequence + parallel unfold into leaves whose Promises
// the composite awaits.
//
// Cancel-on-replacement keys on (target.kind, target.windowId): only
// one leaf-level animation is active per target at a time. A new leaf
// targeting (kind, windowId) cancels the prior one (its Promise
// resolves cleanly, then the new one starts on the next tick). A
// sdk.animations.cancel(target) call resolves the same way.

import type { CompositorSink } from "../protocols/ctx.js";
import type {
  AnimationHandle, AnimationSpec, ParallelSpec, SequenceSpec,
  SpringSpec, TargetRef, TweenSpec,
} from "./spec.js";
import { resolveEasing, type EasingFn } from "./easing.js";
import { DEFAULT_SPRING, SpringState, type SpringParams } from "./spring.js";
import { applyValue, coerceValue } from "./value.js";

// One running leaf animation (tween or spring). Each leaf owns its own
// Promise; composite specs (sequence / parallel) await leaf Promises
// directly. Only leaves drive the per-frame tick.
interface ActiveLeaf {
  handle: AnimationHandle;
  target: TargetRef;
  // Resolves cleanly on natural completion OR cancellation.
  settle: () => void;
  // Drive one frame. Returns true if the leaf finished this step.
  step(dtSec: number): boolean;
}

interface TweenLeaf extends ActiveLeaf {
  readonly kind: "tween";
  // Component-wise from/to (canonical order per target kind).
  readonly from: readonly number[];
  readonly to: readonly number[];
  readonly durationSec: number;
  readonly easing: EasingFn;
  // Elapsed time in seconds since the leaf started.
  elapsedSec: number;
}

interface SpringLeaf extends ActiveLeaf {
  readonly kind: "spring";
  readonly springs: SpringState[];  // one per component
}

type Leaf = TweenLeaf | SpringLeaf;

export interface AnimationEvaluator {
  // Submit a spec. Returns a Promise that resolves when the entire
  // composite (or single leaf) settles or is cancelled.
  run(spec: AnimationSpec): Promise<void>;
  // Cancel the active leaf on `target`, if any. Resolves immediately;
  // the cancelled leaf's run() Promise also resolves cleanly. No-op if
  // no leaf is active on that target.
  cancel(target: TargetRef): Promise<void>;
  // Per-compositor-frame tick. timeMs is the same value passed to
  // dispatchFrameCallbacks; the evaluator computes dt internally.
  tick(timeMs: number): void;
  // Diagnostics / tests.
  activeCount(): number;
}

export interface EvaluatorOptions {
  // Clamp dt to this maximum (seconds) to keep first-tick / long-pause
  // jumps from spawning huge accelerations / overshoots. Default 100ms.
  readonly maxDtSec?: number;
}

export function createEvaluator(
  sink: CompositorSink, opts: EvaluatorOptions = {},
): AnimationEvaluator {
  const leaves = new Map<string, Leaf>();
  let lastTickMs: number | null = null;
  let nextHandle: AnimationHandle = 1;
  const maxDtSec = opts.maxDtSec ?? 0.1;

  function targetKey(t: TargetRef): string {
    return `${t.kind}:${t.windowId}`;
  }

  // Cancel-on-replacement: if a leaf is already active on this target,
  // resolve its Promise cleanly + remove it from the map. Idempotent.
  function preemptTarget(t: TargetRef): void {
    const existing = leaves.get(targetKey(t));
    if (existing) {
      leaves.delete(targetKey(t));
      existing.settle();
    }
  }

  function startTween(spec: TweenSpec): Promise<void> {
    if (spec.duration <= 0 || !Number.isFinite(spec.duration)) {
      // Zero-duration: snap to `to` immediately. Avoids divide-by-zero.
      applyValue(sink, spec.target, coerceValue(spec.target, spec.to));
      preemptTarget(spec.target);
      return Promise.resolve();
    }
    const from = coerceValue(spec.target, spec.from);
    const to = coerceValue(spec.target, spec.to);
    if (from.length !== to.length) {
      throw new Error("tween: from/to component count mismatch");
    }
    preemptTarget(spec.target);
    return new Promise<void>((resolve) => {
      const leaf: TweenLeaf = {
        kind: "tween",
        handle: nextHandle++,
        target: spec.target,
        from, to,
        durationSec: spec.duration / 1000,
        easing: resolveEasing(spec.easing),
        elapsedSec: 0,
        settle: resolve,
        step(dtSec: number): boolean {
          this.elapsedSec += dtSec;
          const t = Math.min(this.elapsedSec / this.durationSec, 1);
          const eased = this.easing(t);
          const out = new Array(this.from.length);
          for (let i = 0; i < this.from.length; i++) {
            out[i] = this.from[i] + (this.to[i] - this.from[i]) * eased;
          }
          applyValue(sink, this.target, out);
          return t >= 1;
        },
      };
      leaves.set(targetKey(spec.target), leaf);
    });
  }

  function startSpring(spec: SpringSpec): Promise<void> {
    const from = coerceValue(spec.target, spec.from);
    const to = coerceValue(spec.target, spec.to);
    if (from.length !== to.length) {
      throw new Error("spring: from/to component count mismatch");
    }
    const params: SpringParams = {
      stiffness: spec.stiffness ?? DEFAULT_SPRING.stiffness,
      damping: spec.damping ?? DEFAULT_SPRING.damping,
      mass: spec.mass ?? DEFAULT_SPRING.mass,
      initialVelocity: spec.initialVelocity ?? DEFAULT_SPRING.initialVelocity,
    };
    preemptTarget(spec.target);
    return new Promise<void>((resolve) => {
      const springs = from.map((f, i) => new SpringState(f, to[i], params));
      const leaf: SpringLeaf = {
        kind: "spring",
        handle: nextHandle++,
        target: spec.target,
        springs,
        settle: resolve,
        step(dtSec: number): boolean {
          let allDone = true;
          const out = new Array(this.springs.length);
          for (let i = 0; i < this.springs.length; i++) {
            const done = this.springs[i].step(dtSec);
            out[i] = this.springs[i].value;
            if (!done) allDone = false;
          }
          applyValue(sink, this.target, out);
          return allDone;
        },
      };
      leaves.set(targetKey(spec.target), leaf);
    });
  }

  async function startSequence(spec: SequenceSpec): Promise<void> {
    for (const item of spec.items) {
      await dispatchSpec(item);
    }
  }

  async function startParallel(spec: ParallelSpec): Promise<void> {
    await Promise.all(spec.items.map(dispatchSpec));
  }

  function dispatchSpec(spec: AnimationSpec): Promise<void> {
    switch (spec.type) {
      case "tween": return startTween(spec);
      case "spring": return startSpring(spec);
      case "sequence": return startSequence(spec);
      case "parallel": return startParallel(spec);
    }
  }

  return {
    run(spec: AnimationSpec): Promise<void> {
      return dispatchSpec(spec);
    },
    cancel(target: TargetRef): Promise<void> {
      preemptTarget(target);
      return Promise.resolve();
    },
    tick(timeMs: number): void {
      if (lastTickMs === null) { lastTickMs = timeMs; return; }
      const dtSec = Math.min((timeMs - lastTickMs) / 1000, maxDtSec);
      lastTickMs = timeMs;
      if (dtSec <= 0 || leaves.size === 0) return;
      // Snapshot keys: a leaf's settle() may trigger a sequence's next
      // item to start (a new entry); the new leaf is added to the map
      // mid-loop. Iterating a snapshot of the current frame's keys
      // keeps each tick deterministic -- the new leaf waits for the
      // next tick to first step.
      const keys = [...leaves.keys()];
      for (const key of keys) {
        const leaf = leaves.get(key);
        if (!leaf) continue;
        const done = leaf.step(dtSec);
        if (done) {
          leaves.delete(key);
          leaf.settle();
        }
      }
    },
    activeCount(): number { return leaves.size; },
  };
}
