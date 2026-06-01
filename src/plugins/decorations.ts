// Worker-side decoration SDK (sdk.decorations). Piece 1: register an app_id
// pattern and observe decoration.assigned events (the core tells the plugin which
// windows it now owns the decoration of). Drawing (requestInsets + a surface) is
// pieces 2/3.
//
// register() issues a core request (endpoint.request); onAssigned() registers a
// callback the inbound decoration.assigned event dispatches to. Mirrors the
// window-observer pattern (validate inbound payloads at the trust boundary).

import { DECORATION_EVENT } from "../events/types.js";
import type { DecorationAssignedEvent } from "../events/types.js";
import type { Endpoint, Json } from "./protocol.js";

export type DecorationAssignedHandler = (ev: DecorationAssignedEvent) => void;

// The plugin-facing decoration surface (becomes sdk.decorations).
export interface PluginDecorations {
  // Register as a decoration provider for windows whose app_id matches `pattern`
  // (a RegExp source string + optional flags). Resolves when the core has
  // recorded it; rejects if the pattern is invalid. First registered match wins.
  register(pattern: string, flags?: string): Promise<void>;
  // Called when a mapped window is assigned to this plugin (its app_id matched).
  onAssigned(cb: DecorationAssignedHandler): void;
}

// The SDK object plus the inbound-event dispatch the bootstrap wires into the
// Endpoint event handler. `dispatch` is NOT on the plugin-facing object.
export interface DecorationControl {
  decorations: PluginDecorations;
  dispatch(name: string, data: Json): boolean;
}

export function createDecorations(endpoint: Endpoint): DecorationControl {
  const assignedHandlers: DecorationAssignedHandler[] = [];

  const decorations: PluginDecorations = {
    async register(pattern, flags) {
      await endpoint.request("decoration.register",
        { pattern, ...(flags !== undefined ? { flags } : {}) });
    },
    onAssigned(cb) { assignedHandlers.push(cb); },
  };

  const dispatch = (name: string, data: Json): boolean => {
    if (name !== DECORATION_EVENT.assigned) return false;
    const ev = asAssignedEvent(data);
    if (ev) for (const cb of assignedHandlers) cb(ev);
    return true;
  };

  return { decorations, dispatch };
}

// Validate the inbound decoration.assigned payload (trust boundary; the core
// builds it from typed sources but it crosses postMessage as Json).
function isRecord(v: Json): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isRect(v: Json): v is DecorationAssignedEvent["rect"] {
  return isRecord(v)
    && typeof v.x === "number" && typeof v.y === "number"
    && typeof v.width === "number" && typeof v.height === "number";
}
function isNullableString(v: Json): v is string | null {
  return v === null || typeof v === "string";
}
function asAssignedEvent(data: Json): DecorationAssignedEvent | null {
  if (!isRecord(data)) return null;
  if (typeof data.surfaceId !== "number") return null;
  if (!isRect(data.rect)) return null;
  if (!isNullableString(data.appId) || !isNullableString(data.title)) return null;
  return { surfaceId: data.surfaceId, appId: data.appId, title: data.title, rect: data.rect };
}
