// Example overdraw config that loads the window-animation plugin.
//
// Run it:
//   npm run build:js
//   node packages/core/dist/main.js --config examples/window-animations/config.mjs
//
// Open clients (a terminal will do); the first one slides in from the
// right of its tile while fading in. Open a second; it slides in from
// the right of the stack column while the first animates from "full
// output" to "left half" in the same frame budget. Same for closes (the
// remaining windows animate from their pre-close rects to the new
// post-close rects).
//
// The plugin claims the 'window-opening' namespace. That tells the
// opening-driver to engage the content gate at first-content commit so
// the plugin's setTransform/setOpacity calls land BEFORE the surface's
// first composite -- no flash, the window is mid-animation from frame 0.

export default {
  plugins: [
    { module: "./plugin.mjs", name: "window-animations" },
  ],
};
