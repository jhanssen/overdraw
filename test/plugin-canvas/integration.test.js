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
        canvas: opts.canvas ?? (opts.world ? { world: true } : {}),
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
      pluginBus,
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
// canvas: { elastic: true } grows each workspace island along its row (one
// 0.5-viewport column per managed member), tiles it via the layout
// provider's columns hint, shoves right-hand neighbors, and scrolls the
// docked camera within the strip to follow focus.

test('elastic: islands grow with members and shove the row; layout hint set', async () => {
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

    // One managed member: viewport-sized island, columns hint.
    const list = await call(rt, 'list', [0]);
    let isl = islands();
    const ws1 = isl.find((i) => i.id === list[0].handle);
    const ws2 = isl.find((i) => i.id === list[1].handle);
    assert.deepEqual(ws1.rect, { x: 0, y: 0, width: 800, height: 600 });
    assert.deepEqual(ws1.layout, { mode: 'columns' });
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
  }, { canvas: { world: true, elastic: true } });
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
  }, { canvas: { world: true, elastic: true } });
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

    // default: false -> ws1 stays a fixed viewport-sized island with
    // master-stack (no layout hint), 3 managed members notwithstanding.
    const list = await call(rt, 'list', [0]);
    let ws1 = islands().find((i) => i.id === list[0].handle);
    assert.deepEqual(ws1.rect, { x: 0, y: 0, width: 800, height: 600 });
    assert.equal(ws1.layout, undefined);

    // Toggle the shown workspace elastic: 3 columns -> strip 1200; the
    // neighbor shoves right; ws2 itself stays fixed.
    let r = await rt.invokeAction('workspace.set-elastic', {});
    assert.equal(r.elastic, true);
    ws1 = islands().find((i) => i.id === list[0].handle);
    assert.deepEqual(ws1.rect, { x: 0, y: 0, width: 1200, height: 600 });
    assert.deepEqual(ws1.layout, { mode: 'columns' });
    const ws2 = islands().find((i) => i.id === list[1].handle);
    assert.equal(ws2.rect.x, 1200 + 128);
    assert.equal(ws2.layout, undefined);

    // Toggle back: fixed again.
    r = await rt.invokeAction('workspace.set-elastic', {});
    assert.equal(r.elastic, false);
    ws1 = islands().find((i) => i.id === list[0].handle);
    assert.deepEqual(ws1.rect, { x: 0, y: 0, width: 800, height: 600 });

    // Explicit index + elastic flag.
    r = await rt.invokeAction('workspace.set-elastic', { index: 2, elastic: true });
    assert.equal(r.elastic, true);
    assert.deepEqual(islands().find((i) => i.id === list[1].handle).layout,
      { mode: 'columns' });
    await assert.rejects(
      rt.invokeAction('workspace.set-elastic', { index: 9 }), /out of bounds/);
  }, { canvas: { world: true, elastic: { default: false } } });
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
    assert.equal(ws1.layout, undefined, 'master-stack again');
  }, { canvas: { world: true, elastic: true } });
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

test('grid: elastic growth shoves within its own grid row only', async () => {
  await withCanvasPlugin(async (h) => {
    const { rt, islands, addWindow } = h;
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    await call(rt, 'create', [{}]);
    await settle();
    // Grow ws1 (slot 0, grid row 0) to 3 columns of 400 = 1200.
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();

    const list = await call(rt, 'list', [0]);
    const rectOf = (i) => islands().find((x) => x.id === list[i].handle).rect;
    assert.equal(rectOf(0).width, 1200, 'ws1 grew');
    assert.deepEqual(rectOf(1), { x: 1200 + 128, y: 0, width: 800, height: 600 },
      'same-row neighbor shoved right');
    assert.deepEqual(rectOf(2), { x: 0, y: VPITCH, width: 800, height: 600 },
      'next grid row unmoved');
  }, { canvas: { world: true, arrangement: 'grid', elastic: true } });
});

// ---- declarative workspaces (canvas.workspaces) ---------------------------

test('canvas.workspaces: seeds named persistent workspaces with elastic by name', async () => {
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

    // 'media' is declared elastic with a 0.75 column: three members grow
    // it to 3 × 600 while its neighbors stay fixed.
    await call(rt, 'show', [3, 0]);
    addWindow(101);
    await settle();
    addWindow(102);
    await settle();
    addWindow(103);
    await settle();
    const mediaIsland = islands().find((i) => i.id === media.handle);
    assert.equal(mediaIsland.rect.width, 1800,
      'declared-elastic workspace grew at its own column fraction');
    assert.deepEqual(mediaIsland.layout, { mode: 'columns' });
    assert.equal(islands().find((i) => i.id === comms.handle).layout, undefined,
      'undeclared workspaces keep the fixed default');

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
        { name: 'media', elastic: { column: 0.75 }, persistent: false },
      ],
    },
  });
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
