// End-to-end shm buffer test. Requires the GPU process + a live host Wayland
// session (the compositor's full present pipeline runs). Brings up the
// compositor, starts the Wayland server, installs the protocol layer, runs an
// shm client that maps a window filled with a known solid blue, then reads the
// uploaded GPU texture back and verifies the pixels.
//
// Blue in ARGB8888 (0xFF0000FF) lands as BGRA8Unorm memory [B=255,G=0,R=0,A=255].

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

import { installProtocols } from '../dist/protocols/index.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const addon = require(join(repoRoot, 'build', 'overdraw_native.node'));
const gpuBin = process.env.OVERDRAW_GPU_PROCESS ?? join(repoRoot, 'build', 'overdraw-gpu-process');

function fail(msg) { console.log(`[test] FAIL: ${msg}`); addon.stop?.(); process.exit(1); }

let dims;
try {
  dims = addon.start(gpuBin); // brings up GPU process + swapchain (needs host Wayland)
} catch (e) {
  fail(`compositor bring-up failed (need GPU + host Wayland session): ${e.message}`);
}
console.log(`[test] compositor up; host window ${dims.width}x${dims.height}`);

const sock = addon.startServer();
console.log(`[test] server socket: ${sock}`);
const state = await installProtocols(addon);

let readback = null;

// Let the libuv loop (frame timer + wire poll + server poll) settle before the
// client connects, then run it.
setTimeout(() => {
  execFile(join(repoRoot, 'build', 'shm-test-client'), [sock], (err, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (err) console.error('[test] client error:', err.message);
  });
}, 200);

// Poll for the committed surface, read it back while the client holds it alive.
const started = Date.now();
const poll = setInterval(() => {
  const id = state.lastCommittedSurfaceId;
  if (id != null && readback == null) {
    const px = addon.surfaceReadback(id);
    if (px) {
      readback = px;
      clearInterval(poll);
      finish();
      return;
    }
  }
  if (Date.now() - started > 5000) {
    clearInterval(poll);
    fail('timed out waiting for a committed surface / readback');
  }
}, 50);

function finish() {
  // Check a few sampled pixels are solid blue: BGRA = [255,0,0,255].
  const W = 64, H = 64;
  const expect = [255, 0, 0, 255];
  let bad = 0, checked = 0;
  const samples = [[0, 0], [W - 1, 0], [W / 2, H / 2], [0, H - 1], [W - 1, H - 1]];
  for (const [x, y] of samples) {
    const o = (y * W + x) * 4;
    checked++;
    for (let c = 0; c < 4; c++) if (readback[o + c] !== expect[c]) bad++;
  }
  const first = [readback[0], readback[1], readback[2], readback[3]];
  console.log(`[test] readback ${readback.length} bytes; first pixel BGRA=${JSON.stringify(first)}; ${checked} samples, ${bad} bad components`);
  const presented = addon.presentedCount();
  console.log(`[test] frames presented: ${presented}`);

  addon.stopServer();
  addon.stop();
  const pass = bad === 0 && presented > 0;
  console.log(pass ? '[test] PASS: shm pixels uploaded + composited + presented' : '[test] FAIL');
  process.exit(pass ? 0 : 1);
}
