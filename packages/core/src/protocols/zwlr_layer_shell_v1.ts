// zwlr_layer_shell_v1 + zwlr_layer_surface_v1: surfaces in named layers of
// the desktop (status bars, wallpapers, app launchers, notifications). Both
// interfaces live here because the layer-surface role state is created at
// get_layer_surface and torn down at the same lifetime boundary.
//
// State pipeline:
//   - get_layer_surface assigns the role + creates LayerSurfaceRecord with
//     default applied state. The first configure is DEFERRED to the client's
//     initial wl_surface.commit (mirrors the xdg_surface initial-commit flow
//     in wl_surface.ts).
//   - set_size / set_anchor / set_margin / set_exclusive_zone /
//     set_keyboard_interactivity / set_layer / set_exclusive_edge accumulate
//     into rec.pending (double-buffered per spec). Validation that requires
//     no surrounding context (range checks) runs at the request; cross-field
//     validation (invalid_exclusive_edge against the applied anchor, size==0
//     vs opposite-edge anchors) runs at commit.
//   - On wl_surface.commit: applyLayerSurfacePending merges pending into
//     applied, re-runs layer-shell-position.placeLayerSurface against the
//     current effectiveRect, updates the reserved-zone registry, sends a new
//     configure if the rect changed, and re-pushes layer placement on the
//     compositor.
//
// Reserved-zone reflow: changes to a layer surface's zone affect OTHER
// zone==0 layer surfaces (which place themselves against the effective
// rect). Any apply triggers reflowAllLayerSurfaces() to re-place every
// other layer surface against the current effective rect.
//
// Protocol-error post: not wired in this compositor today (status.md "Read
// first" notes the gap; cursor_shape / seat handlers also silent-drop on
// errors that the spec defines). Each silent-drop site below is commented
// with the spec error the call WOULD raise. wlr-style post_error is a
// separate future change.

import { signature as shellSig } from "#protocols-gen/zwlr_layer_shell_v1.js";
import { signature as surfaceSig } from "#protocols-gen/zwlr_layer_surface_v1.js";
import type { ZwlrLayerShellV1Handler } from "#protocols-gen/zwlr_layer_shell_v1.js";
import type { ZwlrLayerSurfaceV1Handler } from "#protocols-gen/zwlr_layer_surface_v1.js";

import type {
  Ctx,
  CompositorState,
  LayerSurfaceRecord,
  LayerShellLayer,
  LayerShellKeyboardInteractivity,
} from "./ctx.js";
import { OUTPUT_DEFAULT } from "./ctx.js";
import type { Resource } from "../types.js";

import {
  placeLayerSurface,
  resolveExclusiveEdge,
  computeReservedThickness,
  isValidAnchor,
  ANCHOR_TOP, ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT,
} from "./layer-shell-position.js";

import { rebuildLayerStack, protocolLayerToCompositorLayer } from "../layer-stack.js";
import { configurePopup } from "./xdg_popup.js";

// ---- helpers --------------------------------------------------------------

const LAYER_ENUM = shellSig.enums.layer.entries;        // background/bottom/top/overlay -> uint
const KBI_ENUM = surfaceSig.enums.keyboard_interactivity.entries;

function layerFromInt(v: number): LayerShellLayer | null {
  if (v === LAYER_ENUM.background) return "background";
  if (v === LAYER_ENUM.bottom) return "bottom";
  if (v === LAYER_ENUM.top) return "top";
  if (v === LAYER_ENUM.overlay) return "overlay";
  return null;
}

function kbiFromInt(v: number): LayerShellKeyboardInteractivity | null {
  if (v === KBI_ENUM.none) return "none";
  if (v === KBI_ENUM.exclusive) return "exclusive";
  if (v === KBI_ENUM.on_demand) return "on_demand";
  return null;
}

function defaultApplied(layer: LayerShellLayer): LayerSurfaceRecord["applied"] {
  return {
    width: 0, height: 0,
    anchor: 0,
    exclusiveZone: 0,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    keyboardInteractivity: "none",
    layer,
    exclusiveEdge: 0,
  };
}

// Resolve the `output` arg of get_layer_surface to a target outputId.
// NULL / no binding / unknown all collapse to the primary; a resource that
// was bound through this server resolves via the tracked-resources reverse
// walk. wlOutputResources is Map<outputId, Set<Resource>>, so the reverse is
// O(N_outputs * resources_per_output) -- both small.
function resolveOutputArg(state: CompositorState, output: unknown): number {
  const primary = primaryOutputId(state);
  if (output === null || output === undefined) return primary;
  const tracked = state.wlOutputResources;
  if (!tracked) return primary;
  for (const [outputId, set] of tracked) {
    if (set.has(output as import("../types.js").Resource)) return outputId;
  }
  return primary;
}

// The lowest live outputId, used as the "primary" fallback when an output arg
// is missing or unrecognized. Mirrors the WM's primaryOutputId so layer-shell
// and the WM agree on which output is "the default."
function primaryOutputId(state: CompositorState): number {
  if (state.wm) return state.wm.primaryOutputId();
  // Pre-WM (or GPU-free fixtures without one): fall back to the outputs map's
  // lowest key, then to OUTPUT_DEFAULT if nothing is registered yet.
  if (state.outputs && state.outputs.size > 0) {
    let lo = Infinity;
    for (const id of state.outputs.keys()) if (id < lo) lo = id;
    if (lo !== Infinity) return lo;
  }
  return OUTPUT_DEFAULT;
}

// The output rect the named layer surface targets, in global logical
// coordinates. Falls back to a sensible default when no OutputRecord exists
// (a GPU-free harness that never ran setOnOutputDescriptor) so the placement
// math has something to operate against.
function outputRectFor(state: CompositorState, outputId: number): { x: number; y: number; width: number; height: number } {
  const rec = state.outputs?.get(outputId);
  if (rec) {
    return {
      x: rec.logicalPosition.x, y: rec.logicalPosition.y,
      width: rec.logicalSize.width, height: rec.logicalSize.height,
    };
  }
  return { x: 0, y: 0, width: 1920, height: 1080 };
}

// Effective rect for a layer surface: its target output minus every OTHER
// layer surface's currently-registered reservation on that output. A surface
// does not see its own reservation in its effective rect (so updating zone
// in place doesn't make the surface shrink itself out of existence).
function effectiveRectExcluding(state: CompositorState, exclude: LayerSurfaceRecord): { x: number; y: number; width: number; height: number } {
  const raw = outputRectFor(state, exclude.output);
  if (!state.reservedZones) return raw;
  const myId = exclude.reservedZoneId;
  if (!myId) return state.reservedZones.effectiveRect(exclude.output, raw);
  // Temporarily drop this surface's reservation, compute, restore. Avoid
  // allocating a fresh registry: snapshot the surface's zone, clear it,
  // compute, restore.
  const zones = state.reservedZones.list(exclude.output).filter((z) => z.owner === exclude.surface.id);
  for (const z of zones) state.reservedZones.clear(`${myId}`);
  const r = state.reservedZones.effectiveRect(exclude.output, raw);
  for (const z of zones) state.reservedZones.set(myId, z);
  return r;
}

// ---- per-record apply ----------------------------------------------------

// Merge pending into applied, compute the new rect, update the reserved-zone
// registry, send a configure if size changed, push the compositor layout, and
// reflow other layer surfaces. Returns true when something changed worth
// triggering a WM relayout.
function applyLayerSurface(ctx: Ctx, rec: LayerSurfaceRecord, opts: { firstConfigure: boolean }): boolean {
  const state = ctx.state;
  if (rec.destroyed) return false;

  // Merge pending into applied. undefined = not set this cycle.
  const p = rec.pending;
  const next = { ...rec.applied };
  if (p.width !== undefined) next.width = p.width;
  if (p.height !== undefined) next.height = p.height;
  if (p.anchor !== undefined) next.anchor = p.anchor;
  if (p.exclusiveZone !== undefined) next.exclusiveZone = p.exclusiveZone;
  if (p.margin !== undefined) next.margin = { ...p.margin };
  if (p.keyboardInteractivity !== undefined) next.keyboardInteractivity = p.keyboardInteractivity;
  if (p.layer !== undefined) next.layer = p.layer;
  if (p.exclusiveEdge !== undefined) next.exclusiveEdge = p.exclusiveEdge;

  // Validate set_exclusive_edge against the (newly-applied) anchor. Per spec
  // this is invalid_exclusive_edge; silent-drop convention applies. We still
  // clear the field so the resolver doesn't pick a stale one.
  if (next.exclusiveEdge !== 0) {
    const r = resolveExclusiveEdge(next.anchor, next.exclusiveEdge);
    if ("error" in r) {
      // Would post zwlr_layer_surface_v1.invalid_exclusive_edge.
      next.exclusiveEdge = 0;
    }
  }

  rec.applied = next;
  rec.pending = {};

  // Compute placement against the appropriate base rect.
  const outputRect = outputRectFor(state, rec.output);
  const effective = effectiveRectExcluding(state, rec);
  const placement = placeLayerSurface({
    outputRect, effectiveRect: effective,
    width: next.width, height: next.height,
    anchor: next.anchor,
    margin: next.margin,
    exclusiveZone: next.exclusiveZone,
  });
  // placement.error === 'invalid_size' would post invalid_size; silent-drop
  // convention. We still install the clamped rect so a buggy client doesn't
  // see NaN.
  const prevRect = rec.rect;
  rec.rect = placement.rect;

  // Reserved-zone registry: keep it in sync with the applied state.
  updateReservedZone(state, rec);

  // Push the surface layout to the compositor. This applies even for an
  // unmapped surface (first commit hasn't happened yet); subsequent
  // map-on-first-content uses the layout already in place.
  state.compositor.setSurfaceLayout(
    rec.surface.id, placement.rect.x, placement.rect.y,
    placement.rect.width, placement.rect.height);

  // Send a configure when:
  //   - this is the first configure (deferred from get_layer_surface), OR
  //   - the placement size changed.
  const sizeChanged = !prevRect
    || prevRect.width !== placement.rect.width
    || prevRect.height !== placement.rect.height;
  if (opts.firstConfigure || sizeChanged) {
    sendConfigure(ctx, rec, placement.rect.width, placement.rect.height);
  }

  return true;
}

// Compute the reservation thickness + edge from the applied state and update
// state.reservedZones accordingly. Clears the zone when the surface no longer
// reserves (zone<=0, ambiguous anchor combination, or after destroy).
function updateReservedZone(state: CompositorState, rec: LayerSurfaceRecord): void {
  if (!state.reservedZones) return;
  const a = rec.applied;
  const myId = rec.reservedZoneId ?? `layer-shell-${rec.surface.id}`;
  rec.reservedZoneId = myId;

  if (rec.destroyed || a.exclusiveZone <= 0) {
    state.reservedZones.clear(myId);
    return;
  }
  const r = resolveExclusiveEdge(a.anchor, a.exclusiveEdge);
  if (r.edge === null) {
    state.reservedZones.clear(myId);
    return;
  }
  const thickness = computeReservedThickness(a.exclusiveZone);
  if (thickness === 0) {
    state.reservedZones.clear(myId);
    return;
  }
  state.reservedZones.set(myId, {
    outputId: rec.output,
    edge: r.edge,
    thickness,
    owner: rec.surface.id,
  });
}

// Re-place every layer surface OTHER than `changed` against the new effective
// rect. Called after a change to `changed`'s reservation so siblings (notably
// zone==0 surfaces) re-shrink/grow as appropriate.
function reflowOtherLayerSurfaces(ctx: Ctx, changed: LayerSurfaceRecord): void {
  const state = ctx.state;
  const others = state.layerSurfaces;
  if (!others) return;
  for (const rec of others.values()) {
    if (rec === changed || rec.destroyed) continue;
    const outputRect = outputRectFor(state, rec.output);
    const effective = effectiveRectExcluding(state, rec);
    const placement = placeLayerSurface({
      outputRect, effectiveRect: effective,
      width: rec.applied.width, height: rec.applied.height,
      anchor: rec.applied.anchor,
      margin: rec.applied.margin,
      exclusiveZone: rec.applied.exclusiveZone,
    });
    const prev = rec.rect;
    rec.rect = placement.rect;
    state.compositor.setSurfaceLayout(
      rec.surface.id, placement.rect.x, placement.rect.y,
      placement.rect.width, placement.rect.height);
    // If a sibling's size changed, send it a fresh configure too.
    if (!prev || prev.width !== placement.rect.width || prev.height !== placement.rect.height) {
      sendConfigure(ctx, rec, placement.rect.width, placement.rect.height);
    }
  }
}

// Send zwlr_layer_surface_v1.configure(serial, w, h) and record the serial.
function sendConfigure(ctx: Ctx, rec: LayerSurfaceRecord, w: number, h: number): void {
  const serial = ctx.state.serial();
  rec.lastConfigureSerial = serial;
  rec.configuredWidth = w;
  rec.configuredHeight = h;
  rec.acked = false;
  ctx.events.zwlr_layer_surface_v1.send_configure(rec.resource, serial, w, h);
}

// ---- entry points used by wl_surface.commit ------------------------------

// True if this commit is the initial commit for a layer-surface (the spec's
// "commit without a buffer to obtain the first configure"). Mirrors the
// xdg_surface initial-commit detection in wl_surface.ts.
export function isLayerSurfaceInitialCommit(rec: LayerSurfaceRecord): boolean {
  return rec.lastConfigureSerial === null;
}

// Drive the first configure: applies the accumulated pending state and sends
// a sized configure the client must ack before attaching a buffer.
export function applyLayerSurfaceInitial(ctx: Ctx, rec: LayerSurfaceRecord): void {
  applyLayerSurface(ctx, rec, { firstConfigure: true });
  reflowOtherLayerSurfaces(ctx, rec);
  triggerWmRelayout(ctx.state);
}

// Drive a subsequent apply (any commit after the initial). Doesn't necessarily
// send a configure -- only when the rect actually changed.
export function applyLayerSurfacePending(ctx: Ctx, rec: LayerSurfaceRecord): void {
  applyLayerSurface(ctx, rec, { firstConfigure: false });
  reflowOtherLayerSurfaces(ctx, rec);
  triggerWmRelayout(ctx.state);
  // Keyboard interactivity may have just changed; let the seat re-evaluate
  // the exclusive override. Cheap when nothing is exclusive (an O(n) walk
  // of layer surfaces with no allocations).
  ctx.state.seat?.reevaluateExclusiveLayerFocus();
}

// Called when a layer surface gains presentable content (first
// buffer-bearing commit was uploaded). Mirrors the WM's
// windowHasContent semantically: marks rec.mapped and pushes the
// layer stack so the compositor draws it.
export function markLayerSurfaceMapped(state: CompositorState, rec: LayerSurfaceRecord): void {
  if (rec.mapped || rec.destroyed) return;
  rec.mapped = true;
  rebuildLayerStack(state, protocolLayerToCompositorLayer(rec.applied.layer));
  // A newly-mapped exclusive surface forces focus to itself.
  state.seat?.reevaluateExclusiveLayerFocus();
}

// Teardown for a wl_surface or zwlr_layer_surface_v1 destruction. Idempotent:
// safe to call from the explicit destroy AND from the wl_surface unmap sweep.
export function teardownLayerSurface(state: CompositorState, rec: LayerSurfaceRecord): void {
  if (rec.destroyed) return;
  rec.destroyed = true;
  // Clear reserved zone.
  if (rec.reservedZoneId && state.reservedZones) {
    state.reservedZones.clear(rec.reservedZoneId);
    rec.reservedZoneId = undefined;
  }
  // Drop popups parented to this layer surface. A layer-parented popup whose
  // parent disappears cannot meaningfully render; the spec doesn't formalize
  // dismissal in this direction, but a stale popup with a dangling layer
  // parent would draw at the old rect indefinitely. Drop it.
  if (state.popups) {
    for (const pr of state.popups.values()) {
      if (pr.layerParent !== rec) continue;
      pr.layerParent = null;
      pr.mapped = false;
    }
  }
  // Drop from registries.
  state.layerSurfaces?.delete(rec.resource);
  state.layerSurfacesBySurface?.delete(rec.surface.resource);
  // Push the compositor layer (drops the id).
  rebuildLayerStack(state, protocolLayerToCompositorLayer(rec.applied.layer));
  // Other layer surfaces may have placed themselves against this surface's
  // reservation; reflow them.
  reflowOtherLayerSurfacesForTeardown(state, rec);
  triggerWmRelayout(state);
  // The exclusive set may have just shrunk; re-evaluate so focus reverts
  // to whatever the focus driver chooses next.
  state.seat?.reevaluateExclusiveLayerFocus();
}

// Variant used at teardown when there's no ctx available (called from the
// generic wl_surface unmap sweep). Replays the apply math against the now-
// reduced reservation set; doesn't send configures (each surviving surface's
// own configure cadence handles that on its next commit).
function reflowOtherLayerSurfacesForTeardown(state: CompositorState, changed: LayerSurfaceRecord): void {
  const others = state.layerSurfaces;
  if (!others) return;
  for (const rec of others.values()) {
    if (rec === changed || rec.destroyed) continue;
    const outputRect = outputRectFor(state, rec.output);
    const effective = effectiveRectExcluding(state, rec);
    const placement = placeLayerSurface({
      outputRect, effectiveRect: effective,
      width: rec.applied.width, height: rec.applied.height,
      anchor: rec.applied.anchor,
      margin: rec.applied.margin,
      exclusiveZone: rec.applied.exclusiveZone,
    });
    rec.rect = placement.rect;
    state.compositor.setSurfaceLayout(
      rec.surface.id, placement.rect.x, placement.rect.y,
      placement.rect.width, placement.rect.height);
  }
}

// Trigger a WM layout pass: the tile region just changed, so tiled and
// maximized windows need to reflow. The WM is unaware of layer-shell; we
// reach the layout driver through the WM's schedule API by addWindow/unmap
// no-ops. A direct relayout-schedule hook would be cleaner; for now reach
// in via the wm interface a generic schedule isn't exposed -- so we trigger
// it by setting + clearing a no-op state? Inspect the API:
//
// The Wm interface (wm/index.ts) exposes addWindow/unmapWindow/propose etc.
// All of those eventually call driver.schedule(reason). There is no public
// schedule(reason) on Wm. Easiest: rebuild via the existing rebuild() hook
// the wm uses (state.compositor.setStack is pushed via rebuildStackWithPopups
// the WM holds). But that won't re-run the LAYOUT.
//
// For now: if the WM exposes a schedule via its driver we can't reach here,
// so we use a small indirection: the wm.state.windows list is exactly what
// we'd ask the driver to recompute; calling something that bumps a no-op
// rebuild won't re-run compute. So we use an explicit relayout function
// added on state -- it's set by installProtocols when wiring T6.
function triggerWmRelayout(state: CompositorState): void {
  state.relayout?.("reserved-zones-changed");
}

// ---- handler factories ---------------------------------------------------

export default function makeLayerShell(ctx: Ctx): ZwlrLayerShellV1Handler {
  return {
    get_layer_surface(_resource, id, surface, output, layer, namespace) {
      const state = ctx.state;
      const s = state.surfaces.get(surface);
      if (!s) return; // surface already destroyed; nothing to roll back on

      // role error: wl_surface already has a role.
      // Would post zwlr_layer_shell_v1.role.
      if (s.role !== null) return;

      // already_constructed error: wl_surface has a buffer attached or
      // committed. Would post zwlr_layer_shell_v1.already_constructed.
      if (s.hasContent || s.committed.buffer || s.pending.buffer) return;

      // invalid_layer error: layer arg outside the enum range.
      // Would post zwlr_layer_shell_v1.invalid_layer.
      const layerStr = layerFromInt(layer);
      if (!layerStr) return;

      // `output` arg: NULL (or unbound) = compositor chooses the primary;
      // otherwise the resource is reverse-looked-up to its outputId via the
      // tracked wl_output bindings. An unknown resource (e.g. a wl_output the
      // client never bound through this server) collapses to the primary.
      const outputId = resolveOutputArg(state, output);

      const rec: LayerSurfaceRecord = {
        resource: id,
        surface: s,
        output: outputId,
        namespace,
        pending: {},
        applied: defaultApplied(layerStr),
        lastConfigureSerial: null,
        configuredWidth: 0,
        configuredHeight: 0,
        acked: false,
        mapped: false,
        destroyed: false,
      };
      s.role = "layer_surface";
      s.layerSurface = rec;

      state.layerSurfaces ??= new Map();
      state.layerSurfaces.set(id, rec);
      state.layerSurfacesBySurface ??= new Map();
      state.layerSurfacesBySurface.set(s.resource, rec);

      // Do NOT send a configure here. The first configure is held until the
      // client's initial wl_surface.commit; the wl_surface.commit hook calls
      // applyLayerSurfaceInitial then.
    },
    destroy(_resource) {
      // The shell global itself: per spec, destroying the shell does not
      // affect created layer_surfaces.
    },
  };
}

export function makeLayerSurface(ctx: Ctx): ZwlrLayerSurfaceV1Handler {
  const rec = (resource: Resource): LayerSurfaceRecord | undefined =>
    ctx.state.layerSurfaces?.get(resource);

  return {
    set_size(resource, width, height) {
      const r = rec(resource);
      if (!r) return;
      // Width / height are uint in the wire; accept verbatim. The size==0
      // axis + opposite-edge anchor check runs at commit (cross-field).
      r.pending.width = width >>> 0;
      r.pending.height = height >>> 0;
    },
    set_anchor(resource, anchor) {
      const r = rec(resource);
      if (!r) return;
      if (!isValidAnchor(anchor)) {
        // Would post invalid_anchor (silent-drop convention; see top of file).
        return;
      }
      r.pending.anchor = anchor;
    },
    set_exclusive_zone(resource, zone) {
      const r = rec(resource);
      if (!r) return;
      // zone is signed (int). -1 = extend over reservations; 0 = avoid;
      // >0 = reserve. The placeLayerSurface + resolveExclusiveEdge math
      // honors all three modes.
      r.pending.exclusiveZone = zone | 0;
    },
    set_margin(resource, top, right, bottom, left) {
      const r = rec(resource);
      if (!r) return;
      r.pending.margin = { top: top | 0, right: right | 0, bottom: bottom | 0, left: left | 0 };
    },
    set_keyboard_interactivity(resource, mode) {
      const r = rec(resource);
      if (!r) return;
      const m = kbiFromInt(mode);
      if (!m) {
        // Would post invalid_keyboard_interactivity.
        return;
      }
      r.pending.keyboardInteractivity = m;
    },
    get_popup(resource, popup) {
      const r = rec(resource);
      if (!r) return;
      const pr = ctx.state.popups?.get(popup);
      if (!pr) return;
      // Spec: the popup must have been created via xdg_surface.get_popup
      // with NULL parent. A non-null xdg parent is a protocol violation.
      // Silent-drop convention (no post_error path; see zwlr_layer_shell_v1
      // file header).
      if (pr.parent !== null) return;
      pr.layerParent = r;
      // xdg_surface.get_popup deferred its configure (no resolvable origin
      // until now). Send it now that the layer parent is in place.
      configurePopup(ctx, pr);
    },
    ack_configure(resource, serial) {
      const r = rec(resource);
      if (!r) return;
      if (serial === r.lastConfigureSerial) r.acked = true;
    },
    destroy(resource) {
      const r = rec(resource);
      if (r) teardownLayerSurface(ctx.state, r);
    },
    set_layer(resource, layer) {
      const r = rec(resource);
      if (!r) return;
      const l = layerFromInt(layer);
      if (!l) {
        // Would post invalid_layer (the shell-level error -- the layer-
        // surface inherits its meaning; silent-drop).
        return;
      }
      r.pending.layer = l;
    },
    set_exclusive_edge(resource, edge) {
      const r = rec(resource);
      if (!r) return;
      // edge validity vs the anchor is checked at commit (the anchor may
      // be set later in the same commit batch).
      r.pending.exclusiveEdge = edge | 0;
    },
  };
}
