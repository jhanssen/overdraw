// Pure-unit tests for src/xwayland/properties.ts byte parsers. Each test
// builds a fixed property-reply buffer and asserts the parsed result. No xcb,
// no GPU.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseStringProperty,
  parseWmClass,
  parseWmProtocols,
  parseNetWmState,
  parseNetWmWindowType,
  parseTransientFor,
  parseWmNormalHints,
  parseWmHints,
  parseStartupId,
  parseNetWmIcon,
  netWmStateToPresentation,
  classifyWindowType,
} from "../packages/core/dist/xwayland/properties.js";

// Synthetic atom values (the real values come from the X server's intern; this
// is what the property parsers see at runtime).
const ATOMS = {
  WM_PROTOCOLS: 100,
  WM_DELETE_WINDOW: 101,
  WM_TAKE_FOCUS: 102,
  UTF8_STRING: 103,
  _NET_WM_STATE_FULLSCREEN: 200,
  _NET_WM_STATE_MAXIMIZED_VERT: 201,
  _NET_WM_STATE_MAXIMIZED_HORZ: 202,
  _NET_WM_STATE_MODAL: 203,
  _NET_WM_WINDOW_TYPE_NORMAL: 300,
  _NET_WM_WINDOW_TYPE_DIALOG: 301,
  _NET_WM_WINDOW_TYPE_UTILITY: 302,
  _NET_WM_WINDOW_TYPE_MENU: 303,
  _NET_WM_WINDOW_TYPE_DROPDOWN_MENU: 304,
  _NET_WM_WINDOW_TYPE_POPUP_MENU: 305,
  _NET_WM_WINDOW_TYPE_TOOLTIP: 306,
  _NET_WM_WINDOW_TYPE_COMBO: 307,
};

// Helpers to build u32-array properties (X wire is little-endian on x86_64).
function u32(values) {
  const a = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) a[i] = values[i] >>> 0;
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}
function i32(values) {
  const a = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) a[i] = values[i] | 0;
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}
function bytes(arr) { return new Uint8Array(arr); }

function reply(format, replyType, data) {
  return { window: 1, atom: 1, cookieId: 1, replyType, format, data };
}

// ---- parseStringProperty -------------------------------------------------

test("parseStringProperty: UTF-8 _NET_WM_NAME decodes UTF-8", () => {
  const data = new TextEncoder().encode("hello, 世界");
  const got = parseStringProperty(reply(8, ATOMS.UTF8_STRING, data), ATOMS);
  assert.equal(got, "hello, 世界");
});

test("parseStringProperty: Latin-1 WM_NAME decodes byte-per-codepoint", () => {
  // 0xe9 = U+00E9 (é) in Latin-1. As UTF-8 it would be a continuation byte
  // and decode to U+FFFD; the parser must treat type!=UTF8_STRING as Latin-1.
  const data = bytes([0x68, 0xe9, 0x6c, 0x6c, 0x6f]);  // "héllo"
  const got = parseStringProperty(reply(8, /*STRING type*/ 31, data), ATOMS);
  assert.equal(got, "h\u00e9llo");
});

test("parseStringProperty: format=0 returns null", () => {
  const got = parseStringProperty(reply(0, 0, new Uint8Array(0)), ATOMS);
  assert.equal(got, null);
});

test("parseStringProperty: trims trailing NULs", () => {
  const data = new TextEncoder().encode("name\u0000");
  const got = parseStringProperty(reply(8, ATOMS.UTF8_STRING, data), ATOMS);
  assert.equal(got, "name");
});

// ---- parseWmClass --------------------------------------------------------

test("parseWmClass: two NUL-separated strings -> {instance, appId}", () => {
  // "xterm\0XTerm\0" -- the standard form.
  const data = bytes([0x78, 0x74, 0x65, 0x72, 0x6d, 0x00,  // "xterm\0"
                      0x58, 0x54, 0x65, 0x72, 0x6d, 0x00]); // "XTerm\0"
  const got = parseWmClass(reply(8, 31, data));
  assert.deepEqual(got, { instance: "xterm", appId: "XTerm" });
});

test("parseWmClass: missing separator -> appId only, instance empty", () => {
  const data = bytes([0x66, 0x6f, 0x6f]); // "foo"
  const got = parseWmClass(reply(8, 31, data));
  assert.deepEqual(got, { instance: "", appId: "foo" });
});

test("parseWmClass: format=0 returns null", () => {
  const got = parseWmClass(reply(0, 0, new Uint8Array(0)));
  assert.equal(got, null);
});

// ---- parseWmProtocols ----------------------------------------------------

test("parseWmProtocols: ATOM[] list -> Set", () => {
  const data = u32([ATOMS.WM_DELETE_WINDOW, ATOMS.WM_TAKE_FOCUS]);
  const got = parseWmProtocols(reply(32, 4 /*ATOM*/, data));
  assert.equal(got.size, 2);
  assert.ok(got.has(ATOMS.WM_DELETE_WINDOW));
  assert.ok(got.has(ATOMS.WM_TAKE_FOCUS));
});

test("parseWmProtocols: empty -> empty Set", () => {
  const got = parseWmProtocols(reply(32, 4, new Uint8Array(0)));
  assert.equal(got.size, 0);
});

test("parseWmProtocols: format!=32 -> empty Set", () => {
  const got = parseWmProtocols(reply(8, 4, bytes([1, 2, 3, 4])));
  assert.equal(got.size, 0);
});

// ---- parseNetWmState + netWmStateToPresentation --------------------------

test("netWmStateToPresentation: FULLSCREEN beats MAXIMIZED", () => {
  const data = u32([
    ATOMS._NET_WM_STATE_MAXIMIZED_VERT,
    ATOMS._NET_WM_STATE_FULLSCREEN,
  ]);
  const states = parseNetWmState(reply(32, 4, data));
  assert.equal(netWmStateToPresentation(states, ATOMS), "fullscreen");
});

test("netWmStateToPresentation: either MAXIMIZED bit -> 'maximized'", () => {
  const onlyVert = parseNetWmState(
    reply(32, 4, u32([ATOMS._NET_WM_STATE_MAXIMIZED_VERT])));
  assert.equal(netWmStateToPresentation(onlyVert, ATOMS), "maximized");
  const onlyHorz = parseNetWmState(
    reply(32, 4, u32([ATOMS._NET_WM_STATE_MAXIMIZED_HORZ])));
  assert.equal(netWmStateToPresentation(onlyHorz, ATOMS), "maximized");
});

test("netWmStateToPresentation: empty -> null", () => {
  const states = parseNetWmState(reply(32, 4, new Uint8Array(0)));
  assert.equal(netWmStateToPresentation(states, ATOMS), null);
});

// ---- parseNetWmWindowType + classifyWindowType ---------------------------

test("classifyWindowType: first-recognized wins", () => {
  // Client lists DIALOG first, then a custom atom (unrecognized) -> dialog.
  const types = parseNetWmWindowType(
    reply(32, 4, u32([ATOMS._NET_WM_WINDOW_TYPE_DIALOG, 9999])));
  assert.equal(classifyWindowType(types, ATOMS), "dialog");
});

test("classifyWindowType: all menu variants collapse to 'menu'", () => {
  assert.equal(classifyWindowType([ATOMS._NET_WM_WINDOW_TYPE_DROPDOWN_MENU], ATOMS), "menu");
  assert.equal(classifyWindowType([ATOMS._NET_WM_WINDOW_TYPE_POPUP_MENU], ATOMS), "menu");
  assert.equal(classifyWindowType([ATOMS._NET_WM_WINDOW_TYPE_MENU], ATOMS), "menu");
});

test("classifyWindowType: no recognized type -> null", () => {
  assert.equal(classifyWindowType([42, 43], ATOMS), null);
});

// ---- parseTransientFor ---------------------------------------------------

test("parseTransientFor: u32 window id", () => {
  const data = u32([0x1234abcd]);
  const got = parseTransientFor(reply(32, 33 /*WINDOW*/, data));
  assert.equal(got, 0x1234abcd);
});

test("parseTransientFor: zero -> null (no parent)", () => {
  const got = parseTransientFor(reply(32, 33, u32([0])));
  assert.equal(got, null);
});

test("parseTransientFor: absent -> null", () => {
  const got = parseTransientFor(reply(0, 0, new Uint8Array(0)));
  assert.equal(got, null);
});

// ---- parseWmNormalHints --------------------------------------------------

const PMinSize = 1 << 4;
const PMaxSize = 1 << 5;

function makeSizeHints({ flags, minW = 0, minH = 0, maxW = 0, maxH = 0 }) {
  // 18 fields, INT32: flags + 17 ignored/optional. We only set the ones the
  // parser reads at indices 5,6,7,8.
  const a = new Int32Array(18);
  a[0] = flags;
  a[5] = minW; a[6] = minH;
  a[7] = maxW; a[8] = maxH;
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

test("parseWmNormalHints: PMinSize | PMaxSize -> both sizes", () => {
  const data = makeSizeHints({ flags: PMinSize | PMaxSize,
                                minW: 320, minH: 200, maxW: 1920, maxH: 1080 });
  const got = parseWmNormalHints(reply(32, 41 /*WM_SIZE_HINTS*/, data));
  assert.deepEqual(got, {
    minSize: { width: 320, height: 200 },
    maxSize: { width: 1920, height: 1080 },
  });
});

test("parseWmNormalHints: PMinSize only -> maxSize null", () => {
  const data = makeSizeHints({ flags: PMinSize, minW: 100, minH: 50 });
  const got = parseWmNormalHints(reply(32, 41, data));
  assert.deepEqual(got, {
    minSize: { width: 100, height: 50 },
    maxSize: null,
  });
});

test("parseWmNormalHints: 0-or-negative size -> ignored even with flag", () => {
  const data = makeSizeHints({ flags: PMinSize | PMaxSize,
                                minW: 0, minH: 200, maxW: -1, maxH: 100 });
  const got = parseWmNormalHints(reply(32, 41, data));
  assert.deepEqual(got, { minSize: null, maxSize: null });
});

test("parseWmNormalHints: too-short buffer -> null", () => {
  const got = parseWmNormalHints(reply(32, 41, new Uint8Array(8)));
  assert.equal(got, null);
});

// ---- parseWmHints --------------------------------------------------------

test("parseWmHints: InputHint bit set, input=1 -> input: true", () => {
  const a = new Uint32Array(9);
  a[0] = 1;  // InputHint
  a[1] = 1;  // input = True
  const data = new Uint8Array(a.buffer);
  const got = parseWmHints(reply(32, 35 /*WM_HINTS*/, data));
  assert.deepEqual(got, { input: true });
});

test("parseWmHints: InputHint bit set, input=0 -> input: false (globally-active)", () => {
  const a = new Uint32Array(9);
  a[0] = 1;
  a[1] = 0;
  const got = parseWmHints(reply(32, 35, new Uint8Array(a.buffer)));
  assert.deepEqual(got, { input: false });
});

test("parseWmHints: InputHint bit not set -> input: null", () => {
  const a = new Uint32Array(9);
  a[0] = 0;
  a[1] = 1;
  const got = parseWmHints(reply(32, 35, new Uint8Array(a.buffer)));
  assert.deepEqual(got, { input: null });
});

// ---- parseStartupId ------------------------------------------------------

test("parseStartupId: ASCII id round-trips", () => {
  const id = "gnome-shell-12345-launcher_TIME67890";
  const data = new TextEncoder().encode(id);
  const got = parseStartupId(reply(8, 31 /*STRING*/, data));
  assert.equal(got, id);
});

test("parseStartupId: trailing NULs are trimmed", () => {
  const data = new Uint8Array([0x66, 0x6f, 0x6f, 0x00, 0x00]);
  assert.equal(parseStartupId(reply(8, 31, data)), "foo");
});

test("parseStartupId: absent property (format=0) -> null", () => {
  assert.equal(parseStartupId(reply(0, 0, new Uint8Array(0))), null);
});

test("parseStartupId: wrong format (32 instead of 8) -> null", () => {
  assert.equal(parseStartupId(reply(32, 31, u32([1, 2]))), null);
});

// ---- parseNetWmIcon ------------------------------------------------------

test("parseNetWmIcon: one 2x2 icon decoded", () => {
  // [width=2, height=2, p0..p3]
  const data = u32([2, 2, 0xff111111, 0xff222222, 0xff333333, 0xff444444]);
  const icons = parseNetWmIcon(reply(32, 6 /*CARDINAL*/, data));
  assert.equal(icons.length, 1);
  assert.equal(icons[0].width, 2);
  assert.equal(icons[0].height, 2);
  assert.deepEqual(Array.from(icons[0].pixels),
    [0xff111111, 0xff222222, 0xff333333, 0xff444444]);
});

test("parseNetWmIcon: multiple icons of different sizes", () => {
  const data = u32([
    1, 1, 0xff000001,                 // 1x1 icon
    2, 2, 0xff100000, 0xff200000, 0xff300000, 0xff400000,  // 2x2 icon
  ]);
  const icons = parseNetWmIcon(reply(32, 6, data));
  assert.equal(icons.length, 2);
  assert.equal(icons[0].width, 1); assert.equal(icons[0].height, 1);
  assert.equal(icons[1].width, 2); assert.equal(icons[1].height, 2);
  assert.deepEqual(Array.from(icons[1].pixels),
    [0xff100000, 0xff200000, 0xff300000, 0xff400000]);
});

test("parseNetWmIcon: truncated (declared 3x3 but only 4 pixels follow) -> stops cleanly", () => {
  const data = u32([3, 3, 1, 2, 3, 4]);
  const icons = parseNetWmIcon(reply(32, 6, data));
  assert.equal(icons.length, 0);
});

test("parseNetWmIcon: zero-dim icon is refused (malformed)", () => {
  const data = u32([0, 5, 1, 2, 3, 4, 5]);
  const icons = parseNetWmIcon(reply(32, 6, data));
  assert.equal(icons.length, 0);
});

test("parseNetWmIcon: absent property (format=0) -> []", () => {
  assert.deepEqual(parseNetWmIcon(reply(0, 0, new Uint8Array(0))), []);
});

test("parseNetWmIcon: wrong format (8 instead of 32) -> []", () => {
  assert.deepEqual(parseNetWmIcon(reply(8, 6, new Uint8Array(16))), []);
});
