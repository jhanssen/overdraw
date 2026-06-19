// preferredOutputs durable list + the three mutation rules + currentLiveOutput
// resolver. Pure logic over the registry; no SDK, no runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  init, create, moveWindow, applyMap,
  currentLiveOutput, appendPreferredOutput, promotePreferredOutput,
} from '../../packages/plugin-workspace-default/dist/registry.js';

// ---- seed --------------------------------------------------------------------

test('init: boot workspace has the boot output name in preferredOutputs', () => {
  const { state } = init('DP-1');
  // The boot workspace is at index 1 on output 0.
  const ws = [...state.byHandle.values()][0];
  assert.deepEqual(ws.preferredOutputs, ['DP-1']);
});

test('create: appends boot output name when no preferred list is given', () => {
  let state = init('DP-1').state;
  const r = create(state, {}, 'DP-1');
  state = r.state;
  const ws = state.byHandle.get(r.snapshot.handle);
  assert.deepEqual(ws.preferredOutputs, ['DP-1']);
});

test('create: honors a config-supplied preferredOutputs list', () => {
  let state = init('DP-1').state;
  const r = create(state, { preferredOutputs: ['HDMI-1', 'DP-2'] }, 'DP-1');
  const ws = r.state.byHandle.get(r.snapshot.handle);
  // The boot output is appended so the workspace always covers its live home.
  assert.deepEqual(ws.preferredOutputs, ['HDMI-1', 'DP-2', 'DP-1']);
});

test('create: a config list that already contains the boot output is left untouched', () => {
  let state = init('DP-1').state;
  const r = create(state, { preferredOutputs: ['DP-1', 'HDMI-1'] }, 'DP-1');
  const ws = r.state.byHandle.get(r.snapshot.handle);
  assert.deepEqual(ws.preferredOutputs, ['DP-1', 'HDMI-1']);
});

// ---- mutation rule 2: append on forced placement ----------------------------

test('appendPreferredOutput: adds at lowest priority', () => {
  let state = init('DP-1').state;
  const handle = [...state.byHandle.keys()][0];
  const changed = appendPreferredOutput(state, handle, 'HDMI-1');
  assert.equal(changed, true);
  assert.deepEqual(state.byHandle.get(handle).preferredOutputs, ['DP-1', 'HDMI-1']);
});

test('appendPreferredOutput: idempotent for an already-listed name', () => {
  let state = init('DP-1').state;
  const handle = [...state.byHandle.keys()][0];
  const changed = appendPreferredOutput(state, handle, 'DP-1');
  assert.equal(changed, false);
  assert.deepEqual(state.byHandle.get(handle).preferredOutputs, ['DP-1']);
});

// ---- mutation rule 3: promote on explicit move ------------------------------

test('promotePreferredOutput: inserts at front when name is absent', () => {
  let state = init('DP-1').state;
  const handle = [...state.byHandle.keys()][0];
  const changed = promotePreferredOutput(state, handle, 'HDMI-1');
  assert.equal(changed, true);
  assert.deepEqual(state.byHandle.get(handle).preferredOutputs, ['HDMI-1', 'DP-1']);
});

test('promotePreferredOutput: raises an interior name to the front', () => {
  let state = init('DP-1').state;
  const handle = [...state.byHandle.keys()][0];
  appendPreferredOutput(state, handle, 'HDMI-1');
  appendPreferredOutput(state, handle, 'DP-2');
  // List is now [DP-1, HDMI-1, DP-2].
  const changed = promotePreferredOutput(state, handle, 'DP-2');
  assert.equal(changed, true);
  assert.deepEqual(state.byHandle.get(handle).preferredOutputs, ['DP-2', 'DP-1', 'HDMI-1']);
});

test('promotePreferredOutput: no-op when already at the front', () => {
  let state = init('DP-1').state;
  const handle = [...state.byHandle.keys()][0];
  const changed = promotePreferredOutput(state, handle, 'DP-1');
  assert.equal(changed, false);
  assert.deepEqual(state.byHandle.get(handle).preferredOutputs, ['DP-1']);
});

// ---- moveWindow promotes the destination output ----------------------------

test('moveWindow across outputs: promotes the destination output on the target workspace', () => {
  // Two outputs (0=DP-1, 1=HDMI-1), each with a workspace. Move a surface
  // from output 0's workspace into output 1's workspace; preferredOutputs of
  // the target workspace should now lead with HDMI-1.
  let state = init('DP-1').state;
  // Create workspace 1 on output 1; its preferredOutputs = ['HDMI-1'].
  let r = create(state, { outputId: 1 }, 'HDMI-1'); state = r.state;
  const targetHandle = r.snapshot.handle;
  // Map a surface on output 0's workspace 1.
  let m = applyMap(state, 101, 0, 'DP-1'); state = m.state;

  // Move it to output 1's workspace 1.
  const mv = moveWindow(state, 101, 1, 1, 'HDMI-1');
  state = mv.state;
  const targetWs = state.byHandle.get(targetHandle);
  // HDMI-1 was already at front, list unchanged.
  assert.deepEqual(targetWs.preferredOutputs, ['HDMI-1']);
});

test('moveWindow across outputs: promotes a previously-unknown destination', () => {
  let state = init('DP-1').state;
  // Bring output 1 online: ensureOutput seeds 'HDMI-1' into its first
  // workspace's preferredOutputs. Force the seeded list to a different name
  // so we can observe the promotion.
  let r = create(state, { outputId: 1, preferredOutputs: ['DP-2'] }, 'HDMI-1');
  state = r.state;
  // The seeded workspace is at index 1 on output 1; the freshly-created one
  // is at index 2. We aim the move at index 2 so the promotion is observable.
  const targetHandle = r.snapshot.handle;
  // The newly-created workspace's list is ['DP-2', 'HDMI-1'] (config + boot).
  // Force it to NOT contain HDMI-1 so the promotion does something visible.
  state.byHandle.get(targetHandle).preferredOutputs = ['DP-2'];
  // Map a surface on output 0.
  let m = applyMap(state, 101, 0, 'DP-1'); state = m.state;
  // Move into the target workspace (index 2 on output 1).
  state = moveWindow(state, 101, 2, 1, 'HDMI-1').state;
  // HDMI-1 should now be in front, ahead of DP-2.
  assert.deepEqual(state.byHandle.get(targetHandle).preferredOutputs, ['HDMI-1', 'DP-2']);
});

// ---- currentLiveOutput resolver ---------------------------------------------

test('currentLiveOutput: returns highest-ranked resolvable output', () => {
  let state = init('DP-1').state;
  const handle = [...state.byHandle.keys()][0];
  appendPreferredOutput(state, handle, 'HDMI-1');
  // Live outputs: only DP-1 (id 0) is connected.
  const live = new Map([[0, 'DP-1']]);
  const id = currentLiveOutput(state.byHandle.get(handle), live);
  assert.equal(id, 0);
});

test('currentLiveOutput: prefers the higher-ranked entry when both are live', () => {
  let state = init('DP-1').state;
  const handle = [...state.byHandle.keys()][0];
  // Promote HDMI-1 to the front; DP-1 follows.
  promotePreferredOutput(state, handle, 'HDMI-1');
  const live = new Map([[0, 'DP-1'], [7, 'HDMI-1']]);
  assert.equal(currentLiveOutput(state.byHandle.get(handle), live), 7);
});

test('currentLiveOutput: null when no entry resolves', () => {
  let state = init('DP-1').state;
  const handle = [...state.byHandle.keys()][0];
  const live = new Map([[42, 'HDMI-1']]);  // DP-1 is gone
  assert.equal(currentLiveOutput(state.byHandle.get(handle), live), null);
});

test('currentLiveOutput: identifies a replug on a different port (same name, new dense id)', () => {
  let state = init('DP-1').state;
  const handle = [...state.byHandle.keys()][0];
  // Replug: DP-1 came back as outputId=5 (different dense id, same durable name).
  const live = new Map([[5, 'DP-1']]);
  assert.equal(currentLiveOutput(state.byHandle.get(handle), live), 5);
});
