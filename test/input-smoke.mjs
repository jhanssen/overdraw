// Interactive input-forwarding test. Requires the GPU process + a live host
// Wayland session. Unlike the other smoke tests this CANNOT be fully automated:
// pointer/keyboard events only arrive when a real user moves the mouse over the
// overdraw window and types into it. The host delivers input to the GPU
// process's host wl_surface; the GPU process forwards it over the input socket;
// the core's WaylandInputBackend normalizes it and calls the onInput callback.
//
// Usage:
//   WAYLAND_DISPLAY=... node test/input-smoke.mjs
//
// Then, while the overdraw window is focused, move the pointer over it, click,
// scroll, and press a few keys. The test prints each normalized event and
// passes once it has seen at least one pointer-motion AND one button or key
// event (proving both pointer and click/key paths). Times out after ~20s with
// guidance if no input is seen (e.g. window not focused, or no seat on host).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const addon = require(join(repoRoot, 'build', 'overdraw_native.node'));
const gpuBin = process.env.OVERDRAW_GPU_PROCESS ?? join(repoRoot, 'build', 'overdraw-gpu-process');

const TIMEOUT_MS = Number(process.env.INPUT_TIMEOUT_MS ?? 20000);

function done(pass, msg) {
  console.log(pass ? `[test] PASS: ${msg}` : `[test] FAIL: ${msg}`);
  try { addon.stop(); } catch {}
  process.exit(pass ? 0 : 1);
}

// Event tallies. Pass requires motion + (button or key).
const seen = {
  pointerEnter: 0, pointerLeave: 0, pointerMotion: 0,
  pointerButton: 0, pointerAxis: 0, pointerFrame: 0,
  keyboardEnter: 0, keyboardLeave: 0, keyboardKey: 0, keyboardModifiers: 0,
};

function onInput(ev) {
  if (ev.type in seen) seen[ev.type]++;

  // Print a compact, type-specific line. Motion/frame are noisy; sample them.
  switch (ev.type) {
    case 'pointerMotion':
      if (seen.pointerMotion % 15 === 1)  // ~every 15th to avoid flooding
        console.log(`[ev] motion x=${ev.x.toFixed(1)} y=${ev.y.toFixed(1)}`);
      break;
    case 'pointerFrame':
      break;  // silent; just tallied
    case 'pointerEnter':
      console.log(`[ev] pointerEnter x=${ev.x.toFixed(1)} y=${ev.y.toFixed(1)} serial=${ev.serial}`);
      break;
    case 'pointerLeave':
      console.log(`[ev] pointerLeave serial=${ev.serial}`);
      break;
    case 'pointerButton':
      console.log(`[ev] button=${ev.button} ${ev.pressed ? 'press' : 'release'} serial=${ev.serial}`);
      break;
    case 'pointerAxis':
      console.log(`[ev] axis ${ev.horizontal ? 'horiz' : 'vert'} value=${ev.value} discrete=${ev.discrete}`);
      break;
    case 'keyboardKey':
      console.log(`[ev] key(evdev)=${ev.key} ${ev.pressed ? 'press' : 'release'} serial=${ev.serial}`);
      break;
    case 'keyboardModifiers':
      console.log(`[ev] mods depressed=${ev.modsDepressed} latched=${ev.modsLatched} locked=${ev.modsLocked} group=${ev.group}`);
      break;
    case 'keyboardEnter':
      console.log(`[ev] keyboardEnter serial=${ev.serial}`);
      break;
    case 'keyboardLeave':
      console.log(`[ev] keyboardLeave serial=${ev.serial}`);
      break;
  }

  // Pass condition: saw movement and at least one discrete interaction.
  if (seen.pointerMotion > 0 && (seen.pointerButton > 0 || seen.keyboardKey > 0)) {
    console.log(`[test] tallies: ${JSON.stringify(seen)}`);
    done(true, 'pointer motion + button/key events forwarded to JS');
  }
}

let dims;
try {
  dims = addon.start(gpuBin, null, onInput);
} catch (e) {
  done(false, `compositor bring-up failed (need GPU + host Wayland session): ${e.message}`);
}
console.log(`[test] compositor up; host window ${dims.width}x${dims.height}`);
console.log('[test] Move the pointer over the overdraw window, click, and press a key.');
console.log(`[test] Waiting up to ${TIMEOUT_MS / 1000}s for input...`);

setTimeout(() => {
  console.log(`[test] tallies: ${JSON.stringify(seen)}`);
  const any = Object.values(seen).some((n) => n > 0);
  if (!any) {
    done(false, 'no input events at all. Is the overdraw window focused? ' +
      'Does the host advertise a wl_seat? Is the pointer actually over the window?');
  }
  done(false, 'saw some input but not both motion and a button/key. Try clicking and typing.');
}, TIMEOUT_MS);
