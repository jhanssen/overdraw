// End-to-end: the canvas plugin (workspace parity mode) loaded into a real
// PluginRuntime against a mock CompositorSink + windows broker + real WM.
// Asserts the workspace-namespace surface behaves exactly like
// plugin-workspace-default (same verbs, same setOutputStack pushes, same
// workspace.* events) AND that each output's shown workspace is published
// as an explicit layout island (id = the workspace's durable handle,
// rect = null, members = the pushed stack).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../../packages/core/dist/events/window-bus.js';
import { WINDOW_EVENT } from '../../packages/core/dist/events/types.js';
import { createWm } from '../../packages/core/dist/wm/index.js';
import { createWindowsBroker, NOT_HANDLED as WINDOWS_NOT_HANDLED }
  from '../../packages/core/dist/plugins/windows-broker.js';
import { bundledToResolved } from '../../packages/core/dist/plugins/bundled.js';
import { withRuntime } from '../plugin-helpers.mjs';

const canvasSpec = { name: 'canvas', module: '@overdraw/plugin-canvas' };
// The real layout provider loads alongside: elastic island widths come from
// its measure() (canvas-design.md §5), so a mock would pin geometry the
// production provider never produces.
const layoutSpec = {
  name: 'layout-default', module: '@overdraw/plugin-layout-default',
  configFrom: (cfg) => cfg.layout,
};

function mockSink() {
  const sink = {
    outputStackCalls: [],
    cameraCalls: [],
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack(outputId, ids) {
      sink.outputStackCalls.push({ outputId, ids: ids === null ? null : [...ids] });
    },
    setOutputCamera(outputId, x, y, zoom = 1) {
      sink.cameraCalls.push({ outputId, x, y, zoom });
    },
    setIslandBackdrops(list) {
      sink.backdropCalls.push(list.map((b) => ({ ...b })));
    },
  };
  sink.backdropCalls = [];
  return sink;
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

// Build a runtime + windows broker + bus harness around the canvas plugin.
// The WM runs a capture layout driver so pushed islands are observable via
// the layout snapshots the driver receives.
async function withCanvasPlugin(fn, opts = {}) {
  const pluginBus = new DynamicBus();
  const bus = createCompositorBus();
  const sink = mockSink();
  const layoutSnapshots = [];
  // The WM's apply target, captured so tests can push real window rects
  // (the capture driver never computes any).
  let layoutApply = null;
  const wm = createWm(sink,
    [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }],
    {
      // The plugin bus makes the WM's window.committed/relayout emits
      // visible to the plugin under test, as in production.
      pluginBus,
      // Production wiring: the broker's set-output-stack handler stores
      // stacks on `state`; the WM derives per-output content from them
      // (island scoping for maximized demotion, parent resolution).
      outputContent: () => state.outputToplevelStacks ?? new Map(),
      layoutDriverFactory: (target, snapshot) => {
        layoutApply = target;
        return {
          schedule() { layoutSnapshots.push(snapshot()); },
          settled() { return Promise.resolve(); },
        };
      },
    });
  const seatCalls = { focus: [] };
  const seat = {
    applyKeyboardFocus(id) { seatCalls.focus.push(id); },
    dispatchFocusEvent(reason, trigger) {
      seatCalls.focus.push({ kind: 'dispatch', reason, trigger });
    },
    repickPointer() {},
    grab: null,
    pointerPosition() { return { x: 100, y: 100 }; },
    beginGrab(g) { if (!seat.grab) seat.grab = g; },
    endGrab() { seat.grab = null; },
  };
  const state = {
    bus, wm, surfaces: new Map(), compositor: sink, seat,
    pendingWindowChanges: undefined, decorationResize: null,
  };
  // Late-bound like main.ts: the runtime is created below the broker, and
  // measure-island only fires once both plugins are live.
  let runtime = null;
  const broker = createWindowsBroker({
    wm, compositor: sink, state, pluginBus, bus,
    invokeLayout: (method, args) => runtime.invokeNamespace('layout', method, args),
  });
  bus.on(WINDOW_EVENT.map, (ev) => pluginBus.emit(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => pluginBus.emit(WINDOW_EVENT.unmap, ev));

  const wsEvents = [];
  pluginBus.subscribe('workspace.*', (name, payload) => {
    wsEvents.push({ name, payload });
  });

  // One entry per windows.set-islands broker call = one publishWorld pass.
  const setIslandsCalls = [];

  // Mock animations broker for camera flights. Modes (opts.animations):
  //   undefined      -- run resolves immediately (flights settle instantly);
  //   'manual'       -- run parks until the test resolves it via animPending
  //                     (a second run on the same target resolves the first,
  //                     mirroring the evaluator's cancel-on-replacement);
  //   'deny'         -- run rejects (the broker's cameraGate during a grab).
  const animCalls = [];
  const animPending = [];
  function handleAnimations(method, params) {
    if (opts.animations === 'deny') {
      throw new Error('animations.run: camera animation denied: interactive grab active');
    }
    if (method === 'animations.run') {
      animCalls.push(params.spec);
      if (opts.animations === 'manual') {
        const key = JSON.stringify(params.spec.target);
        const prior = animPending.findIndex((p) => p.key === key);
        if (prior >= 0) animPending.splice(prior, 1)[0].resolve();
        return new Promise((resolve) => animPending.push({ key, resolve }));
      }
      return null;
    }
    if (method === 'animations.cancel') {
      const key = JSON.stringify(params.target);
      const prior = animPending.findIndex((p) => p.key === key);
      if (prior >= 0) animPending.splice(prior, 1)[0].resolve();
      return null;
    }
    throw new Error(`no handler for '${method}'`);
  }

  await withRuntime({
    bus: pluginBus,
    onRequest: (plugin, method, params) => {
      if (method === 'windows.set-islands') setIslandsCalls.push(params);
      if (method.startsWith('windows.')) {
        const r = broker(plugin, method, params);
        if (r === WINDOWS_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      if (method.startsWith('animations.')) return handleAnimations(method, params);
      throw new Error(`no handler for '${method}'`);
    },
  }, async (rt) => {
    runtime = rt;
    // Mirror the production bundled spec: configFrom merges the runtime
    // context (output geometry seed) with the user's canvas slice.
    const spec = {
      ...canvasSpec,
      configFrom: (cfg, rtCtx) => ({
        fallbackOutputId: -1, fallbackOutputName: '',
        bootOutputDurableKey: rtCtx.bootOutputDurableKey,
        initialOutputs: rtCtx.initialOutputs,
        canvas: cfg.canvas,
        layoutGap: cfg.layout?.gap,
        layoutMode: cfg.layout?.mode,
      }),
    };
    const cfg = {
      output: null, focus: null, hotkeys: undefined, actions: undefined,
      plugins: [], sourcePath: null,
      canvas: opts.canvas ?? (opts.world ? { world: true } : {}),
      layout: opts.layout,
    };
    const rtCtx = {
      bootOutputDurableKey: 'mock-0',
      initialOutputs: [{
        outputId: 0, name: 'mock-0', edidId: '',
        x: 0, y: 0, width: 800, height: 600, scale: 1,
      }],
    };
    await rt.load([
      bundledToResolved(layoutSpec, layoutSpec.module, cfg, rtCtx),
      bundledToResolved(spec, spec.module, cfg, rtCtx),
    ]);
    await rt.waitForNamespace('layout');
    await rt.waitForNamespace('workspace');
    await fn({
      rt, sink, wm, wsEvents, seatCalls, layoutSnapshots, animCalls, animPending,
      pluginBus, seat, state, setIslandsCalls,
      layoutApply: () => layoutApply,
      islands() { return layoutSnapshots.at(-1)?.islands ?? []; },
      addWindow(id, { place } = {}) {
        wm.addWindow(id, res(id));
        wm.windowHasContent(id);
        // Placement rules stamp this bag key during preconfigure (before
        // the map); tests set it directly on the WM.
        if (place) wm.setState(id, 'workspace.place', place);
        bus.emit(WINDOW_EVENT.map, {
          surfaceId: id, outputId: 0,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          appId: null, title: null,
        });
      },
      unmapWindow(id) {
        bus.emit(WINDOW_EVENT.unmap, { surfaceId: id });
      },
    });
  });
}

function call(rt, method, args) {
  return rt.invokeNamespace('workspace', method, args);
}

const settle = () => new Promise((r) => setTimeout(r, 50));

// ---- workspace-surface parity ----------------------------------------------

test('canvas: workspace 1 exists at init; list reports it', async () => {
  await withCanvasPlugin(async ({ rt, wsEvents }) => {
    const snaps = await call(rt, 'list', [0]);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].index, 1);
    assert.deepEqual(snaps[0].members, []);
    assert.ok(wsEvents.some((e) => e.name === 'workspace.created'
      && e.payload.index === 1));
  });
});

test('canvas: mapped window joins workspace 1 and pushes setOutputStack', async () => {
  await withCanvasPlugin(async ({ rt, sink, addWindow }) => {
    addWindow(101);
    await settle();
    const snaps = await call(rt, 'list', [0]);
    assert.deepEqual(snaps[0].members, [101]);
    assert.ok(sink.outputStackCalls.some((c) =>
      c.outputId === 0 && JSON.stringify(c.ids) === '[101]'),
      `expected [101] push; got ${JSON.stringify(sink.outputStackCalls)}`);
  });
});

test('canvas: show pushes the new stack, emits hidden+shown, dispatches focus', async () => {
  await withCanvasPlugin(async ({ rt, sink, wsEvents, seatCalls, addWindow }) => {
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    sink.outputStackCalls.length = 0;
    wsEvents.length = 0;
    seatCalls.focus.length = 0;

    await call(rt, 'show', [2, 0]);
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [] });
    assert.ok(wsEvents.some((e) => e.name === 'workspace.hidden' && e.payload.index === 1));
    assert.ok(wsEvents.some((e) => e.name === 'workspace.shown' && e.payload.index === 2));
    assert.ok(seatCalls.focus.some((f) => f.kind === 'dispatch'));
  });
});

test('canvas: moveWindow relocates membership and restacks', async () => {
  await withCanvasPlugin(async ({ rt, addWindow }) => {
    addWindow(101);
    addWindow(102);
    await settle();
    await call(rt, 'create', [{}]);
    await call(rt, 'moveWindow', [101, 2, 0]);
    const snaps = await call(rt, 'list', [0]);
    assert.deepEqual(snaps[0].members, [102]);
    assert.deepEqual(snaps[1].members, [101]);
  });
});

// The member order IS the column order in columns mode, so a new window
// belongs on the right -- the strip reads left to right in the order things
// opened. Master-stack's head is its master slot, where a new window is
// meant to land, so the end follows the DECLARED MODE rather than growth.
test('columns: a newly mapped window joins at the tail, not the master slot', async () => {
  await withCanvasPlugin(async ({ rt, addWindow }) => {
    for (const id of [101, 102, 103]) { addWindow(id); await settle(); }
    const list = await call(rt, 'list', [0]);
    assert.deepEqual(list[0].members, [101, 102, 103],
      'each new window appends to the right of the strip');
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

test('master-stack: a newly mapped window still takes the master slot', async () => {
  await withCanvasPlugin(async ({ rt, addWindow }) => {
    for (const id of [101, 102, 103]) { addWindow(id); await settle(); }
    const list = await call(rt, 'list', [0]);
    assert.deepEqual(list[0].members, [103, 102, 101],
      'the newest window heads the list');
  }, { canvas: { world: true }, layout: { mode: 'master-stack' } });
});

// The mode is declared per island, so an island that declares columns
// appends while its master-stack neighbor on the same output still unshifts.
test('columns: the insertion end follows the island that declares it', async () => {
  await withCanvasPlugin(async ({ rt, addWindow }) => {
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await call(rt, 'show', [2, 0]);
    await rt.invokeAction('workspace.set-layout',
      { index: 2, mode: 'master-stack' });
    await settle();
    for (const id of [102, 103]) { addWindow(id); await settle(); }
    await call(rt, 'show', [1, 0]);
    await settle();
    for (const id of [104, 105]) { addWindow(id); await settle(); }

    const list = await call(rt, 'list', [0]);
    assert.deepEqual(list[0].members, [101, 104, 105],
      'the columns island appends');
    assert.deepEqual(list[1].members, [103, 102],
      'the master-stack island unshifts');
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

test('canvas: reorder promote reorders the member list', async () => {
  await withCanvasPlugin(async ({ rt, addWindow }) => {
    addWindow(101);
    addWindow(102);   // unshifts to master: order [102, 101]
    await settle();
    const changed = await call(rt, 'reorder', [101, 'promote']);
    assert.equal(changed, true);
    const snaps = await call(rt, 'list', [0]);
    assert.deepEqual(snaps[0].members, [101, 102]);
  });
});

test('canvas: ensureOutput is idempotent and returns the shown workspace', async () => {
  await withCanvasPlugin(async ({ rt }) => {
    const a = await call(rt, 'ensureOutput', [0]);
    const b = await call(rt, 'ensureOutput', [0]);
    assert.equal(a.handle, b.handle);
    const snaps = await call(rt, 'list', [0]);
    assert.equal(snaps.length, 1);
  });
});

// ---- island publication ------------------------------------------------------

test('canvas: shown workspace is published as an explicit island (id = handle)', async () => {
  await withCanvasPlugin(async ({ rt, islands, addWindow }) => {
    addWindow(101);
    await settle();
    const list = await call(rt, 'list', [0]);
    const shownHandle = list[0].handle;
    const isl = islands();
    assert.equal(isl.length, 1);
    assert.equal(isl[0].id, shownHandle);
    assert.equal(isl[0].contextOutputId, 0);
    assert.equal(isl[0].rect, null);
    assert.deepEqual(isl[0].members, [101]);
  });
});

test('canvas: show swaps the island to the new workspace handle + members', async () => {
  await withCanvasPlugin(async ({ rt, islands, addWindow }) => {
    addWindow(100);   // anchors ws1 (empty hidden workspaces evaporate)
    addWindow(101);
    await settle();
    const created = await call(rt, 'create', [{}]);
    await call(rt, 'show', [2, 0]);
    let isl = islands();
    assert.equal(isl.length, 1);
    assert.equal(isl[0].id, created.handle);
    assert.deepEqual(isl[0].members, []);

    // Move the window over; the island's members track the stack push.
    await call(rt, 'moveWindow', [101, 2, 0]);
    isl = islands();
    assert.equal(isl[0].id, created.handle);
    assert.deepEqual(isl[0].members, [101]);

    // Switch back: island id returns to workspace 1's handle.
    await call(rt, 'show', [1, 0]);
    const list = await call(rt, 'list', [0]);
    isl = islands();
    assert.equal(isl[0].id, list[0].handle);
    assert.deepEqual(isl[0].members, [100]);
  });
});

test('canvas: island members mirror unmap', async () => {
  await withCanvasPlugin(async ({ islands, addWindow, unmapWindow }) => {
    addWindow(101);
    addWindow(102);
    await settle();
    assert.deepEqual(islands()[0].members, [102, 101]);
    unmapWindow(102);
    await settle();
    assert.deepEqual(islands()[0].members, [101]);
  });
});

// ---- world mode ---------------------------------------------------------
// Slot pitch for the 800-wide mock output (SLOT_GUTTER = 128).
const PITCH = 800 + 128;

test('world: every workspace publishes an island at its slot rect', async () => {
  await withCanvasPlugin(async ({ rt, islands, addWindow }) => {
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await settle();

    const isl = islands();
    assert.equal(isl.length, 2);
    const list = await call(rt, 'list', [0]);
    const byId = new Map(isl.map((i) => [i.id, i]));
    const ws1 = byId.get(list[0].handle);
    const ws2 = byId.get(list[1].handle);
    // Workspace 1 at slot 0 (the arrangement rect), workspace 2 one pitch over.
    assert.deepEqual(ws1.rect, { x: 0, y: 0, width: 800, height: 600 });
    assert.deepEqual(ws2.rect, { x: PITCH, y: 0, width: 800, height: 600 });
    // Hidden workspaces publish too; members carry through.
    assert.deepEqual(ws1.members, [101]);
    assert.deepEqual(ws2.members, []);
  }, { world: true });
});

test('world: overlapping publishWorld triggers coalesce into sequential passes', async () => {
  await withCanvasPlugin(async ({ pluginBus, setIslandsCalls, addWindow }) => {
    addWindow(101);
    await settle();
    const before = setIslandsCalls.length;
    // Five triggers in one tick while the first pass is parked on its
    // awaits: one active pass plus one coalesced rerun, never five
    // interleaved runs racing their set-islands pushes.
    for (let i = 0; i < 5; i++) {
      pluginBus.emit('output.workarea-changed', { outputId: 0 });
    }
    await settle();
    const passes = setIslandsCalls.length - before;
    assert.ok(passes >= 1 && passes <= 2,
      `expected 1-2 coalesced publish passes, saw ${passes}`);
  }, { world: true });
});

test('world: a zoomed window moved onto an island with a zoomed member demotes the incumbent', async () => {
  await withCanvasPlugin(async ({ rt, wm, addWindow }) => {
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await settle();
    addWindow(102);
    await settle();
    await call(rt, 'moveWindow', [102, 2, 0]);
    await settle();
    await wm.propose(101, { sizeMode: 'maximized' }, 'user-input');
    await wm.propose(102, { sizeMode: 'maximized' }, 'user-input');
    await settle();
    // Two islands, one zoomed member each. Moving zoomed 102 into 101's
    // island demotes the incumbent; the arrival keeps its zoom.
    await call(rt, 'moveWindow', [102, 1, 0]);
    await settle();
    assert.equal(wm.getWindowState(102).sizeMode, 'maximized');
    assert.equal(wm.getWindowState(101).sizeMode, 'none');
  }, { world: true });
});

test('world: a zoomed window moved across outputs unzooms; source activity is dropped', async () => {
  await withCanvasPlugin(async ({ rt, wm, addWindow, pluginBus }) => {
    pluginBus.emit('output.changed', {
      outputId: 1, name: 'mock-1', edidId: '',
      x: 800, y: 0, width: 800, height: 600, scale: 1,
    });
    await call(rt, 'ensureOutput', [1]);
    addWindow(101);
    addWindow(102);
    await settle();
    // 102 is output 0's active window and zooms there.
    pluginBus.emit('window.change',
      { surfaceId: 102, activated: true, changed: ['activated'] });
    await settle();
    await wm.propose(102, { sizeMode: 'maximized' }, 'user-input');
    await settle();
    assert.equal(wm.getWindowState(102).sizeMode, 'maximized');
    // Zoom is output-local activity: crossing outputs releases it.
    await call(rt, 'moveWindow', [102, 1, 1]);
    await settle();
    assert.equal(wm.getWindowState(102).sizeMode, 'none');
    // The move also dropped output 0's stale activity record naming 102.
    // Re-zoom 102 on output 1, then activate on output 0: the edge there
    // must not demote a window living on another output.
    await wm.propose(102, { sizeMode: 'maximized' }, 'user-input');
    await settle();
    pluginBus.emit('window.change',
      { surfaceId: 101, activated: true, changed: ['activated'] });
    await settle();
    assert.equal(wm.getWindowState(102).sizeMode, 'maximized');
  }, { world: true });
});

test('world: show docks the camera on the shown slot; hidden members stay published', async () => {
  await withCanvasPlugin(async ({ rt, sink, islands, addWindow }) => {
    addWindow(100);   // anchors ws1 (empty hidden workspaces evaporate)
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await call(rt, 'moveWindow', [101, 2, 0]);
    await settle();

    // 101 now lives on hidden workspace 2: island at slot 1 keeps it as a
    // member (laid out at its slot) while the stack excludes it.
    const list = await call(rt, 'list', [0]);
    const isl = islands();
    const ws2Island = isl.find((i) => i.id === list[1].handle);
    assert.deepEqual(ws2Island.members, [101]);
    assert.equal(ws2Island.rect.x, PITCH);
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [100] });

    // Show workspace 2: camera docks at its slot.
    sink.cameraCalls.length = 0;
    await call(rt, 'show', [2, 0]);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });

    // Back to workspace 1: camera returns to the row origin.
    await call(rt, 'show', [1, 0]);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });
  }, { world: true });
});

test('world: destroying a workspace frees its slot for the next one', async () => {
  await withCanvasPlugin(async ({ rt, islands }) => {
    await call(rt, 'create', [{}]);   // ws2 -> slot 1
    await call(rt, 'destroy', [2, 0]);
    await call(rt, 'create', [{}]);   // new ws2 -> reuses slot 1
    await settle();
    const isl = islands();
    const xs = isl.map((i) => i.rect.x).sort((a, b) => a - b);
    assert.deepEqual(xs, [0, PITCH]);
  }, { world: true });
});

test('world: create-on-reference show docks the camera on the fresh slot', async () => {
  await withCanvasPlugin(async ({ rt, sink, addWindow }) => {
    addWindow(101);   // anchors ws1
    await settle();
    sink.cameraCalls.length = 0;
    await rt.invokeAction('workspace.show', { name: '2' });
    const list = await call(rt, 'list', [0]);
    assert.equal(list.length, 2);
    assert.equal(list[1].name, '2');
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });
  }, { world: true });
});

// ---- world mode: camera flights ------------------------------------------
// A show with a `transition` flies the camera instead of teleporting:
// union stack for the journey, tween on the output-camera target, settle
// = destination stack + one settled camera write + deferred focus.

// Two workspaces, one window each (101 on ws1, 102 on ws2), ws1 shown.
async function setupTwoIslands({ rt, addWindow }) {
  addWindow(101);
  await settle();
  await call(rt, 'create', [{}]);
  await call(rt, 'show', [2, 0]);
  addWindow(102);
  await settle();
  await call(rt, 'show', [1, 0]);
  await settle();
}

test('world: show with a transition flies (union stack, tween, settle at slot)', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, wsEvents, animCalls, animPending } = h;
    await setupTwoIslands(h);
    sink.outputStackCalls.length = 0;
    sink.cameraCalls.length = 0;
    wsEvents.length = 0;

    const p = call(rt, 'show', [2, 0, { kind: 'slide', duration: 200 }]);
    await settle();
    // Takeoff: the union of departure + destination stacks rides the
    // output, the tween targets the destination slot, and the registry
    // truth (bar highlight) flipped immediately -- no settled camera yet.
    assert.deepEqual(sink.outputStackCalls[0], { outputId: 0, ids: [101, 102] });
    assert.equal(animCalls.length, 1);
    assert.equal(animCalls[0].type, 'tween');
    assert.deepEqual(animCalls[0].target, { kind: 'output-camera', outputId: 0 });
    assert.deepEqual(animCalls[0].to, { x: PITCH, y: 0, zoom: 1 });
    assert.equal(animCalls[0].duration, 200);
    assert.ok(wsEvents.some((e) => e.name === 'workspace.shown' && e.payload.index === 2));
    assert.equal(sink.cameraCalls.length, 0);

    animPending.shift().resolve();
    await p;
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [102] });
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });
  }, { world: true, animations: 'manual' });
});

test('world: a newer flight preempts; the loser never settles', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, animCalls, animPending } = h;
    await setupTwoIslands(h);
    // Third island (window 103 on ws3) so the second flight has a
    // destination distinct from both the first's and the live camera.
    await call(rt, 'create', [{}]);
    await call(rt, 'show', [3, 0]);
    h.addWindow(103);
    await settle();
    await call(rt, 'show', [1, 0]);
    await settle();
    sink.outputStackCalls.length = 0;
    sink.cameraCalls.length = 0;

    const p1 = call(rt, 'show', [2, 0, { kind: 'slide', duration: 500 }]);
    await settle();
    const p2 = call(rt, 'show', [3, 0, { kind: 'slide', duration: 500 }]);
    await settle();
    // Flight 2 cancelled flight 1's leaf; flight 1 must abandon its
    // settle (no stack push to [102], no settled camera write).
    await p1;
    assert.equal(sink.cameraCalls.length, 0);
    // Flight 2's union keeps everything from the aborted journey visible.
    assert.deepEqual(sink.outputStackCalls.at(-1),
      { outputId: 0, ids: [101, 102, 103] });
    assert.equal(animCalls.at(-1).to.x, 2 * PITCH);

    animPending.shift().resolve();
    await p2;
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [103] });
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 2 * PITCH, y: 0, zoom: 1 });
  }, { world: true, animations: 'manual' });
});

test('world: an instant show cancels an in-progress flight and docks', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink } = h;
    await setupTwoIslands(h);
    sink.cameraCalls.length = 0;

    const p = call(rt, 'show', [2, 0, { kind: 'slide', duration: 500 }]);
    await settle();
    await call(rt, 'show', [1, 0]);   // instant: cancels the flight
    await p;                          // flight resolves without settling
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [101] });
  }, { world: true, animations: 'manual' });
});

test('world: a denied flight (grab active) falls back to an instant dock', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, animCalls } = h;
    await setupTwoIslands(h);
    sink.outputStackCalls.length = 0;
    sink.cameraCalls.length = 0;

    await call(rt, 'show', [2, 0, { kind: 'slide', duration: 200 }]);
    assert.equal(animCalls.length, 0);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [102] });
  }, { world: true, animations: 'deny' });
});

// ---- world mode: fit (zoom-out overview) ---------------------------------
// workspace.fit frames a consecutive workspace range: union stack, camera
// zoomed out + centered on the slots' bounding box, registry truth
// untouched. workspace.unfit zooms back in.

// Expected fit camera for slots [0..n-1] on the 800x600 mock output.
function fitCam(nSlots) {
  const boundsW = (nSlots - 1) * PITCH + 800;
  const zoom = Math.min(800 / boundsW, 1);
  return {
    outputId: 0,
    x: boundsW / 2 - (800 / zoom) / 2,
    y: (600 - 600 / zoom) / 2,
    zoom,
  };
}

test('world: fit frames the whole row (union stack + zoomed camera); registry untouched', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink } = h;
    await setupTwoIslands(h);   // 101 on ws1 (shown), 102 on ws2
    sink.outputStackCalls.length = 0;
    sink.cameraCalls.length = 0;

    await rt.invokeAction('workspace.fit', {});
    assert.deepEqual(sink.outputStackCalls[0], { outputId: 0, ids: [101, 102] });
    assert.deepEqual(sink.cameraCalls.at(-1), fitCam(2));
    const cur = await call(rt, 'current', [0]);
    assert.equal(cur.index, 1, 'shown workspace unchanged by fit');
  }, { world: true });
});

test('world: fit centers within the workarea (reserved zones respected)', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, state, addWindow } = h;
    // A bar reserves the top 100px of the 800x600 output.
    state.outputs = new Map([[0, {
      logicalPosition: { x: 0, y: 0 },
      logicalSize: { width: 800, height: 600 },
    }]]);
    state.reservedZones = {
      effectiveRect: (_id, r) => ({
        x: r.x, y: r.y + 100, width: r.width, height: r.height - 100,
      }),
    };
    await setupTwoIslands(h);
    sink.cameraCalls.length = 0;
    void addWindow;

    await rt.invokeAction('workspace.fit', {});
    // Islands are workarea-sized (800x500), so the bounds are
    // 0..1728 x 0..500. The zoom fits them into the 800x500 workarea
    // and the bounds center maps to the workarea center (x 400, y 350
    // in viewport coords) -- not the viewport center -- so the fitted
    // world sits below the bar.
    const boundsW = PITCH + 800;
    const zoom = Math.min(800 / boundsW, 500 / 500, 1);
    assert.deepEqual(sink.cameraCalls.at(-1), {
      outputId: 0,
      x: boundsW / 2 - (0 + 400) / zoom,
      y: 250 - (100 + 250) / zoom,
      zoom,
    });
  }, { world: true });
});

test('world: islands size to the workarea; the dock offsets them below the bar', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, state, islands, pluginBus } = h;
    // A bar reserves the top 100px of the 800x600 output.
    state.outputs = new Map([[0, {
      logicalPosition: { x: 0, y: 0 },
      logicalSize: { width: 800, height: 600 },
    }]]);
    state.reservedZones = {
      effectiveRect: (_id, r) => ({
        x: r.x, y: r.y + 100, width: r.width, height: r.height - 100,
      }),
    };
    await setupTwoIslands(h);

    // World rects carry no bar band: pure content, workarea-sized,
    // packed with only the gutter between them.
    const isl = islands();
    const list = await call(rt, 'list', [0]);
    const byId = new Map(isl.map((i) => [i.id, i]));
    assert.deepEqual(byId.get(list[0].handle).rect,
      { x: 0, y: 0, width: 800, height: 500 });
    assert.deepEqual(byId.get(list[1].handle).rect,
      { x: 800 + 128, y: 0, width: 800, height: 500 });

    // The dock aligns the island origin with the WORKAREA origin: the
    // camera sits 100px up so the island renders below the bar.
    sink.cameraCalls.length = 0;
    await call(rt, 'show', [2, 0]);
    assert.deepEqual(sink.cameraCalls.at(-1),
      { outputId: 0, x: 800 + 128, y: -100, zoom: 1 });

    // The bar unmaps: the zone clears, main.ts's registry hook emits
    // output.workarea-changed, and the world re-solves to full-viewport
    // islands with the camera re-docked at the slot itself.
    state.reservedZones = { effectiveRect: (_id, r) => ({ ...r }) };
    pluginBus.emit('output.workarea-changed', { outputId: 0 });
    await settle();
    const isl2 = islands();
    const byId2 = new Map(isl2.map((i) => [i.id, i]));
    assert.deepEqual(byId2.get(list[1].handle).rect,
      { x: 800 + 128, y: 0, width: 800, height: 600 });
    assert.deepEqual(sink.cameraCalls.at(-1),
      { outputId: 0, x: 800 + 128, y: 0, zoom: 1 });
  }, { world: true });
});

test('world: fit range validation', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt } = h;
    await setupTwoIslands(h);
    await assert.rejects(rt.invokeAction('workspace.fit', { start: 2, end: 1 }),
      /out of bounds/);
    await assert.rejects(rt.invokeAction('workspace.fit', { end: 3 }),
      /out of bounds/);
    await assert.rejects(rt.invokeAction('workspace.fit', { start: 0 }),
      /positive integer/);
  }, { world: true });
});

test('fit requires world mode', async () => {
  await withCanvasPlugin(async ({ rt }) => {
    await assert.rejects(rt.invokeAction('workspace.fit', {}), /world mode/);
    await assert.rejects(rt.invokeAction('workspace.unfit', {}), /world mode/);
  });
});

test('world: fitted stack tracks membership changes; camera refits on destroy', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, addWindow } = h;
    await setupTwoIslands(h);
    // Third workspace so destroy leaves a 2-workspace fit.
    await call(rt, 'create', [{}]);
    await call(rt, 'show', [3, 0]);
    addWindow(103);
    await settle();
    await call(rt, 'show', [1, 0]);
    await settle();

    await rt.invokeAction('workspace.fit', {});
    assert.deepEqual(sink.outputStackCalls.at(-1),
      { outputId: 0, ids: [101, 102, 103] });
    assert.deepEqual(sink.cameraCalls.at(-1), fitCam(3));

    // A window mapping onto the shown workspace joins the union (new
    // members lead their workspace's stack).
    sink.outputStackCalls.length = 0;
    addWindow(104);
    await settle();
    assert.deepEqual(sink.outputStackCalls.at(-1),
      { outputId: 0, ids: [104, 101, 102, 103] });

    // Destroying the last framed workspace shrinks the framing.
    sink.cameraCalls.length = 0;
    await call(rt, 'destroy', [3, 0]);
    await settle();
    assert.deepEqual(sink.cameraCalls.at(-1), fitCam(2));
  }, { world: true });
});

test('world: show exits the fit (stack collapses, camera docks at zoom 1)', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink } = h;
    await setupTwoIslands(h);
    await rt.invokeAction('workspace.fit', {});
    sink.cameraCalls.length = 0;

    await call(rt, 'show', [2, 0]);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [102] });
  }, { world: true });
});

test('world: unfit returns to the shown workspace without touching the registry', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, wsEvents } = h;
    await setupTwoIslands(h);
    await rt.invokeAction('workspace.fit', {});
    sink.cameraCalls.length = 0;
    wsEvents.length = 0;

    await rt.invokeAction('workspace.unfit', {});
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [101] });
    assert.equal(wsEvents.length, 0, 'no workspace events for an optics-only unfit');
    const cur = await call(rt, 'current', [0]);
    assert.equal(cur.index, 1);
  }, { world: true });
});

test('world: focus while fitted flips the shown workspace; unfit zooms into it', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, pluginBus, wsEvents } = h;
    await setupTwoIslands(h);
    await rt.invokeAction('workspace.fit', {});
    sink.cameraCalls.length = 0;
    wsEvents.length = 0;

    // Focus lands on 102 (framed, hidden ws2) while fitted -- click or
    // follow-pointer hover. The shown workspace follows focus (bar
    // highlight), but the fit's camera and union stack stay.
    pluginBus.emit('window.change',
      { surfaceId: 102, activated: true, changed: ['activated'] });
    await settle();
    assert.ok(wsEvents.some((e) => e.name === 'workspace.shown' && e.payload.index === 2),
      'shown follows focus while fitted');
    assert.equal(sink.cameraCalls.length, 0, 'camera stays fitted');
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [101, 102] },
      'union stack stays while fitted');
    const cur = await call(rt, 'current', [0]);
    assert.equal(cur.index, 2);

    // Unfit: ws2 is already shown, so this is the optics-only zoom-in
    // onto its slot.
    wsEvents.length = 0;
    await rt.invokeAction('workspace.unfit', {});
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [102] });
    assert.equal(wsEvents.length, 0, 'no extra show on unfit; truth already flipped');
  }, { world: true });
});

// unfit re-asserts the window focused at invoke time (unfitKeepsFocus,
// default on) instead of firing the workspace-changed policy decide --
// under follow-pointer that decide would hand focus to whatever the
// landing leaves under the stationary cursor.
test('world: unfit keeps the invoking focus instead of re-deciding', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, pluginBus, seatCalls } = h;
    await setupTwoIslands(h);
    // Focus 102 on the NON-shown ws2 (no fit override, so the shown
    // workspace does not follow): unfit's default target becomes ws2.
    pluginBus.emit('window.change',
      { surfaceId: 102, activated: true, changed: ['activated'] });
    await settle();
    seatCalls.focus.length = 0;

    await rt.invokeAction('workspace.unfit', {});
    await settle();
    assert.ok(seatCalls.focus.includes(102),
      `unfit re-asserts the invoking focus (got ${JSON.stringify(seatCalls.focus)})`);
    assert.ok(!seatCalls.focus.some(
      (c) => typeof c === 'object' && c !== null && c.reason === 'workspace-changed'),
      'no workspace-changed policy decide after unfit');
    const cur = await call(rt, 'current', [0]);
    assert.equal(cur.index, 2);
  }, { world: true });
});

// Unfit aims at the FINAL view: the focused window's reveal is folded
// into the strip scroll BEFORE the dock target is computed, so the
// camera lands directly on the hovered column instead of flying to the
// stale pre-fit scroll and snapping when the post-settle reveal fires.
test('world: unfit lands directly on the focused column (no fly-then-snap)', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, pluginBus, addWindow, layoutApply } = h;
    for (const id of [101, 102, 103]) { addWindow(id); await settle(); }
    await layoutApply().apply({ rects: [
      { id: 101, outer: { x: 0, y: 0, width: 400, height: 600 } },
      { id: 102, outer: { x: 400, y: 0, width: 400, height: 600 } },
      { id: 103, outer: { x: 800, y: 0, width: 400, height: 600 } },
    ] }, 'state-changed');
    await settle();
    // Focus the head column deliberately (visible; scroll stays 0), fit,
    // then hover the off-view tail column while fitted -- focus follows,
    // nothing scrolls (override gate).
    pluginBus.emit('window.change',
      { surfaceId: 101, activated: true, changed: ['activated'] });
    await settle();
    await rt.invokeAction('workspace.fit', {});
    pluginBus.emit('window.change',
      { surfaceId: 103, activated: true, changed: ['activated'],
        focusReason: 'pointer-enter' });
    await settle();
    sink.cameraCalls.length = 0;

    await rt.invokeAction('workspace.unfit', {});
    await settle();
    // The dock lands at the tail column's reveal (flush right, scroll
    // 400), not at the stale pre-fit scroll 0.
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 400, y: 0, zoom: 1 });
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

// unfitKeepsFocus: false restores the policy decide on unfit.
test('world: unfitKeepsFocus false fires the workspace-changed decide', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, pluginBus, seatCalls } = h;
    await setupTwoIslands(h);
    pluginBus.emit('window.change',
      { surfaceId: 102, activated: true, changed: ['activated'] });
    await settle();
    seatCalls.focus.length = 0;

    await rt.invokeAction('workspace.unfit', {});
    await settle();
    assert.ok(seatCalls.focus.some(
      (c) => typeof c === 'object' && c !== null && c.reason === 'workspace-changed'),
      `expected a workspace-changed decide (got ${JSON.stringify(seatCalls.focus)})`);
  }, { canvas: { world: true, unfitKeepsFocus: false } });
});

test('world: unfit with a different index behaves like show', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, wsEvents } = h;
    await setupTwoIslands(h);
    await rt.invokeAction('workspace.fit', {});
    sink.cameraCalls.length = 0;
    wsEvents.length = 0;

    await rt.invokeAction('workspace.unfit', { index: 2 });
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [102] });
    assert.ok(wsEvents.some((e) => e.name === 'workspace.shown' && e.payload.index === 2));
  }, { world: true });
});

test('world: fit with a transition tweens the camera; one settled write at arrival', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, animCalls, animPending } = h;
    await setupTwoIslands(h);
    sink.outputStackCalls.length = 0;
    sink.cameraCalls.length = 0;

    const p = rt.invokeAction('workspace.fit', { transition: { duration: 200 } });
    await settle();
    const cam = fitCam(2);
    // Union rides at takeoff; the tween targets the fit camera; nothing
    // settled yet.
    assert.deepEqual(sink.outputStackCalls[0], { outputId: 0, ids: [101, 102] });
    assert.equal(animCalls.length, 1);
    assert.deepEqual(animCalls[0].target, { kind: 'output-camera', outputId: 0 });
    assert.deepEqual(animCalls[0].to, { x: cam.x, y: cam.y, zoom: cam.zoom });
    assert.equal(sink.cameraCalls.length, 0);

    animPending.shift().resolve();
    await p;
    assert.deepEqual(sink.cameraCalls.at(-1), cam);
  }, { world: true, animations: 'manual' });
});

test('world: an instant show cancels an in-progress fit tween', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink } = h;
    await setupTwoIslands(h);
    sink.cameraCalls.length = 0;

    const p = rt.invokeAction('workspace.fit', { transition: { duration: 500 } });
    await settle();
    await call(rt, 'show', [2, 0]);   // instant: exits the fit, cancels the tween
    await p;                          // fit resolves without settling
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [102] });
  }, { world: true, animations: 'manual' });
});

// ---- world mode: free roaming + bookmarks ---------------------------------

test('world: pan enters free roaming (union stack, accumulating camera)', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, wsEvents } = h;
    await setupTwoIslands(h);
    sink.outputStackCalls.length = 0;
    sink.cameraCalls.length = 0;
    wsEvents.length = 0;

    await rt.invokeAction('workspace.pan', { dx: 200, dy: 50 });
    assert.deepEqual(sink.outputStackCalls[0], { outputId: 0, ids: [101, 102] },
      'every workspace rides the stack while roaming');
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 200, y: 50, zoom: 1 });
    assert.equal(wsEvents.length, 0, 'roaming does not touch registry truth');

    // A second pan accumulates from the live camera.
    await rt.invokeAction('workspace.pan', { dx: -50 });
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 150, y: 50, zoom: 1 });

    // A structural change keeps the parked camera (free cameras never
    // re-solve) and keeps the union stack.
    sink.cameraCalls.length = 0;
    h.addWindow(103);
    await settle();
    assert.equal(sink.cameraCalls.length, 0, 'free camera stays parked');
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [103, 101, 102] });
  }, { world: true });
});

test('world: zoom multiplies about the view center; pan scales by zoom', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink } = h;
    await setupTwoIslands(h);
    sink.cameraCalls.length = 0;

    // From identity, halving the zoom keeps the view center: the origin
    // shifts back by half the extra world the viewport now covers.
    await rt.invokeAction('workspace.zoom', { factor: 0.5 });
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: -400, y: -300, zoom: 0.5 });

    // A glass-px pan at zoom 0.5 moves twice the world distance.
    await rt.invokeAction('workspace.pan', { dx: 100 });
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: -200, y: -300, zoom: 0.5 });
  }, { world: true });
});

test('world: zoom clamps to min/max; a capped no-change zoom is a no-op', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink } = h;
    await setupTwoIslands(h);
    sink.cameraCalls.length = 0;
    sink.outputStackCalls.length = 0;

    // Docked at zoom 1, a zoom-in capped at 1 changes nothing -- no
    // camera write, and crucially no roaming override (stack untouched).
    await rt.invokeAction('workspace.zoom', { factor: 1.25, max: 1 });
    assert.equal(sink.cameraCalls.length, 0);
    assert.equal(sink.outputStackCalls.length, 0);

    // Zoom out, then a large zoom-in clamps to the max.
    await rt.invokeAction('workspace.zoom', { factor: 0.5 });
    assert.equal(sink.cameraCalls.at(-1).zoom, 0.5);
    await rt.invokeAction('workspace.zoom', { factor: 10, max: 1 });
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });

    // min clamps the other direction.
    await rt.invokeAction('workspace.zoom', { factor: 0.1, min: 0.4 });
    assert.equal(sink.cameraCalls.at(-1).zoom, 0.4);
  }, { world: true });
});

test('world: show and unfit exit free roaming', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink } = h;
    await setupTwoIslands(h);
    await rt.invokeAction('workspace.pan', { dx: 300, dy: 100 });
    sink.cameraCalls.length = 0;

    // show docks at the slot, stack collapses.
    await call(rt, 'show', [2, 0]);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [102] });

    // Roam again, unfit docks back onto the shown workspace.
    await rt.invokeAction('workspace.pan', { dx: -500 });
    sink.cameraCalls.length = 0;
    await rt.invokeAction('workspace.unfit', {});
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [102] });
  }, { world: true });
});

test('world: pan-grab enters free roaming and installs the seat grab; end settles', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, seat, wsEvents } = h;
    await setupTwoIslands(h);
    sink.outputStackCalls.length = 0;
    sink.cameraCalls.length = 0;
    wsEvents.length = 0;

    await rt.invokeAction('workspace.pan-grab', {});
    // Free roaming at the current camera: union stack, settled write of
    // the unchanged framing, seat grab installed.
    assert.deepEqual(sink.outputStackCalls[0], { outputId: 0, ids: [101, 102] });
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });
    assert.equal(seat.grab?.kind, 'camera-pan');
    assert.equal(seat.grab.outputId, 0);
    assert.deepEqual([seat.grab.lastX, seat.grab.lastY], [100, 100]);
    assert.equal(wsEvents.length, 0, 'registry truth untouched');

    // The seat pans transiently (mirror updated by core in production);
    // end releases the grab and adopts the settled camera.
    await rt.invokeAction('workspace.pan-grab-end', {});
    assert.equal(seat.grab, null);
    // Roaming continues: a show exits it and docks normally.
    await call(rt, 'show', [2, 0]);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: PITCH, y: 0, zoom: 1 });
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [102] });
  }, { world: true });
});

test('world: pan-grab backs out cleanly when another grab owns the pointer', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, seat } = h;
    await setupTwoIslands(h);
    seat.grab = { kind: 'move', surfaceId: 101 };   // a move grab is active
    sink.outputStackCalls.length = 0;
    sink.cameraCalls.length = 0;

    await rt.invokeAction('workspace.pan-grab', {});
    assert.equal(seat.grab.kind, 'move', 'existing grab untouched');
    // Backed out: stack collapsed to the shown workspace, camera re-docked.
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [101] });
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });
    seat.grab = null;
  }, { world: true });
});

test('world: bookmarks capture dock / fit / free framings and replay them', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, wsEvents } = h;
    await setupTwoIslands(h);

    // Docked on ws1: an island bookmark. From ws2, going back is a show.
    let r = await rt.invokeAction('workspace.bookmark-set', { name: 'home' });
    assert.equal(r.kind, 'island');
    await call(rt, 'show', [2, 0]);
    wsEvents.length = 0;
    await rt.invokeAction('workspace.bookmark-go', { name: 'home' });
    assert.ok(wsEvents.some((e) => e.name === 'workspace.shown' && e.payload.index === 1));
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });

    // Fitted: a range bookmark; going back re-fits.
    await rt.invokeAction('workspace.fit', {});
    r = await rt.invokeAction('workspace.bookmark-set', { name: 'both' });
    assert.equal(r.kind, 'range');
    await call(rt, 'show', [1, 0]);   // exit the fit
    sink.cameraCalls.length = 0;
    await rt.invokeAction('workspace.bookmark-go', { name: 'both' });
    assert.deepEqual(sink.cameraCalls.at(-1), fitCam(2));
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [101, 102] });

    // Roaming: a free bookmark; going back restores the exact camera.
    await rt.invokeAction('workspace.pan', { dx: 700, dy: -80 });
    r = await rt.invokeAction('workspace.bookmark-set', { name: 'spot' });
    assert.equal(r.kind, 'free');
    await rt.invokeAction('workspace.unfit', {});
    sink.cameraCalls.length = 0;
    await rt.invokeAction('workspace.bookmark-go', { name: 'spot' });
    const cam = sink.cameraCalls.at(-1);
    assert.equal(cam.zoom, fitCam(2).zoom);
    assert.equal(cam.x, 700 / fitCam(2).zoom);
    assert.equal(cam.y, fitCam(2).y - 80 / fitCam(2).zoom);

    // list + delete.
    const list = await rt.invokeAction('workspace.bookmark-list', {});
    assert.deepEqual(list.map((b) => b.name).sort(), ['both', 'home', 'spot']);
    const del = await rt.invokeAction('workspace.bookmark-delete', { name: 'spot' });
    assert.equal(del.deleted, true);
    await assert.rejects(rt.invokeAction('workspace.bookmark-go', { name: 'spot' }),
      /no bookmark/);
  }, { world: true });
});

// ---- world mode: elastic islands ------------------------------------------
// Growth and layout are orthogonal (canvas-design.md §5 "Layout mode is
// declared; growth only sizes the region"): `layout.mode` declares the
// algorithm, `canvas.elastic` only decides whether the island takes the
// layout's measured natural size (grow + camera-scroll within it) or
// stays workarea-sized (the same layout compresses into it).

test('elastic: islands grow to the layout measure and shove the row', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, islands, addWindow } = h;
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await call(rt, 'show', [2, 0]);
    addWindow(102);
    await settle();
    await call(rt, 'show', [1, 0]);
    await settle();

    // One managed member: a 400px column measures under the workarea, so
    // the island floors at it. The mode comes from the layout config, so
    // no per-island hint is published.
    const list = await call(rt, 'list', [0]);
    let isl = islands();
    const ws1 = isl.find((i) => i.id === list[0].handle);
    const ws2 = isl.find((i) => i.id === list[1].handle);
    assert.deepEqual(ws1.rect, { x: 0, y: 0, width: 800, height: 600 });
    assert.equal(ws1.layout, undefined);
    assert.deepEqual(ws2.rect, { x: 800 + 128, y: 0, width: 800, height: 600 });

    // Three managed members on ws1 -> 3 columns of 400 -> strip 1200;
    // ws2 is shoved right by the growth.
    addWindow(103);
    await settle();
    addWindow(104);
    await settle();
    isl = islands();
    assert.deepEqual(isl.find((i) => i.id === list[0].handle).rect,
      { x: 0, y: 0, width: 1200, height: 600 });
    assert.deepEqual(isl.find((i) => i.id === list[1].handle).rect,
      { x: 1200 + 128, y: 0, width: 800, height: 600 });

    // Showing ws2 docks at its shoved origin.
    sink.cameraCalls.length = 0;
    await call(rt, 'show', [2, 0]);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 1328, y: 0, zoom: 1 });
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

// Two apps side by side with a gap configured: the island must equal the
// workarea, so focusing between them never scrolls the camera. Measuring
// the gap bands into the strip instead leaves it 3 x gap too wide and the
// pair visibly drifts on and off the glass.
test('elastic: two 0.5 columns with a gap leave nothing offscreen', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, islands, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    const list = await call(rt, 'list', [0]);
    assert.deepEqual(islands().find((i) => i.id === list[0].handle).rect,
      { x: 0, y: 0, width: 800, height: 600 },
      'the island fits the glass exactly');

    // Focusing back and forth holds the camera still: with maxScroll 0
    // there is nothing to reveal.
    sink.cameraCalls.length = 0;
    for (const id of [101, 102, 101]) {
      h.pluginBus.emit('window.change',
        { surfaceId: id, activated: true, changed: ['activated'] });
      await settle();
    }
    const scrolled = sink.cameraCalls.filter((c) => c.x !== 0);
    assert.deepEqual(scrolled, [], 'no camera scroll between two fitting windows');
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns', gap: 10 } });
});

// A client that states a minimum wider than its share: the strip grows to
// hold it rather than handing it a column it cannot function in. The whole
// path runs -- window state -> measure-island -> the provider's measure()
// -> the published island rect.
test('elastic: a min-width window grows the strip instead of being squeezed', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, wm, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    const list = await call(rt, 'list', [0]);
    // Two 0.5 columns of an 800px glass fit exactly.
    assert.equal(islands().find((i) => i.id === list[0].handle).rect.width, 800);

    // 101 now needs 600px; its 400px column cannot hold it.
    await wm.propose(101, {
      constraints: { minSize: { width: 600, height: 0 }, maxSize: null },
    }, 'client-request');
    await settle();
    assert.equal(islands().find((i) => i.id === list[0].handle).rect.width, 1015,
      'the strip grew to seat the 600px floor (plus its gap allotment)');
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns', gap: 10 } });
});

test('elastic + master-stack: growth is inert (master-stack always fits)', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();
    // Elastic, but master-stack measures to the workarea: the island
    // never grows. A valid combination, not an error.
    const list = await call(rt, 'list', [0]);
    assert.deepEqual(islands().find((i) => i.id === list[0].handle).rect,
      { x: 0, y: 0, width: 800, height: 600 });
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'master-stack' } });
});

test('columns + fixed: even-split -- the same layout compressed into the workarea', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, layoutSnapshots, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();
    const list = await call(rt, 'list', [0]);
    // Fixed growth: the island stays workarea-sized however many
    // columns it holds...
    assert.deepEqual(islands().find((i) => i.id === list[0].handle).rect,
      { x: 0, y: 0, width: 800, height: 600 });
    // ...and the columns provider still tiles it (the driver would
    // compress the three equal columns into the 800px region).
    assert.equal(layoutSnapshots.at(-1).islands[0].members.length, 3);
  }, { canvas: { world: true, elastic: false }, layout: { mode: 'columns' } });
});

test('elastic: only tiled members take columns (floating never grows the strip)', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, wm, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();   // 3 managed -> strip 1200
    const list = await call(rt, 'list', [0]);
    assert.equal(islands().find((i) => i.id === list[0].handle).rect.width, 1200);

    // Floating one member shrinks the strip to 2 columns.
    await wm.propose(103, { tiling: 'floating' }, 'user-input');
    await settle();
    assert.equal(islands().find((i) => i.id === list[0].handle).rect.width, 800,
      '2 columns of 400 -> viewport-width island');
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

test('elastic: scroll reveals keep the layout gap visible (margin = gap)', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, pluginBus, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();
    // 3 columns of 0.5 measure to 1200 -- the gaps are carved out of the
    // columns (386/386/388 at x=10/406/802), never added around them, so
    // the strip is exactly 3 half-glass pitches. Viewport 800 ->
    // maxScroll 400.
    sink.cameraCalls.length = 0;

    // Reveal the RIGHTMOST column (right edge at island x + 1190). With
    // the gap margin the scroll clamps to maxScroll -- the island-edge
    // gap band stays visible -- instead of stopping 10px short.
    pluginBus.emit('window.change',
      { surfaceId: 101, activated: true, changed: ['activated'] });
    pluginBus.emit('stack.relayout', {
      reason: 'mapped',
      windows: [{
        surfaceId: 101, oldOuter: null, oldOutputId: 0,
        newOuter: { x: 802, y: 10, width: 388, height: 580 },
        newOutputId: 0, tiling: 'managed',
      }],
    });
    await settle();
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 400, y: 0, zoom: 1 });

    // Reveal the LEFTMOST column (x = island + 10): scroll returns to 0,
    // not 10 -- the left gap is never eaten.
    pluginBus.emit('window.change',
      { surfaceId: 103, activated: true, changed: ['activated'] });
    pluginBus.emit('stack.relayout', {
      reason: 'reorder',
      windows: [{
        surfaceId: 103, oldOuter: null, oldOutputId: 0,
        newOuter: { x: 10, y: 10, width: 386, height: 580 },
        newOutputId: 0, tiling: 'managed',
      }],
    });
    await settle();
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns', gap: 10 } });
});

// Focus-driven reveals are MINIMAL: a column already fully in view
// leaves the camera alone (focus cycling across visible columns must not
// shift the strip); an off-view column scrolls just enough to sit flush
// at the edge it entered from. Centering is reserved for pointer commits
// (a press, workspace.reveal).
test('elastic: focus reveals minimally; visible columns leave the camera', async () => {
  await withCanvasPlugin(async (h) => {
    const { sink, pluginBus, addWindow } = h;
    for (const id of [101, 102, 103]) { addWindow(id); await settle(); }
    // Strip 1200 (3 x 400), viewport 800 -> 400px of scroll to spend.
    const focus = async (surfaceId, x) => {
      pluginBus.emit('window.change',
        { surfaceId, activated: true, changed: ['activated'] });
      pluginBus.emit('stack.relayout', {
        reason: 'reorder',
        windows: [{
          surfaceId, oldOuter: null, oldOutputId: 0,
          newOuter: { x, y: 0, width: 400, height: 600 },
          newOutputId: 0, tiling: 'managed',
        }],
      });
      await settle();
    };

    // Middle column (400..800) is fully visible at scroll 0: no move.
    sink.cameraCalls.length = 0;
    await focus(102, 400);
    assert.equal(sink.cameraCalls.length, 0,
      'focusing a fully visible column must not scroll');
    // Tail column (800..1200) is off-view: flush right, minimal.
    await focus(103, 800);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 400, y: 0, zoom: 1 },
      'an off-view column scrolls flush to the edge it entered from');
    // Middle column again: fully visible at scroll 400 too -- no move.
    sink.cameraCalls.length = 0;
    await focus(102, 400);
    assert.equal(sink.cameraCalls.length, 0);
    // Head column (0..400): off-view at scroll 400 -> flush left.
    await focus(101, 0);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

// default: true on a declared workspace makes it the initially shown one
// on its output; the auto-created unnamed boot workspace (empty,
// non-persistent, no longer shown) evaporates, so the output boots
// straight onto the declared set.
test('world: a declared workspace with default: true is the boot-shown one', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt } = h;
    const cur = await rt.invokeAction('workspace.current', {});
    assert.equal(cur.name, 'main');
    const list = await rt.invokeAction('workspace.list', {});
    assert.deepEqual(list.map((w) => w.name), ['main'],
      'the unnamed boot workspace evaporated');
  }, { canvas: { world: true, workspaces: [{ name: 'main', default: true }] } });
});

// Declared per-position column widths (canvas.workspaces layout.columns)
// flow to the layout provider as the island hint, and workspace.current
// reports the effective fractions back in the same shape -- the
// resize-then-extract round trip (`overdrawctl invoke workspace.current`
// -> paste into the config workspaces entry).
test('world: declared columns publish as the island hint and extract via workspace.current', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, addWindow, islands } = h;
    // The declared workspace exists from boot; show it so the mapped
    // windows join it (the harness's output starts on its own default
    // workspace).
    const list = await rt.invokeAction('workspace.list', {});
    const main = list.find((w) => w.name === 'main');
    assert.ok(main, 'declared workspace exists from boot');
    await call(rt, 'show', [main.index, 0]);
    await settle();
    addWindow(101); await settle();
    addWindow(102); await settle();
    addWindow(103); await settle();

    const cur = await rt.invokeAction('workspace.current', {});
    assert.equal(cur.name, 'main');
    assert.deepEqual(cur.members.length, 3);
    // Effective fractions: positional hint for the first two, island
    // default for the third.
    assert.deepEqual(cur.columns, [0.25, 0.6, 0.5]);

    // The island hint published to the layout driver carries the array.
    const isl = islands().find((i) => i.members.includes(101));
    assert.deepEqual(isl?.layout, { mode: 'columns', columns: [0.25, 0.6] });

    // A user resize pins window 102; extraction reflects it.
    await rt.invokeNamespace('layout', 'setParams',
      [{ surfaceId: 102, widthDelta: 0.15 }]);
    const cur2 = await rt.invokeAction('workspace.current', {});
    assert.deepEqual(cur2.columns, [0.25, 0.75, 0.5]);
  }, {
    canvas: {
      world: true, elastic: true,
      workspaces: [
        { name: 'main', layout: { mode: 'columns', columns: [0.25, 0.6] } },
      ],
    },
    layout: { mode: 'columns', column: 0.5 },
  });
});

// Hover-driven focus (focusReason "pointer-enter") must not move the
// camera: the strip scrolls only on deliberate focus (click, keyboard,
// workspace switch), a press, or an explicit workspace.reveal.
test('elastic: hover focus never scrolls; a press or workspace.reveal does', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, pluginBus, addWindow, layoutApply } = h;
    for (const id of [101, 102, 103]) { addWindow(id); await settle(); }
    // Real column rects in the WM (3 x 400 across the 1200 strip): the
    // press/reveal paths read them via windows.get.
    await layoutApply().apply({ rects: [
      { id: 101, outer: { x: 0, y: 0, width: 400, height: 600 } },
      { id: 102, outer: { x: 400, y: 0, width: 400, height: 600 } },
      { id: 103, outer: { x: 800, y: 0, width: 400, height: 600 } },
    ] }, 'state-changed');
    await settle();

    // Deliberate focus on the off-view tail column: minimal flush reveal.
    pluginBus.emit('window.change',
      { surfaceId: 103, activated: true, changed: ['activated'] });
    await settle();
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 400, y: 0, zoom: 1 });
    sink.cameraCalls.length = 0;

    // Hover onto the (off-view) head column: focus follows the pointer,
    // the camera stays.
    pluginBus.emit('window.change',
      { surfaceId: 101, activated: true, changed: ['activated'],
        focusReason: 'pointer-enter' });
    await settle();
    assert.equal(sink.cameraCalls.length, 0, 'hover focus must not scroll the strip');

    // A repick (world moved under the stationary cursor) is equally inert.
    pluginBus.emit('window.change',
      { surfaceId: 101, activated: true, changed: ['activated'],
        focusReason: 'pointer-repick' });
    await settle();
    assert.equal(sink.cameraCalls.length, 0, 'repick focus must not scroll the strip');

    // A press commits to the head column: it reveals (flush left).
    pluginBus.emit('pointer.pressed', { surfaceId: 101 });
    await settle();
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });
    sink.cameraCalls.length = 0;

    // A press on a fully VISIBLE column still centers -- clicks commit
    // to the column, unlike focus-driven reveals which are minimal.
    pluginBus.emit('pointer.pressed', { surfaceId: 102 });
    await settle();
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 200, y: 0, zoom: 1 });
    sink.cameraCalls.length = 0;

    // workspace.reveal scrolls to an explicit column (tail -> flush right).
    await rt.invokeAction('workspace.reveal', { surfaceId: 103 });
    await settle();
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 400, y: 0, zoom: 1 });
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

// scrollOnHover: true restores hover-driven strip scroll (the previous
// default): a pointer-enter focus centers its column like any other focus.
test('elastic: scrollOnHover opts back into hover-driven scroll', async () => {
  await withCanvasPlugin(async (h) => {
    const { sink, pluginBus, addWindow, layoutApply } = h;
    for (const id of [101, 102, 103]) { addWindow(id); await settle(); }
    await layoutApply().apply({ rects: [
      { id: 101, outer: { x: 0, y: 0, width: 400, height: 600 } },
      { id: 102, outer: { x: 400, y: 0, width: 400, height: 600 } },
      { id: 103, outer: { x: 800, y: 0, width: 400, height: 600 } },
    ] }, 'state-changed');
    await settle();
    sink.cameraCalls.length = 0;
    pluginBus.emit('window.change',
      { surfaceId: 102, activated: true, changed: ['activated'],
        focusReason: 'pointer-enter' });
    await settle();
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 200, y: 0, zoom: 1 });
  }, { canvas: { world: true, elastic: true, scrollOnHover: true },
     layout: { mode: 'columns' } });
});

test('elastic: the docked camera scrolls to keep the focused window visible', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, pluginBus, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();   // strip 1200, viewport 800
    sink.cameraCalls.length = 0;

    // Focus 101 and deliver its post-layout rect at the strip's right
    // end (the retile stream): the camera scrolls minimally to reveal it.
    pluginBus.emit('window.change',
      { surfaceId: 101, activated: true, changed: ['activated'] });
    pluginBus.emit('stack.relayout', {
      reason: 'mapped',
      windows: [{
        surfaceId: 101, oldOuter: null, oldOutputId: 0,
        newOuter: { x: 800, y: 0, width: 400, height: 600 },
        newOutputId: 0, tiling: 'managed',
      }],
    });
    await settle();
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 400, y: 0, zoom: 1 });

    // Focus moves to the window at the strip's head: the camera
    // scrolls back to reveal it.
    pluginBus.emit('window.change',
      { surfaceId: 103, activated: true, changed: ['activated'] });
    pluginBus.emit('stack.relayout', {
      reason: 'reorder',
      windows: [{
        surfaceId: 103, oldOuter: null, oldOutputId: 0,
        newOuter: { x: 0, y: 0, width: 400, height: 600 },
        newOutputId: 0, tiling: 'managed',
      }],
    });
    await settle();
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });

    // fit frames the whole strip (bounds from the grown rect).
    sink.cameraCalls.length = 0;
    await rt.invokeAction('workspace.fit', {});
    assert.equal(sink.cameraCalls.at(-1).zoom, 800 / 1200);
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

test('elastic: per-workspace opt-in via workspace.set-elastic (fixed default)', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await call(rt, 'show', [2, 0]);
    addWindow(102);
    await settle();
    await call(rt, 'show', [1, 0]);
    await settle();
    addWindow(103);
    await settle();
    addWindow(104);
    await settle();

    // elastic: false -> ws1 stays a fixed viewport-sized island, its 3
    // managed members notwithstanding (they compress into it).
    const list = await call(rt, 'list', [0]);
    let ws1 = islands().find((i) => i.id === list[0].handle);
    assert.deepEqual(ws1.rect, { x: 0, y: 0, width: 800, height: 600 });

    // Toggle the shown workspace elastic: 3 columns -> strip 1200; the
    // neighbor shoves right; ws2 itself stays fixed.
    let r = await rt.invokeAction('workspace.set-elastic', {});
    assert.equal(r.elastic, true);
    ws1 = islands().find((i) => i.id === list[0].handle);
    assert.deepEqual(ws1.rect, { x: 0, y: 0, width: 1200, height: 600 });
    const ws2 = islands().find((i) => i.id === list[1].handle);
    assert.equal(ws2.rect.x, 1200 + 128);
    assert.equal(ws2.rect.width, 800);

    // Toggle back: fixed again.
    r = await rt.invokeAction('workspace.set-elastic', {});
    assert.equal(r.elastic, false);
    ws1 = islands().find((i) => i.id === list[0].handle);
    assert.deepEqual(ws1.rect, { x: 0, y: 0, width: 800, height: 600 });

    // Explicit index + elastic flag.
    r = await rt.invokeAction('workspace.set-elastic', { index: 2, elastic: true });
    assert.equal(r.elastic, true);
    await assert.rejects(
      rt.invokeAction('workspace.set-elastic', { index: 9 }), /out of bounds/);
  }, { canvas: { world: true, elastic: false }, layout: { mode: 'columns' } });
});

test('elastic: default-on config can opt one workspace back to fixed', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();   // strip 1200 by default
    const list = await call(rt, 'list', [0]);
    assert.equal(islands().find((i) => i.id === list[0].handle).rect.width, 1200);

    const r = await rt.invokeAction('workspace.set-elastic', { elastic: false });
    assert.equal(r.elastic, false);
    const ws1 = islands().find((i) => i.id === list[0].handle);
    assert.equal(ws1.rect.width, 800, 'compresses back to the viewport');
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

// ---- declared layout mode (workspace.set-layout) ---------------------------

test('set-layout: declares one workspace\'s mode; growth follows the new measure', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();

    // Global config is master-stack: elastic growth is inert.
    const list = await call(rt, 'list', [0]);
    assert.equal(islands().find((i) => i.id === list[0].handle).rect.width, 800);

    // Declare THIS workspace columns: the hint publishes, and the island
    // grows to the columns measure (3 x 400).
    let r = await rt.invokeAction('workspace.set-layout', { mode: 'columns' });
    assert.equal(r.mode, 'columns');
    let ws1 = islands().find((i) => i.id === list[0].handle);
    assert.deepEqual(ws1.layout, { mode: 'columns' });
    assert.equal(ws1.rect.width, 1200);

    // A per-island column fraction rides the hint and re-measures.
    r = await rt.invokeAction('workspace.set-layout', { mode: 'columns', column: 0.25 });
    ws1 = islands().find((i) => i.id === list[0].handle);
    assert.deepEqual(ws1.layout, { mode: 'columns', column: 0.25 });
    assert.equal(ws1.rect.width, 800, '3 x 200 measures under the workarea -> floors');

    // Clearing the override falls back to the configured default mode.
    r = await rt.invokeAction('workspace.set-layout', {});
    assert.equal(r.mode, null);
    ws1 = islands().find((i) => i.id === list[0].handle);
    assert.equal(ws1.layout, undefined);
    assert.equal(ws1.rect.width, 800);

    await assert.rejects(
      rt.invokeAction('workspace.set-layout', { mode: 'bogus' }), /master-stack/);
    await assert.rejects(
      rt.invokeAction('workspace.set-layout', { index: 9, mode: 'columns' }),
      /out of bounds/);
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'master-stack' } });
});

test('set-layout: per-workspace declaration beats the config default both ways', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();
    const list = await call(rt, 'list', [0]);
    // Config default is columns -> grown.
    assert.equal(islands().find((i) => i.id === list[0].handle).rect.width, 1200);
    // Declaring master-stack on it collapses the growth (inert measure).
    await rt.invokeAction('workspace.set-layout', { mode: 'master-stack' });
    const ws1 = islands().find((i) => i.id === list[0].handle);
    assert.deepEqual(ws1.layout, { mode: 'master-stack' });
    assert.equal(ws1.rect.width, 800);
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

test('column resize: grow-column widens the focused window and re-measures the strip', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow, pluginBus } = h;
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    const list = await call(rt, 'list', [0]);
    // 2 columns of 400 -> measures 800, floors at the workarea.
    assert.equal(islands().find((i) => i.id === list[0].handle).rect.width, 800);

    // The launcher routes layout.column-width-requested -> setParams;
    // this harness has no launcher, so drive the namespace directly and
    // emit the params-changed the launcher would.
    await rt.invokeNamespace('layout', 'setParams', [{ surfaceId: 101, widthDelta: 0.5 }]);
    pluginBus.emit('layout.params-changed', {});
    await settle();
    // 101 is now a full-workarea column: 800 + 400 = 1200.
    assert.equal(islands().find((i) => i.id === list[0].handle).rect.width, 1200);
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

// ---- placement rules (workspace.place state-bag hint) ---------------------
// plugin-window-rules stamps { name?, output?, show? } during preconfigure;
// the canvas map handler is the placement resolver.

test('placement: a named hint creates the workspace and places quietly', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, wm, addWindow } = h;
    addWindow(101);   // anchors ws1 (shown)
    await settle();
    sink.cameraCalls.length = 0;
    sink.outputStackCalls.length = 0;

    // Hinted map: workspace "comms" doesn't exist -> created (hidden),
    // window lands there, shown workspace and camera untouched.
    addWindow(102, { place: { name: 'comms' } });
    await settle();
    const list = await call(rt, 'list', [0]);
    assert.equal(list.length, 2);
    const comms = list.find((w) => w.name === 'comms');
    assert.ok(comms, 'created on reference');
    assert.deepEqual(comms.members, [102]);
    const cur = await call(rt, 'current', [0]);
    assert.equal(cur.index, 1, 'placement is quiet');
    assert.equal(sink.cameraCalls.length, 0, 'camera never moved');
    assert.ok(!sink.outputStackCalls.some((c) => c.ids?.includes(102)),
      'quiet placement never stacks the window');
    assert.equal(wm.getState(102, 'workspace.place'), undefined,
      'hint consumed');
    assert.equal(wm.getState(102, 'workspace.id'), comms.handle,
      'membership bag points at the target');

    // A second window with the same hint joins the existing workspace.
    addWindow(103, { place: { name: 'comms' } });
    await settle();
    const after = await call(rt, 'list', [0]);
    assert.deepEqual(after.find((w) => w.name === 'comms').members, [103, 102]);
  }, { world: true });
});

test('placement: show: true also shows the target workspace', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, wsEvents, addWindow } = h;
    addWindow(101);
    await settle();
    wsEvents.length = 0;
    sink.cameraCalls.length = 0;

    addWindow(102, { place: { name: 'media', show: true } });
    await settle();
    const cur = await call(rt, 'current', [0]);
    assert.equal(cur.name, 'media', 'attention placement shows the target');
    assert.ok(wsEvents.some((e) => e.name === 'workspace.shown'));
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [102] });
    // World mode: the camera docked on the new workspace's slot.
    assert.equal(sink.cameraCalls.at(-1).x, PITCH);
  }, { world: true });
});

test('placement: digit-name hint resolves to the durable handle like show', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, addWindow } = h;
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);   // handle 2, hidden
    addWindow(102, { place: { name: '2' } });
    await settle();
    const list = await call(rt, 'list', [0]);
    assert.deepEqual(list[1].members, [102]);
    const cur = await call(rt, 'current', [0]);
    assert.equal(cur.index, 1, 'quiet');
  }, { world: true });
});

test('placement: malformed or empty hints fall back to the spawn output', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, addWindow } = h;
    addWindow(101);
    await settle();
    addWindow(102, { place: { bogus: true } });
    addWindow(103, { place: 'comms' });   // non-object
    await settle();
    const list = await call(rt, 'list', [0]);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].members, [103, 102, 101]);
  }, { world: true });
});

// ---- world mode: grid arrangement -----------------------------------------
// canvas: { arrangement: "grid" } wraps the slot order row-major after
// ~sqrt(N) columns; vertical pitch = viewport height + gutter.

const VPITCH = 600 + 128;

test('grid: islands wrap row-major; show docks at x AND y', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, islands, addWindow } = h;
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await call(rt, 'create', [{}]);   // 3 workspaces -> cols = 2
    await settle();

    const list = await call(rt, 'list', [0]);
    const rectOf = (i) => islands().find((x) => x.id === list[i].handle).rect;
    assert.deepEqual(rectOf(0), { x: 0, y: 0, width: 800, height: 600 });
    assert.deepEqual(rectOf(1), { x: PITCH, y: 0, width: 800, height: 600 });
    assert.deepEqual(rectOf(2), { x: 0, y: VPITCH, width: 800, height: 600 },
      'third island wraps to the second grid row');

    // Docking on the wrapped island moves the camera on both axes.
    sink.cameraCalls.length = 0;
    await call(rt, 'show', [3, 0]);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: VPITCH, zoom: 1 });
    // And back: y returns to the first row.
    await call(rt, 'show', [1, 0]);
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 0, y: 0, zoom: 1 });
  }, { canvas: { world: true, arrangement: 'grid' } });
});

test('grid: fit frames the 2D bounds (near-square zoom, both axes centered)', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, addWindow } = h;
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await call(rt, 'create', [{}]);
    await call(rt, 'create', [{}]);   // 4 workspaces -> 2x2 grid
    await settle();
    sink.cameraCalls.length = 0;

    await rt.invokeAction('workspace.fit', {});
    const boundsW = PITCH + 800;      // two columns
    const boundsH = VPITCH + 600;     // two grid rows
    const zoom = Math.min(800 / boundsW, 600 / boundsH);
    assert.deepEqual(sink.cameraCalls.at(-1), {
      outputId: 0,
      x: boundsW / 2 - (800 / zoom) / 2,
      y: boundsH / 2 - (600 / zoom) / 2,
      zoom,
    });
    // 2x2 on a 4:3-ish viewport: zoom ~0.45 vs the ~0.29 a 4-wide row
    // would give -- the grid is why fit wastes less glass.
    assert.ok(zoom > 800 / (4 * PITCH));
  }, { canvas: { world: true, arrangement: 'grid' } });
});

// Growth that leaves the packing alone still shoves in-row (canvas-design
// §6): a 2x2 of workarea-wide islands is already screen-shaped, so ws1
// growing by half pushes its own row's neighbor right and the row below
// never hears about it.
test('grid: growth the repack ignores shoves within its own row only', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    addWindow(101);
    await settle();
    for (let i = 0; i < 3; i++) await call(rt, 'create', [{}]);
    await settle();
    const list = await call(rt, 'list', [0]);
    const rectOf = (i) => islands().find((x) => x.id === list[i].handle).rect;
    const belowBefore = [2, 3].map((i) => ({ ...rectOf(i) }));
    assert.equal(belowBefore[0].y, VPITCH, 'ws3/ws4 start on the second row');

    // Grow ws1 (the current workspace) to 3 columns of 400 = 1200.
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();

    assert.equal(rectOf(0).width, 1200, 'ws1 grew');
    assert.deepEqual(rectOf(1), { x: 1200 + 128, y: 0, width: 800, height: 600 },
      'same-row neighbor shoved right');
    assert.deepEqual([2, 3].map((i) => ({ ...rectOf(i) })), belowBefore,
      'the row below never moved');
  }, {
    canvas: { world: true, arrangement: 'grid', elastic: true },
    layout: { mode: 'columns' },
  });
});

// Wide islands wrap sooner: three 2400px strips stack one-per-row (bounds
// 2400x2056, aspect 1.17) rather than the 2-then-1 a count-based ~sqrt(N)
// wrap gives (bounds 4928x1328, aspect 3.7) -- 1.17 is the nearer miss of
// the 800x600 viewport's 1.33, so fit frames a screen-shaped block.
test('grid: wide elastic islands wrap after fewer columns than narrow ones', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    let id = 100;
    for (let ws = 0; ws < 3; ws++) {
      if (ws > 0) {
        await call(rt, 'create', [{}]);
        await call(rt, 'show', [ws + 1, 0]);
        await settle();
      }
      for (let i = 0; i < 3; i++) addWindow(++id);
      await settle();
    }

    const list = await call(rt, 'list', [0]);
    const rectOf = (i) => islands().find((x) => x.id === list[i].handle).rect;
    for (let i = 0; i < 3; i++) {
      assert.equal(rectOf(i).width, 2400, `ws${i + 1} is a three-column strip`);
      assert.deepEqual(
        { x: rectOf(i).x, y: rectOf(i).y }, { x: 0, y: i * VPITCH },
        `ws${i + 1} takes its own grid row`);
    }
  }, {
    canvas: { world: true, arrangement: 'grid', elastic: true },
    layout: { mode: 'columns', column: 1.0 },
  });
});

// A workspace is workarea-wide when created and only becomes a strip as it
// fills, so growth -- not just the island set -- must be able to rewrap the
// grid, or every strip stays packed as if it were one screen wide. Here ws1
// grows to 3x its neighbor and their row can no longer hold both at the
// screen's shape.
test('grid: growth rewraps the grid when the better packing clearly wins', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await settle();
    const list = await call(rt, 'list', [0]);
    const rectOf = (i) => islands().find((x) => x.id === list[i].handle).rect;
    assert.deepEqual({ x: rectOf(1).x, y: rectOf(1).y }, { x: PITCH, y: 0 },
      'two workarea-wide islands start side by side');

    for (const wid of [102, 103]) { addWindow(wid); await settle(); }

    assert.equal(rectOf(0).width, 2400, 'ws1 grew to a three-column strip');
    assert.deepEqual({ x: rectOf(1).x, y: rectOf(1).y }, { x: 0, y: VPITCH },
      'ws2 rewrapped onto its own row rather than sitting 2400px out');
  }, {
    canvas: { world: true, arrangement: 'grid', elastic: true },
    layout: { mode: 'columns', column: 1.0 },
  });
});

// ---- layer-shell maps never join workspace membership ----------------------

test('elastic: a layer-shell map (waybar) neither joins members nor grows the strip', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow, wm } = h;
    addWindow(101);
    await settle();
    const before = islands().find((i) => i.id === 1);
    assert.deepEqual(before.rect, { x: 0, y: 0, width: 800, height: 600 });

    // A bar maps: window.map with role "layer-shell" (no wm.addWindow --
    // layer surfaces are not WM windows).
    h.pluginBus.emit('window.map', {
      surfaceId: 900, outputId: 0,
      rect: { x: 0, y: 0, width: 800, height: 30 },
      appId: null, title: null, role: 'layer-shell',
    });
    await settle();
    const list = await call(rt, 'list', [0]);
    assert.deepEqual(list[0].members, [101], 'bar never joined the workspace');
    const after = islands().find((i) => i.id === 1);
    assert.deepEqual(after.rect, { x: 0, y: 0, width: 800, height: 600 },
      'strip width unchanged by the bar');
    void wm;
  }, { canvas: { world: true, elastic: true }, layout: { mode: 'columns' } });
});

// ---- digit-name resolution vs handle drift --------------------------------

test('world: digit names never resolve to a differently-named workspace', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, addWindow } = h;
    addWindow(101);   // anchors ws1 (handle 1, unnamed)
    await settle();
    addWindow(102);
    await settle();

    // Drift the handle: "2" created (handle 2), evaporates, re-created
    // by a move (handle 3, still named "2").
    await rt.invokeAction('workspace.show', { name: '2' });
    await call(rt, 'show', [1, 0]);   // empty + hidden -> evaporates
    await settle();
    await rt.invokeAction('workspace.move-window', { surfaceId: 102, name: '2' });
    await settle();
    let list = await call(rt, 'list', [0]);
    assert.equal(list.length, 2);
    assert.equal(list[1].name, '2');
    assert.ok(list[1].handle > 2, 'durable handle drifted past the digit');

    // The bug: name "3" fell back to durable handle 3 -- the workspace
    // NAMED "2" -- and windows moved there. It must create "3" instead.
    addWindow(103);
    await settle();
    await rt.invokeAction('workspace.move-window', { surfaceId: 103, name: '3' });
    await settle();
    list = await call(rt, 'list', [0]);
    assert.deepEqual(list.map((w) => w.name), [undefined, '2', '3']);
    assert.deepEqual(list.find((w) => w.name === '2').members, [102]);
    assert.deepEqual(list.find((w) => w.name === '3').members, [103]);

    // The UNNAMED boot workspace stays addressable as "1" (the handle
    // fallback's remaining legitimate case).
    await rt.invokeAction('workspace.show', { name: '1' });
    const cur = await call(rt, 'current', [0]);
    assert.equal(cur.index, 1);
    assert.equal((await call(rt, 'list', [0])).length, 3,
      'no spurious create-on-reference for "1"');
  }, { world: true });
});

// ---- membership on drag (window.drag-dropped) -----------------------------

test('world: dropping a previously-tiled window on another island re-parents and re-tiles', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, wm, pluginBus, addWindow } = h;
    await setupTwoIslands(h);   // 101 on ws1 (slot 0), 102 on ws2 (slot 1)
    addWindow(103);             // second member on ws1
    await settle();

    // Drop 103 at a world point inside ws2's slot (x = PITCH + 100).
    pluginBus.emit('window.drag-dropped',
      { surfaceId: 103, wasManaged: true, x: PITCH + 100, y: 300 });
    await settle();
    const list = await call(rt, 'list', [0]);
    assert.deepEqual(list[0].members, [101], 'left the source island');
    assert.deepEqual(list[1].members, [102, 103], 'joined the target island');
    assert.equal(wm.getWindowState(103)?.tiling, 'managed',
      'previously-tiled window re-tiles in the new island');

    // A floating window keeps floating: in production the grab floats
    // the window before the drop, so mirror that here, then drop 101
    // with wasManaged: false (it was already floating pre-grab).
    await wm.propose(101, { tiling: 'floating' }, 'user-input');
    pluginBus.emit('window.drag-dropped',
      { surfaceId: 101, wasManaged: false, x: PITCH + 200, y: 300 });
    await settle();
    assert.deepEqual((await call(rt, 'list', [0]))[1].members, [102, 103, 101]);
    assert.notEqual(wm.getWindowState(101)?.tiling, 'managed',
      'user-floated window stays floating');

    // Drops on the window's own island or on void keep membership.
    pluginBus.emit('window.drag-dropped',
      { surfaceId: 103, wasManaged: true, x: PITCH + 300, y: 300 });
    pluginBus.emit('window.drag-dropped',
      { surfaceId: 103, wasManaged: true, x: -5000, y: 300 });
    await settle();
    assert.deepEqual((await call(rt, 'list', [0]))[1].members, [102, 103, 101]);
  }, { world: true });
});

test('world: tiled stays tiled -- a drag-floated window snaps back into the tiling on any drop', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, wm, pluginBus, addWindow } = h;
    await setupTwoIslands(h);   // 101 on ws1, 102 on ws2
    addWindow(103);
    await settle();

    // The grab floats the window; a drop on its OWN island re-tiles it
    // (floating is an explicit verb, never a drag side effect).
    await wm.propose(103, { tiling: 'floating' }, 'user-input');
    pluginBus.emit('window.drag-dropped',
      { surfaceId: 103, wasManaged: true, x: 100, y: 300 });
    await settle();
    assert.equal(wm.getWindowState(103)?.tiling, 'managed',
      'own-island drop re-tiles a previously-tiled window');
    assert.deepEqual([...(await call(rt, 'list', [0]))[0].members].sort(), [101, 103],
      'membership unchanged by an own-island drop');

    // Same for a drop on void (no island under the cursor): snap back.
    await wm.propose(103, { tiling: 'floating' }, 'user-input');
    pluginBus.emit('window.drag-dropped',
      { surfaceId: 103, wasManaged: true, x: -5000, y: 300 });
    await settle();
    assert.equal(wm.getWindowState(103)?.tiling, 'managed',
      'void drop re-tiles a previously-tiled window');

    // A window the user floated (wasManaged: false) stays floating on
    // an own-island / void drop.
    await wm.propose(103, { tiling: 'floating' }, 'user-input');
    pluginBus.emit('window.drag-dropped',
      { surfaceId: 103, wasManaged: false, x: 100, y: 300 });
    await settle();
    assert.equal(wm.getWindowState(103)?.tiling, 'floating',
      'user-floated window stays floating');
  }, { world: true });
});

// ---- bookmark evaporation fallback ----------------------------------------

test('world: an island bookmark survives evaporation via its captured name', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, wsEvents, addWindow } = h;
    addWindow(101);   // anchors ws1
    await settle();
    // Dynamic named workspace via create-on-reference; bookmark its dock.
    await rt.invokeAction('workspace.show', { name: '2' });
    const r = await rt.invokeAction('workspace.bookmark-set', { name: 'two' });
    assert.equal(r.kind, 'island');
    // Leave it empty + hidden -> it evaporates.
    await call(rt, 'show', [1, 0]);
    await settle();
    assert.equal((await call(rt, 'list', [0])).length, 1, 'workspace evaporated');

    // bookmark-go re-creates it by the captured name instead of throwing.
    wsEvents.length = 0;
    await rt.invokeAction('workspace.bookmark-go', { name: 'two' });
    const list = await call(rt, 'list', [0]);
    assert.equal(list.length, 2);
    assert.equal(list[1].name, '2');
    assert.ok(wsEvents.some((e) => e.name === 'workspace.shown' && e.payload.index === 2));
  }, { world: true });
});

// ---- declarative workspaces (canvas.workspaces) ---------------------------

test('canvas.workspaces: seeds named persistent workspaces with growth + layout by name', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    await settle();
    const list = await call(rt, 'list', [0]);
    // Boot workspace 1 + the two declared ones.
    assert.deepEqual(list.map((w) => w.name), [undefined, 'comms', 'media']);
    const comms = list.find((w) => w.name === 'comms');
    assert.equal(comms.persistent, true, 'declared workspaces default persistent');
    const media = list.find((w) => w.name === 'media');
    assert.equal(media.persistent, false, 'explicit persistent: false honored');

    // Redundant create by name is a no-op (registry idempotence).
    const snap = await rt.invokeAction('workspace.create', { name: 'comms' });
    assert.equal(snap.handle, comms.handle);
    assert.equal((await call(rt, 'list', [0])).length, 3);

    // 'media' is declared elastic AND columns-with-a-0.75-column: three
    // members grow it to 3 × 600 while its neighbors stay fixed.
    await call(rt, 'show', [3, 0]);
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();
    const mediaIsland = islands().find((i) => i.id === media.handle);
    assert.equal(mediaIsland.rect.width, 1800,
      'declared-elastic workspace grew at its declared column fraction');
    assert.deepEqual(mediaIsland.layout, { mode: 'columns', column: 0.75 });
    assert.equal(islands().find((i) => i.id === comms.handle).layout, undefined,
      'undeclared workspaces take the provider default mode');

    // A window quietly placed on 'comms' keeps it around even when it
    // empties again: persistent means no evaporation.
    await call(rt, 'show', [1, 0]);
    await settle();
    h.unmapWindow(101); h.unmapWindow(102); h.unmapWindow(103);
    await settle();
    const after = await call(rt, 'list', [0]);
    assert.ok(after.some((w) => w.name === 'comms'), 'persistent survives empty+hidden');
    assert.ok(!after.some((w) => w.name === 'media'),
      'persistent: false evaporates when empty and hidden');
  }, {
    canvas: {
      world: true,
      workspaces: [
        { name: 'comms' },
        {
          name: 'media', elastic: true,
          layout: { mode: 'columns', column: 0.75 }, persistent: false,
        },
      ],
    },
  });
});

test('world: empty islands publish backdrops; occupied ones do not', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, addWindow } = h;
    await settle();
    // Boot: ws1 (empty, shown) + declared "spare" (empty) -> 2 backdrops.
    let last = sink.backdropCalls.at(-1);
    assert.equal(last.length, 2);
    assert.deepEqual(last[0], {
      x: 0, y: 0, width: 800, height: 600,
      color: { r: 0x40, g: 0x80, b: 0xc0, a: 0x80 },
    });
    assert.equal(last[1].x, PITCH);

    // A window on ws1 removes its backdrop; "spare" keeps its own.
    addWindow(101);
    await settle();
    last = sink.backdropCalls.at(-1);
    assert.equal(last.length, 1);
    assert.equal(last[0].x, PITCH);

    // Moving the window to "spare" flips which island is marked.
    await rt.invokeAction('workspace.move-window', { surfaceId: 101, name: 'spare' });
    await settle();
    last = sink.backdropCalls.at(-1);
    assert.equal(last.length, 1);
    assert.equal(last[0].x, 0);
  }, {
    canvas: {
      world: true,
      islandBackdrop: '#4080c080',
      workspaces: [{ name: 'spare' }],
    },
  });
});

test('world: canvas.gutter overrides the island spacing', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await settle();
    const list = await call(rt, 'list', [0]);
    const ws2 = islands().find((i) => i.id === list[1].handle);
    assert.equal(ws2.rect.x, 800 + 48, 'second slot one gutter past the viewport');
  }, { canvas: { world: true, gutter: 48 } });
});

test('world: config-seeded bookmarks resolve at go time', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, sink, wsEvents } = h;
    await setupTwoIslands(h);
    wsEvents.length = 0;

    await rt.invokeAction('workspace.bookmark-go', { name: 'two' });
    assert.ok(wsEvents.some((e) => e.name === 'workspace.shown' && e.payload.index === 2),
      'workspace-name bookmark is a show');

    sink.cameraCalls.length = 0;
    await rt.invokeAction('workspace.bookmark-go', { name: 'spot' });
    assert.deepEqual(sink.cameraCalls.at(-1), { outputId: 0, x: 500, y: 0, zoom: 0.5 });

    sink.cameraCalls.length = 0;
    await rt.invokeAction('workspace.bookmark-go', { name: 'all' });
    assert.deepEqual(sink.cameraCalls.at(-1), fitCam(2), 'range bookmark fits');
  }, {
    canvas: {
      world: true,
      bookmarks: [
        { name: 'two', workspace: '2' },
        { name: 'spot', x: 500, y: 0, zoom: 0.5 },
        { name: 'all', start: 1 },
      ],
    },
  });
});
