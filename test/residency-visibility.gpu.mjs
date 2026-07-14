// Stack-gated residency (canvas-design.md "hidden means hidden"): a window
// on a hidden workspace is shown on NO output -- wl_surface.enter/leave
// state (SurfaceRecord.enteredOutputs) follows draw-stack membership, not
// bare geometric overlap. Showing the workspace re-enters the window.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, settled } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 640, height: 480 };

function enteredOf(c, surfaceId) {
  const rec = c.state.surfacesById?.get(surfaceId);
  return rec?.enteredOutputs ? [...rec.enteredOutputs] : [];
}

test("hidden workspace member leaves its output; show re-enters", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const a = c.spawnClient(["--fill-configured", "--color", "ff3030c0"]);
    await a.ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "mapped" });
    const id = snap.windows[0].surfaceId;

    // Visible on workspace 1: resident on output 0.
    await settled(() => Promise.resolve(enteredOf(c, id)),
      (e) => e.length === 1 && e[0] === 0, { what: "entered output 0" });

    // Move to a fresh (hidden) workspace 2: shown nowhere -> leave.
    await c.runtime.invokeAction("workspace.create", {});
    await c.runtime.invokeAction("workspace.move-window", { surfaceId: id, index: 2 });
    await settled(() => Promise.resolve(enteredOf(c, id)),
      (e) => e.length === 0, { what: "left all outputs while hidden" });

    // Show workspace 2: resident again.
    await c.runtime.invokeAction("workspace.show-at-index", { index: 2 });
    await settled(() => Promise.resolve(enteredOf(c, id)),
      (e) => e.length === 1 && e[0] === 0, { what: "re-entered on show" });
  } finally {
    await c.teardown();
  }
});
