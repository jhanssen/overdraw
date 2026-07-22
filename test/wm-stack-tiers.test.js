// Stacking follows keyboard focus across sizeMode tiers: a focused
// fullscreen/maximized window draws above everything; an unfocused
// fullscreen (or maximized floating) window drops below the tiled tier; a
// maximized MANAGED window stays a tile member in the tiled tier where the
// focused peer wins the shared-z tie. Maximized is single-instance per
// island (a new maximize demotes the previous one); fullscreen is not.
// Pure-unit: mock sink, no workspace plugin beyond a static outputContent
// map.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { createLayoutDriver } from '../packages/core/dist/wm/layout-driver.js';
import { effectiveStackZ } from '../packages/core/dist/subsurfaces.js';

function mockSink() {
  return {
    layouts: [],
    stacks: [],
    setSurfaceLayout(id, x, y, w, h) { this.layouts.push({ id, x, y, w, h }); },
    setStack(ids) { this.stacks.push(ids); },
    setLayerSurfaces() {},
    setSurfaceTexture() {},
    commitSurfaceBuffer() {},
    commitSurfaceDmabuf() {},
    removeSurface() {},
    takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; },
    afterCurrentFrame() {},
    renderFrame() {},
  };
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

// Even horizontal split of the tile region across the managed windows the
// driver hands over -- enough layout realism to observe slot occupancy.
function makeWmWithWindows(ids = [1, 2]) {
  const sink = mockSink();
  const wm = createWm(sink,
    [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }],
    {
      outputContent: () => new Map([[0, [...ids]]]),
      configure: { configure: () => null, configureMove: () => {} },
      layoutDriverFactory: (target, snapshot) => createLayoutDriver({
        target, snapshot,
        compute: async (inputs) => {
          const r = inputs.tileRegion;
          const n = inputs.windows.length;
          const w = Math.floor(r.width / n);
          return {
            rects: inputs.windows.map((win, i) => ({
              id: win.id,
              outer: { x: r.x + i * w, y: r.y, width: w, height: r.height },
            })),
          };
        },
      }),
    });
  for (const id of ids) {
    wm.addWindow(id, res(id));
    wm.windowHasContent(id);
  }
  return { wm, sink };
}

const winOf = (wm, id) => wm.state.windows.find((w) => w.surfaceId === id);

test('unfocused fullscreen drops below the tiled tier; focused rises above it', async () => {
  const { wm, sink } = makeWmWithWindows();
  await wm.propose(1, { sizeMode: 'fullscreen' }, 'client-request');

  // Unfocused fullscreen: tier -1, below the tiled peer.
  assert.equal(winOf(wm, 1).stackTier, -1);
  assert.ok(effectiveStackZ(winOf(wm, 1)) < effectiveStackZ(winOf(wm, 2)));
  const stack = sink.stacks.at(-1);
  assert.ok(stack.indexOf(1) < stack.indexOf(2),
    'fullscreen window draws below the tiled peer while unfocused');

  // Focusing it flips to the top tier; the peer stays in the stack below.
  wm.setKeyboardFocus(1);
  assert.equal(winOf(wm, 1).stackTier, 1);
  assert.ok(effectiveStackZ(winOf(wm, 1)) > effectiveStackZ(winOf(wm, 2)));
  const focused = sink.stacks.at(-1);
  assert.ok(focused.indexOf(2) < focused.indexOf(1),
    'focused fullscreen draws above; the peer is not suppressed');
});

test('focus-cycling away from a fullscreen window uncovers the island', async () => {
  const { wm, sink } = makeWmWithWindows();
  await wm.propose(1, { sizeMode: 'fullscreen' }, 'client-request');
  wm.setKeyboardFocus(1);
  wm.setKeyboardFocus(2);
  assert.equal(winOf(wm, 1).stackTier, -1);
  assert.equal(winOf(wm, 2).kbFocused, true);
  const stack = sink.stacks.at(-1);
  assert.ok(stack.indexOf(1) < stack.indexOf(2),
    'fullscreen window dropped behind the newly focused peer');
});

test('fullscreen exit returns the window to the tiled tier', async () => {
  const { wm } = makeWmWithWindows();
  await wm.propose(1, { sizeMode: 'fullscreen' }, 'client-request');
  assert.equal(winOf(wm, 1).stackTier, -1);
  await wm.propose(1, { sizeMode: 'none' }, 'client-request');
  assert.equal(winOf(wm, 1).stackTier, 0);
});

test('focus on a non-window surface (e.g. a layer shell id) lowers the fullscreen window', async () => {
  const { wm, sink } = makeWmWithWindows();
  await wm.propose(1, { sizeMode: 'fullscreen' }, 'client-request');
  wm.setKeyboardFocus(1);
  wm.setKeyboardFocus(777);
  assert.equal(winOf(wm, 1).stackTier, -1);
  const stack = sink.stacks.at(-1);
  assert.ok(stack.includes(1) && stack.includes(2),
    'both windows stay in the stack with focus outside the island');
  assert.ok(stack.indexOf(1) < stack.indexOf(2));
});

test('maximized managed window stays in the tiled tier; the focused peer wins the tie', async () => {
  const { wm } = makeWmWithWindows();
  await wm.propose(1, { sizeMode: 'maximized' }, 'client-request');
  // A maximized MANAGED window is a tile member: never tier -1. The
  // stamp is change-driven, so the never-touched default (undefined)
  // also reads as tier 0.
  assert.equal(winOf(wm, 1).stackTier ?? 0, 0);
  wm.setKeyboardFocus(2);
  // Same tier, same shared tiled z: the focused peer's tie-break wins.
  assert.equal(winOf(wm, 1).stackTier ?? 0, 0);
  assert.ok(effectiveStackZ(winOf(wm, 2)) > effectiveStackZ(winOf(wm, 1)),
    'focused tiled peer draws above the unfocused maximized tile member');
});

test('maximized floating window drops below the tiled tier when unfocused', async () => {
  const { wm } = makeWmWithWindows();
  await wm.propose(1, { tiling: 'floating' }, 'plugin');
  await wm.propose(1, { sizeMode: 'maximized' }, 'client-request');
  assert.equal(winOf(wm, 1).stackTier, -1);
  wm.setKeyboardFocus(1);
  assert.equal(winOf(wm, 1).stackTier, 1);
});

test('fullscreen and maximized coexist; both keep override rects, focus picks the top', async () => {
  const { wm, sink } = makeWmWithWindows();
  await wm.propose(1, { sizeMode: 'fullscreen' }, 'client-request');
  await wm.propose(2, { sizeMode: 'maximized' }, 'client-request');
  await wm.settled();
  // Fullscreen keeps the full output rect -- it is never handed to the
  // layout plugin, so a later maximize cannot squeeze it into a slot.
  assert.equal(winOf(wm, 1).windowState.sizeMode, 'fullscreen');
  const fsLayout = sink.layouts.filter((l) => l.id === 1).at(-1);
  assert.deepEqual(
    { x: fsLayout.x, y: fsLayout.y, w: fsLayout.w, h: fsLayout.h },
    { x: 0, y: 0, w: 800, h: 600 });
  // Focus decides which of the two is on top; neither demotes the other.
  wm.setKeyboardFocus(2);
  assert.ok(effectiveStackZ(winOf(wm, 2)) > effectiveStackZ(winOf(wm, 1)));
  wm.setKeyboardFocus(1);
  assert.ok(effectiveStackZ(winOf(wm, 1)) > effectiveStackZ(winOf(wm, 2)));
});

test('a new maximize demotes the previous maximized window on the island', async () => {
  const { wm } = makeWmWithWindows();
  await wm.propose(1, { sizeMode: 'maximized' }, 'client-request');
  assert.equal(winOf(wm, 1).windowState.sizeMode, 'maximized');
  await wm.propose(2, { sizeMode: 'maximized' }, 'client-request');
  // The demotion runs through propose() on the peer's mutation queue.
  await winOf(wm, 1).pendingMutation;
  assert.equal(winOf(wm, 1).windowState.sizeMode, 'none');
  assert.equal(winOf(wm, 2).windowState.sizeMode, 'maximized');
});

test('a new maximize does NOT demote a fullscreen window', async () => {
  const { wm } = makeWmWithWindows();
  await wm.propose(1, { sizeMode: 'fullscreen' }, 'client-request');
  await wm.propose(2, { sizeMode: 'maximized' }, 'client-request');
  await winOf(wm, 1).pendingMutation;
  assert.equal(winOf(wm, 1).windowState.sizeMode, 'fullscreen');
  assert.equal(winOf(wm, 2).windowState.sizeMode, 'maximized');
});

test('lowered fullscreen window is input-transparent; focused it takes hits again', async () => {
  const { wm } = makeWmWithWindows();
  // Float window 2 into a small corner rect so most of the glass shows
  // only the lowered fullscreen backdrop (window 1).
  await wm.propose(2, { tiling: 'floating' }, 'plugin');
  wm.setFloatingRect(2, { x: 0, y: 0, width: 100, height: 100 });
  await wm.propose(1, { sizeMode: 'fullscreen' }, 'client-request');
  await wm.settled();
  // A point covered only by the lowered fullscreen window hits NOTHING:
  // pointer input there must not reach a backdrop window (cursor prefs,
  // follow-pointer focus would raise it on a mere mouse crossing).
  wm.setKeyboardFocus(2);
  assert.equal(winOf(wm, 1).stackTier, -1);
  const exposed = { x: 700, y: 300 };
  assert.equal(wm.windowAt(exposed.x, exposed.y), null,
    'lowered fullscreen window takes no pointer input');
  // A point over the floating peer hits the peer, not the glass-sized
  // backdrop beneath it.
  assert.equal(wm.windowAt(50, 50)?.surfaceId, 2);
  // Focused (raised) it is hit-testable everywhere it covers.
  wm.setKeyboardFocus(1);
  assert.equal(winOf(wm, 1).stackTier, 1);
  assert.equal(wm.windowAt(exposed.x, exposed.y)?.surfaceId, 1);
});

test('fullscreen window leaves the tile layout: the remaining peer reflows to the full region', async () => {
  const { wm, sink } = makeWmWithWindows([1, 2, 3]);
  await wm.settled();
  await wm.propose(3, { sizeMode: 'fullscreen' }, 'client-request');
  await wm.settled();
  // Unmap one of the two remaining tiled windows: the survivor must take
  // the whole region -- the fullscreen window no longer occupies a slot.
  wm.unmapWindow(1);
  await wm.settled();
  const l = sink.layouts.filter((x) => x.id === 2).at(-1);
  assert.deepEqual({ x: l.x, y: l.y, w: l.w, h: l.h },
    { x: 0, y: 0, w: 800, h: 600 },
    'sole remaining tiled window reflows over the full island');
});
