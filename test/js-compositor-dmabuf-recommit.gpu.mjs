// Layer C end-to-end test (docs/client-buffer-lifecycle.md): a real dmabuf
// client commits the SAME wl_buffer many times in sequence -- the
// cursor-blink / focus-change shape. Under the prior (broken) model the
// compositor BeginAccess'd the texture once at import and never EndAccess'd;
// a same-buffer re-commit sampled the texture concurrently with whatever
// state the kernel held (no fresh acquire fence) and produced intermittent
// BLACK frames. The Layer C fix is a per-frame Begin/End bracket with a
// fresh dmabuf sync_file acquire fence each Begin.
//
// Two assertions, with different guarantees:
//
//   1. `releases === 0`: DETERMINISTIC. The protocol-level contract that
//      wl_buffer.release MUST NOT fire for the surface's still-current
//      buffer (state-machine invariant 4). Reliably catches lifecycle
//      regressions independent of GPU/host timing.
//
//   2. Pixel readback shows red, not black, on every sampled frame:
//      BEST-EFFORT end-to-end check. Reliably catches Layer-C failure modes
//      that produce deterministic black frames (e.g. missing per-frame
//      Begin/End or missing wire-flush before sampling the End wireSerial
//      -- both empirically reproduce as solid-black readback). Does NOT
//      reliably catch race-only regressions in which the per-frame acquire
//      fence is missing/stale but the kernel and Dawn happen to produce
//      visually-acceptable pixels under headless timing. The unit-test
//      matrix on the state machine (test/client-buffer-lifecycle.test.js)
//      is the load-bearing regression guard for the lifecycle rules; this
//      test is the end-to-end smoke.

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
const RECOMMITS = 30;
const READBACKS = 20;

test("Layer C: same-buffer re-commit shows pixels every frame (black-frame regression guard)",
     { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, jsCompositor: true });
  let client = null;
  try {
    client = spawn(buildBin("dmabuf-recommit-client"),
                   [c.sock, String(RECOMMITS)],
                   { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    client.stdout.on("data", (d) => { stdout += d.toString(); });

    // Wait for the surface to map AND for its tile rect to settle (the layout
    // driver schedules async; until the workspace plugin's setOutputStack
    // populates outputContent, the WM holds the addWindow placeholder
    // rect{0,0,-1,-1}). Polling on windows.length alone would read a
    // placeholder rect and produce a center at (-1,-1) -> pixelAt yields null
    // samples, which would falsely trip the BLACK-readback assertion.
    const snap = await c.waitFor(c.query,
      (s) => s.windows.length === 1 && s.windows[0].rect.width > 0,
      { what: "window with real tile", timeoutMs: 4000 });
    const w = snap.windows[0];
    const cx = w.rect.x + (w.rect.width >> 1);
    const cy = w.rect.y + (w.rect.height >> 1);

    // Wait briefly for the first import to land + the surface to start
    // appearing red (avoids the startup transient before per-frame Begin
    // is exercised at all).
    let baselineGood = false;
    for (let i = 0; i < 40; i++) {
      const px = await c.frameReadback();
      if (px && pixelMatches(pixelAt(px, OUT.width, cx, cy), RED_BGRA, 4)) {
        baselineGood = true; break;
      }
      await new Promise((r) => setTimeout(r, 16));
    }
    assert.ok(baselineGood, "baseline: surface should be red after first commit + frame settle");

    // The critical part: while the client re-commits the same buffer, sample
    // the center many times and assert it is ALWAYS red. Any black sample is
    // the regression we are guarding against.
    const blackFrames = [];
    for (let i = 0; i < READBACKS; i++) {
      const px = await c.frameReadback();
      if (!px) continue;
      const sample = pixelAt(px, OUT.width, cx, cy);
      if (pixelMatches(sample, BLACK_BGRA, 4)) {
        blackFrames.push({ i, sample });
      } else if (!pixelMatches(sample, RED_BGRA, 4)) {
        // Not black, not red -- something in between (garbage from a race).
        // Also a failure: the texture should be solid red.
        assert.fail(`readback ${i}: unexpected pixel ${sample} (expected red ${RED_BGRA})`);
      }
      await new Promise((r) => setTimeout(r, 16));
    }
    assert.equal(blackFrames.length, 0,
      `${blackFrames.length}/${READBACKS} readbacks were BLACK (the same-buffer ` +
      `re-commit flicker bug). Samples: ${JSON.stringify(blackFrames)}`);

    // The test client also reports the wl_buffer.release count. With per-cycle
    // releases gated on supersede + GPU completion, re-committing the SAME
    // buffer must NOT produce wl_buffer.release events (invariant 4: never
    // release the surface's CURRENT buffer). Verify the protocol-level
    // contract too.
    // Wait for the client to finish reporting.
    const t0 = Date.now();
    while (!stdout.includes("committed same buffer") && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(stdout.includes("committed same buffer"),
      `client did not finish; stdout:\n${stdout}`);
    const m = stdout.match(/releases=(\d+)/);
    assert.ok(m, "stdout did not report release count");
    const releases = parseInt(m[1], 10);
    assert.equal(releases, 0,
      `wl_buffer.release fired ${releases} times for a still-current buffer ` +
      `(invariant 4: should be 0)`);
  } finally {
    if (client && client.exitCode === null && client.signalCode === null) {
      try { client.kill("SIGTERM"); } catch { /* gone */ }
      await once(client, "exit").catch(() => {});
    }
    await c.teardown();
  }
});
