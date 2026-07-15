// Dynamic-workspace lifetime: a non-persistent workspace evaporates
// (auto-destroys) once it is empty AND not the shown workspace on its
// output. Pure registry tests; the create-on-reference plugin behavior
// that produces these workspaces is covered by the plugin integration
// suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  init, create, show, moveWindow, applyMap, applyUnmap,
  snapshotsForOutput, snapshotOf, OUTPUT_DEFAULT,
} from '../../packages/plugin-workspace-default/dist/registry.js';

const emitsOf = (effects, name) =>
  effects.filter((e) => e.kind === 'emit' && e.name === name);

// state with ws1 (boot, shown, anchored by window 100 so it does not
// itself evaporate when the tests navigate away) + ws2 (created).
// Returns [state, h1, h2].
function twoWorkspaces(spec = {}) {
  let state = init('test').state;
  const h1 = snapshotsForOutput(state, OUTPUT_DEFAULT)[0].handle;
  state = applyMap(state, 100, OUTPUT_DEFAULT, 'test').state;
  const r = create(state, spec, 'test');
  return [r.state, h1, r.snapshot.handle];
}

test('snapshot carries persistent; default false, create({persistent:true}) sets it', () => {
  let state = init('test').state;
  assert.equal(snapshotsForOutput(state, OUTPUT_DEFAULT)[0].persistent, false);
  const r = create(state, { persistent: true }, 'test');
  assert.equal(r.snapshot.persistent, true);
});

test('unmap of the last window on a HIDDEN workspace evaporates it', () => {
  let [state, h1, h2] = twoWorkspaces();
  // Put a window on ws2 (shown), then go back to ws1 so ws2 is hidden.
  state = show(state, 2, OUTPUT_DEFAULT, 'test').state;
  state = applyMap(state, 101, OUTPUT_DEFAULT, 'test').state;
  state = show(state, 1, OUTPUT_DEFAULT, 'test').state;
  assert.equal(snapshotsForOutput(state, OUTPUT_DEFAULT).length, 2);

  const r = applyUnmap(state, 101);
  state = r.state;
  assert.equal(emitsOf(r.sideEffects, 'workspace.destroyed').length, 1);
  assert.equal(emitsOf(r.sideEffects, 'workspace.destroyed')[0].payload.handle, h2);
  assert.equal(snapshotsForOutput(state, OUTPUT_DEFAULT).length, 1);
  assert.equal(state.byHandle.has(h2), false);
});

test('unmap of the last window on the SHOWN workspace keeps it; navigating away reaps it', () => {
  let [state, h1, h2] = twoWorkspaces();
  state = show(state, 2, OUTPUT_DEFAULT, 'test').state;
  state = applyMap(state, 101, OUTPUT_DEFAULT, 'test').state;

  // ws2 is shown: emptying it must not destroy it out from under the user.
  const un = applyUnmap(state, 101);
  state = un.state;
  assert.equal(emitsOf(un.sideEffects, 'workspace.destroyed').length, 0);
  assert.equal(snapshotsForOutput(state, OUTPUT_DEFAULT).length, 2);

  // Leaving it is the moment it evaporates.
  const sh = show(state, 1, OUTPUT_DEFAULT, 'test');
  state = sh.state;
  assert.equal(emitsOf(sh.sideEffects, 'workspace.destroyed').length, 1);
  assert.equal(emitsOf(sh.sideEffects, 'workspace.destroyed')[0].payload.handle, h2);
  assert.equal(snapshotsForOutput(state, OUTPUT_DEFAULT).length, 1);
});

test('show effects order: hidden/shown precede the evaporation destroy', () => {
  let [state, , h2] = twoWorkspaces();
  state = show(state, 2, OUTPUT_DEFAULT, 'test').state;
  const sh = show(state, 1, OUTPUT_DEFAULT, 'test');
  const names = sh.sideEffects
    .filter((e) => e.kind === 'emit').map((e) => e.name);
  const hiddenAt = names.indexOf('workspace.hidden');
  const destroyedAt = names.indexOf('workspace.destroyed');
  assert.ok(hiddenAt >= 0 && destroyedAt > hiddenAt,
    `expected hidden before destroyed, got ${names.join(', ')}`);
});

test('moving the last window off a hidden workspace evaporates it', () => {
  let [state, h1, h2] = twoWorkspaces();
  state = show(state, 2, OUTPUT_DEFAULT, 'test').state;
  state = applyMap(state, 101, OUTPUT_DEFAULT, 'test').state;
  state = show(state, 1, OUTPUT_DEFAULT, 'test').state;

  const mv = moveWindow(state, 101, 1, OUTPUT_DEFAULT, 'test');
  state = mv.state;
  assert.equal(emitsOf(mv.sideEffects, 'workspace.destroyed').length, 1);
  assert.equal(state.byHandle.has(h2), false);
  assert.deepEqual(snapshotOf(state, h1).members, [100, 101]);
});

test('persistent workspace survives becoming empty and hidden', () => {
  let [state, , h2] = twoWorkspaces({ persistent: true });
  state = show(state, 2, OUTPUT_DEFAULT, 'test').state;
  state = applyMap(state, 101, OUTPUT_DEFAULT, 'test').state;
  state = applyUnmap(state, 101).state;
  const sh = show(state, 1, OUTPUT_DEFAULT, 'test');
  state = sh.state;
  assert.equal(emitsOf(sh.sideEffects, 'workspace.destroyed').length, 0);
  assert.equal(state.byHandle.has(h2), true);
  assert.equal(snapshotsForOutput(state, OUTPUT_DEFAULT).length, 2);
});

test('a workspace with remaining members never evaporates', () => {
  let [state] = twoWorkspaces();
  state = show(state, 2, OUTPUT_DEFAULT, 'test').state;
  state = applyMap(state, 101, OUTPUT_DEFAULT, 'test').state;
  state = applyMap(state, 102, OUTPUT_DEFAULT, 'test').state;
  state = show(state, 1, OUTPUT_DEFAULT, 'test').state;
  const r = applyUnmap(state, 101);   // 102 remains
  assert.equal(emitsOf(r.sideEffects, 'workspace.destroyed').length, 0);
  assert.equal(snapshotsForOutput(r.state, OUTPUT_DEFAULT).length, 2);
});

test("an output's only workspace never evaporates (it is shown by construction)", () => {
  let state = init('test').state;
  state = applyMap(state, 101, OUTPUT_DEFAULT, 'test').state;
  const r = applyUnmap(state, 101);
  assert.equal(emitsOf(r.sideEffects, 'workspace.destroyed').length, 0);
  assert.equal(snapshotsForOutput(r.state, OUTPUT_DEFAULT).length, 1);
});

test('evaporation renumbers the workspaces to its right', () => {
  // ws1 shown (anchored), ws2 (will evaporate), ws3. Reap of ws2
  // renumbers ws3 -> 2.
  let state = init('test').state;
  state = applyMap(state, 100, OUTPUT_DEFAULT, 'test').state;
  state = create(state, {}, 'test').state;
  const c3 = create(state, {}, 'test');
  state = c3.state;
  state = show(state, 2, OUTPUT_DEFAULT, 'test').state;
  const sh = show(state, 1, OUTPUT_DEFAULT, 'test');
  state = sh.state;
  const renum = emitsOf(sh.sideEffects, 'workspace.renumbered');
  assert.equal(renum.length, 1);
  assert.deepEqual(renum[0].payload.changes,
    [{ handle: c3.snapshot.handle, oldIndex: 3, newIndex: 2 }]);
});
