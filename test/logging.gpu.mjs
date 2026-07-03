// End-to-end logging: the GPU process emits LOG_INFO records via its IpcSink
// over the log socket; the host's IpcSource reassembles + dispatches into
// spdlog; the file sink writes them out. Also exercises the JS->host path
// (addon.nativeLog) and confirms fragmentation of long payloads via the
// host's file sink. The IpcSink-side fragmentation invariant lives in the
// unit test (test/log.test.js); this file verifies the integrated wiring.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadAddon, gpuBin } from "./harness.mjs";

const addon = loadAddon();

async function waitForLog(path, predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { /* not yet */ }
    if (predicate(text)) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test("logging: GPU + host records reach the host's file sink (incl. long messages)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "overdraw-log-test-"));
  const logPath = join(dir, "compositor.log");
  addon.logInit({ levelSpec: "trace", logFile: logPath });
  addon.start(gpuBin, () => {}, null, { width: 64, height: 64 });
  try {
    // GPU-process side: LOG_INFO at run() entry is sent over the log socket,
    // reassembled by the host's IpcSource thread, and dispatched into the
    // 'gpu' logger.
    const text1 = await waitForLog(logPath, (t) => /overdraw-gpu-process up/.test(t));
    assert.ok(text1 !== null, `expected GPU 'up' line in ${logPath}; got: ${readFileSync(logPath, "utf8")}`);
    assert.match(text1, /\[gpu\].*overdraw-gpu-process up/, "expected '[gpu]' area tag");
    assert.match(text1, /info /i, "expected 'info' level tag");

    // Host side (addon.nativeLog -> spdlog -> file sink). Use a payload longer
    // than kLogFragBytes (480) to confirm long messages survive end-to-end --
    // this path does NOT cross the IPC socket, so it's the file sink + spdlog
    // formatter that is under test here.
    const long = "x".repeat(1500);
    addon.nativeLog(2 /*info*/, "core", `marker-long ${long}`);
    const text2 = await waitForLog(logPath, (t) => t.includes("marker-long"));
    assert.ok(text2 !== null, `expected 'marker-long' in ${logPath}`);
    assert.match(text2, new RegExp(`marker-long x{1500}`),
                 "expected the full 1500-char payload to be preserved");
  } finally {
    addon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
