// Example overdraw config exercising the hotkey chord + mode system.
// Run it:
//   npm run build:js
//   node packages/core/dist/main.js --config examples/hotkeys/config.mjs
// then point a client at the printed WAYLAND_DISPLAY, e.g.:
//   WAYLAND_DISPLAY=<printed> foot
//
// Watch input events from another terminal while pressing keys:
//   node packages/core/dist/cli/overdrawctl.js subscribe 'input.*'
//
// Action logs (sdk.log) print to the compositor's stderr.

import { ref } from "overdraw/config";

export default {
  hotkeys: {
    modes: {
      // Default mode is required. Bindings here need a modifier so plain
      // typing into a client still reaches it.
      default: [
        { keys: "Mod+q", action: "compositor.quit" },

        // Workspace switching (Phase 6).
        { keys: "Mod+1", action: "workspace.show", params: { index: 1 } },
        { keys: "Mod+2", action: "workspace.show", params: { index: 2 } },
        { keys: "Mod+3", action: "workspace.show", params: { index: 3 } },
        { keys: "Mod+n", action: "workspace.create" },

        // Move the focused window to workspace 1 / 2 (deferred ref
        // resolves at chord-match time, not config-load time).
        { keys: "Mod+Shift+1", action: "workspace.move-window",
          params: { surfaceId: ref.focusedWindow, index: 1 } },
        { keys: "Mod+Shift+2", action: "workspace.move-window",
          params: { surfaceId: ref.focusedWindow, index: 2 } },

        // Two-step chord: press Mod+a, then Mod+b. After Mod+a the
        // compositor is in "prefix" state -- any non-matching key
        // cancels and forwards to the client (the prefix Mod+a is
        // not replayed; this is documented).
        { keys: ["Mod+a", "Mod+b"], action: "user.two-step" },

        // Three-step chord using the comma-separated string syntax.
        // Equivalent to ["Mod+x", "Mod+y", "Mod+z"].
        { keys: "Mod+x, Mod+y, Mod+z", action: "user.three-step" },

        // Push a sub-mode. Inside the mode, plain keys (no Mod) work
        // because typing is suppressed: mode is ISOLATED, so unbound
        // keys do NOT fall through to the client.
        { keys: "Mod+r", pushMode: "resize" },

        // Deferred-ref demo. Focus a client window, press Mod+u, see
        // the focused surfaceId in the compositor's stderr.
        { keys: "Mod+u", action: "user.show-focus",
          params: { surface: ref.focusedWindow } },
      ],

      // Sub-mode. exitOnEscape defaults to true for non-default modes,
      // so plain Escape pops it. Return also pops (explicit binding).
      // No Mod needed -- the mode owns every key.
      resize: [
        { keys: "Return", popMode: true },
        { keys: "h", action: "user.resize-step", params: { dir: "left" } },
        { keys: "j", action: "user.resize-step", params: { dir: "down" } },
        { keys: "k", action: "user.resize-step", params: { dir: "up" } },
        { keys: "l", action: "user.resize-step", params: { dir: "right" } },
      ],
    },
  },

  // User-defined actions (Phase 7b). Each handler receives (sdk, params)
  // and runs in-thread in the bundled plugin-config-actions plugin.
  // Convention: prefix names with `user.`.
  actions: {
    "user.two-step": async (sdk) => {
      await sdk.log("two-step chord Mod+a, Mod+b fired");
    },
    "user.three-step": async (sdk) => {
      await sdk.log("three-step chord Mod+x, Mod+y, Mod+z fired");
    },
    "user.show-focus": async (sdk, params) => {
      // params.surface arrived as ref.focusedWindow and was resolved
      // by the action registry before this handler ran. The handler
      // never sees the { $ref: "..." } sentinel.
      await sdk.log(`focused surface: ${JSON.stringify(params)}`);
    },
    "user.resize-step": async (sdk, params) => {
      // No real resize implementation -- xdg_toplevel state requests
      // are no-ops today (status.md "Read first"). This just proves
      // the mode + binding fires.
      await sdk.log(`resize step: ${JSON.stringify(params)}`);
    },
  },
};
