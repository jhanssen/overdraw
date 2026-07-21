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

test("xwm: fullscreen survives focus churn (stale property-reply race)",
  { skip, timeout: 30000 }, async () => {
    // Focus changes write _NET_WM_STATE (the FOCUSED mirror), each write's
    // PropertyNotify triggers an async re-read, and a reply serviced before
    // the client's fullscreen ClientMessage must not roll the state back
    // when it lands after it. Churn keyboard focus around the fullscreen
    // transition to keep reads in flight, then assert the window STAYS
    // fullscreen. (Timing-dependent as a tripwire; the deterministic
    // coverage is xwayland-net-wm-state-race.test.js -- this exercises the
    // real X server + event pipeline.)
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      const peer = c.spawnClient(
        ["--title", "peer", "--app-id", "peer", "--color", "FF00FF00", "--size", "400x300"]);
      await peer.ready;
      await waitFor(c.query, (s) => s.windows.length >= 1 && s.windows[0].mapped,
        { timeoutMs: 8000, what: "peer mapped" });
      const peerId = c.query().windows[0].surfaceId;

      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);
      child = execFile(X11_CLIENT,
        ["--title", "churn-game", "--app-id", "churn.game",
         "--fill", "ff0000",
         "--fullscreen-after-ms", "1200",
         "--timeout-ms", "30000"],
        { env: { ...process.env, DISPLAY: handle.display } });

      const xwin = (s) => s.windows.find((w) => w.role === "xwayland");
      const isFull = (w) => w !== undefined
        && w.rect.width === 1280 && w.rect.height === 720;

      await waitFor(c.query, (s) => {
        const w = xwin(s);
        return w !== undefined && w.mapped && w.rect.width > 0;
      }, { timeoutMs: 8000, what: "x window mapped" });
      const xId = xwin(c.query()).surfaceId;

      // Churn focus between the peer and the X window every ~25ms so
      // FOCUSED writes + re-reads are in flight when the ClientMessage
      // lands, and keep churning after.
      let churn = true;
      const churner = (async () => {
        let flip = false;
        while (churn) {
          c.state.seat?.applyKeyboardFocus(flip ? peerId : xId);
          flip = !flip;
          await new Promise((r) => setTimeout(r, 25));
        }
      })();

      await waitFor(c.query, (s) => isFull(xwin(s)),
        { timeoutMs: 8000, what: "x window fullscreened under focus churn" });

      // Stability: the window must remain fullscreen for a full second of
      // continued churn. Any revert (the pre-guard flap) trips this.
      const t0 = Date.now();
      while (Date.now() - t0 < 1000) {
        assert.ok(isFull(xwin(c.query())),
          "window left fullscreen during focus churn (state rolled back)");
        await new Promise((r) => setTimeout(r, 40));
      }
      churn = false;
      await churner;
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("xwm: pre-map fullscreen survives a slow preconfigure round-trip (no flap)",
  { skip, timeout: 40000 }, async () => {
    // Two once-real regressions, both landing as a fullscreen "flap":
    //   - markInitialCommitComplete committing its stale pre-round-trip
    //     snapshot over the synchronously-stamped fullscreen (reason
    //     window-rule);
    //   - sendStructuralProposals claiming wantsFullscreen:false from
    //     property replies that landed BEFORE _NET_WM_STATE was read, those
    //     stale snapshots committing behind the serialized propose queue.
    // Either revert briefly tiles the game; a geometry-syncing client
    // (Wine/SDL) then drops fullscreen for real. The slow preconfigure
    // interceptor mirrors production subscribers that await broker
    // round-trips and makes the timing window deterministic.
    const c = await setupCompositor({
      config: {
        canvas: { world: true, elastic: true, arrangement: "grid", gutter: 24 },
        layout: { mode: "columns", column: 0.5, masterFraction: 0.5, gap: 10 },
        focus: { policy: "follow-pointer", focusOnMap: true },
        decoration: {
          appIdPattern: ".*", border: { width: 8, radius: 10 },
          unfocused: { kind: "solid", color: "#00ffffff" },
          focused: { kind: "solid", color: "#00ffffff" },
        },
      },
    });
    let handle; let xwm; let child;
    try {
      const term = c.spawnClient(
        ["--title", "term", "--app-id", "term", "--color", "FF00FF00",
         "--size", "400x300", "--fill-configured"]);
      await term.ready;
      await waitFor(c.query, (s) => s.windows.length >= 1 && s.windows[0].mapped,
        { timeoutMs: 8000, what: "tile mapped" });

      c.pluginBus.intercept("window.preconfigure", async (_n, payload) => {
        await new Promise((r) => setTimeout(r, 40));
        return payload;
      });
      const transitions = [];
      c.pluginBus.subscribe("window.committed", (_n, p) => {
        const ev = p;
        if (!ev?.changed?.includes("exclusive")) return;
        transitions.push(
          `${ev.surfaceId}: ${ev.previous?.exclusive}->${ev.current?.exclusive}(${ev.reason})`);
      });

      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);
      child = execFile(X11_CLIENT,
        ["--title", "fs-game", "--app-id", "fs.game",
         "--fill", "ff0000", "--fullscreen", "--ewmh-geometry-sync",
         "--timeout-ms", "40000"],
        { env: { ...process.env, DISPLAY: handle.display } });
      let gameOut = "";
      child.stdout.on("data", (d) => { gameOut += d.toString(); });

      await waitFor(c.query, (s) => s.windows.some((w) => w.role === "xwayland" && w.mapped),
        { timeoutMs: 8000, what: "game mapped" });
      const gameId = c.query().windows.find((w) => w.role === "xwayland").surfaceId;
      const gameWin = () => c.state.wm.state.windows.find((w) => w.surfaceId === gameId);

      await new Promise((r) => setTimeout(r, 4000));

      const reverts = transitions.filter((t) => t.includes("fullscreen->none"));
      assert.deepEqual(reverts, [],
        `no fullscreen reverts expected; transitions: ${JSON.stringify(transitions)}`);
      assert.ok(!gameOut.includes("geometry-sync remove"),
        `the game never saw a non-fullscreen configure; stdout: ${gameOut}`);
      assert.equal(gameWin()?.windowState.exclusive, "fullscreen",
        "game ends exclusive fullscreen");

      // The decoration must be GONE -- including the rounded-corner arcs,
      // which are the visible tell when the band hugs the screen edges (the
      // straight band is a few px at the very edge; the radius-10 corner
      // blobs are unmissable). Every corner probe must be the game's red.
      const px = (d, w, x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
      const RED = [0, 0, 255, 255];
      const probes = [[4, 4], [1275, 4], [4, 715], [1275, 715], [640, 360]];
      let vals = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        c.jsCompositor.renderFrame();
        const { data, width } = await c.jsCompositor.readback();
        vals = probes.map(([x, y]) => px(data, width, x, y));
        if (vals.every((v) => RED.every((ch, i) => v[i] === ch))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      for (let i = 0; i < probes.length; i++) {
        assert.deepEqual(vals[i], RED,
          `probe ${JSON.stringify(probes[i])} must be the game (no corner decoration)`);
      }
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
