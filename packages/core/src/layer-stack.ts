// Unified push for the compositor's non-content layers (background / below /
// above / overlay). Two producers write into the same destination:
//   - overlay broker (plugin overlays + decorations on flat layers),
//   - zwlr_layer_surface_v1 surfaces.
// Without a merger, the last writer to setLayerSurfaces(layer, ids) wins and
// the other set vanishes; this module merges them so a single push per layer
// contains both.
//
// Per-layer ordering: overlay-broker ids first (drawn behind), then layer-
// shell ids. Layer-shell is the "user content for this layer" (panels,
// wallpapers); overlay-broker is compositor chrome (a plugin's status
// banner, a decoration accent line). Within each source, insertion order.

import type { CompositorState, Layer, LayerShellLayer } from "./protocols/ctx.js";

// Protocol layers (zwlr_layer_shell_v1.layer enum: background / bottom / top
// / overlay) and compositor layers (background / below / content / above /
// overlay) differ on the middle two names. Convert at the boundary.
export function protocolLayerToCompositorLayer(layer: LayerShellLayer): Exclude<Layer, "content"> {
  switch (layer) {
    case "background": return "background";
    case "bottom": return "below";
    case "top": return "above";
    case "overlay": return "overlay";
  }
}

// The non-content layers, in the order the compositor draws them.
const NON_CONTENT_LAYERS: ReadonlyArray<Exclude<Layer, "content">> =
  ["background", "below", "above", "overlay"];

// Accessor a producer publishes on `state` so the rebuild can read its
// per-layer ordered list. The overlay broker installs `overlayLayerIds`;
// the layer-shell handler reads its surfaces directly from
// `state.layerSurfaces` so it doesn't need a separate accessor.
export interface LayerStackProducers {
  overlayLayerIds?: (layer: Exclude<Layer, "content">) => number[];
}

// Compute the merged ordered id list for one compositor layer.
function computeLayerIds(state: CompositorState, layer: Exclude<Layer, "content">): number[] {
  const ids: number[] = [];
  const overlayIds = state.overlayLayerIds?.(layer);
  if (overlayIds) ids.push(...overlayIds);
  if (state.layerSurfaces) {
    for (const rec of state.layerSurfaces.values()) {
      if (!rec.mapped || rec.destroyed) continue;
      if (protocolLayerToCompositorLayer(rec.applied.layer) !== layer) continue;
      ids.push(rec.surface.id);
    }
  }
  return ids;
}

// Push the merged list for one layer (or every layer when `layer` is
// undefined). Called by both the overlay broker and the layer-shell handler
// after they mutate their respective sets.
export function rebuildLayerStack(state: CompositorState, layer?: Exclude<Layer, "content">): void {
  const set = layer ? [layer] : NON_CONTENT_LAYERS;
  for (const l of set) {
    state.compositor.setLayerSurfaces?.(l, computeLayerIds(state, l));
  }
}
