// Intercept match engine. Tracks every mapped toplevel's (surfaceId,
// appId, title) and runs an O(N x R) match check (N toplevels, R
// registrations) on each register / unregister / appId change / map /
// unmap event. Pure JS, no GPU, no compositor -- testable in isolation.
//
// 10a coverage: toplevels only. Popups + subsurfaces of matched clients
// draw raw. 10b extends coverage.
//
// Match resolution: first-registered match wins (deterministic across
// plugin restarts). 10b replaces this with category-ordered chains.
//
// The engine emits two abstract events the broker turns into plugin
// callbacks: 'matched' (surface newly satisfies registration r) and
// 'unmatched' (surface previously matched by r no longer does). The
// engine doesn't know about plugin callbacks; the broker wires those.

import type { InterceptableRole, InterceptMatch } from "@overdraw/intercept-types";

// Internal representation of one registration. The broker holds the
// plugin handlers; the engine just stores enough to evaluate the match.
export interface RegistrationData {
  id: number;
  pluginName: string;
  // Compiled regex (the source/flags is what crosses the wire; we
  // compile here so an invalid pattern fails register).
  appIdRegex: RegExp | null;
  // null = default ["toplevel"] in 10a (the only role we support
  // matching against; spec roles are recorded for forward
  // compatibility).
  roles: ReadonlyArray<InterceptableRole> | null;
  // Lower numbers match first. Same-priority resolves by insertion
  // order (insertionSeq).
  priority: number;
  // A fullscreen toplevel never satisfies this registration (see
  // InterceptMatch.excludeFullscreen).
  excludeFullscreen: boolean;
  // Monotonically increasing per-engine counter assigned at
  // addRegistration time. Tie-breaker for same-priority entries.
  insertionSeq: number;
}

// A mapped toplevel's match-relevant fields. Updated by the broker on
// window.map / window.change / window.unmap / window.committed
// (exclusive transitions).
export interface ToplevelData {
  surfaceId: number;
  appId: string | null;
  title: string | null;
  // Current exclusive=fullscreen state. Optional: an update that omits
  // it (e.g. the map event, which doesn't carry window state) leaves
  // the tracked value unchanged.
  fullscreen?: boolean;
}

// Events the engine emits abstractly. The broker translates to plugin
// callbacks (onSurfaceMatched / onSurfaceUnmatched).
export interface MatchEvent {
  kind: "matched" | "unmatched";
  registrationId: number;
  surfaceId: number;
}

export class MatchEngine {
  // Registrations sorted by (priority asc, insertionSeq asc).
  // First-match-wins iterates this list head-to-tail; the sort means
  // lower priority wins, and same-priority falls back to registration
  // order.
  private registrations: RegistrationData[] = [];
  // Mapped toplevels keyed by surfaceId. Updated by the broker.
  private toplevels = new Map<number, ToplevelData>();
  // Current (toplevel surfaceId -> registration id) match assignments.
  // Sparse: only assigned surfaces appear.
  private assignments = new Map<number, number>();
  // Monotonic insertion counter; assigned to each new registration so
  // same-priority registrations resolve in registration order.
  private nextInsertionSeq = 0;

  registerCount(): number { return this.registrations.length; }

  // Add a registration. Returns the synthetic registration id. Re-
  // evaluates every existing toplevel and returns the events caused by
  // the new registration. Critically, a higher-priority (= numerically
  // lower) new registration can STEAL surfaces from a lower-priority
  // existing registration: the returned events include both the
  // unmatched event for the prior owner and the matched event for the
  // new winner. Same-priority and lower-priority new registrations only
  // pick up unassigned surfaces (first-match-wins inside a priority
  // band).
  addRegistration(rPartial: Omit<RegistrationData, "insertionSeq">): MatchEvent[] {
    const r: RegistrationData = { ...rPartial, insertionSeq: this.nextInsertionSeq++ };
    insertSorted(this.registrations, r);
    const events: MatchEvent[] = [];
    for (const [surfaceId, top] of this.toplevels.entries()) {
      if (!matches(r, top)) continue;
      const cur = this.assignments.get(surfaceId);
      if (cur === undefined) {
        // Unassigned: claim it.
        this.assignments.set(surfaceId, r.id);
        events.push({ kind: "matched", registrationId: r.id, surfaceId });
        continue;
      }
      // Already assigned. Steal only if r outranks the current owner.
      const curReg = this.registrations.find((x) => x.id === cur);
      if (!curReg) continue;
      if (compareRank(r, curReg) < 0) {
        events.push({ kind: "unmatched", registrationId: cur, surfaceId });
        this.assignments.set(surfaceId, r.id);
        events.push({ kind: "matched", registrationId: r.id, surfaceId });
      }
    }
    return events;
  }

  // Remove a registration. Returns unmatched events for every surface
  // currently assigned to it, then re-evaluates each freed surface
  // against the remaining registrations (so a removed FIRST registration
  // gives a chance to a registered-later one). Each freed surface
  // optionally produces a follow-up matched event for its new winner.
  removeRegistration(registrationId: number): MatchEvent[] {
    const idx = this.registrations.findIndex((r) => r.id === registrationId);
    if (idx < 0) return [];
    const removed = this.registrations[idx];
    if (!removed) return [];
    this.registrations.splice(idx, 1);
    const events: MatchEvent[] = [];
    const freed: number[] = [];
    for (const [surfaceId, regId] of this.assignments.entries()) {
      if (regId === registrationId) {
        events.push({ kind: "unmatched", registrationId, surfaceId });
        freed.push(surfaceId);
      }
    }
    for (const surfaceId of freed) {
      this.assignments.delete(surfaceId);
      // Re-evaluate against the remaining registrations.
      const top = this.toplevels.get(surfaceId);
      if (!top) continue;
      const nextWinner = this.firstMatching(top);
      if (nextWinner !== null) {
        this.assignments.set(surfaceId, nextWinner.id);
        events.push({ kind: "matched", registrationId: nextWinner.id, surfaceId });
      }
    }
    return events;
  }

  // A toplevel about to receive its first sized configure
  // (window.preconfigure). Same shape as onToplevelMapped, but fires
  // BEFORE the first sized configure goes out so the matched plugin's
  // synchronous setInsets lands in time. Tracks the toplevel + assigns
  // to the first matching registration. Idempotent with subsequent
  // onToplevelMapped (which is a no-op for already-tracked surfaces).
  onToplevelPreconfigure(top: ToplevelData): MatchEvent[] {
    return this.trackToplevel(top);
  }

  // A toplevel mapped (window.map). Add it to the tracking set if not
  // already (a preconfigure-time match may have done so) and assign to
  // the first matching registration if not already assigned.
  onToplevelMapped(top: ToplevelData): MatchEvent[] {
    return this.trackToplevel(top);
  }

  // Internal: shared tracking + matching for preconfigure and map.
  // Idempotent on repeated calls.
  private trackToplevel(top: ToplevelData): MatchEvent[] {
    let rec = this.toplevels.get(top.surfaceId);
    if (rec) {
      // Already tracked (preconfigure ran first); refresh appId/title
      // in case the client set them between preconfigure and map. The
      // fullscreen flag only updates when the caller supplied it (the
      // map event doesn't carry window state).
      rec.appId = top.appId;
      rec.title = top.title;
      if (top.fullscreen !== undefined) rec.fullscreen = top.fullscreen;
    } else {
      rec = { ...top };
      this.toplevels.set(top.surfaceId, rec);
    }
    if (this.assignments.has(top.surfaceId)) return [];   // already matched
    // Match against the TRACKED record: it carries state (fullscreen)
    // that this call's argument may not.
    const winner = this.firstMatching(rec);
    if (winner === null) return [];
    this.assignments.set(top.surfaceId, winner.id);
    return [{ kind: "matched", registrationId: winner.id, surfaceId: top.surfaceId }];
  }

  // Toplevel unmapped. Remove + fire unmatched if it was assigned.
  onToplevelUnmapped(surfaceId: number): MatchEvent[] {
    const events: MatchEvent[] = [];
    const regId = this.assignments.get(surfaceId);
    if (regId !== undefined) {
      events.push({ kind: "unmatched", registrationId: regId, surfaceId });
      this.assignments.delete(surfaceId);
    }
    this.toplevels.delete(surfaceId);
    return events;
  }

  // Toplevel appId changed. Re-evaluate the match. May produce an
  // unmatched + (optionally) a matched event if the winner changed,
  // or just an unmatched / matched on its own.
  onToplevelChanged(surfaceId: number, appId: string | null, title: string | null): MatchEvent[] {
    const cur = this.toplevels.get(surfaceId);
    if (!cur) return [];   // not mapped (or not a toplevel we tracked)
    cur.appId = appId;
    cur.title = title;
    return this.reevaluate(surfaceId, cur);
  }

  // Toplevel entered / left fullscreen. Re-evaluates so registrations
  // with excludeFullscreen release the surface on entry and can reclaim
  // it on exit.
  onToplevelFullscreenChanged(surfaceId: number, fullscreen: boolean): MatchEvent[] {
    const cur = this.toplevels.get(surfaceId);
    if (!cur) return [];
    if (cur.fullscreen === fullscreen) return [];
    cur.fullscreen = fullscreen;
    return this.reevaluate(surfaceId, cur);
  }

  // Shared winner re-evaluation after a tracked field changed.
  private reevaluate(surfaceId: number, cur: ToplevelData): MatchEvent[] {
    const events: MatchEvent[] = [];
    const oldRegId = this.assignments.get(surfaceId);
    const winner = this.firstMatching(cur);
    const newRegId = winner?.id ?? null;
    if (oldRegId === newRegId) return events;   // no change
    if (oldRegId !== undefined) {
      events.push({ kind: "unmatched", registrationId: oldRegId, surfaceId });
      this.assignments.delete(surfaceId);
    }
    if (newRegId !== null) {
      this.assignments.set(surfaceId, newRegId);
      events.push({ kind: "matched", registrationId: newRegId, surfaceId });
    }
    return events;
  }

  // Teardown: drop all registrations + toplevels + assignments.
  shutdown(): void {
    this.registrations = [];
    this.toplevels.clear();
    this.assignments.clear();
  }

  // Test / broker introspection.
  registrationFor(surfaceId: number): number | undefined {
    return this.assignments.get(surfaceId);
  }
  toplevelData(surfaceId: number): ToplevelData | undefined {
    return this.toplevels.get(surfaceId);
  }
  // All currently-assigned (surfaceId, registrationId) pairs.
  assignmentList(): Array<{ surfaceId: number; registrationId: number }> {
    return Array.from(this.assignments.entries()).map(
      ([surfaceId, registrationId]) => ({ surfaceId, registrationId }));
  }

  private firstMatching(top: ToplevelData): RegistrationData | null {
    for (const r of this.registrations) {
      if (matches(r, top)) return r;
    }
    return null;
  }
}

// Ascending order: lower priority first; same-priority by insertionSeq.
// Compatible with Array.prototype.sort.
function compareRank(a: RegistrationData, b: RegistrationData): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.insertionSeq - b.insertionSeq;
}

// Insert r into list keeping (priority, insertionSeq) ascending order.
// O(N) but N is small (handful of registrations).
function insertSorted(list: RegistrationData[], r: RegistrationData): void {
  let idx = list.length;
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    if (cur === undefined) continue;   // list is dense; this is unreachable
    if (compareRank(r, cur) < 0) {
      idx = i;
      break;
    }
  }
  list.splice(idx, 0, r);
}

function matches(r: RegistrationData, top: ToplevelData): boolean {
  // In 10a we only support matching toplevels. The 'roles' filter is
  // recorded but the match here is implicitly toplevel-scoped because
  // this engine only sees toplevels.
  if (r.excludeFullscreen && top.fullscreen === true) return false;
  if (r.appIdRegex !== null) {
    if (top.appId === null) return false;       // no app_id yet -> no match
    if (!r.appIdRegex.test(top.appId)) return false;
  }
  // Roles: if filter is present and doesn't include "toplevel", reject.
  // (10a-only: roles other than "toplevel" can never satisfy because
  // popups/subsurfaces aren't tracked.)
  if (r.roles !== null && !r.roles.includes("toplevel")) return false;
  return true;
}

// Compile a serialized regex spec ({source, flags}) into a RegExp. The
// broker uses this at register time so an invalid pattern fails the
// request rather than silently never matching.
export function compileAppIdRegex(spec: InterceptMatch["appId"]): RegExp | null {
  if (!spec) return null;
  return new RegExp(spec.source, spec.flags);
}
