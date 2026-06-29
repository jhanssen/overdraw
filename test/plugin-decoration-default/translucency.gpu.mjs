// The decoration blit composes the client over the border gradient with
// mix(gradient, client, coverage) + replace blend, so a TRANSLUCENT client
// keeps its own alpha in the inset (it blends against the real backdrop
// downstream) instead of being baked opaque toward the gradient. This drives
// render.ts directly: a known gradient + a translucent input texture, reading
// back the decoration output. Opaque inputs are unchanged (control case).

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OD = join(__dirname, "..", "..", "packages", "core");
const PLUGIN = join(__dirname, "..", "..", "packages", "plugin-decoration-default");
const addon = require(join(OD, "build", "overdraw_native.node"));
let dawn = null;
try {
  const [p] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  if (p) dawn = require(p);
} catch { dawn = null; }
const gpuBin = join(OD, "build", "overdraw-gpu-process");

const OUTW = 64, OUTH = 64, B = 8, INW = 48, INH = 48;
// Solid gray border (matches the bundled default unfocused fill #3a3a3a).
const GRAY = 0x3a / 0xff;
const FILL = { angleRad: 0, stops: [{ color: { r: GRAY, g: GRAY, b: GRAY, a: 1 }, at: 0 }] };
const GRAY_BYTE = 0x3a;

function bgraTexture(device, w, h, bgra) {
  const tex = device.createTexture({
    size: { width: w, height: h },
    format: "bgra8unorm",
    usage: dawn.globals.GPUTextureUsage.TEXTURE_BINDING
      | dawn.globals.GPUTextureUsage.COPY_DST,
  });
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bgra[0]; data[i + 1] = bgra[1]; data[i + 2] = bgra[2]; data[i + 3] = bgra[3];
  }
  device.queue.writeTexture({ texture: tex }, data,
    { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h });
  return tex;
}

async function renderDeco(device, jsCompositor, render, inputBgra) {
  const pipeline = render.createDecorationPipeline(device);
  const draw = render.createDecorationDraw(pipeline);
  render.writeBorderUniforms(device, draw, OUTW, OUTH, FILL);
  render.writeBlitUniforms(device, draw, OUTW, OUTH, INW, INH, B,
    { kind: 0, radius: 0 }, FILL);
  const input = bgraTexture(device, INW, INH, inputBgra);
  const output = device.createTexture({
    size: { width: OUTW, height: OUTH },
    format: "bgra8unorm",
    usage: dawn.globals.GPUTextureUsage.RENDER_ATTACHMENT
      | dawn.globals.GPUTextureUsage.COPY_SRC
      | dawn.globals.GPUTextureUsage.TEXTURE_BINDING,
  });
  render.encodeFrame(pipeline, draw, output.createView(), input);
  const r = await jsCompositor.readbackTexture(output, OUTW, OUTH);
  render.destroyDecorationDraw(draw);
  input.destroy();
  output.destroy();
  return r.data;
}

const px = (data, x, y) => {
  const i = (y * OUTW + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];   // BGRA
};

test("decoration blit preserves a translucent client's alpha; opaque unchanged",
    { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));
  const render = await import(join(PLUGIN, "dist", "render.js"));

  addon.start(gpuBin, () => {}, null, { width: OUTW, height: OUTH });
  try {
    // render.ts references bare WebGPU enum globals (GPUShaderStage,
    // GPUBufferUsage); the in-thread plugin loader installs the dawn.globals
    // bag on globalThis. Mirror that here.
    Object.assign(globalThis, dawn.globals);
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const jsCompositor = new JsCompositor(device, dawn.globals, addon,
      { width: OUTW, height: OUTH }, dawn, h.device);

    // --- Translucent client: premultiplied half-alpha red, BGRA [0,0,128,128].
    const transData = await renderDeco(device, jsCompositor, render, [0, 0, 128, 128]);
    const c = px(transData, OUTW >> 1, OUTH >> 1);   // inset center, coverage 1
    // Alpha is the client's own (~128), NOT forced opaque -- the bug baked it
    // to 255. R is the premultiplied red (~128); G/B stay ~0 -- the bug bled
    // the gray gradient in (~29 each).
    assert.ok(Math.abs(c[3] - 128) <= 6, `center alpha should be ~128 (translucent), got ${c[3]} (${c})`);
    assert.ok(Math.abs(c[2] - 128) <= 6, `center R should be ~128, got ${c[2]} (${c})`);
    assert.ok(c[0] <= 6 && c[1] <= 6, `center B/G should be ~0 (no gradient bleed), got ${c}`);

    // Band corner is the opaque gray gradient.
    const band = px(transData, 2, 2);
    assert.ok(Math.abs(band[0] - GRAY_BYTE) <= 4 && Math.abs(band[1] - GRAY_BYTE) <= 4
      && Math.abs(band[2] - GRAY_BYTE) <= 4 && band[3] >= 250,
      `band should be opaque gray gradient, got ${band}`);

    // --- Opaque client control: premultiplied opaque red, BGRA [0,0,255,255].
    const opaqueData = await renderDeco(device, jsCompositor, render, [0, 0, 255, 255]);
    const o = px(opaqueData, OUTW >> 1, OUTH >> 1);
    assert.ok(o[2] >= 250 && o[3] >= 250 && o[0] <= 6 && o[1] <= 6,
      `opaque center should be solid red, unchanged, got ${o}`);
  } finally {
    addon.stop();
  }
});
