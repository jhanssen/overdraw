// C-M1 verification: the two-device cross-device dmabuf-STM + sync-fd-fence
// round-trip the plugin producer/consumer primitive depends on. status.md flagged
// this exact composition as "assumed to work, unverified" ("two-device cross-
// device sharing ... the sync-fd is produced but not waited on across a device
// boundary"). This asserts it on real hardware before any plugin GPU surface is
// built on top.
//
// The GPU process runs a self-contained selftest (--selftest-xdev): two native
// wgpu::Devices share one GBM dmabuf; device A renders a known color + EndAccess
// (exports a SharedFenceSyncFD); device B BeginAccess WAITS that fence, samples
// the dmabuf, reads it back, and asserts the color. It prints XDEV: PASS/FAIL.
//
// Needs the GPU/DRM render node (needs GPU (no render node / dawn.node) surface; the selftest is fully
// internal). Gated on canRunGpu() for consistency with the other gpu.mjs tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { canRunGpu, buildBin } from "./harness.mjs";

const skip = !canRunGpu() ? "needs the GPU" : false;

test("cross-device dmabuf STM + sync-fd fence round-trip (XDEV)", { skip }, async () => {
  const bin = buildBin("overdraw-gpu-process");
  const { code, out } = await new Promise((resolve, reject) => {
    const p = spawn(bin, ["--selftest-xdev"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { out += d.toString(); });
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("selftest timed out")); }, 60000);
    p.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
    p.on("error", reject);
  });
  // The readback line carries the got/expected pixels for diagnosis on failure.
  assert.match(out, /XDEV: PASS/, `selftest did not pass:\n${out}`);
  assert.equal(code, 0, `selftest exit code ${code}:\n${out}`);
});
