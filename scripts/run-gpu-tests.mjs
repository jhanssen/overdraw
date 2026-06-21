// Wrapper around `node --test` for the GPU suite that:
//
//   1. Forces the Vulkan validation layer ON via VK_LAYER_PATH +
//      VK_INSTANCE_LAYERS + VK_LOAD_LAYERS_ENABLE, so every GPU-process
//      Vulkan call is validated. node --test inherits the layer; the
//      GPU child it spawns inherits it from there.
//   2. Tees the child's stdout/stderr to our own stdout/stderr so the
//      test output appears interactively AND is captured in memory.
//   3. Scans the captured stream for VUID errors. Vulkan validation
//      writes "Error: VUID-..." lines on stderr; without this scan
//      they slip through because node --test only checks per-test
//      assertions, not the GPU child's stderr.
//   4. If any validation error appeared, exits non-zero with a summary
//      block (each unique VUID + count) regardless of whether the
//      underlying test runner exited cleanly. Otherwise propagates
//      the child's exit code.
//
// Run via `npm run test:gpu` (which now calls this script).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const VALIDATION_LAYER_PATH = "/usr/share/vulkan/explicit_layer.d";

// Bail early with a clear message if the layer JSON isn't where we expect.
// Otherwise the layer silently does nothing and the test suite "passes"
// without validation -- the exact gap this script exists to close.
const layerJson = `${VALIDATION_LAYER_PATH}/VkLayer_khronos_validation.json`;
if (!existsSync(layerJson)) {
  console.error(
    `run-gpu-tests: Vulkan validation layer manifest not found at ${layerJson}.\n` +
    `Install vulkan-validation-layers (or set VK_LAYER_PATH to its location).`);
  process.exit(2);
}

const env = {
  ...process.env,
  VK_LAYER_PATH: VALIDATION_LAYER_PATH,
  VK_INSTANCE_LAYERS: "VK_LAYER_KHRONOS_validation",
  VK_LOAD_LAYERS_ENABLE: "*validation*",
};

const args = [
  "--test",
  "--test-concurrency=1",
  "test/**/*.gpu.mjs",
];

const child = spawn(process.execPath, args, {
  env,
  stdio: ["inherit", "pipe", "pipe"],
});

const captured = { out: "", err: "" };
child.stdout.on("data", (chunk) => {
  const s = chunk.toString("utf8");
  captured.out += s;
  process.stdout.write(s);
});
child.stderr.on("data", (chunk) => {
  const s = chunk.toString("utf8");
  captured.err += s;
  process.stderr.write(s);
});

child.on("exit", (code, signal) => {
  // Scan both streams. Validation usually lands on stderr (the layer prints
  // there); GPU-child stderr in this codebase ALSO lands on stdout when the
  // parent's terminal is line-buffered, so check both to be safe.
  const combined = captured.out + "\n" + captured.err;
  const vuidLines = combined.split("\n")
    .filter((l) => /Error: VUID-/.test(l));
  const childExitOk = signal === null && code === 0;

  if (vuidLines.length > 0) {
    const counts = new Map();
    for (const l of vuidLines) {
      const m = l.match(/Error: (VUID-[A-Za-z0-9_-]+)/);
      if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    console.error("\n=========================================");
    console.error(`run-gpu-tests: ${vuidLines.length} Vulkan validation error(s) observed`);
    console.error("=========================================");
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [vuid, n] of sorted) {
      console.error(`  ${n.toString().padStart(4)}  ${vuid}`);
    }
    console.error("=========================================");
    console.error("Failing the run. Reproduce with:");
    console.error(`  VK_LAYER_PATH=${VALIDATION_LAYER_PATH} \\`);
    console.error("    VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation \\");
    console.error("    VK_LOAD_LAYERS_ENABLE='*validation*' \\");
    console.error(`    node ${args.join(" ")}`);
    process.exit(childExitOk ? 1 : (code ?? 1));
  }

  if (signal !== null) {
    console.error(`run-gpu-tests: child terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on("error", (e) => {
  console.error(`run-gpu-tests: failed to spawn node --test: ${e.message}`);
  process.exit(1);
});
