// End-to-end damage propagation for X11 windows. Xwayland forwards each X
// window's changed region as wl_surface.damage_buffer rects on a re-attach
// commit of the window pixmap's dmabuf; the compositor must repaint exactly
// those regions on the composited output. Covers three configurations:
//
//   1. single partial fill on a bare (undecorated) window;
//   2. a rapid burst of small fills (pipelined commits + Xwayland window-
//      buffer cycling) -- every region must survive, none dropped;
//   3. a partial fill through the decoration intercept (client content is
//      composited with the border into an intercept texture; the update must
//      re-render that AND damage the on-screen region).
//
// Needs the GPU, Xwayland, and the built x11-test-client (--fill /
// --stdin-fills modes).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompositor, canRunGpu, waitFor, nextXDisplay } from "./harness.mjs";
import { startXwayland } from "../packages/core/dist/xwayland/index.js";
import { startXwm } from "../packages/core/dist/xwayland/xwm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const X11_CLIENT = join(__dirname, "..", "packages", "core", "build", "x11-test-client");

function haveXwayland() {
  return (process.env.PATH ?? "").split(":").some((p) => p && existsSync(`${p}/Xwayland`));
}
const skip = !canRunGpu() ? "no GPU/dawn.node"
  : !haveXwayland() ? "Xwayland not installed"
    : !existsSync(X11_CLIENT) ? "x11-test-client not built" : false;

const W = 1280, H = 720;
const px = (d, x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
const isRed = (p) => p[2] > 200 && p[1] < 60 && p[0] < 60;
const isGreen = (p) => p[1] > 200 && p[2] < 60 && p[0] < 60;

// Bring up Xwayland + XWM on the given compositor, spawn the fill client
// (red base, stdin-driven partial fills), and wait for it to be mapped.
async function startFillClient(c, title) {
  const handle = await startXwayland(c.addon, {
    waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
  });
  const xwm = startXwm(c.state, c.addon, handle.wmFd);
  const child = spawn(X11_CLIENT,
    ["--title", title, "--fill", "ff0000", "--stdin-fills", "--timeout-ms", "60000"],
    { stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, DISPLAY: handle.display } });
  const rig = { handle, xwm, child, stdout: "" };
  child.stdout.on("data", (d) => { rig.stdout += d.toString(); });
  await waitFor(c.query, (s) => s.windows.some((w) => w.role === "xwayland"),
    { timeoutMs: 8000, what: "xwayland window mapped" });
  return rig;
}

async function stopFillClient(c, rig) {
  try { rig?.child?.kill("SIGKILL"); } catch { /* gone */ }
  try { rig?.xwm?.stop(); } catch { /* gone */ }
  try { if (rig?.handle) c.addon.xwaylandStop(rig.handle.pid); } catch { /* gone */ }
}

// Poll the composited output until pred(data) holds.
async function readUntil(c, pred, what, ms = 15000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await c.frameReadback();
    if (last && pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout: ${what}; probe center=${last ? JSON.stringify(px(last, 640, 360)) : "no readback"}`);
}

// Send one fill command and wait for the client's ack.
async function fill(rig, x, y, w, h, color) {
  rig.child.stdin.write(`fill ${x} ${y} ${w} ${h} ${color}\n`);
  const marker = `[x11] filled ${x} ${y}`;
  const t0 = Date.now();
  while (!rig.stdout.includes(marker) && Date.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(rig.stdout.includes(marker), `no fill ack for ${x},${y}; stdout:\n${rig.stdout}`);
}

test("x11 partial fill reaches the composited output", { skip, timeout: 60000 }, async () => {
  const c = await setupCompositor();
  let rig;
  try {
    rig = await startFillClient(c, "damage-basic");
    await readUntil(c, (d) => isRed(px(d, 640, 360)), "red base on screen");

    // The window tiles to the full output at (0,0): window-local == output.
    await fill(rig, 100, 100, 200, 150, "00ff00");
    const data = await readUntil(c, (d) => isGreen(px(d, 150, 150)),
      "green sub-rect composited");
    assert.ok(isRed(px(data, 640, 360)),
      `outside-region pixel changed: ${px(data, 640, 360)}`);
  } finally {
    await stopFillClient(c, rig);
    await c.teardown();
  }
});

test("burst of x11 partial fills: no region lost", { skip, timeout: 90000 }, async () => {
  const c = await setupCompositor();
  let rig;
  try {
    rig = await startFillClient(c, "damage-burst");
    await readUntil(c, (d) => isRed(px(d, 640, 360)), "red base on screen");

    // 40 squares in a 10x4 grid, sent in rapid batches so Xwayland pipelines
    // commits (and cycles its window buffers under load).
    const squares = [];
    for (let i = 0; i < 40; i++) {
      squares.push({ x: 40 + (i % 10) * 60, y: 40 + Math.floor(i / 10) * 60 });
    }
    for (let i = 0; i < squares.length; i += 4) {
      const batch = squares.slice(i, i + 4)
        .map((s) => `fill ${s.x} ${s.y} 30 30 00ff00\n`).join("");
      rig.child.stdin.write(batch);
      await new Promise((r) => setTimeout(r, 8));
    }
    const t0 = Date.now();
    const ackCount = () => (rig.stdout.match(/\[x11\] filled \d/g) ?? []).length;
    while (ackCount() < squares.length && Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(ackCount(), squares.length,
      `client acked ${ackCount()}/${squares.length} fills`);

    // Let the pipeline drain, then every square must be on screen.
    const data = await readUntil(c,
      (d) => squares.every((s) => isGreen(px(d, s.x + 15, s.y + 15))),
      "all 40 squares composited", 10000);
    assert.ok(isRed(px(data, 640, 400)), "background stayed red");
  } finally {
    await stopFillClient(c, rig);
    await c.teardown();
  }
});

test("x11 partial fill through the decoration intercept", { skip, timeout: 90000 }, async () => {
  const B = 8;
  const c = await setupCompositor({
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
  let rig;
  try {
    rig = await startFillClient(c, "damage-deco");
    // Red client content inside the border insets.
    await readUntil(c, (d) => isRed(px(d, 640, 360)), "red client content on screen");

    // Window-local (100,100) lands at output (B+100, B+100): the content
    // rect of a full-output tile is inset by the border width.
    await fill(rig, 100, 100, 200, 150, "00ff00");
    const data = await readUntil(c, (d) => isGreen(px(d, B + 150, B + 150)),
      "green sub-rect through the intercept");
    assert.ok(isRed(px(data, 640, 360)),
      `outside-region pixel changed: ${px(data, 640, 360)}`);
  } finally {
    await stopFillClient(c, rig);
    await c.teardown();
  }
});
