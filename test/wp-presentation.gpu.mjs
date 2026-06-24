// wp_presentation end-to-end: a client maps a toplevel, requests feedback
// on each commit, and expects `presented` events to arrive with non-zero
// timestamps. The compositor wires presentation feedback to the same flip-
// complete signal that drives wl_callback.done; with the headless backend
// the addon synthesizes a CLOCK_MONOTONIC timestamp per frame timer tick.
//
// Assertions:
//   - clock_id event arrives (advertises CLOCK_MONOTONIC = 1).
//   - At least N `presented` events arrive within the budget.
//   - Each `presented` carries a non-zero tv_sec.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const CLI = buildBin("wp-presentation-client");

test("wp_presentation: feedback delivers presented events with monotonic timestamps",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 400, height: 300 } });
    try {
      const FRAMES = 3;
      const client = c.spawnClient(["--frames", String(FRAMES), "--timeout-ms", "5000"],
        { bin: CLI, readyMarker: "[wp-pres-client] mapped" });
      await client.ready;

      // Wait for the client to print its summary line.
      const summary = await client.waitForLine(/\[wp-pres-client\] done /,
        { what: "summary line", timeoutMs: 6000 });
      const m = summary.match(
        /\[wp-pres-client\] done presented=(\d+) discarded=(\d+) frames=(\d+) ok=(\d+)/);
      assert.ok(m, `summary parse; stdout:\n${summary}`);
      const presented = parseInt(m[1], 10);
      const ok = parseInt(m[4], 10);
      assert.equal(ok, 1, `client reports ok=1; got presented=${presented}, full stdout:\n${summary}`);
      assert.ok(presented >= FRAMES,
        `expected >= ${FRAMES} presented events; got ${presented}`);

      // clock_id is sent on first use; ensure it appeared.
      assert.match(summary, /clock_id=1/, "clock_id=CLOCK_MONOTONIC advertised");
      // At least one presented line should show a non-zero tv_sec component
      // (tv_sec is hi:lo, lo is the low 32 bits and is the usual reading).
      const lines = summary.split("\n").filter((l) => l.includes("presented tv_sec="));
      assert.ok(lines.length >= 1, `at least one presented log line; got:\n${summary}`);
      for (const l of lines) {
        const tm = l.match(/tv_sec=(\d+):(\d+)/);
        assert.ok(tm, `tv_sec parse on '${l}'`);
        const lo = parseInt(tm[2], 10);
        assert.ok(lo > 0, `tv_sec.lo > 0 (monotonic seconds since boot); got ${lo} on '${l}'`);
      }
    } finally {
      await c.teardown();
    }
  });
