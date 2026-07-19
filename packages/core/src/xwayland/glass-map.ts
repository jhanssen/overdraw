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
// lowest-id output that SHOWS the window (stack-gated residency).
// glass = world - chart.
//
// A window shown nowhere is narrated in its ISLAND FRAME: the camera that
// WOULD show it -- the one docking its island's origin at its context
// output's arrangement origin. Told coordinates stay in-arrangement
// (int16-safe) no matter how far the island's world slot roams, are
// deterministic for never-shown windows, and preserve intra-island
// relative geometry; they coincide with the shown narration the moment a
// camera actually docks there. Without an island (implicit islands /
// non-world mode), fall back to the lowest geometric overlap, then
// identity -- the retained-fiction rule.
export function xChartCameraOf(
  state: CompositorState, surfaceId: number,
): { x: number; y: number } {
  const comp = state.compositor;
  const outs = comp.surfaceVisibleOutputs
    ? comp.surfaceVisibleOutputs(surfaceId) : undefined;
  if (outs && outs.length > 0) {
    let lo = Infinity;
    for (const id of outs) if (id < lo) lo = id;
    const cam = state.outputCameras?.get(lo);
    return cam ? { x: cam.x, y: cam.y } : { x: 0, y: 0 };
  }
  const island = state.wm?.islandOf(surfaceId);
  if (island && island.rect) {
    const out = state.outputs?.get(island.contextOutputId);
    if (out) {
      return {
        x: island.rect.x - out.logicalPosition.x,
        y: island.rect.y - out.logicalPosition.y,
      };
    }
  }
  const geo = comp.surfaceOutputs ? comp.surfaceOutputs(surfaceId) : undefined;
  if (!geo || geo.length === 0) return { x: 0, y: 0 };
  let lo = Infinity;
  for (const id of geo) if (id < lo) lo = id;
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
  // Round, don't truncate: with a fractional X scale the products carry
  // float error (2879.9999...), and the napi int cast would truncate a
  // pixel off the window.
  const cw = Math.round(w);
  const ch = Math.round(h);
  addon.xwmConfigureWindow(window, cx, cy, cw, ch);
  addon.xwmSendConfigureNotify(window, cx, cy, cw, ch);
}
