// Test fixture: runs INSIDE a worker_threads Worker. Validates that a Worker can
// load the plugin addon + dawn.node, open a wire client on a core-provided fd,
// and bring up its own device -- the C-M4 step-4 make-or-break (Worker-owned wire
// client + dawn.node-in-a-Worker). The core (main thread) brokers the side-channel
// control; this Worker talks to it via parentPort.
//
// Handshake (Worker side):
//   recv {fd}        -> openWireClient(fd); reserveInstance(); post {reservedInstance}
//   recv {injected}  -> startDevice(); pump on a timer until ready
//   ready            -> wrap device via dawn.node, do a trivial op; post {deviceUp}

import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
        const instH = plugin.instanceHandle(clientId);
        const devH = plugin.deviceHandle(clientId);
        const dev = dawn.wrapDevice(instH, devH);
        const buf = dev.createBuffer({ size: 256, usage: dawn.globals.GPUBufferUsage.COPY_DST });
        buf.destroy();
        const dw = plugin.deviceWireHandle(clientId);
        parentPort.postMessage({ kind: "deviceUp", ok: true, deviceId: dw.id, deviceGeneration: dw.generation });
      } catch (e) {
        parentPort.postMessage({ kind: "deviceUp", ok: false, error: String(e) });
      }
    }, 4);
    tick.unref?.();
  }
});
