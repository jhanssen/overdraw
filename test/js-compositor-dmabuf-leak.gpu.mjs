// Slice-2 release-lifecycle leak test: a client commits many DISTINCT dmabufs on
// one surface, so the JS compositor imports + retires + releases per commit. The
// GPU process's open-fd count must stay bounded (each unreleased import holds a
// dmabuf fd + STM), proving ReleaseClientTex actually frees server-side
// resources rather than leaking ~one fd per frame.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { setupCompositor, canRunGpu, loadDawn, buildBin, gpuPids, fdCount } from "./harness.mjs";

const skip = !canRunGpu() ? "needs GPU (no render node / dawn.node)"
  : (!loadDawn() ? "dawn.node not built" : false);
const FRAMES = 40;

test("JS compositor: cycling dmabufs do not leak GPU-process fds", { skip }, async () => {
  // GPU processes alive before this compositor starts (e.g. a live overdraw
  // session on the host) are not ours to count; only the one this
  // setupCompositor spawns is fd-audited. Same exclusion the harness
  // teardown leak check uses.
  const preexisting = new Set(gpuPids());
  const c = await setupCompositor({ headless: { width: 1280, height: 720 }, jsCompositor: true });
  let client = null;
  try {
    const pids = gpuPids().filter((p) => !preexisting.has(p));
    assert.equal(pids.length, 1, `expected 1 new GPU process, got ${pids.length}`);
    const pid = pids[0];

    client = spawn(buildBin("dmabuf-cycle-client"), [c.sock, String(FRAMES)],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    client.stdout.on("data", (d) => { out += d.toString(); });

    // Baseline once the first buffer has mapped (a couple imports live).
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window", timeoutMs: 4000 });
    // settle a few frames so steady-state fd count is established
    await new Promise((r) => setTimeout(r, 100));
    const baseline = fdCount(pid);

    // Wait for all commits to complete.
    const t0 = Date.now();
    while (!out.includes(`committed ${FRAMES} buffers`) && Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(out.includes(`committed ${FRAMES} buffers`), `client did not finish; stdout:\n${out}`);
    // let final releases drain
    await new Promise((r) => setTimeout(r, 300));
    const after = fdCount(pid);

    const grew = after - baseline;
    // Released correctly: fd count is ~flat. A per-frame leak would be ~FRAMES.
    assert.ok(grew < 10,
      `GPU fd count grew by ${grew} over ${FRAMES} cycled buffers (baseline=${baseline} after=${after}) -- release path leaks`);
  } finally {
    if (client && client.exitCode === null && client.signalCode === null) {
      try { client.kill("SIGTERM"); } catch { /* gone */ }
      await once(client, "exit").catch(() => {});  // safe: not yet exited
    }
    await c.teardown();
  }
});
