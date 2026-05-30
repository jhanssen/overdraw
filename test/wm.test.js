// Pure-unit tests for the window manager state holder (src/wm). No GPU/Wayland:
// a mock addon records setSurfaceLayout / setStack calls so we can assert the
// WM pushes the right geometry + order. Covers mapWindow (placement, content-
// size fallback, idempotence, stack push), unmapWindow, and windowAt hit-testing
// (including z-order on overlap).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../dist/wm/index.js';

// Mock addon: records the layout/stack calls the WM makes.
function mockAddon() {
  const layouts = [];
  const stacks = [];
  return {
    setSurfaceLayout(id, x, y, w, h) { layouts.push({ id, x, y, w, h }); },
    setStack(ids) { stacks.push([...ids]); },
    _layouts: layouts,
    _stacks: stacks,
  };
}

const rec = (id) => ({ resource: { __id: id } }); // SurfaceHandle stub

test('mapWindow: assigns a rect, pushes layout + stack', () => {
  const addon = mockAddon();
  const wm = createWm(addon, { width: 1920, height: 1080 });

  const r = wm.mapWindow(1, rec(1), 300, 200);
  assert.ok(r, 'returns a rect');
  // First window: cascade origin (0,0); content-size fallback -> 300x200.
  assert.deepEqual(r, { x: 0, y: 0, width: 300, height: 200 });

  assert.equal(addon._layouts.length, 1);
  assert.deepEqual(addon._layouts[0], { id: 1, x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(addon._stacks.at(-1), [1]);
});

test('mapWindow: content-size fallback only when placement size is 0', () => {
  const addon = mockAddon();
  const wm = createWm(addon, { width: 1920, height: 1080 });
  const r = wm.mapWindow(7, rec(7), 640, 480);
  // placeWindow stub returns width/height 0, so effective size = content size.
  assert.equal(r.width, 640);
  assert.equal(r.height, 480);
});

test('mapWindow: idempotent for an already-mapped surface', () => {
  const addon = mockAddon();
  const wm = createWm(addon, { width: 1920, height: 1080 });
  wm.mapWindow(1, rec(1), 100, 100);
  const before = addon._stacks.length;
  const r2 = wm.mapWindow(1, rec(1), 100, 100);
  assert.equal(r2, undefined, 'second map returns undefined');
  assert.equal(addon._stacks.length, before, 'no extra stack push');
  assert.equal(wm.state.windows.length, 1);
});

test('mapWindow: stack grows top-most last, pushed in order', () => {
  const addon = mockAddon();
  const wm = createWm(addon, { width: 1920, height: 1080 });
  wm.mapWindow(1, rec(1), 100, 100);
  wm.mapWindow(2, rec(2), 100, 100);
  wm.mapWindow(3, rec(3), 100, 100);
  assert.deepEqual(addon._stacks.at(-1), [1, 2, 3]);
  assert.deepEqual(wm.state.windows.map((w) => w.surfaceId), [1, 2, 3]);
});

test('unmapWindow: removes from stack and re-pushes order', () => {
  const addon = mockAddon();
  const wm = createWm(addon, { width: 1920, height: 1080 });
  wm.mapWindow(1, rec(1), 100, 100);
  wm.mapWindow(2, rec(2), 100, 100);
  wm.mapWindow(3, rec(3), 100, 100);
  wm.unmapWindow(2);
  assert.deepEqual(addon._stacks.at(-1), [1, 3]);
  assert.deepEqual(wm.state.windows.map((w) => w.surfaceId), [1, 3]);
});

test('unmapWindow: unknown id is a no-op', () => {
  const addon = mockAddon();
  const wm = createWm(addon, { width: 1920, height: 1080 });
  wm.mapWindow(1, rec(1), 100, 100);
  const before = addon._stacks.length;
  wm.unmapWindow(999);
  assert.equal(addon._stacks.length, before);
});

test('windowAt: returns the window containing the point', () => {
  const addon = mockAddon();
  const wm = createWm(addon, { width: 1920, height: 1080 });
  wm.mapWindow(1, rec(1), 300, 200); // rect (0,0,300,200)
  const hit = wm.windowAt(10, 10);
  assert.ok(hit);
  assert.equal(hit.surfaceId, 1);
});

test('windowAt: miss outside any window returns null', () => {
  const addon = mockAddon();
  const wm = createWm(addon, { width: 1920, height: 1080 });
  wm.mapWindow(1, rec(1), 300, 200);
  assert.equal(wm.windowAt(1000, 1000), null);
});

test('windowAt: edges are half-open [x, x+w) x [y, y+h)', () => {
  const addon = mockAddon();
  const wm = createWm(addon, { width: 1920, height: 1080 });
  wm.mapWindow(1, rec(1), 300, 200); // (0,0,300,200)
  assert.ok(wm.windowAt(0, 0), 'top-left inclusive');
  assert.equal(wm.windowAt(300, 0), null, 'right edge exclusive');
  assert.equal(wm.windowAt(0, 200), null, 'bottom edge exclusive');
  assert.ok(wm.windowAt(299, 199), 'just inside');
});

test('windowAt: topmost window wins on overlap', () => {
  const addon = mockAddon();
  const wm = createWm(addon, { width: 1920, height: 1080 });
  // Two windows both covering the origin region; window 2 is on top (mapped last).
  wm.mapWindow(1, rec(1), 300, 300);
  wm.mapWindow(2, rec(2), 300, 300);
  // Both at (0,0) only if placement put them there; the cascade offsets #2.
  // Force overlap by checking a point inside #2's rect, which is also inside #1.
  const w2 = wm.state.windows.find((w) => w.surfaceId === 2);
  const px = w2.rect.x + 5, py = w2.rect.y + 5;
  const hit = wm.windowAt(px, py);
  assert.equal(hit.surfaceId, 2, 'topmost (last-mapped) window is hit');
});
