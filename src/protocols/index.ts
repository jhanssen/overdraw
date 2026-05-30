// Minimal protocol loader. Imports every generated interface signature, builds
// the runtime wl_interfaces in the native trampoline, then wires the handwritten
// handler modules: globals (clients bind these) via createGlobal, and
// request-created interfaces (xdg_surface, xdg_toplevel, ...) via
// registerInterface. Each handler module exports a factory that receives a
// context { events, state, addon } and returns the handler object the trampoline
// calls.
//
// This is deliberately minimal: no C++/core-JS/plugin layering or override
// semantics (architecture.md "implementation layers") yet. That machinery is
// only meaningful once plugins exist; it grows in when that track lands.

import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { createWm } from "../wm/index.js";
import type { Addon, EventsByInterface, EventSenders } from "../types.js";
import type { Ctx, CompositorState } from "./ctx.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const genDir = join(__dirname, "..", "protocols-gen");

// A generated signature module: a signature table + an event-sender factory.
interface SignatureModule {
  signature: { name: string };
  makeEvents(post: Addon["postEvent"]): EventSenders;
}

// A handler module default-exports a factory (ctx) => handler object. The
// concrete return type is the interface's generated WlXHandler; here we only
// need that it is an object (registerInterface takes it as unknown).
type HandlerFactory = (ctx: Ctx) => object;
interface HandlerModule { default: HandlerFactory; }

// Interfaces advertised as globals (clients bind them from the registry).
const GLOBALS = ["wl_compositor", "xdg_wm_base", "wl_shm", "zwp_linux_dmabuf_v1", "wl_seat"];

// Interfaces created via requests (new_id), registered without a global so
// their child resources dispatch to a handler.
const CHILD_INTERFACES = [
  "wl_surface", "wl_region", "xdg_surface", "xdg_toplevel",
  "wl_shm_pool", "wl_buffer", "zwp_linux_buffer_params_v1",
  "wl_pointer", "wl_keyboard",
];

// Load all generated signature modules, keyed by interface name.
async function loadSignatures(): Promise<Map<string, SignatureModule>> {
  const mods = new Map<string, SignatureModule>();
  for (const f of readdirSync(genDir)) {
    if (!f.endsWith(".js")) continue;
    const m = (await import(pathToFileURL(join(genDir, f)).href)) as SignatureModule;
    if (m.signature) mods.set(m.signature.name, m);
  }
  return mods;
}

export interface Output { width: number; height: number; }

// Wire the protocol layer onto a started server. `addon` is the native module
// (already had startServer() called). `output` is the compositor output's
// logical size (from addon.start()); placement uses it. Returns the shared
// compositor state for inspection/testing.
export async function installProtocols(
  addon: Addon,
  output: Output = { width: 1920, height: 1080 },
): Promise<CompositorState> {
  const mods = await loadSignatures();

  // Register every interface's signature so cross-references resolve (the
  // trampoline needs the full transitive closure).
  addon.registerProtocols([...mods.values()].map((m) => m.signature));

  // Build the event-sender set for every interface, wired to the native post.
  const events: EventsByInterface = {};
  for (const [name, m] of mods) events[name] = m.makeEvents(addon.postEvent);

  // Shared compositor state across handlers.
  const state: CompositorState = {
    surfaces: new Map(),
    nextSerial: 1,
    serial() { return this.nextSerial++; },
  };
  state.wm = createWm(addon, output);

  const ctx: Ctx = { events, state, addon };

  // Import handler modules. A handler module default-exports a factory.
  const handlerMods: Record<string, HandlerModule> = {
    wl_compositor: await import("./wl_compositor.js"),
    wl_surface: await import("./wl_surface.js"),
    wl_region: await import("./wl_region.js"),
    xdg_wm_base: await import("./xdg_wm_base.js"),
    xdg_surface: await import("./xdg_surface.js"),
    xdg_toplevel: await import("./xdg_toplevel.js"),
    wl_shm: await import("./wl_shm.js"),
    wl_shm_pool: await import("./wl_shm_pool.js"),
    wl_buffer: await import("./wl_buffer.js"),
    zwp_linux_dmabuf_v1: await import("./zwp_linux_dmabuf_v1.js"),
    zwp_linux_buffer_params_v1: await import("./zwp_linux_buffer_params_v1.js"),
    wl_seat: await import("./wl_seat.js"),
  };

  // wl_pointer / wl_keyboard handlers come from the seat module's named exports.
  const seatMod = await import("./wl_seat.js");
  const childHandlers: Record<string, object> = {
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
