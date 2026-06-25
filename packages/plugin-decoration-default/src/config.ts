// Decoration plugin config validation. Pure function: raw unknown -> typed
// ResolvedConfig with every field populated. Throws on schema deviation; the
// in-thread bundled-plugin transport treats init throws as fatal startup
// errors, which is what we want for bad config.

import type {
  DecorationPluginConfig, DecorationFill, DecorationShape,
} from "@overdraw/decoration-types";

// RGBA in [0,1]. Used downstream by the shader uniform packer.
export interface RgbaF { r: number; g: number; b: number; a: number; }

// Internal resolved-fill shape. Always carries an ARRAY of stops (1 entry for
// solid; 2+ for gradient) with positions baked in to [0,1]. The drawing code
// only consults `stops` + `angleRad`; the originating kind is irrelevant.
export interface ResolvedFill {
  // Angle in radians, measured clockwise from +Y (CSS gradient convention).
  // Solid fills carry 0 (unused).
  angleRad: number;
  // Sorted by `at` ascending. At least one stop; solid fills carry exactly
  // one whose color the whole surface samples.
  stops: ReadonlyArray<{ color: RgbaF; at: number }>;
}

export interface ResolvedConfig {
  appIdPattern: string;
  appIdFlags: string | undefined;
  borderWidth: number;
  // The shape applied to the decoration's OUTER rect. The inner shape
  // (applied to the content surface) is derived at apply time by
  // insetting every radius / extent by `borderWidth`. null = a sharp
  // rectangle; no setShape call is issued (compositor early-out).
  outerShape: DecorationShape;
  focused: ResolvedFill;
  unfocused: ResolvedFill;
}

// Defaults applied when the corresponding field is missing.
const DEFAULT_BORDER_WIDTH = 2;
const DEFAULT_BORDER_RADIUS = 8;
const DEFAULT_APPID_PATTERN = ".*";

// A muted two-stop blue gradient: bright steel-blue at the top, deeper blue
// at the bottom. Distinct enough from the dim-gray unfocused fill to read as
// "this is the active window" at a glance.
const DEFAULT_FOCUSED_FILL: DecorationFill = {
  kind: "linear-gradient",
  angle: 0,
  stops: [
    { color: "#5b8fdcff", at: 0 },
    { color: "#2a4a7aff", at: 1 },
  ],
};

// A flat dim gray. Inactive windows fade into the background.
const DEFAULT_UNFOCUSED_FILL: DecorationFill = {
  kind: "solid",
  color: "#3a3a3aff",
};

export function validateConfig(raw: unknown): ResolvedConfig {
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`decoration config must be an object (got ${typeof raw})`);
  }
  const o = raw as { [k: string]: unknown };

  const appIdPattern = o.appIdPattern === undefined ? DEFAULT_APPID_PATTERN : o.appIdPattern;
  if (typeof appIdPattern !== "string" || appIdPattern.length === 0) {
    throw new TypeError(`decoration.appIdPattern must be a non-empty string`);
  }
  let appIdFlags: string | undefined;
  if (o.appIdFlags !== undefined) {
    if (typeof o.appIdFlags !== "string") {
      throw new TypeError(`decoration.appIdFlags must be a string`);
    }
    appIdFlags = o.appIdFlags;
  }
  // Validate the regex compiles here, before the plugin tries to register
  // (the core also compiles for matching, but failing at boot rather than
  // at the first window map gives a better diagnostic).
  try { new RegExp(appIdPattern, appIdFlags); }
  catch (e) {
    throw new TypeError(`decoration.appIdPattern is not a valid RegExp: ${(e as Error).message}`);
  }

  const border = o.border;
  let borderWidth = DEFAULT_BORDER_WIDTH;
  let borderRadius: number | undefined;
  let explicitShape: DecorationShape | undefined;
  if (border !== undefined) {
    if (border === null || typeof border !== "object" || Array.isArray(border)) {
      throw new TypeError(`decoration.border must be an object`);
    }
    const b = border as { [k: string]: unknown };
    if (b.width !== undefined) {
      if (typeof b.width !== "number" || !Number.isFinite(b.width) || b.width < 0) {
        throw new TypeError(`decoration.border.width must be a non-negative finite number`);
      }
      borderWidth = b.width;
    }
    if (b.radius !== undefined) {
      if (typeof b.radius !== "number" || !Number.isFinite(b.radius) || b.radius < 0) {
        throw new TypeError(`decoration.border.radius must be a non-negative finite number`);
      }
      borderRadius = b.radius;
    }
    if (b.shape !== undefined) {
      explicitShape = resolveShape(b.shape);
    }
  }

  // Shape resolution: explicit `shape` wins; then `radius` shorthand;
  // then the default radius (rounded-rect 8). A `radius: 0` collapses
  // to a null (rectangle) shape so the compositor skips the SDF.
  let outerShape: DecorationShape;
  if (explicitShape !== undefined) {
    outerShape = explicitShape;
  } else if (borderRadius !== undefined) {
    outerShape = borderRadius > 0 ? { kind: "rounded-rect", radius: borderRadius } : null;
  } else {
    outerShape = { kind: "rounded-rect", radius: DEFAULT_BORDER_RADIUS };
  }

  const focused = resolveFill(o.focused ?? DEFAULT_FOCUSED_FILL, "focused");
  const unfocused = resolveFill(o.unfocused ?? DEFAULT_UNFOCUSED_FILL, "unfocused");

  return { appIdPattern, appIdFlags, borderWidth, outerShape, focused, unfocused };
}

// Validate a DecorationShape literal. Mirrors the compositor's
// SurfaceShape validator (windows-sdk.ts validateShape) so a bad config
// fails at boot, not at the first setShape call.
function resolveShape(raw: unknown): DecorationShape {
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`decoration.border.shape must be a DecorationShape object or null`);
  }
  const s = raw as { [k: string]: unknown };
  const requireNonNeg = (name: string, v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new TypeError(`decoration.border.shape.${name} must be a non-negative finite number`);
    }
    return v;
  };
  switch (s.kind) {
    case "rounded-rect":
      return { kind: "rounded-rect", radius: requireNonNeg("radius", s.radius) };
    case "rounded-rect-per-corner":
      return {
        kind: "rounded-rect-per-corner",
        tl: requireNonNeg("tl", s.tl),
        tr: requireNonNeg("tr", s.tr),
        br: requireNonNeg("br", s.br),
        bl: requireNonNeg("bl", s.bl),
      };
    case "superellipse": {
      if (typeof s.exponent !== "number" || !Number.isFinite(s.exponent) || s.exponent <= 0) {
        throw new TypeError(
          `decoration.border.shape.exponent must be a positive finite number`);
      }
      return {
        kind: "superellipse",
        exponent: s.exponent,
        radius: requireNonNeg("radius", s.radius),
      };
    }
    default:
      throw new TypeError(
        `decoration.border.shape.kind must be "rounded-rect" | "rounded-rect-per-corner" | "superellipse" `
        + `(got ${JSON.stringify(s.kind)})`);
  }
}

// Inset every radius / extent of a shape by `borderWidth`. The result
// is the shape applied to the WINDOW CONTENT surface (inside the
// border band). Negative values are floored at 0 -- a content shape
// with all radii at 0 is a sharp rectangle (null) which the compositor
// renders as an early-out.
export function insetShape(outer: DecorationShape, borderWidth: number): DecorationShape {
  if (outer === null) return null;
  switch (outer.kind) {
    case "rounded-rect": {
      const r = Math.max(0, outer.radius - borderWidth);
      return r > 0 ? { kind: "rounded-rect", radius: r } : null;
    }
    case "rounded-rect-per-corner": {
      const tl = Math.max(0, outer.tl - borderWidth);
      const tr = Math.max(0, outer.tr - borderWidth);
      const br = Math.max(0, outer.br - borderWidth);
      const bl = Math.max(0, outer.bl - borderWidth);
      if (tl === 0 && tr === 0 && br === 0 && bl === 0) return null;
      return { kind: "rounded-rect-per-corner", tl, tr, br, bl };
    }
    case "superellipse": {
      // The superellipse "radius" is the half-extent on the shorter
      // axis; shrinking it by borderWidth produces the inner curve.
      // exponent is preserved (the shape family is the same).
      const r = Math.max(0, outer.radius - borderWidth);
      return r > 0
        ? { kind: "superellipse", exponent: outer.exponent, radius: r }
        : null;
    }
  }
}

// Validate a DecorationFill and bake its stops into normalized form.
function resolveFill(raw: unknown, fieldName: string): ResolvedFill {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`decoration.${fieldName} must be a DecorationFill object`);
  }
  const f = raw as { [k: string]: unknown };
  const kind = f.kind;
  if (kind === "solid") {
    if (typeof f.color !== "string") {
      throw new TypeError(`decoration.${fieldName}.color must be a string`);
    }
    return { angleRad: 0, stops: [{ color: parseColor(f.color, `${fieldName}.color`), at: 0 }] };
  }
  if (kind === "linear-gradient") {
    const angleDeg = f.angle === undefined ? 0 : f.angle;
    if (typeof angleDeg !== "number" || !Number.isFinite(angleDeg)) {
      throw new TypeError(`decoration.${fieldName}.angle must be a finite number`);
    }
    if (!Array.isArray(f.stops) || f.stops.length < 2) {
      throw new TypeError(`decoration.${fieldName}.stops must be an array of >=2 stops`);
    }
    const stops = f.stops.map((s, i) => {
      if (s === null || typeof s !== "object" || Array.isArray(s)) {
        throw new TypeError(`decoration.${fieldName}.stops[${i}] must be an object`);
      }
      const st = s as { [k: string]: unknown };
      if (typeof st.color !== "string") {
        throw new TypeError(`decoration.${fieldName}.stops[${i}].color must be a string`);
      }
      const color = parseColor(st.color, `${fieldName}.stops[${i}].color`);
      const at = st.at;
      if (at !== undefined) {
        if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || at > 1) {
          throw new TypeError(`decoration.${fieldName}.stops[${i}].at must be in [0,1]`);
        }
      }
      return { color, at: at as number | undefined };
    });
    // Bake `at` into a sorted [0,1]-spread array. Stops with explicit `at` keep
    // their value; missing `at`s are filled by even spacing across remaining
    // positions in the order they appear. Final array sorted ascending; a
    // duplicate / out-of-order user input surfaces as a sorted, well-formed
    // gradient.
    const N = stops.length;
    const baked: { color: RgbaF; at: number }[] = stops.map((s, i) => ({
      color: s.color,
      at: s.at !== undefined ? s.at : i / (N - 1),
    }));
    baked.sort((a, b) => a.at - b.at);
    const angleRad = angleDeg * Math.PI / 180;
    return { angleRad, stops: baked };
  }
  throw new TypeError(
    `decoration.${fieldName}.kind must be "solid" or "linear-gradient" (got ${JSON.stringify(kind)})`);
}

// Parse a CSS-like #rgb / #rrggbb / #rrggbbaa string into RgbaF (each
// component in [0,1]). Other CSS color forms (rgb(), hsl(), color names)
// are intentionally NOT accepted -- a fast, dependency-free parser is
// sufficient for a config string.
export function parseColor(s: string, field: string): RgbaF {
  const m = /^#([0-9a-fA-F]+)$/.exec(s.trim());
  if (!m) throw new TypeError(`decoration.${field}: expected "#rgb" / "#rrggbb" / "#rrggbbaa" (got ${JSON.stringify(s)})`);
  const hex = m[1];
  let r = 0, g = 0, b = 0, a = 255;
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
  } else if (hex.length === 6) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else if (hex.length === 8) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
    a = parseInt(hex.slice(6, 8), 16);
  } else {
    throw new TypeError(`decoration.${field}: expected "#rgb" / "#rrggbb" / "#rrggbbaa" (got ${JSON.stringify(s)})`);
  }
  return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
}

// Re-export the typed slot so users / callers can `satisfies DecorationPluginConfig`
// in one import.
export type {
  DecorationPluginConfig, DecorationFill, DecorationShape,
} from "@overdraw/decoration-types";
