// Restarting the hotkey plugin (config reload, crash respawn) must land a
// working second activation. The input broker holds this plugin's binds and
// mode definitions; without the runtime's onPluginRelease wiring the old
// instance's state survives its stop -- zombie binds keep consuming chords
// with dead handlers, and the successor's defineMode throws ("mode already
// defined"), failing its activation and leaving zero live hotkeys.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withRuntime } from '../plugin-helpers.mjs';
import { createInputBroker, NOT_HANDLED as INPUT_NOT_HANDLED }
  from '../../packages/core/dist/plugins/input-broker.js';
import { BindingChain } from '../../packages/core/dist/input/binding-chain.js';
import {
  bundledToResolved, BUNDLED_PLUGINS,
} from '../../packages/core/dist/plugins/bundled.js';

const spec = BUNDLED_PLUGINS.find((p) => p.name === 'hotkey-default');

const HOTKEYS = {
  modes: {
    default: [
      { keys: 'Super+t', action: 'spawn', params: { command: 'kitty' } },
      { keys: 'Super+z', pushMode: 'resize' },
    ],
    resize: [
      { keys: 'Return', popMode: true },
      { keys: 'Left', action: 'layout.shrink-column' },
    ],
  },
};

const cfg = (hotkeys) => ({
  output: null, focus: null, hotkeys, actions: undefined,
  plugins: [], sourcePath: null,
});

test('reload: the second hotkey instance re-activates and rebinds', async () => {
  const state = { bindingChain: new BindingChain() };
  let runtime = null;
  const broker = createInputBroker({
    state,
    emitToPlugin: (p, n, d) => runtime?.emit(p, n, d),
  });
  const logs = [];
  await withRuntime({
    log: (m) => logs.push(m),
    onEvent: (p, n, d) => { if (n === 'log') logs.push(`${p}: ${String(d)}`); },
    // Mirrors main.ts: broker state keyed by plugin name dies with the plugin.
    onPluginRelease: (name) => broker.unregisterAllFor(name),
    onRequest: (plugin, method, params) => {
      if (method.startsWith('input.')) {
        const r = broker.onRequest(plugin, method, params);
        if (r === INPUT_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      throw new Error(`no handler for '${method}'`);
    },
  }, async (rt) => {
    runtime = rt;
    const entry = () => bundledToResolved(spec, spec.module, cfg(HOTKEYS));
    await rt.load([entry()]);
    assert.ok(logs.some((l) => l.includes('hotkey plugin activated')),
      `first activation (logs: ${JSON.stringify(logs)})`);

    // Two reloads back-to-back: the first exercises stop-with-live-state,
    // the second proves the first left a clean slate too.
    for (const round of [1, 2]) {
      logs.length = 0;
      await rt.reload([entry()]);
      assert.ok(logs.some((l) => l.includes('hotkey plugin activated')),
        `reload ${round} re-activated (logs: ${JSON.stringify(logs)})`);
      assert.ok(!logs.some((l) => l.includes('failed')),
        `reload ${round} clean (logs: ${JSON.stringify(logs)})`);
      assert.equal(rt.states().filter((s) => s.name === 'hotkey-default').length, 1);
      assert.equal(rt.states().find((s) => s.name === 'hotkey-default').state, 'live');
    }
  });
});
