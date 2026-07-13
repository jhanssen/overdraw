// commit-timing-v1 end-to-end: a client maps a toplevel, then drives timed
// commits -- each sets a wp_commit_timer_v1 timestamp ~120ms in the future
// and requests wp_presentation feedback on the same commit. The compositor
// must hold each commit until its target time, so every `presented`
// timestamp lands at-or-after the requested one (the client counts any
// early presentation and reports ok=0). Untimed pacing at the flip rate
// would present ~16ms after commit, two orders of magnitude early -- so
// this also proves the commit was actually deferred, not latched at the
// next flip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, canRunNested, loadDawn, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const nestedSkip = !loadDawn() ? "dawn.node not built"
  : (!canRunNested() ? "needs GPU + host Wayland (nested)" : false);
const CLI = buildBin("commit-timing-client");

test("commit-timing: timed commits present at-or-after their target timestamps",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 400, height: 300 } });
    try {
      const FRAMES = 3;
      const client = c.spawnClient(
        ["--frames", String(FRAMES), "--delay-ms", "120", "--timeout-ms", "8000"],
        { bin: CLI, readyMarker: "[commit-timing-client] mapped" });
      await client.ready;

      const summary = await client.waitForLine(/\[commit-timing-client\] done /,
        { what: "summary line", timeoutMs: 10000 });
      const m = summary.match(
        /\[commit-timing-client\] done presented=(\d+) discarded=(\d+) early=(\d+) frames=(\d+) ok=(\d+)/);
      assert.ok(m, `summary parse; stdout:\n${summary}`);
      const presented = parseInt(m[1], 10);
      const early = parseInt(m[3], 10);
      const ok = parseInt(m[5], 10);
      assert.equal(ok, 1,
        `client reports ok=1; presented=${presented} early=${early}, full stdout:\n${summary}`);
      assert.ok(presented >= FRAMES,
        `expected >= ${FRAMES} presented events; got ${presented}`);
      assert.equal(early, 0, "no presentation before its target timestamp");

      // Every presented line carries the compositor's flip timestamp vs the
      // requested target; each delta must be non-negative.
      const lines = summary.split("\n").filter((l) => l.includes("presented target="));
      assert.ok(lines.length >= FRAMES, `expected ${FRAMES} presented lines; got:\n${summary}`);
      for (const l of lines) {
        const tm = l.match(/delta_ns=(-?\d+)/);
        assert.ok(tm, `delta parse on '${l}'`);
        assert.ok(BigInt(tm[1]) >= 0n, `presented at-or-after target on '${l}'`);
      }
    } finally {
      await c.teardown();
    }
  });

// Regression: the deferred latch must drive a render by itself. It fires
// from a timer callback while the addon's frame loop is idle -- no native
// event accompanies it -- so pumpTimedCommits has to request the frame
// (addon.wake). Without that, the applied commit never renders, no flip
// happens, and the client's frame callback never arrives; timestamp-pacing
// clients then animate only when unrelated input wakes the loop.
//
// Two assertions, because the behavioral one alone can go green on a false
// negative: on a host session that repaints continuously (another client
// animating), the nested backend receives host FrameComplete ticks the
// whole time, and the idle frame-callback breaker rescues the callback
// even without the wake. So in addition to "the callback arrives", wrap
// addon.wake (handlers call it through this same object) and require a
// JS-side wake between the client posting the timed commit and its
// callback arriving -- on a quiesced compositor the latch pump is the only
// legitimate source of one.
test("commit-timing: an idle timed latch wakes the frame loop and delivers the frame callback",
  { skip: nestedSkip }, async () => {
    const c = await setupCompositor({ headless: false, jsCompositor: true });
    try {
      let wakes = 0;
      const realWake = c.addon.wake.bind(c.addon);
      c.addon.wake = () => { wakes++; realWake(); };

      const client = c.spawnClient(
        ["--idle-latch", "--delay-ms", "300", "--timeout-ms", "4000"],
        { bin: CLI, readyMarker: "[commit-timing-client] mapped" });
      await client.ready;

      await client.waitForLine(/\[commit-timing-client\] idle-latch posted/,
        { what: "timed commit posted", timeoutMs: 5000 });
      const wakesAtPost = wakes;

      const summary = await client.waitForLine(/\[commit-timing-client\] idle-latch done/,
        { what: "idle-latch summary", timeoutMs: 10000 });
      const m = summary.match(/idle-latch done=(\d) ms_after_target=(-?\d+) ok=(\d)/);
      assert.ok(m, `summary parse; stdout:\n${summary}`);
      assert.equal(m[1], "1", `frame callback arrived; stdout:\n${summary}`);
      assert.equal(m[3], "1", `client reports ok=1; stdout:\n${summary}`);
      const afterMs = parseInt(m[2], 10);
      assert.ok(afterMs >= 0 && afterMs < 500,
        `wl_callback.done within ~a frame or two of the target; got ${afterMs}ms`);
      assert.ok(wakes > wakesAtPost,
        `the latch woke the frame loop (wakes at post=${wakesAtPost}, after done=${wakes})`);
    } finally {
      await c.teardown();
    }
  });
