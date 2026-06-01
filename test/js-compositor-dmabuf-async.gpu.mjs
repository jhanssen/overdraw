// Async dmabuf create path: a real client using zwp_linux_buffer_params_v1.create
// (NOT create_immed) must get a server-minted wl_buffer via the `created` event,
// then composite. This is the path real EGL clients (kitty/Mesa) take; it was
// previously unimplemented (always send_failed), which crashed EGL clients at
// surface creation. Requires GPU + host Wayland + DRM render node + dawn.node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { setupCompositor, canRunGpu, loadDawn, buildBin, pixelAt, pixelMatches } from "./harness.mjs";

const skip = !canRunGpu() ? "needs GPU (WAYLAND_DISPLAY unset)"
  : (!loadDawn() ? "dawn.node not built" : false);
const OUT = { width: 1280, height: 720 };
const RED_BGRA = [0, 0, 255, 255]; // ARGB 0xFFFF0000 -> BGRA readback

test("JS compositor: async dmabuf create (server-minted wl_buffer) composites (red)",
  { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, jsCompositor: true });
  let client = null;
  let stderr = "";
  try {
    client = spawn(buildBin("dmabuf-async-client"), [c.sock], { stdio: ["ignore", "pipe", "pipe"] });
    client.stderr.on("data", (b) => { stderr += b.toString(); });

    // Window maps only if async create delivered a buffer (params.created) and
    // the import succeeded. params.failed would abort the client before mapping.
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1,
      { what: "async dmabuf window", timeoutMs: 3000 });
    const w = snap.windows[0];
    const cx = w.rect.x + (w.rect.width >> 1);
    const cy = w.rect.y + (w.rect.height >> 1);

    let px = null;
    for (let i = 0; i < 20; i++) {
      px = await c.frameReadback();
      if (px && pixelMatches(pixelAt(px, OUT.width, cx, cy), RED_BGRA, 4)) break;
      await new Promise((r) => setTimeout(r, 16));
    }
    assert.ok(px, "got a frame");
    assert.ok(pixelMatches(pixelAt(px, OUT.width, cx, cy), RED_BGRA, 4),
      `async dmabuf surface center should be red; got ${pixelAt(px, OUT.width, cx, cy)}`);
    assert.ok(!/params\.failed/.test(stderr), "server must not send params.failed for async create");
  } finally {
    if (client && client.exitCode === null && client.signalCode === null) {
      try { client.kill("SIGTERM"); } catch { /* gone */ }
      await once(client, "exit").catch(() => {});
    }
    await c.teardown();
  }
});
