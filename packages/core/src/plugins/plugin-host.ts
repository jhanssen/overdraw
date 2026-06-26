// Shared types between the Worker-mode plugin host (ManagedPlugin in
// runtime.ts) and the in-thread host (InThreadPlugin). Lives in its own
// module to break the otherwise-circular import.

import type { Endpoint, Json, RequestHandler } from "./protocol.js";
import type { NamespaceRegistry } from "./namespace-registry.js";
import type { ActionRegistry } from "./action-registry.js";
import type { ResolvedPlugin } from "../config/types.js";
import type { BusBridge } from "./bus-bridge.js";

export type PluginState =
  | "spawning"
  | "live"
  | "shutting-down"
  | "failed";

// What a plugin host calls when its plugin produces a registry-affecting
// event. PluginRuntime implements it.
export interface PluginController {
  registry(): NamespaceRegistry;
  onRegister(pluginName: string, payload: unknown): void;
  onUnregister(pluginName: string, payload: unknown): void;
  onInvoke(callerName: string, payload: unknown): Promise<Json>;
  onWaitForActive(callerName: string, payload: unknown): Promise<Json>;
  actions(): ActionRegistry;
  onActionRegister(pluginName: string, payload: unknown): void;
  onActionUnregister(pluginName: string, payload: unknown): void;
  onActionInvoke(callerName: string, payload: unknown): Promise<Json>;
  onActionList(callerName: string, payload: unknown): Promise<Json>;
}

// Fallback for plugin->core requests not handled by the namespace/action
// plumbing (gpu/decoration brokers). Both hosts accept one of these.
export type HostRequestFallback =
  (pluginName: string, method: string, params: unknown) => Promise<unknown> | unknown;

// Core-side request routing shared by both plugin hosts: namespace + action
// plumbing first, then the optional broker fallback, else a no-handler error.
export function makePluginRequestHandler(
  ns: PluginController,
  pluginName: string,
  fallback?: HostRequestFallback,
): RequestHandler {
  return async (method, params) => {
    if (method === "plugin.invoke") return await ns.onInvoke(pluginName, params);
    if (method === "plugin.wait-for-active") return await ns.onWaitForActive(pluginName, params);
    if (method === "actions.invoke") return await ns.onActionInvoke(pluginName, params);
    if (method === "actions.list") return await ns.onActionList(pluginName, params);
    if (fallback) return (await fallback(pluginName, method, params)) as Json;
    throw new Error(`no handler for request '${method}'`);
  };
}

// Core-side routing for a plugin->core event: SDK event-bus interactions
// (core-plugin-api.md §3), then namespace (§11) and action (§10) registry
// events. Returns true when consumed; false means the caller should surface
// the event to its own observer.
export function dispatchHostRegistryEvent(
  ns: PluginController,
  pluginName: string,
  bridge: BusBridge,
  name: string,
  data: unknown,
): boolean {
  if (bridge.handle(name, data)) return true;
  if (name === "plugin.register") { ns.onRegister(pluginName, data); return true; }
  if (name === "plugin.unregister") { ns.onUnregister(pluginName, data); return true; }
  if (name === "actions.register") { ns.onActionRegister(pluginName, data); return true; }
  if (name === "actions.unregister") { ns.onActionUnregister(pluginName, data); return true; }
  return false;
}

// What PluginRuntime needs from a plugin host. The runtime holds these in
// one list, oblivious to which transport each uses.
export interface PluginHandle {
  readonly cfg: ResolvedPlugin;
  readonly ready: Promise<void>;
  readonly currentState: PluginState;
  readonly restartCount: number;
  // The endpoint to dispatch invokes against, or null if the plugin is
  // not live (still spawning, or failed).
  endpointHandle(): Endpoint | null;
  // One-way core -> plugin event. No-op unless live.
  emit(name: string, data: Json): void;
  stop(): Promise<void>;
}
