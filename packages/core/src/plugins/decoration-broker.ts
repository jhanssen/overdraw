// Core-side decoration broker. Owns the decoration registry + the content-gating
// state machine. main.ts routes decoration.*
// requests here and gpu.*/surface.* to the GPU broker; it also forwards the GPU
// broker's generic surface hooks (alloc-with-`decorates` tag, first-present) here
// so the broker can link a decoration surface to its window and release the gate.
//
// Flow: a provider registers a pattern; on a matching window map the registry
// assigns it -> the broker emits decoration.assigned to the plugin AND gates the
// window's content (held out of the draw stack) + arms a first-frame timeout. The
// plugin calls createDecoration(windowId, {insets}) -> the broker reserves additive
// insets (WM) and returns the outer rect; the plugin allocates its ring there
// (tagging the alloc with `decorates: windowId`). When that decoration surface
// receives its FIRST frame, the broker releases the gate (content + decoration
// appear together) and cancels the timeout. If the timeout fires first, the broker
// logs an error, permanently deregisters the provider, tells the plugin
// (decoration.deregistered), and releases the gate (the window shows undecorated).

import type { CompositorBus } from "../events/window-bus.js";
import type { CompositorState } from "../protocols/ctx.js";
import { createDecorationRegistry } from "../decorations.js";
import type { DecorationRegistry } from "../decorations.js";
import { DECORATION_EVENT } from "../events/types.js";
import { log } from "../log.js";
import type { DecorationAssignedEvent, DecorationDeregisteredEvent,
  DecorationResizedEvent } from "../events/types.js";

// Default first-decoration-frame deadline. Generous enough for a provider that
// compiles shaders / builds pipelines before its first present.
export const DEFAULT_DECORATION_TIMEOUT_MS = 500;

// Push a one-way event to one plugin Worker by name (PluginRuntime.emit). The
// `data` is a structured-clone-safe decoration payload.
export type EmitToPlugin =
  (pluginName: string, name: string,
   data: DecorationAssignedEvent | DecorationDeregisteredEvent | DecorationResizedEvent) => void;

export interface DecorationBrokerDeps {
  bus: CompositorBus;
  // Compositor state (the WM: inset reservation + content gating). Reads state.wm.
  state: CompositorState;
  emitToPlugin: EmitToPlugin;
  // First-decoration-frame deadline (ms). Defaults to DEFAULT_DECORATION_TIMEOUT_MS.
  timeoutMs?: number;
}

export interface DecorationBroker {
  onRequest(pluginName: string, method: string, params: unknown): unknown;
  // Generic GPU-broker hooks (wired in main.ts): a decoration surface was created
  // for a window; a surface received a frame. The broker filters for its own.
  onSurfaceAllocated(decoSurfaceId: number, windowId: number): void;
  onSurfacePresented(surfaceId: number): void;
  // Forwarded by the WM (via the DecorationResizeSink it was given) when a
  // decorated window's outer tile changed: emit decoration.resized to the
  // owning plugin so it can redraw at the new size (destroy old ring + create
  // a new one at the new rect). The WM has already updated the decoration
  // surface's compositor layout, so the existing texture composites at the
  // new rect in the meantime; the redraw replaces it.
  onDecorationResized(windowId: number, outerRect: { x: number; y: number; width: number; height: number },
                      contentRect: { x: number; y: number; width: number; height: number },
                      insets: { top: number; right: number; bottom: number; left: number }): void;
  unregisterPlugin(pluginName: string): void;
  registry: DecorationRegistry;
}

// Per-gated-window state: the provider, the timeout timer, and the decoration
// surface id once allocated (so a first present on it releases the gate).
interface Gate {
  windowId: number;
  pluginName: string;
  timer: ReturnType<typeof setTimeout>;
  decoSurfaceId: number | null;   // set when createDecoration allocates the surface
  released: boolean;
}

export function createDecorationBroker(deps: DecorationBrokerDeps): DecorationBroker {
  const { bus, state, emitToPlugin } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DECORATION_TIMEOUT_MS;

  // windowId -> Gate (active gates only). decoSurfaceId -> windowId for fast lookup
  // on first present (lives only while a gate is active).
  const gates = new Map<number, Gate>();
  const decoToWindow = new Map<number, number>();
  // windowId -> its window-bound decoration surface id (persists past gate release;
  // used to clear the WM binding on unmap). The WM splices this below the window's
  // content in computeBaseStack so the decoration is z-bound to its window.
  const windowToDeco = new Map<number, number>();

  // Release a window's content gate (idempotent): un-gate in the WM, cancel the
  // timer, drop bookkeeping. Called on first decoration frame, on timeout, and on
  // unmap.
  function releaseGate(windowId: number, reason: string): void {
    const g = gates.get(windowId);
    if (!g || g.released) return;
    g.released = true;
    clearTimeout(g.timer);
    state.wm?.releaseContentGate(windowId, "decoration");
    if (g.decoSurfaceId !== null) decoToWindow.delete(g.decoSurfaceId);
    gates.delete(windowId);
    void reason;
  }

  // A provider failed to produce a first decoration frame in time: log, permanently
  // deregister it, notify it, and release the gate (window shows undecorated).
  function onTimeout(windowId: number): void {
    const g = gates.get(windowId);
    if (!g || g.released) return;
    log.err("plugin", `decoration: provider '${g.pluginName}' did not draw window ${windowId} `
      + `within ${timeoutMs}ms; deregistering (window shown undecorated)`);
    registry.unregisterPlugin(g.pluginName);
    emitToPlugin(g.pluginName, DECORATION_EVENT.deregistered,
      { reason: "first-frame-timeout", windowId });
    releaseGate(windowId, "timeout");
  }

  // Registry callback: a window was assigned to a provider. Notify the plugin, gate
  // the window's content, and arm the first-frame timeout.
  function onAssigned(ev: DecorationAssignedEvent, pluginName: string): void {
    emitToPlugin(pluginName, DECORATION_EVENT.assigned, ev);
    state.wm?.engageContentGate(ev.surfaceId, "decoration");
    const timer = setTimeout(() => onTimeout(ev.surfaceId), timeoutMs);
    timer.unref?.();
    gates.set(ev.surfaceId, {
      windowId: ev.surfaceId, pluginName, timer, decoSurfaceId: null, released: false,
    });
  }

  // Registry callback: a tracked window unmapped. Release any gate + clear the WM
  // decoration binding (no-op if the window is already gone from the WM).
  function onUnmapped(windowId: number): void {
    releaseGate(windowId, "unmap");
    if (windowToDeco.has(windowId)) {
      windowToDeco.delete(windowId);
      state.wm?.setDecorationSurface(windowId, null);
    }
  }

  const registry = createDecorationRegistry(bus, onAssigned, onUnmapped);

  function onRequest(pluginName: string, method: string, params: unknown): unknown {
    switch (method) {
      case "decoration.register": {
        const { pattern, flags } = readRegisterParams(params);
        registry.register(pluginName, pattern, flags);
        return null;
      }
      case "decoration.createDecoration": {
        const { windowId, insets } = readCreateParams(params);
        // Authorization: only the plugin the window is assigned to may decorate it.
        if (registry.assignmentOf(windowId) !== pluginName) {
          throw new Error(`decoration.createDecoration: window ${windowId} not assigned to '${pluginName}'`);
        }
        const grant = state.wm?.setInsets(windowId, insets);
        if (!grant) throw new Error(`decoration.createDecoration: no such mapped window ${windowId}`);
        // The plugin now allocates its ring at outerRect, tagging the alloc with
        // `decorates: windowId`; onSurfaceAllocated links the decoration surface to
        // the window. Return the geometry the plugin renders to.
        return { insets: grant.insets, outerRect: grant.outerRect, contentRect: grant.contentRect };
      }
      default:
        throw new Error(`decoration-broker: unknown method '${method}'`);
    }
  }

  function onSurfaceAllocated(decoSurfaceId: number, windowId: number): void {
    // Bind the decoration surface to its window in the WM so it draws directly below
    // the window's content (z-bound). Done regardless of gate state and persists past
    // gate release (cleared on unmap).
    windowToDeco.set(windowId, decoSurfaceId);
    state.wm?.setDecorationSurface(windowId, decoSurfaceId);
    const g = gates.get(windowId);
    if (!g) return;   // not a gated decoration window (or already released)
    g.decoSurfaceId = decoSurfaceId;
    decoToWindow.set(decoSurfaceId, windowId);
  }

  function onSurfacePresented(surfaceId: number): void {
    const windowId = decoToWindow.get(surfaceId);
    if (windowId === undefined) return;   // not a decoration surface we gate on
    // First decoration frame is installed -> content + decoration appear together.
    releaseGate(windowId, "first-frame");
  }

  function onDecorationResized(
    windowId: number,
    outerRect: { x: number; y: number; width: number; height: number },
    contentRect: { x: number; y: number; width: number; height: number },
    insets: { top: number; right: number; bottom: number; left: number },
  ): void {
    // Only relevant if the window is assigned to a provider (else nobody redraws).
    const pluginName = registry.assignmentOf(windowId);
    if (pluginName === undefined) return;
    const ev: DecorationResizedEvent = { windowId, outerRect, contentRect, insets };
    emitToPlugin(pluginName, DECORATION_EVENT.resized, ev);
  }

  return {
    onRequest, onSurfaceAllocated, onSurfacePresented, onDecorationResized,
    unregisterPlugin: (p) => registry.unregisterPlugin(p),
    registry,
  };
}

// Validate the decoration.register params at the trust boundary (a plugin sends
// them, untyped). `pattern` is required + a non-empty string; `flags` optional.
function readRegisterParams(params: unknown): { pattern: string; flags?: string } {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("decoration.register: params must be an object");
  }
  const rec = params as Record<string, unknown>;
  const pattern = rec.pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("decoration.register: `pattern` must be a non-empty string");
  }
  const flags = rec.flags;
  if (flags !== undefined && typeof flags !== "string") {
    throw new Error("decoration.register: `flags` must be a string");
  }
  return { pattern, ...(flags !== undefined ? { flags } : {}) };
}

// Validate decoration.createDecoration params: { windowId: number, insets:
// {top,right,bottom,left: number} }.
function readCreateParams(params: unknown): {
  windowId: number; insets: { top: number; right: number; bottom: number; left: number };
} {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("decoration.createDecoration: params must be an object");
  }
  const rec = params as Record<string, unknown>;
  if (typeof rec.windowId !== "number") {
    throw new Error("decoration.createDecoration: `windowId` must be a number");
  }
  const i = rec.insets;
  if (typeof i !== "object" || i === null) {
    throw new Error("decoration.createDecoration: `insets` must be an object");
  }
  const ir = i as Record<string, unknown>;
  for (const k of ["top", "right", "bottom", "left"] as const) {
    if (typeof ir[k] !== "number") throw new Error(`decoration.createDecoration: insets.${k} must be a number`);
  }
  return {
    windowId: rec.windowId,
    insets: { top: ir.top as number, right: ir.right as number, bottom: ir.bottom as number, left: ir.left as number },
  };
}
