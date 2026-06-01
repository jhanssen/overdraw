// Core-side decoration request broker. Services the plugin Worker's
// `decoration.*` requests (piece 1: only `decoration.register`) and owns the
// decoration registry, which subscribes to the bus and emits decoration.assigned
// to matched provider plugins. Parallels gpu-broker.ts; main.ts routes
// decoration.* requests here and gpu.*/surface.* to the GPU broker.

import type { CompositorBus } from "../events/window-bus.js";
import { createDecorationRegistry } from "../decorations.js";
import type { DecorationRegistry, EmitToPlugin } from "../decorations.js";

export interface DecorationBrokerDeps {
  bus: CompositorBus;
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
