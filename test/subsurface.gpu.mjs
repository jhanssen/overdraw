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

// Spec: a SYNCHRONIZED subsurface (the default) caches its commits; the cached
// state is applied only when the PARENT commits. So after the child commits its
// buffer but before the parent's next commit, the child must NOT yet appear.
test("sync subsurface: child does NOT appear until the parent commits", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const pColor = 0xff0000ff, cColor = 0xff00ff00;
    const PW = 300, PH = 200, CW = 80, CH = 60, OX = 40, OY = 30;
    const cl = c.spawnClient(
      ["--sync", "--step", "--parent", `${PW}x${PH}`, "--child", `${CW}x${CH}`,
       "--offset", `${OX}x${OY}`, "--parent-color", pColor.toString(16),
       "--child-color", cColor.toString(16)],
      { bin: SUB_BIN, readyMarker: "[subsurface-client] mapped", stdin: true });
    await cl.ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length >= 1, { what: "parent window" });
    const p = snap.windows[0].rect;
    const childCx = p.x + OX + (CW >> 1), childCy = p.y + OY + (CH >> 1);
    const bgraChild = argbToBgra(cColor), bgraParent = argbToBgra(pColor);

    // Child has committed (sync, cached) but the parent has NOT re-committed.
    await cl.waitForLine(/child-committed/, { what: "child commit" });
    // Read back: the child region must still show the PARENT color (child cached).
    // Wait until the parent has composited at all, then assert child is absent.
    const before = await readWhen(c, { x: p.x + 5, y: p.y + 5, bgra: bgraParent });
    assert.ok(pixelMatches(pixelAt(before, OUT.width, childCx, childCy), bgraParent, 4),
      `sync child must NOT show before parent commit; got ${pixelAt(before, OUT.width, childCx, childCy)}`);

    // Tell the client to commit the parent -> the cached child state applies.
    cl.send("go");
    await cl.waitForLine(/parent-committed/, { what: "parent commit" });
    const after = await readWhen(c, { x: childCx, y: childCy, bgra: bgraChild });
    assert.ok(pixelMatches(pixelAt(after, OUT.width, childCx, childCy), bgraChild, 4),
      `sync child must appear after parent commit; got ${pixelAt(after, OUT.width, childCx, childCy)}`);
  } finally {
    await c.teardown();
  }
});

// Spec: a DESYNCHRONIZED subsurface applies its commits directly (no wait for the
// parent). So the child CONTENT appears as soon as the child commits, before any
// further parent commit. (Position uses offset 0 here: set_position takes effect
// on the next PARENT commit per spec, so with no parent re-commit the child sits
// at the parent origin -- which is exactly what we assert, isolating the content-
// timing behavior from the position-timing behavior.)
test("desync subsurface: child content appears on its own commit (no parent commit needed)", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const pColor = 0xff0000ff, cColor = 0xff00ff00;
    const PW = 300, PH = 200, CW = 80, CH = 60;
    const cl = c.spawnClient(
      ["--step", "--parent", `${PW}x${PH}`, "--child", `${CW}x${CH}`,
       "--offset", "0x0", "--parent-color", pColor.toString(16),
       "--child-color", cColor.toString(16)],  // no --sync => desync
      { bin: SUB_BIN, readyMarker: "[subsurface-client] mapped", stdin: true });
    await cl.ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length >= 1, { what: "parent window" });
    const p = snap.windows[0].rect;
    // Child at parent origin (offset 0). Sample inside the child rect.
    const cx = p.x + (CW >> 1), cy = p.y + (CH >> 1);
    const bgraChild = argbToBgra(cColor);

    await cl.waitForLine(/child-committed/, { what: "child commit" });
    // Desync: child content should appear from its own commit, no parent commit.
    const frame = await readWhen(c, { x: cx, y: cy, bgra: bgraChild });
    assert.ok(pixelMatches(pixelAt(frame, OUT.width, cx, cy), bgraChild, 4),
      `desync child content should appear on its own commit; got ${pixelAt(frame, OUT.width, cx, cy)}`);
    cl.send("go"); // let it finish cleanly
  } finally {
    await c.teardown();
  }
});
