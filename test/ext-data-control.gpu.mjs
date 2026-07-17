// ext_data_control_v1 end-to-end: a source client sets a selection via the
// control protocol; a separate receiver client (which does NOT map a window,
// the whole point of this protocol) gets the offer and reads the payload.
//
// Same shape as the wl_data_device clipboard test except neither role needs
// a wl_keyboard focus. Two assertions: the clipboard direction, and the
// primary-selection direction.
//
// GPU-gated because setupCompositor needs the GPU process; the data path
// itself is fd-pipe + protocol.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const CLI = buildBin("ext-data-control-client");
const MIME = "text/plain;charset=utf-8";

async function exchangeOnce(c, mime, payload, primary) {
  // Receiver first so its device is bound before the source claims the
  // selection. The client prints "device ready" after the initial roundtrip.
  const recvArgs = primary ? ["--primary", "--receive", mime] : ["--receive", mime];
  const recv = c.spawnClient(recvArgs, {
    bin: CLI, readyMarker: "[ext-dc-client] device ready",
  });
  await recv.ready;

  const srcArgs = primary
    ? ["--primary", "--source", mime, payload]
    : ["--source", mime, payload];
  const src = c.spawnClient(srcArgs, {
    bin: CLI, readyMarker: "[ext-dc-client] selection set",
  });
  await src.ready;

  const line = await recv.waitForLine(/\[ext-dc-client\] received: [^\n]*\n/,
    { what: "received line", timeoutMs: 5000 });
  return line.match(/\[ext-dc-client\] received: (.*)/)[1].trim();
}

test("ext_data_control: clipboard selection round-trips without keyboard focus",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 800, height: 600 } });
    try {
      const payload = "ext-data-control-clipboard-42";
      const got = await exchangeOnce(c, MIME, payload, false);
      assert.equal(got, payload,
        `clipboard payload round-trips through ext_data_control_v1; got "${got}"`);
    } finally {
      await c.teardown();
    }
  });

test("ext_data_control: primary selection round-trips without keyboard focus",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 800, height: 600 } });
    try {
      const payload = "ext-data-control-primary-7";
      const got = await exchangeOnce(c, MIME, payload, true);
      assert.equal(got, payload,
        `primary-selection payload round-trips through ext_data_control_v1; got "${got}"`);
    } finally {
      await c.teardown();
    }
  });
