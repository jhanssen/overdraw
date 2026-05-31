// C-M4 step 4 make-or-break: a real worker_threads Worker loads the plugin addon
// + dawn.node, opens a wire client on a core-brokered fd, and brings up its OWN
// device IN THE WORKER ISOLATE. Validates Worker-owned wire client + dawn.node in
// a Worker + the Worker<->core<->GPU handshake (core brokers the side channel).
//
// Requires the GPU; skips if dawn.node is absent.

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

// Core broker helpers (Promise-wrapped async addon calls).
const createConn = () => new Promise((res, rej) => addon.pluginCreateConnection((r) => r ? res(r) : rej(new Error("createConnection"))));
const injectInstance = (connId, id, gen) => new Promise((res, rej) => addon.pluginInjectInstance(connId, id, gen, (ok) => ok ? res() : rej(new Error("injectInstance"))));

test("plugin Worker brings up its own device over its own wire client", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  addon.start(gpuBin, () => {}, null, { width: 64, height: 64 });
  const worker = new Worker(join(__dirname, "fixtures", "worker-gpu-bringup.mjs"),
    { workerData: { repoRoot: OD } });
  try {
    // Broker the connection first so connId is known to the message handler.
    const { connId, fd } = await createConn();

    const deviceUp = new Promise((resolve, reject) => {
      worker.on("message", async (msg) => {
        try {
          if (msg.kind === "reservedInstance") {
            // Core injects the instance the Worker reserved over the side channel.
            await injectInstance(connId, msg.id, msg.generation);
            worker.postMessage({ kind: "injected" });
          } else if (msg.kind === "deviceUp") {
            if (!msg.ok) return reject(new Error("worker device bring-up failed: " + (msg.error ?? "")));
            // Core relays the Worker's device handle so the GPU process ticks it.
            addon.pluginSetTickDevice(connId, msg.deviceId, msg.deviceGeneration);
            resolve();
          }
        } catch (e) { reject(e); }
      });
      worker.on("error", reject);
    });

    worker.postMessage({ kind: "fd", fd });
    await deviceUp;
  } finally {
    await worker.terminate();
    addon.stop();
  }
});
