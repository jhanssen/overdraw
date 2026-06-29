// Pure-unit tests for the key-spec parser. No xkbcommon, no compositor;
// these pin the modifier aliases, keysym table coverage, and chord parsing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSpec, parseChord, formatStep, formatChord, stepsEqual,
  MOD_SHIFT, MOD_CTRL, MOD_MOD1, MOD_MOD4,
} from "../packages/core/dist/input/keyspec.js";
import { keysymOf } from "../packages/core/dist/input/keysyms.js";

// ---- parseSpec --------------------------------------------------------------

test("parseSpec: plain key", () => {
  assert.deepEqual(parseSpec("a"), { kind: "key", mods: 0, keysym: 0x61 });
  assert.deepEqual(parseSpec("Return"), { kind: "key", mods: 0, keysym: 0xff0d });
});

test("parseSpec: single modifier", () => {
  assert.deepEqual(parseSpec("Mod+1"), { kind: "key", mods: MOD_MOD4, keysym: 0x31 });
  assert.deepEqual(parseSpec("Ctrl+c"), { kind: "key", mods: MOD_CTRL, keysym: 0x63 });
  assert.deepEqual(parseSpec("Alt+F4"), { kind: "key", mods: MOD_MOD1, keysym: 0xffc1 });
});

test("parseSpec: multiple modifiers (any order)", () => {
  const r = parseSpec("Mod+Shift+Return");
  assert.equal(r.mods, MOD_MOD4 | MOD_SHIFT);
  assert.equal(r.keysym, 0xff0d);
  // Order-independent.
  assert.deepEqual(parseSpec("Shift+Mod+Return"), r);
});

test("parseSpec: case-insensitive on modifiers", () => {
  assert.deepEqual(parseSpec("MOD+a"), { kind: "key", mods: MOD_MOD4, keysym: 0x61 });
  assert.deepEqual(parseSpec("ctrl+SHIFT+a"),
    { kind: "key", mods: MOD_CTRL | MOD_SHIFT, keysym: 0x61 });
});

test("parseSpec: case-insensitive on keysym name", () => {
  // "Return" and "return" resolve to the same keysym.
  assert.equal(parseSpec("return").keysym, parseSpec("Return").keysym);
});

test("parseSpec: Super and Logo are aliases for Mod", () => {
  assert.deepEqual(parseSpec("Super+a"), { kind: "key", mods: MOD_MOD4, keysym: 0x61 });
  assert.deepEqual(parseSpec("Logo+a"), { kind: "key", mods: MOD_MOD4, keysym: 0x61 });
});

test("parseSpec: trims whitespace around tokens", () => {
  assert.deepEqual(parseSpec("  Mod  +  a  "), { kind: "key", mods: MOD_MOD4, keysym: 0x61 });
});

test("parseSpec: rejects empty input", () => {
  assert.throws(() => parseSpec(""), /empty/);
  assert.throws(() => parseSpec("   "), /empty/);
});

test("parseSpec: rejects empty token", () => {
  assert.throws(() => parseSpec("Mod++a"), /empty token/);
  assert.throws(() => parseSpec("+a"), /empty token/);
  assert.throws(() => parseSpec("Mod+"), /empty token/);
});

test("parseSpec: rejects unknown modifier", () => {
  assert.throws(() => parseSpec("Foo+a"), /unknown modifier 'Foo'/);
});

test("parseSpec: rejects unknown keysym", () => {
  assert.throws(() => parseSpec("Mod+nonexistent_key"), /unknown keysym/);
});

test("parseSpec: rejects duplicate modifier", () => {
  assert.throws(() => parseSpec("Mod+Mod+a"), /duplicate modifier/);
  // Aliases collide too: Super and Mod are the same bit.
  assert.throws(() => parseSpec("Super+Mod+a"), /duplicate modifier/);
});

test("parseSpec: rejects non-string", () => {
  assert.throws(() => parseSpec(42), /must be a string/);
});

// ---- parseChord -------------------------------------------------------------

test("parseChord: single-step string is a 1-element array", () => {
  const r = parseChord("Mod+a");
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { kind: "key", mods: MOD_MOD4, keysym: 0x61 });
});

test("parseChord: comma-separated chord", () => {
  const r = parseChord("Mod+a, Mod+b");
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { kind: "key", mods: MOD_MOD4, keysym: 0x61 });
  assert.deepEqual(r[1], { kind: "key", mods: MOD_MOD4, keysym: 0x62 });
});

test("parseChord: space-separated chord", () => {
  const r = parseChord("Mod+a Mod+b");
  assert.equal(r.length, 2);
});

test("parseChord: array of strings", () => {
  const r = parseChord(["Mod+a", "Mod+b"]);
  assert.equal(r.length, 2);
  assert.deepEqual(r[1], { kind: "key", mods: MOD_MOD4, keysym: 0x62 });
});

test("parseChord: array of pre-parsed steps passes through", () => {
  const r = parseChord([{ kind: "key", mods: MOD_CTRL, keysym: 0x61 }, { kind: "key", mods: 0, keysym: 0x62 }]);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { kind: "key", mods: MOD_CTRL, keysym: 0x61 });
});

test("parseChord: rejects empty array", () => {
  assert.throws(() => parseChord([]), /empty/);
});

test("parseChord: rejects empty string", () => {
  assert.throws(() => parseChord(""), /empty/);
});

test("parseChord: rejects non-string non-array", () => {
  assert.throws(() => parseChord(42), /must be a string or array/);
});

// ---- formatStep / formatChord ----------------------------------------------

test("formatStep: round-trips through parseSpec", () => {
  for (const spec of ["a", "Mod+a", "Ctrl+Shift+Return", "Alt+F4", "Mod+Shift+1"]) {
    const parsed = parseSpec(spec);
    const formatted = formatStep(parsed);
    const reparsed = parseSpec(formatted);
    assert.ok(stepsEqual(parsed, reparsed),
      `round-trip failed: ${spec} -> ${formatted}`);
  }
});

test("formatChord: round-trips through parseChord", () => {
  const original = parseChord("Mod+a, Mod+b");
  const formatted = formatChord(original);
  const reparsed = parseChord(formatted);
  assert.equal(reparsed.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(stepsEqual(original[i], reparsed[i]));
  }
});

// ---- keysym table coverage -------------------------------------------------

test("keysymOf: letters a-z map to ASCII codepoints", () => {
  for (let c = 0x61; c <= 0x7a; c++) {
    const name = String.fromCharCode(c);
    assert.equal(keysymOf(name), c);
    // Uppercase also maps (case-insensitive in our table).
    assert.equal(keysymOf(name.toUpperCase()), c);
  }
});

test("keysymOf: digits 0-9 map to ASCII codepoints", () => {
  for (let d = 0; d <= 9; d++) {
    assert.equal(keysymOf(String(d)), 0x30 + d);
  }
});

test("keysymOf: function keys F1-F12", () => {
  // F1 = 0xffbe; F12 = 0xffc9 (consecutive).
  for (let i = 1; i <= 12; i++) {
    const v = keysymOf(`F${i}`);
    assert.ok(v !== null, `F${i} missing`);
  }
});

test("keysymOf: returns null for unknown", () => {
  assert.equal(keysymOf("notakey"), null);
  assert.equal(keysymOf(""), null);
});

// ---- stepsEqual -------------------------------------------------------------

test("stepsEqual: identical steps", () => {
  assert.ok(stepsEqual({ kind: "key", mods: 0x40, keysym: 0x61 }, { kind: "key", mods: 0x40, keysym: 0x61 }));
});

test("stepsEqual: different mods", () => {
  assert.ok(!stepsEqual({ kind: "key", mods: 0x40, keysym: 0x61 }, { kind: "key", mods: 0x44, keysym: 0x61 }));
});

test("stepsEqual: different keysym", () => {
  assert.ok(!stepsEqual({ kind: "key", mods: 0x40, keysym: 0x61 }, { kind: "key", mods: 0x40, keysym: 0x62 }));
});

// ---- scroll steps -----------------------------------------------------------

test("parseSpec: scroll directions + mouse_* aliases", () => {
  assert.deepEqual(parseSpec("Mod+scroll_up"), { kind: "scroll", mods: MOD_MOD4, dir: 0 });
  assert.deepEqual(parseSpec("Mod+scroll_down"), { kind: "scroll", mods: MOD_MOD4, dir: 1 });
  assert.deepEqual(parseSpec("Ctrl+scroll_left"), { kind: "scroll", mods: MOD_CTRL, dir: 2 });
  assert.deepEqual(parseSpec("scroll_right"), { kind: "scroll", mods: 0, dir: 3 });
  // Hyprland-style aliases map to vertical scroll.
  assert.deepEqual(parseSpec("mouse_up"), { kind: "scroll", mods: 0, dir: 0 });
  assert.deepEqual(parseSpec("mouse_down"), { kind: "scroll", mods: 0, dir: 1 });
});

test("formatStep + stepsEqual: scroll", () => {
  assert.equal(formatStep(parseSpec("Mod+scroll_up")), "Mod+scroll_up");
  assert.ok(stepsEqual(parseSpec("Mod+scroll_up"), { kind: "scroll", mods: MOD_MOD4, dir: 0 }));
  assert.ok(!stepsEqual(parseSpec("Mod+scroll_up"), parseSpec("Mod+scroll_down")));
  // a scroll step is never equal to a key/button step with the same mods
  assert.ok(!stepsEqual(parseSpec("Mod+scroll_up"), parseSpec("Mod+button1")));
});
