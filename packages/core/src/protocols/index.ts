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
import type { LayoutDriver, LayoutSnapshot, LayoutApplyTarget } from "../wm/layout-driver.js";
import { queryState } from "../query.js";
import { applySubsurfaces } from "../subsurfaces.js";
import { unmapAndTeardownSurface } from "./wl_surface.js";
import { rebuildStackWithPopups, maybeDismissGrabbedPopup } from "./xdg_popup.js";
import { configureToplevel } from "./xdg_surface.js";
import type { Addon, EventsByInterface, EventSenders } from "../types.js";
import type { Ctx, CompositorState, CompositorSink } from "./ctx.js";
import type { FocusDriver, FocusApplyTarget } from "./focus-driver.js";
import { titleAppId } from "../query.js";
import { WINDOW_EVENT } from "../events/types.js";
import { markLayerSurfaceMapped } from "./zwlr_layer_shell_v1.js";
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
  "wp_cursor_shape_manager_v1",
  "zwlr_layer_shell_v1",
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
  "wp_cursor_shape_device_v1",
  "zwlr_layer_surface_v1",
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
  // The compositing sink (the JsCompositor in production).
  compositor?: CompositorSink;
  // Core-internal event bus. GPU-free tests may omit it; emits become
  // no-ops.
  bus?: CompositorBus;
  // Plugin-visible (dynamic) event bus. When set, the WM emits
  // 'window.relayout' on it during applyLayout. Tests may omit it.
  pluginBus?: import("../events/dynamic-bus.js").DynamicBus;
  // Layout driver factory (core-plugin-api.md §13). Omit -> the WM uses a
  // no-op driver that never moves windows; useful for tests that don't
  // exercise layout.
  layoutDriverFactory?: (
    target: LayoutApplyTarget,
    snapshot: () => LayoutSnapshot,
  ) => LayoutDriver;
  // Focus driver factory (core-plugin-api.md §14). Omit -> the seat uses
  // a no-op driver that never changes focus.
  focusDriverFactory?: (target: FocusApplyTarget) => FocusDriver;
  // Reserved-zone registry. Layer-shell exclusive zones add reservations
  // here; the layout driver consults it via effectiveRect() to compute the
  // tile region. The CALLER (main.ts in production; test harnesses
  // optionally) creates the registry and is responsible for also passing
  // it into the layoutDriverFactory's deps so both sides see the same
  // instance. Omit in GPU-free tests that don't exercise layer-shell.
  reservedZones?: import("../wm/reserved-zones.js").ReservedZoneRegistry;
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
  if (opts.reservedZones) state.reservedZones = opts.reservedZones;
  // The binding chain owns the input modes + chord trie. Plugins
  // register bindings via the windows broker; the seat dispatches each
  // key-down here. Chain events (mode-pushed/popped, chord-*) re-emit on
  // the plugin bus (when present) so subscribers like a status bar
  // observe mode + chord state.
  const { BindingChain } = await import("../input/binding-chain.js");
  const chain = new BindingChain();
  state.bindingChain = chain;
  if (opts.pluginBus) {
    const pb = opts.pluginBus;
    chain.setListener((ev) => {
      switch (ev.kind) {
        case "mode-pushed":
          pb.emit("input.mode-pushed", { name: ev.name, stack: ev.stack });
          break;
        case "mode-popped":
          pb.emit("input.mode-popped", { name: ev.name, stack: ev.stack });
          break;
        case "chord-entered":
          pb.emit("input.chord-entered", { mode: ev.mode, path: ev.path });
          break;
        case "chord-cancelled":
          pb.emit("input.chord-cancelled", { mode: ev.mode, path: ev.path });
          break;
        case "chord-matched":
          pb.emit("input.chord-matched", { mode: ev.mode, path: ev.path });
          break;
      }
    });
  }
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
  // DecorationResize sink: indirect to state.decorationResize so the WM stays
  // unaware of the broker. main.ts sets state.decorationResize after creating
  // the broker (using broker.onDecorationResized). When unset (GPU-free tests
  // / pre-broker bring-up), the WM still updates the decoration's compositor
  // layout directly -- only the plugin-side redraw is skipped.
  state.wm = createWm(state.compositor, output, {
    rebuild: () => rebuildStackWithPopups(state),
    configure: configureSink,
    decorationResize: (windowId, outerRect, contentRect, insets) => {
      state.decorationResize?.(windowId, outerRect, contentRect, insets);
    },
    layoutDriverFactory: opts.layoutDriverFactory,
    pluginBus: opts.pluginBus,
  });
  // Expose wm.schedule via state.relayout for callers outside the WM that
  // affect the tile region (layer-shell reserved-zone changes).
  state.relayout = (reason) => state.wm?.schedule(reason);
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
        //
        // EMIT ORDER: window.map fires BEFORE windowHasContent's pushStack so the
        // decoration registry (a synchronous bus subscriber) gets to call
        // setContentGated(true) BEFORE the window is interleaved into the stack
        // by computeBaseStack. Otherwise the window draws undecorated in the
        // race window between pushStack and onAssigned -- breaking the "content
        // held until decoration's first frame" contract.
        const rect = state.wm?.rectOf(id);
        if (rect) {
          // Emit window.map. app_id/title may be null if the client set them after
          // its first commit (a known timing gap); a later window.change carries the
          // update once set_app_id/set_title fires.
          const ta = titleAppId(state, id);
          state.bus?.emit(WINDOW_EVENT.map, {
            surfaceId: id,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            appId: ta.appId, title: ta.title,
          });
          // Now mark the window drawable + push the stack. If a decoration
          // provider matched in the map emission above, the window is already
          // contentGated and will be skipped by computeBaseStack until the
          // decoration's first present releases the gate.
          state.wm?.windowHasContent(id);
          state.seat?.focusWindow(id, s, rect);
        }
      } else if (s.role === "xdg_popup") {
        // A popup maps on first content; it is compositor-positioned above its
        // parent (rect already computed at get_popup). Mark its PopupRecord mapped
        // and rebuild the stack to include it.
        s.mapped = true;
        const pr = s.xdgSurface?.popup ? state.popups?.get(s.xdgSurface.popup) : undefined;
        if (pr) { pr.mapped = true; mappedPopup = true; }
      } else if (s.role === "layer_surface" && s.layerSurface) {
        // Layer-shell first content: mark mapped, push to the layer stack,
        // emit window.map with role: 'layer-shell'. width/height from the
        // imported buffer are ignored for placement -- the rect was decided
        // by placeLayerSurface against anchor / size / margin. appId/title
        // are null for layer surfaces (the protocol carries a `namespace`
        // identifier instead, not surfaced on this event today).
        s.mapped = true;
        const ls = s.layerSurface;
        ls.mapped = true;
        const rect = ls.rect;
        if (rect) {
          state.bus?.emit(WINDOW_EVENT.map, {
            surfaceId: id,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            appId: null, title: null,
            role: "layer-shell",
          });
        }
        // Push the layer stack so the compositor includes this surface.
        markLayerSurfaceMapped(state, ls);
        mappedAny = true;
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

    // Same disconnect case for wl_buffers: a client that drops without
    // wl_buffer.destroy leaves its descriptor in state.buffers, and a dmabuf
    // descriptor holds an open WaylandFd. The destroy handler did not run, so close
    // the fd + drop the descriptor here (otherwise the wrapper GC-warns + leaks an
    // fd per buffer the client allocated). shm pools are reclaimed via their own
    // refcount on pool destroy.
    //
    // For dmabuf buffers this is ALSO the cache-invalidation trigger for the
    // client-buffer lifecycle (rule A): notifyBufferDestroyed releases the
    // cached GPU import. Without this, a client disconnect would leak imports
    // for every buffer it ever committed (load-bearing per the spec test:
    // "leak guard: surfaceRemoved releases ... others need bufferDestroyed").
    if (state.buffers) {
      for (const [resource, desc] of [...state.buffers.entries()]) {
        if (!resource.destroyed) continue;
        if (desc.dmabuf) {
          const bufferId = state.dmabufBufferIds?.get(resource);
          if (bufferId !== undefined) {
            state.compositor.notifyBufferDestroyed?.(bufferId);
            state.dmabufBufferIds?.delete(resource);
            state.dmabufById?.delete(bufferId);
          }
        }
        if (desc.fd && !desc.fd.closed) {
          try { desc.fd.close(); } catch { /* already closed/taken */ }
        }
        state.buffers.delete(resource);
      }
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

    // Drain sendWlRelease intents from the lifecycle: notify each client that
    // it may write to the buffer again. Per rule A, the bufferId<->resource
    // mapping is NOT removed here -- the cached GPU import lives until the
    // client destroys the wl_buffer (or disconnects), at which point the
    // mapping is cleaned up in the wl_buffer.destroy handler / disconnect
    // sweep. Cleaning it here would break the cache-on-re-attach path that
    // makes a buffer-cycling client efficient.
    const freed = state.compositor.takeFreedBuffers();
    if (freed.length > 0) {
      const byId = state.dmabufById;
      for (const id of freed) {
        const buf = byId?.get(id);
        if (buf && !buf.destroyed) events.wl_buffer.send_release(buf);
      }
    }

    for (const s of state.surfaces.values()) {
      const cbs = s.frameCallbacks;
      if (!cbs || cbs.length === 0) continue;
      s.frameCallbacks = [];
      for (const cb of cbs) {
        if (cb.destroyed) continue;
        events.wl_callback.send_done(cb, timeMs >>> 0);
        // wl_callback.done is type="destructor": the protocol says the
        // resource is gone after this event. Without this call the
        // libwayland resource + napi_ref leaks per frame per surface.
        addon.destroyResource(cb);
      }
    }

    // Animation evaluator: advance active animations and write the new
    // per-surface state values for this frame. Runs BEFORE renderFrame so
    // the compositor's submit reads the updated uniforms. main.ts sets
    // beforeRender; tests / harnesses without an evaluator leave it unset.
    state.beforeRender?.(timeMs);

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
    // wl_seat is constructed via globalHandlers (it takes the focus driver
    // as a second arg, which the generic HandlerFactory shape doesn't allow).
    wl_subcompositor: await import("./wl_subcompositor.js"),
    wl_output: await import("./wl_output.js"),
    wl_data_device_manager: await import("./wl_data_device_manager.js"),
    // wp_cursor_shape_manager_v1 is exposed via globalHandlers; the
    // module's helper factories aren't a default export.
    zwlr_layer_shell_v1: await import("./zwlr_layer_shell_v1.js"),
  };

  // Some child interfaces have handlers from a sibling module's named exports.
  const seatMod = await import("./wl_seat.js");
  const dmabufMod = await import("./zwp_linux_dmabuf_v1.js");
  const subMod = await import("./wl_subcompositor.js");
  const ddmMod = await import("./wl_data_device_manager.js");
  const cursorShapeMod = await import("./cursor_shape.js");
  const layerShellMod = await import("./zwlr_layer_shell_v1.js");
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
    wp_cursor_shape_device_v1: cursorShapeMod.makeCursorShapeDevice(ctx),
    zwlr_layer_surface_v1: layerShellMod.makeLayerSurface(ctx),
  };

  // The apply target forwards lazily: the seat is constructed below and
  // populates state.seat; the driver may dispatch before that happens
  // (unlikely in practice but cheap to guard).
  const applyTarget: FocusApplyTarget = {
    applyKeyboardFocus(surfaceId) {
      state.seat?.applyKeyboardFocus(surfaceId);
    },
  };
  const focusDriver: FocusDriver = opts.focusDriverFactory
    ? opts.focusDriverFactory(applyTarget)
    : { dispatch: () => {}, settled: () => Promise.resolve() };

  // wl_seat takes the focus driver explicitly (the generic factory call
  // below has no way to pass it).
  const globalHandlers: Record<string, object> = {
    wl_seat: seatMod.default(ctx, focusDriver),
    zwp_primary_selection_device_manager_v1: ddmMod.makePrimaryManager(ctx),
    wp_cursor_shape_manager_v1: cursorShapeMod.makeCursorShapeManager(ctx),
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
