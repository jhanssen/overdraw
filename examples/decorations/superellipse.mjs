// Example overdraw config: macOS-style squircle (superellipse) corners on
// every window's decoration. The bundled `plugin-decoration-default` reads
// `config.decoration`, passes it through its own validator, and applies the
// outer shape to the decoration surface + a derived inner shape to the
// window content surface (inset by border.width on every axis).
//
// Run it:
//   npm run build:js
//   node packages/core/dist/main.js --config examples/decorations/superellipse.mjs
//
// Then point a client at the printed WAYLAND_DISPLAY.
//
// About the superellipse shape:
//   The window is a rectangle whose CORNERS are replaced by a localized
//   superelliptic curve. Edges stay straight; only the corner box of size
//   (radius, radius) follows the squircle math. This matches the macOS
//   style: a normal-shaped window with smoothed corners, NOT a full
//   ellipse covering the whole window.
//
// `exponent` controls the corner character:
//   2     -> circular arc (identical to a rounded-rect with the same radius)
//   4..6  -> the macOS "squircle" range (continuous-curvature corner;
//            smoother eye-tracking than a circular arc into the flat edge)
//   large -> approaches a sharp rectangle (the curve compresses into the
//            very last pixel of the corner)
//
// `radius` is the corner extent in logical pixels, clamped to
// min(width, height) / 2. Typical values: 8..16 for a normal-sized window
// matches GTK / GNOME conventions; 12..24 for a more macOS-like
// pronouncement.
export default {
  decoration: {
    border: {
      width: 2,
      shape: { kind: "superellipse", exponent: 5, radius: 12 },
    },
    // A subtle two-stop focused gradient + flat dim unfocused. Skip these
    // fields to keep the bundled plugin's defaults.
    focused: {
      kind: "linear-gradient",
      angle: 0,
      stops: [
        { color: "#5b8fdcff", at: 0 },
        { color: "#2a4a7aff", at: 1 },
      ],
    },
    unfocused: { kind: "solid", color: "#3a3a3aff" },
  },
};
