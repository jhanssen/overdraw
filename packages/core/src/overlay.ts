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
import { primaryOutputId } from "./protocols/output-resolve.js";
import { placeOverlay } from "./overlay-position.js";
import type { OverlayRequest, Rect, Output } from "./overlay-position.js";
import { rebuildLayerStack } from "./layer-stack.js";
import type { DynamicBus } from "./events/dynamic-bus.js";

// A layer an overlay may target. `content` is reserved for client/plugin windows
// (owned by the WM stack), so overlays choose a non-content layer.
export type OverlayLayer = Exclude<Layer, "content">;

export interface OverlayHandle {
  surfaceId: number;
  layer: OverlayLayer;
  rect: Rect;
  pluginId: string;
  // The output an anchored overlay is placed on. null for explicit-rect and
  // window-bound surfaces (their geometry is caller-owned; no output binding).
  outputId: number | null;
}

export interface CreateOverlayParams extends OverlayRequest {
  layer: OverlayLayer;
  // Target output id; defaults to the primary output.
  output?: number;
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
  // Remove every anchored overlay bound to an output (output removal). The
  // owning plugin observes output.pre-remove/removed on the bus and drops its
  // Surface; its surface.destroy is idempotent against this.
  destroyForOutput(outputId: number): void;
  // Recompute every anchored overlay's rect against its output's CURRENT
  // geometry (from state.outputs) and re-push layout. Called when outputs are
  // added/removed/reconfigured (arrangement origins and sizes shift).
  reflow(): void;
  // Introspection (tests / query channel).
  list(): OverlayHandle[];
}

export function createOverlayBroker(state: CompositorState, output: Output): OverlayBroker {
  // Insertion-ordered overlays; per-layer order = insertion order within a layer.
  // `req` is the anchor request (for reflow); absent for explicit-rect surfaces
  // (createAt), which reflow leaves fixed.
  const overlays = new Map<number, OverlayHandle & { req?: CreateOverlayParams; windowBound?: boolean }>();
  // Fallback geometry for harnesses that never populate state.outputs (the
  // constructor caller's single-output size, at the global origin).
  const fallback = { x: 0, y: 0, width: output.width, height: output.height };

  // The target output's rect in global logical coordinates. state.outputs is
  // authoritative (arrangement origin + logical size); the constructor
  // fallback covers GPU-free harnesses.
  function outputRect(outputId: number): Required<Output> {
    const rec = state.outputs?.get(outputId);
    if (!rec) return fallback;
    return {
      x: rec.logicalPosition.x, y: rec.logicalPosition.y,
      width: rec.logicalSize.width, height: rec.logicalSize.height,
    };
  }

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
      const outputId = params.output ?? primaryOutputId(state);
      const rect = placeOverlay(params, outputRect(outputId));
      const surfaceId = state.serial();
      const handle: OverlayHandle & { req: CreateOverlayParams } = {
        surfaceId, layer: params.layer, rect, pluginId, outputId, req: params,
      };
      overlays.set(surfaceId, handle);
      // Geometry to the sink now; the producer fills pixels later (C-M4).
      state.compositor.setSurfaceLayout(surfaceId, rect.x, rect.y, rect.width, rect.height);
      pushLayer(params.layer);
      return { surfaceId, layer: params.layer, rect, pluginId, outputId };
    },

    createAt(pluginId, layer, rect) {
      const surfaceId = state.serial();
      const handle: OverlayHandle & { req?: CreateOverlayParams } = {
        surfaceId, layer, rect: { ...rect }, pluginId, outputId: null,   // no req -> reflow skips it
      };
      overlays.set(surfaceId, handle);
      state.compositor.setSurfaceLayout(surfaceId, rect.x, rect.y, rect.width, rect.height);
      pushLayer(layer);
      return { surfaceId, layer, rect: { ...rect }, pluginId, outputId: null };
    },

    createWindowBound(pluginId, rect) {
      const surfaceId = state.serial();
      const handle: OverlayHandle & { windowBound: true } = {
        // `layer` is nominal here (window-bound surfaces are never pushed to a flat
        // layer); the WM stack owns the z-order. No `req` -> reflow skips it.
        surfaceId, layer: "below", rect: { ...rect }, pluginId, outputId: null, windowBound: true,
      };
      overlays.set(surfaceId, handle);
      // Layout only; no pushLayer (the WM stack places it via computeBaseStack).
      state.compositor.setSurfaceLayout(surfaceId, rect.x, rect.y, rect.width, rect.height);
      return { surfaceId, layer: "below", rect: { ...rect }, pluginId, outputId: null };
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

    destroyForOutput(outputId) {
      const affected = new Set<OverlayLayer>();
      for (const [id, o] of overlays) {
        if (o.outputId !== outputId) continue;
        affected.add(o.layer);
        overlays.delete(id);
        state.compositor.removeSurface(id);
      }
      for (const layer of affected) pushLayer(layer);
    },

    reflow() {
      for (const o of overlays.values()) {
        if (!o.req || o.outputId === null) continue;   // explicit-rect surface: leave fixed
        o.rect = placeOverlay(o.req, outputRect(o.outputId));
        state.compositor.setSurfaceLayout(o.surfaceId, o.rect.x, o.rect.y, o.rect.width, o.rect.height);
      }
    },

    list() {
      return [...overlays.values()].map((o) =>
        ({ surfaceId: o.surfaceId, layer: o.layer, rect: o.rect, pluginId: o.pluginId, outputId: o.outputId }));
    },
  };
}

// Keep overlays coherent across output topology changes: anchored overlays on
// a removed output are dropped (the ring stays alive worker-side until the
// owning plugin -- which sees the same output.* events -- destroys its
// Surface; surface.destroy is idempotent against this), and survivors
// re-place against the new arrangement (origins shift when outputs come and
// go; sizes change on mode switches).
export function installOverlayOutputHooks(pluginBus: DynamicBus, broker: OverlayBroker): void {
  pluginBus.subscribe("output.pre-remove", (_n, raw) => {
    const p = raw as { outputId?: unknown } | undefined;
    if (!p || typeof p.outputId !== "number") return;
    broker.destroyForOutput(p.outputId);
  });
  const reflow = (): void => broker.reflow();
  pluginBus.subscribe("output.added", reflow);
  pluginBus.subscribe("output.removed", reflow);
  pluginBus.subscribe("output.changed", reflow);
}
