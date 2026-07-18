// Runs the native log unit test (build/log-test) and covers the JS-side
// --log-* argv parser. GPU-free, no Dawn dep, so it belongs in the default
// `npm test`. The native half skips if the binary has not been built.
// Mirrors test/wire-barrier.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseLogArgs } from "../packages/core/dist/log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, "..", "packages", "core", "build", "log-test");
const skip = existsSync(bin) ? false : "packages/core/build/log-test not built";

test("parseLogArgs: --log-level / --log-file / --no-log-file", () => {
  assert.deepEqual(parseLogArgs([]), {});
  assert.deepEqual(parseLogArgs(["--log-level=debug"]), { levelSpec: "debug" });
  assert.deepEqual(parseLogArgs(["--log-file=/x/y.log"]), { logFile: "/x/y.log" });
  assert.deepEqual(parseLogArgs(["--no-log-file"]), { noLogFile: true });
  assert.deepEqual(
    parseLogArgs(["--log-level=warn,gpu=trace", "--no-log-file", "other"]),
    { levelSpec: "warn,gpu=trace", noLogFile: true });
  // --log-file and --no-log-file both present: both reported; logInit's
  // disable wins over the path override.
  assert.deepEqual(
    parseLogArgs(["--log-file=/x.log", "--no-log-file"]),
    { logFile: "/x.log", noLogFile: true });
});

test("overdraw::log: areas, spec parser, IpcSink, state-dir paths, crash ring + reports", { skip }, async () => {
  const { code, stdout, stderr } = await new Promise((resolve) => {
    execFile(bin, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
  assert.equal(code, 0, `log-test exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /PASS/, "expected PASS on stdout");
});
