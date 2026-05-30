// Server-only: the Wayland server stands up and returns a socket name. GPU-free.
// See server-helpers.mjs for why each server test is its own file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { haveAddon, loadAddon } from "./server-helpers.mjs";

test("server: starts + stops, returns a socket name",
  { skip: haveAddon ? false : "addon not built" }, () => {
    const addon = loadAddon();
    const sock = addon.startServer();
    try {
      assert.ok(typeof sock === "string" && sock.length > 0, "socket name");
    } finally {
      addon.stopServer();
    }
  });
