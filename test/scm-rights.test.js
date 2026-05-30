// Runs the native SCM_RIGHTS unit test (build/scm-rights-test) from the JS test
// suite: spawn it, assert exit 0 + "PASS" on stdout. GPU-free (a SEQPACKET
// socketpair + memfd), so it belongs in the default `npm test`. Skips if the
// binary has not been built.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, "..", "build", "scm-rights-test");
const skip = existsSync(bin) ? false : "build/scm-rights-test not built (run cmake --build build)";

test("SCM_RIGHTS fd passing over the side-channel transport", { skip }, async () => {
  const { code, stdout } = await new Promise((resolve) => {
    execFile(bin, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
  assert.equal(code, 0, `scm-rights-test exited ${code}\n${stdout}`);
  assert.match(stdout, /PASS/, "expected PASS on stdout");
});
