// zwlr_virtual_pointer_manager_v1 + zwlr_virtual_pointer_v1: lets a client
// inject synthetic pointer input (a "virtual" pointer device). Used by software
// KVMs (lan-mouse) on the RECEIVING machine. Each request is turned into a
// normalized InputEvent and fed through addon.injectInput -- the same sink the
// host seat uses -- so synthetic motion/buttons/scroll drive the cursor and
// reach the focused client exactly like real input.
//
// motion is RELATIVE (dx,dy already in logical pixels via the wl_fixed decode);
// it is added to the seat's current pointer position and injected as an
// absolute motion, clamped to the output union so the cursor can't escape every
// output. motion_absolute maps the client's (x,y)/(x_extent,y_extent) fraction
// across the output union (single global cursor; the output hint is accepted but
// not used for a per-output mapping).
//
// Protocol-error post is not wired in this compositor (see the
// zwlr_layer_shell_v1 header); invalid_axis / invalid_axis_source are
// silent-dropped.

import type { ZwlrVirtualPointerManagerV1Handler } from "#protocols-gen/zwlr_virtual_pointer_manager_v1.js";
import type { ZwlrVirtualPointerV1Handler } from "#protocols-gen/zwlr_virtual_pointer_v1.js";
import type { Ctx } from "./ctx.js";

// Bounding box of all known outputs in logical (output-space) coords, or null
// when none are known (GPU-free harness) -- in which case motion is left
// unclamped.
function outputBounds(ctx: Ctx): { x: number; y: number; w: number; h: number } | null {
  const outs = ctx.state.outputs;
  if (!outs || outs.size === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of outs.values()) {
    const { x, y } = o.logicalPosition;
    const { width, height } = o.logicalSize;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function clampToOutputs(ctx: Ctx, x: number, y: number): { x: number; y: number } {
  const b = outputBounds(ctx);
  if (!b) return { x, y };
  return {
    x: Math.min(Math.max(x, b.x), b.x + b.w),
    y: Math.min(Math.max(y, b.y), b.y + b.h),
  };
}

export default function makeVirtualPointerManager(_ctx: Ctx): ZwlrVirtualPointerManagerV1Handler {
  return {
    create_virtual_pointer(_resource, _seat, _id) {
      // The new zwlr_virtual_pointer_v1 resource dispatches to the child handler
      // below by interface; no per-object state is needed.
    },
    create_virtual_pointer_with_output(_resource, _seat, _output, _id) {
      // Output hint accepted but unused (single global cursor).
    },
    destroy(_resource) {
      // Destroying the manager does not affect created virtual pointers.
    },
  };
}

export function makeVirtualPointer(ctx: Ctx): ZwlrVirtualPointerV1Handler {
  const inject = (ev: Parameters<Ctx["addon"]["injectInput"]>[0]): void => ctx.addon.injectInput(ev);
  return {
    motion(_resource, time, dx, dy) {
      const p = ctx.state.seat?.pointerPosition() ?? { x: 0, y: 0 };
      const t = clampToOutputs(ctx, p.x + dx, p.y + dy);
      inject({ type: "pointerMotion", serial: 0, time, x: t.x, y: t.y });
    },
    motion_absolute(_resource, time, x, y, x_extent, y_extent) {
      if (x_extent === 0 || y_extent === 0) return;
      const b = outputBounds(ctx);
      const tx = b ? b.x + (x / x_extent) * b.w : x;
      const ty = b ? b.y + (y / y_extent) * b.h : y;
      inject({ type: "pointerMotion", serial: 0, time, x: tx, y: ty });
    },
    button(_resource, time, button, state) {
      inject({ type: "pointerButton", serial: 0, time, button, pressed: state === 1 });
    },
    axis(_resource, time, axis, value) {
      inject({ type: "pointerAxis", serial: 0, time, horizontal: axis === 1, value });
    },
    axis_discrete(_resource, time, axis, value, discrete) {
      inject({ type: "pointerAxis", serial: 0, time, horizontal: axis === 1, value, discrete });
    },
    frame(_resource) {
      inject({ type: "pointerFrame", serial: 0, time: 0 });
    },
    axis_source(_resource, _axisSource) {
      // The normalized InputEvent has no axis-source field; no-op.
    },
    axis_stop(_resource, _time, _axis) {
      // No axis-stop in the normalized InputEvent model; no-op.
    },
    destroy(_resource) {
      // No per-object state to release.
    },
  };
}
