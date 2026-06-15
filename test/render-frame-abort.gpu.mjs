// renderFrame error-path regression (A3).
//
// openImportBrackets writes Begin frames for every dmabuf import sampled this
// frame, and dispatches a frameSampled event per surface to the lifecycle. If
// either throws (writeBeginAccess returns false on a desync, or the lifecycle
// rejects an invariant violation), the lifecycle's frameStart MUST be rolled
// back via frameAborted -- otherwise every subsequent renderFrame throws
// "frame already in flight" forever.
//
// The fix moves bracket opening inside the renderFrame try/catch. This test
// verifies the contract by driving renderFrame directly:
//   1. Bring up a real dmabuf client (one surface, one cached import).
//   2. Render once cleanly so the import is wired into a surface.
//   3. Monkey-patch addon.writeBeginAccess to throw on the next call.
//      Call renderFrame: expect the synthetic error to surface.
//   4. Restore writeBeginAccess. Call renderFrame again: must succeed --
//      not throw "frame already in flight".

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { setupCompositor, canRunGpu, loadDawn, buildBin } from "./harness.mjs";

const skip = !canRunGpu() ? "needs GPU (no render node / dawn.node)"
  : (!loadDawn() ? "dawn.node not built" : false);
const OUT = { width: 800, height: 600 };

test("renderFrame: a throw from openImportBrackets rolls back the lifecycle frame",
  { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, jsCompositor: true });
  let client = null;
  try {
    client = spawn(buildBin("dmabuf-test-client"), [c.sock],
      { stdio: ["ignore", "pipe", "pipe"] });

    // Wait until the dmabuf is committed + imported. window appearing in
    // query() means the surface mapped; the import callback may still be
    // in flight, so also drive enough natural frames (the libuv timer in
    // setupCompositor calls renderFrame periodically) for the import to
    // resolve and bind to the surface. Detect resolution by spying on
    // writeBeginAccess -- the moment it fires, the bind happened.
    await c.waitFor(c.query, (s) => s.windows.length === 1,
      { what: "dmabuf window", timeoutMs: 3000 });

    const realWriteBeginAccess = c.addon.writeBeginAccess.bind(c.addon);
    let beginCount = 0;
    let armed = false;
    c.addon.writeBeginAccess = (importId) => {
      ++beginCount;
      if (armed) { armed = false; throw new Error("synthetic-A3-fault"); }
      return realWriteBeginAccess(importId);
    };
    // Wait until at least one natural Begin fires (import resolved + bound).
    const t0 = Date.now();
    while (beginCount === 0 && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 16));
    }
    assert.ok(beginCount > 0, "natural Begin fired (import resolved + bound)");

    // Arm the fault. The next renderFrame's openImportBrackets must throw
    // out of writeBeginAccess; renderFrame's catch must close opened
    // brackets and dispatch frameAborted.
    armed = true;

    // Faulted frame surfaces the synthetic error.
    let firstErr = null;
    try { c.jsCompositor.renderFrame(); }
    catch (e) { firstErr = e; }
    assert.ok(firstErr, "the faulted renderFrame threw");
    assert.match(String(firstErr), /synthetic-A3-fault/, "the synthetic error propagated");

    // Restore + render again. The lifecycle MUST accept the next frameStart;
    // a pre-fix renderFrame would throw "frame already in flight".
    c.addon.writeBeginAccess = realWriteBeginAccess;
    let secondErr = null;
    try { c.jsCompositor.renderFrame(); }
    catch (e) { secondErr = e; }
    if (secondErr) {
      assert.fail(`renderFrame after rollback threw (lifecycle wedged): ${secondErr}`);
    }
  } finally {
    if (client && client.exitCode === null && client.signalCode === null) {
      try { client.kill("SIGTERM"); } catch { /* gone */ }
      await once(client, "exit").catch(() => {});
    }
    await c.teardown();
  }
});
