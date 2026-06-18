// Nested mode: the host wl_surface.frame chain must keep delivering. The GPU
// process arms one wl_surface.frame at startup and re-arms inside
// onFrameCallbackDone so each host vblank fires another FrameComplete IPC,
// which in turn drives state.dispatchFrameCallbacksForOutput -- the only path
// that sends wl_callback.done to clients (per the per-output split). Without
// the re-arm, exactly one done reaches the client and any client gating its
// render loop on wl_callback.done (kitty, most well-behaved Wayland apps)
// commits once and then stalls.
//
// Spawn the harness-client in --frames mode and assert it sees >=3 frame.done
// across one second. The bug-free baseline runs ~one-per-host-vblank; the
// regressed build sees exactly one (or two, counting the initial prime).

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunNested, loadDawn } from "./harness.mjs";

const skip = !loadDawn() ? "dawn.node not built"
  : (!canRunNested() ? "needs GPU + host Wayland (nested)" : false);

test("nested: client receives repeated wl_callback.done events", { skip }, async () => {
  const c = await setupCompositor({ headless: false, jsCompositor: true });
  try {
    const client = c.spawnClient(
      ["--size", "200x150", "--color", "ff2080c0", "--frames"]);
    await client.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window" });

    // One host-vblank is ~16ms at 60Hz; one second gives ~60 dones with no
    // bug, vs. exactly one with the missing re-arm. Pick 3 as the threshold:
    // tolerant of slow CI hosts, still catches the regression decisively.
    await client.waitForLine(/frame\.done n=3/,
      { timeoutMs: 2000, what: "third frame.done" });

    // Count the dones the client reported (each one prints a line).
    const matches = client.stdout.match(/frame\.done n=\d+/g) ?? [];
    assert.ok(matches.length >= 3,
      `expected >=3 frame.done, saw ${matches.length}\n${client.stdout}`);
  } finally {
    await c.teardown();
  }
});
