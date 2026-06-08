// Shared helpers for end-to-end plugin runtime tests (sdk-*.test.js).
// Centralizes the boilerplate that was repeated across files (the runtime
// constructor, the entry factory, the fixture-path resolver, waitFor) AND
// provides withRuntime: a try/finally wrapper that guarantees rt.stop()
// runs even when the test body throws.
//
// Why this matters: a worker_threads Worker that isn't terminate()'d holds
// the parent process's event loop open. A test that fails before its
// rt.stop() leaves the runtime's Workers alive -> the test runner can't
// exit -> the whole test suite hangs. withRuntime ensures cleanup on any
// path.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { PluginRuntime } from '../packages/core/dist/plugins/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures', 'plugins');

// Build a Worker-importable URL for a fixture plugin.
export const fixture = (f) => pathToFileURL(join(FIX, f)).href;

// Fast watchdog defaults for tests. Real overdraw uses longer intervals.
export const FAST = { pingIntervalMs: 50, maxMissedPongs: 2, shutdownTimeoutMs: 300, heapMb: 32 };

// Build a ResolvedPlugin entry from a fixture filename. `over` lets a test
// override any field (name, restart policy, raw, etc.).
export function entry(file, over = {}) {
  return {
    module: fixture(file),
    name: over.name ?? file.replace(/\.mjs$/, ''),
    restart: over.restart ?? 'never',
    maxRestarts: over.maxRestarts ?? 3,
    windowSeconds: over.windowSeconds ?? 60,
    bundled: over.bundled ?? false,
    raw: over.raw ?? {},
  };
}

// Poll `pred` until it returns truthy, or reject after timeoutMs.
export async function waitFor(pred, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Find the first matching log entry across the (plugin, name, data)
// observer array. Returns undefined if none match.
export function findLog(events, pluginName, prefix) {
  return events.find((e) =>
    e.p === pluginName && e.n === 'log' && String(e.d).startsWith(prefix));
}

// Run `fn` with a fresh PluginRuntime, guaranteeing rt.stop() in a finally
// block. The runtime's Workers are terminated even when `fn` throws -- which
// is the difference between a clean test failure and a hung test runner.
//
// Usage:
//   await withRuntime({ bus, ... }, async (rt) => {
//     await rt.load([entry('foo.mjs')]);
//     // ... assertions ...
//   });
export async function withRuntime(runtimeOpts, fn) {
  const rt = new PluginRuntime({ ...FAST, log: () => {}, ...runtimeOpts });
  try { return await fn(rt); }
  finally {
    // Swallow shutdown errors so they don't mask the test's actual failure.
    // The runtime's stop logic logs + carries on; we don't need to re-throw.
    try { await rt.stop(); } catch { /* ignore */ }
  }
}

// Run `fn` with a fresh PluginRuntime + IpcServer on a temp Unix socket,
// guaranteeing both server.stop() and rt.stop() in a finally block. Same
// hang-avoidance rationale as withRuntime.
//
// IpcServer is imported lazily so tests that don't need it aren't paying its
// import cost (and so tests that don't have @types/node-net etc. still load).
export async function withIpcServer(runtimeOpts, fn) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { IpcServer } = await import('../packages/core/dist/ipc/server.js');
  const { DynamicBus } = await import('../packages/core/dist/events/dynamic-bus.js');

  const events = [];
  const pluginBus = runtimeOpts.bus ?? new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: runtimeOpts.onEvent ?? ((p, n, d) => events.push({ p, n, d })),
    ...runtimeOpts,
  });
  const dir = mkdtempSync(join(tmpdir(), 'overdraw-ipc-test-'));
  const socketPath = join(dir, 'overdraw.sock');
  const server = new IpcServer({ socketPath, runtime: rt, bus: pluginBus, log: () => {} });
  await server.start();

  try {
    return await fn({ rt, server, socketPath, pluginBus, events });
  } finally {
    try { await server.stop(); } catch { /* ignore */ }
    try { await rt.stop(); } catch { /* ignore */ }
  }
}
