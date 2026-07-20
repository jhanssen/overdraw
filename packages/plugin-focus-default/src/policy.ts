// Pure focus-policy state machine. No side effects, no async, no SDK refs:
// inputs and config in, FocusResult out, fully unit-testable.

import type { FocusInputs, FocusResult } from "@overdraw/focus-types";

export type FocusPolicy = "follow-pointer" | "click-to-focus";

export interface FocusPluginConfig {
  policy: FocusPolicy;
  // Give keyboard focus to a freshly-mapped window. Without this, follow-
  // pointer with a stationary pointer leaves the new window unfocused, and
  // click-to-focus forces the user to click before typing.
  focusOnMap: boolean;
  // Follow-pointer only: treat a repick -- the WORLD moving under a
  // stationary pointer (camera flight, strip scroll, retile) -- like real
  // pointer motion and refocus whatever lands under the cursor. Off, only
  // physical pointer motion moves focus.
  followRepick: boolean;
}

export const DEFAULT_CONFIG: FocusPluginConfig = {
  policy: "follow-pointer",
  focusOnMap: true,
  followRepick: false,
};

// Validate the user's config slice. Throws on any schema deviation; the
// in-thread bundled-plugin transport treats init throws as fatal startup
// errors, which is what we want for bad config.
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
  const followRepick = o.followRepick === undefined
    ? DEFAULT_CONFIG.followRepick : o.followRepick;
  if (typeof followRepick !== "boolean") {
    throw new TypeError(
      `focus.followRepick must be a boolean (got ${typeof followRepick})`);
  }
  return { policy, focusOnMap, followRepick };
}

// Decide focus from a coarse event. A `{}` return (undefined keyboardFocus)
// means leave focus unchanged -- the common case.
export function decideFocus(config: FocusPluginConfig, inputs: FocusInputs): FocusResult {
  const { policy, focusOnMap } = config;

  switch (inputs.reason) {
    case "pointer-enter": {
      if (policy === "follow-pointer") {
        return { keyboardFocus: inputs.pointer.surfaceUnderPointer };
      }
      return {};
    }

    case "pointer-leave": {
      if (policy === "follow-pointer") return { keyboardFocus: null };
      return {};
    }

    case "pointer-repick": {
      // The world moved under a stationary pointer. Ignored by default:
      // a camera flight or strip scroll must not hand keyboard focus to
      // whatever slides under the cursor. followRepick opts back into
      // treating it as pointer motion.
      if (policy === "follow-pointer" && config.followRepick) {
        return { keyboardFocus: inputs.pointer.surfaceUnderPointer };
      }
      return {};
    }

    case "pointer-button": {
      if (policy === "click-to-focus" && inputs.pointer.surfaceUnderPointer !== null) {
        return { keyboardFocus: inputs.pointer.surfaceUnderPointer };
      }
      return {};
    }

    case "window-mapped": {
      if (focusOnMap && inputs.trigger !== undefined) {
        return { keyboardFocus: inputs.trigger };
      }
      return {};
    }

    case "window-unmapped": {
      // Clearing focus on close of the focused window leaves the desktop
      // without a keyboard target until pointer-enter / explicit picks
      // one. Choosing a next window is not this plugin's job.
      if (inputs.trigger !== undefined && inputs.currentKeyboardFocus === inputs.trigger) {
        return { keyboardFocus: null };
      }
      return {};
    }

    case "workspace-changed": {
      // The pointer is stationary across a workspace switch but the stack
      // under it changed. Under follow-pointer the keyboard target should
      // track the new surface (null if nothing is there now). Click-to-
      // focus leaves focus where it is until a click.
      if (policy === "follow-pointer") {
        return { keyboardFocus: inputs.pointer.surfaceUnderPointer };
      }
      return {};
    }

    case "window-raised":
      return {};

    case "explicit": {
      if (inputs.trigger !== undefined) return { keyboardFocus: inputs.trigger };
      return { keyboardFocus: null };
    }
  }
}
