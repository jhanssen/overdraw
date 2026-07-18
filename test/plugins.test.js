// Plugin runtime tests (scope B): worker isolation, lifecycle, watchdog, restart
// policy. GPU-free. These spawn REAL worker_threads Workers running real fixture
// plugin modules -- the honest test of isolation/watchdog/OOM (a mocked Worker
// would not prove terminate() actually stops a hot loop or that the heap cap
// aborts an OOM). Timing tunables are shrunk so the suite runs fast.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { PluginRuntime } from '../packages/core/dist/plugins/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures', 'plugins');
const fixture = (f) => pathToFileURL(join(FIX, f)).href;

// Fast watchdog/shutdown timing for tests.
const FAST = { pingIntervalMs: 50, maxMissedPongs: 2, shutdownTimeoutMs: 300, heapMb: 32 };

// A plugin entry as the runtime expects (the loader normally produces these).
function entry(file, over = {}) {
  return {
    module: fixture(file), name: over.name ?? file.replace(/\.mjs$/, ''),
    restart: over.restart ?? 'never', maxRestarts: over.maxRestarts ?? 3,
    windowSeconds: over.windowSeconds ?? 60, raw: {},
  };
}

// Poll a runtime's states until `pred` holds or we time out.
async function waitFor(rt, pred, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const s = rt.states();
    if (pred(s)) return s;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out; states=${JSON.stringify(s)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function quietRuntime(opts = {}, events) {
  return new PluginRuntime({
    ...FAST, log: () => {},
    onEvent: events ? (p, n, d) => events.push({ p, n, d }) : undefined,
    ...opts,
  });
}

test('a well-behaved plugin reaches live', async () => {
  const rt = quietRuntime();
  await rt.load([entry('ok.mjs')]);
  assert.deepEqual(rt.states().map((s) => s.state), ['live']);
  await rt.stop();
});

test('init reject -> failed (restart="never")', async () => {
  const rt = quietRuntime();
  await rt.load([entry('init-reject.mjs', { restart: 'never' })]);
  assert.equal(rt.states()[0].state, 'failed');
  await rt.stop();
});

test('init that never settles -> spawn watchdog terminates -> failed (restart="never")', async () => {
  const rt = quietRuntime({ initTimeoutMs: 300 });
  const t0 = Date.now();
  // Without the spawn-phase watchdog this load() never resolves.
  await rt.load([entry('init-hang.mjs', { restart: 'never' })]);
  const dt = Date.now() - t0;
  assert.equal(rt.states()[0].state, 'failed');
  assert.ok(dt >= 250, `settled too early (${dt}ms)`);
  await rt.stop();
});

test('init that never settles + on-failure restart -> budget exhausts -> failed', async () => {
  const rt = quietRuntime({ initTimeoutMs: 200 });
  await rt.load([entry('init-hang.mjs', { restart: 'on-failure', maxRestarts: 1, windowSeconds: 60 })]);
  const s = await waitFor(rt, (st) => st[0].state === 'failed', 8000);
  assert.equal(s[0].state, 'failed');
  assert.equal(s[0].restarts, 1);
  await rt.stop();
});

test('module without a default init export -> failed', async () => {
  const rt = quietRuntime();
  await rt.load([entry('no-default.mjs', { restart: 'never' })]);
  assert.equal(rt.states()[0].state, 'failed');
  await rt.stop();
});

test('graceful stop runs onShutdown', async () => {
  const events = [];
  const rt = quietRuntime({}, events);
  await rt.load([entry('ok.mjs')]);
  await rt.stop();
  // ok.mjs logs "ok plugin shutdown" from its onShutdown callback.
  const logs = events.filter((e) => e.n === 'log').map((e) => e.d);
  assert.ok(logs.some((l) => String(l).includes('shutdown')),
    `expected a shutdown log; got ${JSON.stringify(logs)}`);
});

test('graceful stop honors the shutdown timeout (callback never resolves)', async () => {
  const rt = quietRuntime();
  await rt.load([entry('slow-shutdown.mjs')]);
  const t0 = Date.now();
  await rt.stop();   // must resolve via the shutdownTimeoutMs path, not hang
  const dt = Date.now() - t0;
  assert.ok(dt >= FAST.shutdownTimeoutMs - 50, `stop returned too early (${dt}ms)`);
  assert.ok(dt < FAST.shutdownTimeoutMs + 1500, `stop took too long (${dt}ms)`);
  assert.equal(rt.states()[0].state, 'failed');
});

test('hot loop -> watchdog terminates -> restart budget exhausts -> failed', async () => {
  // A live plugin that wedges its event loop. The watchdog terminates it; with
  // restart="on-failure" it respawns, wedges again, and after maxRestarts in the
  // window it is permanently failed.
  const rt = quietRuntime();
  await rt.load([entry('hot-loop.mjs', { restart: 'on-failure', maxRestarts: 2, windowSeconds: 60 })]);
  // load() resolves on first settle (live). Wait for the terminal failed state.
  const s = await waitFor(rt, (st) => st[0].state === 'failed', 8000);
  assert.equal(s[0].state, 'failed');
  assert.equal(s[0].restarts, 2);
  await rt.stop();
});

test('OOM past heap cap -> Worker aborts -> restart then failed', async () => {
  const rt = quietRuntime();
  await rt.load([entry('oom.mjs', { restart: 'on-failure', maxRestarts: 1, windowSeconds: 60 })]);
  const s = await waitFor(rt, (st) => st[0].state === 'failed', 10000);
  assert.equal(s[0].state, 'failed');
  await rt.stop();
});

test('multiple plugins are independent (one fails, one stays live)', async () => {
  const rt = quietRuntime();
  await rt.load([entry('ok.mjs'), entry('init-reject.mjs', { name: 'bad', restart: 'never' })]);
  const states = Object.fromEntries(rt.states().map((s) => [s.name, s.state]));
  assert.equal(states['ok'], 'live');
  assert.equal(states['bad'], 'failed');
  await rt.stop();
});

test('Worker console.* routes to the host as leveled "log" events', async () => {
  const events = [];
  const rt = quietRuntime({}, events);
  await rt.load([entry('console-log.mjs')]);
  await rt.stop();

  const logs = events.filter((e) => e.n === 'log' && e.p === 'console-log');
  const structured = logs.map((e) => e.d).filter((d) => d && typeof d === 'object');
  const byText = (t) => structured.find((d) => String(d.text).startsWith(t));

  // Module-load-time console.log is captured (shim installs before import),
  // with util.format applied and info level.
  assert.deepEqual(byText('module-load'), { level: 2, text: 'module-load line 1' });
  assert.equal(byText('info line').level, 2);
  assert.equal(byText('warn line').level, 3);
  // Non-string args survive formatting; console.error maps to err.
  const err = byText('error line');
  assert.equal(err.level, 4);
  assert.match(err.text, /code.*7/);
  // sdk.log keeps its plain-string shape.
  assert.ok(logs.some((e) => e.d === 'sdk-log line'));
});
