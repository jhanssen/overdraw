// X11 clients see GLASS positions, not world positions (canvas-design.md
// §7b). X coordinates are int16; world coordinates roam. The XWM narrates
// each managed window's position through the chart camera of the output
// that shows it -- pan only, camera zoom is compositor-side optics X never
// learns about -- so told coordinates stay bounded by the physical
// arrangement. Inbound X coordinates (override-redirect placements) invert
// the mapping through the output whose glass rect contains the point.
// Identity cameras make both directions the identity.
//
// Hidden windows keep being told coordinates in their last home output's
// frame (the chart falls back to geometric overlap): a hidden window's
// told position is dormant state, re-told on show. The structured attic
// (per-island parking slots) arrives with world positions.

import type { CompositorState } from "../protocols/ctx.js";
import type { Addon } from "../types.js";
import { log } from "../log.js";

// Pan-only chart camera for an X-backed window: the camera of the
// lowest-id output that SHOWS the window (stack-gated residency), falling
// back to the lowest geometric overlap, then to identity. glass = world -
// chart.
export function xChartCameraOf(
  state: CompositorState, surfaceId: number,
): { x: number; y: number } {
  const comp = state.compositor;
  let outs = comp.surfaceVisibleOutputs
    ? comp.surfaceVisibleOutputs(surfaceId) : undefined;
  if (!outs || outs.length === 0) {
    outs = comp.surfaceOutputs ? comp.surfaceOutputs(surfaceId) : undefined;
  }
  if (!outs || outs.length === 0) return { x: 0, y: 0 };
  let lo = Infinity;
  for (const id of outs) if (id < lo) lo = id;
  const cam = state.outputCameras?.get(lo);
  return cam ? { x: cam.x, y: cam.y } : { x: 0, y: 0 };
}

// Inbound: a glass-space point (an override-redirect placement, already
// reduced to logical pixels) mapped to world through the camera of the
// output whose glass rect contains it. Points on no output pass through.
export function xGlassToWorld(
  state: CompositorState, gx: number, gy: number,
): { x: number; y: number } {
  const cams = state.outputCameras;
  if (!cams || cams.size === 0 || !state.outputs) return { x: gx, y: gy };
  for (const o of state.outputs.values()) {
    const p = o.logicalPosition;
    const s = o.logicalSize;
    if (gx >= p.x && gx < p.x + s.width && gy >= p.y && gy < p.y + s.height) {
      const cam = cams.get(o.id);
      return cam ? { x: gx + cam.x, y: gy + cam.y } : { x: gx, y: gy };
    }
  }
  return { x: gx, y: gy };
}

// X wire coordinates are int16 and wrap silently. A told coordinate
// outside the range means a gap in the glass-space fiction (or a bug);
// clamp and say so rather than let clients see wrapped positions.
const X16_MAX = 32767;
const X16_MIN = -32768;
function clampX16(v: number, window: number, what: string): number {
  if (v > X16_MAX || v < X16_MIN) {
    log.warn("core",
      `X window ${window}: told ${what}=${v} exceeds int16; clamped ` +
      `(glass-space fiction gap)`);
    return Math.max(X16_MIN, Math.min(X16_MAX, v));
  }
  return v;
}

// Tell one X window its rect (X-device coords): ConfigureWindow + the
// synthetic ConfigureNotify (ICCCM §4.2.3), with int16-clamped position.
export function tellXRect(
  addon: Addon, window: number,
  x: number, y: number, w: number, h: number,
): void {
  const cx = clampX16(Math.round(x), window, "x");
  const cy = clampX16(Math.round(y), window, "y");
  addon.xwmConfigureWindow(window, cx, cy, w, h);
  addon.xwmSendConfigureNotify(window, cx, cy, w, h);
}
