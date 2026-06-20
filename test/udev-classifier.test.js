// Runs the native udev classifier unit test (build/udev-classifier-test) from
// the JS test suite: spawn it, assert exit 0 + "PASS" on stdout. GPU-free, no
// daemon dep, so it belongs in the default `npm test`. Skips if the binary
// has not been built (OVERDRAW_KMS off, or just hasn't been compiled yet).
//
// Mirrors test/wire-barrier.test.js (which runs build/wire-barrier-test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, "..", "packages", "core", "build", "udev-classifier-test");
const skip = existsSync(bin) ? false : "packages/core/build/udev-classifier-test not built (OVERDRAW_KMS off?)";

test("udev hotplug classifier: action + HOTPLUG -> Kind", { skip }, async () => {
  const { code, stdout, stderr } = await new Promise((resolve) => {
    execFile(bin, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
  assert.equal(code, 0, `udev-classifier-test exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /PASS/, "expected PASS on stdout");
});
