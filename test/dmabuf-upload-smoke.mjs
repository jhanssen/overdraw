// End-to-end linux-dmabuf-v1 test. Requires GPU + host Wayland. Brings up the
// compositor + server, installs protocols, runs a client that allocates a LINEAR
// ARGB8888 dmabuf filled with solid red, imports it via zwp_linux_dmabuf_v1,
// maps an xdg_toplevel and commits. The compositor imports the client dmabuf
// (zero-copy) and composites it; a GPU readback verifies the pixels.
//
// Red ARGB8888 -> WGPU BGRA8Unorm readback [0,0,255,255].

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

function fail(msg) { console.log(`[test] FAIL: ${msg}`); try { addon.stop(); } catch {} process.exit(1); }

let dims;
try { dims = addon.start(gpuBin); }
catch (e) { fail(`compositor bring-up failed (need GPU + host Wayland): ${e.message}`); }
console.log(`[test] compositor up; host window ${dims.width}x${dims.height}`);

const sock = addon.startServer();
console.log(`[test] server socket: ${sock}`);
const state = await installProtocols(addon);

let readback = null;

setTimeout(() => {
  execFile(join(repoRoot, 'build', 'dmabuf-test-client'), [sock], (err, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (err) console.error('[test] client error:', err.message);
  });
}, 200);

const started = Date.now();
let pending = false;
const poll = setInterval(() => {
  const id = state.lastCommittedSurfaceId;
  if (id != null && readback == null && !pending) {
    // Async readback: started returns true once the copy/map is kicked off; the
    // callback delivers pixels (or null) on the Node thread when the map lands.
    pending = addon.surfaceReadback(id, (px) => {
      pending = false;
      if (px) { readback = px; clearInterval(poll); finish(); }
    });
  }
  if (Date.now() - started > 6000) { clearInterval(poll); fail('timed out waiting for a committed dmabuf surface / readback'); }
}, 50);

function finish() {
  const W = 64, H = 64;
  const expect = [0, 0, 255, 255]; // BGRA red
  let bad = 0, checked = 0;
  const samples = [[0, 0], [W - 1, 0], [W / 2, H / 2], [0, H - 1], [W - 1, H - 1]];
  for (const [x, y] of samples) {
    const o = (y * W + x) * 4;
    checked++;
    for (let c = 0; c < 4; c++) if (readback[o + c] !== expect[c]) bad++;
  }
  const first = [readback[0], readback[1], readback[2], readback[3]];
  console.log(`[test] readback ${readback.length} bytes; first pixel BGRA=${JSON.stringify(first)}; ${checked} samples, ${bad} bad components`);
  console.log(`[test] frames presented: ${addon.presentedCount()}`);
  addon.stopServer();
  addon.stop();
  const pass = bad === 0;
  console.log(pass ? '[test] PASS: client dmabuf imported + composited + presented' : '[test] FAIL');
  process.exit(pass ? 0 : 1);
}
