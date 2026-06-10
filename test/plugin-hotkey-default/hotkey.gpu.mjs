// GPU integration: real wayland client + bundled hotkey + core-actions
// plugin. A hotkey config binds Mod+q -> compositor.quit. The test
// injects Mod-down then q-press; observes the compositor.shutdown event
// on the plugin bus (the harness doesn't actually exit, just fires the
// emit -- production main.ts subscribes and runs shutdown()).

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, settled } from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (WAYLAND_DISPLAY unset)";
const OUT = { width: 1280, height: 720 };
const FILL = "--fill-configured";

// Evdev keycodes (linux/input-event-codes.h).
const KEY_Q = 16;
const KEY_LEFTMETA = 125;   // Super_L

test("hotkey plugin: Mod+q triggers compositor.quit via the binding chain", { skip }, async () => {
  const shutdowns = [];
  const c = await setupCompositor({
    headless: OUT,
    hotkeys: {
      modes: {
        default: [
          { keys: "Mod+q", action: "compositor.quit" },
        ],
      },
    },
  });
  try {
    // Subscribe to compositor.shutdown so we can observe the emit. The
    // harness doesn't have the main.ts subscriber that ACTUALLY runs
    // shutdown(); just verify the event fires.
    c.pluginBus.subscribe("compositor.shutdown", (n, p) => shutdowns.push({ n, p }));

    const a = c.spawnClient([FILL, "--color", "ff3030c0"]);
    await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "client mapped" });

    // Wait for both plugins (core-actions, hotkey-default) to settle.
    await c.runtime.flush();

    // Inject Mod-down (Super_L), then q-press, then q-release, then
    // Mod-release. Bindings fire on press; release events are still
    // forwarded through xkb so subsequent presses have correct mods.
    c.addon.injectInput({ type: "keyboardKey", key: KEY_LEFTMETA, pressed: true, time: 1 });
    c.addon.injectInput({ type: "keyboardKey", key: KEY_Q,        pressed: true, time: 2 });
    c.addon.injectInput({ type: "keyboardKey", key: KEY_Q,        pressed: false, time: 3 });
    c.addon.injectInput({ type: "keyboardKey", key: KEY_LEFTMETA, pressed: false, time: 4 });

    // The action dispatch is async (event-bus emit), so wait for the
    // shutdown event to land.
    await settled(() => shutdowns,
      (s) => s.length >= 1,
      { what: "compositor.shutdown observed" });
    assert.equal(shutdowns.length, 1);
    assert.equal(shutdowns[0].n, "compositor.shutdown");
  } finally {
    await c.teardown();
  }
});
