// Worker-side decoration SDK (sdk.decorations). A plugin registers an app_id
// pattern, is told which mapped windows it owns (onAssigned), and creates a
// decoration surface for an assigned window with createDecoration(windowId,
// {insets}) -- one call that reserves additive insets in the core AND allocates a
// producer/consumer ring at the resulting outer rect (tagged so the core links the
// surface to the window for content-gating). onDeregistered fires if the core drops
// this provider (e.g. it failed to draw within the first-frame deadline).
//
// Requests go through endpoint.request; inbound decoration.* events are dispatched
// to registered callbacks. Inbound payloads are validated at the trust boundary.

import { DECORATION_EVENT } from "../events/types.js";
import type {
  DecorationAssignedEvent, DecorationDeregisteredEvent, WindowRect,
} from "../events/types.js";
import type { Endpoint, Json } from "./protocol.js";
import type { Surface, RingMaker } from "./gpu.js";

export type DecorationAssignedHandler = (ev: DecorationAssignedEvent) => void;
export type DecorationDeregisteredHandler = (ev: DecorationDeregisteredEvent) => void;

export type Insets = { top: number; right: number; bottom: number; left: number };

// The plugin-facing decoration SDK (sdk.decorations).
export interface PluginDecorations {
  // Register as a decoration provider for windows whose app_id matches `pattern`
  // (a RegExp source string + optional flags). Resolves when the core records it;
  // rejects if the pattern is invalid. First registered match wins.
  register(pattern: string, flags?: string): Promise<void>;
  // Called when a mapped window is assigned to this plugin (its app_id matched).
  // The window's content is GATED (held) until the plugin draws -- so the plugin
  // should createDecoration + draw + present promptly (a deadline applies).
  onAssigned(cb: DecorationAssignedHandler): void;
  // Called if the core permanently deregisters this provider (e.g. it missed the
  // first-frame deadline). No further assignments until it re-registers.
  onDeregistered(cb: DecorationDeregisteredHandler): void;
  // Reserve additive insets around an assigned window AND create the decoration
  // surface at the resulting outer rect. The core grows the window's OUTER rect by
  // the insets (content unchanged, client never told). Returns a Surface the plugin
  // renders the decoration into; its first present releases the gated content (so
  // content + decoration appear together). Rejects if the window is not assigned to
  // this plugin. `layer` defaults to "below" (content draws over it; only the inset
  // band shows).
  createDecoration(windowId: number, opts: { insets: Insets; layer?: DecorationLayer }): Promise<Surface>;
}

export type DecorationLayer = "background" | "below" | "above" | "overlay";

// The SDK object plus the inbound-event dispatch the bootstrap wires into the
// Endpoint event handler. `dispatch` is NOT on the plugin-facing object.
export interface DecorationControl {
  decorations: PluginDecorations;
  dispatch(name: string, data: Json): boolean;
}

// `makeRingSurface` is the GPU ring allocator (from createPluginGpu). It is
// required for createDecoration; a plugin without the GPU capability has no
// decoration drawing (sdk.decorations is only attached when GPU is present).
export function createDecorations(endpoint: Endpoint, makeRingSurface: RingMaker): DecorationControl {
  const assignedHandlers: DecorationAssignedHandler[] = [];
  const deregisteredHandlers: DecorationDeregisteredHandler[] = [];

  const decorations: PluginDecorations = {
    async register(pattern, flags) {
      await endpoint.request("decoration.register",
        { pattern, ...(flags !== undefined ? { flags } : {}) });
    },
    onAssigned(cb) { assignedHandlers.push(cb); },
    onDeregistered(cb) { deregisteredHandlers.push(cb); },
    async createDecoration(windowId, opts) {
      // Core reserves the additive insets + returns the outer rect.
      const res = await endpoint.request("decoration.createDecoration",
        { windowId, insets: opts.insets });
      const grant = asInsetGrant(res);
      if (!grant) throw new Error("decoration.createDecoration: malformed grant from core");
      // Allocate the ring at the outer rect, tagging the alloc with `decorates:
      // windowId` so the core links this surface to the window (first present then
      // releases the gated content).
      const r = grant.outerRect;
      return makeRingSurface(r.width, r.height, {
        layer: opts.layer ?? "below",
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        decorates: windowId,
      });
    },
  };

  const dispatch = (name: string, data: Json): boolean => {
    switch (name) {
      case DECORATION_EVENT.assigned: {
        const ev = asAssignedEvent(data);
        if (ev) for (const cb of assignedHandlers) cb(ev);
        return true;
      }
      case DECORATION_EVENT.deregistered: {
        const ev = asDeregisteredEvent(data);
        if (ev) for (const cb of deregisteredHandlers) cb(ev);
        return true;
      }
      default:
        return false;
    }
  };

  return { decorations, dispatch };
}

// --- inbound payload validators (trust boundary) ---------------------------

function isRecord(v: Json): v is { [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isRect(v: Json): v is WindowRect {
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
function asDeregisteredEvent(data: Json): DecorationDeregisteredEvent | null {
  if (!isRecord(data)) return null;
  if (typeof data.reason !== "string" || typeof data.windowId !== "number") return null;
  return { reason: data.reason, windowId: data.windowId };
}

interface InsetGrant { insets: Insets; outerRect: WindowRect; contentRect: WindowRect; }
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
