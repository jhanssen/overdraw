// xdg-shell (GPU-free): install the JS protocol layer, run the xdg client. It
// creates a surface, gets an xdg_toplevel, sets title/app_id, and completes the
// configure handshake. The client exits non-zero unless the configure states
// wl_array (non-empty) arrived intact -- proving array encode. We also assert the
// server-side toplevel state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipUnless, loadAddon, runClient, sleep } from "./server-helpers.mjs";

test("xdg-shell: toplevel create + configure handshake + non-empty states array encode",
  { skip: skipUnless("xdg-test-client") },
  async () => {
    const addon = loadAddon();
    const { installProtocols } = await import("../dist/protocols/index.js");
    const sock = addon.startServer();
    try {
      const state = await installProtocols(addon);
      const { code } = await runClient("xdg-test-client", sock);
      assert.equal(code, 0, "client handshake + states-array intact (exit 0)");
      await sleep(100);

      const tl = state.toplevels ? [...state.toplevels.values()][0] : undefined;
      assert.ok(tl, "toplevel created");
      assert.equal(tl.title, "overdraw-test", "title recorded");
      assert.equal(tl.appId, "dev.overdraw.test", "app_id recorded");
      assert.equal(tl.xdgSurface?.role, "toplevel", "role assigned");
      assert.equal(tl.xdgSurface?.configured, true, "ack_configure observed");
    } finally {
      addon.stopServer();
    }
  });
