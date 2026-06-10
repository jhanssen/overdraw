// Pure-unit tests for the workspace registry state machine. No SDK, no
// runtime, no compositor; the registry is fully deterministic over (state,
// input) -> (newState, sideEffects).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  init, create, destroy, show, moveWindow, setName,
  applyMap, applyUnmap, current, snapshotsForOutput,
  findHandle, findIndex, snapshotOf, OUTPUT_DEFAULT,
} from '../../packages/plugin-workspace-default/dist/registry.js';

// Helpers: pick effects by kind for assertions.
const ofKind = (effects, kind) => effects.filter((e) => e.kind === kind);
const emitsOf = (effects, name) =>
  effects.filter((e) => e.kind === 'emit' && e.name === name);

// ---- init -----------------------------------------------------------------

test('init: creates workspace 1 on OUTPUT_DEFAULT, shown, no name, no members', () => {
  const { state } = init();
  const snaps = snapshotsForOutput(state, OUTPUT_DEFAULT);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].index, 1);
  assert.equal(snaps[0].outputId, OUTPUT_DEFAULT);
  assert.equal(snaps[0].name, undefined);
  assert.deepEqual(snaps[0].members, []);
  const cur = current(state);
  assert.equal(cur?.handle, snaps[0].handle);
});

test('init: returns a workspace.created sideEffect for the boot workspace', () => {
  const { sideEffects } = init();
  const created = sideEffects.filter((e) =>
    e.kind === 'emit' && e.name === 'workspace.created');
  assert.equal(created.length, 1);
  assert.equal(created[0].payload.index, 1);
  assert.equal(created[0].payload.outputId, OUTPUT_DEFAULT);
});

// ---- create ----------------------------------------------------------------

test('create: appends; new workspace has index=2 and emits workspace.created', () => {
  let state = init().state;
  const r = create(state, {});
  state = r.state;
  assert.equal(r.snapshot.index, 2);
  assert.equal(r.snapshot.name, undefined);
  const ev = emitsOf(r.sideEffects, 'workspace.created');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.index, 2);
  assert.equal(ev[0].payload.handle, r.snapshot.handle);
});

test('create: preserves the optional name', () => {
  let state = init().state;
  const r = create(state, { name: 'web' });
  state = r.state;
  assert.equal(r.snapshot.name, 'web');
  const ev = emitsOf(r.sideEffects, 'workspace.created');
  assert.equal(ev[0].payload.name, 'web');
});

test('create: does NOT auto-show; current() still returns the original', () => {
  let state = init().state;
  const original = current(state);
  const r = create(state, {});
  state = r.state;
  assert.equal(current(state)?.handle, original.handle);
});

test('create: handles are monotonic, never reused', () => {
  let state = init().state;
  const h1 = current(state).handle;
  let r = create(state); state = r.state;
  const h2 = r.snapshot.handle;
  r = create(state); state = r.state;
  const h3 = r.snapshot.handle;
  assert.ok(h2 > h1);
  assert.ok(h3 > h2);
});

// ---- destroy ---------------------------------------------------------------

test('destroy: middle workspace renumbers everything to the right', () => {
  let state = init().state;
  // Workspaces: [1, 2, 3] -- after the bootstrap on OUTPUT_DEFAULT plus 2 creates.
  let r = create(state); state = r.state; const h2 = r.snapshot.handle;
  r = create(state); state = r.state; const h3 = r.snapshot.handle;

  // Destroy index=2 (handle h2). h3 should renumber from index 3 -> 2.
  const dr = destroy(state, 2);
  state = dr.state;
  assert.equal(dr.renumbered.length, 1);
  assert.equal(dr.renumbered[0].handle, h3);
  assert.equal(dr.renumbered[0].oldIndex, 3);
  assert.equal(dr.renumbered[0].newIndex, 2);
  // workspace.destroyed event for h2.
  const destroyed = emitsOf(dr.sideEffects, 'workspace.destroyed');
  assert.equal(destroyed.length, 1);
  assert.equal(destroyed[0].payload.handle, h2);
  assert.equal(destroyed[0].payload.formerIndex, 2);
  // workspace.renumbered event with the change list.
  const renumbered = emitsOf(dr.sideEffects, 'workspace.renumbered');
  assert.equal(renumbered.length, 1);
  assert.deepEqual(renumbered[0].payload.changes, [{
    handle: h3, oldIndex: 3, newIndex: 2,
  }]);
});

test('destroy: relocates members to the workspace that takes its position', () => {
  let state = init().state;
  let r = create(state); state = r.state; const h2 = r.snapshot.handle;
  r = create(state); state = r.state; const h3 = r.snapshot.handle;
  // Map two windows into the current (workspace 1). Move one to workspace 2.
  let m = applyMap(state, 101); state = m.state;
  let mw = moveWindow(state, 101, 2); state = mw.state;
  // Now: ws1=[], ws2=[101], ws3=[]. Destroy ws2; its members should move to
  // the workspace that takes index=2 (which was ws3, now ws2).
  const dr = destroy(state, 2); state = dr.state;
  // h3 is now at index 2 with 101 in it.
  assert.equal(findIndex(state, h3, OUTPUT_DEFAULT), 2);
  assert.deepEqual(snapshotOf(state, h3).members, [101]);
  // state-bag side effect for 101 -> h3.
  const sb = ofKind(dr.sideEffects, 'setStateBag');
  assert.equal(sb.length, 1);
  assert.equal(sb[0].surfaceId, 101);
  assert.equal(sb[0].handle, h3);
  // h2 is gone.
  assert.equal(state.byHandle.has(h2), false);
});

test('destroy: last workspace with members relocates to the new-last (left)', () => {
  let state = init().state;
  let r = create(state); state = r.state; const h2 = r.snapshot.handle;
  r = create(state); state = r.state; const h3 = r.snapshot.handle;
  let m = applyMap(state, 101); state = m.state;
  let mw = moveWindow(state, 101, 3); state = mw.state;
  // ws3=[101]; destroy index 3.
  const dr = destroy(state, 3); state = dr.state;
  // h2 is the new-last (index 2 was already its index, no renumber).
  assert.equal(dr.renumbered.length, 0);
  assert.deepEqual(snapshotOf(state, h2).members, [101]);
  // state-bag side effect.
  const sb = ofKind(dr.sideEffects, 'setStateBag');
  assert.equal(sb[0].handle, h2);
});

test('destroy: the only workspace recreates fresh (new handle), preserves members', () => {
  let state = init().state;
  const orig = current(state).handle;
  let m = applyMap(state, 101); state = m.state;
  m = applyMap(state, 102); state = m.state;
  const dr = destroy(state, 1); state = dr.state;
  // The replacement workspace has a NEW handle (not the original).
  const cur = current(state);
  assert.notEqual(cur.handle, orig);
  // Members were relocated to it.
  assert.deepEqual([...cur.members].sort(), [101, 102]);
  // workspace.created emitted for the fresh one; no workspace.renumbered.
  const created = emitsOf(dr.sideEffects, 'workspace.created');
  assert.equal(created.length, 1);
  assert.equal(created[0].payload.handle, cur.handle);
  const renumbered = emitsOf(dr.sideEffects, 'workspace.renumbered');
  assert.equal(renumbered.length, 0);
});

test('destroy: throws on out-of-range index', () => {
  const state = init().state;
  assert.throws(() => destroy(state, 2), /no workspace at index/);
  assert.throws(() => destroy(state, 0), /no workspace at index/);
});

test('destroy: shifts shownByOutput when destroying the shown workspace', () => {
  let state = init().state;
  let r = create(state); state = r.state; const h2 = r.snapshot.handle;
  // h1 is shown. Destroy h1.
  const dr = destroy(state, 1); state = dr.state;
  // h2 is now at index 1 AND shown.
  assert.equal(findIndex(state, h2, OUTPUT_DEFAULT), 1);
  assert.equal(current(state).handle, h2);
  // setOutputStack + requestFocusDecision should fire.
  const sos = ofKind(dr.sideEffects, 'setOutputStack');
  assert.equal(sos.length, 1);
  const rfd = ofKind(dr.sideEffects, 'requestFocusDecision');
  assert.equal(rfd.length, 1);
  assert.equal(rfd[0].reason, 'workspace-changed');
});

// ---- show ------------------------------------------------------------------

test('show: changes the shown workspace and emits the expected effects', () => {
  let state = init().state;
  let r = create(state); state = r.state; const h2 = r.snapshot.handle;
  let m = applyMap(state, 101); state = m.state;
  m = applyMap(state, 102); state = m.state;
  // workspace 1 has [101, 102]; workspace 2 is empty.

  const sh = show(state, 2); state = sh.state;
  // Hidden event for ws1; shown event for ws2; setOutputStack with empty ids;
  // requestFocusDecision.
  const hidden = emitsOf(sh.sideEffects, 'workspace.hidden');
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].payload.index, 1);
  const shown = emitsOf(sh.sideEffects, 'workspace.shown');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].payload.handle, h2);
  assert.equal(shown[0].payload.index, 2);
  const sos = ofKind(sh.sideEffects, 'setOutputStack');
  assert.equal(sos.length, 1);
  assert.deepEqual(sos[0].ids, []);
  const rfd = ofKind(sh.sideEffects, 'requestFocusDecision');
  assert.equal(rfd.length, 1);
});

test('show: same workspace is a no-op (no side effects)', () => {
  const state = init().state;
  const sh = show(state, 1);
  assert.equal(sh.sideEffects.length, 0);
});

test('show: throws on out-of-range index', () => {
  const state = init().state;
  assert.throws(() => show(state, 5), /no workspace at index/);
});

// ---- moveWindow ------------------------------------------------------------

test('moveWindow: from shown to hidden updates source stack only', () => {
  let state = init().state;
  let r = create(state); state = r.state; const h2 = r.snapshot.handle;
  let m = applyMap(state, 101); state = m.state;
  m = applyMap(state, 102); state = m.state;
  // shown=ws1 [101,102], hidden=ws2 [].

  const mw = moveWindow(state, 101, 2); state = mw.state;
  // 101 now in ws2.
  assert.deepEqual(snapshotOf(state, h2).members, [101]);
  // setOutputStack pushed for the shown (ws1) because its membership shrunk.
  const sos = ofKind(mw.sideEffects, 'setOutputStack');
  assert.equal(sos.length, 1);
  assert.deepEqual(sos[0].ids, [102]);
  // workspace.window-moved emitted.
  const moved = emitsOf(mw.sideEffects, 'workspace.window-moved');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].payload.surfaceId, 101);
  assert.equal(moved[0].payload.fromIndex, 1);
  assert.equal(moved[0].payload.toIndex, 2);
  // state-bag updated to h2.
  const sb = ofKind(mw.sideEffects, 'setStateBag');
  assert.equal(sb.length, 1);
  assert.equal(sb[0].handle, h2);
});

test('moveWindow: from hidden to shown updates target stack', () => {
  let state = init().state;
  let r = create(state); state = r.state;
  let m = applyMap(state, 101); state = m.state;
  // Move 101 to ws2 (hidden).
  let mw = moveWindow(state, 101, 2); state = mw.state;
  // Now show ws2.
  let sh = show(state, 2); state = sh.state;
  // ws2 now shown with [101]; ws1 hidden empty.
  // Move 101 back to ws1 (hidden).
  mw = moveWindow(state, 101, 1); state = mw.state;
  // setOutputStack pushed for ws2 (now shown, lost 101).
  const sos = ofKind(mw.sideEffects, 'setOutputStack');
  assert.equal(sos.length, 1);
  assert.deepEqual(sos[0].ids, []);
});

test('moveWindow: to same workspace is a no-op', () => {
  let state = init().state;
  let m = applyMap(state, 101); state = m.state;
  const mw = moveWindow(state, 101, 1);
  assert.equal(mw.sideEffects.length, 0);
});

test('moveWindow: unknown surface throws', () => {
  let state = init().state;
  let r = create(state); state = r.state;
  assert.throws(() => moveWindow(state, 999, 2), /not tracked/);
});

test('moveWindow: out-of-range target throws', () => {
  let state = init().state;
  let m = applyMap(state, 101); state = m.state;
  assert.throws(() => moveWindow(state, 101, 5), /no workspace at index/);
});

// ---- setName ---------------------------------------------------------------

test('setName: assigns a name; subsequent snapshot shows it', () => {
  let state = init().state;
  const r = setName(state, 1, 'web'); state = r.state;
  assert.equal(current(state).name, 'web');
  const ev = emitsOf(r.sideEffects, 'workspace.renamed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.name, 'web');
});

test('setName: clearing with undefined reverts to no name', () => {
  let state = init().state;
  let r = setName(state, 1, 'web'); state = r.state;
  r = setName(state, 1, undefined); state = r.state;
  assert.equal(current(state).name, undefined);
  const ev = emitsOf(r.sideEffects, 'workspace.renamed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.name, undefined);
});

test('setName: identical value is a no-op', () => {
  let state = init().state;
  let r = setName(state, 1, 'web'); state = r.state;
  r = setName(state, 1, 'web');
  assert.equal(r.sideEffects.length, 0);
});

test('setName: throws on out-of-range index', () => {
  const state = init().state;
  assert.throws(() => setName(state, 5, 'x'), /no workspace at index/);
});

// ---- applyMap --------------------------------------------------------------

test('applyMap: assigns to the shown workspace; emits state-bag + setOutputStack', () => {
  let state = init().state;
  const r = applyMap(state, 101); state = r.state;
  const cur = current(state);
  assert.deepEqual(cur.members, [101]);
  const sb = ofKind(r.sideEffects, 'setStateBag');
  assert.equal(sb.length, 1);
  assert.equal(sb[0].surfaceId, 101);
  assert.equal(sb[0].handle, cur.handle);
  const sos = ofKind(r.sideEffects, 'setOutputStack');
  assert.equal(sos.length, 1);
  assert.deepEqual(sos[0].ids, [101]);
});

test('applyMap: members preserve insertion order', () => {
  let state = init().state;
  let r = applyMap(state, 101); state = r.state;
  r = applyMap(state, 102); state = r.state;
  r = applyMap(state, 103); state = r.state;
  assert.deepEqual(current(state).members, [101, 102, 103]);
});

test('applyMap: idempotent for an already-tracked surface', () => {
  let state = init().state;
  let r = applyMap(state, 101); state = r.state;
  r = applyMap(state, 101);
  assert.equal(r.sideEffects.length, 0);
  assert.deepEqual(current(state).members, [101]);
});

// ---- applyUnmap ------------------------------------------------------------

test('applyUnmap: shown workspace -- removes from members + state-bag + push stack', () => {
  let state = init().state;
  let r = applyMap(state, 101); state = r.state;
  r = applyMap(state, 102); state = r.state;
  const ur = applyUnmap(state, 101); state = ur.state;
  assert.deepEqual(current(state).members, [102]);
  const dsb = ofKind(ur.sideEffects, 'deleteStateBag');
  assert.equal(dsb.length, 1);
  assert.equal(dsb[0].surfaceId, 101);
  const sos = ofKind(ur.sideEffects, 'setOutputStack');
  assert.equal(sos.length, 1);
  assert.deepEqual(sos[0].ids, [102]);
});

test('applyUnmap: hidden workspace -- no setOutputStack push', () => {
  let state = init().state;
  let r = create(state); state = r.state;
  r = applyMap(state, 101); state = r.state;
  let mw = moveWindow(state, 101, 2); state = mw.state;
  // 101 on ws2 (hidden).
  const ur = applyUnmap(state, 101); state = ur.state;
  const sos = ofKind(ur.sideEffects, 'setOutputStack');
  assert.equal(sos.length, 0);
  const dsb = ofKind(ur.sideEffects, 'deleteStateBag');
  assert.equal(dsb.length, 1);
});

test('applyUnmap: unknown surface -- no-op', () => {
  let state = init().state;
  const ur = applyUnmap(state, 999);
  assert.equal(ur.sideEffects.length, 0);
});

// ---- findIndex / findHandle ------------------------------------------------

test('findIndex / findHandle round-trip', () => {
  let state = init().state;
  let r = create(state); state = r.state; const h2 = r.snapshot.handle;
  const idx = findIndex(state, h2, OUTPUT_DEFAULT);
  assert.equal(idx, 2);
  const h = findHandle(state, idx, OUTPUT_DEFAULT);
  assert.equal(h, h2);
});

test('findIndex: unknown handle returns null', () => {
  const state = init().state;
  assert.equal(findIndex(state, 999, OUTPUT_DEFAULT), null);
});

test('findHandle: out-of-range index returns null', () => {
  const state = init().state;
  assert.equal(findHandle(state, 5, OUTPUT_DEFAULT), null);
  assert.equal(findHandle(state, 0, OUTPUT_DEFAULT), null);
});

// ---- snapshot --------------------------------------------------------------

test('snapshotsForOutput: workspaces sorted by index', () => {
  let state = init().state;
  let r = create(state); state = r.state;
  r = create(state); state = r.state;
  const snaps = snapshotsForOutput(state, OUTPUT_DEFAULT);
  assert.deepEqual(snaps.map((s) => s.index), [1, 2, 3]);
});
