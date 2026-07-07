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

test('output.switch-mode emits a request with output + dims + refresh', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  const switchMode = handlers.get('output.switch-mode');
  assert.ok(switchMode, 'output.switch-mode action registered');
  await switchMode({ output: 'DP-1', width: 2560, height: 1440, refreshMhz: 60000 });
  assert.deepEqual(emitted.at(-1), ['output.switch-mode-requested',
    { output: 'DP-1', width: 2560, height: 1440, refreshMhz: 60000 }]);
});

test('output.switch-mode allows refreshMhz omitted (carries 0 -> any rate at dims)', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  await handlers.get('output.switch-mode')({
    output: 'ACM-1234-CAFEBABE', width: 1920, height: 1080,
  });
  assert.deepEqual(emitted.at(-1), ['output.switch-mode-requested',
    { output: 'ACM-1234-CAFEBABE', width: 1920, height: 1080, refreshMhz: 0 }]);
});

test('output.switch-mode rejects missing / invalid params', async () => {
  const { sdk, handlers } = makeSdk();
  await init(sdk);
  const switchMode = handlers.get('output.switch-mode');
  await assert.rejects(() => switchMode({}), /output must be a non-empty string/);
  await assert.rejects(() => switchMode({ output: '' }), /output must be a non-empty string/);
  await assert.rejects(() => switchMode({ output: 'DP-1' }), /width must be a positive integer/);
  await assert.rejects(() => switchMode({ output: 'DP-1', width: 0 }), /width/);
  await assert.rejects(() => switchMode({ output: 'DP-1', width: 1.5, height: 1080 }), /width/);
  await assert.rejects(() => switchMode({ output: 'DP-1', width: 1920 }), /height/);
  await assert.rejects(() => switchMode({ output: 'DP-1', width: 1920, height: 1080, refreshMhz: -1 }),
    /refreshMhz/);
  await assert.rejects(() => switchMode({ output: 'DP-1', width: 1920, height: 1080, refreshMhz: 1.5 }),
    /refreshMhz/);
});

test('xwayland.restart emits xwayland.restart-requested', async () => {
  const { sdk, handlers, emitted } = makeSdk();
  await init(sdk);
  const restart = handlers.get('xwayland.restart');
  assert.ok(restart, 'xwayland.restart action registered');
  const result = await restart();
  assert.equal(result, null);
  assert.deepEqual(emitted.at(-1), ['xwayland.restart-requested', {}]);
});
