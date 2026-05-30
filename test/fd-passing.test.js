// fd passing (GPU-free): a client calls wl_shm.create_pool with an fd; the JS
// handler receives it as a WaylandFd, takes the raw fd via takeRawFd(), and
// reads back the client's marker bytes. Proves request fd-arg decode + the
// WaylandFd ownership transfer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readSync, closeSync } from "node:fs";
import { skipUnless, loadAddon, registerAllSignatures, runClient, sleep } from "./server-helpers.mjs";

test("fd-passing: create_pool delivers a readable WaylandFd with the client's marker",
  { skip: skipUnless("fd-test-client") },
  async () => {
    const addon = loadAddon();
    const sock = addon.startServer();
    try {
      await registerAllSignatures(addon);
      let gotFd = false;
      let markerOk = false;
      addon.createGlobal("wl_shm", {
        create_pool(_resource, _pool, fd, _size) {
          gotFd = !!fd && typeof fd.takeRawFd === "function" && !fd.closed && fd.fd > 0;
          const raw = fd.takeRawFd();
          if (raw >= 0) {
            try {
              const buf = Buffer.alloc(32);
              readSync(raw, buf, 0, buf.length, 0);
              markerOk = buf.toString("latin1").startsWith("OVERDRAW_FD_OK");
            } finally {
              closeSync(raw);
            }
          }
        },
      });

      const { code } = await runClient("fd-test-client", sock);
      assert.equal(code, 0, "client exited cleanly");
      await sleep(100);
      assert.ok(gotFd, "create_pool received a valid WaylandFd");
      assert.ok(markerOk, "fd read back the client's marker bytes");
    } finally {
      addon.stopServer();
    }
  });
