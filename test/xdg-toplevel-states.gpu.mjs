// GPU integration test for xdg_toplevel state-affecting requests:
//   - set_maximized BEFORE initial commit is SUPPRESSED by the default
//     policy (GTK/Qt startup boilerplate that demands maximize before the
//     user has seen the window). The wish is recorded in clientRequests
//     so a window-rules plugin may override at window.preconfigure, but
//     the configure that goes out does NOT carry maximized.
//   - set_fullscreen BEFORE initial commit IS honored (the default policy
//     accepts fullscreen pre-content -- matches sway / hyprland).
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";

// xdg_toplevel.state enum (from the XML)
const STATE_MAXIMIZED = 1;
const STATE_FULLSCREEN = 2;
const STATE_ACTIVATED = 4;

const OUT = { width: 1280, height: 720 };

// Parse a harness-client configure log line into { w, h, states }.
function parseConfigure(line) {
  const m = line.match(/configure (\d+)x(\d+) states=\[([^\]]*)\]/);
  if (!m) return null;
  return {
    w: parseInt(m[1], 10),
    h: parseInt(m[2], 10),
    states: m[3].length ? m[3].split(",").map((s) => parseInt(s, 10)) : [],
  };
}

test("set_maximized before initial commit: SUPPRESSED by default policy; wish preserved", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cl = c.spawnClient(["--initial-state", "maximized"]);
    await cl.ready;

    // Default policy in resolveDecisions(phase="pre-content") suppresses
    // wantsMaximized from a client (the GTK/Qt startup boilerplate that
    // demands maximize before the user has seen the window). The wish
    // is recorded in clientRequests so a window-rules plugin may
    // override at window.preconfigure; the decision axis (exclusive)
    // stays "none" and the configure that goes out reflects the
    // compositor's decision (managed/tiled), not the wish.
    const configures = cl.stdout.split("\n")
      .filter((l) => /\[harness-client\] configure /.test(l)).map(parseConfigure);
    assert.ok(configures.length >= 1, `expected at least one configure; got ${configures.length}`);
    const sized = configures.find((cfg) => cfg.w > 0 && cfg.h > 0);
    assert.ok(sized, "expected a configure carrying a non-zero size");
    assert.equal(sized.w, OUT.width);
    assert.equal(sized.h, OUT.height);
    // The sized configure carries maximized because the window is in
    // the managed tiling lane (size-binding for the tiled stack), but
    // NOT because of the client's set_maximized. The exclusive axis
    // is "none"; the WM is acting on tiling=managed + exclusive=none
    // which the encoder maps to STATE_MAXIMIZED for size-binding.
    assert.ok(sized.states.includes(STATE_MAXIMIZED),
      "tiled window's sized configure should carry maximized for size-binding");

    // WM state: exclusive declined, but the client's wish is on file.
    const snap = c.query();
    assert.equal(snap.windows.length, 1);
    const win = snap.windows[0];
    const ws = c.state.wm.getWindowState(win.surfaceId);
    assert.equal(ws.sizeMode, "none",
      "default policy declined pre-content set_maximized");
    assert.equal(ws.clientRequests.wantsMaximized, true,
      "client's wish recorded for window-rules plugins to read");
  } finally {
    await c.teardown();
  }
});

test("set_fullscreen before initial commit: fullscreen arrives with the sized configure", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cl = c.spawnClient(["--initial-state", "fullscreen"]);
    await cl.ready;
    const configures = cl.stdout.split("\n")
      .filter((l) => /\[harness-client\] configure /.test(l)).map(parseConfigure);
    assert.ok(configures.length >= 1);
    // Same rule as the maximized case: size-binding states only on sized configures.
    const zero = configures.find((cfg) => cfg.w === 0 && cfg.h === 0);
    if (zero) {
      assert.ok(!zero.states.includes(STATE_FULLSCREEN),
        `0x0 configure must NOT carry fullscreen; got [${zero.states.join(",")}]`);
      assert.ok(!zero.states.includes(STATE_MAXIMIZED),
        `0x0 configure must NOT carry maximized; got [${zero.states.join(",")}]`);
    }
    const sized = configures.find((cfg) => cfg.w > 0 && cfg.h > 0);
    assert.ok(sized, "expected a configure carrying a non-zero size");
    assert.equal(sized.w, OUT.width);
    assert.equal(sized.h, OUT.height);
    assert.ok(sized.states.includes(STATE_FULLSCREEN));
    const snap = c.query();
    const ws = c.state.wm.getWindowState(snap.windows[0].surfaceId);
    assert.equal(ws.sizeMode, "fullscreen");
  } finally {
    await c.teardown();
  }
});

test("no initial-state request: managed/tiled window's sized configure carries maximized (size-binding), not fullscreen", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cl = c.spawnClient([]);
    await cl.ready;
    const configures = cl.stdout.split("\n")
      .filter((l) => /\[harness-client\] configure /.test(l)).map(parseConfigure);
    assert.ok(configures.length >= 1, "at least one configure expected");
    // A managed window is tiled: the SIZED configure carries the maximized
    // state so the compositor-assigned size is binding (clients otherwise
    // size to content), but never fullscreen. The 0x0 handshake carries
    // neither (size-binding states require a real size; see the maximized /
    // fullscreen tests above).
    const sized = configures.find((cfg) => cfg.w > 0 && cfg.h > 0);
    assert.ok(sized, "expected a configure carrying a non-zero size");
    assert.ok(sized.states.includes(STATE_MAXIMIZED), "sized configure should carry maximized");
    assert.ok(!sized.states.includes(STATE_FULLSCREEN));
    // Focus follows the client (single window), so activated may be present.
    // We don't assert on activated here; that's a separate concern.
  } finally {
    await c.teardown();
  }
});
