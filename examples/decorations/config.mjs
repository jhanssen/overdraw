// Example overdraw config that loads the animated-gradient decoration plugin.
// Run it:
//   npm run build:js
//   node dist/main.js --config examples/decorations/config.mjs
// then point a client at the printed WAYLAND_DISPLAY, e.g.:
//   WAYLAND_DISPLAY=<printed> foot
//
// The plugin `module` path is resolved relative to THIS file's directory (paths
// starting with ./ or ../, or absolute, are config-relative; bare specifiers pass
// through to the module resolver).
export default {
  plugins: [
    { module: "./animated-gradient.mjs", name: "animated-gradient" },
  ],
};
