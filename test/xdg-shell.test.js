// xdg-shell (GPU-free): install the JS protocol layer, run the xdg client. It
// creates a surface, gets an xdg_toplevel, sets title/app_id, and completes the
// configure handshake. The client exits non-zero unless the configure states
// wl_array (non-empty) arrived intact -- proving array encode. We also assert the
// server-side toplevel state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipUnless, loadAddon, runClient, sleep } from "./server-helpers.mjs";
import { inlineMasterStackDriverFactory } from "./wm-helpers.mjs";

test("xdg-shell: toplevel create + configure handshake + non-empty states array encode",
  { skip: skipUnless("xdg-test-client") },
  async () => {
    const addon = loadAddon();
    const { installProtocols } = await import("../packages/core/dist/protocols/index.js");
    const sock = addon.startServer();
    try {
      // No-op compositor sink: this GPU-free test exercises the protocol
      // handshake only (no rendering), so the compositing ops are stubs.
      const noopCompositor = {
        commitSurfaceBuffer: () => true, commitSurfaceDmabuf: () => true,
        setSurfaceLayout: () => {}, setStack: () => {}, removeSurface: () => {},
        takeImportedSurfaces: () => [], takeFreedBuffers: () => [],
      };
      // Inline layout driver so addWindow assigns a tile and the WM fires
      // the sized configure (xdg_toplevel.configure). The WM is
      // layout-policy-agnostic; without a driver it would never configure.
      const state = await installProtocols(addon, {
        compositor: noopCompositor,
        layoutDriverFactory: inlineMasterStackDriverFactory,
      });
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
