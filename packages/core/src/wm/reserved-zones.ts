// Reserved-zone registry. Tracks regions of an output that should be
// excluded from the layout's tile region and from `maximized` windows --
// the working area shrinks by these zones.
//
// Per-output, edge-anchored bands. The shape was chosen for the layer-shell
// case (status bars, docks anchored to a screen edge); arbitrary
// floating exclusion zones are not supported (would require constraint-
// solving rather than simple subtraction).
//
// No consumer exists today. The registry is in place so `maximized` and
// the layout plugin's tile region both use `effectiveRect()` from day one;
// layer-shell drops in by calling `set` / `clear`.

import type { Rect } from "@overdraw/layout-types";

export type Edge = "top" | "right" | "bottom" | "left";

export interface ReservedZone {
  outputId: number;
  edge: Edge;
  thickness: number;   // px; clamped non-negative
  // Conventionally a layer-shell anchored surface's id; the owner uses
  // it to update or remove the zone.
  owner: number;
}

export interface ReservedZoneRegistry {
  // Install or replace the zone identified by `zoneId`. Multiple zones
  // can coexist on the same edge -- their thicknesses sum.
  set(zoneId: string, zone: ReservedZone): void;
  // Remove the zone. Idempotent.
  clear(zoneId: string): void;
  // Output rect minus all zones for that output, clamped non-negative.
  // When no zones are registered for the output, returns outputRect
  // unchanged.
  effectiveRect(outputId: number, outputRect: Rect): Rect;
  // Diagnostic: enumerate zones for an output. Returned in insertion order.
  list(outputId: number): ReadonlyArray<ReservedZone>;
}

export function createReservedZoneRegistry(): ReservedZoneRegistry {
  const zones = new Map<string, ReservedZone>();

  return {
    set(zoneId, zone) {
      zones.set(zoneId, {
        outputId: zone.outputId,
        edge: zone.edge,
        thickness: Math.max(0, zone.thickness | 0),
        owner: zone.owner,
      });
    },
    clear(zoneId) {
      zones.delete(zoneId);
    },
    effectiveRect(outputId, outputRect) {
      let top = 0, right = 0, bottom = 0, left = 0;
      for (const z of zones.values()) {
        if (z.outputId !== outputId) continue;
        switch (z.edge) {
          case "top": top += z.thickness; break;
          case "right": right += z.thickness; break;
          case "bottom": bottom += z.thickness; break;
          case "left": left += z.thickness; break;
        }
      }
      const x = outputRect.x + left;
      const y = outputRect.y + top;
      const width = Math.max(0, outputRect.width - left - right);
      const height = Math.max(0, outputRect.height - top - bottom);
      return { x, y, width, height };
    },
    list(outputId) {
      const out: ReservedZone[] = [];
      for (const z of zones.values()) {
        if (z.outputId === outputId) out.push(z);
      }
      return out;
    },
  };
}
