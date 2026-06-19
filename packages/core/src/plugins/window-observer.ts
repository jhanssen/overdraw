// Worker-side window-state observer (sdk.window). A typed convenience wrapper
// over sdk.events.subscribe('window.*', ...): plugin registers
// onMap/onUnmap/onChange, this observer subscribes once to 'window.*' and
// dispatches the validated payloads to handlers.
//
// Pull-free: the core emits onto the bus; this observer (via its bus
// subscription) routes to plugin callbacks. A plugin that never registers a
// handler still has the bus subscription, but with no handlers attached the
// dispatch is a no-op.

import { WINDOW_EVENT } from "../events/types.js";
import type {
  WindowMapEvent, WindowUnmapEvent, WindowChangeEvent, WindowChangeField,
} from "../events/types.js";
import type { PluginEvents } from "./events.js";

export type WindowMapHandler = (ev: WindowMapEvent) => void;
export type WindowUnmapHandler = (ev: WindowUnmapEvent) => void;
export type WindowChangeHandler = (ev: WindowChangeEvent) => void;

// The plugin-facing observation surface (becomes sdk.window).
export interface PluginWindowObserver {
  // Called when a toplevel maps. Multiple handlers may be registered.
  onMap(cb: WindowMapHandler): void;
  // Called when a mapped toplevel unmaps/destroys.
  onUnmap(cb: WindowUnmapHandler): void;
  // Called when a mapped toplevel's observable state changes (title/app_id/
  // activation). `ev.changed` lists which fields; current values are included.
  onChange(cb: WindowChangeHandler): void;
}

// The observer + a release handle for the underlying bus subscription. The
// bootstrap calls release() on plugin shutdown (the bus subscription would
// otherwise leak per worker generation).
export interface WindowObserverControl {
  observer: PluginWindowObserver;
  release(): void;
}

export function createWindowObserver(events: PluginEvents): WindowObserverControl {
  const mapHandlers: WindowMapHandler[] = [];
  const unmapHandlers: WindowUnmapHandler[] = [];
  const changeHandlers: WindowChangeHandler[] = [];

  // The underlying 'window.*' bus subscription is lazy: it's installed on
  // the first onMap/onUnmap/onChange handler registration, so a plugin that
  // never observes window state does not pay for an unused subscription
  // (and does not trigger the runtime's no-bus warning).
  let sub: ReturnType<PluginEvents["subscribe"]> | null = null;
  function ensureSubscribed(): void {
    if (sub) return;
    sub = events.subscribe("window.*", (name, payload) => {
      switch (name) {
        case WINDOW_EVENT.map: {
          const ev = asMapEvent(payload);
          if (ev) for (const cb of mapHandlers) cb(ev);
          return;
        }
        case WINDOW_EVENT.unmap: {
          const ev = asUnmapEvent(payload);
          if (ev) for (const cb of unmapHandlers) cb(ev);
          return;
        }
        case WINDOW_EVENT.change: {
          const ev = asChangeEvent(payload);
          if (ev) for (const cb of changeHandlers) cb(ev);
          return;
        }
      }
      // Other window.* events (closing, etc.) -- not yet exposed via this
      // observer. Subscribers wanting them use sdk.events.subscribe directly.
    });
  }

  const observer: PluginWindowObserver = {
    onMap(cb) { mapHandlers.push(cb); ensureSubscribed(); },
    onUnmap(cb) { unmapHandlers.push(cb); ensureSubscribed(); },
    onChange(cb) { changeHandlers.push(cb); ensureSubscribed(); },
  };

  return {
    observer,
    release(): void { sub?.off(); sub = null; },
  };
}

// Runtime validators for the inbound payloads (trust boundary; see subscribe).
// Each returns the narrowed type or null when the shape does not match.

function isRecord(v: unknown): v is { [k: string]: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRect(v: unknown): v is WindowMapEvent["rect"] {
  return isRecord(v)
    && typeof v.x === "number" && typeof v.y === "number"
    && typeof v.width === "number" && typeof v.height === "number";
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function asMapEvent(data: unknown): WindowMapEvent | null {
  if (!isRecord(data)) return null;
  if (typeof data.surfaceId !== "number") return null;
  if (!isRect(data.rect)) return null;
  if (!isNullableString(data.appId) || !isNullableString(data.title)) return null;
  // outputId defaults to the primary (0) when absent so legacy test fixtures
  // emitting bare {surfaceId, rect, appId, title} payloads still pass; real
  // emitters in core always set it.
  const outputId = typeof data.outputId === "number" ? data.outputId : 0;
  return {
    surfaceId: data.surfaceId,
    outputId,
    rect: data.rect,
    appId: data.appId,
    title: data.title,
  };
}

function asUnmapEvent(data: unknown): WindowUnmapEvent | null {
  if (!isRecord(data)) return null;
  if (typeof data.surfaceId !== "number") return null;
  return { surfaceId: data.surfaceId };
}

const CHANGE_FIELDS: readonly WindowChangeField[] = [
  "title", "appId", "activated",
];

function asChangeEvent(data: unknown): WindowChangeEvent | null {
  if (!isRecord(data)) return null;
  if (typeof data.surfaceId !== "number") return null;
  if (!isNullableString(data.appId) || !isNullableString(data.title)) return null;
  if (typeof data.activated !== "boolean") return null;
  const raw = data.changed;
  if (!Array.isArray(raw)) return null;
  const changed: WindowChangeField[] = [];
  for (const f of raw) {
    if (typeof f === "string" && (CHANGE_FIELDS as readonly string[]).includes(f)) {
      changed.push(f as WindowChangeField);
    }
  }
  return {
    surfaceId: data.surfaceId, changed,
    appId: data.appId, title: data.title,
    activated: data.activated,
  };
}
