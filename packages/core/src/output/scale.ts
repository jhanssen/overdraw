// Output scale resolution.
//
// The compositor works in two pixel spaces: device pixels (the scanout /
// render target) and logical pixels (everything client-facing: layout,
// xdg_toplevel.configure sizes, xdg-output, pointer coordinates). The scale
// factor bridges them: logical = round(device / scale).
//
// Scale selection precedence (resolveScale): an explicit config value wins;
// otherwise the display's EDID DPI drives an auto value (KMS only — a nested
// host window has no meaningful physical size of its own); otherwise 1.

// Snap a raw scale to a value that produces integer-pixel logical
// dimensions for the given device size. A naive quarter-step rounding
// (1.0, 1.25, 1.5, 1.75, ...) at 3840x2160 yields logical 2194.286x1234.286
// at 1.75 -- the rounded advertised logical dims (2194x1234) disagree with
// the actual physical extent by a fraction of a logical pixel, which
// breaks clients that expect the two to be consistent (notably Qt with
// wp_viewport).
//
// Search at the wp_fractional_scale_v1 grain (1/120) outward from the
// raw scale, preferring smaller deltas. The first scale whose
// (deviceWidth / scale) and (deviceHeight / scale) both round-trip
// exactly to integers wins. Clamped to [1, 3] (the surrounding code
// assumes sane scales; values outside this range produce nonsensical
// rendering even when the math is clean).
//
// Falls back to 1 when no clean scale exists within the search window
// (~half the range either way at 1/120 steps); rare in practice for
// real-world monitor pixel sizes.
export function snapScale(raw: number, deviceWidth?: number, deviceHeight?: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const clamped = Math.min(3, Math.max(1, raw));
  // No device size known (legacy callers / nested host without geometry):
  // fall back to the quarter-step rounding that won't introduce fractional
  // logical pixels at the canonical scales (1.0, 1.25, 1.5, 2.0, 2.5, 3.0).
  if (deviceWidth === undefined || deviceHeight === undefined
      || deviceWidth <= 0 || deviceHeight <= 0) {
    return Math.min(3, Math.max(1, Math.round(clamped * 4) / 4));
  }
  // Discretize the search range to 1/120 steps to align with the wire-level
  // grain of wp_fractional_scale_v1. Start at the rounded raw value and walk
  // outward, returning the first scale that yields integer logical dims on
  // both axes. The window is wide enough to cover any reasonable input.
  const step = 1 / 120;
  const startIdx = Math.round(clamped * 120);
  const minIdx = Math.max(120, startIdx - 60); // 1.0 floor
  const maxIdx = Math.min(360, startIdx + 60); // 3.0 ceil
  const integerLogical = (s: number): boolean => {
    const lw = deviceWidth / s;
    const lh = deviceHeight / s;
    return Math.abs(lw - Math.round(lw)) < 1e-9
        && Math.abs(lh - Math.round(lh)) < 1e-9;
  };
  if (integerLogical(startIdx * step)) return startIdx * step;
  for (let delta = 1; delta <= 60; delta++) {
    const up = startIdx + delta;
    const down = startIdx - delta;
    if (up <= maxIdx && integerLogical(up * step)) return up * step;
    if (down >= minIdx && integerLogical(down * step)) return down * step;
  }
  // No clean scale in the search window. Fall back to 1 (which always
  // yields integer logical dims = device dims).
  return 1;
}

// Pixel density (DPI) from device resolution + physical size, taking the denser
// axis. Returns 0 when either input is missing (unknown physical size). DPI =
// px / (mm / 25.4).
export function edidDpi(
  deviceWidth: number, deviceHeight: number,
  physicalWidthMm: number, physicalHeightMm: number,
): number {
  if (physicalWidthMm <= 0 || physicalHeightMm <= 0) return 0;
  if (deviceWidth <= 0 || deviceHeight <= 0) return 0;
  const dpiX = deviceWidth / (physicalWidthMm / 25.4);
  const dpiY = deviceHeight / (physicalHeightMm / 25.4);
  return Math.max(dpiX, dpiY);
}

// Derive a scale from physical size + resolution. The reference density is
// 96 DPI = scale 1; the result is snapped to a value that produces integer
// logical dimensions for the device size. Returns 1 when the physical size is
// unknown. This is the auto fallback, used only when no explicit scale is
// configured.
export function edidScaleFallback(
  deviceWidth: number, deviceHeight: number,
  physicalWidthMm: number, physicalHeightMm: number,
): number {
  const dpi = edidDpi(deviceWidth, deviceHeight, physicalWidthMm, physicalHeightMm);
  if (dpi <= 0) return 1;
  const raw = dpi / 96;
  // Integer deadzone: a density within SCALE_DEADZONE of a whole-number scale
  // is treated as that integer. This keeps near-1x panels (e.g. a ~109 DPI
  // 1440p/ultrawide at raw ~1.14) at 1.0 instead of a pointless fractional
  // scale, and lands near-2x panels on a clean 2.0. Densities solidly between
  // integers keep their exact integer-logical scale (1.25, 1.5, 1.667, ...).
  const SCALE_DEADZONE = 0.2;
  const nearest = Math.round(raw);
  if (nearest >= 1 && Math.abs(raw - nearest) <= SCALE_DEADZONE) {
    return snapScale(nearest, deviceWidth, deviceHeight);
  }
  return snapScale(raw, deviceWidth, deviceHeight);
}

export interface ScaleInputs {
  configScale: number | null;       // explicit override, or null
  deviceWidth: number;
  deviceHeight: number;
  physicalWidthMm: number;
  physicalHeightMm: number;
  // Auto EDID derivation only applies on bare-metal output; a nested host
  // window's physical dims describe the host monitor, not our render target.
  allowEdidAuto: boolean;
}

export function resolveScale(i: ScaleInputs): number {
  // Explicit config: honor what the user asked for. Snap to the
  // wp_fractional_scale grain (quarter steps) for stability across
  // restarts, but do NOT silently retarget to a different scale just to
  // get integer logical dimensions -- the user said 1.5, give them 1.5
  // (even if it produces fractional logical pixels for some resolutions).
  if (i.configScale != null) {
    const stepped = Math.round(i.configScale * 4) / 4;
    return Math.min(3, Math.max(1, stepped));
  }
  if (i.allowEdidAuto) {
    return edidScaleFallback(i.deviceWidth, i.deviceHeight,
      i.physicalWidthMm, i.physicalHeightMm);
  }
  return 1;
}

// Logical size for a device size at a scale. Rounded; never below 1.
export function logicalSize(deviceWidth: number, deviceHeight: number, scale: number):
    { width: number; height: number } {
  const s = scale > 0 ? scale : 1;
  return {
    width: Math.max(1, Math.round(deviceWidth / s)),
    height: Math.max(1, Math.round(deviceHeight / s)),
  };
}
