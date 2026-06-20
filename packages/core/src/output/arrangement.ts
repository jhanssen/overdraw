// Output arrangement: where each output sits in the global logical coordinate
// space. Physical placement cannot be inferred, so the authoritative source is
// user config + the wlr-output-management protocol (multi-output-design §10).
// This module supplies:
//   - the deterministic fallback (right of the rightmost output, top-aligned)
//     used when an output isn't otherwise arranged; and
//   - the durable identifier helpers used by per-output memory maps.

import type { OutputRecord } from "../protocols/ctx.js";

// Place an as-yet-unarranged output against the right edge of the current
// rightmost output, top-aligned. Keeps outputs from overlapping at the origin
// before user-declared arrangement is applied. With no existing outputs the
// result is the origin.
export function nextOutputPosition(
  outputs: Iterable<OutputRecord>,
): { x: number; y: number } {
  let x = 0;
  for (const o of outputs) {
    x = Math.max(x, o.logicalPosition.x + o.logicalSize.width);
  }
  return { x, y: 0 };
}

// Resolve an OutputRecord (or pre-record descriptor) to its durable string
// identifier. EDID-derived id takes precedence (survives port swaps);
// connector name is the fallback. Same precedence the workspace plugin's
// preferredOutputs list uses (multi-output-design §3). Returns "" when the
// caller has neither -- the caller should drop memory lookups in that case.
export function durableKeyOf(rec: { edidId: string; name: string }): string {
  return rec.edidId !== "" ? rec.edidId : rec.name;
}

// Format an integer milli-Hz refresh value as a human-readable Hz string
// with three fractional digits (e.g. 143981 -> "143.981Hz"). The wire
// carries integer mHz to match wl_output.mode.refresh's protocol spec, but
// logs are easier to read in Hz. Zero stays "0Hz" (no fractional pad) so
// the "unknown refresh" case doesn't masquerade as 0.000Hz precision.
export function formatRefreshHz(refreshMhz: number): string {
  if (refreshMhz === 0) return "0Hz";
  const whole = Math.floor(refreshMhz / 1000);
  const milli = refreshMhz % 1000;
  return `${whole}.${milli.toString().padStart(3, "0")}Hz`;
}
