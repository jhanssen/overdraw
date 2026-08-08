// The freeze snapshot (surface-transaction holds: WM resize tx,
// layer-shell size holds) must preserve a translucent surface's own
// alpha. The bake renders the surface alone into a pooled texture; over
// premultiplied blending, surface-over-TRANSPARENT is exactly the
// surface's premultiplied rgba, so the frozen draw blends over whatever
// sits beneath identically to the live surface. Baked over OPAQUE black
// instead, translucent pixels arrive pre-blended with black at alpha 1 --
// the hold draws darker and non-translucent, a per-resize-step dark
// flash on clients that animate their size (quickshell panels).
//
// Repro: an opaque green tile with a half-alpha red dmabuf window
// floated over it. Live blend = half red over green. Freezing the
// translucent window must not change the readback; an over-black bake
// zeroes the green contribution under the window (decisive discriminator).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { setupCompositor, canRunGpu, loadDawn, buildBin, pixelAt, pixelMatches } from "./harness.mjs";

const skip = !canRunGpu() ? "needs GPU (no render node / dawn.node)"
  : (!loadDawn() ? "dawn.node not built" : false);
const OUT = { width: 640, height: 480 };
// Premultiplied half-alpha red over opaque green:
// out.rgb = (0.5, 0, 0) + (0, 1, 0) * 0.5 = (0.5, 0.5, 0) -> BGRA.
const BLEND_BGRA = [0, 128, 128, 255];

async function readUntil(c, pred, tries = 60) {
  let px = null;
  for (let i = 0; i < tries; i++) {
    px = await c.frameReadback();
    if (px && pred(px)) return px;
    await new Promise((r) => setTimeout(r, 16));
  }
  return px;
}

test("freeze snapshot preserves translucent alpha", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, jsCompositor: true });
  let client = null;
  try {
    const green = c.spawnClient(["--fill-configured", "--color", "00FF00"]);
    await green.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "green window" });

    client = spawn(buildBin("dmabuf-test-client"),
      [c.sock, "--pixel", "80800000", "--hold-ms", "30000", "--app-id", "translucent"],
      { stdio: ["ignore", "pipe", "pipe"] });
    const snap = await c.waitFor(c.query,
      (s) => s.windows.length === 2 && s.windows.every((w) => w.rect.width > 0),
      { what: "both windows tiled", timeoutMs: 4000 });
    const t = snap.windows.find((w) => w.appId === "translucent");
    assert.ok(t, "translucent dmabuf window mapped");

    // Float the translucent window; the green window re-tiles to fill the
    // output beneath it.
    await c.state.wm.propose(t.surfaceId, { tiling: "floating" }, "user-input");
    c.state.wm.setFloatingRect(t.surfaceId,
      { x: 100, y: 100, width: 64, height: 64 });

    const cx = 132, cy = 132;  // center of the floated 64x64 window
    let px = await readUntil(c,
      (p) => pixelMatches(pixelAt(p, OUT.width, cx, cy), BLEND_BGRA, 8));
    assert.ok(pixelMatches(pixelAt(px, OUT.width, cx, cy), BLEND_BGRA, 8),
      `live blend of half-red over green; got ${pixelAt(px, OUT.width, cx, cy)}`);

    // Freeze, then MOVE the frozen window: frozen pixels appearing at the
    // new position prove the sampled frame was rendered post-freeze (a
    // poll for the expected value at the old position would match a
    // stale pre-freeze frame and assert nothing).
    c.state.compositor.freezeSurface(t.surfaceId);
    assert.ok(c.state.compositor.surfaces.get(t.surfaceId)?.frozen,
      "surface actually froze (guard against a vacuous pass)");
    c.state.wm.setFloatingRect(t.surfaceId,
      { x: 240, y: 100, width: 64, height: 64 });
    const fx = 272, fy = 132;  // center of the moved window; green pre-move
    const GREEN_BGRA = [0, 255, 0, 255];
    px = await readUntil(c,
      (p) => !pixelMatches(pixelAt(p, OUT.width, fx, fy), GREEN_BGRA, 8));
    const frozenSample = pixelAt(px, OUT.width, fx, fy);
    assert.ok(pixelMatches(frozenSample, BLEND_BGRA, 8),
      `frozen blend must match live blend; got ${frozenSample} `
      + `(dark red = the snapshot baked over opaque black)`);

    c.state.compositor.thawSurface(t.surfaceId);
  } finally {
    if (client && client.exitCode === null && client.signalCode === null) {
      try { client.kill("SIGTERM"); } catch { /* gone */ }
      await once(client, "exit").catch(() => {});
    }
    await c.teardown();
  }
});
