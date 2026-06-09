// Cubic-bezier easing evaluation for tween animations. Mirrors the CSS
// cubic-bezier(x1, y1, x2, y2) curve with anchor points (0,0) and (1,1).
// The math is standard: given progress t in [0,1] (normalized time), the
// curve's x-coordinate is a cubic in a parameter `s` in [0,1]; we solve
// for s such that bezierX(s) = t, then return bezierY(s).
//
// The Newton-Raphson + bisection fallback approach is from the WebKit /
// Blink implementations; it converges in ~4 iterations for in-range
// curves. Not implemented from scratch -- this is the standard well-
// known algorithm (core-plugin-api.md "don't experiment").
//
// Easing maps a NORMALIZED progress (0..1 = duration elapsed) to an
// eased progress (0..1 = how far through the value range). At t=0 the
// curve passes through (0,0); at t=1 through (1,1). Out-of-range t is
// clamped at the call site.

import type { CubicBezier, EasingSpec } from "@overdraw/animation-types";

// CSS preset curves (https://drafts.csswg.org/css-easing-1/#valdef-easing-function-ease).
const PRESETS: Record<string, CubicBezier> = {
  ease:        { kind: "cubic-bezier", x1: 0.25, y1: 0.1,  x2: 0.25, y2: 1.0 },
  "ease-in":   { kind: "cubic-bezier", x1: 0.42, y1: 0.0,  x2: 1.0,  y2: 1.0 },
  "ease-out":  { kind: "cubic-bezier", x1: 0.0,  y1: 0.0,  x2: 0.58, y2: 1.0 },
  "ease-in-out": { kind: "cubic-bezier", x1: 0.42, y1: 0.0, x2: 0.58, y2: 1.0 },
};

export function resolveEasing(spec: EasingSpec | undefined): EasingFn {
  if (spec === undefined || spec === "linear") return linear;
  if (typeof spec === "string") {
    const preset = PRESETS[spec];
    if (!preset) {
      throw new Error(`unknown easing preset '${spec}'`);
    }
    return bezier(preset.x1, preset.y1, preset.x2, preset.y2);
  }
  if (spec.kind === "cubic-bezier") {
    return bezier(spec.x1, spec.y1, spec.x2, spec.y2);
  }
  throw new Error("unknown easing spec");
}

export type EasingFn = (t: number) => number;

function linear(t: number): number { return t; }

// Build a cubic-bezier ease(t) closure. Captures pre-computed polynomial
// coefficients so each ease() call avoids re-deriving them.
function bezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  // Polynomial form of cubic Bezier with anchors (0,0) and (1,1):
  //   B(t) = 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3
  //        = c*t + b*t^2 + a*t^3
  // where:
  //   c = 3 * P1
  //   b = 3 * (P2 - P1) - c     = 3 * P2 - 6 * P1
  //   a = 1 - c - b             = 1 - 3 * P2 + 3 * P1
  // Per dimension.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const sampleDerivX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  // Solve sampleX(s) == x for s in [0,1].
  function solve(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton-Raphson: 4 iterations is typically enough.
    let s = x;
    for (let i = 0; i < 4; i++) {
      const d = sampleDerivX(s);
      if (Math.abs(d) < 1e-6) break;
      const xs = sampleX(s) - x;
      s -= xs / d;
    }
    // Fallback bisection if Newton overshot out of [0,1].
    if (s < 0 || s > 1) {
      let lo = 0, hi = 1;
      s = x;
      for (let i = 0; i < 32; i++) {
        const xs = sampleX(s);
        if (Math.abs(xs - x) < 1e-7) return s;
        if (xs < x) lo = s; else hi = s;
        s = (lo + hi) / 2;
      }
    }
    return s;
  }

  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solve(t));
  };
}
