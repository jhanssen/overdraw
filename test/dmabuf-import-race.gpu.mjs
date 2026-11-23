// A dmabuf import that completes after its surface was removed must not
// resurrect the surface: the lifecycle's deferred release tears the import
// down on completion, and binding it afterwards left a Surface sampling
// freed texture memory, failing every queue submit (whole-compositor
// freeze). The native import is stubbed so the completion can be fired by
// hand after removeSurface. Headless; requires the GPU; skips if dawn.node
// is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();
const W = 64, H = 64;
const XRGB8888 = 0x34325258;

test("import completing after surface removal does not resurrect the surface",
  { skip: !dawn ? "dawn.node not built" : false }, async () => {
    const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));
    addon.start(gpuBin, () => {}, null, { width: W, height: H });
    try {
      const h = addon.gpuHandles();
      assert.ok(h, "gpuHandles");
      const device = dawn.wrapDevice(h.instance, h.device);
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });

      let complete = null;
      const released = [];
      comp.addon = Object.assign(Object.create(Object.getPrototypeOf(comp.addon) ?? null), comp.addon, {
        createTextureFromDmabuf: (_fd, _w, _h, _f, _mh, _ml, _o, _s, cb) => { complete = cb; return 77; },
        releaseDmabufImport: (importId) => { released.push(importId); },
      });
      const fakeTex = { width: W, height: H, createView: () => ({}) };
      comp.dawn = { ...comp.dawn, wrapTexture: () => fakeTex };
      comp.deviceHandle = 1n;
      const fd = { closed: false, close() { this.closed = true; }, takeRawFd: () => -1 };

      assert.equal(comp.commitSurfaceDmabuf(5, fd, W, H, XRGB8888, 0, 0, 0, W * 4, 900), true);
      assert.ok(complete, "import started");
      comp.removeSurface(5);
      assert.equal(comp.surfaces.has(5), false);

      complete(1234n);
      assert.equal(comp.surfaces.has(5), false, "removed surface not recreated");
      assert.equal(comp.dmabufImports.has(900), false, "import released, not cached");
      assert.deepEqual(released, [77], "native import released");
    } finally {
      addon.stop();
    }
  });
