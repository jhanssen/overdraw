// wl_output: one global per output. Each global has its own bind
// handler tagged with its outputId; on bind, the handler emits that
// output's geometry/mode/scale/name/done burst and registers the resource
// against state.wlOutputResources[outputId].
//
// Re-emission: when an output reconfigures (host-window resize, KMS mode
// change), reemitWlOutput() walks the bound-resource set for that outputId
// and resends the same burst with the new values. Per spec the events are
// not delta; the full set is resent and `done` is the atomic-commit signal.
// main.ts hooks this to bus.emit('output.changed').

import { signature as outSig } from "#protocols-gen/wl_output.js";
import type { WlOutputHandler } from "#protocols-gen/wl_output.js";
import type { Ctx, CompositorState, OutputRecord } from "./ctx.js";
import { OUTPUT_DEFAULT } from "./ctx.js";
import type { Resource } from "../types.js";

const SUBPIXEL_UNKNOWN = outSig.enums.subpixel.entries.unknown;
const MODE_CURRENT = outSig.enums.mode.entries.current;
const MODE_PREFERRED = outSig.enums.mode.entries.preferred;

// `bind` is a synthetic on-bind hook, not a protocol request.
type OutputHandler = WlOutputHandler & { bind(resource: Resource): void };

// Bound wl_output resources live on state.wlOutputResources (state-scoped,
// not module-level) so tests + multiple compositor instances stay
// independent. Populated on bind, scrubbed lazily during re-emit
// (resource.destroyed check) and on release.
function trackedSet(state: CompositorState, outputId: number): Set<Resource> {
  if (!state.wlOutputResources) state.wlOutputResources = new Map();
  let set = state.wlOutputResources.get(outputId);
  if (!set) { set = new Set<Resource>(); state.wlOutputResources.set(outputId, set); }
  return set;
}

function emitTo(
  events: import("../types.js").EventsByInterface,
  resource: Resource,
  out: OutputRecord,
): void {
  events.wl_output.send_geometry(
    resource,
    out.logicalPosition.x, out.logicalPosition.y,
    out.physicalWidthMm, out.physicalHeightMm,
    SUBPIXEL_UNKNOWN,
    out.make, out.model,
    out.transform);
  // wl_output.mode is in device pixels (the real scanout mode); the logical
  // size is conveyed via scale (here) and xdg_output.logical_size. wl_output
  // scale is an integer, so a fractional scale advertises its ceiling --
  // fractional-aware clients use wp_fractional_scale_v1 for the exact value.
  events.wl_output.send_mode(
    resource, MODE_CURRENT | MODE_PREFERRED,
    out.deviceSize.width, out.deviceSize.height,
    out.refreshMhz);
  // Gate version-since events on the resource's bound version.
  // wl_output v1 clients (e.g. `grim`) have no listener entries past
  // opcode 1 (mode); sending opcode 2+ trips a libwayland-client
  // NULL-listener assertion that SIGABRTs the client. v2 added
  // scale + done; v4 added name + description.
  if (resource.version >= 2) {
    events.wl_output.send_scale(resource, Math.ceil(out.scale));
  }
  if (resource.version >= 4) {
    events.wl_output.send_name(resource, out.name);
    events.wl_output.send_description(resource, out.description);
  }
  if (resource.version >= 2) {
    events.wl_output.send_done(resource);
  }
}

function fallback(state: CompositorState): OutputRecord {
  // Defensive fallback: if state.outputs is somehow empty (GPU-free harness
  // that skipped the registry seed), advertise something matching the WM's
  // primary output size so clients don't abort.
  const primary = state.wm?.primaryOutputId();
  const wmOut = primary !== undefined ? state.wm?.state.outputs.get(primary) : undefined;
  const size = wmOut
    ? { width: wmOut.rect.width, height: wmOut.rect.height }
    : { width: 1920, height: 1080 };
  return {
    id: OUTPUT_DEFAULT,
    logicalPosition: { x: 0, y: 0 },
    logicalSize: size,
    deviceSize: size,
    scale: 1,
    name: "overdraw-0",
    description: "overdraw output",
    refreshMhz: 60000,
    transform: 0,
    physicalWidthMm: 0,
    physicalHeightMm: 0,
    make: "overdraw",
    model: "overdraw output",
    edidId: "",
  };
}

// Resolve a wl_output resource back to its outputId. Walks the tracked
// set; outputs are few, so the cost is negligible. Returns null if the
// resource is unknown (destroyed / never bound on this state).
export function outputIdForWlOutput(state: CompositorState, resource: Resource):
  number | null
{
  const tracked = state.wlOutputResources;
  if (!tracked) return null;
  for (const [outputId, set] of tracked) {
    if (set.has(resource)) return outputId;
  }
  return null;
}

// Re-emit the full event burst to every bound wl_output resource for the
// given output id. Destroyed resources are removed from the tracking set
// in-line. Silent no-op if state.events isn't populated yet (e.g. mid-
// bring-up before installProtocols finishes) or if no resources are bound.
export function reemitWlOutput(state: CompositorState, outputId: number): void {
  const set = state.wlOutputResources?.get(outputId);
  if (!set || set.size === 0) return;
  if (!state.events) return;
  const rec = state.outputs?.get(outputId) ?? fallback(state);
  for (const resource of [...set]) {
    if (resource.destroyed) { set.delete(resource); continue; }
    emitTo(state.events, resource, rec);
  }
}

// Build a per-output bind handler. installProtocols calls this once per
// outputId in state.outputs and passes the result to
// addon.createGlobalForOutput("wl_output", outputId, handler). On bind, the
// handler tracks the resource against this output's id and emits the full
// burst sourced from state.outputs[outputId] (or the fallback when missing).
export function makeOutputForOutput(ctx: Ctx, outputId: number): OutputHandler {
  return {
    bind(resource) {
      trackedSet(ctx.state, outputId).add(resource);
      const rec = ctx.state.outputs?.get(outputId) ?? fallback(ctx.state);
      emitTo(ctx.events, resource, rec);
    },
    release(resource) {
      // wl_output.release is the v3+ destructor request. Drop tracking; the
      // trampoline handles libwayland teardown.
      ctx.state.wlOutputResources?.get(outputId)?.delete(resource);
    },
  };
}

// Default export retained for the request-handler registry (wl_output has
// only `release`, which is per-resource and outputId-independent). The
// registerInterface path uses this; the per-output bind handlers from
// makeOutputForOutput route over their own globals via createGlobalForOutput.
export default function makeOutput(ctx: Ctx): WlOutputHandler {
  return {
    release(resource) {
      // Walk every tracked set to find which output owns the resource. Cheap;
      // outputs are few. Mirrors makeOutputForOutput.release so the request
      // dispatch path doesn't need to know which global the resource came from.
      const tracked = ctx.state.wlOutputResources;
      if (!tracked) return;
      for (const set of tracked.values()) {
        if (set.delete(resource)) return;
      }
    },
  };
}
