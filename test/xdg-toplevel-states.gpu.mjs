// GPU integration test for xdg_toplevel state-affecting requests:
//   - Client sends set_maximized BEFORE its initial commit.
//   - Server defers the first configure until the initial commit.
//   - The single first configure carries the full-output size AND the
//     maximized state bit (no flicker, no second configure to "fix it up").
//   - getWindowState reflects maximized.
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

test("set_maximized before initial commit: maximized arrives with the sized configure", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cl = c.spawnClient(["--initial-state", "maximized"]);
    await cl.ready;

    // xdg-shell spec: 'maximized' requires the client to obey the configure
    // geometry. A 0x0 configure means "client picks size", which is
    // contradictory with 'maximized' (Qt explicitly warns). The compositor
    // suppresses size-binding states until it can also send a real size.
    // Verify: the 0x0 configure carries NO size-binding states, and the
    // sized configure carries maximized + the full output size.
    const configures = cl.stdout.split("\n")
      .filter((l) => /\[harness-client\] configure /.test(l)).map(parseConfigure);
    assert.ok(configures.length >= 1, `expected at least one configure; got ${configures.length}`);
    const zero = configures.find((cfg) => cfg.w === 0 && cfg.h === 0);
    if (zero) {
      assert.ok(!zero.states.includes(STATE_MAXIMIZED),
        `0x0 configure must NOT carry maximized; got [${zero.states.join(",")}]`);
      assert.ok(!zero.states.includes(STATE_FULLSCREEN),
        `0x0 configure must NOT carry fullscreen; got [${zero.states.join(",")}]`);
    }
    const sized = configures.find((cfg) => cfg.w > 0 && cfg.h > 0);
    assert.ok(sized, "expected a configure carrying a non-zero size");
    assert.equal(sized.w, OUT.width, `sized configure width should match output; got ${sized.w}`);
    assert.equal(sized.h, OUT.height, `sized configure height should match output; got ${sized.h}`);
    assert.ok(sized.states.includes(STATE_MAXIMIZED), "sized configure should carry maximized");

    // WM state agrees.
    const snap = c.query();
    assert.equal(snap.windows.length, 1);
    const win = snap.windows[0];
    const ws = c.state.wm.getWindowState(win.surfaceId);
    assert.equal(ws.presentation, "maximized");
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
    assert.equal(ws.presentation, "fullscreen");
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
