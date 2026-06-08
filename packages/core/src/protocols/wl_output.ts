// wl_output: advertises the (single, phase-1) output. Clients like foot abort if
// no monitor is present, and use geometry/mode/scale to size themselves. We send
// one output matching the compositor's logical size at scale 1 on bind.

import { signature as outSig } from "#protocols-gen/wl_output.js";
import type { WlOutputHandler } from "#protocols-gen/wl_output.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

const SUBPIXEL_UNKNOWN = outSig.enums.subpixel.entries.unknown;
const TRANSFORM_NORMAL = outSig.enums.transform.entries.normal;
const MODE_CURRENT = outSig.enums.mode.entries.current;
const MODE_PREFERRED = outSig.enums.mode.entries.preferred;

// `bind` is a synthetic on-bind hook, not a protocol request.
type OutputHandler = WlOutputHandler & { bind(resource: Resource): void };

export default function makeOutput(ctx: Ctx): OutputHandler {
  const out = ctx.state.wm?.state.output ?? { width: 1920, height: 1080 };
  return {
    bind(resource) {
      // Physical size in mm is unknown nested; report 0 (compositors do this).
      ctx.events.wl_output.send_geometry(
        resource, 0, 0, 0, 0, SUBPIXEL_UNKNOWN, "overdraw", "overdraw-0", TRANSFORM_NORMAL);
      ctx.events.wl_output.send_mode(
        resource, MODE_CURRENT | MODE_PREFERRED, out.width, out.height, 60000);
      ctx.events.wl_output.send_scale(resource, 1);
      ctx.events.wl_output.send_name(resource, "overdraw-0");
      ctx.events.wl_output.send_description(resource, "overdraw nested output");
      ctx.events.wl_output.send_done(resource);
    },
    release(_resource) {},
  };
}
