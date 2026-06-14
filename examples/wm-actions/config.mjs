// Example overdraw config binding the Tier-0 window-management actions:
// keyboard focus navigation + master-stack layout manipulation. These
// actions ship bindable-but-unbound; this config wires them to keys so you
// can drive a tiling session from the keyboard.
//
// Run it (KMS, from a TTY):
//   npm run build:js
//   node packages/core/dist/main.js --config examples/wm-actions/config.mjs
// or nested under an existing compositor (e.g. during dev):
//   node packages/core/dist/main.js --backend=nested --config examples/wm-actions/config.mjs
//
// Then point a few clients at the printed WAYLAND_DISPLAY:
//   WAYLAND_DISPLAY=<printed> kitty   # open three or four of these
//
// Mod = Super (the logo key). Action logs (sdk.log) go to the compositor's
// stderr.

export default {
  hotkeys: {
    modes: {
      default: [
        // -- session ------------------------------------------------------
        { keys: "Mod+t", action: "spawn", params: { command: "kitty" } },
        { keys: "Mod+Shift+c", action: "window.close" },
        { keys: "Mod+x", action: "compositor.quit" },

        // -- keyboard focus navigation ------------------------------------
        // Cycle focus through the toplevel stack (wraps at the ends).
        { keys: "Mod+j", action: "focus.next" },
        { keys: "Mod+k", action: "focus.prev" },

        // -- layout: stack reordering -------------------------------------
        // Move the focused window into the master slot.
        { keys: "Mod+Return", action: "layout.promote" },
        // Swap the focused window with its neighbour in the stack.
        { keys: "Mod+Shift+j", action: "layout.swap-next" },
        { keys: "Mod+Shift+k", action: "layout.swap-prev" },

        // -- layout: master column width ----------------------------------
        // Grow / shrink the master column by one step (0.05) per press.
        { keys: "Mod+l", action: "layout.grow-master" },
        { keys: "Mod+h", action: "layout.shrink-master" },
      ],
    },
  },
};
