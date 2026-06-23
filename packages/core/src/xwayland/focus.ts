// Compositor -> X focus mirror policy. Pure logic, no addon / no compositor
// state -- the integration layer (xwm.ts) feeds in window descriptors + addon
// callbacks. The XWM subscribes to KEYBOARD_EVENT.focus and asks this module
// what to do; the module produces a list of X-side actions which the caller
// dispatches via the addon.

// The ICCCM input model for a window. Derived from WM_HINTS.input +
// presence of WM_TAKE_FOCUS in WM_PROTOCOLS, per ICCCM §4.1.7.
//
// "input" is the ICCCM WM_HINTS.input bit; null when the InputHint flag is
// unset, which per ICCCM defaults to true.
// "takeFocus" is whether WM_TAKE_FOCUS appears in WM_PROTOCOLS.
//
//   input=true  takeFocus=false  -> "passive"          SetInputFocus
//   input=true  takeFocus=true   -> "locally-active"   SetInputFocus + WM_TAKE_FOCUS
//   input=false takeFocus=true   -> "globally-active"  WM_TAKE_FOCUS only
//   input=false takeFocus=false  -> "no-input"         nothing
//
// We collapse to two booleans:
//   doSetInputFocus = input || !takeFocus
//   doSendTakeFocus = takeFocus
// (no-input falls out as doSetInputFocus=true & doSendTakeFocus=false, which
// is actually the same as passive on the wire; that mismatches ICCCM's
// "do nothing" intent but is harmless -- a no-input client receiving
// SetInputFocus will refuse it or ignore the keystrokes. wlroots collapses
// it the same way.)
export interface IcccmInputModel {
  doSetInputFocus: boolean;
  doSendTakeFocus: boolean;
}

export function icccmInputModel(
  input: boolean | null, takeFocus: boolean,
): IcccmInputModel {
  const inputEffective = input ?? true;  // null = default true per ICCCM
  return {
    doSetInputFocus: inputEffective || !takeFocus,
    doSendTakeFocus: takeFocus,
  };
}

// One step in the focus-mirror plan. The caller (xwm.ts) maps each to an
// addon call. The opaque numeric fields are X window ids / atoms; the
// caller knows which atoms it has interned.
export type FocusAction =
  | { kind: "set-input-focus"; window: number }
  | { kind: "send-take-focus"; window: number }
  | { kind: "set-net-active-window"; window: number }   // 0 = XCB_NONE
  | { kind: "set-state-focused"; window: number }       // add atom to _NET_WM_STATE
  | { kind: "clear-state-focused"; window: number };    // remove atom from _NET_WM_STATE

// What the focus mirror sees about a managed X window (or a transient OR
// window). Subset of XWindow; only the fields the policy needs.
export interface XFocusTarget {
  window: number;                    // X window id
  inputHint: boolean | null;         // WM_HINTS.input
  hasTakeFocus: boolean;             // WM_TAKE_FOCUS in WM_PROTOCOLS
  overrideRedirect: boolean;
}

// Compute the list of X-side actions for a focus transition.
//
//   prev: the X window that was X-focused (the one we set last time), or
//         null when X-focus was already on the bookkeeper / nothing.
//   next: the X window the compositor now wants to focus, or null when
//         focus moved to a non-X surface (or cleared entirely).
//   bookkeeper: the WM's bookkeeper window id -- the SetInputFocus target
//         when X-focus should leave the X-tree.
//
// Override-redirect windows: the X client positioned them and manages
// their X-side focus itself. The mirror does NOT SetInputFocus an OR
// window and does NOT update _NET_ACTIVE_WINDOW for it (it isn't a
// toplevel). Net effect: when focus moves between non-OR and an OR,
// only the non-OR side's state changes here.
export function planFocusMirror(
  prev: XFocusTarget | null,
  next: XFocusTarget | null,
  bookkeeper: number,
): FocusAction[] {
  const actions: FocusAction[] = [];

  // Step 1: clear focused-state on the outgoing window when it's a managed
  // (non-OR) X window. _NET_WM_STATE_FOCUSED is a per-window EWMH state
  // that decoration plugins and X-side window listeners read to render
  // active/inactive styling.
  if (prev && !prev.overrideRedirect) {
    actions.push({ kind: "clear-state-focused", window: prev.window });
  }

  if (next && !next.overrideRedirect) {
    // Step 2: managed X window gains focus. Apply the ICCCM truth table.
    const model = icccmInputModel(next.inputHint, next.hasTakeFocus);
    if (model.doSetInputFocus) {
      actions.push({ kind: "set-input-focus", window: next.window });
    }
    if (model.doSendTakeFocus) {
      actions.push({ kind: "send-take-focus", window: next.window });
    }
    actions.push({ kind: "set-net-active-window", window: next.window });
    actions.push({ kind: "set-state-focused", window: next.window });
  } else {
    // Focus moved off the X-managed tree (to a Wayland surface, to an OR
    // overlay -- the OR client manages its own focus -- or to nothing).
    // Park X-side focus on the bookkeeper and clear _NET_ACTIVE_WINDOW.
    // The bookkeeper carries no client; SetInputFocus there means "no X
    // client has focus, but X knows that explicitly."
    //
    // Only emit the bookkeeper SetInputFocus when we know the previous
    // X-focus was on a real client (or on first-ever transition we can't
    // tell; emit anyway -- it's idempotent on the X server).
    actions.push({ kind: "set-input-focus", window: bookkeeper });
    actions.push({ kind: "set-net-active-window", window: 0 });
  }

  return actions;
}

// FocusIn event arrived from X (a client's own XSetInputFocus, or our own
// SetInputFocus reflected back). We use the X request sequence to detect
// stale events: the lastFocusSeq is the sequence of the most recent
// WM-initiated SetInputFocus. If the FocusIn event's sequence is older
// than the most recent WM-initiated focus change, it was generated by us
// or by a client whose XSetInputFocus we've already overridden -- ignore
// it.
//
// X sequences are 16-bit on the wire (widened to 32 by the native side).
// Wraparound: treat any reverse-distance > UINT16_MAX/2 as "stale."
export function isFocusInStale(
  eventSeq: number, lastFocusSeq: number,
): boolean {
  const revDist = (lastFocusSeq - eventSeq) & 0xffff;
  return revDist > 0 && revDist < 0x8000;
}

// Friendly alias for the entry point xwm.ts uses.
export const applyFocusToX = planFocusMirror;
