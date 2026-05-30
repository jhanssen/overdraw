// Minimal protocol loader. Imports every generated interface signature, builds
// the runtime wl_interfaces in the native trampoline, then wires the handwritten
// handler modules: globals (clients bind these) via createGlobal, and
// request-created interfaces (xdg_surface, xdg_toplevel, ...) via
// registerInterface. Each handler module exports a factory that receives a
// context { events, state } and returns the handler object the trampoline calls.
//
// This is deliberately minimal: no C++/core-JS/plugin layering or override
// semantics (architecture.md "implementation layers") yet. That machinery is
// only meaningful once plugins exist; it grows in when that track lands.

import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { createWm } from '../wm/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const genDir = join(__dirname, '..', 'protocols-gen');

// Interfaces advertised as globals (clients bind them from the registry).
const GLOBALS = ['wl_compositor', 'xdg_wm_base', 'wl_shm', 'zwp_linux_dmabuf_v1', 'wl_seat'];

// Interfaces created via requests (new_id), registered without a global so
// their child resources dispatch to a handler.
const CHILD_INTERFACES = [
  'wl_surface', 'wl_region', 'xdg_surface', 'xdg_toplevel',
  'wl_shm_pool', 'wl_buffer', 'zwp_linux_buffer_params_v1',
  'wl_pointer', 'wl_keyboard',
];

// Load all generated signature modules, keyed by interface name.
async function loadSignatures() {
  const mods = new Map();
  for (const f of readdirSync(genDir)) {
    if (!f.endsWith('.js')) continue;
    const m = await import(pathToFileURL(join(genDir, f)).href);
    if (m.signature) mods.set(m.signature.name, m);
  }
  return mods;
}

// Wire the protocol layer onto a started server. `addon` is the native module
// (already had startServer() called). `output` is the compositor output's
// logical size { width, height } (from addon.start()); placement uses it.
// Returns the shared compositor state for inspection/testing.
export async function installProtocols(addon, output = { width: 1920, height: 1080 }) {
  const mods = await loadSignatures();

  // Register every interface's signature so cross-references resolve (the
  // trampoline needs the full transitive closure).
  addon.registerProtocols([...mods.values()].map((m) => m.signature));

  // Build the event-sender set for every interface, wired to the native post.
  const events = {};
  for (const [name, m] of mods) events[name] = m.makeEvents(addon.postEvent);

  // Shared compositor state across handlers.
  const state = {
    surfaces: new Map(), // wl_surface resource -> surface record
    nextSerial: 1,
    serial() { return this.nextSerial++; },
  };
  state.wm = createWm(addon, output);

  const ctx = { events, state, addon };

  // Import handler modules and register them. A handler module default-exports
  // a factory (ctx) => handlerObject.
  const handlerMods = {
    wl_compositor: await import('./wl_compositor.js'),
    wl_surface: await import('./wl_surface.js'),
    wl_region: await import('./wl_region.js'),
    xdg_wm_base: await import('./xdg_wm_base.js'),
    xdg_surface: await import('./xdg_surface.js'),
    xdg_toplevel: await import('./xdg_toplevel.js'),
    wl_shm: await import('./wl_shm.js'),
    wl_shm_pool: await import('./wl_shm_pool.js'),
    wl_buffer: await import('./wl_buffer.js'),
    zwp_linux_dmabuf_v1: await import('./zwp_linux_dmabuf_v1.js'),
    zwp_linux_buffer_params_v1: await import('./zwp_linux_buffer_params_v1.js'),
    wl_seat: await import('./wl_seat.js'),
  };

  // wl_pointer / wl_keyboard handlers come from the seat module's named exports.
  const seatMod = handlerMods.wl_seat;
  const childHandlers = {
    wl_pointer: seatMod.makePointer(ctx),
    wl_keyboard: seatMod.makeKeyboard(ctx),
  };

  for (const name of CHILD_INTERFACES) {
    const handler = childHandlers[name] ?? handlerMods[name].default(ctx);
    addon.registerInterface(name, handler);
  }
  for (const name of GLOBALS) {
    addon.createGlobal(name, handlerMods[name].default(ctx));
  }

  return state;
}
