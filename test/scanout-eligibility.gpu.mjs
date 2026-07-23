// Direct-scanout eligibility with a layer-shell bar and a docked camera.
// The two blockers that kept a real fullscreen game off the primary plane
// while a bar was running: the bar composited above the fullscreen buffer
// (topmost-entry rule), and the canvas camera docked below the bar's
// exclusive zone made the output camera non-identity. An ACTIVE
// fullscreen window suppresses the "above" layer, and a camera-exempt
// (output-anchored) candidate ignores the camera check -- so a mode-sized
// opaque fullscreen dmabuf is eligible with both present. Deactivating
// the fullscreen window brings the bar back and ends eligibility.
//
// Uses the compositor's scanoutEligibilityReason probe (the backend
// gates -- KMS, directScanoutEnabled -- live at the renderFrame call
// site, so the candidate test itself is observable headless).
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const LS_BIN = buildBin("layer-shell-test-client");

const A_TOP = 1, A_LEFT = 4, A_RIGHT = 8;

test("fullscreen dmabuf with a bar and a docked camera is scanout-eligible",
  { skip }, async () => {
  const c = await setupCompositor({ headless: { width: 256, height: 256 } });
  let game = null;
  try {
    // Green bar with an exclusive zone, as waybar would be.
    const panel = c.spawnClient(
      ["--layer", "top", "--anchor", String(A_TOP | A_LEFT | A_RIGHT),
       "--size", "0x30", "--zone", "30", "--kbd", "none", "--color", "00FF00",
       "--lifetime", "20000"],
      { bin: LS_BIN, readyMarker: "[client] mapped" });
    await panel.ready;

    // A plain toplevel to deactivate the fullscreen window later.
    const tl = c.spawnClient(
      ["--app-id", "tl", "--title", "tl", "--color", "FF0000FF",
       "--size", "100x100", "--fill-configured"]);
    await tl.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1 && s.windows[0].mapped,
      { what: "toplevel mapped" });
    const tlId = c.query().windows[0].surfaceId;

    // The docked camera canvas world mode produces under a 30px zone.
    c.jsCompositor.setOutputCamera(0, 0, -30, 1);
    assert.notEqual(c.jsCompositor.scanoutEligibilityReason(0), null,
      "no candidate before a fullscreen window exists");

    // Mode-sized opaque (XR24) fullscreen dmabuf client; focused on map.
    game = spawn(buildBin("dmabuf-test-client"),
      [c.sock, "--format", "xrgb", "--fullscreen", "--hold-ms", "20000",
       "--app-id", "game"],
      { stdio: ["ignore", "pipe", "pipe"] });
    await c.waitFor(c.query, (s) => s.windows.length === 2,
      { what: "game mapped", timeoutMs: 8000 });
    const gameId = c.query().windows.map((w) => w.surfaceId)
      .find((id) => id !== tlId);
    await c.waitFor(() => c.state.wm.state.windows.find((w) => w.surfaceId === gameId),
      (w) => w?.windowState.sizeMode === "fullscreen" && w?.stackTier === 1,
      { timeoutMs: 8000, what: "game fullscreen + active" });

    // Bar suppressed + camera-exempt candidate: eligible despite both.
    await c.waitFor(() => c.jsCompositor.scanoutEligibilityReason(0),
      (r) => r === null,
      { what: "scanout-eligible with bar + docked camera", timeoutMs: 4000 });

    // Deactivate: the bar returns above the world and eligibility ends.
    c.state.seat.applyKeyboardFocus(tlId);
    await c.waitFor(() => c.jsCompositor.scanoutEligibilityReason(0),
      (r) => r !== null,
      { what: "ineligible again once the fullscreen window deactivates" });
  } finally {
    game?.kill("SIGTERM");
    await c.teardown();
  }
});
