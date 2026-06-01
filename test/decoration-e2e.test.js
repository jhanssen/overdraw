// End-to-end (GPU-free, real Worker): a decoration-provider plugin registers an
// app_id pattern; a window.map on the bus matches it; the plugin receives the
// decoration.assigned event. Covers the full wire-through: worker register ->
// decoration broker -> registry; bus map -> registry match -> runtime.emit ->
// worker event dispatch -> sdk.decorations.onAssigned.
//
// No compositor/GPU: the bus is driven directly (a real client mapping is covered
// by the window-change e2e GPU test; here we isolate the decoration plumbing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { TypedBus } from '../dist/events/bus.js';
import { WINDOW_EVENT } from '../dist/events/types.js';
import { PluginRuntime } from '../dist/plugins/index.js';
import { createDecorationBroker } from '../dist/plugins/decoration-broker.js';
import { createWm } from '../dist/wm/index.js';

// Mock compositor sink: the WM pushes layout/stack here; we ignore it.
const mockSink = () => ({ setSurfaceLayout() {}, setStack() {} });

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (f) => pathToFileURL(join(__dirname, 'fixtures', 'plugins', f)).href;
const FAST = { pingIntervalMs: 50, maxMissedPongs: 3, shutdownTimeoutMs: 300, heapMb: 32 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForLog(logs, pred, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    if (logs.some(pred)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForLog timed out; logs:\n${logs.join('\n')}`);
    await sleep(15);
  }
}

test('decoration provider registers and is assigned a matching window', async () => {
  const bus = new TypedBus();
  // Minimal compositor state with a real WM (for requestInsets). The window is
  // mapped into the WM directly (no real client in this GPU-free e2e).
  const wm = createWm(mockSink(), { width: 1280, height: 720 });
  const state = { wm };
  let runtime = null;
  const broker = createDecorationBroker({
    bus,
    state,
    emitToPlugin: (plugin, name, data) => { runtime?.emit(plugin, name, data); },
  });

  const logs = [];
  runtime = new PluginRuntime({
    ...FAST, log: () => {},
    onEvent: (_p, name, data) => { if (name === 'log') logs.push(String(data)); },
    onRequest: (plugin, method, params) =>
      method.startsWith('decoration.') ? broker.onRequest(plugin, method, params) : undefined,
  });

  try {
    await runtime.load([{
      module: fixture('decoration-provider.mjs'),
      name: 'deco', restart: 'never', maxRestarts: 0, windowSeconds: 60, raw: {},
    }]);
    await waitForLog(logs, (l) => l === 'registered');

    // A matching window maps. Map it into the WM too (so requestInsets can find
    // it), then emit the bus event with the WM's rect. The registry assigns it and
    // the runtime forwards decoration.assigned to the plugin.
    const rect = wm.mapWindow(5, { resource: { __id: 5 } }, 200, 100);
    bus.emit(WINDOW_EVENT.map, { surfaceId: 5, appId: 'org.test.deco', title: 'Hi', rect });
    await waitForLog(logs, (l) => l.startsWith('ASSIGNED '));

    const ev = JSON.parse(logs.find((l) => l.startsWith('ASSIGNED ')).slice('ASSIGNED '.length));
    assert.deepEqual(ev, { surfaceId: 5, appId: 'org.test.deco', title: 'Hi', rect });
    assert.equal(broker.registry.assignmentOf(5), 'deco');

    // The plugin requests insets on assignment; assert the granted geometry it
    // logged (additive: outer = content grown by the titlebar inset).
    await waitForLog(logs, (l) => l.startsWith('INSETS '));
    const grant = JSON.parse(logs.find((l) => l.startsWith('INSETS ')).slice('INSETS '.length));
    assert.deepEqual(grant.insets, { top: 24, right: 0, bottom: 0, left: 0 });
    assert.deepEqual(grant.contentRect, rect);
    assert.deepEqual(grant.outerRect,
      { x: rect.x, y: rect.y - 24, width: rect.width, height: rect.height + 24 });

    // A non-matching window is not assigned (no further ASSIGNED log).
    bus.emit(WINDOW_EVENT.map, { surfaceId: 6, appId: 'other', title: null, rect });
    await sleep(100);
    assert.equal(logs.filter((l) => l.startsWith('ASSIGNED ')).length, 1);
  } finally {
    await runtime.stop();
  }
});
