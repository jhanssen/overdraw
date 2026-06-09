// Worker-side `sdk.events` implementation (core-plugin-api.md §3). Runs inside
// the plugin Worker (or in-thread bundled plugin); talks to the core over the
// Endpoint.
//
// Plugin -> core:
//   one-way: events.subscribe          { subId: number, pattern: string }
//   one-way: events.unsubscribe        { subId: number }
//   one-way: events.emit               { name: string, payload: unknown }
//   one-way: events.intercept-register { interceptId: number, pattern: string,
//                                        priority?: number }
//   one-way: events.intercept-unregister { interceptId: number }
//
// Core -> plugin:
//   one-way: events.dispatch         { subId, name, payload }
//   REQUEST: events.intercept-handle { interceptId, name, payload }
//            -> reply with the (possibly modified) payload, or null/undefined
//               for observe-only.
//
// IDs are plugin-local counters. The plugin's tryHandleRequest dispatches
// `events.intercept-handle` to the registered handler; the loader calls it
// before generic per-method dispatch.

import type { Endpoint } from "./protocol.js";
import type { Json } from "./protocol.js";

export type EventListener = (name: string, payload: unknown) => void;

export type EventInterceptor =
  (name: string, payload: unknown) => unknown | Promise<unknown> | void;

export interface EventSubscription {
  off(): void;
}

export interface InterceptOptions {
  priority?: number;
}

export interface PluginEvents {
  subscribe(pattern: string, cb: EventListener): EventSubscription;
  emit(name: string, payload: unknown): void;
  // Register an interceptor. Lower priority runs first; ties by registration
  // order. The handler returns the modified payload (or a Promise of it), or
  // undefined to observe without modifying. Core awaits the result before
  // proceeding with the emit's downstream action.
  intercept(pattern: string, cb: EventInterceptor, opts?: InterceptOptions): EventSubscription;
}

// Dispatcher for one-way `events.dispatch` events arriving from core.
export interface EventsDispatcher {
  dispatch(name: string, data: unknown): boolean;
}

// Dispatcher for core->plugin REQUESTS (`events.intercept-handle`).
// Returns { handled: false } when method isn't ours so the loader can try
// other dispatchers; { handled: true, result } when consumed.
export interface InterceptRequestDispatcher {
  tryHandle(method: string, params: Json): { handled: false } | { handled: true; result: Promise<Json> };
}

export interface EventsHandle {
  events: PluginEvents;
  dispatcher: EventsDispatcher;
  requests: InterceptRequestDispatcher;
}

export function createPluginEvents(endpoint: Endpoint): EventsHandle {
  let nextSubId = 1;
  let nextInterceptId = 1;
  const subs = new Map<number, EventListener>();
  const interceptors = new Map<number, EventInterceptor>();

  const events: PluginEvents = {
    subscribe(pattern, cb): EventSubscription {
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new TypeError("subscribe pattern must be a non-empty string");
      }
      if (typeof cb !== "function") {
        throw new TypeError("subscribe cb must be a function");
      }
      const subId = nextSubId++;
      subs.set(subId, cb);
      endpoint.emit("events.subscribe", { subId, pattern });
      return {
        off(): void {
          if (!subs.has(subId)) return;
          subs.delete(subId);
          endpoint.emit("events.unsubscribe", { subId });
        },
      };
    },
    emit(name, payload): void {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("emit name must be a non-empty string");
      }
      // Plugin author is responsible for passing structured-clone-safe
      // payloads (typing model in core-plugin-api.md). Non-cloneable values
      // would throw at postMessage time inside endpoint.emit.
      endpoint.emit("events.emit", { name, payload: payload as Json });
    },
    intercept(pattern, cb, opts): EventSubscription {
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new TypeError("intercept pattern must be a non-empty string");
      }
      if (typeof cb !== "function") {
        throw new TypeError("intercept cb must be a function");
      }
      const priority = opts?.priority;
      if (priority !== undefined && !Number.isFinite(priority)) {
        throw new TypeError("intercept priority must be a finite number");
      }
      const interceptId = nextInterceptId++;
      interceptors.set(interceptId, cb);
      endpoint.emit("events.intercept-register",
        priority !== undefined ? { interceptId, pattern, priority } : { interceptId, pattern });
      return {
        off(): void {
          if (!interceptors.has(interceptId)) return;
          interceptors.delete(interceptId);
          endpoint.emit("events.intercept-unregister", { interceptId });
        },
      };
    },
  };

  const dispatcher: EventsDispatcher = {
    dispatch(eventName, data): boolean {
      if (eventName !== "events.dispatch") return false;
      if (!isDispatchPayload(data)) return true;
      const cb = subs.get(data.subId);
      if (!cb) return true;
      try { cb(data.name, data.payload); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        endpoint.emit("log",
          `[sdk.events] subscriber for '${data.name}' threw: ${msg}`);
      }
      return true;
    },
  };

  const requests: InterceptRequestDispatcher = {
    tryHandle(method, params): { handled: false } | { handled: true; result: Promise<Json> } {
      if (method !== "events.intercept-handle") return { handled: false };
      return { handled: true, result: handleInterceptRequest(params) };
    },
  };

  async function handleInterceptRequest(params: Json): Promise<Json> {
    if (!isInterceptHandlePayload(params)) {
      throw new Error("malformed events.intercept-handle payload");
    }
    const cb = interceptors.get(params.interceptId);
    if (!cb) {
      // Late delivery for an unregistered interceptor: respond with the
      // input payload so the chain effectively skips this entry.
      return params.payload;
    }
    let r: unknown;
    try { r = cb(params.name, params.payload); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      endpoint.emit("log",
        `[sdk.events] interceptor for '${params.name}' threw: ${msg}`);
      throw err;
    }
    if (r && typeof (r as Promise<unknown>).then === "function") {
      r = await r;
    }
    // Discriminated reply so a plugin returning the literal `null` as a
    // payload can be distinguished from an observe-only return (undefined).
    // Json doesn't carry undefined.
    if (r === undefined) return { modified: false } as Json;
    return { modified: true, payload: r as Json } as Json;
  }

  return { events, dispatcher, requests };
}

function isDispatchPayload(d: unknown): d is { subId: number; name: string; payload: unknown } {
  return typeof d === "object" && d !== null
    && typeof (d as { subId?: unknown }).subId === "number"
    && typeof (d as { name?: unknown }).name === "string"
    && "payload" in (d as object);
}

function isInterceptHandlePayload(d: unknown): d is { interceptId: number; name: string; payload: Json } {
  return typeof d === "object" && d !== null
    && typeof (d as { interceptId?: unknown }).interceptId === "number"
    && typeof (d as { name?: unknown }).name === "string"
    && "payload" in (d as object);
}
