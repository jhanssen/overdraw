// Pure-unit tests for the reserved-zone registry.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReservedZoneRegistry } from '../packages/core/dist/wm/reserved-zones.js';

const outputRect = { x: 0, y: 0, width: 1000, height: 600 };

test('no zones: effectiveRect returns outputRect unchanged', () => {
  const r = createReservedZoneRegistry();
  assert.deepEqual(r.effectiveRect(0, outputRect), outputRect);
});

test('top zone: shrinks from the top', () => {
  const r = createReservedZoneRegistry();
  r.set('bar', { outputId: 0, edge: 'top', thickness: 30, owner: 1 });
  assert.deepEqual(r.effectiveRect(0, outputRect),
    { x: 0, y: 30, width: 1000, height: 570 });
});

test('bottom + right zones: shrinks both', () => {
  const r = createReservedZoneRegistry();
  r.set('dock', { outputId: 0, edge: 'bottom', thickness: 50, owner: 1 });
  r.set('panel', { outputId: 0, edge: 'right', thickness: 100, owner: 2 });
  assert.deepEqual(r.effectiveRect(0, outputRect),
    { x: 0, y: 0, width: 900, height: 550 });
});

test('multiple zones on the same edge: thicknesses sum', () => {
  const r = createReservedZoneRegistry();
  r.set('bar1', { outputId: 0, edge: 'top', thickness: 20, owner: 1 });
  r.set('bar2', { outputId: 0, edge: 'top', thickness: 10, owner: 2 });
  assert.deepEqual(r.effectiveRect(0, outputRect),
    { x: 0, y: 30, width: 1000, height: 570 });
});

test('zones for a different output do not affect this one', () => {
  const r = createReservedZoneRegistry();
  r.set('bar', { outputId: 1, edge: 'top', thickness: 30, owner: 1 });
  assert.deepEqual(r.effectiveRect(0, outputRect), outputRect);
});

test('clear removes a zone', () => {
  const r = createReservedZoneRegistry();
  r.set('bar', { outputId: 0, edge: 'top', thickness: 30, owner: 1 });
  r.clear('bar');
  assert.deepEqual(r.effectiveRect(0, outputRect), outputRect);
});

test('set replaces an existing zone with the same id', () => {
  const r = createReservedZoneRegistry();
  r.set('bar', { outputId: 0, edge: 'top', thickness: 30, owner: 1 });
  r.set('bar', { outputId: 0, edge: 'bottom', thickness: 50, owner: 1 });
  // Original top is gone; only bottom contributes.
  assert.deepEqual(r.effectiveRect(0, outputRect),
    { x: 0, y: 0, width: 1000, height: 550 });
});

test('all four edges: rect shrinks from each side', () => {
  const r = createReservedZoneRegistry();
  r.set('t', { outputId: 0, edge: 'top', thickness: 10, owner: 1 });
  r.set('r', { outputId: 0, edge: 'right', thickness: 20, owner: 2 });
  r.set('b', { outputId: 0, edge: 'bottom', thickness: 30, owner: 3 });
  r.set('l', { outputId: 0, edge: 'left', thickness: 40, owner: 4 });
  assert.deepEqual(r.effectiveRect(0, outputRect),
    { x: 40, y: 10, width: 940, height: 560 });
});

test('over-reservation: width/height clamp to 0, never negative', () => {
  const r = createReservedZoneRegistry();
  r.set('t', { outputId: 0, edge: 'top', thickness: 1000, owner: 1 });
  r.set('b', { outputId: 0, edge: 'bottom', thickness: 1000, owner: 2 });
  const eff = r.effectiveRect(0, outputRect);
  assert.equal(eff.height, 0);
});

test('negative thickness clamps to 0', () => {
  const r = createReservedZoneRegistry();
  r.set('bad', { outputId: 0, edge: 'top', thickness: -5, owner: 1 });
  assert.deepEqual(r.effectiveRect(0, outputRect), outputRect);
});

test('list enumerates zones for the given output', () => {
  const r = createReservedZoneRegistry();
  r.set('a', { outputId: 0, edge: 'top', thickness: 10, owner: 1 });
  r.set('b', { outputId: 1, edge: 'bottom', thickness: 20, owner: 2 });
  r.set('c', { outputId: 0, edge: 'right', thickness: 30, owner: 3 });
  const list = r.list(0);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((z) => z.edge).sort(), ['right', 'top']);
});

test('preserves outputRect origin (non-zero x/y)', () => {
  const r = createReservedZoneRegistry();
  r.set('top', { outputId: 0, edge: 'top', thickness: 20, owner: 1 });
  // outputRect not starting at origin (multi-output case)
  const rect = { x: 100, y: 200, width: 800, height: 600 };
  assert.deepEqual(r.effectiveRect(0, rect),
    { x: 100, y: 220, width: 800, height: 580 });
});
