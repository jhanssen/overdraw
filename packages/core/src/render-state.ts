// Per-surface render-state vocabulary shared by the compositor sink
// (gpu/compositor.ts), the plugin-facing SDK (plugins/windows-sdk.ts), and
// the windows broker (plugins/windows-broker.ts): the payload types for the
// opacity/transform/margin/tint/color-matrix/shape/backdrop setters, plus
// the throwing validators both ends of the plugin wire apply to them.

// Per-surface transform; all fields optional, missing fields reset to identity.
// translate is in output pixels, scale is unitless. Rotation is not supported in
// v1 (spec builders compose center-anchored scale via translate + scale + counter-
// translate; rotation needs a shader path that doesn't exist yet).
export interface SurfaceTransform {
  translateX?: number;
  translateY?: number;
  scaleX?: number;
  scaleY?: number;
}

// Per-edge margin in output pixels reserved AROUND the surface's nominal rect.
// Used by downstream consumers (masks, decoration shadows, intercept stages) to
// paint outside the surface itself. Missing fields default to 0.
export interface SurfaceMargin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

// Per-channel tint multiplier on the sampled rgba. Identity is
// (1,1,1,1); missing fields default to 1 (no change to that channel).
// Examples: dim to half = { r: 0.5, g: 0.5, b: 0.5 }; suppress red =
// { r: 0 }; fade alpha = { a: 0.5 }.
export interface SurfaceTint {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}

// 4x4 color matrix applied to the sampled rgba before the per-channel tint.
// Caller passes 16 numbers in COLUMN-MAJOR order, matching
// WGSL mat4x4f. Identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]. Covers
// saturation, hue rotation, contrast, brightness, channel swap. Anything
// needing neighbor pixels within the window's OWN content (distortion,
// content blur) is for the buffer-intercept path; effects on the content
// BEHIND the window go through setBackdropEffect.
export type ColorMatrix = readonly number[] | Float32Array;

// Backdrop effect: the window composites over a transformed copy of
// everything below it in the draw order. `kind` names a renderer
// registered with the compositor ("blur" is the built-in default; in-thread
// plugins can register more via sdk.gpu.registerBackdropEffect). `params`
// is a flat numeric bag the renderer interprets -- for "blur":
// { radius } in logical pixels (default 20).
export interface SurfaceBackdropEffect {
  kind: string;
  params?: Record<string, number>;
}

// Analytic per-surface shape evaluated by the compositor's fragment shader.
// Composes multiplicatively with the optional alpha mask, so a plugin may use
// both (mask for arbitrary shapes, shape for rounded corners; the intersection
// is rendered). null = rectangle (default; shader early-out, zero cost). Radii
// / extents are in surface LOGICAL pixels.
//
// Vocabulary:
//   rounded-rect:           uniform corner radius (circular arc)
//   rounded-rect-per-corner: independent (tl, tr, br, bl) radii (circular arcs)
//   superellipse:           a rectangle whose corners are replaced by a
//                           localized superelliptic curve of extent `radius`
//                           (the macOS-style squircle corner). `exponent`
//                           controls the curve character: n=2 is identical
//                           to rounded-rect (circular arc); n=4..6 is the
//                           macOS-style squircle (continuous-curvature
//                           corner with smoother eye-tracking than a circular
//                           arc); larger n approaches a sharp rectangle.
//                           `radius` is the corner extent in logical px and
//                           is clamped to <= min(width, height) / 2.
export type SurfaceShape =
  | null
  | { kind: "rounded-rect"; radius: number }
  | { kind: "rounded-rect-per-corner";
      tl: number; tr: number; br: number; bl: number }
  | { kind: "superellipse"; exponent: number; radius: number };

// --- Validators -----------------------------------------------------------
//
// One assert per payload type, applied on BOTH ends of the plugin wire: the
// SDK calls them directly (a plugin gets a field-named TypeError), the
// broker wraps them in a boolean guard (a malformed cross-wire payload is
// rejected without trusting the sender). `method` prefixes the message with
// the caller's API name.

export function assertTransform(t: SurfaceTransform, method = "setTransform"): void {
  if (typeof t !== "object" || t === null) {
    throw new TypeError(`${method} t must be an object`);
  }
  for (const k of ["translateX", "translateY", "scaleX", "scaleY"] as const) {
    const v = t[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new TypeError(`${method} ${k} must be a finite number`);
    }
  }
}

export function assertMargin(m: SurfaceMargin, method = "setOutputMargin"): void {
  if (typeof m !== "object" || m === null) {
    throw new TypeError(`${method} m must be an object`);
  }
  for (const k of ["top", "right", "bottom", "left"] as const) {
    const v = m[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      throw new TypeError(`${method} ${k} must be a non-negative finite number`);
    }
  }
}

// Insets are validated as four required finite numbers; negatives are
// accepted here and clamped to zero by the WM when the grant is applied.
export function assertInsets(
  i: { top: number; right: number; bottom: number; left: number },
  method = "setInsets",
): void {
  if (typeof i !== "object" || i === null) {
    throw new TypeError(`${method} insets must be an object`);
  }
  for (const k of ["top", "right", "bottom", "left"] as const) {
    const v = i[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new TypeError(`${method} ${k} must be a finite number`);
    }
  }
}

export function assertShape(shape: SurfaceShape, method = "setShape"): void {
  if (shape === null) return;
  if (typeof shape !== "object") {
    throw new TypeError(`${method} shape must be a SurfaceShape object or null`);
  }
  const requireNonNeg = (name: string, v: unknown): void => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new TypeError(`${method}: ${name} must be a non-negative finite number`);
    }
  };
  switch (shape.kind) {
    case "rounded-rect":
      requireNonNeg("radius", shape.radius);
      return;
    case "rounded-rect-per-corner":
      requireNonNeg("tl", shape.tl);
      requireNonNeg("tr", shape.tr);
      requireNonNeg("br", shape.br);
      requireNonNeg("bl", shape.bl);
      return;
    case "superellipse":
      requireNonNeg("radius", shape.radius);
      if (typeof shape.exponent !== "number" || !Number.isFinite(shape.exponent)
          || shape.exponent < 2) {
        throw new TypeError(`${method}: exponent must be a finite number >= 2`);
      }
      return;
    default: {
      // The discriminator was something else; surface a useful error.
      const k = (shape as { kind?: unknown }).kind;
      throw new TypeError(
        `${method}: unknown shape kind ${JSON.stringify(k)} `
        + `(expected "rounded-rect", "rounded-rect-per-corner", or "superellipse")`);
    }
  }
}

export function assertBackdropEffect(
  e: SurfaceBackdropEffect | null, method = "setBackdropEffect",
): void {
  if (e === null) return;
  if (typeof e !== "object") {
    throw new TypeError(`${method} e must be an object or null`);
  }
  if (typeof e.kind !== "string" || e.kind.length === 0) {
    throw new TypeError(`${method} kind must be a non-empty string`);
  }
  if (e.params !== undefined) {
    if (typeof e.params !== "object" || e.params === null) {
      throw new TypeError(`${method} params must be an object`);
    }
    for (const [k, v] of Object.entries(e.params)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new TypeError(`${method} params.${k} must be a finite number`);
      }
    }
  }
}

export function assertTint(t: SurfaceTint, method = "setTint"): void {
  if (typeof t !== "object" || t === null) {
    throw new TypeError(`${method} t must be an object`);
  }
  for (const k of ["r", "g", "b", "a"] as const) {
    const v = t[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new TypeError(`${method} ${k} must be a finite number`);
    }
  }
}

export function assertColorMatrix(m: ColorMatrix, method = "setColorMatrix"): void {
  // Accept readonly number[] or Float32Array; both are ArrayLike<number>.
  if (!Array.isArray(m) && !(m instanceof Float32Array)) {
    throw new TypeError(`${method} m must be an array of 16 numbers or null`);
  }
  if (m.length !== 16) {
    throw new TypeError(`${method} m must have 16 entries, got ${m.length}`);
  }
  for (let i = 0; i < 16; i++) {
    const v = m[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new TypeError(`${method} m[${i}] must be a finite number`);
    }
  }
}

// True when `check` runs without throwing. The broker's payload guards wrap
// the asserts with this so a malformed cross-wire payload rejects as a
// boolean instead of an exception.
export function validates(check: () => void): boolean {
  try { check(); return true; } catch { return false; }
}
