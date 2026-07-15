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
import { createSurfaceTransactionBroker } from "../surface-transaction.js";
import type { LayoutDriver, LayoutSnapshot, LayoutApplyTarget } from "../wm/layout-driver.js";
import { queryState } from "../query.js";
import { applySubsurfaces } from "../subsurfaces.js";
import { unmapAndTeardownSurface } from "./wl_surface.js";
import { rebuildStackWithPopups, maybeDismissGrabbedPopup, flushDeferredOutputStacks } from "./xdg_popup.js";
import { configureToplevel } from "./xdg_surface.js";
import { updateSurfaceOutputResidency, updateAllSurfaceResidency } from "./surface-residency.js";
import { xChartCameraOf, tellXRect } from "../xwayland/glass-map.js";
import { shouldDeliverFrameCallbackIdle } from "./frame-callbacks.js";
import { installCrossOutputMove } from "./cross-output-move.js";
import { makeOutputForOutput } from "./wl_output.js";
import type { Addon, EventsByInterface, EventSenders } from "../types.js";
import type { Ctx, CompositorState, CompositorSink, SurfaceRecord } from "./ctx.js";
import { OUTPUT_DEFAULT, OUTPUT_FALLBACK, FALLBACK_OUTPUT_NAME } from "./ctx.js";
import type { FocusDriver, FocusApplyTarget } from "./focus-driver.js";
import { titleAppId } from "../query.js";
import { WINDOW_EVENT } from "../events/types.js";
import { markLayerSurfaceMapped, installLayerShellOutputTeardown } from "./zwlr_layer_shell_v1.js";
import type { CompositorBus } from "../events/window-bus.js";
import { flushWindowChanges } from "./window-changes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const genDir = join(__dirname, "..", "protocols-gen");

// The client's natural content size at first content: its committed window
// geometry (set_window_geometry, surface-logical coords) when present, else the
// committed buffer reduced to logical pixels. The WM sizes a window that
// resolves to floating from this so it renders 1:1 at its own size.
function clientContentSize(
  s: SurfaceRecord, bufW: number, bufH: number,
): { width: number; height: number } {
  const geom = s.xdgSurface?.geometry;
  if (geom && geom.width > 0 && geom.height > 0) {
    return { width: geom.width, height: geom.height };
  }
  const bs = s.committed.bufferScale ?? 1;
  return {
    width: Math.max(1, Math.round(bufW / bs)),
    height: Math.max(1, Math.round(bufH / bs)),
  };
}

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
// wl_output is intentionally absent: it is advertised one global per output
// via addon.createGlobalForOutput, so a client binding wl_output for output
// 1 reaches output 1's bind handler and gets output 1's geometry.
const GLOBALS = [
  "wl_compositor", "xdg_wm_base", "wl_shm", "zwp_linux_dmabuf_v1", "wl_drm", "wl_seat",
  "wl_subcompositor", "wl_data_device_manager",
  "zwp_primary_selection_device_manager_v1",
  "wp_cursor_shape_manager_v1",
  "zwlr_layer_shell_v1",
  "zxdg_decoration_manager_v1",
  "org_kde_kwin_server_decoration_manager",
  "zxdg_output_manager_v1",
  "zwlr_foreign_toplevel_manager_v1",
  "wp_viewporter",
  "wp_fractional_scale_manager_v1",
  "wp_linux_drm_syncobj_manager_v1",
  "zwlr_output_manager_v1",
  "zwlr_virtual_pointer_manager_v1",
  "zwp_virtual_keyboard_manager_v1",
  "zwp_relative_pointer_manager_v1",
  "zwp_pointer_constraints_v1",
  "zwp_keyboard_shortcuts_inhibit_manager_v1",
  "ext_workspace_manager_v1",
  "xwayland_shell_v1",
  "ext_data_control_manager_v1",
  "zwlr_data_control_manager_v1",
  "wp_presentation",
  "wp_commit_timing_manager_v1",
  "ext_foreign_toplevel_list_v1",
  "ext_output_image_capture_source_manager_v1",
  "ext_foreign_toplevel_image_capture_source_manager_v1",
  "ext_image_copy_capture_manager_v1",
  "xdg_wm_dialog_v1",
  "zxdg_exporter_v2",
  "zxdg_importer_v2",
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
  "zxdg_toplevel_decoration_v1",
  "org_kde_kwin_server_decoration",
  "zxdg_output_v1",
  "zwlr_foreign_toplevel_handle_v1",
  "wp_viewport",
  "wp_fractional_scale_v1",
  "wp_linux_drm_syncobj_timeline_v1",
  "wp_linux_drm_syncobj_surface_v1",
  "zwlr_output_head_v1",
  "zwlr_output_mode_v1",
  "zwlr_output_configuration_v1",
  "zwlr_output_configuration_head_v1",
  "zwlr_virtual_pointer_v1",
  "zwp_virtual_keyboard_v1",
  "zwp_relative_pointer_v1",
  "zwp_locked_pointer_v1",
  "zwp_confined_pointer_v1",
  "zwp_keyboard_shortcuts_inhibitor_v1",
  "ext_workspace_group_handle_v1",
  "ext_workspace_handle_v1",
  "xwayland_surface_v1",
  "ext_data_control_device_v1",
  "ext_data_control_source_v1",
  "ext_data_control_offer_v1",
  "zwlr_data_control_device_v1",
  "zwlr_data_control_source_v1",
  "zwlr_data_control_offer_v1",
  "wp_presentation_feedback",
  "wp_commit_timer_v1",
  "ext_foreign_toplevel_handle_v1",
  "ext_image_capture_source_v1",
  "ext_image_copy_capture_session_v1",
  "ext_image_copy_capture_frame_v1",
  "ext_image_copy_capture_cursor_session_v1",
  "xdg_dialog_v1",
  "zxdg_exported_v2",
  "zxdg_imported_v2",
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
  const rawCompositor = opts.compositor;
  const state: CompositorState = {
    surfaces: new Map(),
    compositor: rawCompositor,
    nextSerial: 1,
    serial() { return this.nextSerial++; },
  };
  // Intercept setSurfaceLayout in place so a geometry change triggers a
  // wl_surface.enter/leave residency diff for the affected surface (delegating
  // to the underlying sink first, so surfaceOutputs sees the new rect). Done by
  // replacing the single method rather than wrapping the sink in a Proxy: a
  // Proxy traps EVERY property access, so the hot per-frame path (renderFrame,
  // surfaceOutputs, the take*() drains) would pay a get-trap + Reflect.get and
  // a megamorphic receiver on each `state.compositor.x`. Patching one method
  // leaves every other access a direct, inline-cacheable property read.
  const innerSetSurfaceLayout = rawCompositor.setSurfaceLayout?.bind(rawCompositor);
  if (innerSetSurfaceLayout) {
    rawCompositor.setSurfaceLayout = (id, x, y, w, h): void => {
      innerSetSurfaceLayout(id, x, y, w, h);
      const rec = state.surfacesById?.get(id);
      if (rec) updateSurfaceOutputResidency(state, addon, rec);
    };
  }
  // Same single-method patch on the stack setters: residency is gated on
  // draw-stack membership (surfaceVisibleOutputs), so a stack change (a
  // window joining/leaving what an output shows) moves enter/leave state
  // with no geometry change. rebuildStackWithPopups re-pushes on every
  // content commit, so each patch keeps the last-pushed ids and sweeps
  // only on an actual change.
  const stacksChanged = (
    a: ReadonlyArray<number> | null | undefined,
    b: ReadonlyArray<number> | null,
  ): boolean => {
    if (!a || !b) return a !== b || a === undefined;
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
  };
  const innerSetStack = rawCompositor.setStack?.bind(rawCompositor);
  if (innerSetStack && rawCompositor.surfaceVisibleOutputs) {
    let lastGlobal: number[] | undefined;
    rawCompositor.setStack = (ids): void => {
      innerSetStack(ids);
      if (lastGlobal !== undefined && !stacksChanged(lastGlobal, ids)) return;
      const first = lastGlobal === undefined;
      lastGlobal = ids.slice();
      // The very first push is boot bring-up; per-surface layout residency
      // covers it and a sweep before outputs settle is noise.
      if (!first) {
        updateAllSurfaceResidency(state, addon);
        // Visibility changes can re-chart X windows (glass-map.ts).
        state.xwm?.retellPositions();
      }
    };
  }
  // Camera changes move every world-space surface relative to the output:
  // residency (enter/leave, preferred scale) and X glass narration both
  // depend on the camera, so sweep on actual change -- the stack sweep
  // alone runs too early when a stack push and a camera dock land in the
  // same batch (the sweep would see the old camera). Transient writes
  // (per-frame camera-flight steps from the animation evaluator) skip
  // the sweep/retell -- the flight's settled write catches up -- but
  // still refresh the state.outputCameras mirror so pointer->world
  // mapping, popup constraints, and query() track the camera live
  // mid-flight.
  const innerSetOutputCamera = rawCompositor.setOutputCamera?.bind(rawCompositor);
  if (innerSetOutputCamera && rawCompositor.surfaceVisibleOutputs) {
    const lastCam = new Map<number, { x: number; y: number; zoom: number }>();
    rawCompositor.setOutputCamera = (outputId, x, y, zoom = 1, transient = false): void => {
      innerSetOutputCamera(outputId, x, y, zoom);
      state.outputCameras ??= new Map();
      if (x === 0 && y === 0 && zoom === 1) state.outputCameras.delete(outputId);
      else state.outputCameras.set(outputId, { x, y, zoom });
      if (transient) return;
      const prev = lastCam.get(outputId);
      if (prev && prev.x === x && prev.y === y && prev.zoom === zoom) return;
      lastCam.set(outputId, { x, y, zoom });
      updateAllSurfaceResidency(state, addon);
      state.xwm?.retellPositions();
    };
  }
  const innerSetOutputStack = rawCompositor.setOutputStack?.bind(rawCompositor);
  if (innerSetOutputStack && rawCompositor.surfaceVisibleOutputs) {
    const lastByOutput = new Map<number, number[] | null>();
    rawCompositor.setOutputStack = (outputId, ids): void => {
      innerSetOutputStack(outputId, ids);
      const prev = lastByOutput.get(outputId);
      if (lastByOutput.has(outputId) && !stacksChanged(prev, ids)) return;
      lastByOutput.set(outputId, ids === null ? null : ids.slice());
      updateAllSurfaceResidency(state, addon);
      // Visibility changes can re-chart X windows (glass-map.ts).
      state.xwm?.retellPositions();
    };
  }
  if (opts.bus) state.bus = opts.bus;
  if (opts.pluginBus) state.pluginBus = opts.pluginBus;
  if (opts.reservedZones) state.reservedZones = opts.reservedZones;
  // Seed the primary output. The GPU process sends an OutputDescriptor per
  // connector over the ctrl channel after surface bring-up; main.ts's
  // setOnOutputDescriptor callback adds extras and replaces this record's
  // host-derived values (refresh, scale, transform, physical dims, nested-
  // window size). Until that arrives -- and in GPU-free harnesses that never
  // wire the callback -- this seed record keeps wl_output/xdg-output emitting
  // something sensible.
  state.outputs = new Map();
  state.outputs.set(OUTPUT_DEFAULT, {
    id: OUTPUT_DEFAULT,
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: output.width, height: output.height },
    deviceSize: { width: output.width, height: output.height },
    scale: 1,
    name: "overdraw-0",
    description: "overdraw output",
    refreshMhz: 60000,
    transform: 0,
    physicalWidthMm: 0,
    physicalHeightMm: 0,
    make: "overdraw",
    model: "overdraw output",
    edidId: "",  // GPU process supplies the real one via OutputDescriptor
  });
  // Virtual fallback output. Lives outside state.outputs so every iteration
  // over the live output map automatically skips it; only the workspace
  // migration code references it directly. Zero-area rect: parked workspaces
  // do not size their windows against it; clients keep their last-known
  // sizes until a real output resolves them again.
  state.fallbackOutput = {
    id: OUTPUT_FALLBACK,
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 0, height: 0 },
    deviceSize: { width: 0, height: 0 },
    scale: 1,
    name: FALLBACK_OUTPUT_NAME,
    description: "overdraw fallback output",
    refreshMhz: 0,
    transform: 0,
    physicalWidthMm: 0,
    physicalHeightMm: 0,
    make: "overdraw",
    model: "fallback",
    // Fallback output has no physical connector and so no EDID. The
    // workspace migration code keys on FALLBACK_OUTPUT_NAME (see §10) when
    // routing here.
    edidId: "",
  };
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
  // Stash the event-sender map on state so re-emit paths outside the handler
  // factories (e.g. wl_output / xdg_output re-emit on output.changed) can
  // dispatch through it.
  state.events = events;
  // ConfigureSink: the WM calls this to (re)configure a window to a content
  // rect. Role-dispatched:
  //  - xdg_toplevel: send xdg_toplevel.configure + xdg_surface.configure;
  //    return the serial so the resize-tx can match the client's ack.
  //  - xwayland:     apply the rect on the X side (xwmConfigureWindow +
  //    synthetic ConfigureNotify per ICCCM §4.2.3); return null because X
  //    has no ack -- the resize-tx gates on buffer dims only via requireAck.
  // state.xwm is populated by startXwm (which runs AFTER installProtocols);
  // we therefore look it up dynamically per call, not at sink-construction.
  const configureSink: import("../wm/index.js").ConfigureSink = {
    configure(surfaceId, x, y, w, h) {
      const rec = state.surfacesById?.get(surfaceId);
      if (rec?.role === "xwayland") {
        const xw = state.xwm?.findBySurfaceId(surfaceId);
        if (xw) {
          // The WM rect (x,y,w,h) is world coords; X sees GLASS positions
          // (world minus the chart camera, glass-map.ts), then multiplied
          // by the frozen global X scale to land in X-device coords. See
          // docs/xwayland-design.md "HiDPI" + canvas-design.md §7b.
          const cam = xChartCameraOf(state, surfaceId);
          const n = state.xwaylandScale ?? 1;
          tellXRect(addon, xw.window,
            (x - cam.x) * n, (y - cam.y) * n, w * n, h * n);
        }
        return null;
      }
      const xs = rec?.xdgSurface;
      if (xs?.toplevel) return configureToplevel(ctx, xs, w, h);
      return null;
    },
    // Pure move (no resize): xdg has no client-visible position concept, so
    // a no-op. xwayland needs the synthetic ConfigureNotify so the client
    // reads its new root coords -- same world->glass->X-device mapping as
    // the resize path.
    configureMove(surfaceId, x, y, w, h) {
      const rec = state.surfacesById?.get(surfaceId);
      if (rec?.role !== "xwayland") return;
      const xw = state.xwm?.findBySurfaceId(surfaceId);
      if (!xw) return;
      const cam = xChartCameraOf(state, surfaceId);
      const n = state.xwaylandScale ?? 1;
      tellXRect(addon, xw.window,
        (x - cam.x) * n, (y - cam.y) * n, w * n, h * n);
    },
  };
  // The WM delegates its stack push to the full rebuild (windows interleaved with
  // their decorations + subsurfaces + popups via computeBaseStack), keeping
  // rebuildStackWithPopups the single owner of the content stack order.
  // DecorationResize sink: indirect to state.decorationResize so the WM stays
  // unaware of the broker. main.ts sets state.decorationResize after creating
  // the broker (using broker.onDecorationResized). When unset (GPU-free tests
  // / pre-broker bring-up), the WM still updates the decoration's compositor
  // layout directly -- only the plugin-side redraw is skipped.
  // Seed the WM's primary output from the same dims used for state.outputs's
  // OUTPUT_DEFAULT entry. main.ts's setOnOutputDescriptor updates both maps
  // when the GPU process sends real geometry, including any extra connectors.
  // Shared "freeze surface until X" broker. The WM uses it for its
  // resize-tx (batched, atomic); the cross-output residency handler
  // wired in main.ts uses it for the "client must reallocate at the new
  // scale" wait. Holds on the same surface from both sources coalesce
  // into a single hold whose requirements all must be satisfied.
  const surfaceTx = createSurfaceTransactionBroker(state.compositor);
  state.surfaceTx = surfaceTx;
  // After every broker apply, push any per-output stacks that were
  // deferred during the hold (rebuildStackWithPopups stashed them in
  // state.deferredOutputStacks). This makes the outputStack flip
  // atomic with the surface's new geometry.
  surfaceTx.onAfterApply(() => {
    flushDeferredOutputStacks(state);
    // Window geometry just changed under a possibly-stationary pointer
    // (tiles swapped, windows retiled). Re-derive pointer focus so
    // follow-pointer keyboard focus and client hover state land on the
    // window actually under the cursor, after the stack flush above.
    state.seat?.repickPointer();
  });
  state.wm = createWm(
    state.compositor,
    [{
      id: OUTPUT_DEFAULT,
      rect: { x: 0, y: 0, width: output.width, height: output.height },
      scale: 1,
    }],
    {
      rebuild: () => rebuildStackWithPopups(state),
      configure: configureSink,
      decorationResize: (windowId, outerRect, contentRect, insets) => {
        state.decorationResize?.(windowId, outerRect, contentRect, insets);
      },
      layoutDriverFactory: opts.layoutDriverFactory,
      pluginBus: opts.pluginBus,
      surfaceTx,
      // outputContent: the workspace plugin's view of "ordered visible
      // windows per output" -- the layout-driver consumes this so it only
      // lays out the workspace currently shown on each output. Reads live
      // from state.outputToplevelStacks (populated via the workspace
      // plugin's setOutputStack side effects).
      outputContent: () => state.outputToplevelStacks ?? new Map(),
      // Modal focus tethering: the WM observes when a modal becomes
      // active (or loses modality) and tells the seat to move focus.
      // The seat is constructed AFTER createWm (see GLOBALS loop
      // below), so these closures resolve state.seat lazily. When
      // the seat isn't wired yet (very early-life), tethering is a
      // no-op.
      currentFocusedSurfaceId: () => state.seat?.kbFocus?.surfaceId ?? null,
      requestFocus: (surfaceId) => state.seat?.applyKeyboardFocus(surfaceId),
      // Opening-driver hook: dispatched from wm.windowHasContent
      // before pushStack. state.openingDriver is set by main.ts
      // AFTER the runtime is up; resolve it lazily so the hook is a
      // no-op in early life. Returns true when the driver engaged
      // the content gate (a 'window-opening' plugin claimed); the
      // WM doesn't actually consume the return value (the gate it
      // engages is observed via the existing contentGated machinery
      // in pushStack), but returning a boolean keeps the shape
      // consistent with other plugin-style hooks.
      beforeMap: (surfaceId) => {
        const driver = state.openingDriver;
        if (!driver) return false;
        const rec = state.surfacesById?.get(surfaceId);
        if (!rec) return false;
        return driver.beforeMap(state, rec);
      },
      // Side-effect-free: is a 'window-opening' plugin registered? The WM holds
      // the open until the client acks the tile-size configure ONLY when an
      // animation will actually run (otherwise the window maps immediately).
      hasOpeningAnimation: () => state.openingDriver?.hasHandler() ?? false,
    },
  );
  // Expose wm.schedule via state.relayout for callers outside the WM that
  // affect the tile region (layer-shell reserved-zone changes).
  state.relayout = (reason) => state.wm?.schedule(reason);
  // Cross-output workspace-move residency: subscribe to
  // workspace.window-moved so a window crossing outputs freezes at the
  // OLD location and waits for the client to reallocate at the new
  // scale before applying. The WM's resize-tx (engaged by the same
  // move's "reorder" relayout) shares the broker hold, so the two
  // requirements gate the same atomic apply.
  if (opts.pluginBus) installCrossOutputMove(state, addon, opts.pluginBus);
  if (opts.pluginBus) installLayerShellOutputTeardown(state, opts.pluginBus);
  // State-query channel (tests / introspection): a GPU-free snapshot of
  // geometry / focus / stacking. See src/query.ts.
  state.query = () => queryState(state);

  // Outputs with a present in flight: added when renderFrame presents them,
  // cleared when their flip-complete arrives (dispatchFrameCallbacksForOutput).
  // While an output is here, its frame callbacks are delivered by that flip-
  // complete; the idle frame-callback path skips it so it doesn't deliver ahead
  // of the flip.
  const awaitingFlip = new Set<number>();
  // Published read-only so peer subsystems pacing off the same flips (plugin
  // overlay frame ticks) share this set instead of double-tracking it (the
  // compositor's takePresentedOutputs drain is destructive; only one consumer
  // can own it).
  state.awaitingFlipOutputs = awaitingFlip;

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
        // First content places the window (window.map -> workspace plugin)
        // and makes it drawable + focusable; windowHasContent resolves its
        // tiling lane before the placement's layout pass runs. width/height
        // (the committed buffer size) are ignored for placement — the tile is
        // owned by the layout, not the client.
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
            outputId: s.spawnOutputId ?? OUTPUT_DEFAULT,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            appId: ta.appId, title: ta.title,
          });
          // Now mark the window drawable + push the stack. If a decoration
          // provider matched in the map emission above, the window is already
          // contentGated and will be skipped by computeBaseStack until the
          // decoration's first present releases the gate. The content size (the
          // client's committed window geometry, else its buffer in logical px)
          // sizes a window that resolves to floating so it renders 1:1.
          state.wm?.windowHasContent(id, clientContentSize(s, width, height));
          state.seat?.focusWindow(id, s, rect);
        }
      } else if (s.role === "xwayland") {
        // An xwayland window enters the WM at associate (xwm.ts maybeManage)
        // for managed windows OR is registered as an override-redirect
        // overlay (xwm.ts placeOverlay). Override-redirect surfaces are
        // transient overlays (menus/tooltips/DnD icons); they don't enter
        // the WM, don't emit window.map (plugins shouldn't see them),
        // don't auto-focus, and rebuild the stack themselves via
        // rebuildStackWithPopups. Managed xwayland windows mirror the
        // xdg_toplevel flow.
        const isOverrideRedirect = state.xwm?.findBySurfaceId(id)?.overrideRedirect ?? false;
        if (isOverrideRedirect) {
          // OR placement is owned by xwm.ts (state.overrideRedirects +
          // rebuildStackWithPopups); first content just flips s.mapped.
          // The rebuild already ran on MapNotify; trigger another so the
          // stack actually picks up s.mapped flipping true.
          s.mapped = true;
          mappedAny = true;
          mappedPopup = true;
        } else {
          const rect = state.wm?.rectOf(id);
          if (!rect) {
            // The buffer imported before the XWM finished managing this window
            // (its addWindow waits on the WM_CLASS/title property reads). The
            // window has no layout rect yet, so it can't map. Leave it
            // UNCONSUMED -- do not set s.mapped -- so a re-delivery once the
            // window is managed runs this branch again with a rect. xwm.ts
            // maybeManage re-pushes the import via compositor.redeliverImported
            // right after addWindow. (Setting s.mapped here would make the next
            // pass skip it forever: the window would stay mapped-but-invisible.)
            continue;
          }
          s.mapped = true;
          mappedAny = true;
          const ta = titleAppId(state, id);
          state.bus?.emit(WINDOW_EVENT.map, {
            surfaceId: id,
            outputId: s.spawnOutputId ?? OUTPUT_DEFAULT,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            appId: ta.appId, title: ta.title,
          });
          state.wm?.windowHasContent(id, clientContentSize(s, width, height));
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
        const rect = ls.rect;
        if (rect) {
          state.bus?.emit(WINDOW_EVENT.map, {
            surfaceId: id,
            outputId: ls.output,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            appId: null, title: null,
            role: "layer-shell",
          });
        }
        // Mark the record mapped + push the layer stack. markLayerSurfaceMapped
        // owns the rec.mapped flag so its exclusive-keyboard focus reevaluation
        // runs with mapped=true; setting ls.mapped here first would make it
        // early-return and skip that focus override.
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
      unmapAndTeardownSurface(state, addon, s);
      state.surfaces.delete(s.resource);
      unmappedAny = true;
    }

    // Seat-state sweep: drop stale focus pointing at a destroyed surface, and
    // purge destroyed wl_pointer/wl_keyboard resources from the per-client
    // sets. libwayland recycles wl_client* pointer values across disconnects
    // (clientId is the pointer value), so without this sweep a new client at
    // the recycled address would inherit the dead client's keyboards and a
    // subsequent focus change would post wl_keyboard.leave referencing the
    // dead client's surface -- libwayland rejects that as a cross-client object
    // mismatch and disconnects the new client. Surface-destroy must precede
    // this so the kbFocus.surfaceRec.resource.destroyed flag is current.
    state.seat?.sweepDestroyed();

    // Same disconnect case for module-local protocol registries: these
    // track per-client bound resources outside the wrapper maps, and a
    // client that vanished ran none of the protocol's stop/destroy
    // handlers. Each sweep drops state keyed to a destroyed resource.
    // (The module consts are declared later in this function; this
    // closure only runs after installProtocols completes.)
    foreignTopMod.sweepDisconnected();
    extForeignTopMod.sweepDisconnected();
    xdgForeignMod.sweepDisconnected(ctx);
    shortcutsInhibitMod.sweepDisconnected(ctx);
    extWorkspaceMod.sweepDisconnected();
    outputMgmtMod.sweepDisconnected();
    pointerConstraintsMod.sweepDisconnected(ctx);
    captureMod.sweepDisconnected();
    // Timelines hold kernel drm_syncobj handles; sweeping also releases
    // those, not just the map entries.
    syncobjMod.sweepDisconnected(ctx);
    // Selection ownership: a disconnected owner's selection must be
    // relinquished (offers re-pushed as null / X claim rescinded), not
    // just leak -- see sweepDataDeviceState.
    ddmMod.sweepDataDeviceState(ctx);

    // Same disconnect case for wl_buffers: a client that drops without
    // wl_buffer.destroy leaves its descriptor in state.buffers. A dmabuf
    // descriptor holds an open WaylandFd; an shm descriptor holds a ref on its
    // pool's mapping. The destroy handler did not run, so mirror it here: close
    // the fd / release the pool ref + drop the descriptor (otherwise the wrapper
    // GC-warns and leaks a fd, or the pool mapping never frees).
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
        if (desc.poolId) addon.shmBufferUnref(desc.poolId);
        if (desc.fd && !desc.fd.closed) {
          try { desc.fd.close(); } catch { /* already closed/taken */ }
        }
        state.buffers.delete(resource);
      }
    }

    // Disconnect sweep for shm pools: a client that drops without
    // wl_shm_pool.destroy never runs the destroy handler, so the pool's mmap +
    // dup'd fd would leak. Free each destroyed pool now; its buffers were
    // ref-released in the wl_buffer sweep above, so the pool's refcount can
    // reach 0 and freePool runs.
    if (state.pools) {
      for (const [resource, pool] of [...state.pools.entries()]) {
        if (!resource.destroyed) continue;
        addon.shmDestroyPool(pool.poolId);
        state.pools.delete(resource);
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

    // Shm fast-path releases: the GPU process has acked one or more
    // ShmUpload frames since the last tick. Fire the deferred
    // wl_buffer.release for each acked seq. The buffer was queued at
    // commit time keyed by uploadSeq; we drop the entry on release so
    // the map doesn't grow with the client.
    const shmAcks = state.compositor.takeShmUploadAcks?.() ?? [];
    if (shmAcks.length > 0 && state.pendingShmReleases) {
      for (const seq of shmAcks) {
        const buf = state.pendingShmReleases.get(seq);
        if (!buf) continue;
        state.pendingShmReleases.delete(seq);
        if (!buf.destroyed) events.wl_buffer.send_release(buf);
      }
    }

    // Frame callbacks are NOT dispatched here -- they're per-output, fired by
    // dispatchFrameCallbacksForOutput on each KMS flip-complete. A surface on
    // a 60Hz output gets wl_callback.done at 60Hz even when a 240Hz output is
    // also flipping. The per-tick housekeeping above (imports/maps/unmaps,
    // buffer-release, window-changes, animation tick) still runs at the full
    // wake cadence.

    // Break the idle deadlock. A surface with a pending frame callback whose
    // output has no present coming (not awaiting a flip, not dirty) would never
    // get a flip-complete -- so a client waiting on wl_callback.done that
    // produces no damage of its own stalls forever. Force a present of its
    // current (unchanged, still-resident) content; the resulting flip-complete
    // (dispatchFrameCallbacksForOutput, below) delivers the callback at the real
    // vblank. Done BEFORE renderFrame so the freshly-dirtied output presents
    // THIS pass. Vblank-gated (canPresentAnyOutput), so it cannot exceed the
    // refresh rate; when the client stops re-arming, nothing is pending and
    // nothing presents -> fully idle. Surfaces already presenting/dirty are
    // skipped (their own present delivers via flip-complete).
    const comp = state.compositor;
    for (const s of state.surfaces.values()) {
      const cbs = s.frameCallbacks;
      if (!cbs || cbs.length === 0) continue;
      if (!shouldDeliverFrameCallbackIdle(s.id, comp, awaitingFlip)) continue;
      comp.requestPresentForCallback?.(s.id);
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

    // Outputs renderFrame just presented have a flip in flight; their frame
    // callbacks are delivered when that flip completes. Record them so the next
    // pass's force-present skips a surface that already has a present coming.
    for (const o of state.compositor.takePresentedOutputs?.() ?? []) awaitingFlip.add(o);

    // Frame callbacks are delivered ONLY by dispatchFrameCallbacksForOutput on
    // flip-complete (the real vblank). The force-present above guarantees a
    // flip is coming for any surface with a pending callback, so none strand.
  };

  // Per-output frame-callback dispatch. Called by the addon when a KMS
  // ScanoutFlipComplete is drained for `outputId`. Sends wl_callback.done to
  // each pending callback whose surface overlaps that output -- so a surface
  // resident only on a 60Hz output is paced by its flips, not by a faster
  // peer output's. A surface overlapping NO camera view (a hidden island's
  // member, an elastic strip's off-view tail) has no output of its own to
  // pace against, so its callbacks ride ANY output's flip-complete instead:
  // clients that block on `done` before committing must not deadlock
  // (canvas-design.md §5) -- a stalled off-view client can never redraw its
  // way back into view, and a held resize transaction never releases.
  state.dispatchFrameCallbacksForOutput = (timeMs: number, outputId: number): void => {
    // The flip this output was awaiting has completed.
    awaitingFlip.delete(outputId);
    const surfaceOutputs = state.compositor.surfaceOutputs;
    for (const s of state.surfaces.values()) {
      const cbs = s.frameCallbacks;
      if (!cbs || cbs.length === 0) continue;
      // If the compositor can't report residency, fall back to "all outputs"
      // (back-compat for harnesses with a stub compositor).
      if (surfaceOutputs) {
        const outs = surfaceOutputs.call(state.compositor, s.id);
        if (outs.length > 0 && !outs.includes(outputId)) continue;
      }
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
  };

  // Popup click-away dismissal: the seat calls this on a button press.
  state.dismissGrabbedPopup = (x, y) => maybeDismissGrabbedPopup(ctx, x, y);

  // wp_presentation per-output feedback dispatch. Mirror shape of
  // dispatchFrameCallbacksForOutput: addon fires this on each KMS
  // flip-complete (and nested FrameComplete); we walk surfaces that
  // overlap the output and send `presented` with the scanout
  // timestamp.
  const presentationMod = await import("./wp_presentation.js");
  state.dispatchPresentationFeedbackForOutput = (outputId, tvSec, tvNsec, seq) => {
    presentationMod.dispatchPresentationFeedbackForOutput(
      state, addon, outputId, tvSec, tvNsec, seq);
  };

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
    wl_drm: await import("./wl_drm.js"),
    // wl_seat is constructed via globalHandlers (it takes the focus driver
    // as a second arg, which the generic HandlerFactory shape doesn't allow).
    wl_subcompositor: await import("./wl_subcompositor.js"),
    wl_output: await import("./wl_output.js"),
    wl_data_device_manager: await import("./wl_data_device_manager.js"),
    // wp_cursor_shape_manager_v1 is exposed via globalHandlers; the
    // module's helper factories aren't a default export.
    zwlr_layer_shell_v1: await import("./zwlr_layer_shell_v1.js"),
    zxdg_decoration_manager_v1: await import("./zxdg_decoration_manager_v1.js"),
    org_kde_kwin_server_decoration_manager: await import("./org_kde_kwin_server_decoration_manager.js"),
    zxdg_output_manager_v1: await import("./zxdg_output_manager_v1.js"),
    zwlr_foreign_toplevel_manager_v1: await import("./zwlr_foreign_toplevel_manager_v1.js"),
    wp_viewporter: await import("./wp_viewporter.js"),
    wp_fractional_scale_manager_v1: await import("./wp_fractional_scale_manager_v1.js"),
    wp_linux_drm_syncobj_manager_v1: await import("./wp_linux_drm_syncobj_v1.js"),
    zwlr_output_manager_v1: await import("./zwlr_output_manager_v1.js"),
    zwlr_virtual_pointer_manager_v1: await import("./zwlr_virtual_pointer_manager_v1.js"),
    zwp_virtual_keyboard_manager_v1: await import("./zwp_virtual_keyboard_manager_v1.js"),
    zwp_relative_pointer_manager_v1: await import("./zwp_relative_pointer_manager_v1.js"),
    zwp_pointer_constraints_v1: await import("./zwp_pointer_constraints_v1.js"),
    zwp_keyboard_shortcuts_inhibit_manager_v1: await import("./zwp_keyboard_shortcuts_inhibit_manager_v1.js"),
    ext_workspace_manager_v1: await import("./ext_workspace_v1.js"),
    xwayland_shell_v1: await import("./xwayland_shell_v1.js"),
    ext_data_control_manager_v1: await import("./ext_data_control_v1.js"),
    zwlr_data_control_manager_v1: await import("./zwlr_data_control_v1.js"),
    wp_presentation: await import("./wp_presentation.js"),
    wp_commit_timing_manager_v1: await import("./wp_commit_timing_v1.js"),
    ext_foreign_toplevel_list_v1: await import("./ext_foreign_toplevel_list_v1.js"),
    ext_output_image_capture_source_manager_v1: await import("./ext_image_copy_capture_v1.js"),
    xdg_wm_dialog_v1: await import("./xdg_dialog_v1.js"),
    zxdg_exporter_v2: await import("./xdg_foreign_v2.js"),
    zxdg_importer_v2: await import("./xdg_foreign_v2.js"),
  };

  // Some child interfaces have handlers from a sibling module's named exports.
  const seatMod = await import("./wl_seat.js");
  const dmabufMod = await import("./zwp_linux_dmabuf_v1.js");
  const subMod = await import("./wl_subcompositor.js");
  const ddmMod = await import("./wl_data_device_manager.js");
  const cursorShapeMod = await import("./cursor_shape.js");
  const layerShellMod = await import("./zwlr_layer_shell_v1.js");
  const decorationMod = await import("./zxdg_decoration_manager_v1.js");
  const kdeDecorationMod = await import("./org_kde_kwin_server_decoration_manager.js");
  const xdgOutputMod = await import("./zxdg_output_manager_v1.js");
  const foreignTopMod = await import("./zwlr_foreign_toplevel_manager_v1.js");
  const viewporterMod = await import("./wp_viewporter.js");
  const fracScaleMod = await import("./wp_fractional_scale_manager_v1.js");
  const syncobjMod = await import("./wp_linux_drm_syncobj_v1.js");
  const outputMgmtMod = await import("./zwlr_output_manager_v1.js");
  const virtualPointerMod = await import("./zwlr_virtual_pointer_manager_v1.js");
  const virtualKeyboardMod = await import("./zwp_virtual_keyboard_manager_v1.js");
  const relativePointerMod = await import("./zwp_relative_pointer_manager_v1.js");
  const pointerConstraintsMod = await import("./zwp_pointer_constraints_v1.js");
  const shortcutsInhibitMod = await import("./zwp_keyboard_shortcuts_inhibit_manager_v1.js");
  const extWorkspaceMod = await import("./ext_workspace_v1.js");
  const xwlShellMod = await import("./xwayland_shell_v1.js");
  const extDataControlMod = await import("./ext_data_control_v1.js");
  const extForeignTopMod = await import("./ext_foreign_toplevel_list_v1.js");
  const captureMod = await import("./ext_image_copy_capture_v1.js");
  const xdgDialogMod = await import("./xdg_dialog_v1.js");
  const xdgForeignMod = await import("./xdg_foreign_v2.js");
  const commitTimingMod = await import("./wp_commit_timing_v1.js");
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
    zxdg_toplevel_decoration_v1: decorationMod.makeToplevelDecoration(ctx),
    org_kde_kwin_server_decoration: kdeDecorationMod.makeKdeDecoration(ctx),
    zxdg_output_v1: xdgOutputMod.makeXdgOutput(ctx),
    zwlr_foreign_toplevel_handle_v1: foreignTopMod.makeForeignToplevelHandle(ctx),
    wp_viewport: viewporterMod.makeViewport(ctx),
    wp_fractional_scale_v1: fracScaleMod.makeFractionalScale(ctx),
    wp_linux_drm_syncobj_timeline_v1: syncobjMod.makeSyncobjTimeline(ctx),
    wp_linux_drm_syncobj_surface_v1: syncobjMod.makeSyncobjSurface(ctx),
    zwlr_output_head_v1: outputMgmtMod.makeOutputHead(ctx),
    zwlr_output_mode_v1: outputMgmtMod.makeOutputMode(ctx),
    zwlr_output_configuration_v1: outputMgmtMod.makeOutputConfiguration(ctx),
    zwlr_output_configuration_head_v1: outputMgmtMod.makeOutputConfigurationHead(ctx),
    zwlr_virtual_pointer_v1: virtualPointerMod.makeVirtualPointer(ctx),
    zwp_virtual_keyboard_v1: virtualKeyboardMod.makeVirtualKeyboard(ctx),
    zwp_relative_pointer_v1: relativePointerMod.makeRelativePointer(ctx),
    zwp_locked_pointer_v1: pointerConstraintsMod.makeLockedPointer(ctx),
    zwp_confined_pointer_v1: pointerConstraintsMod.makeConfinedPointer(ctx),
    zwp_keyboard_shortcuts_inhibitor_v1: shortcutsInhibitMod.makeShortcutsInhibitor(ctx),
    ext_workspace_group_handle_v1: extWorkspaceMod.makeExtWorkspaceGroupHandle(ctx),
    ext_workspace_handle_v1: extWorkspaceMod.makeExtWorkspaceHandle(ctx),
    xwayland_surface_v1: xwlShellMod.makeXwaylandSurface(ctx),
    ext_data_control_device_v1: extDataControlMod.makeExtDataControlDevice(ctx),
    ext_data_control_source_v1: extDataControlMod.makeExtDataControlSource(ctx),
    ext_data_control_offer_v1: extDataControlMod.makeExtDataControlOffer(ctx),
    // zwlr data-control children share the ext handlers (family dispatch
    // by interface name inside the shared module).
    zwlr_data_control_device_v1: extDataControlMod.makeExtDataControlDevice(ctx),
    zwlr_data_control_source_v1: extDataControlMod.makeExtDataControlSource(ctx),
    zwlr_data_control_offer_v1: extDataControlMod.makeExtDataControlOffer(ctx),
    // wp_presentation_feedback has no requests (event-only); the protocol layer
    // still needs a handler-shaped object to register.
    wp_presentation_feedback: {},
    wp_commit_timer_v1: commitTimingMod.makeCommitTimer(ctx),
    ext_foreign_toplevel_handle_v1: extForeignTopMod.makeExtForeignToplevelHandle(ctx),
    ext_image_capture_source_v1: captureMod.makeImageCaptureSource(ctx),
    ext_image_copy_capture_session_v1: captureMod.makeImageCopyCaptureSession(ctx),
    ext_image_copy_capture_frame_v1: captureMod.makeImageCopyCaptureFrame(ctx),
    ext_image_copy_capture_cursor_session_v1: captureMod.makeImageCopyCaptureCursorSession(ctx),
    xdg_dialog_v1: xdgDialogMod.makeXdgDialog(ctx),
    zxdg_exported_v2: xdgForeignMod.makeExported(ctx),
    zxdg_imported_v2: xdgForeignMod.makeImported(ctx),
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
    ext_foreign_toplevel_image_capture_source_manager_v1:
      captureMod.makeForeignToplevelImageCaptureSourceManager(ctx),
    ext_image_copy_capture_manager_v1:
      captureMod.makeImageCopyCaptureManager(ctx),
    zxdg_importer_v2: xdgForeignMod.makeImporter(ctx),
  };

  for (const name of CHILD_INTERFACES) {
    const handler = childHandlers[name] ?? handlerMods[name].default(ctx);
    addon.registerInterface(name, handler);
  }
  for (const name of GLOBALS) {
    const handler = globalHandlers[name] ?? handlerMods[name].default(ctx);
    addon.createGlobal(name, handler);
  }
  // wl_output: register the request-handler (release is per-resource and
  // output-independent), then create one global per entry in state.outputs.
  // Each global has its own bind handler tagged with its outputId so a
  // client binding wl_output for output 1 gets output 1's burst.
  addon.registerInterface("wl_output", handlerMods.wl_output.default(ctx));
  for (const outputId of state.outputs.keys()) {
    addon.createGlobalForOutput("wl_output", outputId, makeOutputForOutput(ctx, outputId));
  }

  // Foreign-toplevel manager: subscribe to the typed bus + plugin bus for
  // window lifecycle / state change emission. Wired after globals so the
  // handler factory has already been constructed by the GLOBALS loop above
  // and registered its module-local manager set.
  foreignTopMod.installForeignToplevelBusHooks(ctx);
  // Same shape for ext-foreign-toplevel-list; both protocols enumerate
  // the same toplevels, so the wlr variant's lifecycle hooks aren't
  // reused -- each protocol owns its own subscriber set.
  extForeignTopMod.installExtForeignToplevelBusHooks(ctx);

  // wlr-output-management: subscribe to output.added / output.removed /
  // output.changed on the plugin bus so bound managers see head/mode
  // updates and bumped done(serial) events.
  outputMgmtMod.installOutputManagerBusHooks(ctx);

  // ext-workspace-v1: subscribe to workspace.* and output.added/removed
  // on the plugin bus so bound managers see workspace lifecycle, focus,
  // urgency, and rename events. main.ts populates state.workspaceDriver
  // after the runtime is up so inbound activate / remove / create
  // requests route to the bundled workspace plugin.
  extWorkspaceMod.installExtWorkspaceBusHooks(ctx);

  // ext_image_copy_capture_v1: subscribe to window.unmap (toplevel-source
  // session.stopped) and output.pre-remove (output-source session.stopped),
  // and re-advertise constraints on output.changed (mode swap / resize).
  captureMod.installImageCopyCaptureBusHooks(ctx);

  // Capture-frame dispatch. The protocol fires `ready` on the same flip-
  // complete edge that drives wp_presentation feedback (so the
  // presentation_time event carries the actual scanout timestamp).
  // dispatchCaptureForOutput walks armed frames whose source matches
  // outputId and writes pixels into their attached buffers.
  state.dispatchCaptureForOutput = (outputId, tvSec, tvNsec) => {
    captureMod.dispatchCaptureForOutput(ctx, outputId, tvSec, tvNsec);
  };

  return state;
}
