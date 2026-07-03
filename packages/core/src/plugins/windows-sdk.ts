// Worker-side sdk.windows surface. Combines:
//   - The window-observer (onMap/onUnmap/onChange) for metadata changes.
//   - propose() for behavioral-state changes (presentation, layoutMode,
//     layoutData, constraints, parent).
//   - Freeform state-bag setters (setState/getState/deleteState).
//   - Snapshot accessors (get/list).
//   - Per-surface render-state setters (opacity/transform/mask/etc.).
//
// Routes through the Endpoint as request/reply messages
// (windows.propose, windows.set-state, ...). The observation half uses
// sdk.events.subscribe('window.*', ...) under the hood.

import type { Endpoint, Json } from "./protocol.js";
import type { PluginWindowObserver, WindowObserverControl } from "./window-observer.js";
import type { PluginEvents } from "./events.js";
import { createWindowObserver } from "./window-observer.js";
import { FOCUS_REASONS, type FocusReason } from "@overdraw/focus-types";
import type {
  Tiling, Exclusive, ClientRequests, ProposalReason, WindowState,
} from "../events/types.js";

// Re-exported so plugins building proposals don't need a parallel import.
export type {
  Tiling, Exclusive, ClientRequests, ProposalReason, WindowState,
} from "../events/types.js";

// A partial WindowState. Fields omitted from the proposal stay at their
// current value. constraints is a partial of its sub-object too: missing
// min/max stays put.
export interface WindowStateProposal {
  tiling?: Tiling;
  exclusive?: Exclusive;
  visible?: boolean;
  modal?: boolean;
  clientRequests?: Partial<ClientRequests>;
  layoutMode?: string | null;
  layoutData?: unknown;
  constraints?: {
    minSize?: { width: number; height: number } | null;
    maxSize?: { width: number; height: number } | null;
  };
  parent?: number | null;
}

// Per-surface transform; all fields optional, missing fields reset to identity.
// translate is in output pixels, scale is unitless. Rotation is not supported in
// v1 (spec builders compose center-anchored scale via translate + scale + counter-
// translate; rotation needs a shader path that doesn't exist yet).
export interface SurfaceTransform {
  translateX?: number;
  translateY?: number;
  scaleX?: number;
  scaleY?: number;
}

// Per-edge margin in output pixels reserved AROUND the surface's nominal rect.
// Used by downstream consumers (masks, decoration shadows, intercept stages) to
// paint outside the surface itself. Missing fields default to 0.
export interface SurfaceMargin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

// Insets carved out of a window's outer tile to derive its content rect.
// Each field is a non-negative finite integer count of logical pixels.
// `setInsets` clamps negative values to zero; total horizontal/vertical
// insets exceeding the outer extent are clamped so the content rect
// remains non-empty.
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// The result of setInsets: what the WM actually accepted (after clamping),
// the current outer rect, and the derived content rect. The plugin can use
// this to confirm the request landed at the expected dimensions before
// e.g. releasing a content gate.
export interface InsetGrant {
  insets: Insets;
  outerRect: { x: number; y: number; width: number; height: number };
  contentRect: { x: number; y: number; width: number; height: number };
}

// Per-channel tint multiplier on the sampled rgba (Phase 5.5a). Identity is
// (1,1,1,1); missing fields default to 1 (no change to that channel).
// Examples: dim to half = { r: 0.5, g: 0.5, b: 0.5 }; suppress red =
// { r: 0 }; fade alpha = { a: 0.5 }.
export interface SurfaceTint {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}

// 4x4 color matrix applied to the sampled rgba before the per-channel tint
// (Phase 5.5a). Caller passes 16 numbers in COLUMN-MAJOR order, matching
// WGSL mat4x4f. Identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]. Covers
// saturation, hue rotation, contrast, brightness, channel swap. Anything
// needing neighbor pixels (blur, distortion) is for the buffer-intercept
// path (Phase 10), not core primitives.
export type ColorMatrix = readonly number[] | Float32Array;

// Analytic per-surface shape evaluated by the compositor's fragment shader.
// Composes multiplicatively with the optional alpha mask, so a plugin may use
// both (mask for arbitrary shapes, shape for rounded corners; the intersection
// is rendered). null = rectangle (default; shader early-out, zero cost). Radii
// / extents are in surface LOGICAL pixels.
//
// Vocabulary:
//   rounded-rect:           uniform corner radius (circular arc)
//   rounded-rect-per-corner: independent (tl, tr, br, bl) radii (circular arcs)
//   superellipse:           a rectangle whose corners are replaced by a
//                           localized superelliptic curve of extent `radius`
//                           (the macOS-style squircle corner). `exponent`
//                           controls the curve character: n=2 is identical
//                           to rounded-rect (circular arc); n=4..6 is the
//                           macOS-style squircle (continuous-curvature
//                           corner with smoother eye-tracking than a circular
//                           arc); larger n approaches a sharp rectangle.
//                           `radius` is the corner extent in logical px and
//                           is clamped to <= min(width, height) / 2.
export type SurfaceShape =
  | null
  | { kind: "rounded-rect"; radius: number }
  | { kind: "rounded-rect-per-corner";
      tl: number; tr: number; br: number; bl: number }
  | { kind: "superellipse"; exponent: number; radius: number };

// Snapshot of a window. Matches WindowSnapshot in wm/index.ts (kept in sync
// by hand because wm/ is core-side; this is what arrives over the wire).
export interface WindowSnapshot {
  surfaceId: number;
  // The window's current output placement; null = unplaced (no layout pass
  // has assigned it yet).
  outputId: number | null;
  rect: { x: number; y: number; width: number; height: number };
  outer: { x: number; y: number; width: number; height: number };
  insets?: { top: number; right: number; bottom: number; left: number };
  decorationSurfaceId?: number;
  hasContent: boolean;
  contentGated: boolean;
  windowState: WindowState;
  state: { [key: string]: unknown };
}

// The sdk.windows surface. The observer (onMap/onUnmap/onChange) is included
// directly so plugins write `sdk.windows.onMap(...)` not
// `sdk.windows.observer.onMap(...)`.
export interface PluginWindows extends PluginWindowObserver {
  // Propose a behavioral-state change. The proposal is merged with the
  // window's current state; the resulting candidate goes through the
  // 'window.proposed' interceptor chain (other plugins may modify it);
  // the final candidate is committed and 'window.committed' fires. A
  // geometry-affecting change schedules a layout pass.
  //
  // Resolves to the committed state (which may differ from the proposal
  // after arbitration) or null if the window doesn't exist. `reason`
  // defaults to 'plugin' when omitted -- a plugin acting on user input
  // (a hotkey grab) should pass 'user-input' so policy plugins can
  // distinguish.
  propose(
    surfaceId: number,
    proposal: WindowStateProposal,
    reason?: ProposalReason,
  ): Promise<WindowState | null>;

  // Freeform state-bag access. setState emits 'window.state-changed';
  // deleteState emits 'window.state-changed' with deleted=true. getState
  // returns undefined if the key is unset or the window is unknown.
  setState(surfaceId: number, key: string, value: unknown): Promise<void>;
  getState(surfaceId: number, key: string): Promise<unknown>;
  deleteState(surfaceId: number, key: string): Promise<void>;

  // Snapshot accessors.
  get(surfaceId: number): Promise<WindowSnapshot | null>;
  list(): Promise<WindowSnapshot[]>;

  // Override the content-layer draw order for an output. null clears the
  // override and falls back to the global stack. `outputId` is one of the
  // dense ids in state.outputs (see core-plugin-api.md §1); the workspace
  // plugin uses it to multiplex per-output workspace stacks.
  setOutputStack(outputId: number, ids: number[] | null): Promise<void>;

  // Explicit focus override; bypasses the focus plugin's decide()
  // (core-plugin-api.md §1). null clears. For policy-mediated focus
  // changes, emit an event the focus plugin observes instead.
  focus(id: number | null): Promise<void>;

  // Trigger a policy-mediated focus decision. Core builds a FocusInputs
  // from the current pointer + keyboard-focus state and dispatches it to
  // the active 'focus' plugin's decide(). Fire-and-forget; the result
  // applies asynchronously. Use this (not focus()) when the caller wants
  // the focus plugin's policy to decide -- e.g. a workspace plugin after
  // show() wants to re-resolve focus under the new stack.
  requestFocusDecision(reason: FocusReason, trigger?: number): Promise<void>;

  // Per-surface render-state setters (core-plugin-api.md §1). Each is global
  // per surface (not per output) and consumed by the compositor's shader
  // every frame; calls are cheap (uniform-buffer writes on the next frame).
  // opacity is clamped to [0,1]. Animations targeting these flow through
  // sdk.animations.run with the matching target ref.
  setOpacity(id: number, opacity: number): Promise<void>;
  setTransform(id: number, t: SurfaceTransform): Promise<void>;
  setOutputMargin(id: number, m: SurfaceMargin): Promise<void>;
  // Reserve insets inside the window's outer tile. The WM shrinks the
  // window's content rect by the insets and re-configures the client at
  // the smaller size. Returns the actual insets, outer rect, and derived
  // content rect (the WM may clamp negative values; the grant carries the
  // post-clamp result). Returns null when the window is unknown.
  //
  // Authorization: the caller must own an intercept currently assigned
  // to `id`. A plugin with no matching intercept on `id` cannot move
  // its insets (a generic, unauthenticated setInsets would let any
  // plugin shrink any window). The broker returns an error if the
  // caller is not the assigned-intercept owner.
  //
  // Typical use: a decoration intercept calls setInsets from its
  // onSurfaceMatched handler to reserve a border band; the WM then
  // configures the client at the shrunk content size on the first
  // sized configure.
  setInsets(id: number, insets: Insets): Promise<InsetGrant | null>;
  // Alpha mask sampled across the (surface + outputMargin) region; the .a
  // channel modulates the surface's premultiplied rgb and alpha. null clears
  // (default-white, no visible effect). The caller OWNS the GPUTexture's
  // lifetime: keep it alive while installed; replace or clear before destroy.
  //
  // The texture must live on the same GPUDevice the compositor uses to sample
  // it. For in-thread bundled plugins this is automatic (sdk.gpu.device IS
  // core's device). Worker plugins cannot pass a GPUTexture across the thread
  // boundary -- their textures live on a separate device, so the cross-device
  // mask path is unimplemented; calling this from a Worker plugin rejects.
  setMask(id: number, mask: GPUTexture | null): Promise<void>;

  // Analytic per-surface shape (rounded rect, per-corner radii, superellipse,
  // or null = rectangle). Evaluated by an SDF in the compositor's fragment
  // shader and multiplied into the surface's premultiplied output -- composes
  // with setMask. Cheap: a uniform-write only, no GPU resources. Available to
  // both in-thread and Worker plugins (the payload is plain data, not a
  // GPUTexture). Radii are in surface LOGICAL pixels.
  setShape(id: number, shape: SurfaceShape): Promise<void>;

  // Per-channel tint multiplier on the sampled rgba (Phase 5.5a). Identity
  // = (1,1,1,1); missing fields default to 1. Cheap (uniform write next
  // frame).
  setTint(id: number, t: SurfaceTint): Promise<void>;

  // 4x4 color matrix applied to the sampled rgba BEFORE the tint (Phase
  // 5.5a). Pass 16 numbers in column-major order (WGSL mat4x4f). null
  // restores identity.
  setColorMatrix(id: number, m: ColorMatrix | null): Promise<void>;

  // Phase 9a: destroy a phantom surface (created by core in response to
  // a closing window and passed to the plugin via the window.closing
  // event). The plugin calls this when its closing animation completes;
  // the compositor removes the phantom from the draw order, destroys
  // the snapshot texture, and cancels the backstop timer.
  //
  // Idempotent: calling on an already-destroyed phantom id is a no-op.
  // Calling on a non-phantom id (a regular client surface) is also
  // (effectively) a no-op -- the compositor's destroyClosingPhantom
  // refuses non-phantom ids.
  destroyPhantom(id: number): Promise<void>;

  // Release the content gate engaged at window.opening for `id`. The
  // window then enters the compositor's draw stack and the next
  // composite includes it -- with whatever per-surface render state
  // the plugin set before calling this. Typical pattern:
  //
  //   sdk.events.on("window.opening", (ev) => {
  //     sdk.windows.setTransform(ev.surfaceId, { translateX: ev.outerRect.width });
  //     sdk.windows.releaseOpeningGate(ev.surfaceId);  // visible from this frame
  //     sdk.animations.run(tween(target.windowTransform(ev.surfaceId),
  //       { from: { translateX: ev.outerRect.width }, to: { translateX: 0 },
  //         duration: 200 }));
  //   });
  //
  // The release-gate path cancels the opening-driver's backstop timer.
  // No-op if no gate is engaged on `id` (idempotent + safe to call on
  // a non-gated window).
  releaseOpeningGate(id: number): Promise<void>;
}

// The id of the primary output (kept in sync with OUTPUT_DEFAULT in
// protocols/ctx.ts). Re-exported for plugin authors so they don't import
// from internal core paths.
export const OUTPUT_DEFAULT = 0;



export interface WindowsControl {
  windows: PluginWindows;
  release(): void;
}

export function createPluginWindows(
  endpoint: Endpoint, events: PluginEvents,
): WindowsControl {
  const observer: WindowObserverControl = createWindowObserver(events);

  const windows: PluginWindows = {
    // Observation (delegated to the observer).
    onMap(cb) { observer.observer.onMap(cb); },
    onUnmap(cb) { observer.observer.onUnmap(cb); },
    onChange(cb) { observer.observer.onChange(cb); },

    async propose(id, proposal, reason): Promise<WindowState | null> {
      if (typeof id !== "number") throw new TypeError("propose id must be a number");
      validateProposal(proposal);
      const finalReason: ProposalReason = reason ?? "plugin";
      // WindowStateProposal contains `layoutData: unknown` (opaque to core,
      // the plugin author owns clone-safety). Cast through Json at the
      // boundary so the Endpoint.request signature matches.
      // eslint-disable-next-line no-restricted-syntax
      const payload = proposal as unknown as Json;
      const r = await endpoint.request("windows.propose", {
        id, proposal: payload, reason: finalReason,
      });
      if (r === null) return null;
      // eslint-disable-next-line no-restricted-syntax
      return r as unknown as WindowState;
    },

    async setState(id, key, value): Promise<void> {
      if (typeof id !== "number") throw new TypeError("setState id must be a number");
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("setState key must be a non-empty string");
      }
      // Cast value to Json at the boundary: the plugin author is responsible
      // for clone-safety; postMessage enforces it at runtime.
      await endpoint.request("windows.set-state", { id, key, value: value as Json });
    },
    async getState(id, key): Promise<unknown> {
      if (typeof id !== "number") throw new TypeError("getState id must be a number");
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("getState key must be a non-empty string");
      }
      return await endpoint.request("windows.get-state", { id, key });
    },
    async deleteState(id, key): Promise<void> {
      if (typeof id !== "number") throw new TypeError("deleteState id must be a number");
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("deleteState key must be a non-empty string");
      }
      await endpoint.request("windows.delete-state", { id, key });
    },

    async get(id): Promise<WindowSnapshot | null> {
      if (typeof id !== "number") throw new TypeError("get id must be a number");
      const r = await endpoint.request("windows.get", { id });
      if (r === null) return null;
      // Core constructs WindowSnapshot; cast through. eslint-disable-next-line
      // justified for the same reason as actions.list -- trusted producer.
      // eslint-disable-next-line no-restricted-syntax
      return r as unknown as WindowSnapshot;
    },

    async list(): Promise<WindowSnapshot[]> {
      const r = await endpoint.request("windows.list", null);
      // eslint-disable-next-line no-restricted-syntax
      return r as unknown as WindowSnapshot[];
    },

    async setOutputStack(outputId, ids): Promise<void> {
      if (typeof outputId !== "number") {
        throw new TypeError("setOutputStack outputId must be a number");
      }
      if (ids !== null) {
        if (!Array.isArray(ids)) {
          throw new TypeError("setOutputStack ids must be an array or null");
        }
        for (const x of ids) {
          if (typeof x !== "number") {
            throw new TypeError("setOutputStack ids must contain numbers");
          }
        }
      }
      await endpoint.request("windows.set-output-stack", { outputId, ids });
    },

    async focus(id): Promise<void> {
      if (id !== null && typeof id !== "number") {
        throw new TypeError("focus id must be a number or null");
      }
      await endpoint.request("windows.focus", { id });
    },

    async requestFocusDecision(reason, trigger): Promise<void> {
      if (typeof reason !== "string" || !(FOCUS_REASONS as readonly string[]).includes(reason)) {
        throw new TypeError(
          `requestFocusDecision reason must be one of ${FOCUS_REASONS.join("|")}`);
      }
      if (trigger !== undefined && typeof trigger !== "number") {
        throw new TypeError("requestFocusDecision trigger must be a number or omitted");
      }
      const payload: { reason: string; trigger?: number } = { reason };
      if (trigger !== undefined) payload.trigger = trigger;
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("windows.request-focus-decision", payload as unknown as Json);
    },

    async setOpacity(id, opacity): Promise<void> {
      if (typeof id !== "number") {
        throw new TypeError("setOpacity id must be a number");
      }
      if (typeof opacity !== "number" || !Number.isFinite(opacity)) {
        throw new TypeError("setOpacity opacity must be a finite number");
      }
      await endpoint.request("windows.set-opacity", { id, opacity });
    },

    async setTransform(id, t): Promise<void> {
      if (typeof id !== "number") {
        throw new TypeError("setTransform id must be a number");
      }
      validateTransform(t);
      // SurfaceTransform fields are all `number | undefined` -- structurally
      // a Json object once undefined-stripped at the postMessage boundary.
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("windows.set-transform", { id, t: t as unknown as Json });
    },

    async setOutputMargin(id, m): Promise<void> {
      if (typeof id !== "number") {
        throw new TypeError("setOutputMargin id must be a number");
      }
      validateMargin(m);
      // Same Json-compatibility justification as setTransform above.
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("windows.set-output-margin", { id, m: m as unknown as Json });
    },

    async setInsets(id, insets): Promise<InsetGrant | null> {
      if (typeof id !== "number") {
        throw new TypeError("setInsets id must be a number");
      }
      validateInsets(insets);
      // Insets is a plain object of numbers -- structurally Json once
      // it crosses the postMessage boundary.
      // eslint-disable-next-line no-restricted-syntax
      const payload = { id, insets: insets as unknown as Json };
      const result = await endpoint.request("windows.set-insets", payload);
      if (result === null) return null;
      // The broker returns the InsetGrant directly. Trust the shape.
      // eslint-disable-next-line no-restricted-syntax
      return result as unknown as InsetGrant;
    },

    async setMask(id, mask): Promise<void> {
      if (typeof id !== "number") {
        throw new TypeError("setMask id must be a number");
      }
      if (mask !== null && (typeof mask !== "object" || mask === undefined)) {
        throw new TypeError("setMask mask must be a GPUTexture or null");
      }
      // The payload carries a GPUTexture reference; not Json-cloneable. For
      // in-thread the pair-channel delivers by reference. For Worker the
      // postMessage attempt rejects at the transport boundary -- the right
      // failure for a plugin whose textures live on a different device.
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("windows.set-mask", { id, mask: mask as unknown as Json });
    },

    async setShape(id, shape): Promise<void> {
      if (typeof id !== "number") {
        throw new TypeError("setShape id must be a number");
      }
      validateShape(shape);
      // SurfaceShape is plain numbers + a discriminator string, Json-safe.
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("windows.set-shape", { id, shape: shape as unknown as Json });
    },

    async setTint(id, t): Promise<void> {
      if (typeof id !== "number") {
        throw new TypeError("setTint id must be a number");
      }
      validateTint(t);
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("windows.set-tint", { id, t: t as unknown as Json });
    },

    async setColorMatrix(id, m): Promise<void> {
      if (typeof id !== "number") {
        throw new TypeError("setColorMatrix id must be a number");
      }
      if (m !== null) validateColorMatrix(m);
      // Float32Array is structured-clone-safe; plain number[] is Json.
      // Cast through Json at the boundary so the type matches endpoint.request.
      const payload = m === null
        ? null
        : (m instanceof Float32Array ? Array.from(m) : m);
      // eslint-disable-next-line no-restricted-syntax
      await endpoint.request("windows.set-color-matrix", { id, m: payload as unknown as Json });
    },

    async destroyPhantom(id): Promise<void> {
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
        throw new TypeError("destroyPhantom id must be a positive integer");
      }
      await endpoint.request("windows.destroy-phantom", { id });
    },

    async releaseOpeningGate(id): Promise<void> {
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
        throw new TypeError("releaseOpeningGate id must be a positive integer");
      }
      await endpoint.request("windows.release-opening-gate", { id });
    },
  };

  return {
    windows,
    release(): void { observer.release(); },
  };
}

const TILINGS: ReadonlyArray<Tiling> = ["managed", "floating"];
const EXCLUSIVES: ReadonlyArray<Exclusive> = ["none", "maximized", "fullscreen"];

function validateProposal(p: WindowStateProposal): void {
  if (typeof p !== "object" || p === null) {
    throw new TypeError("propose proposal must be an object");
  }
  if (p.tiling !== undefined
      && !(TILINGS as readonly string[]).includes(p.tiling)) {
    throw new TypeError(
      `propose tiling must be one of ${TILINGS.join("|")}`);
  }
  if (p.exclusive !== undefined
      && !(EXCLUSIVES as readonly string[]).includes(p.exclusive)) {
    throw new TypeError(
      `propose exclusive must be one of ${EXCLUSIVES.join("|")}`);
  }
  if (p.visible !== undefined && typeof p.visible !== "boolean") {
    throw new TypeError("propose visible must be a boolean");
  }
  if (p.modal !== undefined && typeof p.modal !== "boolean") {
    throw new TypeError("propose modal must be a boolean");
  }
  if (p.clientRequests !== undefined) {
    if (typeof p.clientRequests !== "object" || p.clientRequests === null) {
      throw new TypeError("propose clientRequests must be an object");
    }
    for (const k of ["wantsMaximized", "wantsFullscreen", "wantsMinimized", "wantsModal"] as const) {
      const v = p.clientRequests[k];
      if (v !== undefined && typeof v !== "boolean") {
        throw new TypeError(`propose clientRequests.${k} must be a boolean`);
      }
    }
  }
  if (p.layoutMode !== undefined
      && p.layoutMode !== null
      && typeof p.layoutMode !== "string") {
    throw new TypeError("propose layoutMode must be a string or null");
  }
  if (p.parent !== undefined
      && p.parent !== null
      && typeof p.parent !== "number") {
    throw new TypeError("propose parent must be a number or null");
  }
  if (p.constraints !== undefined) {
    if (typeof p.constraints !== "object" || p.constraints === null) {
      throw new TypeError("propose constraints must be an object");
    }
    for (const k of ["minSize", "maxSize"] as const) {
      const v = p.constraints[k];
      if (v !== undefined && v !== null) {
        if (typeof v !== "object" || typeof v.width !== "number"
            || typeof v.height !== "number"
            || !Number.isFinite(v.width) || !Number.isFinite(v.height)) {
          throw new TypeError(
            `propose constraints.${k} must be { width, height } or null`);
        }
      }
    }
  }
}

function validateTransform(t: SurfaceTransform): void {
  if (typeof t !== "object" || t === null) {
    throw new TypeError("setTransform t must be an object");
  }
  for (const k of ["translateX", "translateY", "scaleX", "scaleY"] as const) {
    const v = t[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new TypeError(`setTransform ${k} must be a finite number`);
    }
  }
}

function validateMargin(m: SurfaceMargin): void {
  if (typeof m !== "object" || m === null) {
    throw new TypeError("setOutputMargin m must be an object");
  }
  for (const k of ["top", "right", "bottom", "left"] as const) {
    const v = m[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      throw new TypeError(`setOutputMargin ${k} must be a non-negative finite number`);
    }
  }
}

function validateInsets(i: Insets): void {
  if (typeof i !== "object" || i === null) {
    throw new TypeError("setInsets insets must be an object");
  }
  for (const k of ["top", "right", "bottom", "left"] as const) {
    const v = i[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new TypeError(`setInsets ${k} must be a finite number`);
    }
  }
}

function validateShape(shape: SurfaceShape): void {
  if (shape === null) return;
  if (typeof shape !== "object") {
    throw new TypeError("setShape shape must be a SurfaceShape object or null");
  }
  const requireNonNeg = (name: string, v: unknown): void => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new TypeError(`setShape: ${name} must be a non-negative finite number`);
    }
  };
  switch (shape.kind) {
    case "rounded-rect":
      requireNonNeg("radius", shape.radius);
      return;
    case "rounded-rect-per-corner":
      requireNonNeg("tl", shape.tl);
      requireNonNeg("tr", shape.tr);
      requireNonNeg("br", shape.br);
      requireNonNeg("bl", shape.bl);
      return;
    case "superellipse":
      requireNonNeg("radius", shape.radius);
      if (typeof shape.exponent !== "number" || !Number.isFinite(shape.exponent)
          || shape.exponent < 2) {
        throw new TypeError("setShape: exponent must be a finite number >= 2");
      }
      return;
    default: {
      // The discriminator was something else; surface a useful error.
      const k = (shape as { kind?: unknown }).kind;
      throw new TypeError(
        `setShape: unknown shape kind ${JSON.stringify(k)} `
        + `(expected "rounded-rect", "rounded-rect-per-corner", or "superellipse")`);
    }
  }
}

function validateTint(t: SurfaceTint): void {
  if (typeof t !== "object" || t === null) {
    throw new TypeError("setTint t must be an object");
  }
  for (const k of ["r", "g", "b", "a"] as const) {
    const v = t[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new TypeError(`setTint ${k} must be a finite number`);
    }
  }
}

function validateColorMatrix(m: ColorMatrix): void {
  // Accept readonly number[] or Float32Array; both are ArrayLike<number>.
  if (!Array.isArray(m) && !(m instanceof Float32Array)) {
    throw new TypeError("setColorMatrix m must be an array of 16 numbers or null");
  }
  if (m.length !== 16) {
    throw new TypeError(`setColorMatrix m must have 16 entries, got ${m.length}`);
  }
  for (let i = 0; i < 16; i++) {
    const v = m[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new TypeError(`setColorMatrix m[${i}] must be a finite number`);
    }
  }
}
