// zwlr_data_control_v1 (legacy data-control family) end-to-end: same
// exchange as ext-data-control.gpu.mjs but through the zwlr globals,
// which wl-clipboard <= 2.2.1 and older clipboard managers bind. Served
// by the shared handler in ext_data_control_v1.ts; this exercises the
// per-resource family dispatch (offer minting, selection burst, receive
// path) and the since-v2 primary_selection.
//
// Also asserts the whole point of the protocol: neither role maps a
// window (wl-copy's no-data-control fallback maps an invisible toplevel,
// which a tiler reflows around).

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const CLI = buildBin("zwlr-data-control-client");
const MIME = "text/plain;charset=utf-8";

async function exchangeOnce(c, mime, payload, primary) {
  const recvArgs = primary ? ["--primary", "--receive", mime] : ["--receive", mime];
  const recv = c.spawnClient(recvArgs, {
    bin: CLI, readyMarker: "[zwlr-dc-client] device ready",
  });
  await recv.ready;

  const srcArgs = primary
    ? ["--primary", "--source", mime, payload]
    : ["--source", mime, payload];
  const src = c.spawnClient(srcArgs, {
    bin: CLI, readyMarker: "[zwlr-dc-client] selection set",
  });
  await src.ready;

  const line = await recv.waitForLine(/\[zwlr-dc-client\] received: [^\n]*\n/,
    { what: "received line", timeoutMs: 5000 });
  return line.match(/\[zwlr-dc-client\] received: (.*)/)[1].trim();
}

test("zwlr_data_control: clipboard selection round-trips without keyboard focus",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 800, height: 600 } });
    try {
      const payload = "zwlr-data-control-clipboard-42";
      const got = await exchangeOnce(c, MIME, payload, false);
      assert.equal(got, payload,
        `clipboard payload round-trips through zwlr_data_control_v1; got "${got}"`);
      const snap = await c.query();
      assert.equal(snap.windows.length, 0,
        "data-control clients must not map windows");
    } finally {
      await c.teardown();
    }
  });

test("zwlr_data_control: primary selection round-trips without keyboard focus",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 800, height: 600 } });
    try {
      const payload = "zwlr-data-control-primary-7";
      const got = await exchangeOnce(c, MIME, payload, true);
      assert.equal(got, payload,
        `primary-selection payload round-trips through zwlr_data_control_v1; got "${got}"`);
    } finally {
      await c.teardown();
    }
  });
