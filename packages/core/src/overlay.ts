// Overlay broker: the core half of createOverlay (architecture.md "First plugin
// milestone"). A plugin declares intent (layer + anchor + size); the core decides
// the authoritative rect (placeOverlay, output-clamped), assigns a surface id,
// places it in the requested stack layer, and returns the granted geometry. The
// plugin then populates the surface's buffer ring (the producer/consumer
// primitive) -- that allocation/render half lands in C-M4; this module owns the
// geometry + layer registration, which is GPU-free and unit-testable.
//
// Surface ids share the compositor's monotonic id space (state.serial()) so the
// sink's per-surface maps don't collide with wl_surface ids.

import type { CompositorState, Layer } from "./protocols/ctx.js";
import { placeOverlay } from "./overlay-position.js";
import type { OverlayRequest, Rect, Output } from "./overlay-position.js";
import { rebuildLayerStack } from "./layer-stack.js";

// A layer an overlay may target. `content` is reserved for client/plugin windows
// (owned by the WM stack), so overlays choose a non-content layer.
export type OverlayLayer = Exclude<Layer, "content">;

export interface OverlayHandle {
  surfaceId: number;
  layer: OverlayLayer;
  rect: Rect;
  pluginId: string;
}

export interface CreateOverlayParams extends OverlayRequest {
  layer: OverlayLayer;
}

export interface OverlayBroker {
  // Plugin requests an overlay; core decides geometry + registers it in the layer.
  create(pluginId: string, params: CreateOverlayParams): OverlayHandle;
  // Register a surface at an EXPLICIT rect on a layer (no placeOverlay/clamp). The
  // caller already decided the geometry -- output-anchored overlays pass an explicit
  // rect. reflow() leaves these fixed (they are window-relative, not output-anchored).
  createAt(pluginId: string, layer: OverlayLayer, rect: Rect): OverlayHandle;
  // Register a WINDOW-BOUND surface at an explicit rect (decorations). Assigns a
  // surface id + sets its layout in the compositor map, and tracks it for teardown
  // (destroy / plugin death), but does NOT place it on any flat layer: its z-order
  // is owned by the WM stack (computeBaseStack splices it directly below its
  // window's content). reflow() leaves it fixed (it is window-relative).
  createWindowBound(pluginId: string, rect: Rect): OverlayHandle;
  // Remove one overlay (plugin destroyed it or the plugin died).
  destroy(surfaceId: number): void;
  // Remove every overlay owned by a plugin (plugin termination).
  destroyForPlugin(pluginId: string): void;
  // Recompute every overlay's rect against a (possibly new) output size and
  // re-push layout. Called on output resize (when that lands).
  reflow(output: Output): void;
  // Introspection (tests / query channel).
  list(): OverlayHandle[];
}

export function createOverlayBroker(state: CompositorState, output: Output): OverlayBroker {
  // Insertion-ordered overlays; per-layer order = insertion order within a layer.
  // `req` is the anchor request (for reflow); absent for explicit-rect surfaces
  // (createAt), which reflow leaves fixed.
  const overlays = new Map<number, OverlayHandle & { req?: CreateOverlayParams; windowBound?: boolean }>();
  let out = { width: output.width, height: output.height };

  // Per-layer ordered ids contributed by this broker. Published on the state
  // so the unified layer-stack rebuild can merge it with layer-shell surfaces.
  // Window-bound surfaces (decorations) sit in the WM stack instead, so they
  // are excluded here.
  function layerIds(layer: OverlayLayer): number[] {
    const ids: number[] = [];
    for (const o of overlays.values()) if (!o.windowBound && o.layer === layer) ids.push(o.surfaceId);
    return ids;
  }
  state.overlayLayerIds = layerIds;

  function pushLayer(layer: OverlayLayer): void {
    rebuildLayerStack(state, layer);
  }

  return {
    create(pluginId, params) {
      const rect = placeOverlay(params, out);
      const surfaceId = state.serial();
      const handle: OverlayHandle & { req: CreateOverlayParams } = {
        surfaceId, layer: params.layer, rect, pluginId, req: params,
      };
      overlays.set(surfaceId, handle);
      // Geometry to the sink now; the producer fills pixels later (C-M4).
      state.compositor.setSurfaceLayout(surfaceId, rect.x, rect.y, rect.width, rect.height);
      pushLayer(params.layer);
      return { surfaceId, layer: params.layer, rect, pluginId };
    },

    createAt(pluginId, layer, rect) {
      const surfaceId = state.serial();
      const handle: OverlayHandle & { req?: CreateOverlayParams } = {
        surfaceId, layer, rect: { ...rect }, pluginId,   // no req -> reflow skips it
      };
      overlays.set(surfaceId, handle);
      state.compositor.setSurfaceLayout(surfaceId, rect.x, rect.y, rect.width, rect.height);
      pushLayer(layer);
      return { surfaceId, layer, rect: { ...rect }, pluginId };
    },

    createWindowBound(pluginId, rect) {
      const surfaceId = state.serial();
      const handle: OverlayHandle & { windowBound: true } = {
        // `layer` is nominal here (window-bound surfaces are never pushed to a flat
        // layer); the WM stack owns the z-order. No `req` -> reflow skips it.
        surfaceId, layer: "below", rect: { ...rect }, pluginId, windowBound: true,
      };
      overlays.set(surfaceId, handle);
      // Layout only; no pushLayer (the WM stack places it via computeBaseStack).
      state.compositor.setSurfaceLayout(surfaceId, rect.x, rect.y, rect.width, rect.height);
      return { surfaceId, layer: "below", rect: { ...rect }, pluginId };
    },

    destroy(surfaceId) {
      const o = overlays.get(surfaceId);
      if (!o) return;
      overlays.delete(surfaceId);
      state.compositor.removeSurface(surfaceId);
      // Window-bound surfaces aren't on a flat layer; the WM rebuild drops the id
      // when its window's decorationSurfaceId is cleared. Flat overlays re-push here.
      if (!o.windowBound) pushLayer(o.layer);
    },

    destroyForPlugin(pluginId) {
      const affected = new Set<OverlayLayer>();
      for (const [id, o] of overlays) {
        if (o.pluginId !== pluginId) continue;
        affected.add(o.layer);
        overlays.delete(id);
        state.compositor.removeSurface(id);
      }
      for (const layer of affected) pushLayer(layer);
    },

    reflow(output) {
      out = { width: output.width, height: output.height };
      for (const o of overlays.values()) {
        if (!o.req) continue;   // explicit-rect surface (createAt): leave fixed
        o.rect = placeOverlay(o.req, out);
        state.compositor.setSurfaceLayout(o.surfaceId, o.rect.x, o.rect.y, o.rect.width, o.rect.height);
      }
    },

    list() {
      return [...overlays.values()].map((o) =>
        ({ surfaceId: o.surfaceId, layer: o.layer, rect: o.rect, pluginId: o.pluginId }));
    },
  };
}
