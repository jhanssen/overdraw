// GPU integration: deferred refs + config.actions end-to-end. A real
// wayland client maps; the user's config binds Mod+u to a user action
// that observes the focused window. The hotkey config passes
// { $ref: "focusedWindow" } as a param; the action registry resolves
// it from core state (state.seat.kbFocus) at invoke time; the user
// handler receives the actual surface id.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, settled } from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const FILL = "--fill-configured";
const KEY_U = 22;            // evdev keycode for 'u'
const KEY_LEFTMETA = 125;    // Super_L

test("hotkey + deferred-ref + config.actions: focusedWindow flows to user handler", { skip }, async () => {
  const observations = [];
  const c = await setupCompositor({
    headless: OUT,
    actions: {
      "user.observe-focus": async (_sdk, params) => {
        observations.push(params);
      },
    },
    hotkeys: {
      modes: {
        default: [
          { keys: "Mod+u", action: "user.observe-focus",
            params: { surface: { $ref: "focusedWindow" } } },
        ],
      },
    },
  });
  try {
    const a = c.spawnClient([FILL, "--color", "ff3030c0"]);
    await a.ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1,
      { what: "client mapped" });
    const surfaceId = snap.windows[0].surfaceId;

    // focusOnMap (focus plugin default) puts kbFocus on the freshly-mapped
    // window. Wait for that to settle.
    await c.waitFor(c.query, (s) => s.keyboardFocus === surfaceId,
      { what: "kbFocus on client" });
    await c.runtime.flush();

    // Inject Mod+u to trigger the hotkey.
    c.addon.injectInput({ type: "keyboardKey", key: KEY_LEFTMETA, pressed: true, time: 1 });
    c.addon.injectInput({ type: "keyboardKey", key: KEY_U,        pressed: true, time: 2 });
    c.addon.injectInput({ type: "keyboardKey", key: KEY_U,        pressed: false, time: 3 });
    c.addon.injectInput({ type: "keyboardKey", key: KEY_LEFTMETA, pressed: false, time: 4 });

    await settled(() => observations,
      (o) => o.length >= 1,
      { what: "user.observe-focus invoked" });
    assert.equal(observations.length, 1);
    // The deferred ref resolved to the focused surface id.
    assert.equal(observations[0].surface, surfaceId);
  } finally {
    await c.teardown();
  }
});
