// Unit tests for the pure helpers of the Xwayland selection bridge.
// GPU-free, addon-free: validates the MIME <-> X atom mapping, the atom-array
// parser, and the outgoing INCR-threshold decision.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mimeFromAtomName,
  atomNameFromMime,
  parseAtomArray,
  shouldSwitchToIncr,
} from "../packages/core/dist/xwayland/selection.js";

test("mimeFromAtomName: standard text atoms map to MIME types", () => {
  assert.equal(mimeFromAtomName("UTF8_STRING"), "text/plain;charset=utf-8");
  assert.equal(mimeFromAtomName("TEXT"), "text/plain");
  assert.equal(mimeFromAtomName("STRING"), "text/plain");
});

test("mimeFromAtomName: selection-protocol metadata atoms are dropped", () => {
  for (const name of ["TARGETS", "TIMESTAMP", "MULTIPLE", "DELETE", "INCR", "SAVE_TARGETS"]) {
    assert.equal(mimeFromAtomName(name), null, `expected ${name} to be dropped`);
  }
});

test("mimeFromAtomName: atom names containing '/' pass through as MIME", () => {
  assert.equal(mimeFromAtomName("image/png"), "image/png");
  assert.equal(mimeFromAtomName("text/html"), "text/html");
  assert.equal(mimeFromAtomName("application/x-custom"), "application/x-custom");
});

test("mimeFromAtomName: X-specific atoms without '/' are dropped", () => {
  // Without the heuristic, these would leak to wayland clients as MIME
  // strings the receivers cannot honor.
  assert.equal(mimeFromAtomName("_QT_TASKBAR_ICON"), null);
  assert.equal(mimeFromAtomName("COMPOUND_TEXT"), null);
  assert.equal(mimeFromAtomName("WM_NAME"), null);
});

test("atomNameFromMime: standard text MIMEs map back to atom names", () => {
  assert.equal(atomNameFromMime("text/plain;charset=utf-8"), "UTF8_STRING");
  assert.equal(atomNameFromMime("text/plain"), "TEXT");
});

test("atomNameFromMime: arbitrary MIMEs pass through verbatim", () => {
  assert.equal(atomNameFromMime("image/png"), "image/png");
  assert.equal(atomNameFromMime("application/octet-stream"), "application/octet-stream");
});

test("mime / atom-name round trip: text/plain;charset=utf-8 stable", () => {
  const atom = atomNameFromMime("text/plain;charset=utf-8");
  const mime = mimeFromAtomName(atom);
  assert.equal(mime, "text/plain;charset=utf-8");
});

test("mime / atom-name round trip: text/plain stable", () => {
  const atom = atomNameFromMime("text/plain");
  const mime = mimeFromAtomName(atom);
  assert.equal(mime, "text/plain");
});

test("mime / atom-name round trip: arbitrary MIME stable", () => {
  const atom = atomNameFromMime("image/png");
  const mime = mimeFromAtomName(atom);
  assert.equal(mime, "image/png");
});

test("parseAtomArray: empty buffer yields empty array", () => {
  assert.deepEqual(parseAtomArray(new Uint8Array(0)), []);
});

test("parseAtomArray: parses little-endian u32 array", () => {
  // Three atoms: 0x12345678, 0x00000001, 0xfffffffe.
  const bytes = new Uint8Array([
    0x78, 0x56, 0x34, 0x12,
    0x01, 0x00, 0x00, 0x00,
    0xfe, 0xff, 0xff, 0xff,
  ]);
  assert.deepEqual(parseAtomArray(bytes), [0x12345678, 0x00000001, 0xfffffffe]);
});

test("parseAtomArray: rounds down malformed (non-multiple-of-4) input", () => {
  const bytes = new Uint8Array([
    0x01, 0x00, 0x00, 0x00,
    0xff, 0xff, // trailing fragment, ignored
  ]);
  assert.deepEqual(parseAtomArray(bytes), [1]);
});

test("parseAtomArray: handles unaligned subarrays", () => {
  // A Uint8Array that is a non-4-byte-aligned view into a larger buffer.
  const big = new Uint8Array(16);
  for (let i = 0; i < 16; i++) big[i] = i;
  const view = big.subarray(1, 13);  // 12 bytes starting at offset 1
  // The parser must copy when byteOffset is not 4-aligned. Just verify it
  // returns 3 values (rather than throwing or producing garbage).
  const result = parseAtomArray(view);
  assert.equal(result.length, 3);
});

test("shouldSwitchToIncr: below the chunk-size threshold without EOF -> no", () => {
  assert.equal(shouldSwitchToIncr(0, false), false);
  assert.equal(shouldSwitchToIncr(1024, false), false);
  assert.equal(shouldSwitchToIncr(64 * 1024 - 1, false), false);
});

test("shouldSwitchToIncr: at or above the chunk-size threshold without EOF -> yes", () => {
  assert.equal(shouldSwitchToIncr(64 * 1024, false), true);
  assert.equal(shouldSwitchToIncr(128 * 1024, false), true);
});

test("shouldSwitchToIncr: with EOF -> no (the small-transfer path handles it)", () => {
  assert.equal(shouldSwitchToIncr(0, true), false);
  assert.equal(shouldSwitchToIncr(64 * 1024, true), false);
  assert.equal(shouldSwitchToIncr(1024 * 1024, true), false);
});
