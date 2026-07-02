// wl_surface.enter / wl_surface.leave (M6): the surface-residency module
// diffs each surface's currently-overlapping outputs against its tracked
// set and emits enter/leave per crossing. The wl_output resource on the
// event is the one bound by the surface's CLIENT for the relevant output.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  updateSurfaceOutputResidency, updateAllSurfaceResidency,
} from '../packages/core/dist/protocols/surface-residency.js';

function mockResource(name, clientId) {
  return { __resource: name, interfaceName: name, version: 4, destroyed: false, _client: clientId };
}

function mockAddon() {
  return { clientId: (r) => r._client ?? 1 };
}

function mockState(opts) {
  const calls = [];
  const events = {
    wl_surface: {
      send_enter(surface, output) { calls.push(["enter", { surface, output }]); },
      send_leave(surface, output) { calls.push(["leave", { surface, output }]); },
    },
  };
  const compositor = {
    surfaceOutputs: opts.surfaceOutputs,
  };
  const state = {
    surfaces: new Map(),
    surfacesById: new Map(),
    compositor, events,
    wlOutputResources: opts.wlOutputResources ?? new Map(),
  };
  return { state, calls };
}

test('first map: emits enter for every overlapped output (for which the client has a wl_output)', () => {
  const surfaceRes = mockResource("wl_surface", 7);
  const out0Res = mockResource("wl_output-0", 7);
  const out1Res = mockResource("wl_output-1", 7);
  const wlOR = new Map([[0, new Set([out0Res])], [1, new Set([out1Res])]]);
  const { state, calls } = mockState({
    surfaceOutputs: () => [0, 1],
    wlOutputResources: wlOR,
  });
  const rec = { id: 42, resource: surfaceRes };
  state.surfaces.set(surfaceRes, rec);
  state.surfacesById.set(42, rec);
  updateSurfaceOutputResidency(state, mockAddon(), rec);
  // Two enter events; both deliver the right wl_output resource.
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c[0] === "enter"));
  const enteredFor = new Map(calls.map((c) => [c[1].output, c[1].surface]));
  assert.equal(enteredFor.get(out0Res), surfaceRes);
  assert.equal(enteredFor.get(out1Res), surfaceRes);
});

test('residency change: leave for the disjoint output, enter for the new one', () => {
  const surfaceRes = mockResource("wl_surface", 7);
  const out0Res = mockResource("wl_output-0", 7);
  const out1Res = mockResource("wl_output-1", 7);
  const wlOR = new Map([[0, new Set([out0Res])], [1, new Set([out1Res])]]);
  let overlapping = [0];
  const { state, calls } = mockState({
    surfaceOutputs: () => overlapping,
    wlOutputResources: wlOR,
  });
  const rec = { id: 42, resource: surfaceRes };
  state.surfaces.set(surfaceRes, rec);
  state.surfacesById.set(42, rec);
  updateSurfaceOutputResidency(state, mockAddon(), rec);
  calls.length = 0;
  overlapping = [1];
  updateSurfaceOutputResidency(state, mockAddon(), rec);
  // leave on output 0, enter on output 1, in that order.
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "leave");
  assert.equal(calls[0][1].output, out0Res);
  assert.equal(calls[1][0], "enter");
  assert.equal(calls[1][1].output, out1Res);
});

test('no change: emits nothing on idempotent call', () => {
  const surfaceRes = mockResource("wl_surface", 7);
  const out0Res = mockResource("wl_output-0", 7);
  const wlOR = new Map([[0, new Set([out0Res])]]);
  const { state, calls } = mockState({
    surfaceOutputs: () => [0],
    wlOutputResources: wlOR,
  });
  const rec = { id: 42, resource: surfaceRes };
  state.surfaces.set(surfaceRes, rec);
  state.surfacesById.set(42, rec);
  updateSurfaceOutputResidency(state, mockAddon(), rec);
  calls.length = 0;
  updateSurfaceOutputResidency(state, mockAddon(), rec);
  assert.deepEqual(calls, []);
});

test('client has not bound wl_output for an overlapped output: event is suppressed', () => {
  // Surface client = 7, but the wl_output for outputId 1 is bound by a
  // different client (5). The diff should NOT emit enter for output 1 to
  // client 7 (it has no wl_output resource to attach the event to).
  const surfaceRes = mockResource("wl_surface", 7);
  const out0Res = mockResource("wl_output-0", 7);
  const out1Foreign = mockResource("wl_output-1", 5);
  const wlOR = new Map([[0, new Set([out0Res])], [1, new Set([out1Foreign])]]);
  const { state, calls } = mockState({
    surfaceOutputs: () => [0, 1],
    wlOutputResources: wlOR,
  });
  const rec = { id: 42, resource: surfaceRes };
  state.surfaces.set(surfaceRes, rec);
  state.surfacesById.set(42, rec);
  updateSurfaceOutputResidency(state, mockAddon(), rec);
  // Only one event -- enter on output 0 -- because output 1's wl_output is
  // bound by client 5, not 7.
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].output, out0Res);
  // But enteredOutputs IS updated to include 1: a future bind of wl_output
  // for outputId 1 by client 7 still won't backfill -- the spec is fine
  // with this; clients enumerate wl_output BEFORE creating surfaces in the
  // normal case.
  assert.deepEqual([...rec.enteredOutputs].sort(), [0, 1]);
});

test('updateAllSurfaceResidency: skips unmapped surfaces', () => {
  const mappedRes = mockResource("wl_surface-A", 7);
  const unmappedRes = mockResource("wl_surface-B", 7);
  const out0Res = mockResource("wl_output-0", 7);
  const wlOR = new Map([[0, new Set([out0Res])]]);
  const { state, calls } = mockState({
    surfaceOutputs: () => [0],
    wlOutputResources: wlOR,
  });
  const mapped = { id: 1, resource: mappedRes, mapped: true };
  const unmapped = { id: 2, resource: unmappedRes, mapped: false };
  state.surfaces.set(mappedRes, mapped);
  state.surfaces.set(unmappedRes, unmapped);
  state.surfacesById.set(1, mapped);
  state.surfacesById.set(2, unmapped);
  updateAllSurfaceResidency(state, mockAddon());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].surface, mappedRes);
});

test('role detach (empty override) emits leave-all so a reused surface does not double-enter', () => {
  // A client that keeps one wl_surface across successive roles (Qt reuses one
  // surface for successive menu popups) must get a leave when the role is
  // detached, else the next role's enter is a duplicate with no intervening
  // leave -- QtWayland's "Ignoring unexpected wl_surface.enter". detachSurfaceRole
  // drives this by calling updateSurfaceOutputResidency with an empty override.
  const surfaceRes = mockResource("wl_surface", 7);
  const out0Res = mockResource("wl_output-0", 7);
  const wlOR = new Map([[0, new Set([out0Res])]]);
  let overlapping = [0];
  const { state, calls } = mockState({
    surfaceOutputs: () => overlapping,
    wlOutputResources: wlOR,
  });
  const rec = { id: 42, resource: surfaceRes };
  state.surfaces.set(surfaceRes, rec);
  state.surfacesById.set(42, rec);

  // 1) Popup maps on output 0 -> enter.
  updateSurfaceOutputResidency(state, mockAddon(), rec);
  // 2) Popup role detached (unmap): leave-all via empty override.
  updateSurfaceOutputResidency(state, mockAddon(), rec, []);
  // 3) Same surface re-roled onto output 0 again -> a fresh enter.
  overlapping = [0];
  updateSurfaceOutputResidency(state, mockAddon(), rec);

  // The client sees enter, leave, enter -- never enter, enter.
  assert.deepEqual(calls.map((c) => [c[0], c[1].output]), [
    ["enter", out0Res],
    ["leave", out0Res],
    ["enter", out0Res],
  ]);
  // The empty override reset the tracked set between roles.
  assert.deepEqual([...rec.enteredOutputs], [0]);
});

test('destroyed wl_output resource is skipped during enter emission', () => {
  const surfaceRes = mockResource("wl_surface", 7);
  const stale = mockResource("wl_output-stale", 7);
  stale.destroyed = true;
  const wlOR = new Map([[0, new Set([stale])]]);
  const { state, calls } = mockState({
    surfaceOutputs: () => [0],
    wlOutputResources: wlOR,
  });
  const rec = { id: 42, resource: surfaceRes };
  state.surfaces.set(surfaceRes, rec);
  state.surfacesById.set(42, rec);
  updateSurfaceOutputResidency(state, mockAddon(), rec);
  // No enter emitted -- the bound resource is dead. But residency still
  // tracks the output so a future re-emit (after the client re-binds) sees
  // the diff as zero (no churn).
  assert.deepEqual(calls, []);
  assert.deepEqual([...rec.enteredOutputs], [0]);
});
