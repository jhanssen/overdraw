// Pure-unit tests for the window.relayout emit site inside the WM.
// Verifies the WM emits before mutating geometry, awaits interceptors,
// honors a modifying interceptor's newOuter, and is fire-and-forget when
// no interceptor is registered.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

function mockCompositor() {
  const layouts = [];
  const stacks = [];
  return {
    setSurfaceLayout(id, x, y, w, h) { layouts.push({ id, x, y, w, h }); },
    setStack(ids) { stacks.push([...ids]); },
    _layouts: layouts,
    _stacks: stacks,
  };
}

const rec = (id) => ({ resource: { __id: id } });
const OUT = [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }];

function setup() {
  const comp = mockCompositor();
  const pluginBus = new DynamicBus();
  const wm = createWm(comp, OUT, {
    layoutDriverFactory: inlineMasterStackDriverFactory,
    pluginBus,
  });
  return { wm, comp, pluginBus };
}

test('relayout: emits window.relayout per affected window with correct payload', async () => {
  const { wm, pluginBus } = setup();
  const seen = [];
  pluginBus.subscribe(WINDOW_EVENT.relayout, (_, p) => { seen.push(p); });

  wm.addWindow(1, rec(1));
  await wm.settled();
  // Single window: layout pushed once. As a newly-created window, oldOuter
  // and oldOutputId are null; newOuter is the full output rect.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].surfaceId, 1);
  assert.equal(seen[0].oldOuter, null);
  assert.equal(seen[0].oldOutputId, null);
  assert.deepEqual(seen[0].newOuter, { x: 0, y: 0, width: 1000, height: 600 });

  seen.length = 0;
  wm.addWindow(2, rec(2));
  await wm.settled();
  // Two windows: both get relayout events (master + stack). The newly-
  // added window's event is CREATED (oldOuter null); the existing
  // window's event is a RETILED case (both rects non-null).
  assert.equal(seen.length, 2);
  const ids = seen.map((e) => e.surfaceId).sort();
  assert.deepEqual(ids, [1, 2]);
  const created = seen.find((e) => e.surfaceId === 2);
  const retiled = seen.find((e) => e.surfaceId === 1);
  assert.equal(created.oldOuter, null);
  assert.ok(retiled.oldOuter !== null);
  assert.ok(retiled.newOuter !== null);
});

test('relayout: observer sees the post-modification newOuter', async () => {
  const { wm, pluginBus } = setup();
  // Interceptor shifts the window 10px right.
  pluginBus.intercept(WINDOW_EVENT.relayout, (_, p) => ({
    ...p,
    newOuter: { ...p.newOuter, x: p.newOuter.x + 10 },
  }));
  const observed = [];
  pluginBus.subscribe(WINDOW_EVENT.relayout, (_, p) => { observed.push(p); });

  wm.addWindow(1, rec(1));
  await wm.settled();

  assert.equal(observed.length, 1);
  assert.equal(observed[0].newOuter.x, 10);
});

test('relayout: interceptor modifying newOuter changes the WM-installed rect', async () => {
  const { wm, comp, pluginBus } = setup();
  pluginBus.intercept(WINDOW_EVENT.relayout, (_, p) => ({
    ...p,
    newOuter: { x: 42, y: 7, width: 100, height: 50 },
  }));

  wm.addWindow(1, rec(1));
  await wm.settled();
  wm.windowHasContent(1);

  // WM record reflects the interceptor's rect, not the layout's full-output rect.
  assert.deepEqual(wm.state.windows[0].outer, { x: 42, y: 7, width: 100, height: 50 });
  // Compositor received the intercepted rect.
  assert.deepEqual(comp._layouts.at(-1), { id: 1, x: 42, y: 7, w: 100, h: 50 });
});

test('relayout: emit happens BEFORE compositor setSurfaceLayout', async () => {
  const { wm, comp, pluginBus } = setup();
  const order = [];
  pluginBus.subscribe(WINDOW_EVENT.relayout, () => { order.push('emit'); });
  // Layout-side instrumentation: every setSurfaceLayout pushes 'layout'.
  const origSet = comp.setSurfaceLayout.bind(comp);
  comp.setSurfaceLayout = function (...args) {
    order.push('layout');
    origSet(...args);
  };

  wm.addWindow(1, rec(1));
  await wm.settled();
  wm.windowHasContent(1);

  // First event is the emit (pre-action). The 'layout' entry comes later,
  // either from the relayout-time setSurfaceLayout (window has no content
  // yet -> none) or from windowHasContent.
  assert.equal(order[0], 'emit');
});

test('relayout: async interceptor defers WM mutation', async () => {
  const { wm, pluginBus } = setup();
  let interceptorDone = false;
  let postLayoutSeen = false;
  pluginBus.intercept(WINDOW_EVENT.relayout, async () => {
    await new Promise((r) => setTimeout(r, 20));
    interceptorDone = true;
  });
  pluginBus.subscribe(WINDOW_EVENT.relayout, () => {
    // Observer fires AFTER interceptor settles.
    postLayoutSeen = interceptorDone;
  });

  wm.addWindow(1, rec(1));
  await wm.settled();
  assert.equal(postLayoutSeen, true);
});

test('relayout: garbage from interceptor falls back to WM-intended newOuter', async () => {
  const { wm, comp, pluginBus } = setup();
  pluginBus.intercept(WINDOW_EVENT.relayout, () => ({ newOuter: 'not-a-rect' }));

  wm.addWindow(1, rec(1));
  await wm.settled();
  wm.windowHasContent(1);

  // WM ignored the garbage and installed the layout's full-output rect.
  assert.deepEqual(wm.state.windows[0].outer, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(comp._layouts.at(-1), { id: 1, x: 0, y: 0, w: 1000, h: 600 });
});

test('relayout: no pluginBus -> no emit, synchronous-ish apply', async () => {
  // Construct without pluginBus; verify the WM still works exactly as
  // before (existing wm.test.js coverage is the regression contract, but
  // this asserts the no-bus path explicitly).
  const comp = mockCompositor();
  const wm = createWm(comp, OUT, {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  wm.addWindow(1, rec(1));
  await wm.settled();
  wm.windowHasContent(1);
  assert.deepEqual(wm.state.windows[0].outer, { x: 0, y: 0, width: 1000, height: 600 });
});

test('relayout: stuck interceptor exceeding 100ms is skipped; WM proceeds', async () => {
  const warnings = [];
  const pluginBus = new DynamicBus((msg) => warnings.push(msg));
  const comp = mockCompositor();
  const wm = createWm(comp, OUT, {
    layoutDriverFactory: inlineMasterStackDriverFactory,
    pluginBus,
  });
  pluginBus.intercept(WINDOW_EVENT.relayout, async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { newOuter: { x: 999, y: 999, width: 1, height: 1 } };
  });

  const t0 = Date.now();
  wm.addWindow(1, rec(1));
  await wm.settled();
  const elapsed = Date.now() - t0;
  wm.windowHasContent(1);

  // The 100ms timeout kicked in: WM proceeded with the original newOuter.
  assert.deepEqual(wm.state.windows[0].outer, { x: 0, y: 0, width: 1000, height: 600 });
  assert.ok(elapsed < 250, `expected WM to proceed near the timeout, took ${elapsed}ms`);
  assert.ok(warnings.some((m) => m.includes('timed out') || m.includes('failed')));
});
