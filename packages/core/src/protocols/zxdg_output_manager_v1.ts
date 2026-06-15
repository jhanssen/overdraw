// zxdg_output_manager_v1 / zxdg_output_v1: a side-channel on wl_output that
// reports the output's logical position, logical size, name, and
// description. Carries the same identity wl_output v4 already advertises
// (name + description); xdg-output is the path clients that want this data
// without requiring wl_output v4 use. waybar specifically binds it at
// startup and refuses to run when the global is absent.
//
// On get_xdg_output(wl_output): send name, description, logical_position,
// logical_size, then done. Per v3 of the spec the xdg_output `done` event
// is deprecated in favor of wl_output.done, but compositors "must still
// support" emitting it -- and we do here so v1/v2 clients see the
// atomicity signal they expect.
//
// Re-emission: when state.outputs is updated, reemitXdgOutput() walks the
// bound xdg_output_v1 resources for that output and re-emits the full set
// + done. main.ts hooks this to bus.emit('output.changed').

import { signature as outputSig } from "#protocols-gen/zxdg_output_v1.js";
import type { ZxdgOutputManagerV1Handler } from "#protocols-gen/zxdg_output_manager_v1.js";
import type { ZxdgOutputV1Handler } from "#protocols-gen/zxdg_output_v1.js";

import type { Ctx, CompositorState, OutputRecord } from "./ctx.js";
import { OUTPUT_DEFAULT } from "./ctx.js";
import type { Resource } from "../types.js";

void outputSig;

// Resolve the output the client's wl_output resource refers to. Today
// every wl_output resource maps to OUTPUT_DEFAULT (single output). When
// multi-output lands, this becomes a Map<wl_output resource, outputId>
// populated at wl_output bind time.
function outputFor(ctx: Ctx, _wlOutput: unknown): OutputRecord | null {
  return ctx.state.outputs?.get(OUTPUT_DEFAULT) ?? null;
}

// Bound xdg_output_v1 resources live on state.xdgOutputResources (state-
// scoped, not module-level) so tests + multiple compositor instances stay
// independent. Populated by get_xdg_output, scrubbed lazily during re-emit
// (resource.destroyed check) and by destroy.
function trackedSet(state: CompositorState, outputId: number): Set<Resource> {
  if (!state.xdgOutputResources) state.xdgOutputResources = new Map();
  let set = state.xdgOutputResources.get(outputId);
  if (!set) { set = new Set<Resource>(); state.xdgOutputResources.set(outputId, set); }
  return set;
}

function emitTo(
  events: import("../types.js").EventsByInterface,
  resource: Resource,
  rec: OutputRecord,
): void {
  events.zxdg_output_v1.send_logical_position(
    resource, rec.logicalPosition.x, rec.logicalPosition.y);
  events.zxdg_output_v1.send_logical_size(
    resource, rec.logicalSize.width, rec.logicalSize.height);
  events.zxdg_output_v1.send_name(resource, rec.name);
  events.zxdg_output_v1.send_description(resource, rec.description);
  events.zxdg_output_v1.send_done(resource);
}

// Re-emit the full event burst to every bound xdg_output_v1 resource for
// the given output id. Destroyed resources are removed from the tracking
// set in-line. Silent no-op if state.events isn't populated yet (mid-bringup).
export function reemitXdgOutput(state: CompositorState, outputId: number): void {
  const set = state.xdgOutputResources?.get(outputId);
  if (!set || set.size === 0) return;
  if (!state.events) return;
  const rec = state.outputs?.get(outputId);
  if (!rec) return;
  for (const resource of [...set]) {
    if (resource.destroyed) { set.delete(resource); continue; }
    emitTo(state.events, resource, rec);
  }
}

export default function makeXdgOutputManager(ctx: Ctx): ZxdgOutputManagerV1Handler {
  return {
    destroy(_resource) {
      // Destructor. Existing xdg_output_v1 objects survive (per spec).
    },
    get_xdg_output(_manager, id, output) {
      const rec = outputFor(ctx, output);
      if (!rec) return;
      trackedSet(ctx.state, rec.id).add(id);
      emitTo(ctx.events, id, rec);
      // GTK <= 4.22 derives the monitor scale as wl_output mode size /
      // xdg_output logical size, but recomputes it ONLY on wl_output.done.
      // wl_output.done was already sent at bind -- before this xdg_output's
      // logical_size existed -- so that computation divided by a zero logical
      // size (-> a bogus scale_factor, then a scale-0 surface that crashes
      // toolkits). Re-send wl_output.done now, after the logical_size, so the
      // client recomputes with a valid logical size. send_done is the output's
      // atomic-commit signal and is safe to repeat.
      ctx.events.wl_output.send_done(output);
    },
  };
}

export function makeXdgOutput(ctx: Ctx): ZxdgOutputV1Handler {
  return {
    destroy(resource) {
      // Drop from every tracking set we own. Cheap: at most a few entries.
      const all = ctx.state.xdgOutputResources;
      if (!all) return;
      for (const set of all.values()) set.delete(resource);
    },
  };
}
