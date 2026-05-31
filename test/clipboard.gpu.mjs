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

const skip = canRunGpu() ? false : "needs GPU (WAYLAND_DISPLAY unset)";
const CLIP = buildBin("clipboard-test-client");
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
    const out = await receiver.waitForLine(/\[clipboard-client\] received: /, { what: "received line", timeoutMs: 5000 });
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

    const out = await receiver.waitForLine(/\[clipboard-client\] received: /, { what: "received line", timeoutMs: 5000 });
    const got = out.match(/\[clipboard-client\] received: (.*)/)[1].trim();
    assert.equal(got, PRIMARY, `primary selection payload round-trips; got "${got}"`);
  } finally {
    await c.teardown();
  }
});
