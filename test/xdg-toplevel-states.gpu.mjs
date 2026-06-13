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

const skip = canRunGpu() ? false : "needs GPU (WAYLAND_DISPLAY unset)";

// xdg_toplevel.state enum (from the XML)
const STATE_MAXIMIZED = 1;
const STATE_FULLSCREEN = 2;
const STATE_ACTIVATED = 4;

const OUT = { width: 1280, height: 720 };

test("set_maximized before initial commit: first configure carries full output size + maximized state", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cl = c.spawnClient(["--initial-state", "maximized"]);
    await cl.ready;

    // The client logs each configure with the states array. The FIRST
    // configure must already carry full-output size + maximized state
    // (this is the no-flicker contract: the client renders at the right
    // size + state from frame zero, never at a wrong-state intermediate).
    // Subsequent reconfigures are fine; we only assert the first.
    const configures = cl.stdout.split("\n").filter((l) => /\[harness-client\] configure /.test(l));
    assert.ok(configures.length >= 1,
      `expected at least one configure; got ${configures.length}`);
    const m = configures[0].match(/configure (\d+)x(\d+) states=\[([^\]]*)\]/);
    assert.ok(m, `couldn't parse configure line: ${configures[0]}`);
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    const states = m[3].length ? m[3].split(",").map((s) => parseInt(s, 10)) : [];
    assert.equal(w, OUT.width,
      `first configure width should match output (${OUT.width}); got ${w}`);
    assert.equal(h, OUT.height,
      `first configure height should match output (${OUT.height}); got ${h}`);
    assert.ok(states.includes(STATE_MAXIMIZED),
      `first configure states array should include maximized (${STATE_MAXIMIZED}); got [${states.join(",")}]`);

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

test("set_fullscreen before initial commit: configure has fullscreen state + full output size", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cl = c.spawnClient(["--initial-state", "fullscreen"]);
    await cl.ready;
    const configures = cl.stdout.split("\n").filter((l) => /\[harness-client\] configure /.test(l));
    assert.ok(configures.length >= 1);
    const m = configures[0].match(/configure (\d+)x(\d+) states=\[([^\]]*)\]/);
    assert.equal(parseInt(m[1], 10), OUT.width);
    assert.equal(parseInt(m[2], 10), OUT.height);
    const states = m[3].length ? m[3].split(",").map((s) => parseInt(s, 10)) : [];
    assert.ok(states.includes(STATE_FULLSCREEN));
    const snap = c.query();
    const ws = c.state.wm.getWindowState(snap.windows[0].surfaceId);
    assert.equal(ws.presentation, "fullscreen");
  } finally {
    await c.teardown();
  }
});

test("no initial-state request: configure has neither maximized nor fullscreen", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cl = c.spawnClient([]);
    await cl.ready;
    const configures = cl.stdout.split("\n").filter((l) => /\[harness-client\] configure /.test(l));
    assert.ok(configures.length >= 1, "at least one configure expected");
    // The first configure should NOT carry maximized or fullscreen.
    const m = configures[0].match(/states=\[([^\]]*)\]/);
    const states = m[1].length ? m[1].split(",").map((s) => parseInt(s, 10)) : [];
    assert.ok(!states.includes(STATE_MAXIMIZED));
    assert.ok(!states.includes(STATE_FULLSCREEN));
    // Focus follows the client (single window), so activated may be present.
    // We don't assert on activated here; that's a separate concern.
  } finally {
    await c.teardown();
  }
});
