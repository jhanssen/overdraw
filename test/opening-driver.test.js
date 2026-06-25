// Unit tests for the opening-driver (the map-side mirror of the
// closing-driver). Verifies:
//   - beforeMap returns false when no plugin is registered (instant map).
//   - beforeMap returns true when a plugin is registered: engages the WM
//     content gate, emits window.opening with the right payload, arms a
//     backstop.
//   - cancelBackstop suppresses the backstop timer.
//   - Backstop firing force-clears the content gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOpeningDriver } from '../packages/core/dist/protocols/opening-driver.js';

// Minimal mock state. The driver only touches:
//   state.wm.outerRectOf(id)
//   state.wm.isContentGated(id)
//   state.wm.setContentGated(id, gated)
//   state.bus?.emit(WINDOW_EVENT.opening, payload)
//   plus titleAppId(state, id) via state.toplevels.get(...) (we mock the
//   toplevel record so the helper finds title/appId).
function mockState({ outer, role = 'xdg_toplevel', gated = false,
                     title = null, appId = null } = {}) {
  const gates = new Map();
  if (gated) gates.set(1, true);
  const events = [];
  // Toplevel record shape used by titleAppId.
  const toplevelResource = { id: 'tl', version: 1, destroyed: false };
  const toplevels = new Map();
  if (role === 'xdg_toplevel') {
    toplevels.set(toplevelResource, {
      resource: toplevelResource,
      xdgSurface: { surface: { id: 1 } },
      title, appId,
    });
  }
  const surface = { id: 1, role, resource: { id: 'wlsurf', version: 1, destroyed: false } };
  if (role === 'xdg_toplevel') {
    surface.xdgSurface = { toplevel: toplevelResource };
  }
  return {
    state: {
      wm: {
        outerRectOf: (id) => id === 1 ? outer : undefined,
        isContentGated: (id) => gates.get(id) === true,
        setContentGated: (id, on) => {
          if (on) gates.set(id, true);
          else gates.delete(id);
        },
      },
      bus: {
        emit: (name, payload) => { events.push({ name, payload }); },
      },
      toplevels,
      surfaces: new Map([[surface.resource, surface]]),
    },
    surface,
    gates,
    events,
  };
}

test('beforeMap: returns false when no plugin handler registered', () => {
  const m = mockState({ outer: { x: 0, y: 0, width: 500, height: 400 } });
  const driver = createOpeningDriver({ hasPluginHandler: () => false });
  assert.equal(driver.beforeMap(m.state, m.surface), false);
  // No gate engaged.
  assert.equal(m.gates.get(1), undefined);
  // No event emitted.
  assert.equal(m.events.length, 0);
});

test('beforeMap: engages gate + emits window.opening when plugin registered', () => {
  const m = mockState({
    outer: { x: 10, y: 20, width: 500, height: 400 },
    title: 'X', appId: 'com.example.x',
  });
  const driver = createOpeningDriver({ hasPluginHandler: () => true });
  assert.equal(driver.beforeMap(m.state, m.surface), true);
  // Gate engaged.
  assert.equal(m.gates.get(1), true);
  // One event emitted, with the right shape.
  assert.equal(m.events.length, 1);
  assert.equal(m.events[0].name, 'window.opening');
  assert.deepEqual(m.events[0].payload, {
    surfaceId: 1,
    outerRect: { x: 10, y: 20, width: 500, height: 400 },
    appId: 'com.example.x',
    title: 'X',
  });
  // Backstop armed.
  assert.deepEqual(driver.activeBackstopIds(), [1]);
});

test('beforeMap: declines non-toplevel surfaces', () => {
  const m = mockState({
    outer: { x: 0, y: 0, width: 500, height: 400 },
    role: 'wl_subsurface',
  });
  const driver = createOpeningDriver({ hasPluginHandler: () => true });
  assert.equal(driver.beforeMap(m.state, m.surface), false);
  assert.equal(m.gates.get(1), undefined);
  assert.equal(m.events.length, 0);
});

test('beforeMap: declines when window is already gated', () => {
  const m = mockState({
    outer: { x: 0, y: 0, width: 500, height: 400 },
    gated: true,  // pretend e.g. the decoration broker already engaged.
  });
  const driver = createOpeningDriver({ hasPluginHandler: () => true });
  assert.equal(driver.beforeMap(m.state, m.surface), false);
  // The pre-existing gate stays.
  assert.equal(m.gates.get(1), true);
  // No event emitted.
  assert.equal(m.events.length, 0);
  // No backstop armed.
  assert.deepEqual(driver.activeBackstopIds(), []);
});

test('beforeMap: declines when WM has no rect (placeholder)', () => {
  const m = mockState({ outer: { x: 0, y: 0, width: -1, height: -1 } });
  const driver = createOpeningDriver({ hasPluginHandler: () => true });
  assert.equal(driver.beforeMap(m.state, m.surface), false);
  assert.equal(m.gates.get(1), undefined);
});

test('cancelBackstop: removes the timer from the active list', () => {
  const m = mockState({ outer: { x: 0, y: 0, width: 500, height: 400 } });
  const driver = createOpeningDriver({ hasPluginHandler: () => true, backstopMs: 10000 });
  driver.beforeMap(m.state, m.surface);
  assert.deepEqual(driver.activeBackstopIds(), [1]);
  driver.cancelBackstop(1);
  assert.deepEqual(driver.activeBackstopIds(), []);
});

test('backstop fires: clears the gate after timeout', async () => {
  const m = mockState({ outer: { x: 0, y: 0, width: 500, height: 400 } });
  const driver = createOpeningDriver({ hasPluginHandler: () => true, backstopMs: 10 });
  driver.beforeMap(m.state, m.surface);
  assert.equal(m.gates.get(1), true);
  // Wait for the backstop to fire.
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(m.gates.get(1), undefined, 'gate cleared by backstop');
  assert.deepEqual(driver.activeBackstopIds(), []);
});

test('backstop cancellation: cancelled timer does NOT clear the gate', async () => {
  const m = mockState({ outer: { x: 0, y: 0, width: 500, height: 400 } });
  const driver = createOpeningDriver({ hasPluginHandler: () => true, backstopMs: 10 });
  driver.beforeMap(m.state, m.surface);
  assert.equal(m.gates.get(1), true);
  driver.cancelBackstop(1);
  // Wait longer than the backstop interval to ensure it's truly cancelled.
  await new Promise((r) => setTimeout(r, 25));
  // The plugin would have called releaseOpeningGate via the broker; the
  // broker also clears the WM gate. But the driver itself just cancels
  // the timer -- the gate stays engaged from the driver's perspective.
  // Validating that the timer didn't fire: it would have cleared the gate.
  assert.equal(m.gates.get(1), true,
    'gate stays engaged after backstop cancelled (the broker is what clears it)');
});

test('hasPluginHandler is consulted lazily on every beforeMap', () => {
  let registered = false;
  const driver = createOpeningDriver({ hasPluginHandler: () => registered });
  const m = mockState({ outer: { x: 0, y: 0, width: 500, height: 400 } });
  // Initially no plugin: instant map.
  assert.equal(driver.beforeMap(m.state, m.surface), false);
  // Plugin registers; next map gets the hook.
  registered = true;
  // Reset the gate state for a fresh map.
  m.gates.clear();
  assert.equal(driver.beforeMap(m.state, m.surface), true);
});
