// Decoration plugin config validation. Pure function: raw unknown -> typed
// ResolvedConfig with every field populated. Throws on schema deviation; the
// in-thread bundled-plugin transport treats init throws as fatal startup
// errors, which is what we want for bad config.

import type {
  DecorationPluginConfig, DecorationFill,
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
  borderRadius: number;
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
  let borderRadius = DEFAULT_BORDER_RADIUS;
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
  }

  const focused = resolveFill(o.focused ?? DEFAULT_FOCUSED_FILL, "focused");
  const unfocused = resolveFill(o.unfocused ?? DEFAULT_UNFOCUSED_FILL, "unfocused");

  return { appIdPattern, appIdFlags, borderWidth, borderRadius, focused, unfocused };
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
export type { DecorationPluginConfig, DecorationFill } from "@overdraw/decoration-types";
