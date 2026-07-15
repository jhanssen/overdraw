// Windows broker: services the plugin-side sdk.windows.* requests
// (core-plugin-api.md §1). Translates `windows.*` plugin->core requests into
// WM mutations and emits the appropriate events on the typed bus + the
// dynamic bus so plugin subscribers see the change.
//
// Routed from main.ts's onRequest chain. Pure JS broker; no GPU.

import type { Wm, WindowStateProposal } from "../wm/index.js";
import type { CompositorBus } from "../events/window-bus.js";
import type { DynamicBus } from "../events/dynamic-bus.js";
import { WINDOW_EVENT } from "../events/types.js";
import type {
  WindowStateBagChangedEvent, ProposalReason, Tiling, Exclusive,
} from "../events/types.js";
import type { CompositorState, CompositorSink } from "../protocols/ctx.js";
import { rebuildStackWithPopups } from "../protocols/xdg_popup.js";
import { FOCUS_REASONS } from "@overdraw/focus-types";

const TILINGS: ReadonlyArray<Tiling> = ["managed", "floating"];
const EXCLUSIVES: ReadonlyArray<Exclusive> = ["none", "maximized", "fullscreen"];
const PROPOSAL_REASONS: ReadonlyArray<ProposalReason> = [
  "client-request", "plugin", "user-input", "window-rule", "core",
];

export interface WindowsBrokerDeps {
  wm: Wm;
  // The compositor sink, for windows.set-output-stack (overrides the
  // default stack on a specific output). Optional: when absent, the broker
  // rejects set-output-stack requests cleanly.
  compositor: CompositorSink;
  // Compositor state, for markWindowChanged (which coalesces window.change
  // emissions onto the frame boundary -- consistent with title/appId/activated
  // changes from the protocol layer).
  state: CompositorState;
  // The dynamic bus -- plugin-visible. State-bag mutations emit
  // 'window.state-changed' here (not through markWindowChanged: state-bag
  // changes are high-cardinality and not coalesced).
  pluginBus: DynamicBus;
  // The core typed bus -- markWindowChanged consults state.bus, but the broker
  // does not emit directly through it. Kept here for symmetry/extension.
  bus: CompositorBus;
  // Closing driver. The destroy-phantom path needs to cancel
  // the driver's backstop timer in addition to calling
  // compositor.destroyClosingPhantom. Optional: when absent (a
  // configuration without closing-animation support), destroy-phantom
  // still works -- it just skips the backstop-cancel step.
  closingDriver?: import("../protocols/closing-driver.js").ClosingDriver;
  // Mirror of closingDriver on the map side. The release-opening-gate
  // path cancels this driver's backstop in addition to clearing the
  // WM content gate. Optional: a configuration without opening
  // animations leaves this undefined and release-opening-gate just
  // clears the gate (no backstop to cancel; setContentGated is
  // idempotent so this is also a safe no-op when nothing was
  // engaged).
  openingDriver?: import("../protocols/opening-driver.js").OpeningDriver;
  // Intercept broker. windows.set-insets authorization checks that
  // the calling plugin owns the intercept currently assigned to the
  // target surface. Optional: when absent (a configuration without
  // intercept support), windows.set-insets always rejects.
  interceptBroker?: { pluginNameForSurface(surfaceId: number): string | undefined };
}

// The shape main.ts plugs into its onRequest chain. Returns the result for
// recognized methods; throws for malformed payloads / unknown windows; returns
// null when the method isn't a windows.* method (lets the chain fall through).
export type WindowsBroker = (
  pluginName: string, method: string, params: unknown,
) => Promise<unknown> | unknown | typeof NOT_HANDLED;

// Sentinel returned for non-windows methods so the caller knows to try the
// next handler in the chain.
export const NOT_HANDLED = Symbol("windows-broker:not-handled");

export function createWindowsBroker(deps: WindowsBrokerDeps): WindowsBroker {
  const { wm, compositor, state, pluginBus, closingDriver, openingDriver } = deps;

  return (pluginName: string, method: string, params: unknown): unknown | typeof NOT_HANDLED => {
    if (method === "windows.propose") return handlePropose(params);
    if (method === "windows.set-state") return handleSetState(params);
    if (method === "windows.delete-state") return handleDeleteState(params);
    if (method === "windows.get-state") return handleGetState(params);
    if (method === "windows.get") return handleGet(params);
    if (method === "windows.list") return wm.listSnapshots();
    if (method === "windows.set-output-stack") return handleSetOutputStack(params);
    if (method === "windows.set-output-camera") return handleSetOutputCamera(params);
    if (method === "windows.get-output-camera") return handleGetOutputCamera(params);
    if (method === "windows.set-islands") return handleSetIslands(params);
    if (method === "windows.begin-camera-pan") return handleBeginCameraPan(params);
    if (method === "windows.end-camera-pan") return handleEndCameraPan(params);
    if (method === "windows.focus") return handleFocus(params);
    if (method === "windows.request-focus-decision") return handleRequestFocusDecision(params);
    if (method === "windows.set-opacity") return handleSetOpacity(params);
    if (method === "windows.set-transform") return handleSetTransform(params);
    if (method === "windows.set-output-margin") return handleSetOutputMargin(params);
    if (method === "windows.set-insets") return handleSetInsets(pluginName, params);
    if (method === "windows.set-mask") return handleSetMask(params);
    if (method === "windows.set-shape") return handleSetShape(params);
    if (method === "windows.set-tint") return handleSetTint(params);
    if (method === "windows.set-color-matrix") return handleSetColorMatrix(params);
    if (method === "windows.destroy-phantom") return handleDestroyPhantom(params);
    if (method === "windows.release-opening-gate") return handleReleaseOpeningGate(params);
    return NOT_HANDLED;
  };

  function handleDestroyPhantom(p: unknown): null {
    if (!isDestroyPhantomPayload(p)) {
      throw new Error("windows.destroy-phantom: malformed payload");
    }
    if (!compositor.destroyClosingPhantom) {
      throw new Error(
        "windows.destroy-phantom: not supported by this compositor");
    }
    // Cancel the backstop FIRST so an unlucky race where the timer
    // fires between this destroy and a fresh phantom getting the
    // same id can't mis-destroy. The timer's destroy callback is
    // a no-op when the timer was already cancelled.
    closingDriver?.cancelBackstop(p.id);
    compositor.destroyClosingPhantom(p.id);
    return null;
  }

  function handleReleaseOpeningGate(p: unknown): null {
    if (!isReleaseOpeningGatePayload(p)) {
      throw new Error("windows.release-opening-gate: malformed payload");
    }
    // Cancel the backstop FIRST -- if the timer fires between here
    // and the gate clear, it'd log a spurious warning even though
    // the plugin did its job.
    openingDriver?.cancelBackstop(p.id);
    // Clear the opening-owner gate. releaseContentGate is idempotent
    // and a no-op when the owner wasn't engaged, so releasing on a
    // non-gated window (or one whose backstop already fired) is
    // safe.
    wm.releaseContentGate(p.id, "opening");
    return null;
  }

  function handleSetTint(p: unknown): null {
    if (!isSetTintPayload(p)) throw new Error("windows.set-tint: malformed payload");
    if (!compositor.setSurfaceTint) {
      throw new Error("windows.set-tint: not supported by this compositor");
    }
    // The compositor cascades a window's tint over its group (content +
    // decoration + subsurface subtree); a non-window id (phantom, layer
    // surface) is just itself.
    compositor.setSurfaceTint(p.id, p.t);
    return null;
  }

  function handleSetColorMatrix(p: unknown): null {
    if (!isSetColorMatrixPayload(p)) {
      throw new Error("windows.set-color-matrix: malformed payload");
    }
    if (!compositor.setSurfaceColorMatrix) {
      throw new Error("windows.set-color-matrix: not supported by this compositor");
    }
    // Cascades over the window group; see handleSetTint.
    compositor.setSurfaceColorMatrix(p.id, p.m);
    return null;
  }

  function handleSetMask(p: unknown): null {
    if (!isSetMaskPayload(p)) throw new Error("windows.set-mask: malformed payload");
    if (!compositor.setSurfaceMask) {
      throw new Error("windows.set-mask: not supported by this compositor");
    }
    compositor.setSurfaceMask(p.id, p.mask);
    return null;
  }

  function handleSetShape(p: unknown): null {
    if (!isSetShapePayload(p)) throw new Error("windows.set-shape: malformed payload");
    if (!compositor.setSurfaceShape) {
      throw new Error("windows.set-shape: not supported by this compositor");
    }
    compositor.setSurfaceShape(p.id, p.shape);
    return null;
  }

  function handleSetOpacity(p: unknown): null {
    if (!isSetOpacityPayload(p)) throw new Error("windows.set-opacity: malformed payload");
    if (!compositor.setSurfaceOpacity) {
      throw new Error("windows.set-opacity: not supported by this compositor");
    }
    // The compositor cascades opacity over the window group. Applying the
    // same opacity to independently-composited members (content + decoration)
    // is NOT colorimetrically equivalent to compositing the window as one
    // layer at that opacity -- the mid-animation alpha math is slightly off --
    // but the visual is monotonic and looks correct at typical 200ms
    // animation timescales. Strict window-level opacity would require
    // offscreen-rendering the group to a single texture then compositing that
    // at the target alpha (the closing-phantom pattern), which is out of scope.
    compositor.setSurfaceOpacity(p.id, p.opacity);
    return null;
  }

  function handleSetTransform(p: unknown): null {
    if (!isSetTransformPayload(p)) throw new Error("windows.set-transform: malformed payload");
    if (!compositor.setSurfaceTransform) {
      throw new Error("windows.set-transform: not supported by this compositor");
    }
    // The compositor cascades the transform over the window group (content +
    // decoration + subsurface subtree). Without reaching the whole group,
    // animating a decorated window would move only the content while the
    // decoration stays glued to its destination rect. Each member's per-surface
    // transform is layered on top of its own placement at composite time, so
    // the shared transform translates the group as a unit. A non-window id
    // (phantom, layer surface) is just itself.
    compositor.setSurfaceTransform(p.id, p.t);
    return null;
  }

  function handleSetOutputMargin(p: unknown): null {
    if (!isSetOutputMarginPayload(p)) throw new Error("windows.set-output-margin: malformed payload");
    if (!compositor.setSurfaceOutputMargin) {
      throw new Error("windows.set-output-margin: not supported by this compositor");
    }
    compositor.setSurfaceOutputMargin(p.id, p.m);
    return null;
  }

  function handleSetInsets(pluginName: string, p: unknown):
    { insets: { top: number; right: number; bottom: number; left: number };
      outerRect: { x: number; y: number; width: number; height: number };
      contentRect: { x: number; y: number; width: number; height: number } } | null {
    if (!isSetInsetsPayload(p)) throw new Error("windows.set-insets: malformed payload");
    // Authorization: the caller must own the intercept currently
    // assigned to this surface. Mirrors the assignment-check the
    // decoration broker has used today (only the assigned provider
    // can move that window's insets). Without intercept support
    // configured, reject all set-insets calls.
    if (!deps.interceptBroker) {
      throw new Error(
        "windows.set-insets: rejected (intercept broker not configured; " +
        "set-insets requires an active intercept matching the target surface)");
    }
    const ownerPlugin = deps.interceptBroker.pluginNameForSurface(p.id);
    if (ownerPlugin === undefined) {
      throw new Error(
        `windows.set-insets: rejected (no intercept assigned to surface ${p.id}; ` +
        `the caller's plugin must own a matching intercept)`);
    }
    if (ownerPlugin !== pluginName) {
      throw new Error(
        `windows.set-insets: rejected (surface ${p.id} is assigned to ` +
        `intercept owned by '${ownerPlugin}', not '${pluginName}')`);
    }
    const grant = wm.setInsets(p.id, p.insets);
    if (!grant) return null;
    return {
      insets: grant.insets,
      outerRect: grant.outerRect,
      contentRect: grant.contentRect,
    };
  }

  // Explicit focus override. Bypasses the focus plugin's decide() and
  // applies via the seat directly (core-plugin-api.md §1). null clears.
  // Silent no-op when the seat is not bound yet or the surface is gone.
  function handleFocus(p: unknown): null {
    if (!isFocusPayload(p)) throw new Error("windows.focus: malformed payload");
    state.seat?.applyKeyboardFocus(p.id);
    return null;
  }

  // Policy-mediated focus dispatch. The caller supplies a FocusReason (and
  // optional trigger surfaceId); the seat builds a FocusInputs from current
  // pointer + keyboard state and fires the focus driver. Silent no-op when
  // the seat isn't bound (matches windows.focus's tolerance for partial
  // lifecycle).
  function handleRequestFocusDecision(p: unknown): null {
    if (!isRequestFocusDecisionPayload(p)) {
      throw new Error("windows.request-focus-decision: malformed payload");
    }
    // A workspace switch replaces the stack under a stationary pointer.
    // Refresh pointer focus first so the decision below (and clients'
    // wl_pointer enter/leave state) sees the surface actually under the
    // cursor rather than the pre-switch cached hit.
    if (p.reason === "workspace-changed") state.seat?.repickPointer();
    state.seat?.dispatchFocusEvent(p.reason, p.trigger);
    return null;
  }

  function handleSetOutputStack(p: unknown): null {
    if (!isSetOutputStackPayload(p)) {
      throw new Error("windows.set-output-stack: malformed payload");
    }
    if (!compositor.setOutputStack) {
      throw new Error("windows.set-output-stack: not supported by this compositor");
    }
    // Store the toplevel-order filter; let the protocol layer expand it into
    // [toplevel, ...subsurface subtree, ...popups parented under it] in the
    // filter's order. Calling compositor.setOutputStack with the raw
    // toplevel list would skip subsurfaces + popups, which the workspace
    // plugin doesn't model. rebuildStackWithPopups is the single owner of
    // setStack / setOutputStack pushes.
    state.outputToplevelStacks ??= new Map();
    if (p.ids === null) {
      state.outputToplevelStacks.delete(p.outputId);
      // Clear the compositor's override now; rebuildStackWithPopups iterates
      // remaining filters only and would otherwise leave a stale stack.
      compositor.setOutputStack(p.outputId, null);
    } else {
      state.outputToplevelStacks.set(p.outputId, p.ids.slice());
    }
    rebuildStackWithPopups(state);
    // The visible window set on this output changed; trigger a relayout so
    // the layout-driver picks up the new ordering / membership. "reorder"
    // routes through the WM's resize transaction (geometry held until
    // clients re-render at the new size), avoiding a frame or two where
    // a moved window shows scaled at its old size on the new tile.
    state.relayout?.("reorder");
    return null;
  }

  function handleSetOutputCamera(p: unknown): null {
    if (!p || typeof p !== "object") {
      throw new Error("windows.set-output-camera: malformed payload");
    }
    const { outputId, x, y, zoom } = p as {
      outputId?: unknown; x?: unknown; y?: unknown; zoom?: unknown;
    };
    if (typeof outputId !== "number"
      || typeof x !== "number" || !Number.isFinite(x)
      || typeof y !== "number" || !Number.isFinite(y)) {
      throw new Error("windows.set-output-camera: malformed payload");
    }
    if (zoom !== undefined
      && (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom <= 0)) {
      throw new Error("windows.set-output-camera: zoom must be a positive number");
    }
    const z = zoom ?? 1;
    if (!compositor.setOutputCamera) {
      throw new Error("windows.set-output-camera: not supported by this compositor");
    }
    // state.outputCameras is the core-side mirror the seat's pointer->world
    // transform and the popup constraint solver read; the compositor applies
    // the same value to render/damage/residency. The camera patch installed
    // by installProtocols also mirrors (it sees every sink write, including
    // the animation evaluator's per-frame ones); this write covers harnesses
    // where that patch isn't installed.
    state.outputCameras ??= new Map();
    if (x === 0 && y === 0 && z === 1) state.outputCameras.delete(outputId);
    else state.outputCameras.set(outputId, { x, y, zoom: z });
    // The camera patch installed by installProtocols sweeps residency and
    // re-narrates X positions on actual change; this call routes through it.
    compositor.setOutputCamera(outputId, x, y, z);
    // The world moved under a stationary pointer: refresh pointer focus so
    // enter/leave and hover state track the surface actually under the
    // cursor (same rationale as the workspace-changed repick above).
    state.seat?.repickPointer();
    return null;
  }

  function handleGetOutputCamera(p: unknown): { x: number; y: number; zoom: number } {
    if (!p || typeof p !== "object") {
      throw new Error("windows.get-output-camera: malformed payload");
    }
    const { outputId } = p as { outputId?: unknown };
    if (typeof outputId !== "number") {
      throw new Error("windows.get-output-camera: malformed payload");
    }
    // The mirror tracks every sink write, including the animation
    // evaluator's transient per-frame ones, so a flight preempted
    // mid-motion reads its true starting point here.
    return state.outputCameras?.get(outputId) ?? { x: 0, y: 0, zoom: 1 };
  }

  // Drag-pan (canvas-design.md §4): install a camera-pan pointer grab on
  // the seat. While it holds, pointer motion pans the output's camera
  // transiently instead of reaching clients; endGrab settles + repicks.
  // Returns whether the grab was installed (false: no seat, or another
  // grab already active -- the seat's beginGrab is first-wins).
  function handleBeginCameraPan(p: unknown): boolean {
    if (!p || typeof p !== "object"
      || typeof (p as { outputId?: unknown }).outputId !== "number") {
      throw new Error("windows.begin-camera-pan: malformed payload");
    }
    const seat = state.seat;
    if (!seat?.beginGrab || !seat.pointerPosition) return false;
    if (seat.grab) return false;
    const pos = seat.pointerPosition();
    seat.beginGrab({
      kind: "camera-pan",
      outputId: (p as { outputId: number }).outputId,
      lastX: pos.x, lastY: pos.y,
    });
    return !!seat.grab;
  }

  // End an active camera-pan grab (no-op for other grab kinds -- a pan
  // release must never tear down a move/resize grab that superseded it)
  // and return the settled camera.
  function handleEndCameraPan(p: unknown): { x: number; y: number; zoom: number } {
    if (!p || typeof p !== "object"
      || typeof (p as { outputId?: unknown }).outputId !== "number") {
      throw new Error("windows.end-camera-pan: malformed payload");
    }
    const outputId = (p as { outputId: number }).outputId;
    const seat = state.seat;
    if (seat?.grab?.kind === "camera-pan" && seat.grab.outputId === outputId) {
      seat.endGrab();
    }
    return state.outputCameras?.get(outputId) ?? { x: 0, y: 0, zoom: 1 };
  }

  function handleSetIslands(p: unknown): null {
    if (!p || typeof p !== "object") {
      throw new Error("windows.set-islands: malformed payload");
    }
    const { islands } = p as { islands?: unknown };
    if (islands === null) {
      wm.setIslands(null);
      return null;
    }
    if (!Array.isArray(islands)) {
      throw new Error("windows.set-islands: islands must be an array or null");
    }
    const parsed = islands.map((raw, i) => {
      if (!raw || typeof raw !== "object") {
        throw new Error(`windows.set-islands: islands[${i}] must be an object`);
      }
      const isl = raw as {
        id?: unknown; contextOutputId?: unknown; rect?: unknown; members?: unknown;
        layout?: unknown;
      };
      if (typeof isl.id !== "number" || typeof isl.contextOutputId !== "number") {
        throw new Error(`windows.set-islands: islands[${i}] id/contextOutputId must be numbers`);
      }
      let rect: { x: number; y: number; width: number; height: number } | null = null;
      if (isl.rect !== null && isl.rect !== undefined) {
        const r = isl.rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
        if (typeof r.x !== "number" || typeof r.y !== "number"
          || typeof r.width !== "number" || typeof r.height !== "number") {
          throw new Error(`windows.set-islands: islands[${i}].rect must be a rect or null`);
        }
        rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      if (!Array.isArray(isl.members)
        || !isl.members.every((m): m is number => typeof m === "number")) {
        throw new Error(`windows.set-islands: islands[${i}].members must be number[]`);
      }
      if (isl.layout !== undefined
        && (typeof isl.layout !== "object" || isl.layout === null || Array.isArray(isl.layout))) {
        throw new Error(`windows.set-islands: islands[${i}].layout must be an object`);
      }
      return {
        id: isl.id, contextOutputId: isl.contextOutputId, rect,
        members: isl.members.slice(),
        ...(isl.layout !== undefined ? { layout: isl.layout } : {}),
      };
    });
    wm.setIslands(parsed);
    return null;
  }

  async function handlePropose(p: unknown): Promise<unknown> {
    if (!isProposePayload(p)) throw new Error("windows.propose: malformed payload");
    const committed = await wm.propose(p.id, p.proposal, p.reason);
    // Returning the committed WindowState (or null) so plugins can confirm
    // what was actually applied after interceptors ran.
    return committed;
  }

  function handleSetState(p: unknown): null {
    if (!isSetStatePayload(p)) throw new Error("windows.set-state: malformed payload");
    const changed = wm.setState(p.id, p.key, p.value);
    if (changed) {
      const ev: WindowStateBagChangedEvent = {
        surfaceId: p.id, key: p.key, value: p.value, deleted: false,
      };
      pluginBus.emit(WINDOW_EVENT.stateBagChanged, ev);
    }
    return null;
  }

  function handleDeleteState(p: unknown): null {
    if (!isDeleteStatePayload(p)) throw new Error("windows.delete-state: malformed payload");
    const removed = wm.deleteState(p.id, p.key);
    if (removed) {
      const ev: WindowStateBagChangedEvent = {
        surfaceId: p.id, key: p.key, value: null, deleted: true,
      };
      pluginBus.emit(WINDOW_EVENT.stateBagChanged, ev);
    }
    return null;
  }

  function handleGetState(p: unknown): unknown {
    if (!isGetStatePayload(p)) throw new Error("windows.get-state: malformed payload");
    return wm.getState(p.id, p.key);
  }

  function handleGet(p: unknown): unknown {
    if (!isGetPayload(p)) throw new Error("windows.get: malformed payload");
    return wm.getSnapshot(p.id);
  }
}

function isProposePayload(d: unknown): d is {
  id: number; proposal: WindowStateProposal; reason: ProposalReason;
} {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  if (typeof o.reason !== "string"
      || !(PROPOSAL_REASONS as readonly string[]).includes(o.reason)) {
    return false;
  }
  if (typeof o.proposal !== "object" || o.proposal === null) return false;
  const p = o.proposal as { [k: string]: unknown };
  // Validate each known field shape. Missing fields are allowed.
  if (p.tiling !== undefined) {
    if (typeof p.tiling !== "string"
        || !(TILINGS as readonly string[]).includes(p.tiling)) return false;
  }
  if (p.exclusive !== undefined) {
    if (typeof p.exclusive !== "string"
        || !(EXCLUSIVES as readonly string[]).includes(p.exclusive)) return false;
  }
  if (p.visible !== undefined) {
    if (typeof p.visible !== "boolean") return false;
  }
  if (p.modal !== undefined) {
    if (typeof p.modal !== "boolean") return false;
  }
  if (p.clientRequests !== undefined) {
    if (typeof p.clientRequests !== "object" || p.clientRequests === null) return false;
    const cr = p.clientRequests as { [k: string]: unknown };
    for (const k of ["wantsMaximized", "wantsFullscreen", "wantsMinimized", "wantsModal"]) {
      if (cr[k] !== undefined && typeof cr[k] !== "boolean") return false;
    }
  }
  if (p.layoutMode !== undefined) {
    if (p.layoutMode !== null && typeof p.layoutMode !== "string") return false;
  }
  // layoutData is opaque; any clone-safe value is acceptable.
  if (p.parent !== undefined) {
    if (p.parent !== null && typeof p.parent !== "number") return false;
  }
  if (p.constraints !== undefined) {
    if (typeof p.constraints !== "object" || p.constraints === null) return false;
    const c = p.constraints as { [k: string]: unknown };
    for (const k of ["minSize", "maxSize"]) {
      if (c[k] !== undefined && c[k] !== null) {
        if (typeof c[k] !== "object" || c[k] === null) return false;
        const sz = c[k] as { [k: string]: unknown };
        if (!Number.isFinite(sz.width) || !Number.isFinite(sz.height)) return false;
      }
    }
  }
  return true;
}

function isSetStatePayload(d: unknown): d is { id: number; key: string; value: unknown } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  return typeof o.id === "number"
    && typeof o.key === "string" && o.key.length > 0
    && "value" in o;
}

function isDeleteStatePayload(d: unknown): d is { id: number; key: string } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  return typeof o.id === "number"
    && typeof o.key === "string" && o.key.length > 0;
}

function isGetStatePayload(d: unknown): d is { id: number; key: string } {
  return isDeleteStatePayload(d);
}

function isGetPayload(d: unknown): d is { id: number } {
  return typeof d === "object" && d !== null
    && typeof (d as { id?: unknown }).id === "number";
}

function isFocusPayload(d: unknown): d is { id: number | null } {
  if (typeof d !== "object" || d === null) return false;
  const id = (d as { id?: unknown }).id;
  return id === null || typeof id === "number";
}

function isRequestFocusDecisionPayload(d: unknown): d is {
  reason: import("@overdraw/focus-types").FocusReason; trigger?: number;
} {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.reason !== "string" || !(FOCUS_REASONS as readonly string[]).includes(o.reason)) {
    return false;
  }
  if (o.trigger !== undefined && typeof o.trigger !== "number") return false;
  return true;
}

function isSetOutputStackPayload(d: unknown): d is { outputId: number; ids: number[] | null } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.outputId !== "number") return false;
  if (o.ids === null) return true;
  if (!Array.isArray(o.ids)) return false;
  return o.ids.every((x) => typeof x === "number");
}

function isSetOpacityPayload(d: unknown): d is { id: number; opacity: number } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  return typeof o.id === "number"
    && typeof o.opacity === "number" && Number.isFinite(o.opacity);
}

function isSetTransformPayload(d: unknown): d is {
  id: number; t: import("../gpu/compositor.js").SurfaceTransform;
} {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  if (typeof o.t !== "object" || o.t === null) return false;
  const t = o.t as { [k: string]: unknown };
  for (const k of ["translateX", "translateY", "scaleX", "scaleY"]) {
    const v = t[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) return false;
  }
  return true;
}

function isSetOutputMarginPayload(d: unknown): d is {
  id: number; m: import("../gpu/compositor.js").SurfaceMargin;
} {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  if (typeof o.m !== "object" || o.m === null) return false;
  const m = o.m as { [k: string]: unknown };
  for (const k of ["top", "right", "bottom", "left"]) {
    const v = m[k];
    if (v !== undefined
        && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return false;
  }
  return true;
}

function isSetInsetsPayload(d: unknown): d is {
  id: number; insets: { top: number; right: number; bottom: number; left: number };
} {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  if (typeof o.insets !== "object" || o.insets === null) return false;
  const i = o.insets as { [k: string]: unknown };
  for (const k of ["top", "right", "bottom", "left"]) {
    const v = i[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

function isSetMaskPayload(d: unknown): d is { id: number; mask: GPUTexture | null } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  // GPUTexture is an opaque interface; we can't structurally verify it
  // without false positives. Accept null or "looks like an object" and
  // let the compositor surface a clear error if the wrong thing was passed.
  return o.mask === null || typeof o.mask === "object";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isSetShapePayload(d: unknown): d is {
  id: number; shape: import("../gpu/compositor.js").SurfaceShape;
} {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  if (o.shape === null) return true;
  if (typeof o.shape !== "object") return false;
  const s = o.shape as { [k: string]: unknown };
  switch (s.kind) {
    case "rounded-rect":
      return isFiniteNumber(s.radius) && s.radius >= 0;
    case "rounded-rect-per-corner":
      return (["tl", "tr", "br", "bl"] as const).every(
        (k) => isFiniteNumber(s[k]) && (s[k] as number) >= 0);
    case "superellipse":
      return isFiniteNumber(s.radius) && s.radius >= 0
        && isFiniteNumber(s.exponent) && (s.exponent as number) >= 2;
    default:
      return false;
  }
}

function isSetTintPayload(d: unknown): d is {
  id: number; t: import("../gpu/compositor.js").SurfaceTint;
} {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  if (typeof o.t !== "object" || o.t === null) return false;
  const t = o.t as { [k: string]: unknown };
  for (const k of ["r", "g", "b", "a"]) {
    const v = t[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) return false;
  }
  return true;
}

function isSetColorMatrixPayload(d: unknown): d is {
  id: number; m: import("../gpu/compositor.js").ColorMatrix | null;
} {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  if (o.m === null) return true;
  if (!Array.isArray(o.m) && !(o.m instanceof Float32Array)) return false;
  const m = o.m as ArrayLike<unknown>;
  if (m.length !== 16) return false;
  for (let i = 0; i < 16; i++) {
    const v = m[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return false;
  }
  return true;
}

function isDestroyPhantomPayload(d: unknown): d is { id: number } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  return typeof o.id === "number" && Number.isInteger(o.id) && o.id > 0;
}

function isReleaseOpeningGatePayload(d: unknown): d is { id: number } {
  return isDestroyPhantomPayload(d);
}
