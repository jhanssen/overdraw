// Runs the native WireBarrier unit test (build/wire-barrier-test) from the JS
// test suite: spawn it, assert exit 0 + "PASS" on stdout. GPU-free, no Dawn
// dep, so it belongs in the default `npm test`. Skips if the binary has not
// been built.
//
// Mirrors test/scm-rights.test.js (which runs build/scm-rights-test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, "..", "build", "wire-barrier-test");
const skip = existsSync(bin) ? false : "build/wire-barrier-test not built (run cmake --build build)";

test("ipc::WireBarrier deferred-action FIFO + cancel + drainAll", { skip }, async () => {
  const { code, stdout, stderr } = await new Promise((resolve) => {
    execFile(bin, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
  assert.equal(code, 0, `wire-barrier-test exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /PASS/, "expected PASS on stdout");
});
