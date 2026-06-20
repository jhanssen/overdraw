// M7 step 5: recomputeOutputs migration policy.
//
// Tests the registry helper that runs on every hotplug add/remove:
// recompute every workspace's derived live output from its preferredOutputs
// against the current liveOutputs set, evacuate / reclaim / park as the
// design (multi-output-design §10) specifies, preserve the
// ≥1-workspace-per-touched-output invariant, restore per-output focus
// from lastActiveByOutputName.
//
// All tests are pure logic over the registry -- no SDK, no async, no IPC.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  init, create, applyMap, show, recomputeOutputs, ensureOutput,
  appendPreferredOutput, promotePreferredOutput,
} from '../../packages/plugin-workspace-default/dist/registry.js';

// Conveniences -----------------------------------------------------------

// Sentinel ids matching the core's state.fallbackOutput (the workspace
// plugin treats these as opaque -- any unique negative id + sentinel name
// works for testing).
const FALLBACK_ID = -1;
const FALLBACK_NAME = '__fallback__';

function live(...pairs) {
  // Build a Map<outputId, durableName> from {id, name} pairs.
  const m = new Map();
  for (const p of pairs) m.set(p.id, p.name);
  return m;
}

function workspaceOnOutput(state, outputId) {
  return [...state.byHandle.values()]
    .filter((rec) => rec.outputId === outputId)
    .map((rec) => rec.handle);
}

// ---- Removal: evacuation when preferredOutputs[0] disappears -----------

test('remove: workspace whose preferred output vanished falls onto remaining real output', () => {
  // Two outputs: DP-1 (id=0) and HDMI-1 (id=1). One workspace on each --
  // ensureOutput creates exactly one (unlike create which adds another).
  let state = init('DP-1').state;
  state = ensureOutput(state, 1, 'HDMI-1').state;

  // Unplug HDMI-1. Liveouts is just DP-1 now.
  const liveAfter = live({ id: 0, name: 'DP-1' });
  const r = recomputeOutputs(state, liveAfter, FALLBACK_ID, FALLBACK_NAME);
  state = r.state;

  // Every workspace lives on output 0 now. The HDMI-1 workspace's
  // preferredOutputs gains DP-1 at lowest priority (mutation rule 2).
  const wsOn0 = workspaceOnOutput(state, 0);
  const wsOn1 = workspaceOnOutput(state, 1);
  assert.equal(wsOn1.length, 0, 'output 1 has no workspaces after unplug');
  assert.equal(wsOn0.length, 2, 'output 0 has both workspaces');

  // The migrated workspace's preferredOutputs is ['HDMI-1', 'DP-1'].
  const migrated = [...state.byHandle.values()].find(
    (rec) => rec.preferredOutputs.length === 2);
  assert.ok(migrated, 'one workspace had its preferredOutputs grown');
  assert.deepEqual(migrated.preferredOutputs, ['HDMI-1', 'DP-1']);

  // The migration event was emitted with from / to outputIds.
  const migrations = r.sideEffects.filter(
    (e) => e.kind === 'emit' && e.name === 'workspace.migrated');
  assert.equal(migrations.length, 1);
  assert.equal(migrations[0].payload.fromOutputId, 1);
  assert.equal(migrations[0].payload.toOutputId, 0);
});

test('remove: no real output survives -> workspaces park on the fallback', () => {
  let state = init('DP-1').state;

  // Unplug the last real output. Liveouts is empty.
  const r = recomputeOutputs(state, new Map(), FALLBACK_ID, FALLBACK_NAME);
  state = r.state;

  // The boot workspace migrated to the fallback id.
  const ws = [...state.byHandle.values()][0];
  assert.equal(ws.outputId, FALLBACK_ID);
  // The fallback's durable name was appended at lowest priority so a
  // subsequent recompute would resolve back via the same code path.
  assert.deepEqual(ws.preferredOutputs, ['DP-1', FALLBACK_NAME]);
  // The shown workspace on the fallback is set.
  assert.equal(state.shownByOutput.get(FALLBACK_ID), ws.handle);
});

// ---- Reclaim: returning monitor pulls its workspaces back --------------

test('return: workspace migrates BACK to its preferred output when it reappears', () => {
  // Boot with DP-1 + HDMI-1, one workspace each.
  let state = init('DP-1').state;
  state = ensureOutput(state, 1, 'HDMI-1').state;

  // Unplug HDMI-1 -- both workspaces end up on DP-1.
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }), FALLBACK_ID, FALLBACK_NAME).state;

  // Replug HDMI-1 (came back as a different dense outputId, 7).
  const r = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }, { id: 7, name: 'HDMI-1' }),
    FALLBACK_ID, FALLBACK_NAME);
  state = r.state;

  // The workspace that originated on HDMI-1 (preferredOutputs starts with
  // 'HDMI-1') is back on outputId 7 (the new dense id for HDMI-1).
  const onHdmi = workspaceOnOutput(state, 7);
  assert.equal(onHdmi.length, 1);
  const reclaimed = state.byHandle.get(onHdmi[0]);
  assert.equal(reclaimed.preferredOutputs[0], 'HDMI-1',
    'reclaimed workspace was the one originally seeded with HDMI-1');
});

test('return: replug on different port (same durable name, new dense id) reclaims correctly', () => {
  let state = init('DP-1').state;
  state = ensureOutput(state, 1, 'HDMI-1').state;
  // Unplug HDMI-1 (id=1).
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }), FALLBACK_ID, FALLBACK_NAME).state;
  // Replug HDMI-1 on a DIFFERENT port: kernel handed it dense id 42 this time.
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }, { id: 42, name: 'HDMI-1' }),
    FALLBACK_ID, FALLBACK_NAME).state;

  const onHdmi = workspaceOnOutput(state, 42);
  assert.equal(onHdmi.length, 1);
  // Original HDMI-1 workspace is back, despite the new dense id.
  assert.equal(state.byHandle.get(onHdmi[0]).preferredOutputs[0], 'HDMI-1');
});

// ---- ≥1-workspace-per-touched-output invariant -------------------------

test('donor drained to zero by reclaim gets a fresh empty workspace', () => {
  // Boot with DP-1 + HDMI-1 + DP-2; each output has exactly one workspace.
  let state = init('DP-1').state;
  state = ensureOutput(state, 1, 'HDMI-1').state;
  state = ensureOutput(state, 2, 'DP-2').state;

  // Unplug HDMI-1 -- its workspace evacuates to DP-1.
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }, { id: 2, name: 'DP-2' }),
    FALLBACK_ID, FALLBACK_NAME).state;
  // The HDMI-1 workspace now has preferredOutputs = ['HDMI-1', 'DP-1'].
  // DP-1 has 2 workspaces, DP-2 has 1, HDMI-1 has 0.
  assert.equal(workspaceOnOutput(state, 0).length, 2);
  assert.equal(workspaceOnOutput(state, 2).length, 1);

  // Replug HDMI-1 (same dense id 1). The reclaim pulls the HDMI-1
  // workspace back. DP-1 now has 1 workspace (its original); HDMI-1 has 1.
  // Donor invariant DOES NOT trigger -- DP-1 still has its original
  // workspace, no replenishment needed.
  const r = recomputeOutputs(
    state,
    live({ id: 0, name: 'DP-1' }, { id: 1, name: 'HDMI-1' }, { id: 2, name: 'DP-2' }),
    FALLBACK_ID, FALLBACK_NAME);
  state = r.state;
  assert.equal(workspaceOnOutput(state, 0).length, 1);
  assert.equal(workspaceOnOutput(state, 1).length, 1);
  const created = r.sideEffects.filter(
    (e) => e.kind === 'emit' && e.name === 'workspace.created');
  assert.equal(created.length, 0, 'no replenishment workspace created');
});

test('donor invariant: drained donor gets fresh workspace; receiver does not', () => {
  // Set up: DP-1 has one workspace. HDMI-1 also has one workspace whose
  // preferredOutputs is ['HDMI-1'] -- it'll evacuate to DP-1 on unplug.
  let state = init('DP-1').state;
  state = ensureOutput(state, 1, 'HDMI-1').state;

  // Unplug HDMI-1. The HDMI-1 workspace evacuates to DP-1. HDMI-1 is gone.
  // No donor invariant triggers (HDMI-1 isn't in liveOutputs anymore).
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }), FALLBACK_ID, FALLBACK_NAME).state;

  // Now replug HDMI-1 (id=1). The HDMI-1 workspace reclaims back. DP-1
  // returns to ONE workspace (its original). DP-1 is the donor that was
  // drained by reclaim -- wait, DP-1 still has its ORIGINAL workspace,
  // it only lost the HDMI-1 workspace that was VISITING. The donor
  // invariant only fires when reclaim drained the donor to ZERO.

  // To exercise the actual donor case: move the ORIGINAL DP-1 workspace's
  // preferredOutputs to put HDMI-1 in front. Then on replug both go to HDMI-1
  // and DP-1 is drained.
  const dpOriginal = [...state.byHandle.values()].find(
    (rec) => rec.outputId === 0 && rec.preferredOutputs[0] === 'DP-1');
  promotePreferredOutput(state, dpOriginal.handle, 'HDMI-1');
  // Now both workspaces would reclaim to HDMI-1. DP-1 drains to zero.

  const r = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }, { id: 1, name: 'HDMI-1' }),
    FALLBACK_ID, FALLBACK_NAME);
  state = r.state;

  // Both workspaces are now on HDMI-1 (id=1).
  assert.equal(workspaceOnOutput(state, 1).length, 2);
  // DP-1 (id=0) had zero workspaces -- the invariant created a fresh one.
  assert.equal(workspaceOnOutput(state, 0).length, 1);
  const fresh = state.byHandle.get(workspaceOnOutput(state, 0)[0]);
  assert.deepEqual(fresh.preferredOutputs, ['DP-1'],
    'fresh donor-replenishment workspace is anchored to DP-1');
  const created = r.sideEffects.filter(
    (e) => e.kind === 'emit' && e.name === 'workspace.created');
  assert.equal(created.length, 1, 'one replenishment workspace created');
  assert.equal(created[0].payload.outputId, 0,
    'replenishment landed on the drained donor, not the receiver');
});

// ---- lastActiveByOutputName round-trip ---------------------------------

test('lastActive: show() updates the map under the live output name', () => {
  let state = init('DP-1').state;
  // The boot workspace 1 is shown on DP-1; reg.init() seeded lastActive.
  assert.equal(state.lastActiveByOutputName.get('DP-1'),
    state.shownByOutput.get(0),
    'boot workspace is the lastActive for DP-1');

  // Add a second workspace on DP-1, show it.
  state = create(state, {}, 'DP-1').state;
  const ws2 = [...state.byHandle.values()].find(
    (rec) => rec.outputId === 0 && rec.handle !== state.lastActiveByOutputName.get('DP-1'));
  const r = show(state, 2, 0, 'DP-1');
  state = r.state;
  assert.equal(state.lastActiveByOutputName.get('DP-1'), ws2.handle,
    'show() updated lastActive for DP-1');
});

test('lastActive: focus restored when an output returns', () => {
  // Set up DP-1 + HDMI-1 with two workspaces on HDMI-1; show workspace 2.
  // ensureOutput creates ws 1 on HDMI-1; create appends ws 2.
  let state = init('DP-1').state;
  state = ensureOutput(state, 1, 'HDMI-1').state;
  state = create(state, { outputId: 1 }, 'HDMI-1').state;
  // Show HDMI-1's workspace 2.
  state = show(state, 2, 1, 'HDMI-1').state;
  const hdmiShownHandle = state.shownByOutput.get(1);
  assert.equal(state.lastActiveByOutputName.get('HDMI-1'), hdmiShownHandle);

  // Unplug HDMI-1.
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }), FALLBACK_ID, FALLBACK_NAME).state;
  // lastActive[HDMI-1] still points at the formerly-shown workspace
  // (the workspace still exists, just on DP-1 now).
  assert.equal(state.lastActiveByOutputName.get('HDMI-1'), hdmiShownHandle);

  // Replug HDMI-1.
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }, { id: 1, name: 'HDMI-1' }),
    FALLBACK_ID, FALLBACK_NAME).state;
  // The remembered workspace is back AND is shown again.
  assert.equal(state.shownByOutput.get(1), hdmiShownHandle,
    'lastActive workspace restored as shown on HDMI-1 return');
});

test('lastActive: a remembered entry survives a fallback-choice recompute (not overwritten)', () => {
  // Set up: HDMI-1 has wsA (boot) + wsB. Show wsA so lastActive['HDMI-1']=wsA.
  // Then make wsA prefer DP-1; on unplug wsA migrates to DP-1, wsB stays on
  // HDMI-1 (still preferred). On replug, focus restore for HDMI-1 sees
  // lastActive=wsA which is on DP-1, falls back to wsB. The fallback choice
  // must NOT overwrite lastActive (so a future return of wsA to HDMI-1
  // still honors the remembered focus).
  let state = init('DP-1').state;
  state = ensureOutput(state, 1, 'HDMI-1').state;
  state = create(state, { outputId: 1 }, 'HDMI-1').state;
  // Show wsA (the boot workspace at index 1 on output 1) to record it as
  // the last-active for HDMI-1.
  state = show(state, 1, 1, 'HDMI-1').state;
  const wsA = state.shownByOutput.get(1);
  assert.equal(state.lastActiveByOutputName.get('HDMI-1'), wsA,
    'lastActive set by show()');
  promotePreferredOutput(state, wsA, 'DP-1');

  // Unplug HDMI-1 -- wsA moves to DP-1, wsB also moves to DP-1.
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }), FALLBACK_ID, FALLBACK_NAME).state;
  // lastActive['HDMI-1'] still points at wsA (the workspace still exists,
  // just lives on DP-1 now).
  assert.equal(state.lastActiveByOutputName.get('HDMI-1'), wsA);

  // Replug HDMI-1. wsB reclaims to HDMI-1 (its preferred[0]); wsA stays
  // on DP-1. Focus restore on HDMI-1: remembered=wsA but not on HDMI-1
  // anymore. Falls back to wsB. lastActive must NOT be overwritten -- it
  // stays wsA so a future return of wsA still gets focus.
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }, { id: 1, name: 'HDMI-1' }),
    FALLBACK_ID, FALLBACK_NAME).state;
  assert.equal(state.lastActiveByOutputName.get('HDMI-1'), wsA,
    'lastActive NOT overwritten when fallback chose a different workspace');
});

test('lastActive: falls back to lowest-position workspace when remembered is elsewhere', () => {
  // Set up: HDMI-1 has workspaces A and B; A is its lastActive.
  let state = init('DP-1').state;
  state = ensureOutput(state, 1, 'HDMI-1').state;  // ws 1 on output 1
  state = create(state, { outputId: 1 }, 'HDMI-1').state;  // ws 2 on output 1
  // Show ws 1 (the boot workspace).
  state = show(state, 1, 1, 'HDMI-1').state;
  const wsA = state.shownByOutput.get(1);

  // Move wsA's preferredOutputs so it migrates to DP-1 instead of HDMI-1
  // when next recomputed (its preferredOutputs goes ['DP-1', 'HDMI-1']).
  promotePreferredOutput(state, wsA, 'DP-1');

  // Unplug HDMI-1 then replug. wsA's preferredOutputs[0] is DP-1, so it
  // does NOT come back to HDMI-1; the remaining HDMI-1 workspace (wsB)
  // is the only one there. Focus should fall back to wsB (the
  // lowest-position workspace on HDMI-1) -- not wsA which is now on DP-1.
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }), FALLBACK_ID, FALLBACK_NAME).state;
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }, { id: 1, name: 'HDMI-1' }),
    FALLBACK_ID, FALLBACK_NAME).state;

  // HDMI-1 has only wsB (and any replenishment). lastActive[HDMI-1] = wsA
  // is still set, but wsA isn't on HDMI-1 anymore. Step 4 fell back to
  // lowest-position.
  const onHdmi = workspaceOnOutput(state, 1);
  assert.ok(onHdmi.length >= 1);
  const shown = state.shownByOutput.get(1);
  assert.notEqual(shown, wsA, 'remembered workspace is not on HDMI-1; not shown there');
  assert.ok(onHdmi.includes(shown), 'shown is some workspace on HDMI-1');
});

// ---- Cascaded disconnect ownership -------------------------------------

test('cascaded disconnect: workspace remembers its original home through A->B->C', () => {
  // Three outputs: A (id=0,'DP-A'), B (id=1,'DP-B'), C (id=2,'DP-C').
  let state = init('DP-A').state;
  state = ensureOutput(state, 1, 'DP-B').state;
  state = ensureOutput(state, 2, 'DP-C').state;
  // Take the A boot workspace; identify it.
  const wsA = [...state.byHandle.values()].find(
    (rec) => rec.preferredOutputs[0] === 'DP-A').handle;

  // Unplug A -- wsA falls onto B. preferredOutputs becomes ['DP-A', 'DP-B'].
  state = recomputeOutputs(
    state, live({ id: 1, name: 'DP-B' }, { id: 2, name: 'DP-C' }),
    FALLBACK_ID, FALLBACK_NAME).state;
  assert.equal(state.byHandle.get(wsA).outputId, 1);
  assert.deepEqual(state.byHandle.get(wsA).preferredOutputs, ['DP-A', 'DP-B']);

  // Unplug B -- wsA falls onto C. preferredOutputs becomes
  // ['DP-A', 'DP-B', 'DP-C'].
  state = recomputeOutputs(
    state, live({ id: 2, name: 'DP-C' }), FALLBACK_ID, FALLBACK_NAME).state;
  assert.equal(state.byHandle.get(wsA).outputId, 2);
  assert.deepEqual(
    state.byHandle.get(wsA).preferredOutputs, ['DP-A', 'DP-B', 'DP-C']);

  // Replug A. wsA reclaims directly to A, skipping B (which isn't live
  // anyway -- and wouldn't intercept even if it were, because A outranks).
  state = recomputeOutputs(
    state, live({ id: 0, name: 'DP-A' }, { id: 2, name: 'DP-C' }),
    FALLBACK_ID, FALLBACK_NAME).state;
  assert.equal(state.byHandle.get(wsA).outputId, 0,
    'wsA returned to A, not to B (cascaded ownership respects priority)');
});

// ---- Side-effect bookkeeping -------------------------------------------

test('setOutputStack push for outputs whose shown changed', () => {
  let state = init('DP-1').state;
  state = ensureOutput(state, 1, 'HDMI-1').state;

  // Unplug HDMI-1. Both end up on DP-1; DP-1's shown didn't change; HDMI-1's
  // shown went away (output disappeared from positionsByOutput entirely).
  const r = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }), FALLBACK_ID, FALLBACK_NAME);
  state = r.state;
  const stackPushes = r.sideEffects.filter((e) => e.kind === 'setOutputStack');
  // HDMI-1 (id=1) got a setOutputStack with empty ids (its visible set
  // became nothing).
  const hdmiPush = stackPushes.find((e) => e.outputId === 1);
  assert.ok(hdmiPush, 'setOutputStack push for the unplugged output');
  assert.deepEqual(hdmiPush.ids, []);
});

test('workspace.hidden + workspace.shown emit when shown changes via migration', () => {
  // Set up: HDMI-1 has its boot workspace; show it as the active one.
  let state = init('DP-1').state;
  state = ensureOutput(state, 1, 'HDMI-1').state;
  const hdmiBoot = [...state.byHandle.values()].find(
    (rec) => rec.outputId === 1).handle;
  // It's already shown (ensureOutput shows the boot); state.shownByOutput
  // confirms.
  assert.equal(state.shownByOutput.get(1), hdmiBoot);

  // Unplug HDMI-1.
  const r = recomputeOutputs(
    state, live({ id: 0, name: 'DP-1' }), FALLBACK_ID, FALLBACK_NAME);
  const hidden = r.sideEffects.find(
    (e) => e.kind === 'emit' && e.name === 'workspace.hidden'
      && e.payload.handle === hdmiBoot);
  assert.ok(hidden, 'workspace.hidden emitted for the no-longer-shown handle');
  assert.equal(hidden.payload.outputId, 1);
});
