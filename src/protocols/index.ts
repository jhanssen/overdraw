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

import { createWm, type LayoutParams } from "../wm/index.js";
import { queryState } from "../query.js";
import { applySubsurfaces } from "../subsurfaces.js";
import { unmapAndTeardownSurface } from "./wl_surface.js";
import { rebuildStackWithPopups, maybeDismissGrabbedPopup } from "./xdg_popup.js";
import { configureToplevel } from "./xdg_surface.js";
import type { Addon, EventsByInterface, EventSenders } from "../types.js";
import type { Ctx, CompositorState, FocusOptions, CompositorSink } from "./ctx.js";
import { titleAppId } from "../query.js";
import { WINDOW_EVENT } from "../events/types.js";
import type { CompositorBus } from "../events/window-bus.js";
import { flushWindowChanges } from "./window-changes.js";

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
  "zwp_primary_selection_device_manager_v1",
];

// Interfaces created via requests (new_id), registered without a global so
// their child resources dispatch to a handler.
const CHILD_INTERFACES = [
  "wl_surface", "wl_region", "xdg_surface", "xdg_toplevel", "xdg_positioner", "xdg_popup",
  "wl_shm_pool", "wl_buffer", "zwp_linux_buffer_params_v1",
  "wl_pointer", "wl_keyboard", "zwp_linux_dmabuf_feedback_v1",
  "wl_subsurface", "wl_data_device", "wl_data_source", "wl_data_offer", "wl_callback",
  "zwp_primary_selection_device_v1", "zwp_primary_selection_source_v1",
  "zwp_primary_selection_offer_v1",
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
  // Compositor backend. Defaults to the native addon (C++ Compositor). Pass a
  // JsCompositor to run the compositing pass in JS over the wire.
  compositor?: CompositorSink;
  // Core-internal event bus (window/keyboard events). main.ts forwards window.*
  // to the plugin runtime and the clipboard layer subscribes to keyboard.focus.
  // Optional: GPU-free protocol tests can omit it (emits become no-ops).
  bus?: CompositorBus;
  // Tiling layout parameters (master fraction, gaps). Interim config point until a
  // real config system exists. Defaults to DEFAULT_LAYOUT (0.5 master, 0 gap).
  layout?: LayoutParams;
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
  if (!opts.compositor) {
    throw new Error("installProtocols requires opts.compositor (the JS compositor)");
  }
  const state: CompositorState = {
    surfaces: new Map(),
    compositor: opts.compositor,
    nextSerial: 1,
    serial() { return this.nextSerial++; },
  };
  if (opts.bus) state.bus = opts.bus;
  // ctx is needed by the WM's ConfigureSink (configureToplevel) below; build it
  // here. The handler factories receive the same ctx later.
  const ctx: Ctx = { events, state, addon };
  // ConfigureSink: the WM calls this to (re)configure a window to a content size.
  // Resolve surfaceId -> xdg_surface record and send the sized configure.
  const configureSink = (surfaceId: number, w: number, h: number): void => {
    const xs = state.surfacesById?.get(surfaceId)?.xdgSurface;
    if (xs?.toplevel) configureToplevel(ctx, xs, w, h);
  };
  // The WM delegates its stack push to the full rebuild (windows interleaved with
  // their decorations + subsurfaces + popups via computeBaseStack), keeping
  // rebuildStackWithPopups the single owner of the content stack order.
  state.wm = createWm(
    state.compositor, output, () => rebuildStackWithPopups(state), configureSink, opts.layout,
  );
  // State-query channel (tests / introspection): a GPU-free snapshot of
  // geometry / focus / stacking. See src/query.ts.
  state.query = () => queryState(state);

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
    // Map-on-first-content (both shm and dmabuf). Native reports surfaces that
    // gained presentable content; the first time a toplevel does, hand it to the
    // WM to place + stack + focus. dmabuf commits complete asynchronously so this
    // cannot be done inline in wl_surface.commit -- it is the single shared map
    // signal for both buffer paths. Carries the content size for hit-testing.
    const imported = state.compositor.takeImportedSurfaces();
    let mappedAny = false;
    let mappedPopup = false;
    for (const { id, width, height } of imported) {
      const s = state.surfacesById?.get(id);
      if (!s || s.mapped) continue;
      if (s.role === "xdg_toplevel") {
        s.mapped = true;
        mappedAny = true;
        // Geometry was assigned proactively at get_toplevel (addWindow); first
        // content just makes the window drawable + focusable. width/height (the
        // committed buffer size) are ignored for placement — the tile is owned by
        // the layout, not the client.
        const rect = state.wm?.windowHasContent(id);
        if (rect) {
          state.seat?.focusWindow(id, s, rect);
          // Emit window.map. app_id/title may be null if the client set them after
          // its first commit (a known timing gap); a later window.change carries the
          // update once set_app_id/set_title fires.
          const ta = titleAppId(state, id);
          state.bus?.emit(WINDOW_EVENT.map, {
            surfaceId: id,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            appId: ta.appId, title: ta.title,
          });
        }
      } else if (s.role === "xdg_popup") {
        // A popup maps on first content; it is compositor-positioned above its
        // parent (rect already computed at get_popup). Mark its PopupRecord mapped
        // and rebuild the stack to include it.
        s.mapped = true;
        const pr = s.xdgSurface?.popup ? state.popups?.get(s.xdgSurface.popup) : undefined;
        if (pr) { pr.mapped = true; mappedPopup = true; }
      }
    }
    // Resource-destroyed sweep: a client that disconnects (or crashes) without
    // explicitly sending wl_surface.destroy still has its wl_resource torn down by
    // libwayland, which only marks our wrapper `destroyed` -- the protocol destroy
    // handler does NOT run, so no window.unmap would be emitted and anything bound
    // to that window (e.g. a decoration ring) would leak. Detect such surfaces here
    // and run the same idempotent unmap teardown. (The explicit-destroy path already
    // tore down + set `unmapped`, so this only fires for the disconnect case.)
    let unmappedAny = false;
    for (const s of [...state.surfaces.values()]) {
      if (!s.resource.destroyed || s.unmapped) continue;
      unmapAndTeardownSurface(state, s);
      state.surfaces.delete(s.resource);
      unmappedAny = true;
    }

    // A newly-mapped toplevel changes window rects, so re-lay-out subsurfaces
    // (a child that committed before its parent mapped gets placed now).
    if (mappedAny) applySubsurfaces(state);
    if (mappedAny || mappedPopup || unmappedAny) rebuildStackWithPopups(state);

    // Drain coalesced window-state changes (title/app_id/activation) accumulated
    // since the last frame into one window.change per affected surface. Coalescing
    // to the frame boundary means a consumer sees consistent state, not the
    // intermediate values between rapid set_title/set_app_id requests.
    flushWindowChanges(state);

    const freed = state.compositor.takeFreedBuffers();
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

    // JS compositor: render the frame now that layout/stack reflect this frame's
    // commits + any newly-mapped windows. The native path renders on its own
    // libuv timer, so its renderFrame is undefined (no-op here).
    state.compositor.renderFrame?.();
  };

  // Popup click-away dismissal: the seat calls this on a button press.
  state.dismissGrabbedPopup = (x, y) => maybeDismissGrabbedPopup(ctx, x, y);

  // Import handler modules. A handler module default-exports a factory.
  const handlerMods: Record<string, HandlerModule> = {
    wl_compositor: await import("./wl_compositor.js"),
    wl_surface: await import("./wl_surface.js"),
    wl_region: await import("./wl_region.js"),
    xdg_wm_base: await import("./xdg_wm_base.js"),
    xdg_surface: await import("./xdg_surface.js"),
    xdg_toplevel: await import("./xdg_toplevel.js"),
    xdg_positioner: await import("./xdg_positioner.js"),
    xdg_popup: await import("./xdg_popup.js"),
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
    wl_data_device: ddmMod.makeDataDevice(ctx),
    wl_data_source: ddmMod.makeDataSource(ctx),
    wl_data_offer: ddmMod.makeDataOffer(ctx),
    zwp_primary_selection_device_v1: ddmMod.makePrimaryDevice(ctx),
    zwp_primary_selection_source_v1: ddmMod.makePrimarySource(ctx),
    zwp_primary_selection_offer_v1: ddmMod.makePrimaryOffer(ctx),
    wl_callback: {}, // event-only (done); no requests to dispatch
  };

  // wl_seat needs the focus options, so instantiate it explicitly (the generic
  // factory call below would not pass them).
  const globalHandlers: Record<string, object> = {
    wl_seat: seatMod.default(ctx, focusOpts),
    zwp_primary_selection_device_manager_v1: ddmMod.makePrimaryManager(ctx),
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
