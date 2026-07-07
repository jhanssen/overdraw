// In-thread bundled plugin transport. Verifies:
//   - A bundled plugin (cfg.bundled === true) loads in-thread (no Worker).
//   - The plugin's init receives the config (cfg.raw) as its second arg.
//   - Namespace registration works; the runtime can invokeNamespace it.
//   - Init failure leaves the plugin in 'failed' state, no respawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { withRuntime, fixture } from './plugin-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname;

// Build a ResolvedPlugin for an in-thread bundled plugin from a fixture
// filename. Sets bundled: true so the runtime picks the in-thread transport.
function bundledEntry(file, raw = undefined) {
  return {
    module: fixture(file),
    name: file.replace(/\.mjs$/, ''),
    restart: 'never',
    maxRestarts: 3,
    windowSeconds: 60,
    bundled: true,
    raw: raw ?? null,
  };
}

test('in-thread: bundled plugin loads, registers namespace, invocation works', async () => {
  await withRuntime({}, async (rt) => {
    const config = { policy: 'follow-pointer', focusOnMap: true };
    await rt.load([bundledEntry('inthread-config.mjs', config)]);
    await rt.waitForNamespace('test-config');

    // The plugin's getConfig() should return exactly the raw config we passed.
    const got = await rt.invokeNamespace('test-config', 'getConfig', []);
    assert.deepEqual(got, config);

    const name = await rt.invokeNamespace('test-config', 'getName', []);
    assert.equal(name, 'inthread-config');

    // States: the plugin is live, restartCount 0 (no restart machinery for
    // in-thread).
    const states = rt.states();
    assert.equal(states.length, 1);
    assert.equal(states[0].name, 'inthread-config');
    assert.equal(states[0].state, 'live');
    assert.equal(states[0].restarts, 0);
  });
});

test('in-thread: bundled plugin with no config (undefined) gets null in init', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([bundledEntry('inthread-config.mjs')]);
    await rt.waitForNamespace('test-config');
    const got = await rt.invokeNamespace('test-config', 'getConfig', []);
    assert.equal(got, null);
  });
});

test('in-thread: init throw -> plugin enters failed state, no respawn', async () => {
  const logs = [];
  await withRuntime({ log: (m) => logs.push(m) }, async (rt) => {
    // load() awaits ready() which resolves on either live or failed; an
    // init-failed in-thread plugin settles ready immediately to 'failed'.
    await rt.load([bundledEntry('inthread-throw.mjs')]);

    const states = rt.states();
    assert.equal(states.length, 1);
    assert.equal(states[0].state, 'failed');

    // The init failure log line should mention the error.
    const hit = logs.find((l) => l.includes('inthread-throw') && l.includes('init failed'));
    assert.ok(hit, `expected init-failed log; got: ${logs.join('\n')}`);

    // The namespace must NOT be registered (init never reached registerPlugin).
    await assert.rejects(
      rt.invokeNamespace('test-config', 'getConfig', []),
      /no active plugin/,
    );
  });
});

test('in-thread: init that never settles -> spawn watchdog marks failed', async () => {
  await withRuntime({ initTimeoutMs: 300 }, async (rt) => {
    const t0 = Date.now();
    // Without the spawn-phase watchdog this load() never resolves (the
    // hung init can't be terminated -- it shares the main thread).
    await rt.load([bundledEntry('init-hang.mjs')]);
    const dt = Date.now() - t0;
    assert.equal(rt.states()[0].state, 'failed');
    assert.ok(dt >= 250, `settled too early (${dt}ms)`);
  });
});

test('in-thread: graceful stop releases everything', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([bundledEntry('inthread-config.mjs', { x: 1 })]);
    await rt.waitForNamespace('test-config');
    // rt.stop() runs in withRuntime's finally. Just verify it completes.
    // The assert is implicit: if stop hangs, the test runner times out.
  });
});
