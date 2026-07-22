// markInitialCommitComplete vs. a client request landing mid-round-trip.
//
// markInitialCommitComplete snapshots the window state, emits
// window.preconfigure (an async plugin round-trip), then commits the
// result. A client-request propose arriving DURING that await advances the
// state synchronously (the pre-content stamp: a pre-map fullscreen X
// window's _NET_WM_STATE, an xdg set_fullscreen in the same batch). The
// commit must apply only the fields the plugins DELIBERATELY changed
// relative to the snapshot they were shown -- committing the stale
// snapshot wholesale reverts the stamp (observed as a fullscreen window
// flapping to none with reason "window-rule", the client then dropping
// fullscreen entirely on the resulting wrong-size configure).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';

function mockSink() {
  return {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
  };
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

// A pluginBus whose window.preconfigure emit blocks until the test releases
// it; every other emit resolves immediately with its payload.
function makeGatedBus() {
  let releasePreconfigure;
  const gate = new Promise((r) => { releasePreconfigure = r; });
  const committed = [];
  return {
    committed,
    releasePreconfigure: () => releasePreconfigure(),
    emit(name, payload) {
      if (name === 'window.committed') committed.push(payload);
      if (name === 'window.preconfigure') return gate.then(() => payload);
      return Promise.resolve(payload);
    },
  };
}

test('client request landing during the preconfigure round-trip survives the commit', async () => {
  const sink = mockSink();
  const bus = makeGatedBus();
  const wm = createWm(sink,
    [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }],
    { outputContent: () => new Map([[0, [1]]]), pluginBus: bus });
  wm.addWindow(1, res(1), { deferInitialCommit: true });

  // Initial commit starts; the preconfigure emit parks on the gate.
  const micc = wm.markInitialCommitComplete(1, {
    appId: 'game', title: 'g', xwayland: true,
  });
  await new Promise((r) => setTimeout(r, 10));

  // The pre-map fullscreen request lands mid-round-trip. The pre-content
  // stamp applies it synchronously.
  const p = wm.propose(1, { clientRequests: { wantsFullscreen: true } }, 'client-request');
  const win = wm.state.windows.find((w) => w.surfaceId === 1);
  assert.equal(win.windowState.sizeMode, 'fullscreen',
    'pre-content stamp resolved fullscreen synchronously');

  // Plugins return their (stale) snapshot unchanged; the commit must not
  // revert the stamp.
  bus.releasePreconfigure();
  await micc;
  await p;

  assert.equal(win.windowState.sizeMode, 'fullscreen',
    'fullscreen survived the initial-commit pipeline');
  const reverts = bus.committed.filter((ev) =>
    ev.previous?.sizeMode === 'fullscreen' && ev.current?.sizeMode === 'none');
  assert.deepEqual(reverts, [], 'no fullscreen->none commit was emitted');
  // The stamp must ANNOUNCE its edge: edge-driven consumers (the intercept
  // broker's excludeFullscreen) otherwise never learn the window went
  // fullscreen -- the async pass re-resolves to the same values and diffs
  // to nothing.
  const announced = bus.committed.filter((ev) =>
    ev.previous?.sizeMode === 'none' && ev.current?.sizeMode === 'fullscreen'
    && ev.changed?.includes('sizeMode'));
  assert.ok(announced.length >= 1,
    'the pre-content fullscreen stamp emitted a window.committed edge');
});

test('plugin changes made during preconfigure still apply', async () => {
  const sink = mockSink();
  let releasePreconfigure;
  const gate = new Promise((r) => { releasePreconfigure = r; });
  const bus = {
    emit(name, payload) {
      if (name === 'window.preconfigure') {
        // A window-rule floats the window (a deliberate plugin change),
        // resolving only after the gate opens.
        return gate.then(() => ({
          ...payload,
          initialState: { ...payload.initialState, tiling: 'floating' },
        }));
      }
      return Promise.resolve(payload);
    },
  };
  const wm = createWm(sink,
    [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }],
    { outputContent: () => new Map([[0, [1]]]), pluginBus: bus });
  wm.addWindow(1, res(1), { deferInitialCommit: true });

  const micc = wm.markInitialCommitComplete(1, { appId: 'app', title: 't', xwayland: false });
  await new Promise((r) => setTimeout(r, 10));
  // A concurrent client request on a DIFFERENT axis.
  const p = wm.propose(1, { clientRequests: { wantsFullscreen: true } }, 'client-request');
  releasePreconfigure();
  await micc;
  await p;

  const win = wm.state.windows.find((w) => w.surfaceId === 1);
  assert.equal(win.windowState.tiling, 'floating', 'plugin change (float) applied');
  assert.equal(win.windowState.sizeMode, 'fullscreen', 'client request preserved');
});
