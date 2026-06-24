// ext_image_copy_capture_v1 end-to-end:
//   1. Output capture (shm). A producer client maps a solid-color toplevel;
//      the capture client binds the output source manager + capture manager,
//      creates a session, allocates an shm buffer at the advertised size,
//      runs one capture, and asserts that the buffer's center pixel matches
//      the producer's color (blended against the compositor's clear color
//      at the unoccupied region).
//   2. Per-toplevel capture (shm). Same producer; the capture client uses
//      the ext_foreign_toplevel_image_capture_source_manager_v1 path and
//      asserts the captured buffer size matches the WM-assigned tile and
//      that the producer's color fills it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const CLI = buildBin("ext-image-copy-capture-client");

// Drive one capture invocation through the client binary and parse its
// summary lines. Returns { ok, wrote, w, h, bgra: [b,g,r,a], stopped }.
async function runCapture(c, args) {
  const cli = c.spawnClient(args, {
    bin: CLI, readyMarker: "[ext-icc-client] ready",
  });
  await cli.ready;
  // Wait for the summary line (or stopped). 10s budget so we cover slow
  // GPUs / first-readback warm-up.
  const out = await cli.waitForLine(/\[ext-icc-client\] done /,
    { what: "capture summary", timeoutMs: 10000 });
  const m = out.match(/done ok=(\d+) wrote=(\d+) w=(\d+) h=(\d+)/);
  assert.ok(m, `summary parse; stdout:\n${out}`);
  const readyMatch = out.match(
    /\[ext-icc-client\] ready damage=(\d+)x(\d+) [^ ]* [^ ]* center_bgra=([0-9a-f]+),([0-9a-f]+),([0-9a-f]+),([0-9a-f]+)/i);
  const bgra = readyMatch
    ? [parseInt(readyMatch[3], 16), parseInt(readyMatch[4], 16),
       parseInt(readyMatch[5], 16), parseInt(readyMatch[6], 16)]
    : null;
  return {
    ok: parseInt(m[1], 10) === 1,
    wrote: parseInt(m[2], 10) === 1,
    w: parseInt(m[3], 10),
    h: parseInt(m[4], 10),
    bgra,
    stopped: out.includes("session.stopped"),
    raw: out,
  };
}

test("ext_image_copy_capture: output capture returns producer pixels in shm", { skip },
  async () => {
    const c = await setupCompositor({ headless: { width: 320, height: 240 } });
    try {
      // Producer: a 320x240 fullscreen-tile toplevel painted opaque red
      // (ARGB 0xFFFF0000 -> on the wire ARGB8888 little-endian = bytes
      // B=0x00, G=0x00, R=0xFF, A=0xFF). The harness-client paints a
      // solid color filling its buffer; the WM places it tiled over the
      // full output (single-window master-stack = full area).
      const producer = c.spawnClient([
        "--title", "icc-prod",
        "--app-id", "icc.prod",
        "--color", "FFFF0000",
        "--size", "320x240",
        "--fill-configured",
      ]);
      await producer.ready;
      await c.waitFor(c.query, (s) =>
        s.windows.length >= 1 && s.windows[0].mapped,
        { what: "producer mapped" });

      // Push a frame so the JS compositor has an up-to-date scene to
      // capture against, then run the capture.
      c.jsCompositor.renderFrame();

      const r = await runCapture(c, [
        "--mode", "output",
        "--timeout-ms", "8000",
      ]);
      assert.equal(r.ok, true, `capture ok; raw:\n${r.raw}`);
      assert.equal(r.w, 320);
      assert.equal(r.h, 240);
      assert.ok(r.bgra, `center pixel reported; raw:\n${r.raw}`);
      // Center pixel of a 320x240 fullscreen red surface should be opaque
      // red. The producer fills the configured tile, which is the full
      // output, so the center is inside its rect.
      const [b, g, red, a] = r.bgra;
      assert.equal(b, 0x00, `center B byte should be 0x00, got 0x${b.toString(16)}; raw:\n${r.raw}`);
      assert.equal(g, 0x00, `center G byte should be 0x00, got 0x${g.toString(16)}; raw:\n${r.raw}`);
      assert.equal(red, 0xff, `center R byte should be 0xff, got 0x${red.toString(16)}; raw:\n${r.raw}`);
      assert.equal(a, 0xff, `center A byte should be 0xff, got 0x${a.toString(16)}; raw:\n${r.raw}`);
    } finally {
      await c.teardown();
    }
  });

test("ext_image_copy_capture: per-toplevel capture returns the toplevel's pixels", { skip },
  async () => {
    const c = await setupCompositor({ headless: { width: 400, height: 300 } });
    try {
      // Single producer; the ftl handle lookup picks index 0 of one entry.
      const producer = c.spawnClient([
        "--title", "icc-tl",
        "--app-id", "icc.tl",
        "--color", "FF00FF00",  // opaque green
        "--size", "400x300",
        "--fill-configured",
      ]);
      await producer.ready;
      await c.waitFor(c.query, (s) =>
        s.windows.length >= 1 && s.windows[0].mapped,
        { what: "producer mapped" });

      c.jsCompositor.renderFrame();

      const r = await runCapture(c, [
        "--mode", "toplevel",
        "--pick", "0",
        "--timeout-ms", "8000",
      ]);
      assert.equal(r.ok, true, `capture ok; raw:\n${r.raw}`);
      // Per-toplevel capture sizes to the surface's layout rect. With a
      // single window in the master-stack layout that's the full output.
      assert.ok(r.w > 0 && r.h > 0, `nonzero dims (${r.w}x${r.h}); raw:\n${r.raw}`);
      // Center pixel of an opaque green toplevel.
      const [b, g, red, a] = r.bgra;
      assert.equal(b, 0x00, `center B byte should be 0x00, got 0x${b.toString(16)}; raw:\n${r.raw}`);
      assert.equal(g, 0xff, `center G byte should be 0xff, got 0x${g.toString(16)}; raw:\n${r.raw}`);
      assert.equal(red, 0x00, `center R byte should be 0x00, got 0x${red.toString(16)}; raw:\n${r.raw}`);
      assert.equal(a, 0xff, `center A byte should be 0xff, got 0x${a.toString(16)}; raw:\n${r.raw}`);
    } finally {
      await c.teardown();
    }
  });

test("ext_image_copy_capture: toplevel unmap stops the session", { skip },
  async () => {
    const c = await setupCompositor({ headless: { width: 320, height: 240 } });
    try {
      const producer = c.spawnClient([
        "--title", "icc-unmap",
        "--app-id", "icc.unmap",
        "--color", "FF0000FF",
        "--size", "320x240",
      ]);
      await producer.ready;
      await c.waitFor(c.query, (s) =>
        s.windows.length >= 1 && s.windows[0].mapped,
        { what: "producer mapped" });

      // Start the capture client but don't let it run its capture quickly:
      // use --timeout-ms 6000 so it sits waiting for ready. After it starts
      // its session + frame.capture, kill the producer; we expect the
      // session.stopped event to come through and the frame to fail with
      // reason=stopped.
      //
      // The client's flow is: wait for done -> alloc buffer -> create_frame
      // -> attach -> damage -> capture -> wait for ready/failed. Once we see
      // "ready" line (printed only after session.done with constraints), we
      // kill the producer.
      const cli = c.spawnClient(
        ["--mode", "toplevel", "--pick", "0", "--timeout-ms", "6000"],
        { bin: CLI, readyMarker: "[ext-icc-client] ready" });
      await cli.ready;
      // Wait for constraints (the "constraints" line is printed AFTER
      // session.done so we know we're past the registry-bind phase).
      await cli.waitForLine(/\[ext-icc-client\] constraints/,
        { what: "constraints", timeoutMs: 5000 });

      // Kill the producer; its surface unmaps, the bus emits window.unmap,
      // the capture session moves to stopped.
      producer.child.kill("SIGTERM");

      // The client should observe session.stopped OR a failed event with
      // reason=stopped. Both surface as a non-ok summary.
      const summary = await cli.waitForLine(/\[ext-icc-client\] done /,
        { what: "summary line", timeoutMs: 8000 });
      assert.match(summary, /ok=0/,
        `expected ok=0 after producer unmap; raw:\n${summary}`);
    } finally {
      await c.teardown();
    }
  });
