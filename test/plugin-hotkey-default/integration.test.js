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
import { buildResolver } from '../../packages/core/dist/plugins/deferred-refs.js';
import { withRuntime } from '../plugin-helpers.mjs';

const hotkeySpec = BUNDLED_PLUGINS.find((p) => p.name === 'hotkey-default');
if (!hotkeySpec) throw new Error('test setup: hotkey-default not in BUNDLED_PLUGINS');
const coreActionsSpec = BUNDLED_PLUGINS.find((p) => p.name === 'core-actions');
if (!coreActionsSpec) throw new Error('test setup: core-actions not in BUNDLED_PLUGINS');
const configActionsSpec = BUNDLED_PLUGINS.find((p) => p.name === 'config-actions');
if (!configActionsSpec) throw new Error('test setup: config-actions not in BUNDLED_PLUGINS');

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
//   actions: OverdrawConfig.actions map (user-defined action handlers).
//     Loaded via @overdraw/plugin-config-actions.
//   resolvers: deferred-ref resolver map (e.g. focusedWindow: () => 7).
//     Wired into PluginRuntime.resolveDeferredRefs via buildResolver.
async function withHotkeyPlugin(hotkeysConfig, fn, opts = {}) {
  const events = [];
  const pluginBus = new DynamicBus();
  const bus = createCompositorBus();
  const sink = mockSink();
  const wm = createWm(sink, [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
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

  const resolveDeferredRefs = opts.resolvers
    ? buildResolver(opts.resolvers)
    : undefined;

  await withRuntime({
    bus: pluginBus,
    log: opts.log ?? ((m) => events.push({ p: '<runtime>', n: 'log', d: m })),
    onEvent: (p, n, d) => events.push({ p, n, d }),
    resolveDeferredRefs,
    onRequest: (plugin, method, params) => {
      if (method.startsWith('windows.')) {
        const r = windowsBroker(plugin, method, params);
        if (r === WINDOWS_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      if (method.startsWith('input.')) {
        const r = inputBroker.onRequest(plugin, method, params);
        if (r === INPUT_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      throw new Error(`no handler for '${method}'`);
    },
  }, async (runtime) => {
    rt = runtime;
    // Load core-actions first (registers compositor.quit), then
    // config-actions (registers user-defined actions from opts.actions),
    // then hotkey-default (binds keys to actions).
    const baseConfig = {
      output: null, focus: null, hotkeys: undefined, actions: undefined,
      plugins: [], sourcePath: null,
    };
    const resolved = [
      bundledToResolved(coreActionsSpec, coreActionsSpec.module, baseConfig),
      bundledToResolved(configActionsSpec, configActionsSpec.module,
        { ...baseConfig, actions: opts.actions }),
      bundledToResolved(hotkeySpec, hotkeySpec.module,
        { ...baseConfig, hotkeys: hotkeysConfig }),
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
  return chain.dispatchPress(parseSpec(spec));
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

// The Mod+Z resize-submap shape, end to end through the config: while the
// mode is up, no keystroke reaches the focused app -- not the arrows the
// mode binds, and not the still-held-Super arrows that match nothing.
test('a pushed mode swallows every key; the mod-held variant never leaks', async () => {
  const invoked = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [{ keys: 'Mod+z', pushMode: 'resize' }],
        resize: [
          { keys: 'Escape', popMode: true },
          { keys: 'Left', action: 'test.shrink' },
        ],
      },
    },
    async ({ chain, runtime }) => {
      dispatch(chain, 'Mod+z');
      await runtime.flush();
      assert.deepEqual(chain.stackNames(), ['default', 'resize']);

      // Super still held from the chord: matches nothing, but is
      // swallowed rather than reaching the app as a cursor key.
      const held = dispatch(chain, 'Mod+Left');
      await runtime.flush();
      assert.equal(held.consume, true);
      assert.deepEqual(invoked, [], 'no action fired');

      // Super released: the bound arrow fires.
      const bare = dispatch(chain, 'Left');
      await runtime.flush();
      assert.equal(bare.consume, true);
      assert.deepEqual(invoked, ['test.shrink']);

      // An unrelated key is swallowed too -- and typing resumes on exit.
      assert.equal(dispatch(chain, 'q').consume, true);
      dispatch(chain, 'Escape');
      await runtime.flush();
      assert.deepEqual(chain.stackNames(), ['default']);
      assert.equal(dispatch(chain, 'q').consume, false);
    },
    { actions: { 'test.shrink': () => { invoked.push('test.shrink'); } } },
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
      // Unbound + no exit -> swallowed: a pushed mode isolates the
      // keyboard, so the modal holds and the app sees nothing.
      assert.equal(r.consume, true);
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
      const r = chain.dispatchPress({ mods: step.mods | 0x10, keysym: step.keysym });
      assert.equal(r.consume, true);
      await runtime.flush();
      assert.equal(events.length, 1);
    },
  );
});

// ---- config.actions + deferred refs (Phase 7b) ----------------------------

test('config.actions: user-defined handler fires on hotkey match', async () => {
  const userInvocations = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+u', action: 'user.note', params: { msg: 'hello' } },
        ],
      },
    },
    async ({ chain, runtime }) => {
      // Run the binding.
      const r = chain.dispatchPress(parseSpec('Mod+u'));
      assert.equal(r.consume, true);
      await runtime.flush();
      assert.equal(userInvocations.length, 1);
      assert.deepEqual(userInvocations[0].params, { msg: 'hello' });
    },
    {
      actions: {
        'user.note': async (_sdk, params) => {
          userInvocations.push({ params });
        },
      },
    },
  );
});

test('deferred refs: ref.focusedWindow resolved at invoke time', async () => {
  const invocations = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+w', action: 'user.observe',
            params: { surface: { $ref: 'focusedWindow' }, count: 1 } },
        ],
      },
    },
    async ({ chain, runtime }) => {
      chain.dispatchPress(parseSpec('Mod+w'));
      await runtime.flush();
      assert.equal(invocations.length, 1);
      // The resolver returned 42 -> the handler sees { surface: 42, count: 1 }.
      assert.deepEqual(invocations[0].params, { surface: 42, count: 1 });
    },
    {
      actions: {
        'user.observe': async (_sdk, params) => { invocations.push({ params }); },
      },
      resolvers: { focusedWindow: () => 42 },
    },
  );
});

test('deferred refs: resolver returning null passes through', async () => {
  const invocations = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+n', action: 'user.observe',
            params: { surface: { $ref: 'focusedWindow' } } },
        ],
      },
    },
    async ({ chain, runtime }) => {
      chain.dispatchPress(parseSpec('Mod+n'));
      await runtime.flush();
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].params.surface, null);
    },
    {
      actions: {
        'user.observe': async (_sdk, params) => { invocations.push({ params }); },
      },
      resolvers: { focusedWindow: () => null },
    },
  );
});

test('config.actions: handler can invoke other actions via sdk', async () => {
  const shutdowns = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+q', action: 'user.confirm-quit' },
        ],
      },
    },
    async ({ chain, runtime, pluginBus }) => {
      pluginBus.subscribe('compositor.shutdown', () => shutdowns.push('fired'));
      chain.dispatchPress(parseSpec('Mod+q'));
      await runtime.flush();
      assert.equal(shutdowns.length, 1);
    },
    {
      actions: {
        'user.confirm-quit': async (sdk) => {
          await sdk.actions.invoke('compositor.quit');
        },
      },
    },
  );
});

// ---- Release callbacks ----------------------------------------------------

test('releaseAction fires when the held key is released', async () => {
  const seen = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+m',
            action: 'user.press',
            releaseAction: 'user.release' },
        ],
      },
    },
    async ({ chain, runtime }) => {
      chain.dispatchPress(parseSpec('Mod+m'));
      await runtime.flush();
      assert.deepEqual(seen, ['press']);
      // Release the trigger first, then the modifier.
      chain.dispatchRelease({ kind: 'key', keysym: parseSpec('m').keysym });
      chain.dispatchRelease({ kind: 'mod', bit: 0x40 /* MOD_MOD4 */ });
      await runtime.flush();
      assert.deepEqual(seen, ['press', 'release']);
    },
    {
      actions: {
        'user.press': () => { seen.push('press'); },
        'user.release': () => { seen.push('release'); },
      },
    },
  );
});

test('releaseAction validation: chord + releaseAction is rejected by the chain', async () => {
  let failed = false;
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: ['Mod+a', 'Mod+b'],
            action: 'noop',
            releaseAction: 'noop' },
        ],
      },
    },
    async ({ runtime }) => {
      const states = runtime.states();
      const hk = states.find((s) => s.name === 'hotkey-default');
      if (hk?.state === 'failed') failed = true;
    },
    { expectFailure: true },
  );
  assert.equal(failed, true);
});

test('releaseAction without action is allowed (release-only binding via action)', async () => {
  // Press an action AND register a release. Order in the spec is action +
  // releaseAction; this exercises the per-half independence.
  const seen = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+n',
            pushMode: 'submode',
            releasePopMode: true },
        ],
        submode: [
          { keys: 'Escape', popMode: true },
        ],
      },
    },
    async ({ chain, runtime }) => {
      // pushMode on press.
      chain.dispatchPress(parseSpec('Mod+n'));
      await runtime.flush();
      assert.deepEqual(chain.stackNames(), ['default', 'submode']);
      // popMode on release.
      chain.dispatchRelease({ kind: 'key', keysym: parseSpec('n').keysym });
      chain.dispatchRelease({ kind: 'mod', bit: 0x40 });
      await runtime.flush();
      assert.deepEqual(chain.stackNames(), ['default']);
      assert.equal(seen.length, 0); // no actions fired in this test
    },
  );
});

// ---- Grab actions (registered by plugin-core-actions) --------------------

test('window.begin-move action emits window.grab-requested with kind=move', async () => {
  const requests = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+button1',
            action: 'window.begin-move',
            params: { surfaceId: 42 } },
        ],
      },
    },
    async ({ chain, pluginBus, runtime }) => {
      pluginBus.subscribe('window.grab-requested', (_n, p) => requests.push(p));
      chain.dispatchPress({ kind: 'button', mods: 0x40, button: 0x110 });
      await runtime.flush();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].kind, 'move');
      assert.equal(requests[0].surfaceId, 42);
    },
  );
});

test('window.begin-resize action emits window.grab-requested with edges', async () => {
  const requests = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+button3',
            action: 'window.begin-resize',
            params: { surfaceId: 7, edges: 'top-left' } },
        ],
      },
    },
    async ({ chain, pluginBus, runtime }) => {
      pluginBus.subscribe('window.grab-requested', (_n, p) => requests.push(p));
      chain.dispatchPress({ kind: 'button', mods: 0x40, button: 0x111 });
      await runtime.flush();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].kind, 'resize');
      assert.equal(requests[0].edges, 'top-left');
    },
  );
});

test('window.begin-resize: edges defaults to bottom-right when omitted', async () => {
  const requests = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+button3',
            action: 'window.begin-resize',
            params: { surfaceId: 7 } },
        ],
      },
    },
    async ({ chain, pluginBus, runtime }) => {
      pluginBus.subscribe('window.grab-requested', (_n, p) => requests.push(p));
      chain.dispatchPress({ kind: 'button', mods: 0x40, button: 0x111 });
      await runtime.flush();
      assert.equal(requests[0].edges, 'bottom-right');
    },
  );
});

test('window.end-grab action emits window.grab-end-requested', async () => {
  const requests = [];
  await withHotkeyPlugin(
    {
      modes: {
        default: [
          { keys: 'Mod+button1',
            action: 'window.begin-move',
            params: { surfaceId: 1 },
            releaseAction: 'window.end-grab' },
        ],
      },
    },
    async ({ chain, pluginBus, runtime }) => {
      pluginBus.subscribe('window.grab-end-requested', () => requests.push({}));
      chain.dispatchPress({ kind: 'button', mods: 0x40, button: 0x110 });
      await runtime.flush();
      // Release the button and the Mod.
      chain.dispatchRelease({ kind: 'button', button: 0x110 });
      chain.dispatchRelease({ kind: 'mod', bit: 0x40 });
      await runtime.flush();
      assert.equal(requests.length, 1);
    },
  );
});
