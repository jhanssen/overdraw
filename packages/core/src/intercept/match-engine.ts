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
}

// A mapped toplevel's match-relevant fields. Updated by the broker on
// window.map / window.change / window.unmap.
export interface ToplevelData {
  surfaceId: number;
  appId: string | null;
  title: string | null;
}

// Events the engine emits abstractly. The broker translates to plugin
// callbacks (onSurfaceMatched / onSurfaceUnmatched).
export interface MatchEvent {
  kind: "matched" | "unmatched";
  registrationId: number;
  surfaceId: number;
}

export class MatchEngine {
  // Registrations in insertion order. First-match-wins iterates this
  // list head-to-tail.
  private registrations: RegistrationData[] = [];
  // Mapped toplevels keyed by surfaceId. Updated by the broker.
  private toplevels = new Map<number, ToplevelData>();
  // Current (toplevel surfaceId -> registration id) match assignments.
  // Sparse: only assigned surfaces appear.
  private assignments = new Map<number, number>();

  registerCount(): number { return this.registrations.length; }

  // Add a registration. Returns the synthetic registration id. Re-
  // evaluates every existing toplevel and returns the events caused by
  // the new registration (matched events for any toplevel that newly
  // matches this registration and isn't already assigned to an earlier
  // registration).
  addRegistration(r: RegistrationData): MatchEvent[] {
    this.registrations.push(r);
    const events: MatchEvent[] = [];
    for (const [surfaceId, top] of this.toplevels.entries()) {
      if (this.assignments.has(surfaceId)) continue;  // earlier reg already owns it
      if (matches(r, top)) {
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

  // A toplevel mapped (window.map). Add it to the tracking set and
  // assign to the first matching registration, if any.
  onToplevelMapped(top: ToplevelData): MatchEvent[] {
    this.toplevels.set(top.surfaceId, { ...top });
    const winner = this.firstMatching(top);
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

function matches(r: RegistrationData, top: ToplevelData): boolean {
  // In 10a we only support matching toplevels. The 'roles' filter is
  // recorded but the match here is implicitly toplevel-scoped because
  // this engine only sees toplevels.
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
