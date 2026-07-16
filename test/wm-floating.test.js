// Pure-unit tests for the WM's floating tiling lane:
//   - The resolver dispatches floating windows in core (plugin not called).
//   - First transition into the floating lane captures the current outer
//     as the initial floating rect.
//   - setFloatingRect updates the stored rect and schedules a relayout.
//   - The bundled master-stack plugin doesn't see floating windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { createLayoutDriver } from '../packages/core/dist/wm/layout-driver.js';
import { computeBaseStack } from '../packages/core/dist/subsurfaces.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

function mockSink() {
  return {
    layouts: [],
    stacks: [],
    setSurfaceLayout(id, x, y, w, h) { this.layouts.push({ id, x, y, w, h }); },
    setStack(ids) { this.stacks.push(ids); },
    setLayerSurfaces() {}, setSurfaceTexture() {},
    commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
  };
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

async function addMapped(wm, id) {
  wm.addWindow(id, res(id));
  await wm.settled();
  wm.windowHasContent(id);
}

// Driver that runs a fake master-stack synchronously, but verifies which
// windows the plugin actually sees.
function recordingDriver(pluginVisible) {
  return (target, snapshot) => createLayoutDriver({
    target, snapshot,
    compute: async (inputs) => {
      pluginVisible.push(inputs.windows.map((w) => w.id));
      return {
        rects: inputs.windows.map((w) => ({
          id: w.id,
          outer: { x: 0, y: 0, width: 500, height: 600 },
        })),
      };
    },
  });
}

// --- tiling lane dispatch -----------------------------------------------

test('floating window: captures initial rect from current outer on first transition', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  // Currently no floatingRect.
  assert.equal(wm.getFloatingRect(1), null);

  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  const fr = wm.getFloatingRect(1);
  assert.ok(fr);
  // Initial floating rect = current outer at the time of transition.
  // With single-window master-stack: full output.
  assert.deepEqual(fr, { x: 0, y: 0, width: 1000, height: 600 });
});

test('setFloatingRect: updates stored rect', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  wm.setFloatingRect(1, { x: 100, y: 200, width: 400, height: 300 });
  assert.deepEqual(wm.getFloatingRect(1),
    { x: 100, y: 200, width: 400, height: 300 });
});

test('setFloatingRect: schedules a layout pass', () => {
  let scheduled = 0;
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: (target, snapshot) => {
      void target; void snapshot;
      return {
        schedule() { scheduled++; },
        settled() { return Promise.resolve(); },
      };
    },
  });
  wm.addWindow(1, res(1));  // sync; driver is fake
  const before = scheduled;
  wm.setFloatingRect(1, { x: 10, y: 20, width: 100, height: 80 });
  assert.equal(scheduled, before + 1);
});

test('resolver: floating window uses its floatingRect, not the plugin output', async () => {
  const visible = [];
  const layouts = [];
  const sink = {
    ...mockSink(),
    setSurfaceLayout(id, x, y, w, h) { layouts.push({ id, x, y, w, h }); },
  };
  const wm = createWm(sink, [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: recordingDriver(visible),
  });
  await addMapped(wm, 1);
  layouts.length = 0;

  // Transition to floating with an explicit rect.
  wm.setFloatingRect(1, { x: 100, y: 50, width: 300, height: 200 });
  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  await wm.settled();
  // The plugin should NOT have been called for the floating window (no
  // managed windows). The resolver assigned the floating rect.
  const lastLayout = layouts.at(-1);
  assert.deepEqual(lastLayout, { id: 1, x: 100, y: 50, w: 300, h: 200 });
});

test('resolver: layout plugin only sees managed windows, not floating', async () => {
  const visible = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: recordingDriver(visible),
  });
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  visible.length = 0;

  await wm.propose(2, { tiling: 'floating' }, 'user-input');
  await wm.settled();
  // The plugin's last invocation saw only window 1 (managed); window 2 is
  // floating and resolved in core.
  assert.deepEqual(visible.at(-1), [1]);
});

test('resolver: empty managed set with floating window: plugin not called', async () => {
  const visible = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: recordingDriver(visible),
  });
  await addMapped(wm, 1);
  visible.length = 0;
  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  await wm.settled();
  // No managed windows -> plugin not called.
  assert.equal(visible.length, 0);
});

test('floating rect preserved across floating -> managed -> floating', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  // First float at default rect (= current outer at transition).
  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  const initial = wm.getFloatingRect(1);
  // User drags to a new position.
  wm.setFloatingRect(1, { x: 200, y: 100, width: 500, height: 400 });
  // Back to managed.
  await wm.propose(1, { tiling: 'managed' }, 'user-input');
  assert.deepEqual(wm.getFloatingRect(1),
    { x: 200, y: 100, width: 500, height: 400 });
  // Float again -- rect is preserved (no re-capture).
  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  assert.deepEqual(wm.getFloatingRect(1),
    { x: 200, y: 100, width: 500, height: 400 });
  assert.notDeepEqual(wm.getFloatingRect(1), initial);
});

test('getFloatingRect: unknown window returns null', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }]);
  assert.equal(wm.getFloatingRect(999), null);
});

test('setFloatingRect: unknown window is a no-op (no throw)', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }]);
  wm.setFloatingRect(999, { x: 0, y: 0, width: 1, height: 1 });
  // Just confirms no throw.
  assert.equal(wm.getFloatingRect(999), null);
});

// --- tiling-lane propose accepted ---------------------------------------

test('propose: tiling=floating is accepted', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  const r = await wm.propose(1, { tiling: 'floating' }, 'user-input');
  assert.equal(r.tiling, 'floating');
});

// --- transient (parented) windows resolve to floating before they tile ------

test('parented window floats at first content without disturbing the tiled stack', async () => {
  // A window the client marks transient (set_parent) resolves to the floating
  // lane at first content, before it enters the layout -- so it never tiles or
  // reorders the existing tiled windows. The layout gates on outputContent
  // (placement), mirroring the workspace plugin: an unplaced window is not laid
  // out, so a would-be-floating window never gets a tile-sized outer.
  const placed = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
    outputContent: () => new Map(placed.length ? [[0, [...placed]]] : []),
  });

  // A tiled window already owns the output. Placement (models the workspace
  // plugin's setOutputStack) schedules the relayout that lays it out.
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.markInitialCommitComplete(1, { appId: 'term', title: null });
  placed.push(1);
  wm.schedule('mapped');
  await wm.settled();
  wm.windowHasContent(1);
  await wm.settled();
  assert.deepEqual(wm.rectOf(1), { x: 0, y: 0, width: 1000, height: 600 }, 'window 1 fills the output');

  // A transient (parented) window maps. It is never placed into the tiled set.
  wm.addWindow(2, res(2), { deferInitialCommit: true });
  await wm.propose(2, { parent: 1 }, 'client-request');
  await wm.markInitialCommitComplete(2, { appId: 'dialog', title: null });
  assert.equal(wm.outerRectOf(2)?.width <= 0, true, 'window 2 unplaced after the handshake (placeholder)');

  // First content: it joins the output content and signals content, carrying the
  // client's natural content size. The float decision runs before the placement
  // relayout, so the layout never tiles it.
  placed.push(2);
  wm.windowHasContent(2, { width: 640, height: 480 });
  await wm.settled();

  assert.equal(wm.getWindowState(2)?.tiling, 'floating', 'parented window floats');
  assert.deepEqual(wm.rectOf(1), { x: 0, y: 0, width: 1000, height: 600 }, 'tiled window 1 undisturbed');
  // Sized from the client's own content size (so it renders 1:1), NOT blown up
  // to the master-stack tile it never occupied. Centered on the output.
  const fr = wm.getFloatingRect(2);
  assert.deepEqual({ width: fr?.width, height: fr?.height }, { width: 640, height: 480 },
    'floating rect adopts the client content size');
  assert.deepEqual({ x: fr?.x, y: fr?.y }, { x: (1000 - 640) / 2, y: (600 - 480) / 2 },
    'centered on its output');
});

test('floating window with reserved insets: outer grows so content == client size', async () => {
  // A decoration intercept reserves insets at preconfigure -- while the window
  // is still managed, so setInsets' floating grow-path is skipped. When the
  // window then floats at first content, the seed sizes the OUTER tile as the
  // client content PLUS those insets, so the content rect equals the client's
  // own size. A fixed-size dialog never has to resize, so its content gate can
  // release on the first frame instead of waiting for a buffer that never comes.
  const placed = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
    outputContent: () => new Map(placed.length ? [[0, [...placed]]] : []),
  });

  // A tiled window owns the output.
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.markInitialCommitComplete(1, { appId: 'term', title: null });
  placed.push(1);
  wm.schedule('mapped');
  await wm.settled();
  wm.windowHasContent(1);
  await wm.settled();

  // A transient window maps; the decoration reserves a 2px band on every edge
  // BEFORE first content (while still managed -- the placeholder outer means
  // setInsets only stores the insets, it does not grow anything yet).
  wm.addWindow(2, res(2), { deferInitialCommit: true });
  await wm.propose(2, { parent: 1 }, 'client-request');
  await wm.markInitialCommitComplete(2, { appId: 'dialog', title: null });
  wm.setInsets(2, { top: 2, right: 2, bottom: 2, left: 2 });

  placed.push(2);
  wm.windowHasContent(2, { width: 640, height: 480 });
  await wm.settled();

  assert.equal(wm.getWindowState(2)?.tiling, 'floating', 'parented window floats');
  // Outer = client content + insets (640+2+2 x 480+2+2).
  const fr = wm.getFloatingRect(2);
  assert.deepEqual({ width: fr?.width, height: fr?.height }, { width: 644, height: 484 },
    'outer tile = client content + reserved insets');
  // Content rect = the client's own size, so it renders 1:1 and never resizes.
  assert.deepEqual(wm.rectOf(2), { x: (1000 - 644) / 2 + 2, y: (600 - 484) / 2 + 2, width: 640, height: 480 },
    'content rect equals the client content size, inset within the outer tile');
});

// --- raiseAllFloating: bring the floating layer back over the tiled stack ---
// The composited order is z-sorted by computeBaseStack (the renderer's path);
// a higher index is drawn on top.

function stackOf(wm) {
  return computeBaseStack({ wm, surfaces: new Map() });
}

test('raiseAllFloating: floating windows restacked above the tiled stack', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  // Two tiled windows (sharing tiledZ) and one floating window (above them).
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await addMapped(wm, 3);
  await wm.propose(3, { tiling: 'floating' }, 'user-input');

  // Raising a tiled window lifts the whole tile stack over the floating one.
  wm.raiseWindow(1);
  let stack = stackOf(wm);
  assert.ok(stack.indexOf(3) < Math.min(stack.indexOf(1), stack.indexOf(2)),
    'tiled stack raised above the floating window');

  // raiseAllFloating brings the floating window back on top of both tiles.
  wm.raiseAllFloating();
  stack = stackOf(wm);
  assert.ok(stack.indexOf(3) > Math.max(stack.indexOf(1), stack.indexOf(2)),
    'floating window raised above the tiled stack');
});

test('raiseAllFloating: preserves relative order of multiple floating windows', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1); // tiled
  await addMapped(wm, 2); // floating
  await addMapped(wm, 3); // floating
  await wm.propose(2, { tiling: 'floating' }, 'user-input');
  await wm.propose(3, { tiling: 'floating' }, 'user-input');
  wm.raiseWindow(3); // 3 above 2 in the floating layer
  wm.raiseWindow(1); // tile stack over both floating

  wm.raiseAllFloating();
  const stack = stackOf(wm);
  // Both floating above the tile, and 3 still above 2.
  assert.ok(stack.indexOf(2) > stack.indexOf(1), 'floating 2 above tiled');
  assert.ok(stack.indexOf(3) > stack.indexOf(2), 'floating 3 stays above floating 2');
});

// --- map-time float placement -------------------------------------------

// A window that maps already floating (fixed-size here; also dialogs and
// rule-floated windows) has no rect to inherit, so the WM picks one. It must
// land in front of the user: an output's own rect is where the monitor sits
// in the arrangement, which stops being the visible region the moment a
// camera looks somewhere else.
async function addFixedSize(wm, id, w, h) {
  wm.addWindow(id, res(id));
  await wm.propose(id, {
    constraints: { minSize: { width: w, height: h }, maxSize: { width: w, height: h } },
  }, 'client-request');
  wm.windowHasContent(id);
  await wm.settled();
}

test('float placement: centers on what the output is looking at', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
    // The camera is parked on an island far from the output's own slot.
    viewportOf: () => ({ x: 5000, y: 300, width: 1000, height: 600 }),
  });
  await addFixedSize(wm, 1, 400, 200);
  assert.equal(wm.getWindowState(1).tiling, 'floating', 'fixed-size maps floating');
  assert.deepEqual(wm.getFloatingRect(1),
    { x: 5300, y: 500, width: 400, height: 200 },
    'centered in the viewport, not at the output rect');
});

test('float placement: a zoomed-out camera sees more world, and the float centers in it', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
    // zoom 0.5 -> the viewport covers twice the world in each axis.
    viewportOf: () => ({ x: 0, y: 0, width: 2000, height: 1200 }),
  });
  await addFixedSize(wm, 1, 400, 200);
  assert.deepEqual(wm.getFloatingRect(1),
    { x: 800, y: 500, width: 400, height: 200 });
});

test('float placement: no viewport reported -> the output rect is the answer', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addFixedSize(wm, 1, 400, 200);
  assert.deepEqual(wm.getFloatingRect(1),
    { x: 300, y: 200, width: 400, height: 200 },
    'no camera: the output shows its own rect');
});
