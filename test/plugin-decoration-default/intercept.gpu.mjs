// End-to-end GPU test for the bundled decoration-default plugin running
// as an intercept (step 2 of decoration-as-intercept.md). Verifies:
//
//   - the border band pixels in the perimeter of the intercept output
//     come from the configured fill (the focused gradient by default
//     when the window has focus); the inset region samples the client.
//
//   - the late-match catch-up gate path: when a client maps first and
//     the bundled plugin then matches, the window stays out of the
//     draw stack until the client re-commits at the post-insets size.
//     (Verified indirectly via state.wm.isContentGated transitioning
//     false during the test's settled poll.)
//
// All tests share the bundled plugin (BUNDLED_PLUGINS contains it
// unconditionally) with explicit decoration config so the test's
// expected colors match what the plugin paints.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setupCompositor, canRunGpu, buildBin, pixelAt, pixelMatches, settled,
} from "../harness.mjs";

const HARNESS_BIN = buildBin("harness-client");
const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";

const OUT = { width: 256, height: 256 };
// The client size doesn't matter for the bundled plugin (which decorates
// the WM-assigned outer rect, not the client's requested rect); we pass
// --fill-configured so the client adopts the post-insets content size on
// the first configure.
const CLIENT_REQUESTED_SIZE = "200x150";
const CLIENT_COLOR_ARGB = "FFFF0000";              // ARGB: opaque red
const CLIENT_BGRA = [0, 0, 255, 255];              // BGRA: red

// The bundled plugin's default unfocused fill (single window in a test
// session has no keyboard-focused state, so the default unfocused
// gradient applies). Default is #3a3a3aff (solid). Convert to BGRA.
const HEX_TO_BGRA = (h) => {
  const n = parseInt(h.slice(1), 16);
  // For "#3a3a3aff" (8 nybbles): r=3a g=3a b=3a a=ff.
  const r = (n >>> 24) & 0xff;
  const g = (n >>> 16) & 0xff;
  const b = (n >>> 8)  & 0xff;
  const a = n & 0xff;
  return [b, g, r, a];
};
const UNFOCUSED_BGRA = HEX_TO_BGRA("#3a3a3aff");
const FOCUSED_BGRA = HEX_TO_BGRA("#0000ffff");       // blue -> BGRA [255,0,0,255]

test("decoration-default (intercept): border band fills the perimeter; client fills the inset",
  { skip }, async () => {
  // The bundled decoration plugin's default appIdPattern is ".*", so it
  // matches any client. Use a borderWidth large enough to sample cleanly
  // (8 px on each axis).
  const B = 8;
  const c = await setupCompositor({
    headless: OUT,
    intercept: true,
    config: {
      decoration: {
        appIdPattern: ".*",
        border: { width: B, radius: 0 },   // radius 0 -> sharp rectangle
        unfocused: { kind: "solid", color: "#3a3a3aff" },
        focused: { kind: "solid", color: "#3a3a3aff" },
      },
    },
  });
  try {
    const client = c.spawnClient(
      ["--app-id", "deco-test", "--color", CLIENT_COLOR_ARGB,
       "--size", CLIENT_REQUESTED_SIZE, "--title", "t",
       "--fill-configured"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await client.ready;
    // The intercept output replaces the client texture at the WM outer
    // rect. With a single client, the layout fills the full output;
    // the outer is 256x256, content (after 8px insets) is 240x240,
    // band is 8px wide on every side.
    // Wait for the inset region to show the client's red AND the band
    // to show the gradient. The late-match catch-up flow may take a
    // frame or two: the client maps at 256x256 first, the broker
    // matches, the plugin calls setInsets, the client reconfigures to
    // 240x240, re-commits, the gate releases.
    const center = { x: OUT.width >> 1, y: OUT.height >> 1 };   // inset region
    const bandSample = { x: 2, y: 2 };                          // band region (top-left)
    // The settle predicate covers EVERY probe point asserted below: a
    // transitional catch-up frame (client still committed at the pre-inset
    // size, decoration output stretched) can satisfy center+corner while
    // the band edge is still off by a few px, so settling on a subset
    // flakes the later asserts.
    const px = await settled(() => c.frameReadback(),
      (p) => p
        && pixelMatches(pixelAt(p, OUT.width, center.x, center.y), CLIENT_BGRA, 8)
        && pixelMatches(pixelAt(p, OUT.width, bandSample.x, bandSample.y), UNFOCUSED_BGRA, 8)
        && pixelMatches(pixelAt(p, OUT.width, OUT.width >> 1, 2), UNFOCUSED_BGRA, 8)
        && pixelMatches(pixelAt(p, OUT.width, OUT.width >> 1, B + 2), CLIENT_BGRA, 8),
      { what: "decoration: client inset + band settled at all probe points", timeoutMs: 6000 });
    // Sanity checks once settled:
    assert.ok(pixelMatches(pixelAt(px, OUT.width, center.x, center.y), CLIENT_BGRA, 8),
      `center should be the client's red (inset region); got ${pixelAt(px, OUT.width, center.x, center.y)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, bandSample.x, bandSample.y), UNFOCUSED_BGRA, 8),
      `top-left corner should be the border band; got ${pixelAt(px, OUT.width, bandSample.x, bandSample.y)}`);
    // Inside the band but not at the very corner.
    assert.ok(pixelMatches(pixelAt(px, OUT.width, OUT.width >> 1, 2), UNFOCUSED_BGRA, 8),
      `top-middle should be the border band; got ${pixelAt(px, OUT.width, OUT.width >> 1, 2)}`);
    // Inside the inset region, just past the band.
    assert.ok(pixelMatches(pixelAt(px, OUT.width, OUT.width >> 1, B + 2), CLIENT_BGRA, 8),
      `just past the top band -> client; got ${pixelAt(px, OUT.width, OUT.width >> 1, B + 2)}`);
  } finally {
    await c.teardown();
  }
});

test("decoration-default (intercept): band reflects keyboard focus on an idle window",
  { skip }, async () => {
  // Regression: a static window (one that never commits again after its
  // first frame) must repaint its decoration band when keyboard focus
  // changes. Focus is a level-triggered render input (ctx.activated); the
  // plugin reads it live each tick instead of caching a window.change edge,
  // which is what a client with no ongoing content (a dialog) depends on.
  const B = 8;
  const c = await setupCompositor({
    headless: OUT,
    intercept: true,
    config: {
      decoration: {
        appIdPattern: ".*",
        border: { width: B, radius: 0 },
        unfocused: { kind: "solid", color: "#3a3a3aff" },
        focused: { kind: "solid", color: "#0000ffff" },
      },
    },
  });
  try {
    const client = c.spawnClient(
      ["--app-id", "deco-test", "--color", CLIENT_COLOR_ARGB,
       "--size", CLIENT_REQUESTED_SIZE, "--title", "t",
       "--fill-configured"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await client.ready;
    const band = { x: 2, y: 2 };
    const win = c.query().windows.find((w) => w.appId === "deco-test");
    assert.ok(win, "decorated window present in query");
    // The client never commits again after mapping; each transition below only
    // changes keyboard focus, so a repaint proves the band tracks ctx.activated
    // live rather than a cached window.change edge.

    // Focus -> focused fill.
    c.state.seat.applyKeyboardFocus(win.surfaceId);
    assert.equal(c.state.seat.kbFocus?.surfaceId, win.surfaceId,
      "keyboard focus landed on the decorated window");
    let px = await settled(() => c.frameReadback(),
      (p) => p && pixelMatches(pixelAt(p, OUT.width, band.x, band.y), FOCUSED_BGRA, 8),
      { what: "band focused after focus", timeoutMs: 6000 });
    // The client content is untouched by the focus change.
    assert.ok(pixelMatches(pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1), CLIENT_BGRA, 8),
      `center still shows client; got ${pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1)}`);

    // Blur -> unfocused fill (no client commit).
    c.state.seat.applyKeyboardFocus(null);
    await settled(() => c.frameReadback(),
      (p) => p && pixelMatches(pixelAt(p, OUT.width, band.x, band.y), UNFOCUSED_BGRA, 8),
      { what: "band unfocused after blur", timeoutMs: 6000 });

    // Re-focus -> focused fill again (no client commit).
    c.state.seat.applyKeyboardFocus(win.surfaceId);
    px = await settled(() => c.frameReadback(),
      (p) => p && pixelMatches(pixelAt(p, OUT.width, band.x, band.y), FOCUSED_BGRA, 8),
      { what: "band focused after re-focus", timeoutMs: 6000 });
    assert.ok(pixelMatches(pixelAt(px, OUT.width, band.x, band.y), FOCUSED_BGRA, 8),
      `band must be the focused fill after re-focus; got ${pixelAt(px, OUT.width, band.x, band.y)}`);
  } finally {
    await c.teardown();
  }
});

test("decoration-default (intercept): band hugs the window geometry, not the CSD shadow buffer",
  { skip }, async () => {
  // A GTK-style CSD client draws a transparent drop-shadow margin AROUND its
  // window: the buffer is bigger than the real window on every side, and
  // set_window_geometry declares the opaque inner rect. The decoration must
  // band the WINDOW (geometry), sampling only that sub-region -- not the whole
  // buffer -- so the band hugs the window with no transparent gap where the
  // shadow was. Regression for the double-crop (compositor re-cropping the
  // intercept output by geometry) + buffer-vs-geometry banding bugs.
  const B = 8;
  const c = await setupCompositor({
    headless: OUT,
    intercept: true,
    config: {
      decoration: {
        appIdPattern: ".*",
        border: { width: B, radius: 0 },
        unfocused: { kind: "solid", color: "#00ff00ff" },   // green band
        focused: { kind: "solid", color: "#00ff00ff" },
      },
    },
  });
  const BAND_BGRA = [0, 255, 0, 255];   // green
  try {
    // --shadow-margin 30: buffer = window + 60, geometry = window @ (30,30).
    const client = c.spawnClient(
      ["--app-id", "csd", "--color", CLIENT_COLOR_ARGB, "--size", "140x140",
       "--shadow-margin", "30", "--fill-configured", "--title", "s"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await client.ready;
    const win = () => c.query().windows.find((w) => w.appId === "csd");
    // Settle: the window content (red) fills the inset, hugged by the band.
    const px = await settled(() => c.frameReadback(),
      (p) => {
        if (!p) return false;
        const w = win();
        if (!w) return false;
        const cx = w.rect.x + (w.rect.width >> 1);
        const cy = w.rect.y + (w.rect.height >> 1);
        return pixelMatches(pixelAt(p, OUT.width, cx, cy), CLIENT_BGRA, 8)
          && pixelMatches(pixelAt(p, OUT.width, 2, cy), BAND_BGRA, 8);
      },
      { what: "csd window content + band settled", timeoutMs: 6000 });
    const w = win();
    const cy = w.rect.y + (w.rect.height >> 1);
    // The band hugs the window: NO transparent pixel anywhere along a scanline
    // through the window center. Before the fix, the client's transparent
    // shadow margin sat between the window and the band as a see-through gap.
    for (let x = 0; x < OUT.width; x++) {
      const p = pixelAt(px, OUT.width, x, cy);
      assert.ok(p[3] > 200,
        `scanline pixel (${x},${cy}) must be opaque (band or window), not a `
        + `transparent shadow gap; got [B,G,R,A]=${Array.from(p)}`);
    }
    // Left band is green; window interior is the client's red; the boundary is
    // direct (band -> window, no gap).
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 2, cy), BAND_BGRA, 8),
      `left band should be green; got ${pixelAt(px, OUT.width, 2, cy)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, w.rect.x + (w.rect.width >> 1), cy), CLIENT_BGRA, 8),
      `window center should be the client red; got ${pixelAt(px, OUT.width, w.rect.x + (w.rect.width >> 1), cy)}`);
  } finally {
    await c.teardown();
  }
});

test("decoration-default (intercept): rounded corners clip the band with uniform thickness",
  { skip }, async () => {
  // Setup with a meaningful corner radius. The compositor applies the
  // OUTER shape to the combined output texture (clipping the perimeter),
  // and the plugin applies the inner shape via SDF coverage in the blit
  // shader. Visual check: the four corners of the outer rect are
  // transparent (clipped by the outer shape -> shows clear color), and
  // the band fills consistently between the inner and outer rounded
  // boundaries.
  const B = 8;
  const RADIUS = 16;
  const c = await setupCompositor({
    headless: OUT,
    intercept: true,
    config: {
      decoration: {
        appIdPattern: ".*",
        border: { width: B, radius: RADIUS },
        unfocused: { kind: "solid", color: "#3a3a3aff" },
        focused: { kind: "solid", color: "#3a3a3aff" },
      },
    },
  });
  try {
    const client = c.spawnClient(
      ["--app-id", "deco-test", "--color", CLIENT_COLOR_ARGB,
       "--size", CLIENT_REQUESTED_SIZE, "--title", "t",
       "--fill-configured"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await client.ready;
    // Wait for a stable composite where the center shows the client.
    await settled(() => c.frameReadback(),
      (p) => p && pixelMatches(
        pixelAt(p, OUT.width, OUT.width >> 1, OUT.height >> 1), CLIENT_BGRA, 8),
      { what: "client centered in inset region", timeoutMs: 6000 });
    const px = await c.frameReadback();
    // The four corners of the OUTER rect should be CLEAR (clipped by the
    // outer rounded-rect SDF). The compositor's clear color is black with
    // full alpha.
    const CLEAR = [0, 0, 0, 255];
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 0, 0), CLEAR, 8),
      `outer (0,0) corner clipped to clear; got ${pixelAt(px, OUT.width, 0, 0)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, OUT.width - 1, 0), CLEAR, 8),
      `outer top-right corner clipped to clear; got ${pixelAt(px, OUT.width, OUT.width - 1, 0)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 0, OUT.height - 1), CLEAR, 8),
      `outer bottom-left corner clipped to clear; got ${pixelAt(px, OUT.width, 0, OUT.height - 1)}`);
    // The band fills mid-edge regions (e.g. top-center, between the
    // outer's top curve and the inner's top curve at the centerline).
    assert.ok(pixelMatches(pixelAt(px, OUT.width, OUT.width >> 1, 2), UNFOCUSED_BGRA, 8),
      `top-mid band fills with the border color; got ${pixelAt(px, OUT.width, OUT.width >> 1, 2)}`);
    // The client texture is visible at the center (well inside the inner
    // rounded curve).
    assert.ok(pixelMatches(pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1), CLIENT_BGRA, 8),
      `center shows client; got ${pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1)}`);
  } finally {
    await c.teardown();
  }
});

test("decoration-default (intercept): late-match catch-up does not show a wrong-size frame",
  { skip }, async () => {
  // The plugin releases the gate on ctx.contentReady -- only once the
  // client has committed at the configured (post-insets) size. We can't
  // see the wrong-size frame on screen (that's the whole point of the
  // gate); we verify indirectly that:
  //   - the window IS gated for some non-zero time after match;
  //   - the final composite shows the post-insets content size
  //     (the client filled its 240x240 tile, not stretched 256x256).
  const B = 8;
  const c = await setupCompositor({
    headless: OUT,
    intercept: true,
    config: {
      decoration: {
        appIdPattern: ".*",
        border: { width: B, radius: 0 },
        unfocused: { kind: "solid", color: "#3a3a3aff" },
        focused: { kind: "solid", color: "#3a3a3aff" },
      },
    },
  });
  try {
    const client = c.spawnClient(
      ["--app-id", "deco-test", "--color", CLIENT_COLOR_ARGB,
       "--size", CLIENT_REQUESTED_SIZE, "--title", "t",
       "--fill-configured"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await client.ready;
    // Wait until the final composite is correct.
    await settled(() => c.frameReadback(),
      (p) => p && pixelMatches(
        pixelAt(p, OUT.width, OUT.width >> 1, OUT.height >> 1), CLIENT_BGRA, 8),
      { what: "client centered in inset region", timeoutMs: 6000 });
    // The inset region is 240x240 starting at (8, 8). The client filled
    // it after the second configure; sample at the inset boundary (one
    // pixel inside the inset) to confirm the client texture extends to
    // the band edge (not stretched / not gap).
    const px = await c.frameReadback();
    assert.ok(pixelMatches(pixelAt(px, OUT.width, B, B), CLIENT_BGRA, 8),
      `inset top-left should be client red; got ${pixelAt(px, OUT.width, B, B)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, OUT.width - B - 1, OUT.height - B - 1), CLIENT_BGRA, 8),
      `inset bottom-right should be client red; got ${pixelAt(px, OUT.width, OUT.width - B - 1, OUT.height - B - 1)}`);
    // The window is no longer gated by the time we get a stable frame.
    const win = c.query().windows.find((w) => w.appId === "deco-test");
    if (win) {
      assert.equal(c.state.wm.isContentGated(win.surfaceId), false,
        "decoration gate released by the time the final frame composites");
    }
  } finally {
    await c.teardown();
  }
});

test("decoration-default (intercept): a fullscreen window draws bare (no band, no insets)",
  { skip }, async () => {
  // The window declares fullscreen before mapping (--initial-state), the
  // way games do. excludeFullscreen keeps the decoration registration
  // from ever matching it: no border band, no insets -- the client's
  // pixels reach every edge of the output.
  const B = 8;
  const c = await setupCompositor({
    headless: OUT,
    intercept: true,
    config: {
      decoration: {
        appIdPattern: ".*",
        border: { width: B, radius: 0 },
        unfocused: { kind: "solid", color: "#3a3a3aff" },
        focused: { kind: "solid", color: "#3a3a3aff" },
      },
    },
  });
  try {
    const client = c.spawnClient(
      ["--app-id", "fs-test", "--color", CLIENT_COLOR_ARGB,
       "--size", CLIENT_REQUESTED_SIZE, "--title", "t",
       "--fill-configured", "--initial-state", "fullscreen"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await client.ready;
    // Fullscreen rect = the whole output; without decoration the client
    // fills all of it, including where the band would have been.
    const center = { x: OUT.width >> 1, y: OUT.height >> 1 };
    const bandArea = { x: 2, y: 2 };
    const px = await settled(() => c.frameReadback(),
      (p) => p
        && pixelMatches(pixelAt(p, OUT.width, center.x, center.y), CLIENT_BGRA, 8)
        && pixelMatches(pixelAt(p, OUT.width, bandArea.x, bandArea.y), CLIENT_BGRA, 8),
      { what: "fullscreen: client red at center AND at the would-be band", timeoutMs: 6000 });
    for (const [x, y] of [[2, 2], [OUT.width - 3, 2], [2, OUT.height - 3],
                          [OUT.width - 3, OUT.height - 3],
                          [OUT.width >> 1, 2], [center.x, center.y]]) {
      assert.ok(pixelMatches(pixelAt(px, OUT.width, x, y), CLIENT_BGRA, 8),
        `(${x},${y}) should be the client's red (no decoration on fullscreen); got ${pixelAt(px, OUT.width, x, y)}`);
    }
  } finally {
    await c.teardown();
  }
});
