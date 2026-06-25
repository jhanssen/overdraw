// Canonical config types for the bundled decoration plugin
// (@overdraw/plugin-decoration-default). A user's overdraw config passes a
// `decoration` slice verbatim through to the plugin's init(sdk, rawConfig);
// the plugin owns validation. These types let a user write
// `decoration: cfg satisfies DecorationPluginConfig` for IDE help without
// committing the core to the shape (core treats it as `unknown`).

// Decoration shape vocabulary. Mirrors the compositor's SurfaceShape but
// declared here so users writing `decoration: cfg satisfies
// DecorationPluginConfig` don't need to import a core-internal type.
// `null` is a rectangle. Per-corner and superellipse map directly onto
// the compositor's analytic SDF; the plugin applies one shape to the
// decoration's outer rect and derives an inset shape for the window's
// content rect (per-corner: each corner shrunk by `border.width`;
// superellipse: the radius half-extent shrunk).
export type DecorationShape =
  | null
  | { kind: "rounded-rect"; radius: number }
  | {
      kind: "rounded-rect-per-corner";
      tl: number; tr: number; br: number; bl: number;
    }
  | {
      // |x/a|^n + |y/b|^n = 1. n=4..6 is the macOS-style squircle;
      // n=2 is an ellipse; large n approaches a sharp rect. `radius`
      // is the half-extent on the shorter axis (mirrors the
      // rounded-rect API; the compositor uses the surface's actual
      // extents in both axes).
      kind: "superellipse";
      exponent: number;
      radius: number;
    };

// A solid fill or a multi-stop linear gradient. Used for the focused/
// unfocused border appearance.
//
// Color strings are CSS-like: "#rgb", "#rrggbb", "#rrggbbaa". Alpha defaults
// to fully opaque when omitted. Other CSS forms (rgb(), hsl()) are NOT
// accepted -- the validator wants a fast, dependency-free parser.
export type DecorationFill =
  | { kind: "solid"; color: string }
  | {
      // Linear gradient along the surface in normalized coords. `angle` is in
      // degrees, measured clockwise from the +Y axis (CSS convention): 0 =
      // top->bottom, 90 = left->right, 180 = bottom->top, 270 = right->left.
      kind: "linear-gradient";
      angle?: number;
      // Two or more color stops. `at` is the position along the gradient in
      // [0,1]; when omitted, stops are spaced evenly. Order matters (the
      // shader interpolates between consecutive stops by `at`).
      stops: ReadonlyArray<{ color: string; at?: number }>;
    };

// The full config the bundled plugin accepts. Every field is optional;
// missing fields take the documented defaults below.
export interface DecorationPluginConfig {
  // Provider match. Default ".*" (decorate every window).
  appIdPattern?: string;
  // Optional RegExp flags applied to appIdPattern (e.g. "i" for case-insensitive).
  appIdFlags?: string;

  // Frame geometry.
  border?: {
    // Border thickness in (logical) pixels. Applied to all four edges.
    // Default 2.
    width?: number;
    // Shorthand: outer-corner radius in (logical) pixels, equivalent to
    // `shape: { kind: "rounded-rect", radius }`. 0 = sharp corners.
    // Default 8. Mutually exclusive with `shape` (when both are given,
    // `shape` wins). The inner shape that masks the window's content is
    // derived by insetting every radius / extent by `width`.
    radius?: number;
    // Explicit shape. Overrides `radius` if both are present. `null`
    // is a sharp-edged rectangle (= radius: 0).
    shape?: DecorationShape;
  };

  // Frame fill when the decorated window is the keyboard-focused window.
  // Default: a subtle two-stop blue-ish gradient.
  focused?: DecorationFill;
  // Frame fill when the decorated window is not focused. Default: a flat
  // dim gray.
  unfocused?: DecorationFill;

  // Escape hatch for plugin-specific extensions (custom shape, additional
  // overlays, alternative shader knobs). The bundled default plugin ignores
  // unknown keys; a user fork can read this. Including a typed slot here
  // means future config additions in a fork don't have to be hung off
  // `appIdPattern`-adjacent fields.
  extra?: { [key: string]: unknown };
}
