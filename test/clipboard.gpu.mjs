// Clipboard (wl_data_device selection) end-to-end: a source client sets a
// selection (mime + payload); a receiver client (which maps a window to take
// keyboard focus, since selection goes to the focused client) gets the offer and
// reads the payload back over the pipe. Asserts the bytes round-trip.
//
// GPU-gated only because the receiver needs keyboard focus, which needs a mapped
// window (compositor). The clipboard data path itself is fd-pipe + protocol.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const CLIP = buildBin("clipboard-test-client");
const EXT_DC = buildBin("ext-data-control-client");
const ZWLR_DC = buildBin("zwlr-data-control-client");
const MIME = "text/plain;charset=utf-8";
const PAYLOAD = "overdraw-clipboard-roundtrip-42";

test("clipboard: selection set by source is received by the focused client", { skip }, async () => {
  const c = await setupCompositor({ headless: { width: 800, height: 600 } });
  try {
    // Receiver first: maps a window -> focus-on-map -> eligible for selection.
    const receiver = c.spawnClient(["--receive", MIME],
      { bin: CLIP, readyMarker: "[clipboard-client] receiver mapped" });
    await receiver.ready;
    await c.waitFor(c.query, (s) => s.keyboardFocus != null, { what: "receiver focused" });

    // Source sets the selection; the server should push the offer to the focused
    // receiver, which then receive()s and reads the payload.
    const source = c.spawnClient(["--source", MIME, PAYLOAD],
      { bin: CLIP, readyMarker: "[clipboard-client] selection set" });
    await source.ready;

    // The receiver exits 0 after printing what it read.
    const out = await receiver.waitForLine(/\[clipboard-client\] received: [^\n]*\n/, { what: "received line", timeoutMs: 5000 });
    const got = out.match(/\[clipboard-client\] received: (.*)/)[1].trim();
    assert.equal(got, PAYLOAD, `clipboard payload round-trips; got "${got}"`);
  } finally {
    await c.teardown();
  }
});

test("primary selection: middle-click selection round-trips to the focused client", { skip }, async () => {
  const c = await setupCompositor({ headless: { width: 800, height: 600 } });
  try {
    const PRIMARY = "overdraw-primary-selection-7";
    const receiver = c.spawnClient(["--primary", "--receive", MIME],
      { bin: CLIP, readyMarker: "[clipboard-client] receiver mapped" });
    await receiver.ready;
    await c.waitFor(c.query, (s) => s.keyboardFocus != null, { what: "receiver focused" });

    const source = c.spawnClient(["--primary", "--source", MIME, PRIMARY],
      { bin: CLIP, readyMarker: "[clipboard-client] selection set" });
    await source.ready;

    const out = await receiver.waitForLine(/\[clipboard-client\] received: [^\n]*\n/, { what: "received line", timeoutMs: 5000 });
    const got = out.match(/\[clipboard-client\] received: (.*)/)[1].trim();
    assert.equal(got, PRIMARY, `primary selection payload round-trips; got "${got}"`);
  } finally {
    await c.teardown();
  }
});

// Cross-protocol paste: a data-control client (clipboard manager,
// lan-mouse-style sync tool) owns the selection; a regular focused client
// pastes it through wl_data_device / zwp_primary_selection. Exercises the
// receive() forward from a wl-side offer to a data-control source -- a
// different source family than the same-protocol tests above, where the
// send event lives at a different opcode.
async function crossPaste(c, dcBin, dcMarker, payload, primary) {
  // Receiver first: maps a window -> focus-on-map -> eligible for selection.
  const recvArgs = primary ? ["--primary", "--receive", MIME] : ["--receive", MIME];
  const receiver = c.spawnClient(recvArgs,
    { bin: CLIP, readyMarker: "[clipboard-client] receiver mapped" });
  await receiver.ready;
  await c.waitFor(c.query, (s) => s.keyboardFocus != null, { what: "receiver focused" });

  const srcArgs = primary
    ? ["--primary", "--source", MIME, payload]
    : ["--source", MIME, payload];
  const src = c.spawnClient(srcArgs, { bin: dcBin, readyMarker: dcMarker });
  await src.ready;

  const out = await receiver.waitForLine(/\[clipboard-client\] received: [^\n]*\n/,
    { what: "received line", timeoutMs: 5000 });
  return out.match(/\[clipboard-client\] received: (.*)/)[1].trim();
}

test("clipboard: selection set via ext_data_control pastes into the focused client",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 800, height: 600 } });
    try {
      const payload = "ext-dc-to-wl-paste-13";
      const got = await crossPaste(c, EXT_DC, "[ext-dc-client] selection set", payload, false);
      assert.equal(got, payload,
        `ext_data_control-owned clipboard pastes via wl_data_device; got "${got}"`);
    } finally {
      await c.teardown();
    }
  });

test("clipboard: selection set via zwlr_data_control pastes into the focused client",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 800, height: 600 } });
    try {
      const payload = "zwlr-dc-to-wl-paste-29";
      const got = await crossPaste(c, ZWLR_DC, "[zwlr-dc-client] selection set", payload, false);
      assert.equal(got, payload,
        `zwlr_data_control-owned clipboard pastes via wl_data_device; got "${got}"`);
    } finally {
      await c.teardown();
    }
  });

test("primary selection: set via ext_data_control pastes into the focused client",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 800, height: 600 } });
    try {
      const payload = "ext-dc-to-wl-primary-5";
      const got = await crossPaste(c, EXT_DC, "[ext-dc-client] selection set", payload, true);
      assert.equal(got, payload,
        `ext_data_control-owned primary selection pastes via zwp_primary_selection; got "${got}"`);
    } finally {
      await c.teardown();
    }
  });
