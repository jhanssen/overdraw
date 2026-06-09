// Shared types between the Worker-mode plugin host (ManagedPlugin in
// runtime.ts) and the in-thread host (InThreadPlugin). Lives in its own
// module to break the otherwise-circular import.

import type { Endpoint, Json } from "./protocol.js";
import type { NamespaceRegistry } from "./namespace-registry.js";
import type { ActionRegistry } from "./action-registry.js";
import type { ResolvedPlugin } from "../config/types.js";

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
