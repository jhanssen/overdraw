// Regression: keyUpdate() must resolve keysyms before any wl_keyboard
// client has bound. The keymap was previously built lazily only inside
// KeymapInfo (called by the protocol layer's get_keyboard handler), so
// a host key-down arriving before any client bound a keyboard called
// keyUpdate() with no keymap and silently returned keysym=0. The chain
// gates on keysym != 0, so the chord was skipped without diagnostics.
// ensureKeymap() now covers both call sites in the addon.
//
// This test exercises the addon directly (no setupCompositor) so the
// keymap singleton has not been touched by any prior wl_keyboard bind.
// Node's --test isolates each file in its own subprocess by default, so
// the addon's static state is fresh here regardless of other test files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const skip = process.env.WAYLAND_DISPLAY ? false : "needs host Wayland (WAYLAND_DISPLAY unset)";
const addonPath = resolve("packages/core/build/overdraw_native.node");
const gpuBin = resolve("packages/core/build/overdraw-gpu-process");

// Evdev keycode for 'a' (linux/input-event-codes.h KEY_A).
const KEY_A = 30;
// XKB keysym for lowercase a (xkbcommon-keysyms.h XKB_KEY_a).
const XKB_KEY_a = 0x61;

test("addon.keyUpdate resolves a keysym on first call (no client connected)", { skip }, () => {
  const addon = require(addonPath);
  // start() brings up the GPU process + device but binds NOTHING from a
  // Wayland-client perspective; no wl_keyboard get_keyboard has run, so
  // KeymapInfo's lazy path has not constructed the keymap. The chord
  // dispatch path inside wl_seat would call keyUpdate at this point.
  addon.start(gpuBin, null, null, { width: 320, height: 240 });
  try {
    const r = addon.keyUpdate(KEY_A, true);
    assert.equal(r.keysym, XKB_KEY_a,
      `expected XKB_KEY_a (0x${XKB_KEY_a.toString(16)}), got 0x${r.keysym.toString(16)} -- keymap not built on first key-down`);
    addon.keyUpdate(KEY_A, false);
  } finally {
    addon.stop();
  }
});
