// Worker-side decoration SDK (sdk.decorations). Piece 1: register an app_id
// pattern and observe decoration.assigned events (the core tells the plugin which
// windows it now owns the decoration of). Drawing (requestInsets + a surface) is
// pieces 2/3.
//
// register() issues a core request (endpoint.request); onAssigned() registers a
// callback the inbound decoration.assigned event dispatches to. Mirrors the
// window-observer pattern (validate inbound payloads at the trust boundary).

import { DECORATION_EVENT } from "../events/types.js";
import type { DecorationAssignedEvent, WindowRect } from "../events/types.js";
import type { Endpoint, Json } from "./protocol.js";

export type DecorationAssignedHandler = (ev: DecorationAssignedEvent) => void;

export type Insets = { top: number; right: number; bottom: number; left: number };

// Granted decoration geometry from requestInsets. `outerRect` is where the
// decoration surface lives (content grown by the granted insets); `contentRect`
// is the unchanged client content; `insets` are the granted (possibly clamped)
// values.
export interface InsetGrant { insets: Insets; outerRect: WindowRect; contentRect: WindowRect; }

// The plugin-facing decoration surface (becomes sdk.decorations).
export interface PluginDecorations {
  // Register as a decoration provider for windows whose app_id matches `pattern`
  // (a RegExp source string + optional flags). Resolves when the core has
  // recorded it; rejects if the pattern is invalid. First registered match wins.
  register(pattern: string, flags?: string): Promise<void>;
  // Called when a mapped window is assigned to this plugin (its app_id matched).
  onAssigned(cb: DecorationAssignedHandler): void;
  // Reserve additive decoration insets around an assigned window. The core grows
  // the window's OUTER rect by the insets (content unchanged, client never told)
  // and returns the granted geometry. Reject if the window is not assigned to this
  // plugin. The plugin draws its decoration into a surface at `outerRect`.
  requestInsets(surfaceId: number, insets: Insets): Promise<InsetGrant>;
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
    async requestInsets(surfaceId, insets) {
      const res = await endpoint.request("decoration.requestInsets", { surfaceId, insets });
      const grant = asInsetGrant(res);
      if (!grant) throw new Error("decoration.requestInsets: malformed grant from core");
      return grant;
    },
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

function isInsets(v: Json): v is Insets {
  return isRecord(v)
    && typeof v.top === "number" && typeof v.right === "number"
    && typeof v.bottom === "number" && typeof v.left === "number";
}

function asInsetGrant(data: Json): InsetGrant | null {
  if (!isRecord(data)) return null;
  if (!isInsets(data.insets) || !isRect(data.outerRect) || !isRect(data.contentRect)) return null;
  return { insets: data.insets, outerRect: data.outerRect, contentRect: data.contentRect };
}
