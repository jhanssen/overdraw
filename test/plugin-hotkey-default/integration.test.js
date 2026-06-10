// End-to-end: bundled hotkey plugin loaded into a real PluginRuntime,
// driving a real BindingChain. Asserts the SDK round-trip from config
// -> sdk.input.bind -> chain dispatch -> binding-fired -> action invoke.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../../packages/core/dist/events/window-bus.js';
import { createWm } from '../../packages/core/dist/wm/index.js';
import { BindingChain } from '../../packages/core/dist/input/binding-chain.js';
import { createInputBroker, NOT_HANDLED as INPUT_NOT_HANDLED }
  from '../../packages/core/dist/plugins/input-broker.js';
import { createWindowsBroker, NOT_HANDLED as WINDOWS_NOT_HANDLED }
  from '../../packages/core/dist/plugins/windows-broker.js';
import {
  bundledToResolved, BUNDLED_PLUGINS,
} from '../../packages/core/dist/plugins/bundled.js';
import { parseSpec } from '../../packages/core/dist/input/keyspec.js';
import { withRuntime } from '../plugin-helpers.mjs';

const hotkeySpec = BUNDLED_PLUGINS.find((p) => p.name === 'hotkey-default');
if (!hotkeySpec) throw new Error('test setup: hotkey-default not in BUNDLED_PLUGINS');
const coreActionsSpec = BUNDLED_PLUGINS.find((p) => p.name === 'core-actions');
if (!coreActionsSpec) throw new Error('test setup: core-actions not in BUNDLED_PLUGINS');

function mockSink() {
  return {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack() {},
  };
}

// Build a hotkey-aware runtime: real PluginRuntime, real BindingChain,
// input broker routing, optional core-actions plugin.
// opts:
//   log: capture runtime log lines (default: into the events array).
//   expectFailure: skip the waitForNamespace step (the plugin is expected
//     to enter the failed state from a malformed config).
async function withHotkeyPlugin(hotkeysConfig, fn, opts = {}) {
  const events = [];
  const pluginBus = new DynamicBus();
  const bus = createCompositorBus();
  const sink = mockSink();
  const wm = createWm(sink, { width: 800, height: 600 });
  const chain = new BindingChain();
  const state = {
    bus, wm, surfaces: new Map(), compositor: sink,
    seat: null, bindingChain: chain,
  };
  const windowsBroker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });
  // The input broker emits binding-fired back to the originating plugin via
  // runtime.emit -- assigned by withRuntime below.
  let rt = null;
  const inputBroker = createInputBroker({
    state,
    emitToPlugin: (plugin, name, data) => { rt?.emit(plugin, name, data); },
  });

  // Capture all input.* events emitted on the plugin bus (mode/chord).
  const inputEvents = [];
  pluginBus.subscribe('input.*', (name, payload) => {
    inputEvents.push({ name, payload });
  });
  // Re-publish chain events to pluginBus -- normally done by installProtocols.
  chain.setListener((ev) => {
    switch (ev.kind) {
      case 'mode-pushed':
        pluginBus.emit('input.mode-pushed', { name: ev.name, stack: ev.stack });
        break;
      case 'mode-popped':
        pluginBus.emit('input.mode-popped', { name: ev.name, stack: ev.stack });
        break;
      case 'chord-entered':
        pluginBus.emit('input.chord-entered', { mode: ev.mode, path: ev.path });
        break;
      case 'chord-cancelled':
        pluginBus.emit('input.chord-cancelled', { mode: ev.mode, path: ev.path });
        break;
      case 'chord-matched':
        pluginBus.emit('input.chord-matched', { mode: ev.mode, path: ev.path });
        break;
    }
  });

  await withRuntime({
    bus: pluginBus,
    log: opts.log ?? ((m) => events.push({ p: '<runtime>', n: 'log', d: m })),
    onEvent: (p, n, d) => events.push({ p, n, d }),
    onRequest: (plugin, method, params) => {
      if (method.startsWith('windows.')) {
        const r = windowsBroker(plugin, method, params);
        if (r === WINDOWS_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      if (method.startsWith('input.')) {
        const r = inputBroker(plugin, method, params);
        if (r === INPUT_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      throw new Error(`no handler for '${method}'`);
    },
  }, async (runtime) => {
    rt = runtime;
    // Load core-actions first so compositor.quit is available, then
    // hotkey-default with the test's config.
    const resolved = [
      bundledToResolved(coreActionsSpec, coreActionsSpec.module,
        { output: null, focus: null, hotkeys: undefined, plugins: [], sourcePath: null }),
      bundledToResolved(hotkeySpec, hotkeySpec.module,
        { output: null, focus: null, hotkeys: hotkeysConfig, plugins: [], sourcePath: null }),
    ];
    await runtime.load(resolved);
    // Tests expecting init failure skip waitForNamespace via expectFailure.
    if (!opts.expectFailure) await runtime.waitForNamespace('hotkey');
    // Allow event subscriptions + bindings to settle through the in-thread
    // microtask hops before the test starts dispatching.
    await runtime.flush();
    await fn({ runtime, chain, pluginBus, events, inputEvents });
  });
}

// Dispatch a key through the chain (post-xkb-resolved -- the test
// synthesizes the KeyStep directly).
function dispatch(chain, spec) {
  return chain.dispatch(parseSpec(spec));
}

// ---- Empty / minimal config ----------------------------------------------

test('init: empty config is allowed (plugin registers but binds nothing)', async () => {
  await withHotkeyPlugin(undefined, async ({ runtime }) => {
    const states = runtime.states();
    const hk = states.find((s) => s.name === 'hotkey-default');
    assert.equal(hk?.state, 'live');
  });
});

// ---- Single-step binding -> action --------------------------------------

test('single-step binding fires its action when the key is pressed', async () => {
  const events = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+a', action: 'compositor.quit' },
        ],
      },
    },
    async ({ chain, pluginBus, runtime }) => {
      // Subscribe to the shutdown emit so we can observe whether the
      // action actually fired (compositor.quit emits compositor.shutdown).
      pluginBus.subscribe('compositor.shutdown', (n, p) => events.push({ n, p }));
      const r = dispatch(chain, 'Mod+a');
      assert.equal(r.consume, true);
      assert.equal(r.matched, true);
      await runtime.flush();
      assert.equal(events.length, 1);
      assert.equal(events[0].n, 'compositor.shutdown');
    },
  );
});

// ---- Unrecognized key not consumed ---------------------------------------

test('unbound key is not consumed', async () => {
  await withHotkeyPlugin(
    {
      modes: {
        default: [{ keys: 'Mod+a', action: 'compositor.quit' }],
      },
    },
    async ({ chain }) => {
      const r = dispatch(chain, 'Mod+b');
      assert.equal(r.consume, false);
    },
  );
});

// ---- Chord ---------------------------------------------------------------

test('two-step chord enters prefix then fires action', async () => {
  const events = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: ['Mod+a', 'Mod+b'], action: 'compositor.quit' },
        ],
      },
    },
    async ({ chain, pluginBus, runtime, inputEvents }) => {
      pluginBus.subscribe('compositor.shutdown', () => events.push('fired'));
      const r1 = dispatch(chain, 'Mod+a');
      assert.equal(r1.consume, true);
      assert.equal(r1.matched, false);
      assert.ok(inputEvents.some((e) => e.name === 'input.chord-entered'));

      const r2 = dispatch(chain, 'Mod+b');
      assert.equal(r2.consume, true);
      assert.equal(r2.matched, true);
      await runtime.flush();
      assert.equal(events.length, 1);
      assert.ok(inputEvents.some((e) => e.name === 'input.chord-matched'));
    },
  );
});

// ---- Mode push / pop -----------------------------------------------------

test('pushMode + popMode shift the active mode', async () => {
  await withHotkeyPlugin(
    {
      modes: {
        default: [{ keys: 'Mod+r', pushMode: 'resize' }],
        resize: [{ keys: 'Return', popMode: true }],
      },
    },
    async ({ chain, runtime, pluginBus, inputEvents }) => {
      pluginBus.subscribe('input.mode-pushed', () => {});

      // Enter resize.
      const r1 = dispatch(chain, 'Mod+r');
      assert.equal(r1.consume, true);
      await runtime.flush();
      assert.ok(inputEvents.some((e) => e.name === 'input.mode-pushed' && e.payload.name === 'resize'));
      assert.deepEqual(chain.stackNames(), ['default', 'resize']);

      // Pop via the configured Return binding.
      const r2 = dispatch(chain, 'Return');
      assert.equal(r2.consume, true);
      await runtime.flush();
      assert.ok(inputEvents.some((e) => e.name === 'input.mode-popped' && e.payload.name === 'resize'));
      assert.deepEqual(chain.stackNames(), ['default']);
    },
  );
});

test('Escape exits a sub-mode by default (binding-chain feature, no binding needed)', async () => {
  await withHotkeyPlugin(
    {
      modes: {
        default: [{ keys: 'Mod+r', pushMode: 'resize' }],
        resize: [],
      },
    },
    async ({ chain, runtime }) => {
      dispatch(chain, 'Mod+r');
      await runtime.flush();
      assert.deepEqual(chain.stackNames(), ['default', 'resize']);

      const r = dispatch(chain, 'Escape');
      assert.equal(r.consume, true);
      assert.deepEqual(chain.stackNames(), ['default']);
    },
  );
});

test('exitOnEscape: false prevents Escape from popping', async () => {
  await withHotkeyPlugin(
    {
      modes: {
        default: [{ keys: 'Mod+r', pushMode: 'modal' }],
        modal: { bindings: [], exitOnEscape: false },
      },
    },
    async ({ chain, runtime }) => {
      dispatch(chain, 'Mod+r');
      await runtime.flush();
      assert.deepEqual(chain.stackNames(), ['default', 'modal']);
      const r = dispatch(chain, 'Escape');
      assert.equal(r.consume, false);    // unbound + no exit -> forward
      assert.deepEqual(chain.stackNames(), ['default', 'modal']);
    },
  );
});

// ---- Config validation ---------------------------------------------------

test('config missing default mode rejects (plugin enters failed state)', async () => {
  const logs = [];
  await withHotkeyPlugin(
    { modes: { resize: [] } }, // no default
    async ({ runtime }) => {
      const states = runtime.states();
      const hk = states.find((s) => s.name === 'hotkey-default');
      assert.equal(hk?.state, 'failed');
      assert.ok(logs.some((l) => l.includes("'default'")),
        `expected 'default' missing in logs; got ${logs.join('\n')}`);
    },
    { log: (m) => logs.push(m), expectFailure: true },
  );
});

test('binding with two outcomes is rejected', async () => {
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+a', action: 'compositor.quit', pushMode: 'resize' },
        ],
        resize: [],
      },
    },
    async ({ runtime }) => {
      const states = runtime.states();
      const hk = states.find((s) => s.name === 'hotkey-default');
      assert.equal(hk?.state, 'failed');
    },
    { expectFailure: true },
  );
});

test('binding with no outcome is rejected', async () => {
  await withHotkeyPlugin(
    {
      modes: {
        default: [{ keys: 'Mod+a' }],
      },
    },
    async ({ runtime }) => {
      const states = runtime.states();
      const hk = states.find((s) => s.name === 'hotkey-default');
      assert.equal(hk?.state, 'failed');
    },
    { expectFailure: true },
  );
});

test('unknown key spec is rejected at bind time', async () => {
  await withHotkeyPlugin(
    {
      modes: {
        default: [{ keys: 'Mod+notakey', action: 'compositor.quit' }],
      },
    },
    async ({ runtime }) => {
      const states = runtime.states();
      const hk = states.find((s) => s.name === 'hotkey-default');
      assert.equal(hk?.state, 'failed');
    },
    { expectFailure: true },
  );
});

// ---- Modifier mismatch (NumLock should be ignored) ------------------------

test('NumLock-with-binding still matches', async () => {
  const events = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [{ keys: 'Mod+1', action: 'compositor.quit' }],
      },
    },
    async ({ chain, pluginBus, runtime }) => {
      pluginBus.subscribe('compositor.shutdown', () => events.push('fired'));
      // Mod+1 with NumLock (Mod2 = 0x10) on top.
      const step = parseSpec('Mod+1');
      const r = chain.dispatch({ mods: step.mods | 0x10, keysym: step.keysym });
      assert.equal(r.consume, true);
      await runtime.flush();
      assert.equal(events.length, 1);
    },
  );
});
