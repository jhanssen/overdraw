// Trampoline auto-destroy on destructor requests (A2).
//
// The trampoline must call wl_resource_destroy on the libwayland resource
// after dispatching any request marked type="destructor" in the protocol
// XML (wl_buffer.destroy, wl_surface.destroy, wl_pointer.release, ...).
// Without this, the per-protocol JS handler can clean its TS maps but the
// libwayland resource and its napi_ref leak for the client's lifetime --
// one leaked resource + ref per wl_surface.frame callback per frame per
// surface, the worst case called out in the review.
//
// The destructor client creates two surfaces, destroys s1, then makes a
// fresh request (create_region) on the same wl_compositor. The handler
// captures both surfaces and asserts s1.destroyed === true when the
// create_region trigger fires -- WHILE the client is still connected, so
// the destruction can only come from the trampoline's auto-destroy on the
// destructor request, not from client-disconnect cleanup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipUnless, loadAddon, registerAllSignatures, runClient } from "./server-helpers.mjs";

test("trampoline: destructor request triggers wl_resource_destroy before client disconnect",
  { skip: skipUnless("wl-destructor-client") },
  async () => {
    const addon = loadAddon();
    const sock = addon.startServer();
    try {
      await registerAllSignatures(addon);

      let s1 = null;
      let s2 = null;
      let s1DestroyedAtTrigger = null;
      addon.createGlobal("wl_compositor", {
        create_surface(_resource, surface) {
          if (!s1) s1 = surface;
          else s2 = surface;
        },
        create_region(_resource, _region) {
          // Trigger fires AFTER s1 was destroyed by the client. The trampoline
          // must have already destroyed s1 (synchronously, in onDispatch after
          // the destroy handler returned), so s1.destroyed is true now while
          // the client is still connected.
          s1DestroyedAtTrigger = s1?.destroyed === true;
        },
      });
      // Register wl_surface and wl_region with no-op handlers so their
      // destructor requests dispatch (the trampoline needs the registration).
      addon.registerInterface("wl_surface", { destroy() {} });
      addon.registerInterface("wl_region", { destroy() {} });

      const { code, stdout, stderr } = await runClient("wl-destructor-client", sock);
      assert.equal(code, 0, `client exited cleanly (stdout=${stdout} stderr=${stderr})`);

      assert.ok(s1, "create_surface fired once");
      assert.ok(s2, "create_surface fired twice");
      assert.equal(s1DestroyedAtTrigger, true,
        "s1.destroyed === true at the moment create_region fired (trampoline auto-destroyed)");
      assert.equal(s1.destroyed, true, "s1 stays destroyed after run");
      // s2 was destroyed by the client at exit, so it MAY be destroyed by now
      // (disconnect-time cleanup) -- this test doesn't assert on s2's final
      // state.
    } finally {
      addon.stopServer();
    }
  });
