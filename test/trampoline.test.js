// Trampoline (GPU-free): a real libwayland client binds wl_compositor and calls
// create_surface; the JS handler must fire with a wl_surface resource, send an
// event back (generated event-sender path), and the wrapper must invalidate when
// the client destroys the surface. Proves generator metadata drives real
// libwayland dispatch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipUnless, loadAddon, registerAllSignatures, runClient, sleep } from "./server-helpers.mjs";

test("trampoline: create_surface fires the JS handler; wrapper invalidated on destroy",
  { skip: skipUnless("wl-test-client") },
  async () => {
    const addon = loadAddon();
    const sock = addon.startServer();
    try {
      const mods = await registerAllSignatures(addon);
      const surfaceEvents = mods["wl_surface"].makeEvents(addon.postEvent);

      let created = false;
      let stashedSurface = null;
      addon.createGlobal("wl_compositor", {
        create_surface(_resource, surface) {
          created = true;
          stashedSurface = surface;
          surfaceEvents.send_preferred_buffer_scale(surface, 2);
        },
      });

      const { code } = await runClient("wl-test-client", sock);
      assert.equal(code, 0, "client exited cleanly");
      await sleep(100);
      assert.ok(created, "create_surface handler fired");
      assert.equal(stashedSurface?.destroyed, true, "surface wrapper invalidated after destroy");
    } finally {
      addon.stopServer();
    }
  });
