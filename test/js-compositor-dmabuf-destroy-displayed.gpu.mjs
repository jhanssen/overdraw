// A client that destroys its previous wl_buffer IMMEDIATELY after
// committing the next one -- before the new buffer's async import can have
// bound -- must not blank the surface. This is the shape Qt produces when a
// resize drops the old-size buffer pool (a hover-expanding quickshell panel
// re-sizes every animation frame): under a release-on-destroy model the
// import teardown nulls the surface's texture and the surface draws NOTHING
// until the replacement import lands, one blank-flash per step. The
// compositor instead parks a destroyed-but-displayed import as a zombie
// (its dmabuf fds are owned by the import; the client's destroy cannot
// invalidate the texture) and frees it once the replacement binds.
//
// Best-effort end-to-end guard, like the recommit black-frame test: the
// readback loop reliably catches the deterministic blank-per-cycle mode;
// the bounded-fd leak test (js-compositor-dmabuf-leak.gpu.mjs) guards the
// zombies-actually-drain side.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { setupCompositor, canRunGpu, loadDawn, buildBin, pixelAt, pixelMatches } from "./harness.mjs";

const skip = !canRunGpu() ? "needs GPU (no render node / dawn.node)"
  : (!loadDawn() ? "dawn.node not built" : false);
const OUT = { width: 1280, height: 720 };
const RED_BGRA = [0, 0, 255, 255]; // ARGB 0xFFFF0000 -> BGRA readback
const BLACK_BGRA = [0, 0, 0, 255];
const CYCLES = 40;

test("destroying a displayed wl_buffer never blanks the surface",
     { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, jsCompositor: true });
  let client = null;
  try {
    client = spawn(buildBin("dmabuf-cycle-client"),
                   [c.sock, String(CYCLES), "early"],
                   { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    client.stdout.on("data", (d) => { stdout += d.toString(); });

    const snap = await c.waitFor(c.query,
      (s) => s.windows.length === 1 && s.windows[0].rect.width > 0,
      { what: "window with real tile", timeoutMs: 4000 });
    const w = snap.windows[0];
    const cx = w.rect.x + (w.rect.width >> 1);
    const cy = w.rect.y + (w.rect.height >> 1);

    // Baseline: the first buffer's import lands and the surface shows red.
    let baselineGood = false;
    for (let i = 0; i < 40; i++) {
      const px = await c.frameReadback();
      if (px && pixelMatches(pixelAt(px, OUT.width, cx, cy), RED_BGRA, 4)) {
        baselineGood = true; break;
      }
      await new Promise((r) => setTimeout(r, 16));
    }
    assert.ok(baselineGood, "baseline: surface should be red after first commit");

    // While the client cycles buffers (destroying each displayed one right
    // after the successor's commit), the center must stay red: a black
    // sample is the destroy-blanked-the-surface regression.
    const blackFrames = [];
    while (client.exitCode === null && !stdout.includes("committed")) {
      const px = await c.frameReadback();
      if (px) {
        const sample = pixelAt(px, OUT.width, cx, cy);
        if (pixelMatches(sample, BLACK_BGRA, 4)) blackFrames.push(sample);
      }
      await new Promise((r) => setTimeout(r, 8));
    }
    assert.equal(blackFrames.length, 0,
      `${blackFrames.length} readbacks were BLACK during the destroy-early ` +
      `cycle (the surface blanked between a displayed buffer's destroy and ` +
      `its replacement's import)`);

    const t0 = Date.now();
    while (!stdout.includes(`committed ${CYCLES} buffers`) && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(stdout.includes(`committed ${CYCLES} buffers`),
      `client did not finish; stdout:\n${stdout}`);
  } finally {
    if (client && client.exitCode === null && client.signalCode === null) {
      try { client.kill("SIGTERM"); } catch { /* gone */ }
      await once(client, "exit").catch(() => {});
    }
    await c.teardown();
  }
});
