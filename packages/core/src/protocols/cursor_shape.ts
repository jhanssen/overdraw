// wp_cursor_shape_v1: client requests a named cursor shape instead of
// supplying its own pixels via wl_pointer.set_cursor.
//
// Two interfaces:
//   wp_cursor_shape_manager_v1: global. get_pointer(new_id, pointer) returns
//     a per-pointer wp_cursor_shape_device_v1.
//   wp_cursor_shape_device_v1: set_shape(serial, shape) installs the named
//     shape as the client's cursor for that pointer.
//
// Wired into core via the same seat-side cursor ops the wl_pointer.set_cursor
// path uses: serial validation against the pointer's most-recent enter, then
// setClientCursor with the texture from the theme resolver. The two
// mechanisms share the priority-2 "client cursor" slot.
//
// Animated cursors are not supported in v1: shapes whose XCursor file has
// multiple frames render frame 0 only (e.g. 'wait').

import type { Ctx } from "./ctx.js";
import type { WpCursorShapeManagerV1Handler } from "#protocols-gen/wp_cursor_shape_manager_v1.js";
import type { WpCursorShapeDeviceV1Handler } from "#protocols-gen/wp_cursor_shape_device_v1.js";
import { signature as devSig } from "#protocols-gen/wp_cursor_shape_device_v1.js";
import { WpCursorShapeDeviceV1_Error } from "#protocols-gen/wp_cursor_shape_device_v1.js";
import type { Resource } from "../types.js";

// shape enum -> XCursor theme name. Values come from the protocol XML
// (`cursor-shape-v1.xml`); names match standard XCursor shape names so
// the resolver can look them up directly.
//
// Some themes don't ship every shape; the resolver falls back to the
// built-in arrow for 'default' only. For unknown / unshipped shapes
// other than 'default', the resolver returns null and we drop silently
// (the previous cursor remains in place).
const SHAPE_NAMES: Record<number, string> = {
  1: "default",
  2: "context-menu",
  3: "help",
  4: "pointer",
  5: "progress",
  6: "wait",
  7: "cell",
  8: "crosshair",
  9: "text",
  10: "vertical-text",
  11: "alias",
  12: "copy",
  13: "move",
  14: "no-drop",
  15: "not-allowed",
  16: "grab",
  17: "grabbing",
  18: "e-resize",
  19: "n-resize",
  20: "ne-resize",
  21: "nw-resize",
  22: "s-resize",
  23: "se-resize",
  24: "sw-resize",
  25: "w-resize",
  26: "ew-resize",
  27: "ns-resize",
  28: "nesw-resize",
  29: "nwse-resize",
  30: "col-resize",
  31: "row-resize",
  32: "all-scroll",
  33: "zoom-in",
  34: "zoom-out",
  35: "dnd-ask",
  36: "all-resize",
};

// Per-device state: the wl_pointer the client passed at get_pointer time.
// set_shape resolves serial validation against that pointer's stored enter
// serial. Kept as a WeakMap so device destruction implicitly drops it.
const devicePointer = new WeakMap<Resource, Resource>();

export function makeCursorShapeManager(_ctx: Ctx): WpCursorShapeManagerV1Handler {
  return {
    destroy(_resource) { /* destructor: trampoline handles resource teardown */ },
    get_pointer(_manager, deviceResource, pointerResource) {
      // Track which wl_pointer this device is bound to so set_shape can
      // look up the latest enter serial and the owning client.
      devicePointer.set(deviceResource, pointerResource);
    },
    get_tablet_tool_v2(_manager, _device, _tool) {
      // Tablet protocol not implemented in this compositor (no
      // zwp_tablet_tool_v2 advertised); accept the request so a client
      // that probes the manager doesn't crash, but the resulting device
      // is inert -- it can't validate enter serials because tablet
      // tools don't exist.
    },
  };
}

export function makeCursorShapeDevice(ctx: Ctx): WpCursorShapeDeviceV1Handler {
  return {
    destroy(_resource) { /* destructor */ },
    set_shape(resource, serial, shape) {
      const seat = ctx.state.seat;
      if (!seat) return;
      const pointer = devicePointer.get(resource);
      if (!pointer || pointer.destroyed) return;
      // Serial validation: must match a recent wl_pointer.enter for the
      // associated pointer. Stale or missing: silent drop (protocol
      // convention -- and what wl_pointer.set_cursor does too).
      const exp = seat.cursor.lastEnterSerialFor(pointer);
      if (exp === undefined || serial < exp) return;

      const name = SHAPE_NAMES[shape];
      if (!name) {
        ctx.addon.postError(resource, WpCursorShapeDeviceV1_Error.invalid_shape,
          `wp_cursor_shape_device_v1.set_shape: invalid shape ${shape}`);
        return;
      }

      // Look up the XCursor texture for this shape in the active theme.
      const sizePx = Number(process.env.XCURSOR_SIZE) || 24;
      const r = ctx.addon.resolveCursorShape(name, sizePx, 1);
      if (!r) {
        // Shape not in the active theme + no fallback (only 'default'
        // has one). Drop silently; the previous cursor stays.
        return;
      }

      // Install into the internal cursor surface and point the slot at it.
      // setCursorPixels uploads the bytes and points the slot at the
      // compositor-internal cursor surface; the client's "cursor"
      // selection is just (resolver pixels, hotspot). We record that as
      // the client's cursor preference so focus changes restore the
      // right shape.
      //
      // The compositor mutation here is direct (not via setClientCursor)
      // because the bytes need a fresh CPU upload to the internal surface
      // each time; setClientCursor's surface-pointer path is for client-
      // owned wl_surfaces. We still update setClientCursor so the seat
      // can re-apply it on focus changes.
      const clientId = ctx.addon.clientId(resource);
      ctx.state.compositor.setCursorPixels?.(
        r.rgba, r.width, r.height, r.hotspotX, r.hotspotY);
      ctx.state.compositor.setCursorVisible?.(true);

      // Note: we don't cache this shape against the clientId in the
      // seat's per-client cursor map. The seat's applyClientCursor path
      // only handles surface-or-hidden, not resolver-driven shapes.
      // Clients are expected to re-call set_shape on every
      // pointer.enter (which they already do for wl_pointer.set_cursor,
      // the analogous mechanism). On focus change away, the seat reverts
      // to the compositor default; on focus change back without a fresh
      // set_shape, the client's shape would be lost. v1 limitation
      // noted in cursor-design.md.
    },
  };
}

// Convenience: identifies this protocol's child interface name in code
// that wires registerInterface (mirrors makePointer / makeKeyboard).
export const DEVICE_INTERFACE_NAME = devSig.name;
