// Mirror windows (headless pixel tests): a compositor-owned window showing a
// live copy of a client window's draw list, placed by the WM like any other.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setupCompositor, canRunGpu, buildBin, pixelAt, pixelMatches,
  pointerMotion, pointerButton,
} from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 800, height: 600 };
const FILL = "--fill-configured";
const BTN_LEFT = 0x110;

function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff, g = (argb >>> 8) & 0xff, b = argb & 0xff,
        a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}
const center = (r) => ({ x: r.x + (r.width >> 1), y: r.y + (r.height >> 1) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readUntil(c, pt, bgra, tries = 60) {
  let px = null;
  for (let i = 0; i < tries; i++) {
    px = await c.frameReadback();
    if (px && pixelMatches(pixelAt(px, OUT.width, pt.x, pt.y), bgra, 4)) return { px, ok: true };
    await sleep(16);
  }
  return { px, ok: false };
}

// Spawn a fill client, wait for its tile to show `color`, and return its
// WM snapshot.
async function spawnFilled(c, color, extra = []) {
  const cl = c.spawnClient([FILL, "--color", color.toString(16), ...extra], { stdin: true });
  await cl.ready;
  const before = new Set(c.query().windows.map((w) => w.surfaceId));
  let win = null;
  for (let i = 0; i < 60 && !win; i++) {
    win = c.query().windows.find((w) => !before.has(w.surfaceId) || c.query().windows.length === 1) ?? null;
    if (!win) await sleep(16);
  }
  assert.ok(win, "client window mapped");
  const r = await readUntil(c, center(win.rect), argbToBgra(color));
  assert.ok(r.ok, `window ${win.surfaceId} shows ${color.toString(16)}`);
  return { cl, id: win.surfaceId };
}

async function settle(c) {
  await c.state.wm.settled();
  await sleep(50);
}

const rectOf = (c, id) => c.state.wm.getSnapshot(id)?.rect ?? null;

// A mirror belongs to whichever island its creator puts it in; the bundled
// workspace plugin never adopts one. Stand in for the creator: publish the
// output's stack with the mirror after its source.
async function placeMirror(c, src, mirrorId) {
  c.windowsBroker("test", "windows.set-output-stack", { outputId: 0, ids: [src, mirrorId] });
  await settle(c);
  // The source's resize transaction holds its old full-width rect (and the
  // deferred stack flush) until the client re-renders at the new tile size
  // or the transaction deadline passes. Wait for the two tiles to be final
  // and disjoint, and for the mirror to reach the draw list, so no pixel
  // check below can land on the source by accident.
  const disjoint = (a, b) => a.x + a.width <= b.x || b.x + b.width <= a.x
    || a.y + a.height <= b.y || b.y + b.height <= a.y;
  for (let i = 0; i < 120; i++) {
    const s = rectOf(c, src), m = rectOf(c, mirrorId);
    const drawn = c.jsCompositor.introspect().outputs
      .some((o) => o.drawList.some((e) => e.id === mirrorId));
    if (s && m && s.width === 400 && m.width === 400 && disjoint(s, m) && drawn) return;
    await sleep(16);
  }
  throw new Error(`mirror never placed beside its source: src=${JSON.stringify(rectOf(c, src))} mirror=${JSON.stringify(rectOf(c, mirrorId))}`);
}

test("a mirror shows its source, follows content changes, and reports mirrorOf", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const blue = 0xff2040c0, green = 0xff20c040;
    const { cl, id: src } = await spawnFilled(c, blue);

    const mirrorId = c.state.mirrorDriver.create(src);
    assert.ok(typeof mirrorId === "number" && mirrorId > 0, "mirror minted");
    await placeMirror(c, src, mirrorId);

    const snap = c.state.wm.getSnapshot(mirrorId);
    assert.ok(snap, "mirror is a WM window");
    assert.equal(snap.mirrorOf, src);
    assert.ok(snap.rect.width > 0 && snap.rect.height > 0, "mirror was laid out");
    const srcRect = rectOf(c, src);
    assert.ok(srcRect.x !== snap.rect.x || srcRect.y !== snap.rect.y,
      "source and mirror occupy different tiles");
    assert.ok(!c.state.wm.focusOrder().includes(mirrorId), "mirror is not a focus candidate");

    // The mirror's tile shows the source's pixels.
    const m = center(snap.rect);
    const first = await readUntil(c, m, argbToBgra(blue));
    assert.ok(first.ok, `mirror shows the source color; got ${pixelAt(first.px, OUT.width, m.x, m.y)}`);

    // Source content change -> mirror follows. The source's own damage is
    // its rect; without propagation the mirror's rect stays outside every
    // repaint scissor and keeps the old pixels.
    cl.send(`recolor ${green.toString(16)}`);
    const srcNow = await readUntil(c, center(rectOf(c, src)), argbToBgra(green));
    assert.ok(srcNow.ok, "source recolored on screen");
    const mNow = await readUntil(c, center(rectOf(c, mirrorId)), argbToBgra(green));
    assert.ok(mNow.ok,
      `mirror follows the recolor; got ${pixelAt(mNow.px, OUT.width, m.x, m.y)}`);

    // The introspection labels the entry.
    const intro = c.jsCompositor.introspect();
    const entries = intro.outputs.flatMap((o) => o.drawList);
    const entry = entries.find((e) => e.id === mirrorId);
    assert.ok(entry && entry.kind === "mirror",
      `draw list carries the mirror entry; got ${JSON.stringify(entries.map((e) => [e.id, e.kind]))}`);

    // Source unmap retires the mirror.
    cl.child.kill("SIGTERM");
    let gone = false;
    for (let i = 0; i < 100 && !gone; i++) {
      gone = c.query().windows.length === 0 && c.jsCompositor.mirrorGeometry(mirrorId) === null;
      if (!gone) await sleep(16);
    }
    assert.ok(gone, "mirror destroyed with its source");
  } finally {
    await c.teardown();
  }
});

test("a mirror's copy includes the source's popup and keeps the rest transparent", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const pColor = 0xff0000ff, uColor = 0xff00ff00;
    const PW = 200, PH = 150, UW = 60, UH = 40;
    // Anchor rect (350,120,20,20), bottom_left anchor, bottom_right gravity:
    // popup top-left at parent + (350,140). The parent is configured to a
    // tile the compositor stretches its buffer over; once the mirror joins
    // the layout the parent's tile is 400 wide, so the 60px popup hangs
    // 10px past the tile's right edge.
    const cl = c.spawnClient(
      ["--parent", `${PW}x${PH}`, "--popup", `${UW}x${UH}`, "--anchor-rect", "350,120,20,20",
       "--parent-color", pColor.toString(16), "--popup-color", uColor.toString(16)],
      { bin: buildBin("popup-test-client"),
        readyMarker: "[popup-client] popup configured" });
    await cl.ready;
    const snap0 = await c.waitFor(c.query, (s) => s.windows.length >= 1, { what: "parent window" });
    const src = snap0.windows[0].surfaceId;
    const mirrorId = c.state.mirrorDriver.create(src);
    assert.ok(mirrorId > 0);
    await placeMirror(c, src, mirrorId);
    const p = rectOf(c, src);
    const mr = rectOf(c, mirrorId);
    assert.ok(p.x < mr.x && p.width === 400, `source is the 400px master tile; got ${JSON.stringify(p)}`);
    const popupPt = { x: p.x + 350 + (UW >> 1), y: p.y + 140 + (UH >> 1) };
    const onScreen = await readUntil(c, popupPt, argbToBgra(uColor));
    assert.ok(onScreen.ok, "popup composites on screen");

    const geo = c.jsCompositor.mirrorGeometry(mirrorId);
    assert.ok(geo && geo.slot && geo.rect, "mirror placed");
    // The region spans the parent's tile plus the popup hanging off it.
    assert.equal(geo.region.x + geo.region.w, p.x + 350 + UW, "region reaches the popup's right edge");
    assert.ok(geo.rect.w > geo.slot.w, "mirror surface extends past its slot by the hang");
    const tex = c.jsCompositor.mirrorTexture(mirrorId);
    assert.ok(tex, "mirror texture exists");
    const px = (await c.jsCompositor.readbackTexture(tex.texture, tex.outW, tex.outH)).data;
    // Popup pixel, in region-local coordinates.
    const lx = popupPt.x - geo.region.x, ly = popupPt.y - geo.region.y;
    assert.ok(pixelMatches(pixelAt(px, tex.outW, lx, ly), argbToBgra(uColor), 4),
      `mirror texture shows the popup; got ${pixelAt(px, tex.outW, lx, ly)}`);
    // Parent pixel beside the popup.
    const bx = p.x + PW - 5 - geo.region.x, by = p.y + 5 - geo.region.y;
    assert.ok(pixelMatches(pixelAt(px, tex.outW, bx, by), argbToBgra(pColor), 4),
      `mirror texture shows the parent; got ${pixelAt(px, tex.outW, bx, by)}`);
    // Below the popup, past the tile's right edge, nothing draws: the
    // uncovered part of the region stays transparent.
    const tx = geo.region.w - 2, ty = geo.region.h - 2;
    const t = pixelAt(px, tex.outW, tx, ty);
    assert.equal(t[3], 0, `uncovered region is transparent; got ${t}`);

    // On screen: the mirror's tile shows the popup at the same offset from
    // the mirror's slot as the popup has from the parent's tile (scaled).
    const sx = geo.slot.w / geo.anchor.w, sy = geo.slot.h / geo.anchor.h;
    const mpt = {
      x: Math.round(geo.slot.x + (popupPt.x - geo.anchor.x) * sx),
      y: Math.round(geo.slot.y + (popupPt.y - geo.anchor.y) * sy),
    };
    const onMirror = await readUntil(c, mpt, argbToBgra(uColor));
    assert.ok(onMirror.ok,
      `mirror shows the popup on screen at ${mpt.x},${mpt.y}; got ${pixelAt(onMirror.px, OUT.width, mpt.x, mpt.y)}`);
  } finally {
    await c.teardown();
  }
});

test("a press on a mirror emits pointer.pressed with the mirror id and no client focus", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const { id: src } = await spawnFilled(c, 0xffc02020);
    const mirrorId = c.state.mirrorDriver.create(src);
    await placeMirror(c, src, mirrorId);
    const mr = rectOf(c, mirrorId);
    const pressed = [];
    c.state.bus.on("pointer.pressed", (ev) => pressed.push(ev.surfaceId));

    const m = center(mr);
    pointerMotion(c.addon, m.x, m.y);
    await sleep(30);
    assert.equal(c.state.seat.focus?.surfaceId ?? null, null,
      `no client pointer focus over a mirror; mirror rect ${JSON.stringify(mr)} src ${JSON.stringify(rectOf(c, src))} pointer ${m.x},${m.y}`);
    pointerButton(c.addon, BTN_LEFT, true);
    pointerButton(c.addon, BTN_LEFT, false);
    await sleep(30);
    assert.deepEqual(pressed, [mirrorId], "press over the mirror reported with its id");

    // A press on the source still targets the source.
    const s = center(rectOf(c, src));
    pointerMotion(c.addon, s.x, s.y);
    await sleep(30);
    pointerButton(c.addon, BTN_LEFT, true);
    pointerButton(c.addon, BTN_LEFT, false);
    await sleep(30);
    assert.deepEqual(pressed, [mirrorId, src]);
  } finally {
    await c.teardown();
  }
});
