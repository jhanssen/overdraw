// zwp_pointer_constraints_v1 + zwp_relative_pointer_v1 end-to-end: a locked
// pointer must keep delivering relative_motion INSIDE wl_pointer.frame
// groups, with absolute wl_pointer.motion suppressed.
//
// Regression shape: while locked, the seat skipped the absolute-motion
// branch -- which was the only place wl_pointer.frame was sent -- so
// relative_motion arrived with no frame ever following. Frame-batching
// clients (notably Xwayland) hold pointer events until the frame, so X
// games saw NO mouse input at all while pointer-locked (camera dead until
// a button/key event flushed the queue).
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin, waitFor } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const CLI = buildBin("pointer-lock-client");

test("locked pointer: relative_motion is frame-terminated, absolute motion suppressed",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 320, height: 240 } });
    try {
      const cli = c.spawnClient(["--timeout-ms", "20000"],
        { bin: CLI, readyMarker: "[lock-client] mapped" });
      await cli.ready;
      await c.waitFor(c.query, (s) => s.windows.length >= 1 && s.windows[0].mapped,
        { what: "lock client mapped" });

      // Move the pointer onto the (fullscreen-tiled) surface: enter fires,
      // the client locks, the compositor activates the lock (surface has
      // pointer focus) and confirms with zwp_locked_pointer_v1.locked.
      // Retry the motion until the enter lands -- right after map the
      // surface may take a frame to become hit-testable.
      for (let i = 0; i < 40 && !cli.stdout.includes("[lock-client] enter"); i++) {
        c.addon.injectInput({ type: "pointerMotion", x: 160, y: 120, time: 1 + i });
        c.addon.injectInput({ type: "pointerFrame", time: 1 + i });
        await new Promise((r) => setTimeout(r, 100));
      }
      await cli.waitForLine(/\[lock-client\] locked/, { what: "locked", timeoutMs: 5000 });

      // Motion while locked, carrying relative deltas (as the libinput
      // backend always does). Absolute position frozen by the backend in
      // production; synthetic events model that by repeating x/y.
      for (let i = 0; i < 3; i++) {
        c.addon.injectInput({ type: "pointerMotion", x: 160, y: 120,
          dx: 5, dy: -3, dxUnaccel: 7, dyUnaccel: -4, time: 10 + i });
        c.addon.injectInput({ type: "pointerFrame", time: 10 + i });
      }
      await cli.waitForLine(/\[lock-client\] frame/, { what: "frame after rel", timeoutMs: 5000 });
      // Give the remaining lines a beat to flush, then inspect the ordering.
      await new Promise((r) => setTimeout(r, 300));
      const lines = cli.stdout.split("\n").filter((l) => l.startsWith("[lock-client]"));

      const lockedIdx = lines.findIndex((l) => l.includes("locked"));
      assert.ok(lockedIdx >= 0, `lock confirmed; got:\n${lines.join("\n")}`);
      const after = lines.slice(lockedIdx + 1);

      // Every relative_motion arrives with the injected deltas and is
      // followed by a frame before the next pointer event.
      const rels = after.filter((l) => l.includes(" rel "));
      assert.ok(rels.length >= 3, `expected >=3 relative_motion, got ${rels.length}:\n${after.join("\n")}`);
      for (const r of rels) {
        assert.match(r, /rel dx=5\.00 dy=-3\.00 dxu=7\.00 dyu=-4\.00/,
          `relative deltas survive the wire; got: ${r}`);
      }
      for (let i = 0; i < after.length; i++) {
        if (!after[i].includes(" rel ")) continue;
        assert.ok(after[i + 1]?.includes("frame"),
          `relative_motion must be frame-terminated; got:\n${after.join("\n")}`);
      }
      // Absolute motion is suppressed while locked.
      assert.ok(!after.some((l) => l.includes(" motion ")),
        `no absolute motion while locked; got:\n${after.join("\n")}`);
    } finally {
      await c.teardown();
    }
  });
