// ext_foreign_toplevel_list_v1 end-to-end: spawn a normal xdg_toplevel
// client (the harness client), then start a separate ext-ftl-client and
// verify it sees exactly that toplevel via the catch-up path. Also
// verify a NEWLY-mapped toplevel arrives via the lifecycle event hook.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const FTL = buildBin("ext-foreign-toplevel-client");

test("ext_foreign_toplevel_list: catch-up + new toplevel via the lifecycle hook",
  { skip }, async () => {
    const c = await setupCompositor({ headless: { width: 800, height: 600 } });
    try {
      // First toplevel: spawn the harness client. Wait for it to map so
      // the WM state has the window before we bind ext_foreign_toplevel_list.
      const a = c.spawnClient(["--title", "first", "--app-id", "app.a"]);
      await a.ready;
      await c.waitFor(c.query, (s) => s.windows.length >= 1,
        { what: "first toplevel mapped" });

      // Now start the ext-ftl client; the bind catch-up loop should emit
      // a `toplevel` event for `a`.
      const ftl = c.spawnClient(["--expect", "2", "--timeout-ms", "5000"],
        { bin: FTL, readyMarker: "[ext-ftl-client] ready" });
      await ftl.ready;

      // Wait for the first toplevel line. (catch-up)
      await ftl.waitForLine(/toplevel id=.*app_id=app\.a/,
        { what: "first toplevel via catch-up", timeoutMs: 4000 });

      // Map a second toplevel; the lifecycle hook should produce a fresh
      // `toplevel` event for it.
      const b = c.spawnClient(["--title", "second", "--app-id", "app.b"]);
      await b.ready;
      await c.waitFor(c.query, (s) => s.windows.length >= 2,
        { what: "second toplevel mapped" });

      // Wait for the second toplevel line. (lifecycle event hook)
      await ftl.waitForLine(/toplevel id=.*app_id=app\.b/,
        { what: "second toplevel via lifecycle event", timeoutMs: 4000 });

      // The client exits 0 after seeing both.
      const summary = await ftl.waitForLine(/\[ext-ftl-client\] done /,
        { what: "summary line", timeoutMs: 4000 });
      assert.match(summary, /ok=1/, `ok=1 in summary; got:\n${summary}`);

      // Verify both identifiers were unique (the spec's stability + no-reuse
      // requirement).
      const ids = [];
      for (const line of summary.split("\n")) {
        const m = line.match(/toplevel id=([^ ]+)/);
        if (m) ids.push(m[1]);
      }
      assert.equal(ids.length, 2, `two toplevel lines; got ${ids.length}`);
      assert.notEqual(ids[0], ids[1], `identifiers must be distinct; got '${ids[0]}' '${ids[1]}'`);
    } finally {
      await c.teardown();
    }
  });
