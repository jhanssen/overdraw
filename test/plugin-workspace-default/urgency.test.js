// Pure-unit tests for workspace urgency: registry-level setUrgent toggles,
// idempotence, auto-clear on show, and snapshot reflection. The protocol-
// level translation of these events lives under test/ext-workspace*.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  init, create, show, setUrgent, applyMap, snapshotsForOutput,
  OUTPUT_DEFAULT,
} from '../../packages/plugin-workspace-default/dist/registry.js';

const emitsOf = (effects, name) =>
  effects.filter((e) => e.kind === 'emit' && e.name === name);

test('setUrgent: flips the flag, emits workspace.urgency-changed', () => {
  let state = init('out0').state;
  // Create a second workspace so we can mark it urgent without it being
  // the shown one (which would auto-clear).
  let r = create(state, {}, 'out0'); state = r.state;
  const handle2 = r.snapshot.handle;

  const u = setUrgent(state, 2, true, OUTPUT_DEFAULT);
  state = u.state;
  const evs = emitsOf(u.sideEffects, 'workspace.urgency-changed');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].payload.urgent, true);
  assert.equal(evs[0].payload.workspaceId, handle2);
  assert.equal(evs[0].payload.outputId, OUTPUT_DEFAULT);

  const snaps = snapshotsForOutput(state, OUTPUT_DEFAULT);
  assert.equal(snaps[1].urgent, true);
  assert.equal(snaps[0].urgent, false);
});

test('setUrgent: idempotent — re-setting the same value emits nothing', () => {
  let state = init('out0').state;
  let r = create(state, {}, 'out0'); state = r.state;

  // First flip: emits.
  let u = setUrgent(state, 2, true, OUTPUT_DEFAULT);
  state = u.state;
  assert.equal(emitsOf(u.sideEffects, 'workspace.urgency-changed').length, 1);

  // Same value again: no emit.
  u = setUrgent(state, 2, true, OUTPUT_DEFAULT);
  state = u.state;
  assert.equal(u.sideEffects.length, 0);

  // Clear: emits again.
  u = setUrgent(state, 2, false, OUTPUT_DEFAULT);
  state = u.state;
  const evs = emitsOf(u.sideEffects, 'workspace.urgency-changed');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].payload.urgent, false);

  // Clear again: no emit.
  u = setUrgent(state, 2, false, OUTPUT_DEFAULT);
  assert.equal(u.sideEffects.length, 0);
});

test('show: auto-clears urgent on the newly-shown workspace; emit ordered before workspace.shown', () => {
  let state = init('out0').state;
  // 100 anchors ws1 so it survives being hidden while empty.
  state = applyMap(state, 100, 0, 'out0').state;
  let r = create(state, {}, 'out0'); state = r.state;
  const handle2 = r.snapshot.handle;

  let u = setUrgent(state, 2, true, OUTPUT_DEFAULT); state = u.state;
  assert.equal(snapshotsForOutput(state, OUTPUT_DEFAULT)[1].urgent, true);

  const s = show(state, 2, OUTPUT_DEFAULT, 'out0');
  state = s.state;

  const emits = s.sideEffects.filter((e) => e.kind === 'emit');
  const names = emits.map((e) => e.name);
  // urgency-changed must come before workspace.shown so coalesced
  // protocol-state subscribers see the cleared urgent bit then the new
  // active bit in one logical update.
  const urgencyIdx = names.indexOf('workspace.urgency-changed');
  const shownIdx = names.indexOf('workspace.shown');
  assert.ok(urgencyIdx !== -1, 'expected urgency-changed emit');
  assert.ok(shownIdx !== -1, 'expected workspace.shown emit');
  assert.ok(urgencyIdx < shownIdx, 'urgency-changed must precede workspace.shown');

  const urgencyEvent = emits[urgencyIdx];
  assert.equal(urgencyEvent.payload.urgent, false);
  assert.equal(urgencyEvent.payload.workspaceId, handle2);

  assert.equal(snapshotsForOutput(state, OUTPUT_DEFAULT)[1].urgent, false);
});

test('show: NO urgency-changed emit when the workspace was not urgent', () => {
  let state = init('out0').state;
  let r = create(state, {}, 'out0'); state = r.state;

  const s = show(state, 2, OUTPUT_DEFAULT, 'out0');
  assert.equal(emitsOf(s.sideEffects, 'workspace.urgency-changed').length, 0);
});

test('show: setting urgent on the already-shown workspace emits but does NOT auto-clear via this code path', () => {
  // Edge case: there is no event that fires "show was called for an
  // already-shown workspace" auto-clear. Auto-clear runs only on the
  // shown-transition path. setting urgent on the currently-shown
  // workspace is therefore observable; clearing it is up to the caller.
  let state = init('out0').state;
  const u = setUrgent(state, 1, true, OUTPUT_DEFAULT);
  state = u.state;
  assert.equal(snapshotsForOutput(state, OUTPUT_DEFAULT)[0].urgent, true);

  // Re-show same workspace: returns no side effects (already shown
  // short-circuit). The urgent flag is unchanged — caller must clear it
  // explicitly if they want.
  const s = show(state, 1, OUTPUT_DEFAULT, 'out0');
  assert.equal(s.sideEffects.length, 0);
  assert.equal(snapshotsForOutput(state, OUTPUT_DEFAULT)[0].urgent, true);
});

test('setUrgent: throws on out-of-range index', () => {
  const { state } = init('out0');
  assert.throws(() => setUrgent(state, 99, true, OUTPUT_DEFAULT),
    /no workspace at index 99/);
});

test('snapshotsForOutput: every snapshot carries urgent (default false)', () => {
  let state = init('out0').state;
  let r = create(state, { name: 'web' }, 'out0'); state = r.state;
  r = create(state, { name: 'code' }, 'out0'); state = r.state;
  const snaps = snapshotsForOutput(state, OUTPUT_DEFAULT);
  assert.equal(snaps.length, 3);
  for (const s of snaps) assert.equal(s.urgent, false);
});
