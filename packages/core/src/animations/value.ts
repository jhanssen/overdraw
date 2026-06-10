// Value coercion + interpolation + writing for the three target kinds.
// Each kind has an identity (default value) and a per-field set of
// numeric components. Tween and spring operate on numeric components;
// the writers package the components back into the CompositorSink
// setters' shapes.

import type { CompositorSink } from "../protocols/ctx.js";
import type { TargetRef } from "@overdraw/animation-types";

// Field names per target kind (in canonical order). The evaluator
// stores per-animation arrays of field values aligned with this order.
const TRANSFORM_FIELDS = ["translateX", "translateY", "scaleX", "scaleY"] as const;
const MARGIN_FIELDS = ["top", "right", "bottom", "left"] as const;

// Identity component values: what missing fields default to.
const TRANSFORM_IDENTITY: Record<typeof TRANSFORM_FIELDS[number], number> = {
  translateX: 0, translateY: 0, scaleX: 1, scaleY: 1,
};
const MARGIN_IDENTITY: Record<typeof MARGIN_FIELDS[number], number> = {
  top: 0, right: 0, bottom: 0, left: 0,
};

// Coerce a from/to value into an ordered numeric array per target kind.
// For window-opacity: a single-element array. For transform / margin:
// canonical-order field values with identity defaults filled in.
// Throws on shape mismatch.
export function coerceValue(target: TargetRef, value: unknown): number[] {
  if (target.kind === "window-opacity") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("opacity value must be a finite number");
    }
    return [value];
  }
  if (target.kind === "window-transform") {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("transform value must be an object");
    }
    const v = value as Record<string, unknown>;
    return TRANSFORM_FIELDS.map((k) => {
      const f = v[k];
      if (f === undefined) return TRANSFORM_IDENTITY[k];
      if (typeof f !== "number" || !Number.isFinite(f)) {
        throw new TypeError(`transform.${k} must be a finite number`);
      }
      return f;
    });
  }
  if (target.kind === "window-output-margin") {
    if (typeof value !== "object" || value === null) {
      throw new TypeError("outputMargin value must be an object");
    }
    const v = value as Record<string, unknown>;
    return MARGIN_FIELDS.map((k) => {
      const f = v[k];
      if (f === undefined) return MARGIN_IDENTITY[k];
      if (typeof f !== "number" || !Number.isFinite(f) || f < 0) {
        throw new TypeError(`outputMargin.${k} must be a non-negative finite number`);
      }
      return f;
    });
  }
  throw new TypeError(`unknown target kind '${(target as { kind: string }).kind}'`);
}

// Apply a numeric component array (in canonical order) to the surface
// via the CompositorSink. Silent no-op if the sink does not implement
// the relevant setter (rejects at the broker boundary instead).
export function applyValue(
  sink: CompositorSink, target: TargetRef, components: readonly number[],
): void {
  switch (target.kind) {
    case "window-opacity":
      sink.setSurfaceOpacity?.(target.windowId, components[0] ?? 1);
      return;
    case "window-transform":
      sink.setSurfaceTransform?.(target.windowId, {
        translateX: components[0], translateY: components[1],
        scaleX: components[2], scaleY: components[3],
      });
      return;
    case "window-output-margin":
      sink.setSurfaceOutputMargin?.(target.windowId, {
        top: components[0], right: components[1],
        bottom: components[2], left: components[3],
      });
      return;
  }
}


