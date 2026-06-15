// Protocol-coverage integration tests for paths the core happy-path tests don't
// assert: wl_output event delivery, wl_callback (frame-callback) delivery, and
// wl_keyboard.key delivery to the focused client. The harness-client reports
// what it RECEIVES on stdout; we assert those lines. Headless; needs the GPU.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, keyHost } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const KEY_A = 30; // evdev

test("wl_output: client receives a mode matching the output size", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cl = c.spawnClient([]);
    await cl.ready;
    // The client binds wl_output and prints each event; assert it saw a mode at
    // the compositor's output size (the advertised monitor).
    await cl.waitForLine(new RegExp(`output\\.mode flags=\\d+ ${OUT.width}x${OUT.height}`),
      { what: "output.mode" });
    await cl.waitForLine(/output\.done/, { what: "output.done" });
  } finally {
    await c.teardown();
  }
});

test("wl_callback: compositor fires frame callbacks (wl_surface.frame -> done)", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cl = c.spawnClient(["--frames"]);
    await cl.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window" });
    // The client re-requests a frame callback each done; assert several fire,
    // proving the per-frame dispatchFrameCallbacks loop drives the client.
    await cl.waitForLine(/frame\.done n=3/, { what: "3 frame callbacks" });
  } finally {
    await c.teardown();
  }
});

test("wl_keyboard: key to the focused client is delivered", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, focus: { policy: "follow-pointer", focusOnMap: true } });
  try {
    const cl = c.spawnClient([]);
    await cl.ready;
    const snap = await c.waitFor(
      c.query, (s) => s.windows.length === 1 && s.keyboardFocus === s.windows[0].surfaceId,
      { what: "kb focus on map" });
    assert.equal(snap.keyboardFocus, snap.windows[0].surfaceId);
    // The client should have received wl_keyboard.enter on focus + a keymap.
    await cl.waitForLine(/kb\.keymap format=/, { what: "keymap" });
    await cl.waitForLine(/kb\.enter/, { what: "kb enter" });

    // Inject a key through the real host-input path; assert the focused client
    // receives wl_keyboard.key press then release.
    keyHost(c.addon, KEY_A, true);
    await cl.waitForLine(new RegExp(`kb\\.key key=${KEY_A} state=1`), { what: "key press" });
    keyHost(c.addon, KEY_A, false);
    await cl.waitForLine(new RegExp(`kb\\.key key=${KEY_A} state=0`), { what: "key release" });
  } finally {
    await c.teardown();
  }
});
