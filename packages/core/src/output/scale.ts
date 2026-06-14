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

// Snap a raw scale to a sane step. Fractional UIs round to quarter steps
// (1.0, 1.25, 1.5, ...) which is the granularity wp_fractional_scale_v1
// expresses cleanly (multiples of 120ths). Clamped to [1, 3].
export function snapScale(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const stepped = Math.round(raw * 4) / 4;
  return Math.min(3, Math.max(1, stepped));
}

// Derive a scale from physical size + resolution. DPI = px / (mm / 25.4).
// The reference density is 96 DPI = scale 1; the result is snapped. Returns 1
// when the physical size is unknown (0). This is the auto fallback, used only
// when no explicit scale is configured.
export function edidScaleFallback(
  deviceWidth: number, deviceHeight: number,
  physicalWidthMm: number, physicalHeightMm: number,
): number {
  if (physicalWidthMm <= 0 || physicalHeightMm <= 0) return 1;
  if (deviceWidth <= 0 || deviceHeight <= 0) return 1;
  const dpiX = deviceWidth / (physicalWidthMm / 25.4);
  const dpiY = deviceHeight / (physicalHeightMm / 25.4);
  const dpi = Math.max(dpiX, dpiY);
  return snapScale(dpi / 96);
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
  if (i.configScale != null) return snapScale(i.configScale);
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
