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
//   state.wm.engageContentGate(id, owner)
//   state.wm.releaseContentGate(id, owner)
//   state.bus?.emit(WINDOW_EVENT.opening, payload)
//   plus titleAppId(state, id) via state.toplevels.get(...) (we mock the
//   toplevel record so the helper finds title/appId).
//
// `gates` is a Map<surfaceId, Set<owner>> mirroring the WM's
// contentGateOwners machinery so tests can assert who's currently
// holding the gate.
function mockState({ outer, role = 'xdg_toplevel', gated = false,
                     title = null, appId = null,
                     viewport = { x: 0, y: 0, width: 1920, height: 1080 } } = {}) {
  const gates = new Map();
  if (gated) gates.set(1, new Set(['decoration']));  // a pre-existing owner
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
  const surface = { id: 1, role, spawnOutputId: 0,
                    resource: { id: 'wlsurf', version: 1, destroyed: false } };
  if (role === 'xdg_toplevel') {
    surface.xdgSurface = { toplevel: toplevelResource };
  }
  return {
    state: {
      wm: {
        outerRectOf: (id) => id === 1 ? outer : undefined,
        engageContentGate: (id, owner) => {
          if (!gates.has(id)) gates.set(id, new Set());
          gates.get(id).add(owner);
        },
        releaseContentGate: (id, owner) => {
          const s = gates.get(id);
          if (!s) return;
          s.delete(owner);
          if (s.size === 0) gates.delete(id);
        },
        primaryOutputId: () => 0,
        // The world region the output shows -- what the event reports as
        // outputRect, so it shares a space with outerRect.
        viewportOf: (id) => id === 0 ? viewport : null,
        // wm.state.outputs is a Map<id, WmOutput>.
        state: {
          outputs: new Map([[0, {
            id: 0,
            rect: { x: 0, y: 0, width: 1920, height: 1080 },
            scale: 1,
          }]]),
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
  // Gate engaged under our owner key.
  assert.deepEqual([...m.gates.get(1)], ['opening']);
  // One event emitted, with the right shape.
  assert.equal(m.events.length, 1);
  assert.equal(m.events[0].name, 'window.opening');
  assert.deepEqual(m.events[0].payload, {
    surfaceId: 1,
    outerRect: { x: 10, y: 20, width: 500, height: 400 },
    outputId: 0,
    outputRect: { x: 0, y: 0, width: 1920, height: 1080 },
    tiling: 'managed',
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

test('beforeMap: stacks with a pre-existing gate (e.g. decoration broker)', () => {
  // The decoration broker engages from window.map BEFORE the opening
  // driver fires inside windowHasContent. With multi-owner gating
  // both engage; both must release before the window draws.
  const m = mockState({
    outer: { x: 0, y: 0, width: 500, height: 400 },
    gated: true,  // mock-state seeds owner='decoration'
    title: 'X', appId: 'com.example.x',
  });
  const driver = createOpeningDriver({ hasPluginHandler: () => true });
  assert.equal(driver.beforeMap(m.state, m.surface), true,
    'opening driver engages even when another gate owner is present');
  // Both owners now hold the gate.
  assert.deepEqual([...m.gates.get(1)].sort(), ['decoration', 'opening']);
  // The window.opening event still fires (the plugin gets a chance
  // to set initial render state for its part of the animation).
  assert.equal(m.events.length, 1);
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

test('backstop fires: clears the opening-owner gate after timeout', async () => {
  const m = mockState({ outer: { x: 0, y: 0, width: 500, height: 400 } });
  const driver = createOpeningDriver({ hasPluginHandler: () => true, backstopMs: 10 });
  driver.beforeMap(m.state, m.surface);
  assert.deepEqual([...m.gates.get(1)], ['opening']);
  // Wait for the backstop to fire.
  await new Promise((r) => setTimeout(r, 25));
  // Opening owner released; with no other owners holding, the gate
  // map entry is gone entirely.
  assert.equal(m.gates.get(1), undefined, 'gate cleared by backstop');
  assert.deepEqual(driver.activeBackstopIds(), []);
});

test('backstop fires: only releases its own owner; other owners stay', async () => {
  // If a decoration is also gating, the backstop releasing the
  // opening-owner should leave the decoration owner in place. The
  // window stays invisible until the decoration also releases.
  const m = mockState({
    outer: { x: 0, y: 0, width: 500, height: 400 },
    gated: true,  // 'decoration'
  });
  const driver = createOpeningDriver({ hasPluginHandler: () => true, backstopMs: 10 });
  driver.beforeMap(m.state, m.surface);
  assert.deepEqual([...m.gates.get(1)].sort(), ['decoration', 'opening']);
  await new Promise((r) => setTimeout(r, 25));
  // Opening owner released; decoration owner still holding.
  assert.deepEqual([...m.gates.get(1)], ['decoration']);
});

test('backstop cancellation: cancelled timer does NOT release the gate', async () => {
  const m = mockState({ outer: { x: 0, y: 0, width: 500, height: 400 } });
  const driver = createOpeningDriver({ hasPluginHandler: () => true, backstopMs: 10 });
  driver.beforeMap(m.state, m.surface);
  assert.deepEqual([...m.gates.get(1)], ['opening']);
  driver.cancelBackstop(1);
  await new Promise((r) => setTimeout(r, 25));
  // The plugin would have called releaseOpeningGate via the broker; the
  // broker handles the release. From the driver's perspective: it just
  // cancels the timer. Validating that the timer didn't fire (would
  // have cleared the gate): the opening owner is still in the set.
  assert.deepEqual([...m.gates.get(1)], ['opening'],
    'gate stays engaged after backstop cancelled (the broker is what releases it)');
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
  assert.deepEqual([...m.gates.get(1)], ['opening']);
});

// outerRect is a world rect; outputRect must be the region the output is
// SHOWING, or a plugin subtracting them to get a slide distance mixes world
// and monitor-arrangement coordinates. Under a camera parked on a far
// island the difference is the whole point.
test('window.opening: outputRect is the output viewport, not its layout slot', () => {
  const m = mockState({
    outer: { x: 8000, y: 0, width: 800, height: 600 },
    viewport: { x: 7800, y: 0, width: 1920, height: 1080 },
  });
  const driver = createOpeningDriver({ hasPluginHandler: () => true });
  driver.beforeMap(m.state, m.surface);
  const ev = m.events.find((e) => e.name === 'window.opening');
  assert.deepEqual(ev.payload.outputRect, { x: 7800, y: 0, width: 1920, height: 1080 });
  // The plugin's "distance from the output's left edge to the tile" is now
  // a subtraction within one space.
  assert.equal(ev.payload.outerRect.x - ev.payload.outputRect.x, 200);
});
