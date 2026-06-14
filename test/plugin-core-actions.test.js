// Unit tests for the bundled core-actions plugin's `spawn` action: it emits
// `process.spawn-requested` (the launcher does the real child_process spawn)
// and validates its params.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import init from '../packages/plugin-core-actions/dist/index.js';

function makeSdk() {
  const handlers = new Map();
  const emitted = [];
  const sdk = {
    name: 'core-actions',
    log: () => {},
    actions: {
      register: ({ name, handler }) => { handlers.set(name, handler); return { unregister() {} }; },
    },
    events: { emit: (n, p) => emitted.push([n, p]) },
  };
  return { sdk, handlers, emitted };
}

test('spawn emits process.spawn-requested with command + args', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  const spawn = handlers.get('spawn');
  assert.ok(spawn, 'spawn action registered');
  await spawn({ command: 'kitty', args: ['-e', 'vim'] });
  assert.deepEqual(emitted.at(-1), ['process.spawn-requested', { command: 'kitty', args: ['-e', 'vim'] }]);
});

test('spawn with no args emits empty args array', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  await handlers.get('spawn')({ command: 'kitty' });
  assert.deepEqual(emitted.at(-1), ['process.spawn-requested', { command: 'kitty', args: [] }]);
});

test('spawn drops missing/empty/invalid command (no event)', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  const spawn = handlers.get('spawn');
  emitted.length = 0;
  await spawn({});
  await spawn({ command: '' });
  await spawn({ command: 42 });
  await spawn(null);
  assert.equal(emitted.filter((e) => e[0] === 'process.spawn-requested').length, 0);
});

test('spawn filters non-string args', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  await handlers.get('spawn')({ command: 'foo', args: ['a', 3, 'b', null] });
  assert.deepEqual(emitted.at(-1)[1], { command: 'foo', args: ['a', 'b'] });
});

test('window.close emits window.close-requested', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  const close = handlers.get('window.close');
  assert.ok(close, 'window.close action registered');
  await close();
  assert.deepEqual(emitted.at(-1), ['window.close-requested', {}]);
});

test('focus.next / focus.prev emit focus.cycle-requested with a direction', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  await handlers.get('focus.next')();
  assert.deepEqual(emitted.at(-1), ['focus.cycle-requested', { direction: 'next' }]);
  await handlers.get('focus.prev')();
  assert.deepEqual(emitted.at(-1), ['focus.cycle-requested', { direction: 'prev' }]);
});

test('layout.promote / swap-next / swap-prev emit layout.reorder-requested with an op', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  await handlers.get('layout.promote')();
  assert.deepEqual(emitted.at(-1), ['layout.reorder-requested', { op: 'promote' }]);
  await handlers.get('layout.swap-next')();
  assert.deepEqual(emitted.at(-1), ['layout.reorder-requested', { op: 'swap-next' }]);
  await handlers.get('layout.swap-prev')();
  assert.deepEqual(emitted.at(-1), ['layout.reorder-requested', { op: 'swap-prev' }]);
});

test('layout.grow-master / shrink-master emit signed master-fraction deltas', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  await handlers.get('layout.grow-master')();
  const grow = emitted.at(-1);
  assert.equal(grow[0], 'layout.master-fraction-requested');
  assert.ok(grow[1].delta > 0, 'grow delta is positive');
  await handlers.get('layout.shrink-master')();
  const shrink = emitted.at(-1);
  assert.equal(shrink[0], 'layout.master-fraction-requested');
  assert.equal(shrink[1].delta, -grow[1].delta, 'shrink delta is the negated grow delta');
});
