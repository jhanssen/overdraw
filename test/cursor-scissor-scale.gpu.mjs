// Cursor rendering + composite-scissor correctness at fractional output
// scale, headless.
//
// Two oracles, both against a solid-red cursor sweeping over a solid-blue
// background at scale 1.5 (the sweep uses fractional pointer coordinates,
// like real input):
//
//  1. Per-frame synthetic oracle: every pixel must be pure red or pure
//     blue, and red only within the cursor sprite's device rect. Any other
//     color anywhere (black fill residue, stale content, sampling bleed)
//     or misplaced red is an artifact. This catches draw-path bugs that an
//     incremental-vs-full comparison cannot (a bug in the sprite draw
//     appears in both and cancels).
//
//  2. End-of-sweep incremental-vs-full comparison: the incrementally
//     rendered target must be pixel-identical to a forced full repaint of
//     the same scene. This catches damage/scissor bookkeeping bugs.
//
// Run: npm run test:gpu

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();

const DEV = 192, DEVH = 190;  // 190/1.5 -> logical 126.67: non-integer, like real modes
// 1.25 makes the fill-coverage miss a solid quarter-pixel (edge at .25
// past a pixel center) instead of an exact .5 rasterization tie, so the
// repro does not depend on the GPU's tie-breaking.
const SCALE = 1.25;
const LOGICAL = 160;  // covers DEV/SCALE on both axes (clipped at the target edge)
const CUR_W = 24, CUR_H = 24;
const HOT_X = 4, HOT_Y = 4;

const RED = [0, 0, 255, 255];    // BGRA
const BLUE = [255, 0, 0, 255];

function solid(bgra, w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = bgra[0]; buf[i + 1] = bgra[1]; buf[i + 2] = bgra[2]; buf[i + 3] = bgra[3];
  }
  return { data: buf, stride };
}

test("fractional scale: cursor sweep renders only red-in-rect and blue", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));

  addon.start(gpuBin, () => {}, null, { width: DEV, height: DEVH });
  try {
    const h = addon.gpuHandles();
    assert.ok(h, "gpuHandles");
    const device = dawn.wrapDevice(h.instance, h.device);
    const comp = new JsCompositor(device, dawn.globals, addon, { width: DEV, height: DEVH });
    comp.setOutputSize(DEV, DEVH, SCALE);

    const bg = solid(BLUE, LOGICAL, LOGICAL);
    comp.uploadPixels(1, { width: LOGICAL, height: LOGICAL, stride: bg.stride }, bg.data);
    comp.setSurfaceLayout(1, 0, 0, LOGICAL, LOGICAL);
    comp.setStack([1]);
    // A translucent island backdrop over the sweep area. Translucency is
    // load-bearing: it blends against whatever the partial frame left
    // underneath, so a base pixel the black fill failed to cover shows the
    // previous frame's content ghosting through -- the artifact this test
    // guards. An opaque scene overdraws such pixels and hides the bug.
    comp.setIslandBackdrops([
      { x: 30, y: 30, width: 80, height: 80, color: { r: 128, g: 128, b: 128, a: 56 } },
    ]);

    const cur = solid(RED, CUR_W, CUR_H);
    comp.setCursorPixels(cur.data, CUR_W, CUR_H, HOT_X, HOT_Y);
    comp.setCursorVisible(true);

    // Scan one frame against the oracle. The sprite's device rect is
    // (pointer - hotspot) * scale, sized CUR * scale; allow 1px of slack on
    // every edge for rasterization rounding of the fractional quad.
    // Backdrop device rect (blends are hardware-rounded; the end-of-sweep
    // incremental-vs-full diff is the oracle inside it).
    const BD = { x0: 30 * SCALE - 2, y0: 30 * SCALE - 2, x1: 110 * SCALE + 2, y1: 110 * SCALE + 2 };
    function scanFrame(data, px_, py_, tag) {
      const rx0 = (px_ - HOT_X) * SCALE, ry0 = (py_ - HOT_Y) * SCALE;
      const rx1 = rx0 + CUR_W * SCALE, ry1 = ry0 + CUR_H * SCALE;
      const bad = [];
      for (let y = 0; y < DEVH && bad.length < 6; y++) {
        for (let x = 0; x < DEV && bad.length < 6; x++) {
          if (x >= BD.x0 && x <= BD.x1 && y >= BD.y0 && y <= BD.y1) continue;
          const i = (y * DEV + x) * 4;
          const b = data[i], g = data[i + 1], r = data[i + 2], a = data[i + 3];
          const isRed = b === 0 && g === 0 && r === 255 && a === 255;
          const isBlue = b === 255 && g === 0 && r === 0 && a === 255;
          if (!isRed && !isBlue) {
            bad.push(`${tag}: (${x},${y}) = [${b},${g},${r},${a}] (neither red nor blue)`);
            continue;
          }
          const inRect = x >= rx0 - 1 && x <= rx1 + 1 && y >= ry0 - 1 && y <= ry1 + 1;
          if (isRed && !inRect) bad.push(`${tag}: red outside cursor rect at (${x},${y})`);
        }
      }
      return bad;
    }

    let x = 10.0, y = 10.0;
    comp.setCursorPosition(x, y);
    comp.renderFrame();
    let rb = await comp.readback();
    let bad = scanFrame(rb.data, x, y, "frame0(full)");
    assert.equal(bad.length, 0, `first (full) frame artifacts:\n${bad.join("\n")}`);

    // Mouse-like diagonal sweep, fractional steps, partial frame per move.
    for (let i = 0; i < 40; i++) {
      x += 2.3; y += 1.7;
      comp.setCursorPosition(x, y);
      comp.renderFrame();
      rb = await comp.readback();
      bad = scanFrame(rb.data, x, y, `step${i}@(${x.toFixed(1)},${y.toFixed(1)})`);
      assert.equal(bad.length, 0, `sweep artifacts:\n${bad.join("\n")}`);
    }
    // Two final moves with adversarial parity (found by brute force). The
    // second frame's union damage box ends at logical x1=75, whose true
    // device edge is ceil(75*1.25)=94 -- but a scissor computed as
    // floor(x0*scale)+ceil(w*scale) ends at 93, one column short. The old
    // sprite painted device column 93 (its edge at 93.75), so the move
    // leaves a 1px stale-cursor line just right of the vacated sprite:
    // exactly the artifact seen live at fractional scales.
    comp.setCursorPosition(55.0, 55.0);
    comp.renderFrame();
    await comp.readback();
    comp.setCursorPosition(51.9, 51.9);
    comp.renderFrame();
    rb = await comp.readback();
    const incremental = rb.data;

    // Bookkeeping oracle: forced full repaint of the identical scene must
    // match the incremental target exactly.
    comp.setOutputSize(DEV, DEVH, SCALE);  // damageFull; target dims unchanged
    comp.renderFrame();
    const { data: full } = await comp.readback();
    const diff = [];
    for (let py = 0; py < DEVH && diff.length < 6; py++) {
      for (let qx = 0; qx < DEV && diff.length < 6; qx++) {
        const i = (py * DEV + qx) * 4;
        if (incremental[i] !== full[i] || incremental[i + 1] !== full[i + 1]
          || incremental[i + 2] !== full[i + 2] || incremental[i + 3] !== full[i + 3]) {
          diff.push(`(${qx},${py}) inc=[${incremental[i]},${incremental[i + 1]},${incremental[i + 2]},${incremental[i + 3]}]`
            + ` full=[${full[i]},${full[i + 1]},${full[i + 2]},${full[i + 3]}]`);
        }
      }
    }
    assert.equal(diff.length, 0,
      `incremental render diverged from full repaint (stale pixels):\n${diff.join("\n")}`);
  } finally {
    addon.stop();
  }
});
