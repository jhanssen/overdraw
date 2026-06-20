// Surface-transaction broker.
//
// Generic "freeze this surface until something happens" primitive. The
// compositor keeps showing the surface's pre-hold appearance (via
// freezeSurface's GPU snapshot) while a set of conditions resolves; once
// every requirement on the surface's hold is ready (or the deadline
// fires) the broker calls each requirement's onApply and thaws.
//
// Two patterns drive this primitive:
//   - Resize transaction: the WM holds new geometry while clients re-render
//     at a new size. ready = configure acked + a drawable buffer at the
//     new size; onApply = push the held geometry. Multiple windows that
//     swap places must apply in one atomic batch (otherwise they overlap
//     mid-swap), so the WM registers each surface's hold with the SAME
//     batchKey and the broker waits for the slowest hold in the batch
//     before applying any of them.
//   - Cross-output move: a window's outer just moved to a different
//     output. ready = the client has committed at least one new buffer
//     since hold-start (= it has reallocated at the new output's scale);
//     onStart drives wl_surface.enter/leave + preferred_scale to the
//     client; onApply is a no-op (the WM's own hold, if present, owns the
//     geometry swap). Registered without a batchKey, so it applies
//     independently of any concurrent WM tx batch.
//
// A surface has at most one active hold; concurrent call sites add
// requirements to the same hold via begin(). onStart is called once when
// the hold is first created (= freezeSurface time); later requirements
// joining an existing hold do NOT re-trigger onStart -- the surface is
// already frozen, and the joining caller is responsible for whatever
// setup it needs.

import { log } from "./log.js";

// The slice of the compositor sink the broker needs. Each method is
// optional so GPU-free test sinks remain valid.
export interface SurfaceFreezeSink {
  freezeSurface?(id: number): void;
  thawSurface?(id: number): void;
  setFrozenReadyHandler?(cb: (id: number) => void): void;
}

// A single requirement contributed by one call site.
export interface HoldRequirement {
  // Free-form tag for logging; e.g. "resize-tx", "cross-output".
  tag: string;
  // Re-evaluated on every relevant signal. Return true when this
  // requirement no longer blocks the hold.
  ready(): boolean;
  // Optional batch grouping. Holds sharing the same non-null batchKey
  // wait for each other and apply together (atomic from the on-screen
  // point of view). Null/undefined = the hold applies as soon as ITS
  // own requirements are ready, independent of any other hold.
  batchKey?: string | null;
  // Side effect run as the surface is first frozen for this hold. NOT
  // called when this requirement joins an existing hold (the surface is
  // already frozen; the caller drives any joining-time setup itself).
  onStart?(): void;
  // Side effect run as part of apply, just before thaw.
  onApply?(): void;
  // Side effect run if the hold is cancelled without applying.
  onCancel?(): void;
  // Side effect run when the compositor signals that the frozen surface
  // has a fresh drawable buffer (= the client has rendered at least one
  // new frame since the hold began). Cross-output residency uses this:
  // it's how it knows "the client reallocated at the new scale". This
  // hook fires BEFORE the broker re-evaluates ready(), so the hook can
  // flip a flag the same requirement's ready() then reads.
  onFrozenReady?(): void;
}

export interface SurfaceTransactionBroker {
  // Add a requirement for surfaceId. If no hold exists for the surface,
  // freezeSurface is called and req.onStart fires synchronously. If a
  // hold already exists, the new requirement joins it. After registering
  // the requirement, the broker re-evaluates readiness immediately --
  // an already-ready requirement applies right away (subject to its
  // batchKey peers also being ready).
  begin(surfaceId: number, req: HoldRequirement): void;
  // External "something happened" hook. Re-checks every hold; applies
  // any whose requirements are all ready (respecting batch grouping).
  evaluate(): void;
  // Drop every requirement for the surface without applying. Calls each
  // req.onCancel and thaws. Used when a surface unmaps.
  cancel(surfaceId: number): void;
  // True iff there is at least one requirement registered for the
  // surface.
  has(surfaceId: number): boolean;
  // Register a callback fired once after each batch apply (after every
  // hold's onApply + thaw in the batch has completed). Used by callers
  // that need to push deferred side effects atomically with the broker
  // apply -- e.g. compositor.setOutputStack pushes that were withheld
  // during the hold to prevent the surface from being drawn on the new
  // output before its geometry has moved there.
  onAfterApply(cb: () => void): void;
  // Test/diagnostic helpers.
  size(): number;
  tagsFor(surfaceId: number): ReadonlyArray<string>;
}

interface InternalHold {
  surfaceId: number;
  reqs: HoldRequirement[];
  // Absolute time after which the hold is force-applied even if some
  // requirement is still not ready. Inf = no deadline.
  deadlineAt: number;
}

export interface SurfaceTransactionBrokerOptions {
  // Maximum hold duration. After this, the broker applies even when
  // requirements remain unready. Matches the WM's existing 150ms timeout.
  timeoutMs?: number;
  // Optional injected clock + timer for tests.
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 150;

export function createSurfaceTransactionBroker(
  sink: SurfaceFreezeSink,
  opts: SurfaceTransactionBrokerOptions = {},
): SurfaceTransactionBroker {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((cb, ms) => {
    const h: ReturnType<typeof setTimeout> & { unref?: () => void } = setTimeout(cb, ms);
    h.unref?.();
    return h;
  });
  const clearTimer = opts.clearTimer ?? ((h) => { clearTimeout(h as ReturnType<typeof setTimeout>); });

  const holds = new Map<number, InternalHold>();
  const afterApplyCbs: Array<() => void> = [];
  let timer: unknown = null;

  // Forward the compositor's frozen-ready callback into evaluate. The
  // signal is per-surface, but the batch invariant means we re-check
  // every hold anyway; just gate the work on "hold exists for this id".
  sink.setFrozenReadyHandler?.((id) => {
    const h = holds.get(id);
    if (!h) return;
    for (const r of h.reqs) {
      if (!r.onFrozenReady) continue;
      try { r.onFrozenReady(); }
      catch (e) { log.warn("core", `surface-tx onFrozenReady (${r.tag}) threw: ${String(e)}`); }
    }
    evaluate();
  });

  function holdReady(h: InternalHold): boolean {
    for (const r of h.reqs) if (!r.ready()) return false;
    return true;
  }

  // Decide which holds can apply this round. Independent holds (no
  // batchKey) apply individually as their own reqs go ready. Batched
  // holds apply only when every other hold sharing the same batchKey is
  // also ready. Force-elapsed deadlines override readiness and drag the
  // whole batch (including its not-yet-ready peers) into apply.
  function holdsToApply(forceElapsed: boolean): InternalHold[] {
    const t = now();
    const apply: InternalHold[] = [];
    // Group by batchKey first (null = independent).
    const groups = new Map<string | null, InternalHold[]>();
    for (const h of holds.values()) {
      // Conservative: all reqs in a hold should share batch semantics.
      // The "effective" key for a multi-req hold is the FIRST non-null
      // batchKey among its reqs, or null. Concurrent call sites adding
      // requirements with different batch semantics is an unusual case
      // that we resolve by binding the hold to whichever key arrives
      // first; later same-key joiners are absorbed.
      let key: string | null = null;
      for (const r of h.reqs) {
        if (r.batchKey != null) { key = r.batchKey; break; }
      }
      const arr = groups.get(key); if (arr) arr.push(h); else groups.set(key, [h]);
    }
    for (const [key, group] of groups) {
      if (key === null) {
        // Independent: each hold decides for itself.
        for (const h of group) {
          if (holdReady(h) || (forceElapsed && h.deadlineAt <= t)) apply.push(h);
        }
      } else {
        // Batched: gate on every member.
        const allReady = group.every(holdReady);
        const anyExpired = forceElapsed && group.some((h) => h.deadlineAt <= t);
        if (allReady || anyExpired) for (const h of group) apply.push(h);
      }
    }
    return apply;
  }

  function clearTimerIfIdle(): void {
    if (timer !== null && holds.size === 0) {
      clearTimer(timer);
      timer = null;
    }
  }

  function armTimer(): void {
    if (timer !== null) return;
    let earliest = Infinity;
    for (const h of holds.values()) if (h.deadlineAt < earliest) earliest = h.deadlineAt;
    if (!Number.isFinite(earliest)) return;
    const delay = Math.max(1, earliest - now());
    const tick = (): void => {
      timer = null;
      if (holds.size === 0) return;
      // Deadline fired: force-apply anything whose deadline has elapsed
      // (which may pull along its batch peers). Then re-arm for any
      // hold still hanging on.
      const list = holdsToApply(true);
      if (list.length) doApply(list);
      if (holds.size > 0) armTimer();
    };
    timer = setTimer(tick, delay);
  }

  function evaluate(): void {
    if (holds.size === 0) { clearTimerIfIdle(); return; }
    const list = holdsToApply(false);
    if (list.length) doApply(list);
  }

  function doApply(list: InternalHold[]): void {
    // Atomically remove from the map first so anything triggered during
    // onApply (e.g. setSurfaceLayout side effects, downstream events)
    // sees the holds gone and won't recurse.
    for (const h of list) holds.delete(h.surfaceId);
    if (holds.size === 0 && timer !== null) { clearTimer(timer); timer = null; }
    for (const h of list) {
      for (const r of h.reqs) {
        try { r.onApply?.(); }
        catch (e) { log.warn("core", `surface-tx onApply (${r.tag}) threw: ${String(e)}`); }
      }
      sink.thawSurface?.(h.surfaceId);
    }
    // Post-apply hooks fire AFTER all onApply + thaw -- callers use this
    // to push deferred side effects atomically with the apply (e.g. a
    // queued setOutputStack that was withheld during the hold).
    for (const cb of afterApplyCbs) {
      try { cb(); }
      catch (e) { log.warn("core", `surface-tx onAfterApply threw: ${String(e)}`); }
    }
  }

  return {
    begin(surfaceId, req) {
      let h = holds.get(surfaceId);
      const fresh = !h;
      if (!h) {
        h = {
          surfaceId,
          reqs: [],
          deadlineAt: timeoutMs > 0 ? now() + timeoutMs : Infinity,
        };
        holds.set(surfaceId, h);
      } else if (timeoutMs > 0) {
        // Extend the deadline so a late-joining requirement gets a fair
        // window to satisfy itself. Without this, a hold that's about
        // to time out would yank the floor out from under the joiner.
        const newDeadline = now() + timeoutMs;
        if (newDeadline > h.deadlineAt) h.deadlineAt = newDeadline;
      }
      h.reqs.push(req);
      if (fresh) {
        sink.freezeSurface?.(surfaceId);
        try { req.onStart?.(); }
        catch (e) { log.warn("core", `surface-tx onStart (${req.tag}) threw: ${String(e)}`); }
      }
      armTimer();
      // Newly-added requirements can be already-ready; re-check.
      evaluate();
    },

    evaluate,

    cancel(surfaceId) {
      const h = holds.get(surfaceId);
      if (!h) return;
      holds.delete(surfaceId);
      for (const r of h.reqs) {
        try { r.onCancel?.(); }
        catch (e) { log.warn("core", `surface-tx onCancel (${r.tag}) threw: ${String(e)}`); }
      }
      sink.thawSurface?.(surfaceId);
      clearTimerIfIdle();
    },

    has(surfaceId) { return holds.has(surfaceId); },
    onAfterApply(cb) { afterApplyCbs.push(cb); },
    size() { return holds.size; },
    tagsFor(surfaceId) {
      const h = holds.get(surfaceId);
      return h ? h.reqs.map((r) => r.tag) : [];
    },
  };
}
