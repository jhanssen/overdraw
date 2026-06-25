// Unit tests for zxdg_exporter_v2 + zxdg_importer_v2 (xdg-foreign-unstable-v2).
//   - export_toplevel mints a handle and sends it on the exported resource.
//   - export_toplevel on a non-toplevel surface posts invalid_surface.
//   - import_toplevel(handle) returns a valid imported; set_parent_of routes
//     to wm.propose with parent=<exporter surfaceId>.
//   - Unknown handle: imported still mints but immediately receives destroyed.
//   - Destroying the exporter sends destroyed to every dependent imported
//     and clears their parent edge.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import makeExporter, {
  makeExported,
  makeImporter,
  makeImported,
  _resetForTests,
} from '../packages/core/dist/protocols/xdg_foreign_v2.js';

function mockSink() {
  return {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
  };
}

function setup() {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  const surfaces = new Map();
  const sentEvents = [];
  const postErrorCalls = [];
  const state = { wm, surfaces };
  const addon = {
    postError(resource, code, message) {
      postErrorCalls.push({ resource, code, message });
    },
  };
  const events = {
    zxdg_exported_v2: {
      send_handle(resource, handle) {
        sentEvents.push(['handle', { resource, handle }]);
      },
    },
    zxdg_imported_v2: {
      send_destroyed(resource) {
        sentEvents.push(['destroyed', { resource }]);
      },
    },
  };
  const ctx = { state, addon, events };
  const exporter = makeExporter(ctx);
  const exported = makeExported(ctx);
  const importer = makeImporter(ctx);
  const imported = makeImported(ctx);
  return { wm, surfaces, exporter, exported, importer, imported, ctx, sentEvents, postErrorCalls };
}

function makeSurface(s, id, role) {
  const resource = { id, version: 1, destroyed: false };
  const rec = { id, resource, role };
  s.surfaces.set(resource, rec);
  return resource;
}

function makeToplevelSurface(s, id) {
  const surface = makeSurface(s, id, 'xdg_toplevel');
  s.wm.addWindow(id, { resource: surface });
  s.wm.windowHasContent(id);
  return surface;
}

import { beforeEach } from 'node:test';
beforeEach(() => { _resetForTests(); });

test('export_toplevel: mints a handle and sends it on the exported resource', () => {
  const s = setup();
  const surface = makeToplevelSurface(s, 1);
  const exporterRes = { id: 'e', version: 1, destroyed: false };
  const exportedRes = { id: 'ex1', version: 1, destroyed: false };
  s.exporter.export_toplevel(exporterRes, exportedRes, surface);
  const handleEv = s.sentEvents.find(([k]) => k === 'handle');
  assert.ok(handleEv);
  assert.equal(typeof handleEv[1].handle, 'string');
  assert.ok(handleEv[1].handle.length > 0);
  assert.equal(s.postErrorCalls.length, 0);
});

test('export_toplevel: non-toplevel surface posts invalid_surface', () => {
  const s = setup();
  const surface = makeSurface(s, 1, 'wl_subsurface'); // not toplevel
  const exporterRes = { id: 'e', version: 1, destroyed: false };
  const exportedRes = { id: 'ex1', version: 1, destroyed: false };
  s.exporter.export_toplevel(exporterRes, exportedRes, surface);
  assert.equal(s.postErrorCalls.length, 1);
  assert.equal(s.postErrorCalls[0].code, 0); // invalid_surface
});

test('import_toplevel + set_parent_of: routes through wm.propose with parent', async () => {
  const s = setup();
  const parentSurface = makeToplevelSurface(s, 1);
  // child surface in (conceptually) a different client.
  const childSurface = makeToplevelSurface(s, 2);
  // Export.
  const exporterRes = { id: 'e', version: 1, destroyed: false };
  const exportedRes = { id: 'ex1', version: 1, destroyed: false };
  s.exporter.export_toplevel(exporterRes, exportedRes, parentSurface);
  const handle = s.sentEvents.find(([k]) => k === 'handle')[1].handle;
  // Import on the (conceptual) recipient side.
  const importerRes = { id: 'i', version: 1, destroyed: false };
  const importedRes = { id: 'im1', version: 1, destroyed: false };
  s.importer.import_toplevel(importerRes, importedRes, handle);
  // set_parent_of(child).
  s.imported.set_parent_of(importedRes, childSurface);
  await new Promise((r) => setImmediate(r));
  // The child's parent should now be the parent's surfaceId.
  const childState = s.wm.getWindowState(2);
  assert.equal(childState.parent, 1);
});

test('import_toplevel with unknown handle: imported receives destroyed immediately', () => {
  const s = setup();
  const importerRes = { id: 'i', version: 1, destroyed: false };
  const importedRes = { id: 'im1', version: 1, destroyed: false };
  s.importer.import_toplevel(importerRes, importedRes, 'nonexistent-handle');
  const destroyedEv = s.sentEvents.find(([k]) => k === 'destroyed');
  assert.ok(destroyedEv, 'destroyed event sent');
  assert.equal(destroyedEv[1].resource, importedRes);
});

test('destroying the exporter sends destroyed to dependent imports + clears parent edge', async () => {
  const s = setup();
  const parentSurface = makeToplevelSurface(s, 1);
  const childSurface = makeToplevelSurface(s, 2);
  const exporterRes = { id: 'e', version: 1, destroyed: false };
  const exportedRes = { id: 'ex1', version: 1, destroyed: false };
  s.exporter.export_toplevel(exporterRes, exportedRes, parentSurface);
  const handle = s.sentEvents.find(([k]) => k === 'handle')[1].handle;
  const importerRes = { id: 'i', version: 1, destroyed: false };
  const importedRes = { id: 'im1', version: 1, destroyed: false };
  s.importer.import_toplevel(importerRes, importedRes, handle);
  s.imported.set_parent_of(importedRes, childSurface);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.wm.getWindowState(2).parent, 1);
  // Now exporter destroys the exported resource.
  s.sentEvents.length = 0;
  s.exported.destroy(exportedRes);
  await new Promise((r) => setImmediate(r));
  const destroyedEv = s.sentEvents.find(([k]) => k === 'destroyed');
  assert.ok(destroyedEv, 'destroyed event sent to imported');
  // Child's parent edge cleared.
  assert.equal(s.wm.getWindowState(2).parent, null);
});

test('destroying the imported clears the parent edge', async () => {
  const s = setup();
  const parentSurface = makeToplevelSurface(s, 1);
  const childSurface = makeToplevelSurface(s, 2);
  const exporterRes = { id: 'e', version: 1, destroyed: false };
  const exportedRes = { id: 'ex1', version: 1, destroyed: false };
  s.exporter.export_toplevel(exporterRes, exportedRes, parentSurface);
  const handle = s.sentEvents.find(([k]) => k === 'handle')[1].handle;
  const importerRes = { id: 'i', version: 1, destroyed: false };
  const importedRes = { id: 'im1', version: 1, destroyed: false };
  s.importer.import_toplevel(importerRes, importedRes, handle);
  s.imported.set_parent_of(importedRes, childSurface);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.wm.getWindowState(2).parent, 1);
  s.imported.destroy(importedRes);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.wm.getWindowState(2).parent, null);
});
