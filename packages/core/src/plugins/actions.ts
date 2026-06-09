// Worker-side sdk.actions (core-plugin-api.md §10). Runs INSIDE the plugin
// Worker; talks to core via the Endpoint.
//
// Two halves:
//   1. Registration: the plugin calls sdk.actions.register({name, handler,
//      description?, schema?}). The worker stores the handler locally for
//      dispatch and sends `actions.register` to core (one-way event).
//   2. Consumption: the plugin calls sdk.actions.invoke(name, params). The
//      worker sends `actions.invoke` to core, which routes to the owning
//      plugin's worker via `actions.handle`. Returns the handler's result.
//   3. Listing: sdk.actions.list returns the system-wide action inventory
//      (sends an `actions.list` request to core).

import type { Endpoint, Json } from "./protocol.js";

export type ActionSchema = unknown;

export interface ActionInfo {
  name: string;
  description?: string;
  schema?: ActionSchema;
}

export type ActionHandler = (params: unknown) => unknown | Promise<unknown>;

export interface ActionRegisterSpec {
  // Namespaced action name ('workspace.show', 'window.close', ...).
  name: string;
  // Optional human-readable description (shown in CLI introspection / help).
  description?: string;
  // Optional schema (JSON-Schema-ish) for IPC parameter validation. Core
  // does not validate against it; the IPC layer does.
  schema?: ActionSchema;
  // The handler invoked when this action is called. Sync or async; result is
  // returned to the caller (must be structured-clone-safe).
  handler: ActionHandler;
}

export interface ActionRegistration {
  // Voluntarily release this action registration. Idempotent.
  unregister(): void;
}

export interface PluginActions {
  register(spec: ActionRegisterSpec): ActionRegistration;
  invoke(name: string, params?: unknown): Promise<unknown>;
  list(): Promise<ActionInfo[]>;
}

// Same DispatchResult shape used elsewhere (namespace.ts).
export type DispatchResult =
  | { handled: false }
  | { handled: true; result: Json | Promise<Json> };

export interface ActionsDispatcher {
  tryHandle(method: string, params: unknown): DispatchResult;
}

export interface ActionsHandle {
  actions: PluginActions;
  dispatcher: ActionsDispatcher;
}

export function createPluginActions(endpoint: Endpoint): ActionsHandle {
  // Local handler table: name -> handler function. Populated on register;
  // looked up on inbound `actions.handle` requests from core.
  const handlers = new Map<string, ActionHandler>();

  const actions: PluginActions = {
    register(spec): ActionRegistration {
      if (typeof spec !== "object" || spec === null) {
        throw new TypeError("actions.register expects an object");
      }
      if (typeof spec.name !== "string" || spec.name.length === 0) {
        throw new TypeError("actions.register name must be a non-empty string");
      }
      if (typeof spec.handler !== "function") {
        throw new TypeError("actions.register handler must be a function");
      }
      if (handlers.has(spec.name)) {
        throw new Error(`action '${spec.name}' already registered by this plugin`);
      }
      handlers.set(spec.name, spec.handler);
      const payload: Json = { name: spec.name };
      if (spec.description !== undefined) {
        (payload as { [k: string]: Json }).description = spec.description;
      }
      if (spec.schema !== undefined) {
        // Cast to Json: schema is opaque to core; the plugin author is
        // responsible for it being structured-clone-safe.
        (payload as { [k: string]: Json }).schema = spec.schema as Json;
      }
      endpoint.emit("actions.register", payload);
      return {
        unregister(): void {
          if (!handlers.has(spec.name)) return;
          handlers.delete(spec.name);
          endpoint.emit("actions.unregister", { name: spec.name });
        },
      };
    },
    async invoke(name, params): Promise<unknown> {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("actions.invoke name must be a non-empty string");
      }
      return await endpoint.request("actions.invoke",
        { name, params: (params ?? null) as Json });
    },
    async list(): Promise<ActionInfo[]> {
      const r = await endpoint.request("actions.list", null);
      // Core constructs this from the typed ActionRegistry; the shape is
      // ActionInfo[] by construction. The wire's Json type cannot express
      // optional fields like description/schema directly, so this is the
      // narrowing point. (Cast via Json[] -> ActionInfo[]; eslint-disable
      // justified because the producer is core, not an untrusted source.)
      // eslint-disable-next-line no-restricted-syntax
      return r as unknown as ActionInfo[];
    },
  };

  const dispatcher: ActionsDispatcher = {
    tryHandle(method, params): DispatchResult {
      if (method !== "actions.handle") return { handled: false };
      if (!isHandlePayload(params)) {
        return { handled: true,
          result: Promise.reject(new Error("actions.handle: malformed payload")) };
      }
      const handler = handlers.get(params.name);
      if (!handler) {
        return { handled: true, result: Promise.reject(new Error(
          `actions.handle: '${params.name}' is not registered by this plugin`)) };
      }
      const result = (async (): Promise<Json> => {
        const r = await handler(params.params);
        return r as Json;
      })();
      return { handled: true, result };
    },
  };

  return { actions, dispatcher };
}

function isHandlePayload(d: unknown): d is { name: string; params: unknown } {
  return typeof d === "object" && d !== null
    && typeof (d as { name?: unknown }).name === "string"
    && "params" in (d as object);
}
