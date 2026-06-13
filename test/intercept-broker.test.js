// Pure-unit tests for the intercept broker:
//   - register/unregister + setup/destroy callbacks
//   - bus events (window.map / change / unmap) drive lifecycle
//   - per-frame tick dispatches render to active surfaces
//   - render throw -> error logged, surface falls back to raw
//   - consecutive failures past threshold -> auto-unregister
//   - outputRect return -> installOutput receives placement
//
// All GPU-free: the device + textures are fakes; the test asserts on
// recorded calls to a stub compositor sink.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InterceptBroker } from '../packages/core/dist/intercept/broker.js';
import { TypedBus } from '../packages/core/dist/events/bus.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';
import { InThreadInterceptState } from '../packages/core/dist/intercept/inthread-state.js';

// Fake GPUTexture: a JS object the broker treats as opaque (it only
// passes it to the plugin and to installInterceptOutput). createView()
// returns another opaque object; destroy() is a no-op.
function fakeTexture(w, h) {
  return {
    width: w,
    height: h,
    createView: () => ({ __view: true, w, h }),
    destroy: () => {},
  };
}

// Fake device: createTexture returns fakeTexture objects so the
// in-thread output ring can be allocated.
function fakeDevice() {
  return {
    createTexture: (d) => fakeTexture(d.size.width, d.size.height),
  };
}

function fakeTextureUsage() {
  return {
    RENDER_ATTACHMENT: 0x10,
    TEXTURE_BINDING: 0x04,
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
  };
}

// Stub compositor sink. Records every install/clear and answers
// surfaceClientTexture / surfaceIsPresentable from a map.
function stubCompositor(initial = {}) {
  const log = [];
  const clientTextures = new Map(Object.entries(initial.clientTextures ?? {}).map(([k, v]) => [Number(k), v]));
  const presentable = new Set(Object.entries(initial.presentable ?? {}).filter(([, v]) => v).map(([k]) => Number(k)));
  return {
    log,
    setClientTexture(sid, tex) {
      if (tex === null) clientTextures.delete(sid);
      else clientTextures.set(sid, tex);
    },
    setPresentable(sid, p) { p ? presentable.add(sid) : presentable.delete(sid); },
    sink: {
      installInterceptOutput(surfaceId, view, placement) {
        log.push({ kind: 'install', surfaceId, view, placement });
      },
      clearInterceptOutput(surfaceId) {
        log.push({ kind: 'clear', surfaceId });
      },
      surfaceClientTexture(surfaceId) {
        return clientTextures.get(surfaceId) ?? null;
      },
      surfaceIsPresentable(surfaceId) {
        return presentable.has(surfaceId);
      },
    },
  };
}

function setup(initial = {}) {
  const bus = new TypedBus();
  const comp = stubCompositor(initial);
  const messages = [];
  const broker = new InterceptBroker({
    bus,
    compositor: comp.sink,
    inThread: {
      device: fakeDevice(),
      textureUsage: fakeTextureUsage(),
    },
    log: (line) => messages.push(line),
  });
  return { broker, bus, comp, messages };
}

function appIdMatch(source, flags = '') {
  return { source, flags };
}

function mapEvent(surfaceId, appId = null, title = null) {
  return { surfaceId, appId, title, rect: { x: 0, y: 0, width: 100, height: 100 } };
}

function changeEvent(surfaceId, fields, appId = null, title = null) {
  return {
    surfaceId, changed: fields, appId, title,
    activated: false,
  };
}

// ---------------------------------------------------------------------------

test('broker: register runs setup once and assigns matched events', async () => {
  const { broker, bus, comp } = setup();
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  let setupCount = 0;
  let matchedCount = 0;
  const id = await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('firefox') },
    setup: () => {
      setupCount += 1;
      return {
        onSurfaceMatched: () => { matchedCount += 1; },
        render: () => {},
      };
    },
  }, 'test-plugin');
  assert.equal(setupCount, 1);
  assert.equal(matchedCount, 1);
  assert.deepEqual(broker.activeSurfacesFor(id), [1]);
  void comp;
});

test('broker: late-mapped client matches existing registration', async () => {
  const { broker, bus } = setup();
  let matchedSurfaceId = null;
  const id = await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('firefox') },
    setup: () => ({
      onSurfaceMatched: (info) => { matchedSurfaceId = info.surfaceId; },
      render: () => {},
    }),
  }, 'test-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(7, 'firefox'));
  assert.equal(matchedSurfaceId, 7);
  assert.deepEqual(broker.activeSurfacesFor(id), [7]);
});

test('broker: appId change can re-match a previously-unmatched surface', async () => {
  const { broker, bus } = setup();
  const matched = [];
  const id = await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('firefox') },
    setup: () => ({
      onSurfaceMatched: (info) => matched.push(['matched', info.surfaceId]),
      onSurfaceUnmatched: (info) => matched.push(['unmatched', info.surfaceId]),
      render: () => {},
    }),
  }, 'test-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'chrome'));   // no match
  assert.deepEqual(matched, []);
  bus.emit(WINDOW_EVENT.change, changeEvent(1, ['appId'], 'firefox', null));
  assert.deepEqual(matched, [['matched', 1]]);
  assert.deepEqual(broker.activeSurfacesFor(id), [1]);
});

test('broker: unmap fires onSurfaceUnmatched', async () => {
  const { broker, bus } = setup();
  const unmatched = [];
  const id = await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      onSurfaceUnmatched: (info) => unmatched.push(info.surfaceId),
      render: () => {},
    }),
  }, 'test-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  bus.emit(WINDOW_EVENT.unmap, { surfaceId: 1 });
  assert.deepEqual(unmatched, [1]);
  assert.deepEqual(broker.activeSurfacesFor(id), []);
});

test('broker: unregister fires onSurfaceUnmatched + destroy', async () => {
  const { broker, bus } = setup();
  let destroyCount = 0;
  const unmatched = [];
  const id = await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      onSurfaceUnmatched: (info) => unmatched.push(info.surfaceId),
      render: () => {},
      destroy: () => { destroyCount += 1; },
    }),
  }, 'test-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  bus.emit(WINDOW_EVENT.map, mapEvent(2, 'firefox'));
  await broker.unregister(id);
  assert.deepEqual(unmatched.sort(), [1, 2]);
  assert.equal(destroyCount, 1);
  assert.equal(broker.registrationCount(), 0);
});

test('broker: tick calls render only for presentable + textured surfaces', async () => {
  const { broker, bus, comp } = setup();
  let renderCount = 0;
  await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      render: () => { renderCount += 1; },
    }),
  }, 'test-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  // Not presentable, no client tex -> tick is a no-op for this surface.
  broker.tick(0);
  assert.equal(renderCount, 0);
  // Add client texture but not presentable -> still skipped.
  comp.setClientTexture(1, { texture: fakeTexture(64, 64), w: 64, h: 64 });
  broker.tick(16);
  assert.equal(renderCount, 0);
  // Make presentable -> render fires.
  comp.setPresentable(1, true);
  broker.tick(32);
  assert.equal(renderCount, 1);
  // installInterceptOutput recorded after render.
  const installs = comp.log.filter((e) => e.kind === 'install');
  assert.equal(installs.length, 1);
  assert.equal(installs[0].surfaceId, 1);
});

test('broker: render outputRect propagates as install placement', async () => {
  const { broker, bus, comp } = setup();
  await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      render: () => ({ outputRect: { x: 32, y: 32, w: 64, h: 64 } }),
    }),
  }, 'test-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(64, 64), w: 64, h: 64 });
  comp.setPresentable(1, true);
  broker.tick(0);
  const installs = comp.log.filter((e) => e.kind === 'install');
  assert.equal(installs.length, 1);
  assert.deepEqual(installs[0].placement, { x: 32, y: 32, w: 64, h: 64 });
});

test('broker: render throw -> log + clear; surface falls back to raw', async () => {
  const { broker, bus, comp, messages } = setup();
  await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      render: () => { throw new Error('boom'); },
    }),
  }, 'test-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(64, 64), w: 64, h: 64 });
  comp.setPresentable(1, true);
  broker.tick(0);
  // Logged + clearInterceptOutput called.
  assert.ok(messages.some((m) => m.includes('render threw') && m.includes('boom')));
  const clears = comp.log.filter((e) => e.kind === 'clear');
  assert.equal(clears.length, 1);
  // No install (render didn't produce output this frame).
  const installs = comp.log.filter((e) => e.kind === 'install');
  assert.equal(installs.length, 0);
});

test('broker: K consecutive failures -> auto-unregister', async () => {
  const { broker, bus, comp } = setup();
  let destroyed = false;
  const renderEvents = [];
  await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      onSurfaceUnmatched: () => renderEvents.push('unmatched'),
      render: () => { renderEvents.push('render'); throw new Error('always fails'); },
      destroy: () => { destroyed = true; },
    }),
  }, 'test-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(64, 64), w: 64, h: 64 });
  comp.setPresentable(1, true);
  const N = InThreadInterceptState.FAILURE_THRESHOLD;
  for (let i = 0; i < N; ++i) broker.tick(i * 16);
  // The auto-unregister fires from a microtask.
  await new Promise((r) => queueMicrotask(r));
  await new Promise((r) => queueMicrotask(r));
  assert.equal(destroyed, true, 'destroy fired after threshold');
  assert.equal(broker.registrationCount(), 0);
});

test('broker: in-thread transport required for registerInThread', async () => {
  const bus = new TypedBus();
  const comp = stubCompositor();
  const broker = new InterceptBroker({
    bus, compositor: comp.sink, log: () => {},
    // No inThread -> registerInThread throws.
  });
  await assert.rejects(broker.registerInThread({
    name: 'x', match: {}, setup: () => ({ render: () => {} }),
  }, 'plugin'), /in-thread transport not configured/);
});

test('broker: invalid app_id regex rejects register', async () => {
  const { broker } = setup();
  await assert.rejects(broker.registerInThread({
    name: 'x',
    match: { appId: { source: '[', flags: '' } },
    setup: () => ({ render: () => {} }),
  }, 'plugin'), SyntaxError);
});
