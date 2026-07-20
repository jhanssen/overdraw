// Reserved-zone registry. Tracks regions of an output that should be
// excluded from the layout's tile region and from `maximized` windows --
// the working area shrinks by these zones.
//
// Per-output, edge-anchored bands. The shape was chosen for the layer-shell
// case (status bars, docks anchored to a screen edge); arbitrary
// floating exclusion zones are not supported (would require constraint-
// solving rather than simple subtraction).
//
// The layout driver reads `effectiveRect()` for both the tile region and
// `maximized` windows; the layer-shell handler maintains zones via `set` /
// `clear` for anchored surfaces that declare an exclusive zone.

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
  // unchanged. `excludeOwner` skips that owner's zones -- a layer surface
  // placing itself must not see its own reservation, and reading it this
  // way keeps the computation pure (no clear/re-set churn, no spurious
  // onChange).
  effectiveRect(outputId: number, outputRect: Rect, excludeOwner?: number): Rect;
  // Diagnostic: enumerate zones for an output. Returned in insertion order.
  list(outputId: number): ReadonlyArray<ReservedZone>;
  // Notify when an output's zone picture actually changes (a set that
  // stores identical values, or a clear of an absent zone, is silent).
  // A zone migrating between outputs notifies both.
  onChange(cb: (outputId: number) => void): void;
}

export function createReservedZoneRegistry(): ReservedZoneRegistry {
  const zones = new Map<string, ReservedZone>();
  const changeCbs: Array<(outputId: number) => void> = [];
  function notify(outputId: number): void {
    for (const cb of changeCbs) cb(outputId);
  }

  return {
    set(zoneId, zone) {
      const next: ReservedZone = {
        outputId: zone.outputId,
        edge: zone.edge,
        thickness: Math.max(0, zone.thickness | 0),
        owner: zone.owner,
      };
      const prev = zones.get(zoneId);
      zones.set(zoneId, next);
      if (prev && prev.outputId === next.outputId && prev.edge === next.edge
          && prev.thickness === next.thickness && prev.owner === next.owner) {
        return;
      }
      if (prev && prev.outputId !== next.outputId) notify(prev.outputId);
      notify(next.outputId);
    },
    clear(zoneId) {
      const prev = zones.get(zoneId);
      if (!zones.delete(zoneId)) return;
      if (prev) notify(prev.outputId);
    },
    effectiveRect(outputId, outputRect, excludeOwner) {
      let top = 0, right = 0, bottom = 0, left = 0;
      for (const z of zones.values()) {
        if (z.outputId !== outputId) continue;
        if (excludeOwner !== undefined && z.owner === excludeOwner) continue;
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
    onChange(cb) {
      changeCbs.push(cb);
    },
  };
}
