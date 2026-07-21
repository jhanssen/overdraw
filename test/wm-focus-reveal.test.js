// focusReveal: keyboard focus moving to a window that shares an output with
// a DIFFERENT window holding exclusive (fullscreen/maximized) lifts the
// focused window above the exclusive tier, so focus-cycling away from a
// fullscreen window reveals the newly focused one. Pure-unit: mock sink, no
// workspace plugin beyond a static outputContent map.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
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

function makeWmWithTwoWindows() {
  const sink = mockSink();
  const placed = [1, 2];
  const wm = createWm(sink,
    [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }],
    { outputContent: () => new Map([[0, [...placed]]]) });
  for (const id of placed) {
    wm.addWindow(id, res(id));
    wm.windowHasContent(id);
  }
  return { wm, sink };
}

const winOf = (wm, id) => wm.state.windows.find((w) => w.surfaceId === id);

test('focus on a fullscreen peer sets focusReveal and re-pushes the stack', async () => {
  const { wm, sink } = makeWmWithTwoWindows();
  await wm.propose(1, { exclusive: 'fullscreen' }, 'client-request');

  // Dominance follows focus: unfocused fullscreen suppresses nothing.
  assert.ok(sink.stacks.at(-1).includes(2),
    'peer stays in the stack while the fullscreen window is unfocused');

  // Focusing the fullscreen window engages dominance: peer dropped.
  wm.setKeyboardFocus(1);
  assert.deepEqual(sink.stacks.at(-1), [1]);

  wm.setKeyboardFocus(2);
  assert.equal(winOf(wm, 2).focusReveal, true);
  assert.equal(winOf(wm, 1).focusReveal ?? false, false);
  // Revealed window is back in the stack, ABOVE the fullscreen window.
  assert.deepEqual(sink.stacks.at(-1), [1, 2]);
  // The hit-test / draw sort key agrees.
  assert.ok(effectiveStackZ(winOf(wm, 2)) > effectiveStackZ(winOf(wm, 1)));
});

test('focus back on the fullscreen window clears the reveal and re-engages dominance', async () => {
  const { wm, sink } = makeWmWithTwoWindows();
  await wm.propose(1, { exclusive: 'fullscreen' }, 'client-request');
  wm.setKeyboardFocus(2);
  wm.setKeyboardFocus(1);
  assert.equal(winOf(wm, 2).focusReveal, false);
  assert.deepEqual(sink.stacks.at(-1), [1]);
});

test('exclusive exiting clears the reveal on the focused peer', async () => {
  const { wm } = makeWmWithTwoWindows();
  await wm.propose(1, { exclusive: 'fullscreen' }, 'client-request');
  wm.setKeyboardFocus(2);
  assert.equal(winOf(wm, 2).focusReveal, true);
  await wm.propose(1, { exclusive: 'none' }, 'client-request');
  assert.equal(winOf(wm, 2).focusReveal, false);
});

test('focus on a non-window surface (e.g. a layer shell id) clears the reveal', async () => {
  const { wm, sink } = makeWmWithTwoWindows();
  await wm.propose(1, { exclusive: 'fullscreen' }, 'client-request');
  wm.setKeyboardFocus(2);
  wm.setKeyboardFocus(777);
  assert.equal(winOf(wm, 2).focusReveal, false);
  // Focus left the island entirely: the fullscreen window is not dominant
  // either, so nothing is suppressed and nothing is revealed.
  assert.ok(sink.stacks.at(-1).includes(1) && sink.stacks.at(-1).includes(2),
    'no dominance and no reveal with focus outside the island');
});

test('no exclusive window anywhere: focus changes do not re-push the stack', async () => {
  const { wm, sink } = makeWmWithTwoWindows();
  const before = sink.stacks.length;
  wm.setKeyboardFocus(1);
  wm.setKeyboardFocus(2);
  assert.equal(sink.stacks.length, before);
  assert.equal(winOf(wm, 1).focusReveal ?? false, false);
  assert.equal(winOf(wm, 2).focusReveal ?? false, false);
});
