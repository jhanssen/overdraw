// Test fixture (Worker): brings up its wire client + device exactly like
// worker-gpu-bringup.mjs, then on receiving {probe} performs:
//   1. Some wire traffic (createBuffer/destroy via dawn.node) -> bumps the
//      cross-channel ordering serial.
//   2. A reserveProducerTexture (which the production helper flushes inside
//      before sampling the serial).
// Reports two values: the serial sampled BEFORE the traffic, and the serial
// returned by reserveProducerTexture AFTER it. The test asserts the latter is
// strictly greater -- which proves reserveProducerTexture's internal flush
// commits any pending wire-client traffic into the FdSerializer before reading
// bytesQueued (the "captured too early" trap from the abandoned attempt would
// leave it unchanged).
//
// (Note: an empirical finding from this session is that ReserveTexture itself
// does NOT emit wire bytes in this Dawn build -- only descriptor-bearing /
// device-bound commands like createBuffer do. So the invariant we PIN is "the
// helper's internal flush commits prior wire-client traffic," which is what
// matters for the recycled-handle hazard: the wire bytes the GPU process must
// drain past are the OLD-handle-referencing commands from prior frames, not
// the new reserve.)

import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { join } from "node:path";
import { globSync } from "node:fs";

const require = createRequire(import.meta.url);
const OD = workerData.repoRoot;
const plugin = require(join(OD, "build", "overdraw_plugin_native.node"));
const [dp] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
const dawn = require(dp);

let clientId = null;

parentPort.on("message", (msg) => {
  if (msg.kind === "fd") {
    clientId = plugin.openWireClient(msg.fd);
    const inst = plugin.reserveInstance(clientId);
    parentPort.postMessage({ kind: "reservedInstance", id: inst.id, generation: inst.generation });
  } else if (msg.kind === "injected") {
    plugin.startDevice(clientId);
    const tick = setInterval(() => {
      const st = plugin.pump(clientId);
      if (st.failed) { clearInterval(tick); parentPort.postMessage({ kind: "deviceUp", ok: false }); return; }
      if (!st.ready) return;
      clearInterval(tick);
      try {
        const dw = plugin.deviceWireHandle(clientId);
        parentPort.postMessage({ kind: "deviceUp", ok: true, deviceId: dw.id, deviceGeneration: dw.generation });
      } catch (e) {
        parentPort.postMessage({ kind: "deviceUp", ok: false, error: String(e) });
      }
    }, 4);
    tick.unref?.();
  } else if (msg.kind === "probe") {
    try {
      const instH = plugin.instanceHandle(clientId);
      const devH = plugin.deviceHandle(clientId);
      const dev = dawn.wrapDevice(instH, devH);
      // Sample the serial BEFORE creating any new wire traffic.
      const beforeBq = plugin.wireBytesQueued(clientId);
      // Create wire traffic that DEFINITELY emits bytes: a buffer + destroy.
      const buf = dev.createBuffer({ size: 256, usage: dawn.globals.GPUBufferUsage.COPY_DST });
      buf.destroy();
      // DO NOT flush here -- the helper must flush internally for the captured
      // serial to include the bytes we just generated.
      const r = plugin.reserveProducerTexture(clientId, 9001, 16, 16);
      const captured = r.wireSerial;
      plugin.forgetProducerReservation(clientId, 9001);
      parentPort.postMessage({
        kind: "probeDone",
        beforeBq: beforeBq.toString(),
        captured: captured.toString(),
      });
    } catch (e) {
      parentPort.postMessage({ kind: "probeDone", error: String(e) });
    }
  }
});
