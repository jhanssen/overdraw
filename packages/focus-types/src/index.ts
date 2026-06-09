// Canonical types for the focus plugin namespace (core-plugin-api.md §14).
//
// Any plugin claiming the 'focus' namespace MUST conform to FocusAPI.
// Unlike layout (which exposes a synchronous compute()), focus is driven
// fire-and-forget by the core seat: handleInput() dispatches decide() on
// every focus-relevant coarse event and applies the resolved result on the
// next tick. Sequencing happens in core; the plugin doesn't have to think
// about staleness.
//
// No named-mode dispatch. Core does NOT know about 'follow-pointer' or
// 'click-to-focus' strings; the bundled focus plugin implements those
// internally. core-plugin-api.md §"Cross-cutting patterns" / Pattern B.
//
// Type-only package: empty index.js at runtime; the .d.ts is the contract.

// Coarse events that drive focus decisions. Pointer-motion is intentionally
// NOT in this set -- wl_pointer events always follow the pointer regardless
// of keyboard-focus policy, so the rate-limiting question is moot. A
// follow-pointer-style plugin reacts to pointer-enter / pointer-leave
// (surface boundary crossings), not per-motion.
export type FocusReason =
  | "pointer-enter"      // pointer crossed into a surface
  | "pointer-leave"      // pointer left all surfaces (or went off-output)
  | "pointer-button"     // a button press over a surface (passed even if seat already had focus)
  | "window-mapped"      // a toplevel mapped + got presentable content
  | "window-unmapped"    // a mapped toplevel unmapped/destroyed
  | "window-raised"      // explicit reordering brought a window to the top
  | "workspace-changed"  // (future Phase 6) workspace switch
  | "explicit";          // a focus request that wants the plugin to confirm.
                         // sdk.windows.focus(id) is an explicit OVERRIDE
                         // (bypasses decide()); 'explicit' is reserved for
                         // future paths where a caller wants the plugin's
                         // policy to apply (e.g. IPC actions, workspace
                         // plugin handoffs).

export interface FocusPointer {
  x: number;
  y: number;
  // The surface under the pointer right now, or null if outside any surface.
  surfaceUnderPointer: number | null;
}

export interface FocusInputs {
  // What triggered this decision.
  reason: FocusReason;
  // Pointer state at the moment of dispatch.
  pointer: FocusPointer;
  // Current keyboard focus (the surface that would still receive keys if
  // decide() returns undefined).
  currentKeyboardFocus: number | null;
  // The surface that triggered this decision when meaningful (the
  // newly-mapped window for 'window-mapped'; the clicked surface for
  // 'pointer-button'; the raised surface for 'window-raised'). Undefined
  // for events that have no single "trigger" (e.g. pointer-leave).
  trigger?: number;
}

export interface FocusResult {
  // The new keyboard focus target, or null to clear focus, or undefined to
  // leave focus unchanged. (undefined is the common case under
  // click-to-focus: pointer-enter does not trigger a focus change.)
  keyboardFocus?: number | null;
}

// The contract a plugin claiming 'focus' implements. decide() is the only
// method today; future revisions may add others.
//
// async per the SDK contract; the bundled focus plugin's implementation is
// synchronous and returns Promise.resolve(...).
export interface FocusAPI {
  decide(inputs: FocusInputs): Promise<FocusResult>;
}
