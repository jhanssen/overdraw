// overdraw core entry point (Node-hosted).
//
// Node owns main() and the libuv event loop; the native addon holds the C++
// core. start() does one-shot bring-up then registers libuv handles (wire poll
// + frame timer) that drive presentation. The loop runs until we stop().

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const addon = require(join(__dirname, '..', 'build', 'overdraw_native.node'));
const gpuBin = process.env.OVERDRAW_GPU_PROCESS
  ?? join(__dirname, '..', 'build', 'overdraw-gpu-process');

const { width, height } = addon.start(gpuBin);
console.log(`[core/js] up; host window ${width}x${height}; libuv driving frames`);

// Run for a bounded time (the libuv frame timer keeps the loop alive), then
// stop. A real run would stop on window close / signal.
const runMs = Number(process.env.OVERDRAW_RUN_MS ?? 4000);
setTimeout(() => {
  const n = addon.presentedCount();
  addon.stop();
  console.log(`[core/js] presented ${n} frames over libuv; stopped cleanly`);
}, runMs);
