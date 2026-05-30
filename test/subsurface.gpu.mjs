// Subsurface compositing (headless pixel test): a parent toplevel with a child
// wl_subsurface at an offset must composite the child ABOVE the parent at
// parent_rect + (sx, sy). Verifies the child color appears in the child region
// and the parent color shows in a parent-only region. Computed expectation, no
// goldens. Needs the GPU.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin, pixelAt, pixelMatches } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (WAYLAND_DISPLAY unset)";
const OUT = { width: 1280, height: 720 };
const SUB_BIN = buildBin("subsurface-test-client");

function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff, g = (argb >>> 8) & 0xff, b = argb & 0xff, a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}

async function readWhen(c, expect /* {x,y,bgra} */, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const px = await c.frameReadback();
    if (px && pixelMatches(pixelAt(px, OUT.width, expect.x, expect.y), expect.bgra, 4)) return px;
    await new Promise((r) => setTimeout(r, 16));
  }
  return c.frameReadback();
}

test("subsurface composites above its parent at parent + offset", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const pColor = 0xff0000ff, cColor = 0xff00ff00; // parent blue, child green
    const PW = 300, PH = 200, CW = 80, CH = 60, OX = 40, OY = 30;
    const cl = c.spawnClient(
      ["--parent", `${PW}x${PH}`, "--child", `${CW}x${CH}`, "--offset", `${OX}x${OY}`,
       "--parent-color", pColor.toString(16), "--child-color", cColor.toString(16)],
      { bin: SUB_BIN, readyMarker: "[subsurface-client] mapped" });
    await cl.ready;

    // The WM places the parent toplevel; query() gives its rect.
    const snap = await c.waitFor(c.query, (s) => s.windows.length >= 1, { what: "parent window" });
    const p = snap.windows[0].rect;

    // Child center in output space = parent origin + offset + half child.
    const childCx = p.x + OX + (CW >> 1);
    const childCy = p.y + OY + (CH >> 1);
    const bgraChild = argbToBgra(cColor);
    const frame = await readWhen(c, { x: childCx, y: childCy, bgra: bgraChild });

    assert.ok(pixelMatches(pixelAt(frame, OUT.width, childCx, childCy), bgraChild, 4),
      `child region should show the child color; got ${pixelAt(frame, OUT.width, childCx, childCy)}`);

    // A parent-only point (top-left corner, before the child offset) shows parent.
    const px = p.x + 5, py = p.y + 5;
    assert.ok(px < p.x + OX || py < p.y + OY, "sample point is outside the child region");
    assert.ok(pixelMatches(pixelAt(frame, OUT.width, px, py), argbToBgra(pColor), 4),
      `parent-only region should show the parent color; got ${pixelAt(frame, OUT.width, px, py)}`);
  } finally {
    await c.teardown();
  }
});
