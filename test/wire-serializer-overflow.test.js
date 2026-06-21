// Runs the native wire-serializer-overflow-test (build/wire-serializer-overflow-test)
// from the JS suite. Drives the FdSerializer with many GetCmdSpace calls whose
// cumulative bytes exceed kCapacity (16 MiB) and verifies bytes round-trip.
// Catches the silent-drop bug where GetCmdSpace returned nullptr on batch
// overflow (Dawn auto-chunks large writeTexture/writeBuffer into 1 MiB
// sub-commands; ~16 such chunks fill the batch and every subsequent chunk
// was being dropped).
//
// GPU-free, no Dawn-device dep -- just the wire serializer + a socketpair.
// Skips if the binary has not been built.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, "..", "packages", "core", "build", "wire-serializer-overflow-test");
const skip = existsSync(bin) ? false : "packages/core/build/wire-serializer-overflow-test not built";

test("FdSerializer GetCmdSpace handles batch overflow (auto-flush+retry)", { skip, timeout: 30000 }, async () => {
  const { code, stdout, stderr } = await new Promise((resolve) => {
    execFile(bin, { timeout: 25000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
  assert.equal(code, 0,
    `wire-serializer-overflow-test exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /PASS/, "expected PASS on stdout");
});
