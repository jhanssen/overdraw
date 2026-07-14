// Per-output content camera (docs/canvas-design.md §4, setOutputCamera):
// a camera offset pans world-space content (toplevels) on the output while
// glass-anchored surfaces (layer shell) stay put, on both the render side
// (readback pixels) and the input side (pointer hit-testing). Identity
// restore repaints the pre-camera frame.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setupCompositor, canRunGpu, pixelAt, pixelMatches, buildBin, pointerMotion,
} from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 256, height: 256 };
const LS_BIN = buildBin("layer-shell-test-client");
const A_TOP = 1, A_LEFT = 4, A_RIGHT = 8;

// ARGB 0xFFRRGGBB -> BGRA readback bytes [B,G,R,A].
function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff, g = (argb >>> 8) & 0xff, b = argb & 0xff, a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}
const BLACK = [0, 0, 0, 255];

// Poll readbacks until `pred(px)` holds (a camera change lands on the next
// frame-timer render, not synchronously).
async function readUntil(c, pred, tries = 60) {
  let px = null;
  for (let i = 0; i < tries; i++) {
    px = await c.frameReadback();
    if (px && pred(px)) return px;
    await new Promise((r) => setTimeout(r, 16));
  }
  return px;
}

async function waitForMappedLayerSurface(c, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const rec of c.state.layerSurfaces?.values() ?? []) {
      if (rec.mapped) return rec;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for a mapped layer surface");
}

// Apply a camera the way the windows broker does: compositor (render/damage/
// residency) + the state mirror the seat's pointer transform reads.
function setCamera(c, outputId, x, y, zoom = 1) {
  c.state.outputCameras ??= new Map();
  if (x === 0 && y === 0 && zoom === 1) c.state.outputCameras.delete(outputId);
  else c.state.outputCameras.set(outputId, { x, y, zoom });
  c.state.compositor.setOutputCamera(outputId, x, y, zoom);
  c.state.seat?.repickPointer();
}

test("camera pans world content; layer surface stays anchored; identity restores",
  { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const blue = 0xff2040c0;
    const blueBgra = argbToBgra(blue);
    const greenBgra = [0, 255, 0, 255];

    // Top panel (glass-anchored), zone 0 so the toplevel tiles full-output.
    c.spawnClient(
      ["--layer", "top", "--anchor", String(A_TOP | A_LEFT | A_RIGHT),
       "--size", "0x30", "--zone", "0", "--kbd", "none", "--color", "00FF00"],
      { bin: LS_BIN, readyMarker: "[client] mapped" });
    await waitForMappedLayerSurface(c);

    const t = c.spawnClient(["--fill-configured", "--color", blue.toString(16)]);
    await t.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "toplevel" });

    // Identity: toplevel fills the output (row 128 is below the panel).
    let px = await readUntil(c,
      (p) => pixelMatches(pixelAt(p, OUT.width, 200, 128), blueBgra, 4)
        && pixelMatches(pixelAt(p, OUT.width, 128, 15), greenBgra, 4));
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 200, 128), blueBgra, 4),
      `pre-camera content; got ${pixelAt(px, OUT.width, 200, 128)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 128, 15), greenBgra, 4),
      `pre-camera panel; got ${pixelAt(px, OUT.width, 128, 15)}`);

    // Camera (128, 0): glass x shows world x+128. The toplevel (world
    // 0..256) now covers glass 0..128; glass 200 looks at world 328 = void.
    setCamera(c, 0, 128, 0);
    px = await readUntil(c,
      (p) => pixelMatches(pixelAt(p, OUT.width, 200, 128), BLACK, 4));
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 60, 128), blueBgra, 4),
      `panned content at glass 60; got ${pixelAt(px, OUT.width, 60, 128)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 200, 128), BLACK, 4),
      `void past the window under camera; got ${pixelAt(px, OUT.width, 200, 128)}`);
    // The panel must not move with the camera.
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 128, 15), greenBgra, 4),
      `panel anchored under camera; got ${pixelAt(px, OUT.width, 128, 15)}`);

    // Identity restore repaints the full pre-camera frame.
    setCamera(c, 0, 0, 0);
    px = await readUntil(c,
      (p) => pixelMatches(pixelAt(p, OUT.width, 200, 128), blueBgra, 4));
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 200, 128), blueBgra, 4),
      `identity restored; got ${pixelAt(px, OUT.width, 200, 128)}`);
  } finally {
    await c.teardown();
  }
});

test("camera transforms pointer hit-testing; layer hits stay glass-space",
  { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    c.spawnClient(
      ["--layer", "top", "--anchor", String(A_TOP | A_LEFT | A_RIGHT),
       "--size", "0x30", "--zone", "0", "--kbd", "none", "--color", "00FF00"],
      { bin: LS_BIN, readyMarker: "[client] mapped" });
    const panel = await waitForMappedLayerSurface(c);

    const t = c.spawnClient(["--fill-configured", "--color", "ff2040c0"]);
    await t.ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "toplevel" });
    const toplevelId = snap.windows[0].surfaceId;

    // Identity: glass (150, 128) hits the toplevel.
    pointerMotion(c.addon, 150, 128);
    await c.waitFor(c.query, (s) => s.pointerFocus === toplevelId,
      { what: "identity pointer focus on toplevel" });

    // Camera (-100, 0): glass (150, 128) is world (50, 128) -> still the
    // toplevel; glass (50, 128) is world (-50, 128) -> void, no focus.
    setCamera(c, 0, -100, 0);
    pointerMotion(c.addon, 150, 128);
    await c.waitFor(c.query, (s) => s.pointerFocus === toplevelId,
      { what: "panned pointer focus on toplevel" });
    // Local coords must account for the camera: glass 150 = world 50 on a
    // window whose world rect starts at 0.
    assert.equal(c.state.seat.focus.view.camX, -100,
      "hit records the view transform it was made with");
    pointerMotion(c.addon, 50, 128);
    await c.waitFor(c.query, (s) => s.pointerFocus === null,
      { what: "void under camera clears pointer focus" });

    // The panel is glass-anchored: glass (128, 15) still hits it.
    pointerMotion(c.addon, 128, 15);
    await c.waitFor(c.query, (s) => s.pointerFocus === panel.surface.id,
      { what: "panel hit stays glass-space" });

    setCamera(c, 0, 0, 0);
  } finally {
    await c.teardown();
  }
});

test("camera zoom scales world content + hit-testing; panel unscaled", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const blue = 0xff2040c0;
    const blueBgra = argbToBgra(blue);
    const greenBgra = [0, 255, 0, 255];

    c.spawnClient(
      ["--layer", "top", "--anchor", String(A_TOP | A_LEFT | A_RIGHT),
       "--size", "0x30", "--zone", "0", "--kbd", "none", "--color", "00FF00"],
      { bin: LS_BIN, readyMarker: "[client] mapped" });
    await waitForMappedLayerSurface(c);

    const t = c.spawnClient(["--fill-configured", "--color", blue.toString(16)]);
    await t.ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "toplevel" });
    const toplevelId = snap.windows[0].surfaceId;

    // Full-frame baseline (row 128 is below the 30px panel).
    let px = await readUntil(c,
      (p) => pixelMatches(pixelAt(p, OUT.width, 200, 128), blueBgra, 4));
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 200, 128), blueBgra, 4));

    // Zoom 0.5 about the view origin: the 256-wide window covers glass
    // 0..128; glass 200 looks past its scaled extent into the void.
    setCamera(c, 0, 0, 0, 0.5);
    px = await readUntil(c,
      (p) => pixelMatches(pixelAt(p, OUT.width, 200, 128), BLACK, 4));
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 60, 60), blueBgra, 4),
      `zoomed content at glass (60,60); got ${pixelAt(px, OUT.width, 60, 60)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 200, 128), BLACK, 4),
      `void past the scaled window; got ${pixelAt(px, OUT.width, 200, 128)}`);
    // The panel does not zoom.
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 128, 15), greenBgra, 4),
      `panel unscaled under zoom; got ${pixelAt(px, OUT.width, 128, 15)}`);

    // Hit-testing maps glass through the zoom: glass (100, 100) is world
    // (200, 200) -> inside the window; glass (200, 128) is world (400, 256)
    // -> void.
    pointerMotion(c.addon, 100, 100);
    await c.waitFor(c.query, (s) => s.pointerFocus === toplevelId,
      { what: "zoomed pointer focus on toplevel" });
    pointerMotion(c.addon, 200, 128);
    await c.waitFor(c.query, (s) => s.pointerFocus === null,
      { what: "void under zoom clears pointer focus" });

    // Identity restore.
    setCamera(c, 0, 0, 0, 1);
    px = await readUntil(c,
      (p) => pixelMatches(pixelAt(p, OUT.width, 200, 128), blueBgra, 4));
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 200, 128), blueBgra, 4),
      `identity restored; got ${pixelAt(px, OUT.width, 200, 128)}`);
  } finally {
    await c.teardown();
  }
});
