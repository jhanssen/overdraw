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
  };
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
  const wm = createWm(sink,
    [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }],
    {
      layoutDriverFactory: (target, snapshot) => ({
        schedule() { layoutSnapshots.push(snapshot()); },
        settled() { return Promise.resolve(); },
      }),
    });
  const seatCalls = { focus: [] };
  const seat = {
    applyKeyboardFocus(id) { seatCalls.focus.push(id); },
    dispatchFocusEvent(reason, trigger) {
      seatCalls.focus.push({ kind: 'dispatch', reason, trigger });
    },
    repickPointer() {},
  };
  const state = {
    bus, wm, surfaces: new Map(), compositor: sink, seat,
    pendingWindowChanges: undefined, decorationResize: null,
  };
  const broker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });
  bus.on(WINDOW_EVENT.map, (ev) => pluginBus.emit(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => pluginBus.emit(WINDOW_EVENT.unmap, ev));

  const wsEvents = [];
  pluginBus.subscribe('workspace.*', (name, payload) => {
    wsEvents.push({ name, payload });
  });

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
      if (method.startsWith('windows.')) {
        const r = broker(plugin, method, params);
        if (r === WINDOWS_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      if (method.startsWith('animations.')) return handleAnimations(method, params);
      throw new Error(`no handler for '${method}'`);
    },
  }, async (rt) => {
    // Mirror the production bundled spec: configFrom merges the runtime
    // context (output geometry seed) with the user's canvas slice.
    const spec = {
      ...canvasSpec,
      configFrom: (cfg, runtime) => ({
        fallbackOutputId: -1, fallbackOutputName: '',
        bootOutputDurableKey: runtime.bootOutputDurableKey,
        initialOutputs: runtime.initialOutputs,
        canvas: cfg.canvas,
      }),
    };
    await rt.load([bundledToResolved(spec, spec.module,
      {
        output: null, focus: null, hotkeys: undefined, actions: undefined,
        plugins: [], sourcePath: null,
        canvas: opts.world ? { world: true } : {},
      },
      {
        bootOutputDurableKey: 'mock-0',
        initialOutputs: [{
          outputId: 0, name: 'mock-0', edidId: '',
          x: 0, y: 0, width: 800, height: 600, scale: 1,
        }],
      })]);
    await rt.waitForNamespace('workspace');
    await fn({
      rt, sink, wm, wsEvents, seatCalls, layoutSnapshots, animCalls, animPending,
      islands() { return layoutSnapshots.at(-1)?.islands ?? []; },
      addWindow(id) {
        wm.addWindow(id, res(id));
        wm.windowHasContent(id);
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
    assert.deepEqual(isl[0].members, []);
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

test('world: show docks the camera on the shown slot; hidden members stay published', async () => {
  await withCanvasPlugin(async ({ rt, sink, islands, addWindow }) => {
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
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [] });

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
