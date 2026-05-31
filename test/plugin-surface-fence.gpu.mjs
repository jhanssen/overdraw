// C-M4 step 3: per-frame producer/consumer fence on a cross-process surface
// buffer. The plugin device (producer) renders a known color into its texture,
// EndAccess (-> sync-fd, held GPU-side); the core device (consumer) BeginAccess
// WAITS that fence, samples the same dmabuf, reads it back, and asserts the
// color. Proves the C-M1 cross-device fence applied per-frame across processes
// via the side channel (ProducerBegin/End, ConsumerBegin/End).
//
// Requires the GPU; skips if dawn.node is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OD = join(__dirname, "..");
const addon = require(join(OD, "build", "overdraw_native.node"));
let dawn = null;
try { const [p] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node")); if (p) dawn = require(p); } catch { dawn = null; }
const gpuBin = join(OD, "build", "overdraw-gpu-process");

const pConnect = () => new Promise((res, rej) => addon.pluginConnect((r) => r ? res(r) : rej(new Error("connect"))));
const pAlloc = (c, w, h) => new Promise((res, rej) => addon.pluginAllocSurfaceBuffer(c, w, h, (r) => r ? res(r) : rej(new Error("alloc"))));
const producerBegin = (id) => new Promise((res, rej) => addon.pluginSurfaceProducerBegin(id, (ok) => ok ? res() : rej(new Error("producerBegin"))));
const consumerBegin = (id) => new Promise((res, rej) => addon.pluginSurfaceConsumerBegin(id, (ok) => ok ? res() : rej(new Error("consumerBegin"))));

const SZ = 64;

test("cross-process producer/consumer fence: plugin renders, core samples", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  addon.start(gpuBin, () => {}, null, { width: SZ, height: SZ });
  try {
    const core = addon.gpuHandles();
    const coreDev = dawn.wrapDevice(core.instance, core.device);
    const p = await pConnect();
    const pluginDev = dawn.wrapDevice(p.instance, p.device);
    const sb = await pAlloc(p.connId, SZ, SZ);

    const prodTex = dawn.wrapTexture(p.device, sb.producerTexture);
    const consTex = dawn.wrapTexture(core.device, sb.consumerTexture);

    // --- Producer (plugin device): clear to a known color, then EndAccess.
    await producerBegin(sb.surfaceBufId);
    const R = 0.30, G = 0.60, B = 0.90;
    {
      const enc = pluginDev.createCommandEncoder();
      enc.beginRenderPass({
        colorAttachments: [{ view: prodTex.createView(), loadOp: "clear", storeOp: "store",
                             clearValue: { r: R, g: G, b: B, a: 1 } }],
      }).end();
      pluginDev.queue.submit([enc.finish()]);
    }
    addon.pluginSurfaceProducerEnd(sb.surfaceBufId, p.connId);

    // --- Consumer (core device): BeginAccess waits the producer fence, sample.
    await consumerBegin(sb.surfaceBufId);
    const g = dawn.globals;
    // textureLoad the dmabuf into an offscreen RGBA8 target, then read back.
    const mod = coreDev.createShaderModule({ code:
      "@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{" +
      "var p=array<vec2f,3>(vec2f(-1,-3),vec2f(3,1),vec2f(-1,1));return vec4f(p[i],0,1);}" +
      "@group(0) @binding(0) var t:texture_2d<f32>;" +
      "@fragment fn fs(@builtin(position) c:vec4f)->@location(0) vec4f{" +
      "return textureLoad(t, vec2i(i32(c.x),i32(c.y)), 0);}" });
    const off = coreDev.createTexture({ size: { width: SZ, height: SZ }, format: "rgba8unorm",
      usage: g.GPUTextureUsage.RENDER_ATTACHMENT | g.GPUTextureUsage.COPY_SRC });
    const pipe = coreDev.createRenderPipeline({ layout: "auto",
      vertex: { module: mod, entryPoint: "vs" }, primitive: { topology: "triangle-list" },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] } });
    const bg = coreDev.createBindGroup({ layout: pipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: consTex.createView() }] });
    const bpr = 256;
    const rb = coreDev.createBuffer({ size: bpr * SZ, usage: g.GPUBufferUsage.COPY_DST | g.GPUBufferUsage.MAP_READ });
    const enc = coreDev.createCommandEncoder();
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: off.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    rp.setPipeline(pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
    enc.copyTextureToBuffer({ texture: off }, { buffer: rb, bytesPerRow: bpr, rowsPerImage: SZ }, { width: SZ, height: SZ });
    coreDev.queue.submit([enc.finish()]);

    // Read back the offscreen (forces the sample of consTex to complete) BEFORE
    // ending the consumer access bracket -- EndAccess releases the dmabuf access,
    // so the sample must have executed first.
    await rb.mapAsync(g.GPUMapMode.READ);
    addon.pluginSurfaceConsumerEnd(sb.surfaceBufId);
    const px = new Uint8Array(rb.getMappedRange());
    const u8 = (v) => Math.round(v * 255);
    const got = [px[0], px[1], px[2], px[3]];
    rb.unmap();
    const tol = 3, exp = [u8(R), u8(G), u8(B), 255];
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(got[i] - exp[i]) <= tol,
      `channel ${i}: got ${got[i]} expected ${exp[i]} (full got ${got})`);
  } finally {
    addon.stop();
  }
});
