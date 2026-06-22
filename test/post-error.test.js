// wl_resource_post_error end-to-end: an illegal request must disconnect the
// client with the spec'd error code on the right interface.
//
// The server registers a minimal wl_surface whose set_buffer_scale posts
// wl_surface.invalid_scale (code 0) on a non-positive scale -- the same code
// the real handler posts. wl-error-client issues set_buffer_scale(0) and
// asserts it observes EPROTO + (code 0, wl_surface) before exiting 0. A
// regression (postError not wired, wrong code, or no disconnect) makes the
// client exit non-zero with a diagnostic on stderr.

import { test } from "node:test";
import assert from "node:assert/strict";
import { skipUnless, loadAddon, registerAllSignatures, runClient } from "./server-helpers.mjs";

test("postError: an illegal request disconnects the client with the spec error",
  { skip: skipUnless("wl-error-client") },
  async () => {
    const addon = loadAddon();
    const sock = addon.startServer();
    try {
      await registerAllSignatures(addon);

      addon.createGlobal("wl_compositor", {
        create_surface(_resource, _surface) {},
        create_region(_resource, _region) {},
      });
      // Minimal wl_surface: a non-positive buffer scale is invalid_scale (0).
      addon.registerInterface("wl_surface", {
        destroy() {},
        set_buffer_scale(resource, scale) {
          if (scale < 1) addon.postError(resource, 0, `invalid buffer scale ${scale}`);
        },
      });
      addon.registerInterface("wl_region", { destroy() {} });

      const { code, stdout, stderr } = await runClient("wl-error-client", sock);
      assert.equal(code, 0,
        `client should observe the protocol error and exit 0; stdout=${stdout} stderr=${stderr}`);
    } finally {
      addon.stopServer();
    }
  });
