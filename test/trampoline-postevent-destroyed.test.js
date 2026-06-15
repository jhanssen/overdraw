// Posting an event to a resource whose client has gone must be a safe no-op,
// not a use-after-free.
//
// A resource wrapper handed to JS stores the wl_resource* in an N-API external
// whose value is immutable. When the client disconnects, libwayland frees the
// wl_resource and the trampoline's destroy listener marks the wrapper
// destroyed, but the external keeps pointing at the freed memory. If JS later
// posts an event to that stale wrapper (e.g. a broadcast loop that hasn't
// pruned the dead client yet), postEvent must not dereference the dangling
// pointer -- doing so reads freed memory (wl_resource_get_class -> a garbage
// class string -> strlen) and crashes. The same applies to clientId.
//
// This test captures a live surface wrapper, lets the client disconnect so the
// resource is destroyed, then drives postEvent/clientId on the now-dead wrapper
// and asserts they no-op without throwing or crashing, and that the server is
// still usable afterward.

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipUnless, loadAddon, registerAllSignatures, runClient, sleep } from "./server-helpers.mjs";

test("trampoline: postEvent/clientId on a destroyed resource are safe no-ops",
  { skip: skipUnless("wl-destructor-client") },
  async () => {
    const addon = loadAddon();
    const sock = addon.startServer();
    try {
      await registerAllSignatures(addon);

      const surfaces = [];
      addon.createGlobal("wl_compositor", {
        create_surface(_resource, surface) { surfaces.push(surface); },
        create_region(_resource, _region) {},
      });
      addon.registerInterface("wl_surface", { destroy() {} });
      addon.registerInterface("wl_region", { destroy() {} });

      const { code } = await runClient("wl-destructor-client", sock);
      assert.equal(code, 0, "client exited cleanly");
      assert.ok(surfaces.length >= 1, "captured at least one surface wrapper");

      // Wait for the server to process the client disconnect: every surface the
      // client created is destroyed (its destroy listener flips `destroyed`).
      const dead = surfaces[surfaces.length - 1];
      for (let i = 0; i < 300 && dead.destroyed !== true; i++) await sleep(10);
      assert.equal(dead.destroyed, true,
        "surface wrapper marked destroyed after client disconnect");

      // The wrapper's external still holds the freed wl_resource*. Posting to it
      // must dereference nothing: no throw, returns undefined (dropped), and the
      // process stays alive. opcode 0 (wl_surface.enter) with empty args -- the
      // liveness guard returns before args are read.
      assert.doesNotThrow(() => addon.postEvent(dead, 0, []),
        "postEvent to a destroyed resource does not throw");
      assert.equal(addon.postEvent(dead, 0, []), undefined,
        "postEvent to a destroyed resource is a no-op (undefined)");
      assert.equal(addon.clientId(dead), 0,
        "clientId of a destroyed resource is 0, not a dangling deref");

      // Server still works: a fresh client can connect and create a surface.
      const before = surfaces.length;
      const { code: code2 } = await runClient("wl-destructor-client", sock);
      assert.equal(code2, 0, "second client exited cleanly (server alive)");
      assert.ok(surfaces.length > before, "server still dispatches create_surface");
    } finally {
      addon.stopServer();
    }
  });
