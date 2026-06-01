// The core-internal window/compositor event bus: the concrete TypedBus instance +
// its event map. Producers (the protocol layer, the seat) emit; subscribers (the
// plugin-forwarding layer in main.ts, the clipboard layer, the future decoration
// registry) call bus.on(...).
//
// The map's keys are the WINDOW_EVENT name strings so producers reference the
// same constants as the plugin wire. keyboard.focus is in-core only today (the
// clipboard layer consumes it); it replaces the old seat.onKbFocusChange hook.

import { TypedBus } from "./bus.js";
import { WINDOW_EVENT } from "./types.js";
import type { WindowMapEvent, WindowUnmapEvent, WindowChangeEvent } from "./types.js";

// Keyboard-focus change (active window). clientId is the newly focused client, or
// null when focus cleared. In-core consumer: the clipboard layer (selection
// follows keyboard focus).
export type KeyboardFocusEvent = { clientId: number | null };

export const KEYBOARD_EVENT = {
  focus: "keyboard.focus",
} as const;

// The event map: name -> payload. Extend here as new producers land.
export interface CompositorEventMap {
  [WINDOW_EVENT.map]: WindowMapEvent;
  [WINDOW_EVENT.unmap]: WindowUnmapEvent;
  [WINDOW_EVENT.change]: WindowChangeEvent;
  [KEYBOARD_EVENT.focus]: KeyboardFocusEvent;
}

export type CompositorBus = TypedBus<CompositorEventMap>;

export function createCompositorBus(
  onError?: (msg: string, err: unknown) => void,
): CompositorBus {
  return new TypedBus<CompositorEventMap>(onError);
}
