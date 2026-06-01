// Core-side decoration request broker. Services the plugin Worker's
// `decoration.*` requests (piece 1: only `decoration.register`) and owns the
// decoration registry, which subscribes to the bus and emits decoration.assigned
// to matched provider plugins. Parallels gpu-broker.ts; main.ts routes
// decoration.* requests here and gpu.*/surface.* to the GPU broker.

import type { CompositorBus } from "../events/window-bus.js";
import type { CompositorState } from "../protocols/ctx.js";
import { createDecorationRegistry } from "../decorations.js";
import type { DecorationRegistry, EmitToPlugin } from "../decorations.js";

export interface DecorationBrokerDeps {
  bus: CompositorBus;
  // Compositor state (for the WM: inset reservation). The broker reads state.wm.
  state: CompositorState;
  // Push a one-way event to one plugin Worker by name (PluginRuntime.emit).
  emitToPlugin: EmitToPlugin;
}

export interface DecorationBroker {
  // The request handler (decoration.* methods). Returns the response value (null
  // for register). `params` is untyped at the wire boundary and validated inside.
  onRequest(pluginName: string, method: string, params: unknown): unknown;
  // Drop a plugin's providers (plugin teardown). Exposed for the runtime to call.
  unregisterPlugin(pluginName: string): void;
  registry: DecorationRegistry;
}

export function createDecorationBroker(deps: DecorationBrokerDeps): DecorationBroker {
  const registry = createDecorationRegistry(deps.bus, deps.emitToPlugin);

  function onRequest(pluginName: string, method: string, params: unknown): unknown {
    switch (method) {
      case "decoration.register": {
        const { pattern, flags } = readRegisterParams(params);
        // new RegExp(pattern, flags) inside register() throws on a bad pattern; let
        // it propagate so the plugin's request rejects with the syntax error.
        registry.register(pluginName, pattern, flags);
        return null;
      }
      case "decoration.requestInsets": {
        const { surfaceId, insets } = readInsetsParams(params);
        // Authorization: a plugin may only reserve insets on a window assigned to
        // it (it got the decoration.assigned event). Reject otherwise.
        if (registry.assignmentOf(surfaceId) !== pluginName) {
          throw new Error(`decoration.requestInsets: surface ${surfaceId} not assigned to '${pluginName}'`);
        }
        const grant = deps.state.wm?.setInsets(surfaceId, insets);
        if (!grant) throw new Error(`decoration.requestInsets: no such mapped window ${surfaceId}`);
        // Return the granted geometry; the plugin allocates its decoration surface
        // at outerRect (the inset border region around the content).
        return { insets: grant.insets, outerRect: grant.outerRect, contentRect: grant.contentRect };
      }
      default:
        throw new Error(`decoration-broker: unknown method '${method}'`);
    }
  }

  return { onRequest, unregisterPlugin: (p) => registry.unregisterPlugin(p), registry };
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

// Validate decoration.requestInsets params: { surfaceId: number, insets: {top,
// right,bottom,left: number} }.
function readInsetsParams(params: unknown): {
  surfaceId: number; insets: { top: number; right: number; bottom: number; left: number };
} {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("decoration.requestInsets: params must be an object");
  }
  const rec = params as Record<string, unknown>;
  if (typeof rec.surfaceId !== "number") {
    throw new Error("decoration.requestInsets: `surfaceId` must be a number");
  }
  const i = rec.insets;
  if (typeof i !== "object" || i === null) {
    throw new Error("decoration.requestInsets: `insets` must be an object");
  }
  const ir = i as Record<string, unknown>;
  for (const k of ["top", "right", "bottom", "left"] as const) {
    if (typeof ir[k] !== "number") throw new Error(`decoration.requestInsets: insets.${k} must be a number`);
  }
  return {
    surfaceId: rec.surfaceId,
    insets: { top: ir.top as number, right: ir.right as number, bottom: ir.bottom as number, left: ir.left as number },
  };
}
