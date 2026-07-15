// M7 hotplug handlers (factored out of main.ts for isolated unit testing).
//
// makeOnOutputAdded / makeOnOutputRemoved return the callbacks registered via
// addon.setOnOutputAdded / addon.setOnOutputRemoved. They orchestrate the
// JS-side reaction to a GPU-process hotplug event:
//
//   OutputAdded   create state.outputs entry -> wl_output global ->
//                 reserveScanoutForOutput -> push to compositor/WM/input ->
//                 residency / fractional re-emit -> output.added bus event.
//
//   OutputRemoved output.pre-remove bus event (workspace migration, etc.,
//                 with state.outputs[outputId] still present) ->
//                 strip from compositor/WM/input -> wl_surface.leave via
//                 residency diff -> destroy wl_output global ->
//                 state.outputs.delete -> output.removed bus event ->
//                 releaseScanoutForOutput.
//
// Both pipelines call pushOutputs (compositor.setOutputs + WM.setOutputs +
// addon.updateOutputLayout) so the surviving set is mirrored everywhere
// before residency diffs run. The compositor's outputsGeom must drop the
// removed output before updateAllSurfaceResidency, or the diff cannot
// produce the wl_surface.leave for it (the resource is gone the moment we
// destroyGlobalForOutput, so the leave must fire BEFORE that).

import type { Addon, OutputDescriptor } from "../types.js";
import type { CompositorState, OutputRecord } from "../protocols/ctx.js";
import type { CompositorSink } from "../protocols/ctx.js";
import { JsCompositor } from "../gpu/compositor.js";
import { resolveScale, logicalSize } from "./scale.js";
import { nextOutputPosition, durableKeyOf } from "./arrangement.js";
import { makeOutputForOutput } from "../protocols/wl_output.js";
import { updateAllSurfaceResidency } from "../protocols/surface-residency.js";
import { reemitFractionalScale } from "../protocols/wp_fractional_scale_manager_v1.js";

export interface HotplugDeps {
  addon: Addon;
  state: CompositorState;
  compositor: CompositorSink;
  pluginBus: { emit: (name: string, payload: Record<string, unknown>) => void };
  // Scale comes from the user config (null/undefined = unset, fall back to
  // EDID-DPI auto-scale when allowEdidAutoScale).
  config: { scale?: number | null };
  // Whether to allow the EDID-DPI auto-scale fallback. KMS mode only -- a
  // nested host's physical dims describe the host monitor, not the render
  // target. Caller resolves this once from backendOpts.backend === "kms".
  allowEdidAutoScale: boolean;
  // Logging hooks. Defaults to no-op so tests don't need to mock; the live
  // wiring in main.ts passes the log module.
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

// Push the current state.outputs snapshot to every layer that mirrors it:
// the JsCompositor's per-output geometry, the input backend's pointer
// layout, the WM's output rects. Shared between hotplug add/remove and
// the wlr-output-management apply path (any source that mutates an
// output's position or scale calls this, then schedules relayout +
// residency diff).
export function pushOutputsToLayers(deps: {
  addon: Addon;
  state: CompositorState;
  compositor: CompositorSink;
}): void {
  const { addon, state, compositor } = deps;
  const outputs = state.outputs;
  if (!outputs) return;
  if (compositor instanceof JsCompositor && compositor.setOutputs) {
    compositor.setOutputs([...outputs.values()].map((r) => ({
      id: r.id,
      deviceWidth: r.deviceSize.width, deviceHeight: r.deviceSize.height,
      logicalX: r.logicalPosition.x, logicalY: r.logicalPosition.y,
      scale: r.scale,
    })));
  }
  addon.updateOutputLayout([...outputs.values()].map((r) => ({
    x: r.logicalPosition.x, y: r.logicalPosition.y,
    w: r.logicalSize.width, h: r.logicalSize.height,
  })));
  state.wm?.setOutputs([...outputs.values()].map((r) => ({
    id: r.id,
    rect: {
      x: r.logicalPosition.x, y: r.logicalPosition.y,
      width: r.logicalSize.width, height: r.logicalSize.height,
    },
    scale: r.scale,
  })));
}

export function makeOnOutputAdded(deps: HotplugDeps): (d: OutputDescriptor) => void {
  return (d) => {
    const { addon, state, pluginBus, config, allowEdidAutoScale } = deps;
    const outputs = state.outputs;
    if (!outputs) return;
    const device = { width: d.width, height: d.height };
    // Durable identifier the memory maps key on. Same precedence the
    // workspace plugin uses (edidId first, name fallback).
    const durable = durableKeyOf({ edidId: d.edidId, name: d.name });
    // Scale precedence: explicit config scale wins (handled inside
    // resolveScale); else memorized scale from a prior set_scale or
    // config.byKey; else EDID-DPI auto / 1.
    const memorizedScale = durable !== ""
      ? state.outputScaleMemory?.get(durable) ?? null : null;
    const scale = resolveScale({
      configScale: config.scale ?? memorizedScale,
      deviceWidth: device.width, deviceHeight: device.height,
      physicalWidthMm: d.physicalWidthMm, physicalHeightMm: d.physicalHeightMm,
      allowEdidAuto: allowEdidAutoScale,
    });
    const logical = logicalSize(device.width, device.height, scale);
    // Position precedence: memorized position (config or prior set_position)
    // wins; else the deterministic right-of-rightmost fallback.
    const memorizedPos = durable !== ""
      ? state.outputPositionMemory?.get(durable) : undefined;
    const pos = memorizedPos ?? nextOutputPosition(outputs.values());

    // Dense id reuse without a paired OutputRemoved is a contract violation
    // upstream. The design (§3) allows reuse only after a remove. Warn and
    // tear down the stale entry so the layers don't drift; the rest of the
    // add path then proceeds as if the id were brand new.
    if (outputs.has(d.outputId)) {
      deps.log?.warn(
        `OutputAdded for outputId=${d.outputId} already present; tearing down stale entry`);
      addon.destroyGlobalForOutput("wl_output", d.outputId);
      outputs.delete(d.outputId);
    }

    const rec: OutputRecord = {
      id: d.outputId,
      logicalPosition: pos,
      logicalSize: logical,
      deviceSize: device,
      scale,
      name: d.name,
      description: d.model || d.name,
      refreshMhz: d.refreshMhz,
      transform: d.transform,
      physicalWidthMm: d.physicalWidthMm,
      physicalHeightMm: d.physicalHeightMm,
      make: d.make,
      model: d.model,
      edidId: d.edidId,
    };
    outputs.set(d.outputId, rec);

    if (state.events) {
      addon.createGlobalForOutput(
        "wl_output", d.outputId,
        makeOutputForOutput({ events: state.events, state, addon }, d.outputId),
      );
    }

    // Finish the GPU bring-up handshake (KMS only; addon no-ops on nested).
    // acquireOutputTextureHandle returns null for this outputId until the
    // ring is built, so renders for this output skip until ready.
    addon.reserveScanoutForOutput(d.outputId, device.width, device.height);

    deps.log?.info(
      `output ${d.outputId} added at (${pos.x},${pos.y}): ${device.width}x${device.height} `
      + `device, ${logical.width}x${logical.height} logical name=${d.name}`);

    pushOutputsToLayers(deps);
    state.relayout?.("output-added");

    // Surfaces may now overlap the new output -- enter / primary shift.
    updateAllSurfaceResidency(state, addon);

    pluginBus.emit("output.added", {
      outputId: d.outputId,
      name: d.name,
      edidId: d.edidId,
      x: pos.x,
      y: pos.y,
      width: logical.width,
      height: logical.height,
      scale,
      refreshMhz: d.refreshMhz,
    });
  };
}

export function makeOnOutputRemoved(deps: HotplugDeps): (d: { outputId: number }) => void {
  return ({ outputId }) => {
    const { addon, state, pluginBus } = deps;
    const outputs = state.outputs;
    if (!outputs) return;
    const rec = outputs.get(outputId);
    if (!rec) {
      deps.log?.warn(`OutputRemoved for unknown outputId=${outputId}; ignoring`);
      return;
    }
    const name = rec.name;

    // 1. Synchronous bus subscribers -- workspace plugin migrates, anyone
    //    else reading the durable identifier of the dying output gets it
    //    here. state.outputs[outputId] is still present.
    pluginBus.emit("output.pre-remove", { outputId, name, edidId: rec.edidId });

    // 2. Strip X from the data-driven layers. wl_output X still exists in
    //    the trampoline so wl_surface.leave (next step) can reference it.
    outputs.delete(outputId);
    pushOutputsToLayers(deps);
    state.relayout?.("output-removed");

    // 3. Diff surface-output residency against the surviving set; surfaces
    //    that previously overlapped X now produce wl_surface.leave on X's
    //    bound wl_output resource. Fractional scale re-emits for surfaces
    //    whose primary just shifted.
    updateAllSurfaceResidency(state, addon);
    reemitFractionalScale(state);

    // 4. Drop X's wl_output global. Clients see wl_registry.global_remove.
    //    Any bound wl_output Resource continues to exist until the client
    //    destroys it (resource-level lifetime).
    addon.destroyGlobalForOutput("wl_output", outputId);
    state.wlOutputResources?.delete(outputId);

    // 5. Post-teardown subscribers (e.g. plugin bookkeeping that needs the
    //    output already gone).
    pluginBus.emit("output.removed", { outputId, name, edidId: rec.edidId });

    // 6. Release the core-side scanout state. Any in-flight present for X
    //    has already failed (compositor.acquireOutputTextureHandle returns
    //    null for unknown outputIds), so this is the last cleanup.
    addon.releaseScanoutForOutput(outputId);

    deps.log?.info(`output ${outputId} removed (name=${name})`);
  };
}
