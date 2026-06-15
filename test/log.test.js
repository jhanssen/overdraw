// Runs the native log unit test (build/log-test). GPU-free, no Dawn dep, so
// it belongs in the default `npm test`. Skips if the binary has not been
// built. Mirrors test/wire-barrier.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, "..", "packages", "core", "build", "log-test");
const skip = existsSync(bin) ? false : "packages/core/build/log-test not built";

test("overdraw::log: areas, --log-level spec parser, IpcSink fragmentation + pre-fd ring", { skip }, async () => {
  const { code, stdout, stderr } = await new Promise((resolve) => {
    execFile(bin, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
  assert.equal(code, 0, `log-test exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /PASS/, "expected PASS on stdout");
});
