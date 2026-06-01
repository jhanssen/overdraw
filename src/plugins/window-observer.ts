// Worker-side window-state observer (runs INSIDE the plugin Worker). Receives the
// core's one-way window.* events off the Endpoint and dispatches them to the
// callbacks a plugin registered via sdk.window.onMap / onUnmap / onChange.
//
// Pull-free: the core pushes events; the plugin only registers handlers. A plugin
// that never registers a handler simply has no listeners and the events are dropped.

import { WINDOW_EVENT } from "../events/types.js";
import type {
  WindowMapEvent, WindowUnmapEvent, WindowChangeEvent, WindowChangeField,
} from "../events/types.js";
import type { Json } from "./protocol.js";

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

// The observer plus the internal dispatch entry the bootstrap wires into the
// Endpoint's event handler. `dispatch` is NOT on the plugin-facing object.
export interface WindowObserverControl {
  observer: PluginWindowObserver;
  // Returns true if `name` was a window.* event it consumed.
  dispatch(name: string, data: Json): boolean;
}

export function createWindowObserver(): WindowObserverControl {
  const mapHandlers: WindowMapHandler[] = [];
  const unmapHandlers: WindowUnmapHandler[] = [];
  const changeHandlers: WindowChangeHandler[] = [];

  const observer: PluginWindowObserver = {
    onMap(cb) { mapHandlers.push(cb); },
    onUnmap(cb) { unmapHandlers.push(cb); },
    onChange(cb) { changeHandlers.push(cb); },
  };

  // The core constructs these payloads from typed sources (events/types.ts) and
  // sends them over a structured-clone transport. This is a trust boundary, so the
  // inbound Json is validated (not blindly cast) before invoking handlers; a
  // malformed payload is dropped rather than handed to plugin code.
  const dispatch = (name: string, data: Json): boolean => {
    switch (name) {
      case WINDOW_EVENT.map: {
        const ev = asMapEvent(data);
        if (ev) for (const cb of mapHandlers) cb(ev);
        return true;
      }
      case WINDOW_EVENT.unmap: {
        const ev = asUnmapEvent(data);
        if (ev) for (const cb of unmapHandlers) cb(ev);
        return true;
      }
      case WINDOW_EVENT.change: {
        const ev = asChangeEvent(data);
        if (ev) for (const cb of changeHandlers) cb(ev);
        return true;
      }
      default:
        return false;
    }
  };

  return { observer, dispatch };
}

// Runtime validators for the inbound Json payloads (trust boundary; see dispatch).
// Each returns the narrowed type or null when the shape does not match.

function isRecord(v: Json): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRect(v: Json): v is WindowMapEvent["rect"] {
  return isRecord(v)
    && typeof v.x === "number" && typeof v.y === "number"
    && typeof v.width === "number" && typeof v.height === "number";
}

function isNullableString(v: Json): v is string | null {
  return v === null || typeof v === "string";
}

function asMapEvent(data: Json): WindowMapEvent | null {
  if (!isRecord(data)) return null;
  if (typeof data.surfaceId !== "number") return null;
  if (!isRect(data.rect)) return null;
  if (!isNullableString(data.appId) || !isNullableString(data.title)) return null;
  return { surfaceId: data.surfaceId, rect: data.rect, appId: data.appId, title: data.title };
}

function asUnmapEvent(data: Json): WindowUnmapEvent | null {
  if (!isRecord(data)) return null;
  if (typeof data.surfaceId !== "number") return null;
  return { surfaceId: data.surfaceId };
}

const CHANGE_FIELDS: readonly WindowChangeField[] = ["title", "appId", "activated"];

function asChangeEvent(data: Json): WindowChangeEvent | null {
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
  return { surfaceId: data.surfaceId, changed, appId: data.appId, title: data.title, activated: data.activated };
}
