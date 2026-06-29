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
// invalid_axis / invalid_axis_source are posted (via ctx.addon.postError) when
// an axis/axis_source enum is out of range.

import type { ZwlrVirtualPointerManagerV1Handler } from "#protocols-gen/zwlr_virtual_pointer_manager_v1.js";
import type { ZwlrVirtualPointerV1Handler } from "#protocols-gen/zwlr_virtual_pointer_v1.js";
import { ZwlrVirtualPointerV1_Error } from "#protocols-gen/zwlr_virtual_pointer_v1.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";
import { resolveOutputArg } from "./output-resolve.js";

// wl_pointer.axis: vertical_scroll(0) / horizontal_scroll(1). Anything else is
// a protocol error.
function validAxis(ctx: Ctx, resource: Resource, axis: number): boolean {
  if (axis === 0 || axis === 1) return true;
  ctx.addon.postError(resource, ZwlrVirtualPointerV1_Error.invalid_axis, "invalid axis");
  return false;
}

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

// Logical rect of a single output by id, or null if unknown.
function outputRectById(ctx: Ctx, id: number): { x: number; y: number; w: number; h: number } | null {
  const o = ctx.state.outputs?.get(id);
  if (!o) return null;
  return { x: o.logicalPosition.x, y: o.logicalPosition.y, w: o.logicalSize.width, h: o.logicalSize.height };
}

// The rect motion_absolute maps into for this virtual pointer: the output it was
// created with (create_virtual_pointer_with_output), else the whole union.
function absoluteRect(ctx: Ctx, resource: Resource): { x: number; y: number; w: number; h: number } | null {
  const outId = resource.__vpOutputId as number | null | undefined;
  if (outId != null) return outputRectById(ctx, outId);
  return outputBounds(ctx);
}

export default function makeVirtualPointerManager(ctx: Ctx): ZwlrVirtualPointerManagerV1Handler {
  return {
    create_virtual_pointer(_resource, _seat, id) {
      id.__vpOutputId = null;  // no output association -> motion_absolute uses the union
    },
    create_virtual_pointer_with_output(_resource, _seat, output, id) {
      // Associate the pointer with the given output so motion_absolute maps into
      // that output's rect. A null output means "no association" (union).
      id.__vpOutputId = output ? resolveOutputArg(ctx.state, output) : null;
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
    motion_absolute(resource, time, x, y, x_extent, y_extent) {
      if (x_extent === 0 || y_extent === 0) return;
      const b = absoluteRect(ctx, resource);
      const tx = b ? b.x + (x / x_extent) * b.w : x;
      const ty = b ? b.y + (y / y_extent) * b.h : y;
      inject({ type: "pointerMotion", serial: 0, time, x: tx, y: ty });
    },
    button(_resource, time, button, state) {
      inject({ type: "pointerButton", serial: 0, time, button, pressed: state === 1 });
    },
    axis(resource, time, axis, value) {
      if (!validAxis(ctx, resource, axis)) return;
      inject({ type: "pointerAxis", serial: 0, time, horizontal: axis === 1, value });
    },
    axis_discrete(resource, time, axis, value, discrete) {
      if (!validAxis(ctx, resource, axis)) return;
      // The seat carries high-resolution steps as value120 (1 detent = 120);
      // convert this protocol's whole-step `discrete` to that unit.
      inject({ type: "pointerAxis", serial: 0, time, horizontal: axis === 1, value, value120: discrete * 120 });
    },
    frame(_resource) {
      inject({ type: "pointerFrame", serial: 0, time: 0 });
    },
    axis_source(resource, axis_source) {
      // wl_pointer.axis_source: wheel(0)/finger(1)/continuous(2)/wheel_tilt(3).
      if (axis_source > 3) {
        ctx.addon.postError(resource, ZwlrVirtualPointerV1_Error.invalid_axis_source,
          "invalid axis_source");
        return;
      }
      inject({ type: "pointerAxisSource", serial: 0, time: 0, axisSource: axis_source });
    },
    axis_stop(resource, time, axis) {
      if (!validAxis(ctx, resource, axis)) return;
      inject({ type: "pointerAxisStop", serial: 0, time, horizontal: axis === 1 });
    },
    destroy(_resource) {
      // No per-object state to release.
    },
  };
}
