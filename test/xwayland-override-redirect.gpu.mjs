// Phase 3.3 end-to-end: override-redirect X11 windows (menus, tooltips, DnD
// icons) are placed at their X-client-supplied root coords on the content
// layer's overlay strip, above all toplevels and popups. They do NOT enter
// the WM, do NOT emit window.map / window.unmap, and do NOT trigger focus
// (focus on OR comes from explicit X-side requests in slice 3.4).
//
// Needs the GPU, Xwayland, and the built x11-test-client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompositor, canRunGpu, waitFor, nextXDisplay, pointerMotion } from "./harness.mjs";
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

test("override-redirect X11 window is placed at its X-supplied coords",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      // Open an override-redirect window at (300, 200) of size 150x100.
      child = execFile(X11_CLIENT, [
        "--override-redirect",
        "--x", "300", "--y", "200", "--w", "150", "--h", "100",
        "--title", "or-menu",
        "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });

      // OR surfaces are recorded in state.overrideRedirects after MapNotify.
      // Wait for it. The state isn't surfaced through state.query() (OR
      // overlays are deliberately invisible to plugins), so check state
      // directly via the compositor handle.
      const overrideRedirects = () => c.state.overrideRedirects ?? new Map();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          const ors = overrideRedirects();
          if (ors.size >= 1) return resolve();
          if (Date.now() > deadline) return reject(new Error(
            `OR overlay never appeared; state.overrideRedirects=${JSON.stringify([...ors])}`));
          setTimeout(tick, 50);
        };
        tick();
      });

      // The OR overlay must be at the X-supplied (300, 200) 150x100.
      const ors = overrideRedirects();
      const entries = [...ors.entries()];
      assert.equal(ors.size, 1,
        `exactly one OR overlay; saw ${entries.length}: ${JSON.stringify(entries)}`);
      const [, rect] = entries[0];
      assert.deepEqual(rect, { x: 300, y: 200, width: 150, height: 100 },
        "OR rect matches X-supplied coords (identity-mapped in rootless mode)");

      // OR surfaces must NOT appear in state.query().windows. They are
      // transient overlays, not WM windows.
      const snap = c.query();
      assert.equal(snap.windows.length, 0,
        `OR overlay leaked into state.query().windows: ${JSON.stringify(snap.windows)}`);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("an OR overlay surface is focusable (focusTargetFor resolves it)",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      child = execFile(X11_CLIENT, [
        "--override-redirect",
        "--x", "50", "--y", "50", "--w", "100", "--h", "60",
        "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });

      // Wait for the OR overlay to register.
      const ors = () => c.state.overrideRedirects ?? new Map();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          if (ors().size >= 1) return resolve();
          if (Date.now() > deadline) return reject(new Error("OR never appeared"));
          setTimeout(tick, 50);
        };
        tick();
      });

      const [orSurfaceId] = [...ors().keys()];

      // Apply keyboard focus to the OR overlay; the seat's focusTargetFor
      // should resolve it via state.overrideRedirects (instead of
      // wm.getSnapshot, which would fail -- OR isn't in the WM).
      c.state.seat?.applyKeyboardFocus(orSurfaceId);

      // The seat's kbFocus is now the OR surface.
      assert.equal(c.state.seat?.kbFocus?.surfaceId, orSurfaceId,
        "keyboard focus landed on the OR overlay");
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("with global X scale=2, an OR window's X coords land halved (compositor logical)",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      // Freeze X scale=2 before the XWM starts so placeOverlay divides by
      // the right number.
      c.state.xwaylandScale = 2;
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      // OR at X (400, 200) 200x100 -- in X-device coords. With X scale=2
      // the compositor's logical rect must be (200, 100, 100, 50).
      child = execFile(X11_CLIENT, [
        "--override-redirect",
        "--x", "400", "--y", "200", "--w", "200", "--h", "100",
        "--title", "or-scaled",
        "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });

      const overrideRedirects = () => c.state.overrideRedirects ?? new Map();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          if (overrideRedirects().size >= 1) return resolve();
          if (Date.now() > deadline) return reject(new Error(
            `OR overlay never appeared; state.overrideRedirects=${JSON.stringify([...overrideRedirects()])}`));
          setTimeout(tick, 50);
        };
        tick();
      });

      const [, rect] = [...overrideRedirects().entries()][0];
      assert.deepEqual(rect, { x: 200, y: 100, width: 100, height: 50 },
        `OR rect halved by X scale=2 (X-device (400,200) 200x100 -> logical (200,100) 100x50); saw ${JSON.stringify(rect)}`);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("destroying an OR window cleans up state.overrideRedirects",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      child = execFile(X11_CLIENT, [
        "--override-redirect",
        "--x", "100", "--y", "100", "--w", "80", "--h", "40",
        "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });

      // Wait for it to appear.
      const ors = () => c.state.overrideRedirects ?? new Map();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          if (ors().size >= 1) return resolve();
          if (Date.now() > deadline) return reject(new Error("OR never appeared"));
          setTimeout(tick, 50);
        };
        tick();
      });

      // Kill the X client -- the X server then emits DestroyNotify which
      // xwm.ts maps to removeOverlay.
      child.kill("SIGKILL");

      // Wait for state.overrideRedirects to drain.
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const tick = () => {
          if (ors().size === 0) return resolve();
          if (Date.now() > deadline) return reject(new Error(
            `OR not cleaned up after destroy; state.overrideRedirects=${JSON.stringify([...ors()])}`));
          setTimeout(tick, 50);
        };
        tick();
      });
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("window created OR but cleared before map is MANAGED (fullscreen honored)",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      // The attribute flip games/Wine perform: create with OR set, clear it
      // before mapping. MapNotify carries the cleared value; the WM must
      // classify by that, not the create-time snapshot.
      child = execFile(X11_CLIENT, [
        "--or-clear-before-map",
        "--fullscreen",
        "--title", "or-flip-game",
        "--w", "640", "--h", "480",
        "--fill", "3060a0",
        "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });

      const snap = await waitFor(c.query,
        (s) => s.windows.length === 1,
        { timeoutMs: 8000, what: "or-flipped window managed" });
      assert.equal(snap.windows[0].title, "or-flip-game");
      const winId = snap.windows[0].surfaceId;
      const sizeMode = () =>
        c.state.wm.state.windows.find((w) => w.surfaceId === winId)
          ?.windowState.sizeMode;
      await waitFor(() => ({ sizeMode: sizeMode() }),
        (s) => s.sizeMode === "fullscreen",
        { timeoutMs: 5000, what: "fullscreen applied" });

      // And it must NOT sit in the overlay store.
      assert.equal((c.state.overrideRedirects ?? new Map()).size, 0,
        "no overlay placement for a window that mapped non-OR");
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("an OR overlay takes pointer input (picked above content)",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      child = execFile(X11_CLIENT, [
        "--override-redirect",
        "--x", "120", "--y", "90", "--w", "200", "--h", "100",
        "--fill", "a03060",
        "--title", "or-menu-input",
        "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });

      const ors = () => c.state.overrideRedirects ?? new Map();
      await waitFor(() => ({ n: ors().size }), (s) => s.n >= 1,
        { timeoutMs: 8000, what: "OR overlay placed" });
      const [orSurfaceId] = [...ors().keys()];

      // Move the pointer into the overlay's rect (identity camera: world
      // == glass). Pointer focus must land on the OR surface, not fall
      // through to whatever is beneath.
      pointerMotion(c.addon, 220, 140);
      const snap = await waitFor(c.query,
        (s) => s.pointerFocus === orSurfaceId,
        { timeoutMs: 5000, what: "pointer focus on the OR overlay" });
      assert.equal(snap.pointerFocus, orSurfaceId);

      // Off-overlay motion releases it.
      pointerMotion(c.addon, 500, 400);
      await waitFor(c.query,
        (s) => s.pointerFocus !== orSurfaceId,
        { timeoutMs: 5000, what: "pointer focus left the OR overlay" });
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("pointer onto an OR overlay keeps keyboard focus on the window beneath",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    const children = [];
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);
      const env = { env: { ...process.env, DISPLAY: handle.display } };

      children.push(execFile(X11_CLIENT, [
        "--title", "or-owner", "--fill", "3060a0", "--timeout-ms", "20000",
      ], env));
      const snap = await waitFor(c.query,
        (s) => s.windows.some((w) => w.title === "or-owner" && w.rect.width > 0),
        { timeoutMs: 8000, what: "owner window laid out" });
      const owner = snap.windows.find((w) => w.title === "or-owner");
      // Follow-pointer: hovering the owner focuses it.
      pointerMotion(c.addon, owner.rect.x + 20, owner.rect.y + 20);
      await waitFor(c.query, (s) => s.keyboardFocus === owner.surfaceId,
        { timeoutMs: 5000, what: "owner focused" });

      // A menu-like OR overlay over the owner's interior.
      const mx = owner.rect.x + 100, my = owner.rect.y + 80;
      children.push(execFile(X11_CLIENT, [
        "--override-redirect",
        "--x", String(mx), "--y", String(my), "--w", "200", "--h", "100",
        "--fill", "a03060", "--title", "or-menu-focus", "--timeout-ms", "20000",
      ], env));
      const ors = () => c.state.overrideRedirects ?? new Map();
      await waitFor(() => ({ n: ors().size }), (s) => s.n >= 1,
        { timeoutMs: 8000, what: "OR overlay placed" });
      const [orSurfaceId] = [...ors().keys()];

      pointerMotion(c.addon, mx + 50, my + 50);
      await waitFor(c.query, (s) => s.pointerFocus === orSurfaceId,
        { timeoutMs: 5000, what: "pointer focus on the OR overlay" });
      await c.focusDriver?.settled?.();
      const after = await c.query();
      assert.equal(after.keyboardFocus, owner.surfaceId,
        "keyboard focus stays on the owner while the pointer is over its menu");
    } finally {
      for (const ch of children) if (ch.exitCode === null) ch.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
