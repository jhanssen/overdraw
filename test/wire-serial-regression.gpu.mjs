// Regression test for the "captured-too-early" wire-serial trap.
//
// CONTEXT. The plugin worker's reserveProducerTexture() reserves a wire texture,
// FLUSHES the wire client, and samples FdSerializer::bytesQueued() inside the
// native call. That serial gates the GPU process's plugin-side InjectTexture for
// AllocSurfaceBuf (recycled-handle hazard): the GPU process holds the inject
// until its plugin-conn wire reader has consumed past the serial -- so all
// prior wire traffic (especially any commands referencing the OLD handle id at
// the recycled spot) has been applied before the new InjectTexture installs a
// new object there.
//
// If the flush we call inside the helper does NOT actually commit dawn.node-
// issued commands into the FdSerializer (the trap the abandoned attempt fell
// into), the captured serial fails to include preceding traffic, the GPU
// process "catches up" before the old commands are drained, and the inject can
// target a stale binding.
//
// Empirical note for this Dawn build: ReserveTexture itself does NOT emit wire
// bytes (it is pure client-side handle bookkeeping; the server materializes the
// texture via InjectTexture instead). The wire bytes that need draining for
// the recycled-handle hazard are the OLD-handle-referencing commands from
// prior frames -- NOT the new reserve. The invariant this test pins is
// therefore: the captured serial includes prior wire-client traffic.
//
// Test: emit some wire traffic via dawn.node (createBuffer/destroy) WITHOUT
// calling flush from JS. Then call reserveProducerTexture (which must flush
// internally). Assert the captured serial is strictly greater than the serial
// sampled BEFORE the traffic. If the helper omits its internal flush, the
// captured serial would equal the pre-traffic value and the test fails.

import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
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

const createConn = () => new Promise((res, rej) =>
  addon.pluginCreateConnection((r) => r ? res(r) : rej(new Error("createConnection"))));
const injectInstance = (connId, id, gen) => new Promise((res, rej) =>
  addon.pluginInjectInstance(connId, id, gen, (ok) => ok ? res() : rej(new Error("injectInstance"))));

test("reserveProducerTexture internal flush captures prior wire-client traffic",
     { skip: !dawn ? "dawn.node not built" : false }, async () => {
  addon.start(gpuBin, () => {}, null, { width: 64, height: 64 });
  const worker = new Worker(join(__dirname, "fixtures", "wire-serial-probe.mjs"),
    { workerData: { repoRoot: OD } });
  try {
    const { connId, fd } = await createConn();
    const result = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("timed out")), 15000);
      worker.on("message", async (msg) => {
        try {
          if (msg.kind === "reservedInstance") {
            await injectInstance(connId, msg.id, msg.generation);
            worker.postMessage({ kind: "injected" });
          } else if (msg.kind === "deviceUp") {
            if (!msg.ok) { clearTimeout(to); return reject(new Error("worker device bring-up failed: " + (msg.error ?? ""))); }
            addon.pluginSetTickDevice(connId, msg.deviceId, msg.deviceGeneration);
            worker.postMessage({ kind: "probe" });
          } else if (msg.kind === "probeDone") {
            clearTimeout(to);
            resolve(msg);
          }
        } catch (e) { clearTimeout(to); reject(e); }
      });
      worker.on("error", (e) => { clearTimeout(to); reject(e); });
      worker.postMessage({ kind: "fd", fd });
    });

    if (result.error) throw new Error(`probe failed in worker: ${result.error}`);
    const before = BigInt(result.beforeBq);
    const captured = BigInt(result.captured);
    // The helper's internal flush must have committed the createBuffer/destroy
    // commands issued AFTER `before` was sampled but BEFORE the helper ran. The
    // captured serial therefore must be strictly greater than `before`.
    assert.ok(captured > before,
      `captured serial ${captured} must be > pre-traffic serial ${before} `
      + `(reserveProducerTexture's internal flush must commit prior wire traffic)`);
  } finally {
    await worker.terminate();
    addon.stop();
  }
});
