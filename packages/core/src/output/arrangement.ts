// Output arrangement: where each output sits in the global logical coordinate
// space. Physical placement cannot be inferred, so the authoritative source is
// user config (multi-output-design §10); this module currently provides only
// the deterministic fallback used for an output the user has not arranged.

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
