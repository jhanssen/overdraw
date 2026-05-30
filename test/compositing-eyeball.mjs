// Eyeball test for multi-surface placement + stacking + blending.
// Requires GPU + host Wayland. Brings up the compositor, installs protocols,
// then spawns two long-lived solid-color clients. The placement stub cascades
// them at distinct positions; you should SEE two differently-colored squares at
// different spots in the overdraw window (not one full-screen square).
//
// Quit with ctrl-c; the clients and compositor are torn down.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { installProtocols } from '../src/protocols/index.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const addon = require(join(repoRoot, 'build', 'overdraw_native.node'));
const gpuBin = process.env.OVERDRAW_GPU_PROCESS ?? join(repoRoot, 'build', 'overdraw-gpu-process');
const clientBin = join(repoRoot, 'build', 'color-client');

const children = [];
function cleanup() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch {} }
  try { addon.stopServer(); } catch {}
  try { addon.stop(); } catch {}
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

let state = null;
const onInput = (ev) => state?.seat?.handleInput(ev);

let dims;
try {
  dims = addon.start(gpuBin, null, onInput);
} catch (e) {
  console.log(`[test] FAIL bring-up (need GPU + host Wayland): ${e.message}`);
  process.exit(1);
}
console.log(`[test] compositor up; output ${dims.width}x${dims.height}`);

const sock = addon.startServer();
console.log(`[test] server socket: ${sock}`);
state = await installProtocols(addon, { width: dims.width, height: dims.height });

function spawnClient(argbHex, w, h, title, delayMs) {
  setTimeout(() => {
    const c = spawn(clientBin, [sock, argbHex, String(w), String(h), title], {
      stdio: 'inherit',
    });
    children.push(c);
  }, delayMs);
}

// Two distinct colors/sizes. ARGB8888 hex. Red and green.
spawnClient('FFFF0000', 300, 300, 'red', 300);
spawnClient('FF00FF00', 350, 250, 'green', 800);

console.log('[test] spawning two color clients; look at the overdraw window.');
console.log('[test] expect: a red 300x300 and a green 350x250 square at DIFFERENT positions.');
console.log('[test] ctrl-c to quit.');
