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
// surfaceClientTexture / surfaceIsPresentable / surfaceWmRect from a map.
function stubCompositor(initial = {}) {
  const log = [];
  const clientTextures = new Map(Object.entries(initial.clientTextures ?? {}).map(([k, v]) => [Number(k), v]));
  const presentable = new Set(Object.entries(initial.presentable ?? {}).filter(([, v]) => v).map(([k]) => Number(k)));
  const wmRects = new Map(Object.entries(initial.wmRects ?? {}).map(([k, v]) => [Number(k), v]));
  const logicalSizes = new Map();
  const opaqueSurfaces = new Set();
  return {
    log,
    setOpaque(sid, o) { o ? opaqueSurfaces.add(sid) : opaqueSurfaces.delete(sid); },
    setClientTexture(sid, tex) {
      if (tex === null) clientTextures.delete(sid);
      else clientTextures.set(sid, tex);
    },
    setPresentable(sid, p) { p ? presentable.add(sid) : presentable.delete(sid); },
    setWmRect(sid, rect) {
      if (rect === null) wmRects.delete(sid);
      else wmRects.set(sid, rect);
    },
    setLogicalSize(sid, size) {
      if (size === null) logicalSizes.delete(sid);
      else logicalSizes.set(sid, size);
    },
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
      surfaceWmRect(surfaceId) {
        return wmRects.get(surfaceId) ?? null;
      },
      surfaceLogicalSize(surfaceId) {
        return logicalSizes.get(surfaceId) ?? null;
      },
      surfaceIsOpaque(surfaceId) {
        return opaqueSurfaces.has(surfaceId);
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

test('broker: opaque buffer format flows into render input.opaque', async () => {
  const { broker, bus, comp } = setup();
  const seen = [];
  await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      render: ({ input }) => { seen.push(input.opaque); },
    }),
  }, 'test-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(64, 64), w: 64, h: 64 });
  comp.setPresentable(1, true);
  // ARGB-style buffer: alpha is meaningful.
  broker.tick(0);
  assert.deepEqual(seen, [false]);
  // XRGB-style buffer: the alpha byte is undefined; the plugin must be told.
  comp.setOpaque(1, true);
  broker.tick(16);
  assert.deepEqual(seen, [false, true]);
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

test('broker: input rect maps window geometry into buffer pixels (fractional scale)', async () => {
  const bus = new TypedBus();
  const comp = stubCompositor();
  const geometries = new Map();
  const broker = new InterceptBroker({
    bus, compositor: comp.sink,
    inThread: { device: fakeDevice(), textureUsage: fakeTextureUsage() },
    surfaceGeometry: (sid) => geometries.get(sid) ?? null,
    log: () => {},
  });
  const rects = [];
  const ctxScales = [];
  const dimScales = [];
  await broker.registerInThread({
    name: 'test',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      outputDimensions: (w, h, s) => { dimScales.push(s); return { w, h }; },
      render: ({ input, ctx }) => {
        rects.push(input.rect);
        ctxScales.push(ctx.inputScale);
      },
    }),
  }, 'test-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'kitty'));
  // A 1.5x fractional-scale client: 200x100-logical window geometry backed
  // by a 300x150-buffer-pixel texture.
  comp.setClientTexture(1, { texture: fakeTexture(300, 150), w: 300, h: 150 });
  comp.setLogicalSize(1, { w: 200, h: 100 });
  geometries.set(1, { x: 0, y: 0, width: 200, height: 100 });
  comp.setPresentable(1, true);
  broker.tick(16);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 300, h: 150 },
    'geometry scaled to buffer pixels covers the whole buffer');
  assert.equal(ctxScales[0], 1.5, 'render ctx reports the buffer/logical factor');
  assert.equal(dimScales[0], 1.5, 'outputDimensions receives the same factor');

  // Non-zero origin (CSD shadow margins) scales on both axes.
  geometries.set(1, { x: 10, y: 20, width: 180, height: 60 });
  broker.tick(32);
  assert.deepEqual(rects[1], { x: 15, y: 30, w: 270, h: 90 });

  // Without a logical size (sink without support), geometry passes through
  // unscaled -- the scale-1 behavior.
  comp.setLogicalSize(1, null);
  geometries.set(1, { x: 0, y: 0, width: 200, height: 100 });
  broker.tick(48);
  assert.deepEqual(rects[2], { x: 0, y: 0, w: 200, h: 100 });
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

// --- gates / releaseGate --------------------------------------------------

function setupWithGates() {
  const bus = new TypedBus();
  const comp = stubCompositor();
  const messages = [];
  // Recording gate sink.
  const gateLog = [];
  const gateSink = {
    engageContentGate(sid, owner) { gateLog.push({ kind: 'engage', sid, owner }); },
    releaseContentGate(sid, owner) { gateLog.push({ kind: 'release', sid, owner }); },
  };
  const broker = new InterceptBroker({
    bus, compositor: comp.sink, gateSink,
    inThread: { device: fakeDevice(), textureUsage: fakeTextureUsage() },
    log: (line) => messages.push(line),
  });
  return { broker, bus, comp, messages, gateLog };
}

test('broker: gates:true engages gate on match, releases on releaseGate()', async () => {
  const { broker, bus, comp, gateLog } = setupWithGates();
  let releaseFn = null;
  await broker.registerInThread({
    name: 'deco',
    match: { appId: appIdMatch('.*') },
    gates: true,
    setup: () => ({
      render: ({ ctx }) => { releaseFn = ctx.releaseGate; },
    }),
  }, 'deco-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  // Gate engaged synchronously on match.
  assert.deepEqual(gateLog, [{ kind: 'engage', sid: 1, owner: 'intercept-deco' }]);
  // Render once; the plugin captures releaseGate.
  comp.setClientTexture(1, { texture: fakeTexture(64, 64), w: 64, h: 64 });
  comp.setPresentable(1, true);
  broker.tick(0);
  assert.ok(releaseFn !== null, 'plugin received releaseGate callback');
  // Plugin releases.
  releaseFn();
  assert.deepEqual(gateLog.at(-1), { kind: 'release', sid: 1, owner: 'intercept-deco' });
});

test('broker: gates: false / omitted does NOT engage a gate', async () => {
  const { broker, bus, gateLog } = setupWithGates();
  await broker.registerInThread({
    name: 'effect',
    match: { appId: appIdMatch('.*') },
    // no gates: declared
    setup: () => ({ render: () => {} }),
  }, 'effect-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  assert.deepEqual(gateLog, []);
});

test('broker: releaseGate() is idempotent', async () => {
  const { broker, bus, comp, gateLog } = setupWithGates();
  let releaseFn = null;
  await broker.registerInThread({
    name: 'deco',
    match: { appId: appIdMatch('.*') },
    gates: true,
    setup: () => ({
      render: ({ ctx }) => { releaseFn = ctx.releaseGate; },
    }),
  }, 'deco-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(64, 64), w: 64, h: 64 });
  comp.setPresentable(1, true);
  broker.tick(0);
  releaseFn();
  releaseFn();
  releaseFn();
  // One engage, one release, no second release.
  const releases = gateLog.filter((e) => e.kind === 'release');
  assert.equal(releases.length, 1);
});

test('broker: render throw releases the gate (window falls back to raw)', async () => {
  const { broker, bus, comp, gateLog } = setupWithGates();
  await broker.registerInThread({
    name: 'deco',
    match: { appId: appIdMatch('.*') },
    gates: true,
    setup: () => ({
      render: () => { throw new Error('plugin crashed'); },
    }),
  }, 'deco-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(64, 64), w: 64, h: 64 });
  comp.setPresentable(1, true);
  broker.tick(0);
  const releases = gateLog.filter((e) => e.kind === 'release');
  assert.equal(releases.length, 1, 'gate released on render throw');
});

test('broker: unregister releases any active gates', async () => {
  const { broker, bus, gateLog } = setupWithGates();
  const id = await broker.registerInThread({
    name: 'deco',
    match: { appId: appIdMatch('.*') },
    gates: true,
    setup: () => ({ render: () => {} }),
  }, 'deco-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  bus.emit(WINDOW_EVENT.map, mapEvent(2, 'firefox'));
  // Both gates engaged.
  assert.equal(gateLog.filter((e) => e.kind === 'engage').length, 2);
  await broker.unregister(id);
  // Both released.
  assert.equal(gateLog.filter((e) => e.kind === 'release').length, 2);
});

test('broker: unmap releases the gate', async () => {
  const { broker, bus, gateLog } = setupWithGates();
  await broker.registerInThread({
    name: 'deco',
    match: { appId: appIdMatch('.*') },
    gates: true,
    setup: () => ({ render: () => {} }),
  }, 'deco-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  bus.emit(WINDOW_EVENT.unmap, { surfaceId: 1 });
  const releases = gateLog.filter((e) => e.kind === 'release');
  assert.equal(releases.length, 1);
});

test('broker: gates backstop timeout force-releases after timeoutMs', async () => {
  const { broker, bus, gateLog } = setupWithGates();
  await broker.registerInThread({
    name: 'stuck',
    match: { appId: appIdMatch('.*') },
    gates: { timeoutMs: 10 },   // tiny timeout for the test
    setup: () => ({ render: () => {} }),   // never calls releaseGate
  }, 'stuck-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  assert.equal(gateLog.filter((e) => e.kind === 'engage').length, 1);
  // Wait > timeoutMs.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gateLog.filter((e) => e.kind === 'release').length, 1,
    'backstop fired and released the gate');
});

test('broker: gates without gateSink configured logs warning and does nothing', async () => {
  const bus = new TypedBus();
  const comp = stubCompositor();
  const messages = [];
  const broker = new InterceptBroker({
    bus, compositor: comp.sink,
    // No gateSink.
    inThread: { device: fakeDevice(), textureUsage: fakeTextureUsage() },
    log: (line) => messages.push(line),
  });
  let renderFn = null;
  await broker.registerInThread({
    name: 'deco',
    match: { appId: appIdMatch('.*') },
    gates: true,
    setup: () => ({ render: ({ ctx }) => { renderFn = ctx.releaseGate; } }),
  }, 'deco-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  assert.ok(messages.some((m) => m.includes('declared gates:true but no gate sink')));
  // ctx.releaseGate is still callable (no-op).
  comp.setClientTexture(1, { texture: fakeTexture(64, 64), w: 64, h: 64 });
  comp.setPresentable(1, true);
  broker.tick(0);
  assert.doesNotThrow(() => renderFn());
});

test('broker: strict-release policy holds gate across wrong-size frames (late-match catch-up)', async () => {
  // This is the central scenario the gates+ctx.surfaceRect machinery
  // exists to handle: an intercept registers AFTER a window has already
  // mapped and committed at its pre-inset (full-outer) size. The plugin
  // must NOT release the gate on the first render (which sees the old
  // wrong-size buffer); it must wait until the client re-commits at the
  // post-inset content size. While the gate stays engaged, the window
  // is out of the draw stack -- no wrong-size frame is ever visible.
  const { broker, bus, comp, gateLog } = setupWithGates();
  const renderObservations = [];
  const B = 4;   // border size, in pixels per side
  await broker.registerInThread({
    name: 'deco',
    match: { appId: appIdMatch('.*') },
    gates: true,
    setup: () => ({
      outputDimensions: (w, h) => ({ w: w + 2 * B, h: h + 2 * B }),
      render: ({ input, ctx }) => {
        renderObservations.push({
          inputW: input.rect.w, expectedContentW: ctx.surfaceRect.w - 2 * B,
        });
        // Strict policy: only release when the client has re-committed
        // at the post-inset content size.
        if (input.rect.w === ctx.surfaceRect.w - 2 * B) ctx.releaseGate();
      },
    }),
  }, 'deco-plugin');

  // Window was already mapped at the full outer size BEFORE the plugin
  // registered. WM rect = outer = 200x200; client committed at 200x200.
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(200, 200), w: 200, h: 200 });
  comp.setPresentable(1, true);
  comp.setWmRect(1, { x: 0, y: 0, w: 200, h: 200 });
  // Gate engaged at match (synchronous from window.map).
  assert.equal(gateLog.filter((e) => e.kind === 'engage').length, 1);

  // First render fires at the OLD size (client hasn't re-committed yet).
  // Strict policy compares inputW (200) against surfaceRect.w - 2B (192).
  // They don't match; the plugin does NOT call releaseGate.
  broker.tick(0);
  assert.deepEqual(renderObservations.at(-1), { inputW: 200, expectedContentW: 192 });
  assert.equal(gateLog.filter((e) => e.kind === 'release').length, 0,
    'gate stays engaged across wrong-size frame');

  // A few more frames pass; client still hasn't re-committed. Gate
  // stays engaged through them all.
  broker.tick(16);
  broker.tick(32);
  assert.equal(gateLog.filter((e) => e.kind === 'release').length, 0);

  // Now the client re-commits at the post-inset content size (192x192).
  comp.setClientTexture(1, { texture: fakeTexture(192, 192), w: 192, h: 192 });
  broker.tick(48);
  // Plugin sees matching dimensions; calls releaseGate.
  assert.deepEqual(renderObservations.at(-1), { inputW: 192, expectedContentW: 192 });
  assert.equal(gateLog.filter((e) => e.kind === 'release').length, 1,
    'gate released once the client re-commits at the post-inset size');
});

// --- preconfigure-time match ----------------------------------------------

test('broker: preconfigure-time emit fires onSurfaceMatched before window.map', async () => {
  const { broker, bus } = setup();
  const events = [];
  await broker.registerInThread({
    name: 'rect',
    match: { appId: appIdMatch('firefox') },
    setup: () => ({
      onSurfaceMatched: (info) => { events.push({ kind: 'matched', surfaceId: info.surfaceId }); },
      render: () => {},
    }),
  }, 'plugin');
  // Preconfigure fires before any map. The intercept broker should
  // assign on this seam alone (so the plugin's setInsets call inside
  // onSurfaceMatched lands before the first sized configure goes out).
  bus.emit(WINDOW_EVENT.preconfigure, {
    surfaceId: 1, appId: 'firefox', title: null,
    initialState: {},
  });
  assert.deepEqual(events, [{ kind: 'matched', surfaceId: 1 }]);
  // Subsequent map for the same surface must NOT fire a second matched.
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  assert.deepEqual(events, [{ kind: 'matched', surfaceId: 1 }]);
});

test('broker: preconfigure without matching registration is a no-op', async () => {
  const { broker, bus } = setup();
  let matched = 0;
  await broker.registerInThread({
    name: 'rect',
    match: { appId: appIdMatch('firefox') },
    setup: () => ({
      onSurfaceMatched: () => { matched += 1; },
      render: () => {},
    }),
  }, 'plugin');
  bus.emit(WINDOW_EVENT.preconfigure, {
    surfaceId: 1, appId: 'chrome', title: null, initialState: {},
  });
  assert.equal(matched, 0);
});

test('broker: preconfigure then map together fire only one matched', async () => {
  const { broker, bus } = setup();
  let matched = 0;
  await broker.registerInThread({
    name: 'r',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      onSurfaceMatched: () => { matched += 1; },
      render: () => {},
    }),
  }, 'plugin');
  bus.emit(WINDOW_EVENT.preconfigure, {
    surfaceId: 1, appId: 'firefox', title: null, initialState: {},
  });
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  assert.equal(matched, 1);
});

test('broker: map without preconfigure still fires matched (catch-up path)', async () => {
  const { broker, bus } = setup();
  let matched = 0;
  await broker.registerInThread({
    name: 'r',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      onSurfaceMatched: () => { matched += 1; },
      render: () => {},
    }),
  }, 'plugin');
  // No preconfigure (simulating: client mapped before plugin loaded;
  // catch-up via window.map alone).
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  assert.equal(matched, 1);
});

// --- ctx.surfaceRect ------------------------------------------------------

test('broker: ctx.surfaceRect reflects the surface\'s current WM rect', async () => {
  const { broker, bus, comp } = setup();
  const seen = [];
  await broker.registerInThread({
    name: 'rect',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      render: ({ ctx }) => { seen.push({ ...ctx.surfaceRect }); },
    }),
  }, 'rect-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(100, 80), w: 100, h: 80 });
  comp.setPresentable(1, true);
  comp.setWmRect(1, { x: 10, y: 20, w: 200, h: 160 });
  broker.tick(0);
  // WM relayout shrinks the outer rect.
  comp.setWmRect(1, { x: 10, y: 20, w: 196, h: 156 });
  broker.tick(16);
  assert.deepEqual(seen, [
    { x: 10, y: 20, w: 200, h: 160 },
    { x: 10, y: 20, w: 196, h: 156 },
  ]);
});

test('broker: ctx.surfaceRect is zero rect when compositor returns null', async () => {
  const { broker, bus, comp } = setup();
  let observed = null;
  await broker.registerInThread({
    name: 'rect',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      render: ({ ctx }) => { observed = { ...ctx.surfaceRect }; },
    }),
  }, 'rect-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(100, 80), w: 100, h: 80 });
  comp.setPresentable(1, true);
  // Deliberately not calling comp.setWmRect; surfaceWmRect returns null.
  broker.tick(0);
  assert.deepEqual(observed, { x: 0, y: 0, w: 0, h: 0 });
});

// --- outputDimensions -----------------------------------------------------

test('broker: outputDimensions allocates ring at declared size', async () => {
  const { broker, bus, comp } = setup();
  const createdSizes = [];
  await broker.registerInThread({
    name: 'border',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      outputDimensions: (w, h) => ({ w: w + 4, h: h + 4 }),
      render: ({ output }) => { createdSizes.push({ w: output.rect.w, h: output.rect.h }); },
    }),
  }, 'border-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(100, 80), w: 100, h: 80 });
  comp.setPresentable(1, true);
  broker.tick(0);
  assert.deepEqual(createdSizes, [{ w: 104, h: 84 }]);
  // installInterceptOutput got a view whose underlying texture was 104x84.
  const installs = comp.log.filter((e) => e.kind === 'install');
  assert.equal(installs.length, 1);
  assert.equal(installs[0].view.w, 104);
  assert.equal(installs[0].view.h, 84);
});

test('broker: outputDimensions reallocates when input dims change', async () => {
  const { broker, bus, comp } = setup();
  const sizes = [];
  await broker.registerInThread({
    name: 'border',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      outputDimensions: (w, h) => ({ w: w + 4, h: h + 4 }),
      render: ({ output }) => { sizes.push({ w: output.rect.w, h: output.rect.h }); },
    }),
  }, 'border-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(100, 80), w: 100, h: 80 });
  comp.setPresentable(1, true);
  broker.tick(0);
  // Client resizes.
  comp.setClientTexture(1, { texture: fakeTexture(200, 160), w: 200, h: 160 });
  broker.tick(16);
  assert.deepEqual(sizes, [{ w: 104, h: 84 }, { w: 204, h: 164 }]);
});

test('broker: outputDimensions defaults to identity when not provided', async () => {
  const { broker, bus, comp } = setup();
  const sizes = [];
  await broker.registerInThread({
    name: 'plain',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      render: ({ output }) => { sizes.push({ w: output.rect.w, h: output.rect.h }); },
    }),
  }, 'plain-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(100, 80), w: 100, h: 80 });
  comp.setPresentable(1, true);
  broker.tick(0);
  assert.deepEqual(sizes, [{ w: 100, h: 80 }]);
});

test('broker: outputDimensions returning invalid dims counts as failure', async () => {
  const { broker, bus, comp, messages } = setup();
  let renderCount = 0;
  await broker.registerInThread({
    name: 'bad',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      outputDimensions: () => ({ w: 0, h: 0 }),
      render: () => { renderCount += 1; },
    }),
  }, 'bad-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(100, 80), w: 100, h: 80 });
  comp.setPresentable(1, true);
  broker.tick(0);
  assert.equal(renderCount, 0, 'render does not fire when ensureRing throws');
  assert.ok(messages.some((m) => m.includes('ensureRing failed')));
  // ensureRing throw is treated as a render failure for threshold purposes.
});

test('broker: outputDimensions sustained failure -> auto-unregister', async () => {
  const { broker, bus, comp } = setup();
  let destroyed = false;
  await broker.registerInThread({
    name: 'bad',
    match: { appId: appIdMatch('.*') },
    setup: () => ({
      outputDimensions: () => ({ w: -1, h: -1 }),
      render: () => {},
      destroy: () => { destroyed = true; },
    }),
  }, 'bad-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'firefox'));
  comp.setClientTexture(1, { texture: fakeTexture(100, 80), w: 100, h: 80 });
  comp.setPresentable(1, true);
  const N = InThreadInterceptState.FAILURE_THRESHOLD;
  for (let i = 0; i < N; ++i) broker.tick(i * 16);
  await new Promise((r) => queueMicrotask(r));
  await new Promise((r) => queueMicrotask(r));
  assert.equal(destroyed, true);
  assert.equal(broker.registrationCount(), 0);
});

test('broker: fullscreen transitions on the plugin bus unmatch/rematch excludeFullscreen registrations', async () => {
  const bus = new TypedBus();
  const comp = stubCompositor();
  const subs = new Map();
  const pluginBus = {
    subscribe(name, handler) { subs.set(name, handler); return {}; },
  };
  const broker = new InterceptBroker({
    bus,
    pluginBus,
    compositor: comp.sink,
    inThread: { device: fakeDevice(), textureUsage: fakeTextureUsage() },
    log: () => {},
  });
  let matched = 0, unmatched = 0;
  const id = await broker.registerInThread({
    name: 'deco',
    match: { excludeFullscreen: true },
    setup: () => ({
      onSurfaceMatched: () => { matched += 1; },
      onSurfaceUnmatched: () => { unmatched += 1; },
      render: () => {},
    }),
  }, 'deco-plugin');
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'game'));
  assert.equal(matched, 1);
  assert.deepEqual(broker.activeSurfacesFor(id), [1]);

  const committed = subs.get(WINDOW_EVENT.committed);
  assert.ok(committed, 'broker subscribed to window.committed on the plugin bus');
  committed(WINDOW_EVENT.committed,
    { surfaceId: 1, changed: ['sizeMode'], current: { sizeMode: 'fullscreen' } });
  assert.equal(unmatched, 1);
  assert.deepEqual(broker.activeSurfacesFor(id), []);

  committed(WINDOW_EVENT.committed,
    { surfaceId: 1, changed: ['sizeMode'], current: { sizeMode: 'none' } });
  assert.equal(matched, 2);
  assert.deepEqual(broker.activeSurfacesFor(id), [1]);
});

test('broker: preconfigure seeds fullscreen so an excludeFullscreen registration never matches', async () => {
  const bus = new TypedBus();
  const comp = stubCompositor();
  const broker = new InterceptBroker({
    bus,
    compositor: comp.sink,
    inThread: { device: fakeDevice(), textureUsage: fakeTextureUsage() },
    log: () => {},
  });
  let matched = 0;
  const id = await broker.registerInThread({
    name: 'deco',
    match: { excludeFullscreen: true },
    setup: () => ({
      onSurfaceMatched: () => { matched += 1; },
      render: () => {},
    }),
  }, 'deco-plugin');
  // A game declaring fullscreen pre-map: preconfigure carries the state.
  bus.emit(WINDOW_EVENT.preconfigure, {
    surfaceId: 1, appId: 'game', title: null, xwayland: false,
    initialState: { sizeMode: 'fullscreen' },
  });
  bus.emit(WINDOW_EVENT.map, mapEvent(1, 'game'));
  assert.equal(matched, 0);
  assert.deepEqual(broker.activeSurfacesFor(id), []);
});
