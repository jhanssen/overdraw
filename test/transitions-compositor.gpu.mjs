// Phase 8 step 2: compositor-direct tests for the transition pipeline.
// Drives JsCompositor.setActiveTransition with two textures and asserts
// the on-screen output blends them per the chosen kind. This bypasses
// the transitions broker + plugin SDK (those land in step 3); the goal
// here is to validate the WGSL kinds + the renderFrame routing.
//
// Inputs are built directly via queue.writeTexture (solid-color fills)
// rather than from real Wayland clients, so the test is independent of
// the WM tiling and any client-render timing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (WAYLAND_DISPLAY unset)";
const OUT = { width: 320, height: 240 };

// Allocate a TEXTURE_BINDING|RENDER_ATTACHMENT|COPY_SRC|COPY_DST texture
// on the core device, filled with a single solid color via writeTexture.
// Color is [B, G, R, A] bytes (matches the compositor's bgra8unorm).
function solidTexture(c, bgra, w, h) {
  const tex = c.coreDevice.createTexture({
    size: { width: w, height: h },
    format: "bgra8unorm",
    usage: c.dawn.globals.GPUTextureUsage.TEXTURE_BINDING
         | c.dawn.globals.GPUTextureUsage.COPY_DST,
  });
  // One row of solid bytes, repeated h times. Allocates h*w*4 -- cheap
  // for the test's small targets.
  const row = new Uint8Array(w * 4);
  for (let i = 0; i < w; i++) {
    row[i * 4 + 0] = bgra[0];
    row[i * 4 + 1] = bgra[1];
    row[i * 4 + 2] = bgra[2];
    row[i * 4 + 3] = bgra[3];
  }
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(row, y * w * 4);
  c.coreDevice.queue.writeTexture(
    { texture: tex },
    data,
    { bytesPerRow: w * 4, rowsPerImage: h },
    { width: w, height: h },
  );
  return tex;
}

// Drive one renderFrame and read back the offscreen target.
async function frame(c) {
  c.jsCompositor.renderFrame();
  return c.frameReadback();
}

// Convenience: BGRA constants. Premultiplied (alpha 0xff so straight = pre).
const RED  = [0x00, 0x00, 0xff, 0xff];
const BLUE = [0xff, 0x00, 0x00, 0xff];

// ---- crossfade ----

test("transition crossfade: progress=0 -> from, progress=1 -> to, mid -> blend",
    { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const fromTex = solidTexture(c, RED,  OUT.width, OUT.height);
    const toTex   = solidTexture(c, BLUE, OUT.width, OUT.height);
    let progress = 0;
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "crossfade", getProgress: () => progress,
    });

    progress = 0;
    let px = await frame(c);
    let p = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1);
    assert.ok(pixelMatches(p, RED, 4), `p=0 expected red, got ${p}`);

    progress = 1;
    px = await frame(c);
    p = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1);
    assert.ok(pixelMatches(p, BLUE, 4), `p=1 expected blue, got ${p}`);

    progress = 0.5;
    px = await frame(c);
    p = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1);
    // Linear interp of premultiplied: (1-p)*RED + p*BLUE = (~128, 0, ~128).
    assert.ok(Math.abs(p[0] - 128) < 8, `mid B: expected ~128, got ${p[0]}`);
    assert.ok(p[1] < 8, `mid G: expected ~0, got ${p[1]}`);
    assert.ok(Math.abs(p[2] - 128) < 8, `mid R: expected ~128, got ${p[2]}`);

    c.jsCompositor.clearActiveTransition();
    fromTex.destroy();
    toTex.destroy();
  } finally {
    await c.teardown();
  }
});

// ---- slide-left ----

test("transition slide-left: midpoint puts from on the LEFT, to on the RIGHT",
    { skip }, async () => {
  // FROM slides off to the left as progress advances. At p=0.5, FROM has
  // shifted half-screen left, so the left half of the screen still shows
  // FROM and the right half shows TO entering from the right edge.
  const c = await setupCompositor({ headless: OUT });
  try {
    const fromTex = solidTexture(c, RED,  OUT.width, OUT.height);
    const toTex   = solidTexture(c, BLUE, OUT.width, OUT.height);
    let progress = 0.5;
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "slide-left", getProgress: () => progress,
    });

    const px = await frame(c);
    const left  = pixelAt(px, OUT.width, OUT.width >> 2,       OUT.height >> 1);
    const right = pixelAt(px, OUT.width, (OUT.width * 3) >> 2, OUT.height >> 1);
    assert.ok(pixelMatches(left,  RED,  4), `left expected red, got ${left}`);
    assert.ok(pixelMatches(right, BLUE, 4), `right expected blue, got ${right}`);

    c.jsCompositor.clearActiveTransition();
    fromTex.destroy();
    toTex.destroy();
  } finally {
    await c.teardown();
  }
});

// ---- slide-right ----

test("transition slide-right: midpoint puts to on the LEFT, from on the RIGHT",
    { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const fromTex = solidTexture(c, RED,  OUT.width, OUT.height);
    const toTex   = solidTexture(c, BLUE, OUT.width, OUT.height);
    let progress = 0.5;
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "slide-right", getProgress: () => progress,
    });

    const px = await frame(c);
    const left  = pixelAt(px, OUT.width, OUT.width >> 2,       OUT.height >> 1);
    const right = pixelAt(px, OUT.width, (OUT.width * 3) >> 2, OUT.height >> 1);
    assert.ok(pixelMatches(left,  BLUE, 4), `left expected blue, got ${left}`);
    assert.ok(pixelMatches(right, RED,  4), `right expected red, got ${right}`);

    c.jsCompositor.clearActiveTransition();
    fromTex.destroy();
    toTex.destroy();
  } finally {
    await c.teardown();
  }
});

// ---- slide-up ----

test("transition slide-up: midpoint puts from on TOP, to on BOTTOM",
    { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const fromTex = solidTexture(c, RED,  OUT.width, OUT.height);
    const toTex   = solidTexture(c, BLUE, OUT.width, OUT.height);
    let progress = 0.5;
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "slide-up", getProgress: () => progress,
    });

    const px = await frame(c);
    const top    = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 2);
    const bottom = pixelAt(px, OUT.width, OUT.width >> 1, (OUT.height * 3) >> 2);
    assert.ok(pixelMatches(top,    RED,  4), `top expected red, got ${top}`);
    assert.ok(pixelMatches(bottom, BLUE, 4), `bottom expected blue, got ${bottom}`);

    c.jsCompositor.clearActiveTransition();
    fromTex.destroy();
    toTex.destroy();
  } finally {
    await c.teardown();
  }
});

// ---- slide-down ----

test("transition slide-down: midpoint puts to on TOP, from on BOTTOM",
    { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const fromTex = solidTexture(c, RED,  OUT.width, OUT.height);
    const toTex   = solidTexture(c, BLUE, OUT.width, OUT.height);
    let progress = 0.5;
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "slide-down", getProgress: () => progress,
    });

    const px = await frame(c);
    const top    = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 2);
    const bottom = pixelAt(px, OUT.width, OUT.width >> 1, (OUT.height * 3) >> 2);
    assert.ok(pixelMatches(top,    BLUE, 4), `top expected blue, got ${top}`);
    assert.ok(pixelMatches(bottom, RED,  4), `bottom expected red, got ${bottom}`);

    c.jsCompositor.clearActiveTransition();
    fromTex.destroy();
    toTex.destroy();
  } finally {
    await c.teardown();
  }
});

// ---- scale ----

test("transition scale: progress=1 shows to; midpoint shows blended center",
    { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const fromTex = solidTexture(c, RED,  OUT.width, OUT.height);
    const toTex   = solidTexture(c, BLUE, OUT.width, OUT.height);
    let progress = 1;
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "scale", getProgress: () => progress,
    });

    // At p=1: FROM is scale 0 (gone); TO is full scale (blue) -> center is BLUE.
    let px = await frame(c);
    const at1 = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1);
    assert.ok(pixelMatches(at1, BLUE, 4), `p=1 expected blue, got ${at1}`);

    // At p=0.5: both FROM (red, alpha 0.5) and TO (blue, alpha 0.5) overlap
    // at center -> 0.5*red + 0.5*blue = (~128, 0, ~128, 0xff).
    progress = 0.5;
    px = await frame(c);
    const mid = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1);
    assert.ok(Math.abs(mid[0] - 128) < 16, `mid B: expected ~128, got ${mid[0]}`);
    assert.ok(mid[1] < 16, `mid G: expected ~0, got ${mid[1]}`);
    assert.ok(Math.abs(mid[2] - 128) < 16, `mid R: expected ~128, got ${mid[2]}`);

    c.jsCompositor.clearActiveTransition();
    fromTex.destroy();
    toTex.destroy();
  } finally {
    await c.teardown();
  }
});

// ---- on-screen pass replacement ----

test("renderFrame: while transition active, on-screen output ignores draw list",
    { skip }, async () => {
  // Even with an empty drawList (no surfaces), the transition pass
  // produces a non-empty output. And even with a non-empty drawList,
  // the on-screen result IS the transition pass output, not the
  // composite of the drawList.
  const c = await setupCompositor({ headless: OUT });
  try {
    const fromTex = solidTexture(c, RED,  OUT.width, OUT.height);
    const toTex   = solidTexture(c, RED,  OUT.width, OUT.height);  // same
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "crossfade", getProgress: () => 0,
    });

    const px = await frame(c);
    // Whole screen is RED (both inputs are RED).
    const corners = [
      pixelAt(px, OUT.width, 0, 0),
      pixelAt(px, OUT.width, OUT.width - 1, 0),
      pixelAt(px, OUT.width, 0, OUT.height - 1),
      pixelAt(px, OUT.width, OUT.width - 1, OUT.height - 1),
    ];
    for (const p of corners) {
      assert.ok(pixelMatches(p, RED, 4), `corner expected red, got ${p}`);
    }

    c.jsCompositor.clearActiveTransition();
    fromTex.destroy();
    toTex.destroy();
  } finally {
    await c.teardown();
  }
});

// ---- error / lifecycle ----

test("setActiveTransition: rejects double install", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const fromTex = solidTexture(c, RED,  4, 4);
    const toTex   = solidTexture(c, BLUE, 4, 4);
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "crossfade", getProgress: () => 0,
    });
    assert.throws(() => c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "crossfade", getProgress: () => 0,
    }), /already active/);
    c.jsCompositor.clearActiveTransition();
    // After clear, install succeeds again.
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "crossfade", getProgress: () => 0,
    });
    c.jsCompositor.clearActiveTransition();
    fromTex.destroy();
    toTex.destroy();
  } finally {
    await c.teardown();
  }
});

test("hasActiveTransition: reflects install/clear", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    assert.equal(c.jsCompositor.hasActiveTransition(), false);
    const fromTex = solidTexture(c, RED,  4, 4);
    const toTex   = solidTexture(c, BLUE, 4, 4);
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "crossfade", getProgress: () => 0,
    });
    assert.equal(c.jsCompositor.hasActiveTransition(), true);
    c.jsCompositor.clearActiveTransition();
    assert.equal(c.jsCompositor.hasActiveTransition(), false);
    fromTex.destroy();
    toTex.destroy();
  } finally {
    await c.teardown();
  }
});

// ---- resolveTextures: per-frame re-pick ----

test("setActiveTransition: resolveTextures called per frame; bind group rebuilds on identity change",
    { skip }, async () => {
  // Worker-live's case: the input texture identity rotates each frame.
  // Verify that when resolveTextures returns a different handle the
  // next frame samples the new texture, not the stale bind group.
  const c = await setupCompositor({ headless: OUT });
  try {
    const fromTex  = solidTexture(c, RED,  OUT.width, OUT.height);
    const toTex1   = solidTexture(c, BLUE, OUT.width, OUT.height);
    const toTex2   = solidTexture(c, [0, 0xff, 0, 0xff], OUT.width, OUT.height); // green
    let toTex = toTex1;
    c.jsCompositor.setActiveTransition({
      fromTex, toTex,
      kind: "crossfade", getProgress: () => 1,  // fully TO
      resolveTextures: () => ({ fromTex, toTex }),
    });

    let px = await frame(c);
    let p = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1);
    assert.ok(pixelMatches(p, BLUE, 4), `expected blue, got ${p}`);

    // Swap to-texture identity.
    toTex = toTex2;
    px = await frame(c);
    p = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1);
    assert.ok(pixelMatches(p, [0, 0xff, 0, 0xff], 4), `expected green, got ${p}`);

    c.jsCompositor.clearActiveTransition();
    fromTex.destroy();
    toTex1.destroy();
    toTex2.destroy();
  } finally {
    await c.teardown();
  }
});

test("setActiveTransition: resolveTextures returns null -> opaque-black clear",
    { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const fromTex = solidTexture(c, RED,  4, 4);
    const toTex   = solidTexture(c, BLUE, 4, 4);
    c.jsCompositor.setActiveTransition({
      fromTex, toTex, kind: "crossfade", getProgress: () => 0.5,
      resolveTextures: () => null,
    });
    const px = await frame(c);
    const p = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1);
    // null resolver -> clear to (0,0,0,1).
    assert.ok(pixelMatches(p, [0, 0, 0, 0xff], 4), `expected black, got ${p}`);
    c.jsCompositor.clearActiveTransition();
    fromTex.destroy();
    toTex.destroy();
  } finally {
    await c.teardown();
  }
});
