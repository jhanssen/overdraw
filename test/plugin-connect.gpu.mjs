// C-M4 step 1 (runtime-proves C-M2): a NEW plugin wire connection to the GPU
// process brings up its OWN device. addon.pluginConnect() creates a socketpair,
// hands the GPU-end to the GPU process over the side channel (AddWireConn), opens
// a second WireClient on the client-end, reserves+injects the instance
// (InjectPluginInstance), and RequestAdapter/RequestDevice over the new
// connection. Asserts the returned handles are usable: dawn.node wrapDevice +
// a trivial device op (createBuffer) succeed -> two WireClients coexist under the
// one global proc table (objects route per-owning-client).
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
try {
  const [p] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  if (p) dawn = require(p);
} catch { dawn = null; }
const gpuBin = join(OD, "build", "overdraw-gpu-process");

test("plugin wire connection brings up its own device", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  addon.start(gpuBin, () => {}, null, { width: 64, height: 64 });
  try {
    // The core's own device first (proves the existing connection still works).
    const core = addon.gpuHandles();
    assert.ok(core && core.device, "core gpuHandles");

    // A second, independent plugin connection + device.
    const p = addon.pluginConnect();
    assert.ok(p, "pluginConnect returned handles");
    assert.equal(typeof p.connId, "number");
    assert.ok(p.instance && p.device, "plugin instance+device handles");
    // The plugin device must be a DISTINCT handle from the core device.
    assert.notEqual(p.device, core.device, "plugin device != core device");

    // Wrap the plugin device via dawn.node and do a trivial op. If the two
    // WireClients did not route per-object correctly, this would target the wrong
    // client / fail.
    const dev = dawn.wrapDevice(p.instance, p.device);
    const buf = dev.createBuffer({ size: 256, usage: dawn.globals.GPUBufferUsage.COPY_DST });
    assert.ok(buf, "createBuffer on the plugin device");
    buf.destroy();

    // C-M4 step 2: allocate a producer/consumer surface buffer (one GBM dmabuf
    // imported into BOTH the plugin device and the core device). Both texture
    // handles must wrap (dawn.node wrapTexture) on their respective devices.
    const coreDev = dawn.wrapDevice(core.instance, core.device);
    const sb = addon.pluginAllocSurfaceBuffer(p.connId, 64, 64);
    assert.ok(sb && sb.surfaceBufId, "pluginAllocSurfaceBuffer");
    assert.notEqual(sb.producerTexture, 0n, "producer texture handle");
    assert.notEqual(sb.consumerTexture, 0n, "consumer texture handle");
    // Producer texture on the plugin device, consumer on the core device.
    const prodTex = dawn.wrapTexture(p.device, sb.producerTexture);
    const consTex = dawn.wrapTexture(core.device, sb.consumerTexture);
    assert.ok(prodTex, "wrap producer texture (plugin device)");
    assert.ok(consTex, "wrap consumer texture (core device)");
    // The producer can make a render-attachment view; the consumer a sampled view.
    assert.ok(prodTex.createView(), "producer view");
    assert.ok(consTex.createView(), "consumer view");
  } finally {
    addon.stop();
  }
});
