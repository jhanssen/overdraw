// Pure workspace state machine. No SDK refs, no async, no side effects in
// the running sense -- all I/O is described as a typed SideEffect array the
// caller (the plugin wrapper) translates into SDK calls.
//
// Two ids per workspace:
//   WorkspaceHandle  -- stable identity. Monotonic; never reused. Stored in
//                       the window state bag and event payloads. Survives
//                       destruction of other workspaces.
//   WorkspaceIndex   -- 1-based position in the per-output workspace list.
//                       Dense; shifts on destroy. User/CLI/hotkey-facing.
//
// Invariants enforced by every state transition:
//   - At least one workspace per output that has ever been touched.
//   - Each output has exactly one shown workspace.
//   - A surfaceId belongs to at most one workspace at a time.
//   - nextHandle is monotonic.

import type {
  WorkspaceHandle, WorkspaceIndex, WorkspaceSnapshot,
} from "@overdraw/workspace-types";

// Re-exported so the plugin wrapper does not have to import from both
// packages.
export type { WorkspaceHandle, WorkspaceIndex, WorkspaceSnapshot };

export const OUTPUT_DEFAULT = 0;

export interface WorkspaceRecord {
  handle: WorkspaceHandle;
  // The workspace's *current* live output. Derived from preferredOutputs +
  // the live output set whenever outputs change; the field is the cached
  // result so map lookups (positionsByOutput, shownByOutput) stay O(1).
  outputId: number;
  name?: string;
  // Durable, prioritized list of output identifiers this workspace prefers
  // to live on. Most-preferred first. NEVER shrinks: a workspace remembers
  // every output it has ever lived on. Identifiers are stable across
  // unplug/replug -- a returning monitor with a matching identifier
  // reclaims its workspaces. Three mutations are allowed:
  //   1. Config seed at create time (workspace.create({preferredOutputs}));
  //   2. Append at lowest priority when a workspace is forced onto an
  //      output not already in its list (an evacuation fallback);
  //   3. Promote: an explicit move to output X raises X above the
  //      previously-current entry.
  preferredOutputs: string[];
  // Ordered surface ids belonging to this workspace, master-front (index 0
  // is the layout's master, the tail is the bottom of the stack). This list
  // IS the per-workspace draw order: setOutputStack pushes it verbatim, the
  // layout-driver consumes it (master-stack uses index 0 as the master), the
  // hit-tester walks it front-to-back. Reorder ops (promote/swap-next/
  // swap-prev) mutate it.
  members: number[];
  // Attention flag. Set by setUrgent(), cleared automatically when the
  // workspace becomes the shown one on its output. Surfaces via
  // snapshotOf(). External consumers (status bars, the ext-workspace-v1
  // protocol) read it via 'workspace.urgency-changed' bus events.
  urgent: boolean;
}

export interface WorkspaceState {
  byHandle: Map<WorkspaceHandle, WorkspaceRecord>;
  positionsByOutput: Map<number, WorkspaceHandle[]>;
  shownByOutput: Map<number, WorkspaceHandle>;
  // Reverse index: which workspace a surfaceId belongs to. A surface absent
  // from this map is unowned (not yet seen by applyMap, or has been
  // unmapped).
  surfaceToHandle: Map<number, WorkspaceHandle>;
  nextHandle: number;
  // Per-output focus memory keyed by durable output identifier (the same
  // string used in preferredOutputs). Updated on every show() so the
  // workspace last active on output X is restored when X reappears after a
  // hotplug. Survives evacuations: if output X disappears, the entry stays;
  // when X returns and recomputeOutputs reclaims workspaces onto X, the
  // remembered workspace becomes shown there again. See multi-output-design
  // §10 "Active workspace memory".
  lastActiveByOutputName: Map<string, WorkspaceHandle>;
}

// Discriminated union of side effects the registry produces. The wrapper
// translates each into an SDK call.
export type SideEffect =
  | { kind: "setOutputStack"; outputId: number; ids: number[] }
  | { kind: "setStateBag"; surfaceId: number; handle: WorkspaceHandle }
  | { kind: "deleteStateBag"; surfaceId: number }
  | { kind: "requestFocusDecision"; reason: "workspace-changed" }
  | { kind: "emit"; name: string; payload: Record<string, unknown> };

export interface RenumberChange {
  handle: WorkspaceHandle;
  oldIndex: WorkspaceIndex;
  newIndex: WorkspaceIndex;
}

// Helper: cast a plain number to a branded id at the boundary. Branded types
// are nominal in TS but erased at runtime; the casts are inert at JS runtime.
function asHandle(n: number): WorkspaceHandle { return n as WorkspaceHandle; }
function asIndex(n: number): WorkspaceIndex { return n as WorkspaceIndex; }

// Build a snapshot from a record + its current position.
export function snapshotOf(state: WorkspaceState,
                           handle: WorkspaceHandle): WorkspaceSnapshot {
  const rec = state.byHandle.get(handle);
  if (!rec) {
    throw new Error(`snapshotOf: unknown workspace handle ${handle}`);
  }
  const positions = state.positionsByOutput.get(rec.outputId) ?? [];
  const idx0 = positions.indexOf(handle);
  if (idx0 === -1) {
    throw new Error(`snapshotOf: handle ${handle} not in output ${rec.outputId}`);
  }
  return {
    handle,
    index: asIndex(idx0 + 1),
    ...(rec.name !== undefined ? { name: rec.name } : {}),
    outputId: rec.outputId,
    members: [...rec.members],
    urgent: rec.urgent,
  };
}

// All snapshots for an output, sorted by index. Empty array if the output
// has no workspaces yet.
export function snapshotsForOutput(state: WorkspaceState,
                                   outputId: number): WorkspaceSnapshot[] {
  const positions = state.positionsByOutput.get(outputId) ?? [];
  return positions.map((h) => snapshotOf(state, h));
}

// Resolve a 1-based index to its handle on outputId. Null if out of range.
export function findHandle(state: WorkspaceState,
                           index: WorkspaceIndex,
                           outputId: number): WorkspaceHandle | null {
  const positions = state.positionsByOutput.get(outputId) ?? [];
  const i = (index as number) - 1;
  if (i < 0 || i >= positions.length) return null;
  return positions[i];
}

// Reverse: resolve a handle to its 1-based index on outputId. Null if the
// handle is not on that output (or doesn't exist).
export function findIndex(state: WorkspaceState,
                          handle: WorkspaceHandle,
                          outputId: number): WorkspaceIndex | null {
  const positions = state.positionsByOutput.get(outputId) ?? [];
  const i = positions.indexOf(handle);
  if (i === -1) return null;
  return asIndex(i + 1);
}

// Find a workspace by its display name on outputId. Names are not
// required to be unique (the API doesn't enforce uniqueness; two
// workspaces may share a name); the first match in position order
// wins. Returns null if no workspace on outputId carries `name`.
export function findIndexByName(state: WorkspaceState,
                                name: string,
                                outputId: number): WorkspaceIndex | null {
  const positions = state.positionsByOutput.get(outputId) ?? [];
  for (let i = 0; i < positions.length; i++) {
    const rec = state.byHandle.get(positions[i]);
    if (rec?.name === name) return asIndex(i + 1);
  }
  return null;
}

// Build the back-to-front surfaceId list for the currently-shown workspace
// on outputId. Empty if the output has no workspaces (transient).
// Exported so the plugin's transition path can capture the FROM stack
// before mutating state to compute the TO stack.
export function stackFor(state: WorkspaceState, outputId: number): number[] {
  const shown = state.shownByOutput.get(outputId);
  if (shown === undefined) return [];
  const rec = state.byHandle.get(shown);
  if (!rec) return [];
  return [...rec.members];
}

// Construct the initial state: one workspace (handle=1) on OUTPUT_DEFAULT,
// shown there. Its preferredOutputs is seeded with the boot output's name
// (passed in by the caller). No additional members. Returns the state + the
// workspace.created side effect for the initial workspace -- the caller
// emits it on the bus so subscribers see the boot-time workspace.
export function init(
  bootOutputName: string,
): { state: WorkspaceState; sideEffects: SideEffect[] } {
  const state: WorkspaceState = {
    byHandle: new Map(),
    positionsByOutput: new Map(),
    shownByOutput: new Map(),
    surfaceToHandle: new Map(),
    nextHandle: 1,
    lastActiveByOutputName: new Map(),
  };
  const ensured = ensureOutput(state, OUTPUT_DEFAULT, bootOutputName);
  // Seed lastActive for the boot output so a hotplug-on-boot path that
  // never observed a show() before the first remove still has a focus
  // anchor when the output returns.
  const shown = ensured.state.shownByOutput.get(OUTPUT_DEFAULT);
  if (shown !== undefined && bootOutputName !== "") {
    ensured.state.lastActiveByOutputName.set(bootOutputName, shown);
  }
  return ensured;
}

// Internal: guarantee outputId has at least one workspace, creating one if
// needed. Returns the (possibly mutated) state + any sideEffects emitted
// (only 'workspace.created' on first creation). `seedName` is the durable
// output identifier seeded into the new workspace's preferredOutputs list;
// callers should pass the live output's name so the workspace remembers its
// boot home.
export function ensureOutput(state: WorkspaceState, outputId: number, seedName: string,
                      ): { state: WorkspaceState; sideEffects: SideEffect[] } {
  if ((state.positionsByOutput.get(outputId) ?? []).length > 0) {
    return { state, sideEffects: [] };
  }
  const handle = asHandle(state.nextHandle);
  const rec: WorkspaceRecord = {
    handle, outputId, members: [], urgent: false,
    // Empty seedName leaves preferredOutputs empty (no durable identity);
    // the registry's resolver returns null in that case and the next
    // recomputeOutputs / config-seeded create populates it. Matches the
    // destroy()-replacement-workspace path.
    preferredOutputs: seedName !== "" ? [seedName] : [],
  };
  state.byHandle.set(handle, rec);
  state.positionsByOutput.set(outputId, [handle]);
  state.shownByOutput.set(outputId, handle);
  state.nextHandle += 1;
  // Two events: workspace.created announces the workspace; workspace.shown
  // announces it is the (newly-and-only-possible) shown workspace on its
  // output. Subscribers tracking shown state (status bars, the
  // ext-workspace-v1 protocol layer) need the shown emit even for the very
  // first workspace on an output -- recomputeOutputs's per-output diff only
  // emits .shown on a TRANSITION, and a brand-new output has no prior
  // shown to transition from.
  const sideEffects: SideEffect[] = [
    {
      kind: "emit", name: "workspace.created",
      payload: { handle, index: 1, outputId },
    },
    {
      kind: "emit", name: "workspace.shown",
      payload: { handle, index: 1, outputId },
    },
  ];
  return { state, sideEffects };
}

// Resolve a workspace's current live output: the highest-ranked entry in its
// preferredOutputs that maps to a connected output, by name. Returns null
// when nothing in the list resolves (the caller falls back to the virtual
// fallback output). Used by the output-add/remove recompute the plugin runs
// on bus events.
export function currentLiveOutput(
  rec: WorkspaceRecord,
  liveOutputs: ReadonlyMap<number, string>,  // outputId -> name
): number | null {
  // Build a reverse lookup once. Small N (live outputs); cheap.
  const byName = new Map<string, number>();
  for (const [id, name] of liveOutputs) byName.set(name, id);
  for (const name of rec.preferredOutputs) {
    const id = byName.get(name);
    if (id !== undefined) return id;
  }
  return null;
}

// Mutation 2: append an output identifier at LOWEST priority (workspace was
// forced here as a fallback). Idempotent: a name already in the list is not
// re-appended. Returns true if the list changed.
export function appendPreferredOutput(
  state: WorkspaceState, handle: WorkspaceHandle, name: string,
): boolean {
  const rec = state.byHandle.get(handle);
  if (!rec) return false;
  if (rec.preferredOutputs.includes(name)) return false;
  rec.preferredOutputs.push(name);
  return true;
}

// Mutation 3: promote an output identifier to just above the workspace's
// current entry (raises it on explicit move). Idempotent: if the name is
// already at or above the head, no change. Returns true if the list changed.
export function promotePreferredOutput(
  state: WorkspaceState, handle: WorkspaceHandle, name: string,
): boolean {
  const rec = state.byHandle.get(handle);
  if (!rec) return false;
  const idx = rec.preferredOutputs.indexOf(name);
  if (idx === 0) return false;       // already most-preferred
  if (idx === -1) {
    rec.preferredOutputs.unshift(name);
    return true;
  }
  rec.preferredOutputs.splice(idx, 1);
  rec.preferredOutputs.unshift(name);
  return true;
}

// Create a new workspace, appended at the end of the position list for
// outputId. Does NOT auto-show. Returns the snapshot of the new workspace.
//
// `outputName` is the durable identifier of the live output the workspace
// will be created on -- seeds the workspace's preferredOutputs list so a
// future hotplug can restore the workspace to its boot home. `spec.preferredOutputs`
// is an optional CONFIG-supplied list; when present it is used verbatim (with
// `outputName` appended at the end if not already in it so the list always
// covers the live boot output).
export function create(state: WorkspaceState,
                       spec: { name?: string; outputId?: number;
                               preferredOutputs?: ReadonlyArray<string>;
                             } = {},
                       outputName: string,
                       ): { state: WorkspaceState; snapshot: WorkspaceSnapshot;
                            sideEffects: SideEffect[] } {
  const outputId = spec.outputId ?? OUTPUT_DEFAULT;
  // ensureOutput first so the very-first workspace on a brand-new output is
  // still appended at the end (it'll just be the only one).
  const e = ensureOutput(state, outputId, outputName);
  state = e.state;
  const sideEffects = [...e.sideEffects];

  const handle = asHandle(state.nextHandle);
  state.nextHandle += 1;
  // Seed preferredOutputs from the config spec when present; otherwise the
  // live output's name is the sole entry. Either way, ensure `outputName` is
  // in the list so the workspace remembers its boot home.
  const preferred: string[] = spec.preferredOutputs
    ? [...spec.preferredOutputs]
    : [outputName];
  if (!preferred.includes(outputName)) preferred.push(outputName);

  const rec: WorkspaceRecord = {
    handle, outputId, members: [], urgent: false,
    preferredOutputs: preferred,
    ...(spec.name !== undefined ? { name: spec.name } : {}),
  };
  state.byHandle.set(handle, rec);
  const positions = state.positionsByOutput.get(outputId);
  if (!positions) throw new Error("internal: positions missing post-ensureOutput");
  positions.push(handle);
  const index = positions.length;

  sideEffects.push({
    kind: "emit", name: "workspace.created",
    payload: {
      handle, index, outputId,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
    },
  });
  return { state, snapshot: snapshotOf(state, handle), sideEffects };
}

// Destroy the workspace at `index` on outputId. Relocates members; renumbers
// the rest; re-creates if destroying the last workspace; updates the shown
// workspace if it was the destroyed one. `outputName` seeds the replacement
// workspace's preferredOutputs if a fresh one is created for the last slot;
// callers without name context can pass an empty string (the fresh workspace
// then gets a preferredOutputs covering only the live outputId, no durable
// identity -- the next config-seeded create supplies one).
export function destroy(state: WorkspaceState,
                        index: WorkspaceIndex,
                        outputId: number = OUTPUT_DEFAULT,
                        outputName: string = "",
                        ): { state: WorkspaceState; sideEffects: SideEffect[];
                             renumbered: RenumberChange[] } {
  const handle = findHandle(state, index, outputId);
  if (handle === null) {
    throw new Error(
      `destroy: no workspace at index ${index as number} on output ${outputId}`);
  }
  const rec = state.byHandle.get(handle);
  if (!rec) throw new Error("internal: handle in positions but not in byHandle");

  const positions = state.positionsByOutput.get(outputId);
  if (!positions) throw new Error("internal: positions missing");
  const pos0 = positions.indexOf(handle);
  if (pos0 === -1) throw new Error("internal: handle not in positions");

  const formerIndex = asIndex(pos0 + 1);
  const sideEffects: SideEffect[] = [];

  // Remove the position. After removal, positions[pos0] is what USED TO BE
  // at index pos0+1 (one further to the right).
  positions.splice(pos0, 1);

  // Pick relocation target. Prefer the workspace that took this position;
  // if we destroyed the last one, fall back to the new last (one to the
  // left). If positions is now empty, create a fresh workspace for index 1
  // (handle is new, NOT the destroyed one).
  const wasShown = state.shownByOutput.get(outputId) === handle;

  // Drop the destroyed record up front so any subsequent lookups don't see
  // it. Members are remembered in `rec.members` (closure-captured) until
  // they're transferred to the target.
  state.byHandle.delete(handle);

  let target: WorkspaceHandle | null = null;
  let createdFresh = false;
  if (positions.length === 0) {
    // Always-at-least-one invariant: create a fresh workspace for this
    // output. New handle, no name. preferredOutputs is seeded with the live
    // output's name when known (mutation rule 2 -- forced placement), else
    // left empty for the next config-seeded create to populate.
    const fresh = asHandle(state.nextHandle);
    state.nextHandle += 1;
    state.byHandle.set(fresh, {
      handle: fresh, outputId, members: [], urgent: false,
      preferredOutputs: outputName !== "" ? [outputName] : [],
    });
    positions.push(fresh);
    sideEffects.push({
      kind: "emit", name: "workspace.created",
      payload: { handle: fresh, index: 1, outputId },
    });
    target = fresh;
    createdFresh = true;
  } else if (pos0 < positions.length) {
    // The workspace that USED TO BE at pos0+1+1 is now at pos0+1.
    target = positions[pos0];
  } else {
    // Destroyed the last; relocate to the new-last (one to the left).
    target = positions[positions.length - 1];
  }

  // Relocate members. Update both record + reverse index + state-bag.
  // Preserves the destroyed workspace's order at the tail of the target's
  // member list (the target's existing members stay master-front; relocated
  // ones land below).
  if (rec.members.length > 0 && target !== null) {
    const targetRec = state.byHandle.get(target);
    if (!targetRec) throw new Error("internal: relocation target missing");
    for (const sid of rec.members) {
      if (!targetRec.members.includes(sid)) targetRec.members.push(sid);
      state.surfaceToHandle.set(sid, target);
      sideEffects.push({ kind: "setStateBag", surfaceId: sid, handle: target });
    }
  }

  // Reassign shownByOutput if needed.
  if (wasShown && target !== null) {
    state.shownByOutput.set(outputId, target);
  }

  // workspace.destroyed event.
  sideEffects.push({
    kind: "emit", name: "workspace.destroyed",
    payload: { handle, formerIndex: formerIndex as number, outputId },
  });

  // Compute renumber events. Every workspace at position >= pos0 in the
  // NEW positions list shifted down by one in index: its new index is i+1,
  // its old index was i+2. The freshly-created replacement workspace (when
  // positions emptied) is a NEW workspace with no oldIndex -- skip it.
  const renumbered: RenumberChange[] = [];
  if (!createdFresh) {
    for (let i = pos0; i < positions.length; i++) {
      const h = positions[i];
      renumbered.push({
        handle: h, oldIndex: asIndex(i + 2), newIndex: asIndex(i + 1),
      });
    }
  }
  if (renumbered.length > 0) {
    sideEffects.push({
      kind: "emit", name: "workspace.renumbered",
      payload: {
        outputId,
        changes: renumbered.map((c) => ({
          handle: c.handle,
          oldIndex: c.oldIndex as number,
          newIndex: c.newIndex as number,
        })),
      },
    });
  }

  // If the shown workspace changed, push its stack and request a focus
  // re-decide.
  if (wasShown) {
    sideEffects.push({
      kind: "setOutputStack", outputId, ids: stackFor(state, outputId),
    });
    sideEffects.push({ kind: "requestFocusDecision", reason: "workspace-changed" });
  } else if (rec.members.length > 0) {
    // Not shown ourselves, but our members moved to the target; if the
    // target IS shown, its stack just grew.
    if (target !== null && state.shownByOutput.get(outputId) === target) {
      sideEffects.push({
        kind: "setOutputStack", outputId, ids: stackFor(state, outputId),
      });
    }
  }

  return { state, sideEffects, renumbered };
}

// Make the workspace at `index` the shown one on outputId. Pushes the new
// stack and triggers a focus re-decide. No-op if already shown.
//
// Auto-clears urgent on the workspace that becomes shown: if `rec.urgent`
// was true, it is cleared and a `workspace.urgency-changed` emit is
// prepended to the side-effect list (before workspace.hidden / .shown) so
// subscribers observe urgency falling before the activation event.
//
// `outputName` is the durable identifier of `outputId`; when non-empty it
// updates lastActiveByOutputName so a future hotplug restoration knows
// which workspace to re-show on this output. Passing an empty string
// suppresses the update (used by tests that don't model output names).
export function show(state: WorkspaceState,
                     index: WorkspaceIndex,
                     outputId: number = OUTPUT_DEFAULT,
                     outputName: string = "",
                     ): { state: WorkspaceState; sideEffects: SideEffect[] } {
  const handle = findHandle(state, index, outputId);
  if (handle === null) {
    throw new Error(
      `show: no workspace at index ${index as number} on output ${outputId}`);
  }
  const prev = state.shownByOutput.get(outputId);
  if (prev === handle) {
    // Even if already shown, refresh the focus-memory entry: a re-show
    // (e.g. after a focus action) re-anchors the output's last active.
    if (outputName !== "") state.lastActiveByOutputName.set(outputName, handle);
    return { state, sideEffects: [] };
  }

  state.shownByOutput.set(outputId, handle);
  if (outputName !== "") state.lastActiveByOutputName.set(outputName, handle);

  const sideEffects: SideEffect[] = [];
  // Auto-clear urgency on the newly-shown workspace. Emitted first so a
  // protocol subscriber translating both into one wire state event sees
  // the cleared urgent bit and the new active bit together.
  const rec = state.byHandle.get(handle);
  if (rec && rec.urgent) {
    rec.urgent = false;
    sideEffects.push({
      kind: "emit", name: "workspace.urgency-changed",
      payload: { workspaceId: handle, urgent: false, outputId },
    });
  }
  if (prev !== undefined) {
    const prevIdx = findIndex(state, prev, outputId);
    if (prevIdx !== null) {
      sideEffects.push({
        kind: "emit", name: "workspace.hidden",
        payload: { handle: prev, index: prevIdx as number, outputId },
      });
    }
  }
  sideEffects.push({
    kind: "emit", name: "workspace.shown",
    payload: { handle, index: index as number, outputId },
  });
  sideEffects.push({
    kind: "setOutputStack", outputId, ids: stackFor(state, outputId),
  });
  sideEffects.push({ kind: "requestFocusDecision", reason: "workspace-changed" });
  return { state, sideEffects };
}

// Set or clear the urgent flag on the workspace at `index` on outputId.
// Idempotent: when the flag already matches the request, returns no side
// effects (no event emitted). When the flag flips, emits
// 'workspace.urgency-changed'. Throws if `index` is out of range, matching
// the behavior of show/destroy/setName.
export function setUrgent(state: WorkspaceState,
                          index: WorkspaceIndex,
                          urgent: boolean,
                          outputId: number = OUTPUT_DEFAULT,
                          ): { state: WorkspaceState; sideEffects: SideEffect[] } {
  const handle = findHandle(state, index, outputId);
  if (handle === null) {
    throw new Error(
      `setUrgent: no workspace at index ${index as number} on output ${outputId}`);
  }
  const rec = state.byHandle.get(handle);
  if (!rec) throw new Error("internal: handle without record");
  if (rec.urgent === urgent) return { state, sideEffects: [] };
  rec.urgent = urgent;
  return {
    state,
    sideEffects: [{
      kind: "emit", name: "workspace.urgency-changed",
      payload: { workspaceId: handle, urgent, outputId },
    }],
  };
}

// Move a surfaceId to the workspace at `index` on outputId. If the surface
// is unknown (never seen by applyMap), throws. If the target is already its
// owner, no-op. When the move crosses outputs, the target workspace's
// preferredOutputs is promoted: the target output's name is raised to the
// front of the list (mutation rule 3). `outputName` is the durable identifier
// of `outputId`; passing the empty string suppresses the promotion (used by
// tests that don't model output names).
export function moveWindow(state: WorkspaceState,
                           surfaceId: number,
                           targetIndex: WorkspaceIndex,
                           outputId: number = OUTPUT_DEFAULT,
                           outputName: string = "",
                           ): { state: WorkspaceState; sideEffects: SideEffect[] } {
  const targetHandle = findHandle(state, targetIndex, outputId);
  if (targetHandle === null) {
    throw new Error(
      `moveWindow: no workspace at index ${targetIndex as number} on output ${outputId}`);
  }
  const fromHandle = state.surfaceToHandle.get(surfaceId);
  if (fromHandle === undefined) {
    throw new Error(`moveWindow: surface ${surfaceId} is not tracked by any workspace`);
  }
  if (fromHandle === targetHandle) {
    return { state, sideEffects: [] };
  }
  const fromRec = state.byHandle.get(fromHandle);
  const targetRec = state.byHandle.get(targetHandle);
  if (!fromRec || !targetRec) throw new Error("internal: handle without record");

  const fromOutputId = fromRec.outputId;
  const fromIdx = findIndex(state, fromHandle, fromOutputId);
  if (fromIdx === null) throw new Error("internal: from handle has no index");

  const fromIdxInMembers = fromRec.members.indexOf(surfaceId);
  if (fromIdxInMembers >= 0) fromRec.members.splice(fromIdxInMembers, 1);
  // New windows on the target land at the tail (matches applyMap's append).
  if (!targetRec.members.includes(surfaceId)) targetRec.members.push(surfaceId);
  state.surfaceToHandle.set(surfaceId, targetHandle);

  // Cross-output move: explicit user action; promote the destination on the
  // target workspace's preferred list so a future replug of that output
  // reclaims the workspace.
  if (outputId !== fromOutputId && outputName !== "") {
    promotePreferredOutput(state, targetHandle, outputName);
  }

  const sideEffects: SideEffect[] = [
    { kind: "setStateBag", surfaceId, handle: targetHandle },
    {
      kind: "emit", name: "workspace.window-moved",
      payload: {
        surfaceId,
        fromHandle, toHandle: targetHandle,
        fromIndex: fromIdx as number, toIndex: targetIndex as number,
        fromOutputId, toOutputId: outputId,
      },
    },
  ];

  // Push setOutputStack for any output whose shown workspace's membership
  // changed.
  const shownOnFrom = state.shownByOutput.get(fromOutputId);
  if (shownOnFrom === fromHandle) {
    sideEffects.push({
      kind: "setOutputStack", outputId: fromOutputId,
      ids: stackFor(state, fromOutputId),
    });
  }
  if (outputId !== fromOutputId || shownOnFrom !== fromHandle) {
    const shownOnTo = state.shownByOutput.get(outputId);
    if (shownOnTo === targetHandle) {
      sideEffects.push({
        kind: "setOutputStack", outputId, ids: stackFor(state, outputId),
      });
    }
  }

  return { state, sideEffects };
}

// Reorder a surfaceId within its workspace's member list. Operates in three
// modes that mirror the WM's previous wm.reorder API:
//   "promote"   move the surface to the master slot (index 0).
//   "swap-next" swap with the surface immediately AFTER it (tail-ward).
//   "swap-prev" swap with the surface immediately BEFORE it (master-ward).
// swap-next/swap-prev do NOT wrap. Returns true and emits a setOutputStack
// side effect when the order changed; false (no-op) otherwise. Throws if
// the surface is unknown.
export function reorder(state: WorkspaceState,
                        surfaceId: number,
                        op: "promote" | "swap-next" | "swap-prev",
                        ): { state: WorkspaceState; changed: boolean;
                             sideEffects: SideEffect[] } {
  const handle = state.surfaceToHandle.get(surfaceId);
  if (handle === undefined) {
    throw new Error(`reorder: surface ${surfaceId} is not tracked by any workspace`);
  }
  const rec = state.byHandle.get(handle);
  if (!rec) throw new Error("internal: handle without record");

  const i = rec.members.indexOf(surfaceId);
  if (i < 0) return { state, changed: false, sideEffects: [] };

  let mutated = false;
  if (op === "promote") {
    if (i === 0) return { state, changed: false, sideEffects: [] };
    rec.members.splice(i, 1);
    rec.members.unshift(surfaceId);
    mutated = true;
  } else if (op === "swap-next") {
    if (i >= rec.members.length - 1) return { state, changed: false, sideEffects: [] };
    [rec.members[i], rec.members[i + 1]] = [rec.members[i + 1], rec.members[i]];
    mutated = true;
  } else {
    if (i <= 0) return { state, changed: false, sideEffects: [] };
    [rec.members[i], rec.members[i - 1]] = [rec.members[i - 1], rec.members[i]];
    mutated = true;
  }

  const sideEffects: SideEffect[] = [];
  if (mutated && state.shownByOutput.get(rec.outputId) === handle) {
    sideEffects.push({
      kind: "setOutputStack", outputId: rec.outputId,
      ids: stackFor(state, rec.outputId),
    });
  }
  return { state, changed: mutated, sideEffects };
}

// Set or clear a workspace's name. Idempotent if the value already matches.
export function setName(state: WorkspaceState,
                        index: WorkspaceIndex,
                        name: string | undefined,
                        outputId: number = OUTPUT_DEFAULT,
                        ): { state: WorkspaceState; sideEffects: SideEffect[] } {
  const handle = findHandle(state, index, outputId);
  if (handle === null) {
    throw new Error(
      `setName: no workspace at index ${index as number} on output ${outputId}`);
  }
  const rec = state.byHandle.get(handle);
  if (!rec) throw new Error("internal: handle without record");
  if (rec.name === name) return { state, sideEffects: [] };

  if (name === undefined) delete rec.name;
  else rec.name = name;

  return {
    state,
    sideEffects: [{
      kind: "emit", name: "workspace.renamed",
      payload: {
        handle, index: index as number, outputId,
        ...(name !== undefined ? { name } : {}),
      },
    }],
  };
}

// A new window mapped on `outputId`. Assigns to that output's currently-
// shown workspace. Idempotent: if the surface is already tracked, no-op.
// `outputName` is the durable identifier of the output -- used to seed
// preferredOutputs if this is the first workspace on `outputId`.
export function applyMap(state: WorkspaceState,
                         surfaceId: number,
                         outputId: number,
                         outputName: string,
                         ): { state: WorkspaceState; sideEffects: SideEffect[] } {
  if (state.surfaceToHandle.has(surfaceId)) {
    return { state, sideEffects: [] };
  }
  const e = ensureOutput(state, outputId, outputName);
  state = e.state;
  const sideEffects = [...e.sideEffects];

  const shown = state.shownByOutput.get(outputId);
  if (shown === undefined) {
    throw new Error("internal: shownByOutput missing post-ensureOutput");
  }
  const rec = state.byHandle.get(shown);
  if (!rec) throw new Error("internal: shown handle has no record");
  // New windows take the master slot (index 0); the previous master shifts
  // down one. Matches dwm semantics + the WM's previous addWindow(unshift)
  // behavior. The `promote` action lets the user rearrange explicitly.
  if (!rec.members.includes(surfaceId)) rec.members.unshift(surfaceId);
  state.surfaceToHandle.set(surfaceId, shown);

  sideEffects.push({ kind: "setStateBag", surfaceId, handle: shown });
  sideEffects.push({
    kind: "setOutputStack", outputId,
    ids: stackFor(state, outputId),
  });
  return { state, sideEffects };
}

// A tracked window unmapped. Remove from membership + reverse index. The
// state-bag entry is dropped (the surface is gone). If the unmapped window
// was on the shown workspace, push setOutputStack.
export function applyUnmap(state: WorkspaceState,
                           surfaceId: number,
                           ): { state: WorkspaceState; sideEffects: SideEffect[] } {
  const handle = state.surfaceToHandle.get(surfaceId);
  if (handle === undefined) return { state, sideEffects: [] };

  const rec = state.byHandle.get(handle);
  if (!rec) {
    // Stale reverse-index entry; clean it up.
    state.surfaceToHandle.delete(surfaceId);
    return { state, sideEffects: [] };
  }

  const idxInMembers = rec.members.indexOf(surfaceId);
  if (idxInMembers >= 0) rec.members.splice(idxInMembers, 1);
  state.surfaceToHandle.delete(surfaceId);

  const sideEffects: SideEffect[] = [
    { kind: "deleteStateBag", surfaceId },
  ];
  if (state.shownByOutput.get(rec.outputId) === handle) {
    sideEffects.push({
      kind: "setOutputStack", outputId: rec.outputId,
      ids: stackFor(state, rec.outputId),
    });
  }
  return { state, sideEffects };
}

// The currently-shown workspace on outputId, as a snapshot. Null only in
// transient states (no workspaces on this output yet); after init() with
// OUTPUT_DEFAULT, OUTPUT_DEFAULT always has one.
export function current(state: WorkspaceState,
                        outputId: number = OUTPUT_DEFAULT,
                        ): WorkspaceSnapshot | null {
  const handle = state.shownByOutput.get(outputId);
  if (handle === undefined) return null;
  return snapshotOf(state, handle);
}

// Migration record returned by recomputeOutputs (one per workspace whose
// outputId changed). Diagnostics + drives the `workspace.migrated` bus
// event; callers shouldn't need to consume it for state-mutating logic
// (the state has already been updated in place).
export interface MigrationChange {
  handle: WorkspaceHandle;
  fromOutputId: number;
  toOutputId: number;
}

// Recompute every workspace's derived live output against the current set
// of live outputs (real connectors only -- the fallback is passed
// separately). Implements the full multi-output-design §10 migration policy:
//
//   1. Each workspace's new home is the highest-ranked entry in its
//      preferredOutputs that resolves to a live output (currentLiveOutput).
//   2. A workspace whose preferred list has no live match falls onto the
//      lowest-id remaining live output AND has that output's durable name
//      appended at lowest priority (mutation rule 2: remembered as a
//      fallback). When no live outputs exist, the workspace parks on
//      fallbackOutputId and gets fallbackOutputName appended (so a future
//      recompute that reincludes the fallback in liveOutputs resolves it).
//   3. ≥1-workspace-per-touched-output invariant: any live output that
//      ends with zero workspaces after the migration (a donor drained by
//      reclaim) gets a fresh empty workspace created on it. The fallback
//      output is exempt from this invariant -- a non-empty fallback exists
//      only when something parked there; an empty one stays empty.
//   4. Per-output focus restore: for any output whose `shownByOutput` was
//      cleared (its shown workspace migrated away) OR whose `shownByOutput`
//      is unset because the output just gained its first workspaces (a
//      returning monitor reclaiming workspaces), set `shownByOutput` to:
//        a) lastActiveByOutputName[durableName] if it resolves to a
//           workspace currently on this output (the design's "Active
//           workspace memory" rule), else
//        b) the lowest-position workspace on this output.
//   5. Side effects:
//      - workspace.migrated emit per changed workspace.
//      - workspace.hidden + workspace.shown emits where shown changed.
//      - workspace.created emit for each donor-replenishment workspace.
//      - setOutputStack push for each output whose visible stack changed
//        (shown changed, or its only workspace moved away and was
//        replaced by a fresh one).
//      - requestFocusDecision once if any shown changed.
//
// `liveOutputs` MUST NOT include the fallback (the caller filters real
// outputs only). `fallbackOutputId` is the sentinel id used for parked
// workspaces; `fallbackOutputName` is its durable identifier (matches
// state.fallbackOutput.name on the core side). When the workspace plugin
// runs in a non-core harness without a fallback, pass an empty string
// for `fallbackOutputName` -- workspaces with no live home then have no
// place to park and throw.
export function recomputeOutputs(
  state: WorkspaceState,
  liveOutputs: ReadonlyMap<number, string>,
  fallbackOutputId: number,
  fallbackOutputName: string,
): {
  state: WorkspaceState;
  sideEffects: SideEffect[];
  migrations: MigrationChange[];
} {
  const sideEffects: SideEffect[] = [];
  const migrations: MigrationChange[] = [];

  // Snapshot the per-output "shown" workspace BEFORE we mutate anything --
  // the per-output diff at the end of this function consults it to decide
  // which outputs need a setOutputStack push.
  const shownBefore = new Map<number, WorkspaceHandle | undefined>();
  // Every output that currently has workspaces, plus every live output
  // (so a returning monitor with no workspaces yet still gets diffed).
  const allOutputsToCheck = new Set<number>();
  for (const id of state.positionsByOutput.keys()) allOutputsToCheck.add(id);
  for (const id of liveOutputs.keys()) allOutputsToCheck.add(id);
  allOutputsToCheck.add(fallbackOutputId);
  for (const id of allOutputsToCheck) {
    shownBefore.set(id, state.shownByOutput.get(id));
  }

  // Determine the lowest-id real output (used as the no-preference fallback
  // when a workspace's preferred list has no live match but live outputs
  // exist). Sorting by outputId keeps this deterministic across runs.
  const liveOutputIds = [...liveOutputs.keys()].sort((a, b) => a - b);

  // Step 1+2: derive each workspace's new home.
  for (const [handle, rec] of state.byHandle) {
    const oldOutputId = rec.outputId;
    let newOutputId: number;

    const resolved = currentLiveOutput(rec, liveOutputs);
    if (resolved !== null) {
      newOutputId = resolved;
    } else if (liveOutputIds.length > 0) {
      // No remembered output is live; fall onto the lowest-id remaining
      // real output and remember it at lowest priority (mutation rule 2).
      newOutputId = liveOutputIds[0];
      const name = liveOutputs.get(newOutputId);
      if (name !== undefined) appendPreferredOutput(state, handle, name);
    } else {
      // No real outputs at all -- park on the fallback. Append the
      // fallback's durable name at lowest priority so a future recompute
      // that includes the fallback in liveOutputs (currently never; the
      // fallback is parallel state) still resolves it via the same code
      // path as any other entry.
      newOutputId = fallbackOutputId;
      if (fallbackOutputName !== "") {
        appendPreferredOutput(state, handle, fallbackOutputName);
      }
    }

    if (newOutputId === oldOutputId) continue;

    // Move the workspace between positionsByOutput entries.
    const fromPositions = state.positionsByOutput.get(oldOutputId);
    if (fromPositions) {
      const idx = fromPositions.indexOf(handle);
      if (idx >= 0) fromPositions.splice(idx, 1);
      // Leave an empty array in the map so step 3 can still pick a
      // shown one (if any) and so we know which outputs were drained.
    }
    let toPositions = state.positionsByOutput.get(newOutputId);
    if (!toPositions) {
      toPositions = [];
      state.positionsByOutput.set(newOutputId, toPositions);
    }
    toPositions.push(handle);

    // If this workspace was the shown one on its old output, clear that
    // entry; step 3 picks a replacement (or leaves it unset if the old
    // output is now workspaceless).
    if (state.shownByOutput.get(oldOutputId) === handle) {
      state.shownByOutput.delete(oldOutputId);
    }

    rec.outputId = newOutputId;
    migrations.push({ handle, fromOutputId: oldOutputId, toOutputId: newOutputId });
  }

  // Step 3: ≥1-workspace-per-touched-output invariant. Any LIVE output
  // (not fallback) that ended with zero workspaces because reclaim drained
  // it gets a fresh empty workspace. Done before the focus restore so the
  // newly-created workspace participates in the lowest-position fallback.
  for (const liveId of liveOutputIds) {
    const positions = state.positionsByOutput.get(liveId);
    if (positions && positions.length > 0) continue;
    const name = liveOutputs.get(liveId);
    if (name === undefined) continue;  // unreachable; liveOutputIds came from liveOutputs
    const freshHandle = asHandle(state.nextHandle);
    state.nextHandle += 1;
    state.byHandle.set(freshHandle, {
      handle: freshHandle, outputId: liveId, members: [], urgent: false,
      // Seed preferredOutputs with the live name so the replenishment
      // workspace stays anchored to this output across future churn.
      preferredOutputs: [name],
    });
    if (positions) positions.push(freshHandle);
    else state.positionsByOutput.set(liveId, [freshHandle]);
    sideEffects.push({
      kind: "emit", name: "workspace.created",
      payload: { handle: freshHandle, index: 1, outputId: liveId },
    });
  }

  // Step 4: per-output focus restore. For each output that needs a new
  // shown (its shown was cleared, or it has workspaces but no shown
  // because it just appeared), pick:
  //   a) lastActiveByOutputName[name] if it resolves to a workspace
  //      currently on this output;
  //   b) else the lowest-position workspace on this output.
  // Iterate over every output that has workspaces -- a returning monitor
  // that just reclaimed workspaces has positions but no shown entry yet.
  const outputsWithWorkspaces = new Set<number>(state.positionsByOutput.keys());
  for (const outputId of outputsWithWorkspaces) {
    const positions = state.positionsByOutput.get(outputId);
    if (!positions || positions.length === 0) continue;
    if (state.shownByOutput.has(outputId)) continue;

    // Determine durable name for this output: liveOutputs is the source of
    // truth for real outputs; the fallback has its own name; unknown means
    // we don't have a name (test harness or transient state) and lastActive
    // lookup is skipped.
    let durableName = "";
    if (outputId === fallbackOutputId) {
      durableName = fallbackOutputName;
    } else {
      const liveName = liveOutputs.get(outputId);
      if (liveName !== undefined) durableName = liveName;
    }

    let chosen: WorkspaceHandle | null = null;
    let fromRemembered = false;
    if (durableName !== "") {
      const remembered = state.lastActiveByOutputName.get(durableName);
      if (remembered !== undefined && positions.includes(remembered)) {
        chosen = remembered;
        fromRemembered = true;
      }
    }
    if (chosen === null) chosen = positions[0];
    state.shownByOutput.set(outputId, chosen);
    // Only update lastActive when the choice CAME from a successful
    // lookup (round-trip preservation). When we fell back to the
    // lowest-position workspace because the remembered one is no longer
    // on this output, leave the remembered entry alone -- if that
    // workspace comes back to this output later (via another hotplug),
    // a subsequent recompute restores its focus. Overwriting now would
    // permanently lose that intent.
    if (fromRemembered && durableName !== "") {
      state.lastActiveByOutputName.set(durableName, chosen);
    }
  }

  // Step 5: emit per-output side effects.
  //   - Every output whose shown changed: emit workspace.hidden (if
  //     applicable) + workspace.shown + setOutputStack.
  //   - Every output whose shown DID NOT change but whose workspaces set
  //     was touched (migration moved a non-shown workspace away or onto
  //     it): the visible stack didn't change, so no setOutputStack.
  //   - One requestFocusDecision at the end if anything changed.
  let anyShownChanged = false;
  for (const [outputId, before] of shownBefore) {
    const after = state.shownByOutput.get(outputId);
    if (before === after) continue;
    anyShownChanged = true;

    if (before !== undefined) {
      // The previously-shown workspace may have migrated away (it now
      // lives on another output) or just been hidden by a focus change
      // here. findIndex returns null when the handle no longer lives on
      // outputId; we still emit hidden with the formerIndex 0 (sentinel)
      // because subscribers track the handle, not the index.
      const rec = state.byHandle.get(before);
      const formerIdx = rec && rec.outputId === outputId
        ? findIndex(state, before, outputId)
        : null;
      sideEffects.push({
        kind: "emit", name: "workspace.hidden",
        payload: {
          handle: before,
          // formerIndex 0 = sentinel "no longer on this output" (the
          // workspace migrated). Normal hides carry the live index.
          index: (formerIdx ?? 0) as number,
          outputId,
        },
      });
    }
    if (after !== undefined) {
      const idx = findIndex(state, after, outputId);
      sideEffects.push({
        kind: "emit", name: "workspace.shown",
        payload: { handle: after, index: (idx ?? 1) as number, outputId },
      });
    }

    // setOutputStack for every output whose shown changed -- including
    // the case where after is undefined (output disappeared from
    // positionsByOutput entirely; tell the compositor to clear the
    // stack via null). The compositor accepts null to clear.
    if (after === undefined) {
      sideEffects.push({ kind: "setOutputStack", outputId, ids: [] });
    } else {
      sideEffects.push({
        kind: "setOutputStack", outputId, ids: stackFor(state, outputId),
      });
    }
  }

  // Step 6: workspace.migrated events for diagnostics + plugin observers
  // that want per-workspace movement. Emitted AFTER hidden/shown so a
  // status bar that re-renders on migrated sees the resolved state.
  for (const m of migrations) {
    sideEffects.push({
      kind: "emit", name: "workspace.migrated",
      payload: {
        handle: m.handle,
        fromOutputId: m.fromOutputId,
        toOutputId: m.toOutputId,
      },
    });
  }

  // Step 7: cleanup empty position arrays so future iterations of
  // positionsByOutput don't iterate over phantom outputs. Done last so
  // step 5's shownBefore-based diff already ran against the pre-cleanup
  // state.
  for (const [outputId, positions] of [...state.positionsByOutput.entries()]) {
    if (positions.length === 0) state.positionsByOutput.delete(outputId);
  }

  if (anyShownChanged) {
    sideEffects.push({ kind: "requestFocusDecision", reason: "workspace-changed" });
  }

  return { state, sideEffects, migrations };
}
