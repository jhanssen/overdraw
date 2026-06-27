// Focus routing through a covering subsurface. A client (Firefox is the
// canonical case) renders its content into a wl_subsurface that covers its
// xdg_toplevel. Hovering that content puts the POINTER on the subsurface but
// keyboard focus / activation must land on the ROOT toplevel -- a subsurface
// is not a focusable window. Regression test for follow-pointer focus never
// reaching such clients (keyboardFocus stuck null after the first leave).
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin, pointerMotion, waitFor } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const SUB_BIN = buildBin("subsurface-test-client");

test("hover on a covering subsurface focuses the root toplevel", { skip }, async () => {
  // focusOnMap:false so the ONLY thing that can focus the window is the
  // pointer-enter we inject -- isolates the hover path from the map path.
  const c = await setupCompositor({ headless: OUT, focus: { policy: "follow-pointer", focusOnMap: false } });
  try {
    const CW = 160, CH = 120, OX = 30, OY = 24;
    const cl = c.spawnClient(
      ["--parent", "300x200", "--child", `${CW}x${CH}`, "--offset", `${OX}x${OY}`,
       "--parent-color", "ff0000ff", "--child-color", "ff00ff00"],
      { bin: SUB_BIN, readyMarker: "[subsurface-client] mapped" });
    await cl.ready;

    const snap0 = await waitFor(c.query, (s) => s.windows.length >= 1, { what: "parent window" });
    const parentId = snap0.windows[0].surfaceId;
    const p = snap0.windows[0].rect;
    assert.equal(snap0.keyboardFocus, null, "focusOnMap:false -> no keyboard focus on map");

    // Move the pointer onto the child subsurface (covers parent + offset).
    const childCx = p.x + OX + (CW >> 1);
    const childCy = p.y + OY + (CH >> 1);
    pointerMotion(c.addon, childCx, childCy);

    // Keyboard focus applies asynchronously (the focus driver's decide() is a
    // promise); pointer focus is synchronous. Wait for the async apply.
    const snap = await waitFor(c.query, (s) => s.keyboardFocus !== null,
      { what: "keyboard focus applied after hover" });

    // Pointer is on the subsurface (not the toplevel)...
    assert.notEqual(snap.pointerFocus, null, "pointer focus should land on a surface");
    assert.notEqual(snap.pointerFocus, parentId,
      "pointer focus should be the child subsurface, not the toplevel");
    // ...but keyboard focus / activation is the root toplevel.
    assert.equal(snap.keyboardFocus, parentId,
      "keyboard focus must resolve to the root toplevel under a subsurface hit");
  } finally {
    await c.teardown();
  }
});
