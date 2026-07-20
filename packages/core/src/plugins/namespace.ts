// Worker-side sdk.registerPlugin / sdk.plugin (core-plugin-api.md §11). Runs
// INSIDE the plugin Worker; talks to core via the Endpoint.
//
// Three halves:
//   1. Registration: the plugin calls sdk.registerPlugin(name, init, opts?).
//      The claim is sent to core (`plugin.register`) and init is STORED,
//      not run -- a claim is inert until core selects it for activation.
//   2. Activation: core sends a `plugin.activate` request when this claim
//      wins its namespace. The worker runs the stored init() then, walks
//      the returned API's function-valued keys to build the method list,
//      replies with it, and remembers the API locally so future
//      plugin.handle requests from core can dispatch into it. A losing
//      claim's init never runs -- side effects a provider performs in its
//      init (actions, subscriptions, input binds) exist only for the
//      winner.
//   3. Consumption: the plugin calls sdk.plugin(name). The worker returns a
//      Proxy whose method calls turn into `plugin.invoke` requests to core.
//      The Proxy resolves when an ACTIVATED winner exists for that
//      namespace (worker asks core via `plugin.wait-for-active`).
//
// The same plugin author code runs unchanged when later moved to in-thread
// execution (bundled). What differs is the transport: in-thread will route
// `plugin.invoke` through direct calls on the next microtask instead of
// postMessage.

import type { Endpoint, Json } from "./protocol.js";

// API type a plugin returns from registerPlugin's init function. Methods may
// be sync or async; results must be structured-clone-safe. Non-function-valued
// keys are recorded but not invokable (a method call on them rejects).
export type RegisteredApi = { [key: string]: unknown };

export type InitFn<API extends RegisteredApi> = () => API | Promise<API>;

export interface RegisterOptions {
  // Higher wins. Defaults: bundled plugins register at 0; user plugins
  // default to 100 if unspecified. Plugins may pass an explicit value to
  // claim a different rank.
  priority?: number;
}

export interface RegistrationHandle {
  // Voluntarily release this namespace claim. Idempotent.
  unregister(): void;
}

export interface PluginNamespace {
  registerPlugin<API extends RegisteredApi>(
    name: string,
    init: InitFn<API>,
    opts?: RegisterOptions,
  ): Promise<RegistrationHandle>;

  // Get a Proxy that routes method calls to the active winner for `name`.
  // The returned promise resolves once SOME plugin claims `name` (with a
  // bounded wait; rejects on timeout). Subsequent method calls on the proxy
  // always route to whoever is currently active.
  plugin<API extends RegisteredApi>(name: string): Promise<API>;
}

// The result of offering an inbound request to the namespace dispatcher.
// `handled: false` means the request method is not ours -- the bootstrap
// should try the next handler in the chain.
export type DispatchResult =
  | { handled: false }
  | { handled: true; result: Json | Promise<Json> };

// Dispatcher for inbound core->plugin requests targeting this worker's
// registered namespaces. The bootstrap wires this into its handleRequests
// chain (first chance to consume; falls through to other handlers if not).
export interface NamespaceDispatcher {
  tryHandle(method: string, params: unknown): DispatchResult;
}

export interface NamespaceHandle {
  ns: PluginNamespace;
  dispatcher: NamespaceDispatcher;
}

// Default wait when sdk.plugin('x') is called and no plugin claims 'x' yet.
// Long enough to absorb load-order races; short enough that a misconfigured
// system fails visibly. core-plugin-api.md "no-plugin-loaded fallback" — in
// the real system the bundled plugins always claim before user plugins try
// to consume, so this only fires on misconfiguration.
const DEFAULT_WAIT_MS = 5_000;

export function createNamespaceHandle(endpoint: Endpoint): NamespaceHandle {
  // Activated local registrations: namespace -> API object (so we can
  // dispatch plugin.handle requests from core into the right method).
  const localApis = new Map<string, RegisteredApi>();
  // Claims awaiting activation: namespace -> the stored init. Moved into
  // localApis when core sends plugin.activate.
  const pendingInits = new Map<string, InitFn<RegisteredApi>>();

  const ns: PluginNamespace = {
    async registerPlugin(name, init, opts): Promise<RegistrationHandle> {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("registerPlugin name must be a non-empty string");
      }
      if (typeof init !== "function") {
        throw new TypeError("registerPlugin init must be a function");
      }
      if (localApis.has(name) || pendingInits.has(name)) {
        throw new Error(`already registered for namespace '${name}'`);
      }

      // Store init for activation; the claim itself carries no API surface.
      pendingInits.set(name, init);

      const priority = opts?.priority;
      const payload: Json = { namespace: name };
      if (typeof priority === "number") (payload as { [k: string]: Json }).priority = priority;
      endpoint.emit("plugin.register", payload);

      return {
        unregister(): void {
          if (!localApis.has(name) && !pendingInits.has(name)) return;
          localApis.delete(name);
          pendingInits.delete(name);
          endpoint.emit("plugin.unregister", { namespace: name });
        },
      };
    },

    async plugin<API extends RegisteredApi>(name: string): Promise<API> {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("plugin name must be a non-empty string");
      }
      // Block until some plugin claims this namespace (or timeout).
      await endpoint.request("plugin.wait-for-active",
        { namespace: name, timeoutMs: DEFAULT_WAIT_MS });

      // Return a Proxy that forwards method calls as plugin.invoke requests.
      // The proxy only handles method-shaped accesses (property access ->
      // function -> call). Property reads of non-function values are not
      // supported: the proxy never owns concrete data, only method shapes.
      const handler: ProxyHandler<API> = {
        get(_target, prop): unknown {
          if (typeof prop === "symbol") return undefined;
          if (prop === "then" || prop === "catch" || prop === "finally") {
            // Prevent Promise auto-unwrap thinking this object is thenable.
            // (Promise.resolve(proxy) would otherwise call .then(...).)
            return undefined;
          }
          return (...args: unknown[]): Promise<unknown> => {
            return endpoint.request("plugin.invoke", {
              namespace: name,
              method: prop,
              args: args as Json[],
            });
          };
        },
      };
      // The target is an empty object; the Proxy intercepts every property
      // access and produces an invoke-bound function.
      return new Proxy({} as API, handler);
    },
  };

  const dispatcher: NamespaceDispatcher = {
    tryHandle(method, params): DispatchResult {
      if (method === "plugin.activate") {
        const nsName = (params as { namespace?: unknown } | null)?.namespace;
        if (typeof nsName !== "string") {
          return { handled: true,
            result: Promise.reject(new Error("plugin.activate: malformed payload")) };
        }
        // Idempotent for an already-activated namespace: report the
        // existing API surface (core may retry after a dropped reply).
        const existing = localApis.get(nsName);
        if (existing) {
          return { handled: true, result: Promise.resolve({ methods: methodsOf(existing) }) };
        }
        const init = pendingInits.get(nsName);
        if (!init) {
          return { handled: true, result: Promise.reject(new Error(
            `plugin.activate: no claim stored for '${nsName}'`)) };
        }
        const result = (async (): Promise<Json> => {
          const api = await init();
          if (api === null || typeof api !== "object") {
            throw new TypeError(
              `registerPlugin('${nsName}'): init must return an object (got ${typeof api})`);
          }
          pendingInits.delete(nsName);
          localApis.set(nsName, api);
          return { methods: methodsOf(api) };
        })();
        return { handled: true, result };
      }

      if (method !== "plugin.handle") return { handled: false };
      if (!isHandlePayload(params)) {
        // We DID recognize the method; reject it loudly. (Not falling
        // through: a malformed plugin.handle is a bug, not a different
        // handler's responsibility.)
        return { handled: true,
          result: Promise.reject(new Error("plugin.handle: malformed payload")) };
      }
      const api = localApis.get(params.namespace);
      if (!api) {
        return { handled: true, result: Promise.reject(new Error(
          `plugin.handle: no local registration for '${params.namespace}' ` +
          `(plugin lost its registration?)`)) };
      }
      const fn = api[params.method];
      if (typeof fn !== "function") {
        return { handled: true, result: Promise.reject(new Error(
          `plugin.handle: '${params.namespace}.${params.method}' is not a function`)) };
      }
      // Invoke; the plugin's method may return value or Promise. Cast to Json
      // at the boundary: the plugin author is responsible for returning
      // structured-clone-safe values, same trust contract as other SDK paths.
      const result = (async (): Promise<Json> => {
        const r = await (fn as (...a: unknown[]) => unknown)(...params.args);
        return r as Json;
      })();
      return { handled: true, result };
    },
  };

  return { ns, dispatcher };
}

function methodsOf(api: RegisteredApi): string[] {
  const methods: string[] = [];
  for (const key of Object.keys(api)) {
    if (typeof api[key] === "function") methods.push(key);
  }
  return methods;
}

function isHandlePayload(d: unknown): d is { namespace: string; method: string; args: unknown[] } {
  return typeof d === "object" && d !== null
    && typeof (d as { namespace?: unknown }).namespace === "string"
    && typeof (d as { method?: unknown }).method === "string"
    && Array.isArray((d as { args?: unknown }).args);
}
