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
import type { Ctx, CompositorState, FocusOptions } from "./ctx.js";

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
const GLOBALS = [
  "wl_compositor", "xdg_wm_base", "wl_shm", "zwp_linux_dmabuf_v1", "wl_seat",
  "wl_subcompositor", "wl_output", "wl_data_device_manager",
];

// Interfaces created via requests (new_id), registered without a global so
// their child resources dispatch to a handler.
const CHILD_INTERFACES = [
  "wl_surface", "wl_region", "xdg_surface", "xdg_toplevel",
  "wl_shm_pool", "wl_buffer", "zwp_linux_buffer_params_v1",
  "wl_pointer", "wl_keyboard", "zwp_linux_dmabuf_feedback_v1",
  "wl_subsurface", "wl_data_device", "wl_data_source", "wl_callback",
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

export interface InstallOptions {
  output?: Output;
  // Keyboard focus policy (interim config point until a real config system
  // exists). Defaults to follow-pointer + focus-on-map.
  focus?: FocusOptions;
}

// Wire the protocol layer onto a started server. `addon` is the native module
// (already had startServer() called). `opts.output` is the compositor output's
// logical size (from addon.start()); placement uses it. Returns the shared
// compositor state for inspection/testing.
export async function installProtocols(
  addon: Addon,
  opts: InstallOptions = {},
): Promise<CompositorState> {
  const output = opts.output ?? { width: 1920, height: 1080 };
  const focusOpts: FocusOptions = opts.focus ?? { policy: "follow-pointer", focusOnMap: true };
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

  // Fire pending wl_surface.frame callbacks. Clients drive their render loop off
  // these (commit -> request frame -> draw next frame on done), so without this
  // a client renders one frame and waits forever. Called once per compositor
  // frame from the launcher's onFrame hook. wl_callback.done carries a ms
  // timestamp; the callback is single-shot (client re-requests each frame).
  state.dispatchFrameCallbacks = (timeMs: number): void => {
    // Release dmabuf buffers whose compositor GPU read has completed. Native
    // tracks this precisely (queue OnSubmittedWorkDone on the frame that last
    // sampled each buffer) and hands back the freed bufferIds here. This is the
    // correct completion signal -- not a timer guess: releasing only after the
    // GPU is done reading avoids both client overwrite-while-reading and the
    // vkAcquireNextImageKHR starvation seen when buffers are never freed.
    const freed = addon.takeFreedBuffers();
    if (freed.length > 0) {
      const byId = state.dmabufById;
      const byBuf = state.dmabufBufferIds;
      for (const id of freed) {
        const buf = byId?.get(id);
        if (buf) {
          if (!buf.destroyed) events.wl_buffer.send_release(buf);
          byId?.delete(id);
          byBuf?.delete(buf);
        }
      }
    }

    for (const s of state.surfaces.values()) {
      const cbs = s.frameCallbacks;
      if (!cbs || cbs.length === 0) continue;
      s.frameCallbacks = [];
      for (const cb of cbs) {
        if (cb.destroyed) continue;
        events.wl_callback.send_done(cb, timeMs >>> 0);
      }
    }
  };

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
    wl_subcompositor: await import("./wl_subcompositor.js"),
    wl_output: await import("./wl_output.js"),
    wl_data_device_manager: await import("./wl_data_device_manager.js"),
  };

  // Some child interfaces have handlers from a sibling module's named exports.
  const seatMod = await import("./wl_seat.js");
  const dmabufMod = await import("./zwp_linux_dmabuf_v1.js");
  const subMod = await import("./wl_subcompositor.js");
  const ddmMod = await import("./wl_data_device_manager.js");
  const childHandlers: Record<string, object> = {
    wl_pointer: seatMod.makePointer(ctx),
    wl_keyboard: seatMod.makeKeyboard(ctx),
    zwp_linux_dmabuf_feedback_v1: dmabufMod.makeDmabufFeedback(),
    wl_subsurface: subMod.makeSubsurface(ctx),
    wl_data_device: ddmMod.makeDataDevice(),
    wl_data_source: ddmMod.makeDataSource(),
    wl_callback: {}, // event-only (done); no requests to dispatch
  };

  // wl_seat needs the focus options, so instantiate it explicitly (the generic
  // factory call below would not pass them).
  const globalHandlers: Record<string, object> = {
    wl_seat: seatMod.default(ctx, focusOpts),
  };

  for (const name of CHILD_INTERFACES) {
    const handler = childHandlers[name] ?? handlerMods[name].default(ctx);
    addon.registerInterface(name, handler);
  }
  for (const name of GLOBALS) {
    const handler = globalHandlers[name] ?? handlerMods[name].default(ctx);
    addon.createGlobal(name, handler);
  }

  return state;
}
