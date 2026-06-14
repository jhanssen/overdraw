// Regression: binding matching must use the shift-level-0 ("base") keysym so
// a held Shift counts only as a modifier bit. Before this, addon.keyUpdate
// returned only the Shift-translated keysym ('j' under Shift -> 'J'); a
// binding written "Mod+Shift+j" parses to the 'j' keysym (keyspec folds case),
// so it never matched the live 'J' and the key fell through to the client.
//
// GPU-free: keyUpdate builds the xkb keymap lazily (ensureKeymap), independent
// of the compositor/GPU, so this exercises the addon directly. Skips if the
// native addon has not been built. Node isolates each test file in its own
// subprocess, so the addon's keymap singleton is fresh here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const addonPath = join(__dirname, "..", "packages", "core", "build", "overdraw_native.node");
const skip = existsSync(addonPath) ? false : "overdraw_native.node not built";

// Evdev keycodes (linux/input-event-codes.h).
const KEY_1 = 2;
const KEY_J = 36;
const KEY_LEFTSHIFT = 42;
// XKB keysyms (xkbcommon-keysyms.h) under a US layout.
const XKB_KEY_1 = 0x31;
const XKB_KEY_exclam = 0x21;
const XKB_KEY_j = 0x6a;
const XKB_KEY_J = 0x4a;
const MOD_SHIFT = 0x01;

test("keyUpdate.baseKeysym is shift-independent; keysym is shift-translated", { skip }, () => {
  const addon = require(addonPath);

  // No Shift: base == translated.
  const plain = addon.keyUpdate(KEY_J, true);
  addon.keyUpdate(KEY_J, false);
  assert.equal(plain.keysym, XKB_KEY_j);
  assert.equal(plain.baseKeysym, XKB_KEY_j);

  // Shift held: the letter key translates to uppercase, but the base keysym
  // stays lowercase and the Shift bit shows up in mods -- so "Mod+Shift+j"
  // (which parses to the 'j' keysym + Shift) matches.
  addon.keyUpdate(KEY_LEFTSHIFT, true);
  const shifted = addon.keyUpdate(KEY_J, true);
  addon.keyUpdate(KEY_J, false);
  assert.equal(shifted.keysym, XKB_KEY_J, "translated keysym is uppercase under Shift");
  assert.equal(shifted.baseKeysym, XKB_KEY_j, "base keysym stays lowercase under Shift");
  assert.ok(shifted.modsDepressed & MOD_SHIFT, "Shift bit is set in modsDepressed");

  // Number row: Shift+1 translates to '!', base stays '1' -- so "Mod+Shift+1"
  // (parses to the '1' keysym) matches too.
  const shifted1 = addon.keyUpdate(KEY_1, true);
  addon.keyUpdate(KEY_1, false);
  assert.equal(shifted1.keysym, XKB_KEY_exclam, "translated keysym is '!' under Shift");
  assert.equal(shifted1.baseKeysym, XKB_KEY_1, "base keysym stays '1' under Shift");

  addon.keyUpdate(KEY_LEFTSHIFT, false);
});
