// Integration test: focus driver + real runtime + bundled focus plugin,
// exercising the end-to-end Phase 3 pipeline. The driver fires decide()
// via runtime.invokeNamespace, the bundled in-thread plugin computes the
// result, and the driver applies it via the test's FocusApplyTarget.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFocusDriver } from '../../packages/core/dist/protocols/focus-driver.js';
import { bundledToResolved, BUNDLED_PLUGINS } from '../../packages/core/dist/plugins/bundled.js';
import { withRuntime } from '../plugin-helpers.mjs';

const focusSpec = BUNDLED_PLUGINS.find((p) => p.name === 'focus-default');
if (!focusSpec) throw new Error('test setup: focus-default not in BUNDLED_PLUGINS');

// Build a tiny ResolvedConfig harness so bundledToResolved picks up our
// focus config via spec.configFrom.
function loadedConfig(focus) {
  return { output: null, focus, plugins: [], sourcePath: null };
}

// Drive the focus driver through one dispatch and await both the driver's
// settled() AND the apply (the result, when applied, ends up in `applied`
// via the test target).
async function dispatchAndSettle(driver, settledWaiter, args) {
  driver.dispatch(args);
  await settledWaiter();
}

test('end-to-end: bundled focus plugin (follow-pointer) responds to coarse events', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([bundledToResolved(focusSpec, focusSpec.module,
      loadedConfig({ policy: 'follow-pointer', focusOnMap: true }))]);
    await rt.waitForNamespace('focus');

    const applied = [];
    const driver = createFocusDriver({
      target: { applyKeyboardFocus: (id) => applied.push(id) },
      decide: (inputs) => rt.invokeNamespace('focus', 'decide', [inputs]),
    });

    // pointer-enter -> focus that surface
    await dispatchAndSettle(driver, () => driver.settled(), {
      reason: 'pointer-enter',
      pointer: { x: 100, y: 100, surfaceUnderPointer: 42 },
      currentKeyboardFocus: null,
      trigger: 42,
    });
    assert.deepEqual(applied, [42]);

    // pointer-leave -> clear
    applied.length = 0;
    await dispatchAndSettle(driver, () => driver.settled(), {
      reason: 'pointer-leave',
      pointer: { x: 0, y: 0, surfaceUnderPointer: null },
      currentKeyboardFocus: 42,
    });
    assert.deepEqual(applied, [null]);

    // pointer-button under follow-pointer -> no change (so no apply)
    applied.length = 0;
    await dispatchAndSettle(driver, () => driver.settled(), {
      reason: 'pointer-button',
      pointer: { x: 100, y: 100, surfaceUnderPointer: 99 },
      currentKeyboardFocus: null,
      trigger: 99,
    });
    assert.deepEqual(applied, []);

    // window-mapped (focusOnMap=true) -> focus the new window
    applied.length = 0;
    await dispatchAndSettle(driver, () => driver.settled(), {
      reason: 'window-mapped',
      pointer: { x: 0, y: 0, surfaceUnderPointer: null },
      currentKeyboardFocus: null,
      trigger: 7,
    });
    assert.deepEqual(applied, [7]);
  });
});

test('end-to-end: bundled focus plugin (click-to-focus) requires a click', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([bundledToResolved(focusSpec, focusSpec.module,
      loadedConfig({ policy: 'click-to-focus', focusOnMap: true }))]);
    await rt.waitForNamespace('focus');

    const applied = [];
    const driver = createFocusDriver({
      target: { applyKeyboardFocus: (id) => applied.push(id) },
      decide: (inputs) => rt.invokeNamespace('focus', 'decide', [inputs]),
    });

    // pointer-enter under click-to-focus -> no change
    await dispatchAndSettle(driver, () => driver.settled(), {
      reason: 'pointer-enter',
      pointer: { x: 100, y: 100, surfaceUnderPointer: 42 },
      currentKeyboardFocus: null,
      trigger: 42,
    });
    assert.deepEqual(applied, []);

    // pointer-button -> focus changes
    await dispatchAndSettle(driver, () => driver.settled(), {
      reason: 'pointer-button',
      pointer: { x: 100, y: 100, surfaceUnderPointer: 42 },
      currentKeyboardFocus: null,
      trigger: 42,
    });
    assert.deepEqual(applied, [42]);
  });
});

test('end-to-end: bundled focus plugin rejects bad config (init throws)', async () => {
  const logs = [];
  await withRuntime({ log: (m) => logs.push(m) }, async (rt) => {
    await rt.load([bundledToResolved(focusSpec, focusSpec.module,
      loadedConfig({ policy: 'nope' }))]);
    // Plugin should be in 'failed' state; namespace not registered.
    const states = rt.states();
    assert.equal(states[0].state, 'failed');
    // The validateConfig error should surface in the log line.
    assert.ok(logs.some((l) => l.includes('init failed') && l.includes('focus.policy')),
      `expected focus.policy error in logs; got: ${logs.join('\n')}`);
  });
});

test('focus driver: stale results are discarded', async () => {
  // Use a controlled decide() that delays so we can fire two dispatches in
  // quick succession and verify only the later one applies.
  let resolveFirst;
  let resolveSecond;
  const firstP = new Promise((r) => { resolveFirst = r; });
  const secondP = new Promise((r) => { resolveSecond = r; });
  let call = 0;
  const decide = (inputs) => {
    call++;
    const which = call;
    return call === 1
      ? firstP.then(() => ({ keyboardFocus: 100 }))
      : secondP.then(() => ({ keyboardFocus: 200 }));
  };
  const applied = [];
  const driver = createFocusDriver({
    target: { applyKeyboardFocus: (id) => applied.push(id) },
    decide,
  });

  // Fire two dispatches. The second supersedes the first.
  driver.dispatch({
    reason: 'pointer-enter',
    pointer: { x: 0, y: 0, surfaceUnderPointer: 100 },
    currentKeyboardFocus: null, trigger: 100,
  });
  driver.dispatch({
    reason: 'pointer-enter',
    pointer: { x: 0, y: 0, surfaceUnderPointer: 200 },
    currentKeyboardFocus: null, trigger: 200,
  });

  // Resolve the FIRST after the second is in flight. It should be discarded.
  resolveFirst();
  // Then resolve the second; it should apply.
  resolveSecond();

  await driver.settled();
  assert.deepEqual(applied, [200]);
});

test('focus driver: decide() rejection is logged + apply does not fire', async () => {
  const logs = [];
  const applied = [];
  const driver = createFocusDriver({
    target: { applyKeyboardFocus: (id) => applied.push(id) },
    decide: () => Promise.reject(new Error('boom')),
    log: (m) => logs.push(m),
  });
  driver.dispatch({
    reason: 'pointer-enter',
    pointer: { x: 0, y: 0, surfaceUnderPointer: 1 },
    currentKeyboardFocus: null, trigger: 1,
  });
  await driver.settled();
  assert.deepEqual(applied, []);
  assert.ok(logs.some((l) => l.includes('decide(pointer-enter) failed: boom')),
    `expected boom log; got: ${logs.join('\n')}`);
});
