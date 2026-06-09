// Pure policy state machine for the bundled focus plugin. Two policies and a
// focus-on-map toggle; the plugin's decide() calls into one of these.
//
// "Pure" means: no side effects, no async, no SDK references. Inputs go in,
// FocusResult comes out. Makes the policies unit-testable in isolation
// against synthetic event sequences.

import type { FocusInputs, FocusResult } from "@overdraw/focus-types";

export type FocusPolicy = "follow-pointer" | "click-to-focus";

export interface FocusPluginConfig {
  policy: FocusPolicy;
  // Give keyboard focus to a freshly-mapped window. Covers two cases:
  //   - Under click-to-focus, the new window is typeable immediately
  //     without requiring a click.
  //   - Under follow-pointer, a window that maps under a stationary
  //     pointer would otherwise never get a pointer-motion event to focus
  //     it. focusOnMap closes that hole.
  focusOnMap: boolean;
}

export const DEFAULT_CONFIG: FocusPluginConfig = {
  policy: "follow-pointer",
  focusOnMap: true,
};

// Validate + normalize a config value (typically the user's config.focus,
// passed verbatim through the bundled-plugin config channel). Throws on
// any deviation from the schema -- in-thread plugins surface init throws
// as fatal startup errors, which is the desired behavior for bad config.
export function validateConfig(raw: unknown): FocusPluginConfig {
  if (raw === null || raw === undefined) return { ...DEFAULT_CONFIG };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`focus config must be an object (got ${typeof raw})`);
  }
  const o = raw as { [k: string]: unknown };
  const policy = o.policy === undefined ? DEFAULT_CONFIG.policy : o.policy;
  if (policy !== "follow-pointer" && policy !== "click-to-focus") {
    throw new TypeError(
      `focus.policy must be 'follow-pointer' or 'click-to-focus' (got ${JSON.stringify(policy)})`);
  }
  const focusOnMap = o.focusOnMap === undefined ? DEFAULT_CONFIG.focusOnMap : o.focusOnMap;
  if (typeof focusOnMap !== "boolean") {
    throw new TypeError(
      `focus.focusOnMap must be a boolean (got ${typeof focusOnMap})`);
  }
  return { policy, focusOnMap };
}

// The decide function. Pure: same inputs + config => same result. The
// undefined result (leave focus unchanged) is the common case; many events
// don't trigger a focus change under either policy.
export function decideFocus(config: FocusPluginConfig, inputs: FocusInputs): FocusResult {
  const { policy, focusOnMap } = config;

  switch (inputs.reason) {
    case "pointer-enter": {
      // follow-pointer: focus the surface the pointer entered (if any).
      // click-to-focus: leave focus alone (the user has to click).
      if (policy === "follow-pointer") {
        return { keyboardFocus: inputs.pointer.surfaceUnderPointer };
      }
      return {};
    }

    case "pointer-leave": {
      // follow-pointer: pointer left all surfaces -> clear keyboard focus
      // (matches the long-standing wl_seat.ts behavior; an empty desktop
      // has no keyboard target).
      // click-to-focus: focus persists when the pointer moves away.
      if (policy === "follow-pointer") {
        return { keyboardFocus: null };
      }
      return {};
    }

    case "pointer-button": {
      // click-to-focus: a press over a surface focuses it. The trigger is
      // the surface under the press (which the seat carries as
      // `pointer.surfaceUnderPointer`, since button events have no
      // separate coordinate).
      // follow-pointer: ignore button events for focus (the focus already
      // tracks the pointer; clicking shouldn't re-fire enter logic).
      if (policy === "click-to-focus" && inputs.pointer.surfaceUnderPointer !== null) {
        return { keyboardFocus: inputs.pointer.surfaceUnderPointer };
      }
      return {};
    }

    case "window-mapped": {
      // focusOnMap covers both policies: a launched app is typeable
      // immediately. Without it, a follow-pointer setup with a stationary
      // pointer would never focus the new window; a click-to-focus setup
      // would require an explicit click before typing.
      if (focusOnMap && inputs.trigger !== undefined) {
        return { keyboardFocus: inputs.trigger };
      }
      return {};
    }

    case "window-unmapped": {
      // If the unmapped window had focus, clear focus -- a later
      // pointer-enter / explicit will re-establish it. Today's wl_seat.ts
      // does NOT auto-move focus on close (see status.md); preserving
      // that behavior (no automatic next-window selection) keeps the
      // extraction behavior-preserving.
      if (inputs.trigger !== undefined && inputs.currentKeyboardFocus === inputs.trigger) {
        return { keyboardFocus: null };
      }
      return {};
    }

    case "window-raised":
    case "workspace-changed": {
      // Not exercised by today's seat code. Reserved for Phase 6+
      // workspace plugin / explicit raise paths. The bundled plugin
      // leaves focus alone; a more elaborate plugin can replace this.
      return {};
    }

    case "explicit": {
      // An explicit focus request from another plugin / IPC. The trigger
      // is the target surface (null to clear).
      if (inputs.trigger !== undefined) {
        return { keyboardFocus: inputs.trigger };
      }
      return { keyboardFocus: null };
    }
  }
}
