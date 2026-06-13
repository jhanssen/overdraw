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
// Re-emission on output change: not wired today (the single output is
// constant). state.outputs is the integration seam: when a future
// reconfiguration path updates an OutputRecord, this module would walk
// bound xdg_output_v1 resources for that wl_output and re-emit the
// changed properties + done. Not built; the data is constant.

import { signature as outputSig } from "#protocols-gen/zxdg_output_v1.js";
import type { ZxdgOutputManagerV1Handler } from "#protocols-gen/zxdg_output_manager_v1.js";
import type { ZxdgOutputV1Handler } from "#protocols-gen/zxdg_output_v1.js";

import type { Ctx, OutputRecord } from "./ctx.js";
import { OUTPUT_DEFAULT } from "./ctx.js";

void outputSig;

// Resolve the output the client's wl_output resource refers to. Today
// every wl_output resource maps to OUTPUT_DEFAULT (single output). When
// multi-output lands, this becomes a Map<wl_output resource, outputId>
// populated at wl_output bind time.
function outputFor(ctx: Ctx, _wlOutput: unknown): OutputRecord | null {
  return ctx.state.outputs?.get(OUTPUT_DEFAULT) ?? null;
}

export default function makeXdgOutputManager(ctx: Ctx): ZxdgOutputManagerV1Handler {
  return {
    destroy(_resource) {
      // Destructor. Existing xdg_output_v1 objects survive (per spec).
    },
    get_xdg_output(_manager, id, output) {
      const rec = outputFor(ctx, output);
      if (!rec) return;
      // Send the identity + geometry. v3 sends them at creation; the same
      // set is re-sent whenever the output changes (not wired today).
      ctx.events.zxdg_output_v1.send_logical_position(
        id, rec.logicalPosition.x, rec.logicalPosition.y);
      ctx.events.zxdg_output_v1.send_logical_size(
        id, rec.logicalSize.width, rec.logicalSize.height);
      ctx.events.zxdg_output_v1.send_name(id, rec.name);
      ctx.events.zxdg_output_v1.send_description(id, rec.description);
      // The xdg_output_v1.done event is deprecated since v3 but compositors
      // must still emit it for v1/v2 clients.
      ctx.events.zxdg_output_v1.send_done(id);
    },
  };
}

export function makeXdgOutput(_ctx: Ctx): ZxdgOutputV1Handler {
  return {
    destroy(_resource) {
      // Destructor: trampoline handles teardown. No per-resource state
      // tracked today.
    },
  };
}
