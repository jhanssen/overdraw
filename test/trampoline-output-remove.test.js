// Per-output global removal must not free state under bound resources.
//
// A wl_resource bound through createGlobalForOutput keeps dispatching into
// its InterfaceState after destroyGlobalForOutput: the well-behaved client
// reaction to wl_registry.global_remove is wl_output.release -- a request
// on exactly such a resource. The trampoline parks the state until the last
// bound resource is destroyed and drops requests for it (destructors still
// release the server-side resource). Without the parking, the release
// dispatches through freed memory and segfaults the compositor -- this test
// runs the server in-process, so a regression crashes the test run itself.
//
// Also covered: re-advertising the same (interface, outputId) key routes
// through the removal path rather than overwriting (and thus freeing) the
// previous InterfaceState in place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipUnless, loadAddon, registerAllSignatures, runClient } from "./server-helpers.mjs";

test("trampoline: wl_output.release after per-output global removal",
  { skip: skipUnless("output-remove-client") },
  async () => {
    const addon = loadAddon();
    const sock = addon.startServer();
    try {
      await registerAllSignatures(addon);

      // Advertise, then re-advertise at the same key before any client
      // exists: the first state must be torn down via the removal path.
      addon.createGlobalForOutput("wl_output", 0, { bind() {} });
      let bound = 0;
      addon.createGlobalForOutput("wl_output", 0, {
        bind() {
          bound++;
          // Remove the global after the bind completes; the client holds a
          // live wl_output resource across the removal.
          setImmediate(() => addon.destroyGlobalForOutput("wl_output", 0));
        },
      });

      const { code, stdout, stderr } = await runClient("output-remove-client", sock);
      assert.equal(code, 0, `client exited cleanly (stdout=${stdout} stderr=${stderr})`);
      assert.equal(bound, 1, "client bound the re-advertised per-output global once");
      assert.match(stdout, /released, server alive/);
    } finally {
      addon.stopServer();
    }
  });
