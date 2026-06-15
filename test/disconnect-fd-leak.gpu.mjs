// Disconnect-sweep fd-leak guards (compositor/node side).
//
// Two client-buffer fd lifecycles must not leak a fd in the compositor process
// when a client goes away:
//
//  1. dmabuf: each zwp_linux_buffer_params.add carries a dmabuf fd. libwayland
//     transfers ownership of that fd to the dispatcher (it does NOT close it),
//     so the trampoline must wrap it directly -- duping and leaving the original
//     open leaks one dmabuf fd per buffer the client ever sends.
//  2. shm: a wl_shm_pool the client never destroys (it just disconnects) holds
//     an mmap + a dup'd memfd in the compositor. The disconnect sweep must free
//     it (after releasing the pool's per-buffer refs).
//
// Both cleanups run in the frame-driven disconnect sweep, so this needs the live
// compositor (GPU tier). The compositor runs in THIS process, so we count fds on
// process.pid.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readlinkSync } from "node:fs";

import { setupCompositor, canRunGpu, loadDawn, buildBin } from "./harness.mjs";

const skip = !canRunGpu() ? "needs GPU (WAYLAND_DISPLAY unset)"
  : (!loadDawn() ? "dawn.node not built" : false);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Count this process's open fds whose /proc target matches `re`.
function fdMatch(re) {
  let n = 0;
  for (const e of readdirSync(`/proc/${process.pid}/fd`)) {
    try { if (re.test(readlinkSync(`/proc/${process.pid}/fd/${e}`))) n++; } catch { /* fd vanished */ }
  }
  return n;
}

// Poll until `count()` drops to <= target or we time out; returns the last value.
async function settle(count, target, timeoutMs = 4000) {
  const t0 = Date.now();
  let v = count();
  while (v > target && Date.now() - t0 < timeoutMs) { await sleep(50); v = count(); }
  return v;
}

test("disconnect: a client's dmabuf fds are reclaimed (no per-buffer fd leak)", { skip }, async () => {
  const c = await setupCompositor({ headless: { width: 1280, height: 720 }, jsCompositor: true });
  try {
    await sleep(150);
    const base = fdMatch(/dmabuf/);
    const N = 30;
    const client = spawn(buildBin("dmabuf-cycle-client"), [c.sock, String(N)],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    client.stdout.on("data", (d) => { out += d.toString(); });
    const [code] = await once(client, "exit");
    assert.equal(code, 0, `client exited cleanly; stdout:\n${out}`);

    // Drive frames so the disconnect sweep closes the last buffer's fd.
    const after = await settle(() => fdMatch(/dmabuf/), base + 2);
    assert.ok(after <= base + 2,
      `dmabuf fds leaked after a client committed ${N} buffers: base=${base} after=${after} `
      + `(pre-fix this grows ~1 per buffer)`);
  } finally {
    await c.teardown();
  }
});

test("disconnect: shm pools are reclaimed when a client drops without destroy", { skip }, async () => {
  const c = await setupCompositor({ headless: { width: 1280, height: 720 }, jsCompositor: true });
  try {
    await sleep(150);
    const poolFds = () => fdMatch(/overdraw-shmdc/);
    const base = poolFds();
    const COUNT = 8;
    const client = spawn(buildBin("shm-disconnect-client"), [c.sock, String(COUNT)],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    client.stdout.on("data", (d) => { out += d.toString(); });
    const [code] = await once(client, "exit");
    assert.equal(code, 0, `client exited cleanly; stdout:\n${out}`);

    // Disconnect sweep (frame-driven) must munmap + close every pool fd.
    const after = await settle(poolFds, base);
    assert.equal(after, base,
      `shm pool fds leaked after a client dropped ${COUNT} pools without destroy: `
      + `base=${base} after=${after}`);
  } finally {
    await c.teardown();
  }
});
