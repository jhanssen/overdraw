// Phase 1 Xwayland lifecycle: spawn a rootless Xwayland against the running
// compositor and assert it completes its Wayland handshake with our server and
// brings up an X display (its X11 listening socket appears, so an X client
// could connect). No XWM / surface association yet -- that is Phase 2.
//
// This exercises the genuine integration unknown: whether overdraw's Wayland
// server is complete enough for Xwayland to initialize against it. Needs the
// GPU (Xwayland's glamor) + the Xwayland binary; self-skips otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { setupCompositor, canRunGpu } from "./harness.mjs";
import { startXwayland, stopXwayland } from "../packages/core/dist/xwayland/index.js";

function haveXwayland() {
  return (process.env.PATH ?? "").split(":").some((p) => p && existsSync(`${p}/Xwayland`));
}

const skip = !canRunGpu()
  ? "no GPU/dawn.node"
  : !haveXwayland()
    ? "Xwayland not installed"
    : false;

test("xwayland: spawns rootless and brings up an X display", { skip }, async () => {
  const c = await setupCompositor();
  let handle;
  try {
    handle = await startXwayland(c.addon, { waylandDisplay: c.sock });
    assert.ok(handle.pid > 0, "got a pid");
    assert.ok(Number.isInteger(handle.displayNumber) && handle.displayNumber >= 0,
      "got a display number");
    assert.equal(handle.display, `:${handle.displayNumber}`, "display name matches number");
    assert.ok(existsSync(`/tmp/.X11-unix/X${handle.displayNumber}`),
      "X11 listening socket exists (an X client could connect)");
  } finally {
    if (handle) stopXwayland(c.addon, handle);
    await c.teardown();
  }
});
