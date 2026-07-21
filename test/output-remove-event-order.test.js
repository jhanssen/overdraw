// M7 step 6: wl_surface.leave fires BEFORE wl_registry.global_remove on
// hotplug remove.
//
// The OutputRemoved JS handler (output/hotplug.ts) must emit
// wl_surface.leave for surfaces leaving the dying output BEFORE destroying
// the wl_output global. Once the global is destroyed, libwayland's
// wl_global_destroy queues wl_registry.global_remove and any wl_surface
// resource that referenced the wl_output via .enter would no longer have
// a wl_output resource to identify in the .leave event -- the client
// would observe an enter for an output that disappears with no
// corresponding leave.
//
// We verify the call order by capturing every event emission AND every
// addon.destroyGlobalForOutput invocation into a single timeline list,
// then asserting the indices.
//
// Tested in isolation (no real Wayland client; the trampoline + libwayland
// are stubbed). The on-the-wire ordering follows from the JS call order
// because both send_leave and destroyGlobalForOutput route through
// synchronous addon calls that immediately commit to libwayland's queue
// (wl_resource_post_event for the leave; wl_global_destroy for the
// global_remove). Real-client verification of this is the manual KMS
// check called out in the M7 handoff.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeOnOutputRemoved } from '../packages/core/dist/output/hotplug.js';
import { JsCompositor } from '../packages/core/dist/gpu/compositor.js';

// Build a fresh test fixture: a state with two outputs (0=DP-1, 1=HDMI-1),
// one mapped surface that overlaps output 1 only, the wl_output resources
// bound by the same client as the surface, and a fractional-scale resource
// for the surface. Returns the deps + a `timeline` list that captures
// every event emission and addon call in synchronous order.
function makeFixture() {
  const timeline = [];
  const log = (entry) => timeline.push(entry);

  // Surface resource (bound by client 7) and the two wl_output resources
  // bound by the same client so the residency differ can resolve leave to
  // the right wl_output.
  const surfaceRes = {
    __resource: "wl_surface", interfaceName: "wl_surface", version: 6,
    destroyed: false, _client: 7,
  };
  const out0Res = {
    __resource: "wl_output-0", interfaceName: "wl_output", version: 4,
    destroyed: false, _client: 7,
  };
  const out1Res = {
    __resource: "wl_output-1", interfaceName: "wl_output", version: 4,
    destroyed: false, _client: 7,
  };
  const fractionalRes = {
    __resource: "wp_fractional_scale", interfaceName: "wp_fractional_scale_v1",
    version: 1, destroyed: false, _client: 7,
  };

  const addon = {
    clientId: (r) => r._client ?? 1,
    createGlobalForOutput(_n, _id, _h) { /* not relevant */ },
    destroyGlobalForOutput(name, outputId) {
      log({ kind: "addon.destroyGlobalForOutput", name, outputId });
    },
    reserveScanoutForOutput(_outputId, _w, _h) { /* not relevant */ },
    releaseScanoutForOutput(outputId) {
      log({ kind: "addon.releaseScanoutForOutput", outputId });
    },
    updateOutputLayout(_rects) { /* not relevant */ },
  };

  // Compositor must satisfy the residency differ AND survive the
  // instanceof JsCompositor check that pushOutputsToLayers does.
  const compositor = Object.create(JsCompositor.prototype);
  compositor.setOutputs = (_outs) => { /* not relevant */ };
  // surfaceOutputs reflects the CURRENT state.outputs at call time
  // (matches the production behavior: when hotplug.ts removes the
  // output then calls updateAllSurfaceResidency, surfaceOutputs returns
  // the reduced set; the residency differ emits leave for the missing
  // output).
  compositor.surfaceOutputs = (surfaceId) => {
    if (surfaceId !== 42) return [];
    return [...state.outputs.keys()].filter((id) => id === 1);
  };
  // The residency differ prefers the stack-gated variant; this harness
  // models no stacks, so visibility == geometry.
  compositor.surfaceVisibleOutputs = compositor.surfaceOutputs;

  const events = {
    wl_surface: {
      send_enter(surface, output) {
        log({ kind: "wl_surface.send_enter", surface, output });
      },
      send_leave(surface, output) {
        log({ kind: "wl_surface.send_leave", surface, output });
      },
    },
    wp_fractional_scale_v1: {
      send_preferred_scale(resource, scale120) {
        log({ kind: "wp_fractional_scale_v1.send_preferred_scale",
              resource, scale120 });
      },
    },
  };

  const surfaceRec = {
    id: 42, resource: surfaceRes, mapped: true,
    enteredOutputs: new Set([1]),  // surface currently overlaps output 1 only
  };

  const state = {
    outputs: new Map([
      [0, {
        id: 0, name: "DP-1", edidId: "",
        logicalPosition: { x: 0, y: 0 },
        logicalSize: { width: 1920, height: 1080 },
        deviceSize: { width: 1920, height: 1080 },
        scale: 1, description: "DP-1", refreshMhz: 60000, transform: 0,
        physicalWidthMm: 500, physicalHeightMm: 280, make: "t", model: "DP-1",
      }],
      [1, {
        id: 1, name: "HDMI-1", edidId: "",
        logicalPosition: { x: 1920, y: 0 },
        logicalSize: { width: 1920, height: 1080 },
        deviceSize: { width: 1920, height: 1080 },
        scale: 2, description: "HDMI-1", refreshMhz: 60000, transform: 0,
        physicalWidthMm: 500, physicalHeightMm: 280, make: "t", model: "HDMI-1",
      }],
    ]),
    surfaces: new Map([[surfaceRes, surfaceRec]]),
    surfacesById: new Map([[42, surfaceRec]]),
    events,
    compositor,
    wlOutputResources: new Map([
      [0, new Set([out0Res])],
      [1, new Set([out1Res])],
    ]),
    fractionalScaleResources: new Map([[fractionalRes, surfaceRes]]),
    wm: {
      setOutputs: (_o) => { /* not relevant */ },
      primaryOutputId: () => {
        // Lowest live outputId. Matches the real WM's
        // primaryOutputId() that primaryOutputOfSurface falls back to
        // when the surface no longer overlaps anything.
        let lo = Infinity;
        for (const id of state.outputs.keys()) if (id < lo) lo = id;
        return lo === Infinity ? 0 : lo;
      },
    },
    relayout: (_r) => { /* not relevant */ },
  };

  const pluginBus = {
    emit(name, _payload) { log({ kind: "bus.emit", name }); },
  };

  const deps = {
    addon, state, compositor, pluginBus,
    config: { scale: null },
    allowEdidAutoScale: false,
    log: { info: () => {}, warn: () => {} },
  };

  return { deps, state, timeline, surfaceRes, out0Res, out1Res, fractionalRes };
}

test('OutputRemoved: wl_surface.leave fires BEFORE addon.destroyGlobalForOutput', () => {
  const { deps, timeline } = makeFixture();
  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 1 });  // unplug HDMI-1

  const iLeave = timeline.findIndex(
    (e) => e.kind === "wl_surface.send_leave");
  const iDestroyGlobal = timeline.findIndex(
    (e) => e.kind === "addon.destroyGlobalForOutput");

  assert.ok(iLeave >= 0, "wl_surface.leave was emitted");
  assert.ok(iDestroyGlobal >= 0, "destroyGlobalForOutput was called");
  assert.ok(iLeave < iDestroyGlobal,
    `wl_surface.leave (index ${iLeave}) must precede ` +
    `destroyGlobalForOutput (index ${iDestroyGlobal})`);
});

test('OutputRemoved: leave carries the wl_output resource of the dying output', () => {
  const { deps, timeline, out1Res } = makeFixture();
  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 1 });

  const leave = timeline.find((e) => e.kind === "wl_surface.send_leave");
  assert.ok(leave, "wl_surface.leave was emitted");
  assert.equal(leave.output, out1Res,
    "leave references the wl_output bound for the dying outputId");
});

test('OutputRemoved: fractional_scale re-emits with the surviving primary scale', () => {
  const { deps, timeline } = makeFixture();
  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 1 });

  // After remove, the only output left is 0 (scale=1 from the fixture).
  // Surface previously overlapped only output 1; residency diff drops
  // output 1 from enteredOutputs. The fractional-scale re-emit then
  // resolves to... well, the surface no longer overlaps any output.
  // primaryOutputOfSurface falls back to the geometric overlap, which
  // is empty, then to compositor.primaryOutputId() -- our mock
  // compositor doesn't provide one so primaryOutputId reads from
  // state.wm. The fixture's wm.primaryOutputId is undefined; the
  // fallback hits state.outputs.get(OUTPUT_DEFAULT)?.scale ?? 1 == 1.
  // The protocol value is round(scale * 120) = 120.
  const scaleEmit = timeline.find(
    (e) => e.kind === "wp_fractional_scale_v1.send_preferred_scale");
  assert.ok(scaleEmit, "wp_fractional_scale_v1.preferred_scale re-emitted");
  // Re-emit happens AFTER leave, so the residency-driven leave already
  // shrank the surface's enteredOutputs set; with no outputs left in
  // enteredOutputs the primary falls back to OUTPUT_DEFAULT = 0 with
  // scale 1 -> 120 in protocol units.
  assert.equal(scaleEmit.scale120, 120);
});

test('OutputRemoved: order is leave -> fractional re-emit -> global_remove', () => {
  const { deps, timeline } = makeFixture();
  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 1 });

  const iLeave = timeline.findIndex(
    (e) => e.kind === "wl_surface.send_leave");
  const iScale = timeline.findIndex(
    (e) => e.kind === "wp_fractional_scale_v1.send_preferred_scale");
  const iDestroyGlobal = timeline.findIndex(
    (e) => e.kind === "addon.destroyGlobalForOutput");

  assert.ok(iLeave >= 0 && iScale >= 0 && iDestroyGlobal >= 0,
    "all three events emitted");
  assert.ok(iLeave < iScale,
    "wl_surface.leave precedes fractional-scale re-emit");
  assert.ok(iScale < iDestroyGlobal,
    "fractional-scale re-emit precedes destroyGlobalForOutput");
});

test('OutputRemoved: no leave when surface does not overlap the dying output', () => {
  // Set up a surface that overlaps output 0 only; remove output 1; the
  // residency differ should find no change and emit no leave.
  const { deps, state, timeline } = makeFixture();
  // Move the surface to overlap output 0 only.
  const rec = [...state.surfaces.values()][0];
  rec.enteredOutputs = new Set([0]);
  state.compositor.surfaceOutputs = (sid) => sid === 42 ? [0] : [];
  state.compositor.surfaceVisibleOutputs = state.compositor.surfaceOutputs;

  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 1 });

  const iLeave = timeline.findIndex(
    (e) => e.kind === "wl_surface.send_leave");
  assert.equal(iLeave, -1,
    "no wl_surface.leave when the dying output was never part of the residency set");
});

test('OutputRemoved: LAST output still emits leave before global_remove', () => {
  // Unplugging the only monitor: the WM must be handed the virtual
  // fallback (its setOutputs contract forbids an empty set), and the
  // surface must still observe leave -> global_remove for the dying
  // output. A throw anywhere in this pipeline once left the compositor
  // unable to process the monitor's re-add.
  const { deps, state, timeline } = makeFixture();
  // Reduce to a single output (0) with the surface resident on it.
  state.outputs.delete(1);
  const rec = [...state.surfaces.values()][0];
  rec.enteredOutputs = new Set([0]);
  state.compositor.surfaceOutputs =
    (sid) => sid === 42 ? [...state.outputs.keys()] : [];
  state.compositor.surfaceVisibleOutputs = state.compositor.surfaceOutputs;
  state.fallbackOutput = {
    id: -1,
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 0, height: 0 },
    deviceSize: { width: 0, height: 0 },
    scale: 1, name: "__fallback__", description: "overdraw fallback output",
    refreshMhz: 0, transform: 0, physicalWidthMm: 0, physicalHeightMm: 0,
    make: "overdraw", model: "overdraw", edidId: "",
  };
  // Enforce the real WM contract; record what it received.
  const wmCalls = [];
  state.wm.setOutputs = (outs) => {
    if (outs.length === 0) throw new Error("setOutputs: outputs must be non-empty");
    wmCalls.push(outs.map((o) => ({ ...o })));
  };

  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 0 });  // must not throw

  assert.equal(wmCalls.length, 1);
  assert.equal(wmCalls[0][0].id, -1, "WM received the fallback output");

  const iLeave = timeline.findIndex((e) => e.kind === "wl_surface.send_leave");
  const iDestroyGlobal = timeline.findIndex(
    (e) => e.kind === "addon.destroyGlobalForOutput");
  const iRelease = timeline.findIndex(
    (e) => e.kind === "addon.releaseScanoutForOutput");
  assert.ok(iLeave >= 0, "wl_surface.leave emitted for the last output");
  assert.ok(iLeave < iDestroyGlobal, "leave precedes global_remove");
  assert.ok(iRelease > iDestroyGlobal, "scanout release runs last");
  assert.equal(state.outputs.size, 0);
});
