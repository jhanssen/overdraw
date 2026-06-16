// Composite-scissor on the REAL KMS scanout path. Unlike the headless test
// (composite-scissor.gpu.mjs, single offscreen target), this drives the
// nested/slot path: acquireOutputTexture() hands out the 3 rotating scanout-ring
// slots, presentOutput() does real DRM atomic page-flips, and the OutputDamageRing
// is keyed per slot -- the one thing the headless 1-slot target cannot exercise.
//
// Scanout slots are not readable back (readback() is headless-only), so this
// asserts that real page-flips occur (presentedCount advances) across content
// changes, and that the slot acquire/present/damage-consume loop runs without
// crashing -- not pixel values. Pixel correctness of the partial path is covered
// headlessly by composite-scissor.gpu.mjs.
//
// SELF-SKIPS unless canRunKms() (connected DRM connector + no active graphical
// session + dawn). CAUTION when it runs: it takes DRM-master and modesets the
// connected panel for real -- the panel shows these test frames, and (the KMS
// backend does not restore the prior CRTC on teardown) keeps the last frame
// until a VT switch repaints the console.
//
// Run: npm run test:gpu  (skips on machines without a free connected connector)

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";
import { canRunKms } from "./harness.mjs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OD = join(__dirname, "..", "packages", "core");

const addon = require(join(OD, "build", "overdraw_native.node"));
let dawn = null;
try {
  const [p] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  if (p) dawn = require(p);
} catch { dawn = null; }
const gpuBin = join(OD, "build", "overdraw-gpu-process");

const skip = canRunKms()
  ? false
  : "needs KMS (a free connected DRM connector, no active graphical session, dawn.node)";

const SZ = 256;
const BLUE = [255, 0, 0, 255];
const RED = [0, 0, 255, 255];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function solid(bgra, w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = bgra[0]; buf[i + 1] = bgra[1]; buf[i + 2] = bgra[2]; buf[i + 3] = bgra[3];
  }
  return { data: buf, stride };
}

test("KMS scanout: composite-scissor drives real page-flips across the slot ring", { skip }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));

  // backend:"kms" -> the core opens the card via libseat, takes DRM-master,
  // and sends the fd to the GPU process, which modesets the connector and
  // injects 3 scanout-ring slots.
  const dims = addon.start(gpuBin, () => {}, () => {}, { backend: "kms" });
  try {
    assert.ok(dims && dims.width > 0 && dims.height > 0, "KMS reported an output mode");
    const h = addon.gpuHandles();
    assert.ok(h, "gpuHandles");
    const device = dawn.wrapDevice(h.instance, h.device);
    const comp = new JsCompositor(device, dawn.globals, addon,
      { width: dims.width, height: dims.height }, dawn, h.device,
      { nested: true, format: addon.outputFormat() });

    // Let KMS bringup finish injecting the scanout slots.
    await sleep(150);

    const blue = solid(BLUE, SZ, SZ);
    comp.uploadPixels(1, { width: SZ, height: SZ, stride: blue.stride }, blue.data);
    comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
    comp.setStack([1]);

    const before = addon.presentedCount();
    // Drive several frames, alternating content each time. Frame 1 (first sight
    // of each slot) repaints fully; later frames damage only the surface rect ->
    // partial scissored frames on real rotating slots. Pace ~vsync so a slot
    // frees between presents (the page-flip completes over the ctrl fd).
    const red = solid(RED, SZ, SZ);
    for (let i = 0; i < 8; i++) {
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: blue.stride },
        (i % 2 === 0 ? red : blue).data);
      comp.renderFrame();
      await sleep(25);
    }
    const after = addon.presentedCount();
    assert.ok(after > before,
      `expected real page-flips on the scanout ring (presentedCount ${before} -> ${after})`);
  } finally {
    addon.stop();
  }
});
