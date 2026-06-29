// Native keymap registry + active-keymap arbitration (GPU-free).
//
// Exercises the addon's per-keyboard keymap machinery directly -- registerKeymap
// (compile a client keymap from an fd via initFromFd), setActiveKeymap (switch
// which keymap keyUpdate/keymapInfo use), and unregisterKeymap -- without a GPU,
// compositor, or Wayland session. The "client" keymap fed back in is the default
// seat keymap's own memfd, which is guaranteed-valid keymap text, so this needs
// only xkbcommon + the built native addon. Self-skips if either is unavailable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let addon = null;
try {
  addon = require(join(__dirname, "..", "packages", "core", "build", "overdraw_native.node"));
} catch {
  addon = null;  // not built; skip
}

// KEY_LEFTSHIFT in evdev; pressing it must set a modifier bit under any sane
// keymap.
const KEY_LEFTSHIFT = 42;

test("native keymap: register a client keymap, switch active, key state, unregister", { skip: addon ? false : "native addon not built" }, () => {
  // The default seat keymap (built on demand). Skip if xkbcommon can't compile
  // it (e.g. no xkeyboard-config data present).
  const def = addon.keymapInfo();
  if (!def) { return; }  // environment without xkb data: nothing to assert
  assert.equal(def.format, 1);
  assert.ok(def.size > 0);
  const defaultSize = def.size;
  // keymapInfo dups the memfd; we feed THIS dup back in as a "client" keymap
  // (registerKeymap takes ownership of the fd).
  const id = addon.registerKeymap(def.fd, def.size);
  assert.ok(id >= 1, "registerKeymap returns a non-zero id for a valid keymap");

  // Switching to the virtual keymap is a real change; switching again is not.
  assert.equal(addon.setActiveKeymap(id), true);
  assert.equal(addon.setActiveKeymap(id), false);

  // keymapInfo now reports the active (virtual) keymap. It was compiled from the
  // default's text and re-serialized, so it is a valid V1 keymap of the same
  // size.
  const act = addon.keymapInfo();
  assert.ok(act);
  assert.equal(act.format, 1);
  assert.equal(act.size, defaultSize);
  act.fd.close();

  // Modifier state is read from the active keymap: pressing Shift sets a bit,
  // releasing clears it.
  const down = addon.keyUpdate(KEY_LEFTSHIFT, true);
  assert.notEqual(down.modsDepressed, 0, "Shift down sets a depressed modifier bit");
  const up = addon.keyUpdate(KEY_LEFTSHIFT, false);
  assert.equal(up.modsDepressed, 0, "Shift up clears it");

  // setModifiers sets the active keymap's state directly (a virtual keyboard's
  // explicit modifiers request). Set the Shift bit from `down` (the mask xkb
  // produced for a real Shift press) and confirm it round-trips back.
  const shiftMask = down.modsDepressed;
  const set = addon.setModifiers(shiftMask, 0, 0, 0);
  assert.equal(set.modsDepressed, shiftMask, "explicit modifier mask is honored");
  const cleared = addon.setModifiers(0, 0, 0, 0);
  assert.equal(cleared.modsDepressed, 0, "clearing the mask works");

  // Switch back to the default; unregister the virtual keymap.
  assert.equal(addon.setActiveKeymap(0), true);
  addon.unregisterKeymap(id);
  // An unknown id falls back to the default (no change, since already default).
  assert.equal(addon.setActiveKeymap(id), false);

  // The default keymap is unaffected and still serves keymapInfo.
  const after = addon.keymapInfo();
  assert.ok(after);
  assert.equal(after.size, defaultSize);
  after.fd.close();
});
