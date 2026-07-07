// The core-internal window/compositor event bus: the concrete TypedBus instance +
// its event map. Producers (the protocol layer, the seat) emit; subscribers (the
// plugin-forwarding layer in main.ts, the clipboard layer, the decoration
// registry) call bus.on(...).
//
// The map's keys are the WINDOW_EVENT name strings so producers reference the
// same constants as the plugin wire. keyboard.focus is in-core only today (the
// clipboard layer consumes it).

import { TypedBus } from "./bus.js";
import { WINDOW_EVENT, STACK_EVENT } from "./types.js";
import type {
  WindowMapEvent, WindowUnmapEvent, WindowChangeEvent, WindowStateBagChangedEvent,
  WindowClosingEvent, WindowOpeningEvent, WindowPreconfigureEvent,
  StackRelayoutEvent,
} from "./types.js";

// Keyboard-focus change (active window). surfaceId / clientId identify the
// newly focused wl_surface (or null when focus cleared); prevSurfaceId is
// the surface losing focus (null when focus came from nowhere). In-core
// consumers: the clipboard layer (selection follows keyboard focus), the
// XWM (mirror focus to X via SetInputFocus / WM_TAKE_FOCUS).
export type KeyboardFocusEvent = {
  surfaceId: number | null;
  prevSurfaceId: number | null;
  clientId: number | null;
};

export const KEYBOARD_EVENT = {
  focus: "keyboard.focus",
} as const;

// Selection (clipboard / primary) ownership changed -- a wl client set or
// cleared a source, OR the Xwayland selection bridge published an X-owned
// source. Subscribers (the data-control protocol layer; bookkeeping that
// wants to react to "the active clipboard owner is different now") see one
// event per logical change. The payload only names which selection moved;
// readers consult state.{selection,primarySelection,xClipboardSource,
// xPrimarySource} for the new owner.
export type SelectionChangedEvent = {
  kind: "clipboard" | "primary";
};

export const SELECTION_EVENT = {
  changed: "selection.changed",
} as const;

// The event map: name -> payload. Extend here as new producers land.
export interface CompositorEventMap {
  [WINDOW_EVENT.map]: WindowMapEvent;
  [WINDOW_EVENT.unmap]: WindowUnmapEvent;
  [WINDOW_EVENT.change]: WindowChangeEvent;
  [WINDOW_EVENT.stateBagChanged]: WindowStateBagChangedEvent;
  [WINDOW_EVENT.closing]: WindowClosingEvent;
  [WINDOW_EVENT.opening]: WindowOpeningEvent;
  [WINDOW_EVENT.preconfigure]: WindowPreconfigureEvent;
  [STACK_EVENT.relayout]: StackRelayoutEvent;
  [KEYBOARD_EVENT.focus]: KeyboardFocusEvent;
  [SELECTION_EVENT.changed]: SelectionChangedEvent;
}

export type CompositorBus = TypedBus<CompositorEventMap>;

export function createCompositorBus(
  onError?: (msg: string, err: unknown) => void,
): CompositorBus {
  return new TypedBus<CompositorEventMap>(onError);
}
