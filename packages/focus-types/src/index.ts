// Canonical types for the 'focus' plugin namespace (core-plugin-api.md §14).
// The .d.ts is the contract any plugin claiming 'focus' implements. The
// FOCUS_REASONS tuple is the only runtime value: a single source of truth
// for the FocusReason string-literal union, used by trust-boundary
// validators (sdk.windows.requestFocusDecision in plugins-sdk, the windows
// broker in core) to reject malformed reasons.

// Coarse events that drive focus decisions. Pointer-motion is intentionally
// absent: wl_pointer events always follow the pointer regardless of
// keyboard-focus policy, and follow-pointer-style plugins react to surface
// crossings (pointer-enter / pointer-leave), not per-motion.
export const FOCUS_REASONS = [
  "pointer-enter",     // pointer crossed into a surface
  "pointer-leave",     // pointer left all surfaces (or went off-output)
  "pointer-button",    // a button press over a surface
  "window-mapped",     // a toplevel mapped + got presentable content
  "window-unmapped",   // a mapped toplevel unmapped/destroyed
  "window-raised",     // explicit reordering brought a window to the top
  "workspace-changed", // workspace switch
  "explicit",          // a focus request that wants the plugin to confirm
                       // (sdk.windows.focus bypasses decide() entirely;
                       // this is reserved for callers that want policy
                       // applied -- IPC actions, workspace handoffs).
] as const;

export type FocusReason = typeof FOCUS_REASONS[number];

export interface FocusPointer {
  x: number;
  y: number;
  surfaceUnderPointer: number | null;
}

export interface FocusInputs {
  reason: FocusReason;
  pointer: FocusPointer;
  currentKeyboardFocus: number | null;
  // The surface that triggered the decision when meaningful: the
  // newly-mapped window, the clicked surface, the raised surface. Undefined
  // for events with no single trigger (pointer-leave).
  trigger?: number;
}

export interface FocusResult {
  // null clears focus; undefined leaves focus unchanged (the common case --
  // most events under most policies don't move focus).
  keyboardFocus?: number | null;
}

export interface FocusAPI {
  decide(inputs: FocusInputs): Promise<FocusResult>;
}
