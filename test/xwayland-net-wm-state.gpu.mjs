// Post-map EWMH fullscreen: a MAPPED X window requests fullscreen with a
// _NET_WM_STATE ClientMessage to the root (action ADD/REMOVE), not by
// rewriting the property -- the property is only read at manage time. The
// xwm must apply the requested state change, republish _NET_WM_STATE, and
// re-propose so the WM fullscreens (and un-fullscreens) the window. This is
// the path every windowed game takes when its fullscreen toggle is hit
// after launch.
//
// Scenario: a wayland peer maps first (so the tiled rect differs from the
// output rect), then an X client maps WINDOWED, requests fullscreen via
// ClientMessage after 1.5s, and requests un-fullscreen at 6s. The window's
// WM rect must become the full output, then leave it again.
//
// Needs the GPU, Xwayland, and the built x11-test-client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
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

const skip = !canRunGpu()
  ? "no GPU/dawn.node"
  : !haveXwayland()
    ? "Xwayland not installed"
    : !existsSync(X11_CLIENT)
      ? "x11-test-client not built"
      : false;

test("xwm: post-map _NET_WM_STATE ClientMessage fullscreens and restores",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      // Peer tile: with two windows the tiled lane splits the output, so a
      // windowed/restored rect can never equal the 1280x720 output rect.
      const peer = c.spawnClient(
        ["--title", "peer", "--app-id", "peer", "--color", "FF00FF00", "--size", "400x300"]);
      await peer.ready;
      await waitFor(c.query, (s) => s.windows.length >= 1 && s.windows[0].mapped,
        { timeoutMs: 8000, what: "peer mapped" });

      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);
      child = execFile(X11_CLIENT,
        ["--title", "windowed-game", "--app-id", "windowed.game",
         "--fill", "ff0000",
         "--fullscreen-after-ms", "1500",
         "--unfullscreen-after-ms", "6000",
         "--timeout-ms", "30000"],
        { env: { ...process.env, DISPLAY: handle.display } });

      const xwin = (s) => s.windows.find((w) => w.role === "xwayland");
      const isFull = (w) => w !== undefined
        && w.rect.width === 1280 && w.rect.height === 720;

      // Maps windowed: managed with a non-output-sized tile first.
      await waitFor(c.query, (s) => {
        const w = xwin(s);
        return w !== undefined && w.mapped && w.rect.width > 0 && !isFull(w);
      }, { timeoutMs: 8000, what: "x window mapped windowed" });

      // ClientMessage ADD -> the WM fullscreens it to the whole output.
      await waitFor(c.query, (s) => isFull(xwin(s)),
        { timeoutMs: 8000, what: "x window fullscreened post-map" });

      // ClientMessage REMOVE -> back to a tiled (non-output-sized) rect.
      await waitFor(c.query, (s) => {
        const w = xwin(s);
        return w !== undefined && w.rect.width > 0 && !isFull(w);
      }, { timeoutMs: 10000, what: "x window restored from fullscreen" });
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
