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
  // Insertion-ordered (JS Map iteration order). The order surfaceIds appear
  // in setOutputStack pushes is the order they were added.
  members: Set<number>;
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
  };
  return ensureOutput(state, OUTPUT_DEFAULT, bootOutputName);
}

// Internal: guarantee outputId has at least one workspace, creating one if
// needed. Returns the (possibly mutated) state + any sideEffects emitted
// (only 'workspace.created' on first creation). `seedName` is the durable
// output identifier seeded into the new workspace's preferredOutputs list;
// callers should pass the live output's name so the workspace remembers its
// boot home.
function ensureOutput(state: WorkspaceState, outputId: number, seedName: string,
                      ): { state: WorkspaceState; sideEffects: SideEffect[] } {
  if ((state.positionsByOutput.get(outputId) ?? []).length > 0) {
    return { state, sideEffects: [] };
  }
  const handle = asHandle(state.nextHandle);
  const rec: WorkspaceRecord = {
    handle, outputId, members: new Set(),
    preferredOutputs: [seedName],
  };
  state.byHandle.set(handle, rec);
  state.positionsByOutput.set(outputId, [handle]);
  state.shownByOutput.set(outputId, handle);
  state.nextHandle += 1;
  const sideEffects: SideEffect[] = [
    {
      kind: "emit", name: "workspace.created",
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
    handle, outputId, members: new Set(),
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
      handle: fresh, outputId, members: new Set(),
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
  if (rec.members.size > 0 && target !== null) {
    const targetRec = state.byHandle.get(target);
    if (!targetRec) throw new Error("internal: relocation target missing");
    for (const sid of rec.members) {
      targetRec.members.add(sid);
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
  } else if (rec.members.size > 0) {
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
export function show(state: WorkspaceState,
                     index: WorkspaceIndex,
                     outputId: number = OUTPUT_DEFAULT,
                     ): { state: WorkspaceState; sideEffects: SideEffect[] } {
  const handle = findHandle(state, index, outputId);
  if (handle === null) {
    throw new Error(
      `show: no workspace at index ${index as number} on output ${outputId}`);
  }
  const prev = state.shownByOutput.get(outputId);
  if (prev === handle) return { state, sideEffects: [] };

  state.shownByOutput.set(outputId, handle);

  const sideEffects: SideEffect[] = [];
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

  fromRec.members.delete(surfaceId);
  targetRec.members.add(surfaceId);
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
  rec.members.add(surfaceId);
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

  rec.members.delete(surfaceId);
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
