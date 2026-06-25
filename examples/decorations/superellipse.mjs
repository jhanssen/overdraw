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
// About the superellipse:
//   |x/a|^n + |y/b|^n = 1
// exponent=2  -> ellipse
// exponent=4..6 -> the macOS-style "squircle" (continuous-curvature corner;
//                  smoother eye-tracking than a circular arc into a flat
//                  edge). exponent=5 is a common choice; macOS itself uses
//                  ~5 with some additional smoothing math.
// large exponent -> approaches a sharp rectangle.
//
// `radius` is the half-extent on the SHORTER axis -- exposed for symmetry
// with rounded-rect APIs; the compositor uses the surface's actual extents
// in both axes regardless.
export default {
  decoration: {
    border: {
      width: 2,
      shape: { kind: "superellipse", exponent: 5, radius: 24 },
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
