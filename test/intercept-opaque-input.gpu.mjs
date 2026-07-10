// Opaque (X-alpha) buffer formats through the intercept path. An XR24
// dmabuf's alpha byte is undefined -- X11 clients through Xwayland (glamor
// window pixmaps) routinely leave garbage there. The compositor's raw draw
// path forces alpha=1 for opaque formats at the shader level, but an
// intercepted surface samples through the plugin instead, so the flag must
// travel as InterceptInput.opaque and the plugin's blit must apply it --
// otherwise the client content blends away and the decoration band /
// backdrop shows through (transparent window bodies under X11 apps).
//
// Both tests commit an XR24 dmabuf whose X byte is 0 (--pixel 00FF0000 =
// red with a zeroed X byte): raw path must show red (control), and the
// decorated path must show red too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setupCompositor, canRunGpu, loadDawn, buildBin } from "./harness.mjs";

const skip = !canRunGpu() ? "needs GPU (no render node / dawn.node)"
  : (!loadDawn() ? "dawn.node not built" : false);

const W = 512, H = 512;
const px = (d, x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
const isRed = (p) => p[2] > 200 && p[1] < 60 && p[0] < 60;

async function readUntil(c, pred, what, ms = 10000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await c.frameReadback();
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout: ${what}; center=${last ? JSON.stringify(px(last, 256, 256)) : "-"}`);
}

function spawnXr24(c) {
  // --fit-configure sizes the buffer from the WM's tile so the decoration's
  // content gate (which waits for a size-correct commit) releases.
  return spawn(buildBin("dmabuf-test-client"),
    [c.sock, "--format", "xrgb", "--pixel", "00FF0000",
     "--hold-ms", "20000", "--fit-configure"],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env } });
}

test("XR24 dmabuf with zeroed X byte: raw path shows opaque content", { skip, timeout: 60000 }, async () => {
  const c = await setupCompositor({ headless: { width: W, height: H } });
  let client;
  try {
    client = spawnXr24(c);
    await readUntil(c, (d) => isRed(px(d, 256, 256)), "raw XR24 shows red");
  } finally {
    try { client?.kill("SIGKILL"); } catch { /* gone */ }
    await c.teardown();
  }
});

test("XR24 dmabuf with zeroed X byte: decorated (intercept) path shows opaque content", { skip, timeout: 60000 }, async () => {
  const c = await setupCompositor({
    headless: { width: W, height: H },
    intercept: true,
    config: {
      decoration: {
        appIdPattern: ".*",
        border: { width: 2, radius: 10 },
        focused: {
          kind: "linear-gradient", angle: 45,
          stops: [{ color: "#33ccffee" }, { color: "#00ff99ee" }],
        },
        unfocused: { kind: "solid", color: "#595959aa" },
      },
    },
  });
  let client;
  try {
    client = spawnXr24(c);
    const t0 = Date.now();
    let win = null;
    while (!win && Date.now() - t0 < 8000) {
      win = (await c.query()).windows[0];
      if (!win) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(win, "window mapped");
    // A probe just inside the band's inner edge, mid-height (away from the
    // rounded corners). This sits in the blit's band-underlay rim, where a
    // garbage alpha of 0 mixes the border gradient into the content -- the
    // pixel only reads pure red when the opaque flag forces alpha=1.
    const ex = win.rect.x + 6, ey = win.rect.y + (win.rect.height >> 1);
    const data = await readUntil(c, (d) => isRed(px(d, 256, 256)),
      "decorated XR24 shows red at tile center");
    assert.ok(isRed(px(data, ex, ey)),
      `inner-edge content at (${ex},${ey}): ${px(data, ex, ey)}`);
  } finally {
    try { client?.kill("SIGKILL"); } catch { /* gone */ }
    await c.teardown();
  }
});
