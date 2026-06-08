// Worker-side `sdk.events` implementation (core-plugin-api.md §3). Runs inside
// the plugin Worker; talks to the core via the Endpoint's one-way event
// envelope.
//
// Plugin -> core (one-way events):
//   events.subscribe   { subId: number, pattern: string }
//   events.unsubscribe { subId: number }
//   events.emit        { name: string, payload: unknown }
//
// Core -> plugin (one-way event delivered to subscriptions):
//   events.dispatch    { subId: number, name: string, payload: unknown }
//
// The plugin mints subIds locally (a counter). Subscription handles know their
// subId and send unsubscribe on .off(). When the worker dies, core releases all
// of this plugin's bus subscriptions, so the worker need not unsubscribe on
// teardown -- but doing so on .off() lets a long-lived plugin clean up
// individual subscriptions without restart.

import type { Endpoint } from "./protocol.js";
import type { Json } from "./protocol.js";

export type EventListener = (name: string, payload: unknown) => void;

export interface EventSubscription {
  off(): void;
}

export interface PluginEvents {
  // Subscribe to an event by exact name or pattern. The pattern grammar is the
  // same as core's DynamicBus: exact ('window.map'), prefix-glob
  // ('workspace.*'), or catch-all ('*').
  subscribe(pattern: string, cb: EventListener): EventSubscription;
  // Emit an event by name. Plugins should namespace under their own name
  // (e.g. 'workspace.shown'); core knows nothing about names.
  emit(name: string, payload: unknown): void;
}

// Dispatcher for `events.dispatch` events arriving from core. The bootstrap
// passes incoming events here; returns true if it consumed (matched a known
// subId), false to let other dispatchers see it.
export interface EventsDispatcher {
  dispatch(name: string, data: unknown): boolean;
}

export interface EventsHandle {
  events: PluginEvents;
  dispatcher: EventsDispatcher;
}

export function createPluginEvents(endpoint: Endpoint): EventsHandle {
  let nextSubId = 1;
  // subId -> callback. The same callback may be subscribed twice (under
  // different subIds) and they are independent.
  const subs = new Map<number, EventListener>();

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
          if (!subs.has(subId)) return;   // idempotent
          subs.delete(subId);
          endpoint.emit("events.unsubscribe", { subId });
        },
      };
    },
    emit(name, payload): void {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("emit name must be a non-empty string");
      }
      // Cast to Json: the plugin author is responsible for passing
      // structured-clone-safe payloads (per the typing model in
      // core-plugin-api.md). Non-cloneable values would throw at postMessage
      // time inside endpoint.emit; that is the runtime check.
      endpoint.emit("events.emit", { name, payload: payload as Json });
    },
  };

  const dispatcher: EventsDispatcher = {
    dispatch(eventName, data): boolean {
      if (eventName !== "events.dispatch") return false;
      if (!isDispatchPayload(data)) return true;   // consumed; malformed dropped
      const cb = subs.get(data.subId);
      if (!cb) return true;     // late delivery for an unsubscribed sub; consumed
      try { cb(data.name, data.payload); }
      catch (err) {
        // The plugin's callback threw. Don't kill the worker; log via the
        // endpoint's reserved `log` event so it surfaces in the core log.
        const msg = err instanceof Error ? err.message : String(err);
        endpoint.emit("log",
          `[sdk.events] subscriber for '${data.name}' threw: ${msg}`);
      }
      return true;
    },
  };

  return { events, dispatcher };
}

function isDispatchPayload(d: unknown): d is { subId: number; name: string; payload: unknown } {
  return typeof d === "object" && d !== null
    && typeof (d as { subId?: unknown }).subId === "number"
    && typeof (d as { name?: unknown }).name === "string"
    && "payload" in (d as object);
}
