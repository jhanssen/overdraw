// Shared types between ManagedPlugin (Worker-mode, runtime.ts) and
// InThreadPlugin (in-thread bundled, inthread-plugin.ts). Both implement
// PluginHandle so PluginRuntime can hold them in one list and treat them
// uniformly (endpoint lookup, namespace dispatch, emit, lifecycle).
//
// Why a shared module: avoids a circular import between runtime.ts and
// inthread-plugin.ts and keeps the public contract surface in one place.

import type { Endpoint, Json } from "./protocol.js";
import type { NamespaceRegistry } from "./namespace-registry.js";
import type { ActionRegistry } from "./action-registry.js";
import type { ResolvedPlugin } from "../config/types.js";

// Lifecycle states. Same set for both transports; "spawning" maps to
// "loader started but init not yet acknowledged" on the in-thread path.
export type PluginState =
  | "spawning"
  | "live"
  | "shutting-down"
  | "failed";

// The controller a plugin host (Worker or in-thread) calls when its plugin
// produces a registry-affecting event. The runtime implements this; both
// ManagedPlugin and InThreadPlugin reference it.
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

// What PluginRuntime needs from a plugin host. Both ManagedPlugin and
// InThreadPlugin implement this interface (one runs in a worker_threads
// Worker; the other on the main thread via a paired Channel). The runtime
// holds a list of PluginHandle, oblivious to which transport each uses.
export interface PluginHandle {
  readonly cfg: ResolvedPlugin;
  readonly ready: Promise<void>;
  readonly currentState: PluginState;
  readonly restartCount: number;
  // The endpoint to dispatch invokes against, or null if the plugin is not
  // currently live (still spawning, or failed).
  endpointHandle(): Endpoint | null;
  // Push a one-way event to this plugin's loader (no-op unless live).
  emit(name: string, data: Json): void;
  // Graceful shutdown.
  stop(): Promise<void>;
}
