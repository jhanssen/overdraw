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
