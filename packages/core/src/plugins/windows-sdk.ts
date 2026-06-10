// Worker-side sdk.windows surface (core-plugin-api.md §1). Combines:
//   - The window-observer (onMap/onUnmap/onChange) for state-change events.
//   - Hint-state setters (setFloating/setFullscreen/setMaximized/setMinimized).
//   - Freeform state-bag setters (setState/getState/deleteState).
//   - Snapshot accessors (get/list).
//
// Routes all the new methods through the Endpoint as request/reply messages
// (windows.set, windows.set-state, windows.get-state, windows.delete-state,
// windows.get, windows.list). The observation half is unchanged; it uses
// sdk.events.subscribe('window.*', ...) under the hood.

import type { Endpoint, Json } from "./protocol.js";
import type { PluginWindowObserver, WindowObserverControl } from "./window-observer.js";
import type { PluginEvents } from "./events.js";
import { createWindowObserver } from "./window-observer.js";

// Hint field names; must match WindowHints keys on the core side.
export type HintField = "floating" | "fullscreen" | "maximized" | "minimized";

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

// Snapshot of a window. Matches WindowSnapshot in wm/index.ts (kept in sync
// by hand because wm/ is core-side; this is what arrives over the wire).
export interface WindowSnapshot {
  surfaceId: number;
  rect: { x: number; y: number; width: number; height: number };
  outer: { x: number; y: number; width: number; height: number };
  insets?: { top: number; right: number; bottom: number; left: number };
  decorationSurfaceId?: number;
  hasContent: boolean;
  contentGated: boolean;
  hints: { floating: boolean; fullscreen: boolean; maximized: boolean; minimized: boolean };
  state: { [key: string]: unknown };
}

// The sdk.windows surface. The observer (onMap/onUnmap/onChange) is included
// directly so plugins write `sdk.windows.onMap(...)` not
// `sdk.windows.observer.onMap(...)`.
export interface PluginWindows extends PluginWindowObserver {
  // Hint-state setters. Toggles per-window hints; emits 'window.change' with
  // the field listed.
  setFloating(surfaceId: number, value: boolean): Promise<void>;
  setFullscreen(surfaceId: number, value: boolean): Promise<void>;
  setMaximized(surfaceId: number, value: boolean): Promise<void>;
  setMinimized(surfaceId: number, value: boolean): Promise<void>;

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
  // override and falls back to the global stack. Use OUTPUT_DEFAULT (=0)
  // until multi-output reconfiguration is built (see status.md).
  setOutputStack(outputId: number, ids: number[] | null): Promise<void>;

  // Explicit focus override; bypasses the focus plugin's decide()
  // (core-plugin-api.md §1). null clears. For policy-mediated focus
  // changes, emit an event the focus plugin observes instead.
  focus(id: number | null): Promise<void>;

  // Per-surface render-state setters (core-plugin-api.md §1). Each is global
  // per surface (not per output) and consumed by the compositor's shader
  // every frame; calls are cheap (uniform-buffer writes on the next frame).
  // opacity is clamped to [0,1]. Animations targeting these flow through
  // sdk.animations.run with the matching target ref.
  setOpacity(id: number, opacity: number): Promise<void>;
  setTransform(id: number, t: SurfaceTransform): Promise<void>;
  setOutputMargin(id: number, m: SurfaceMargin): Promise<void>;
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

  // Per-channel tint multiplier on the sampled rgba (Phase 5.5a). Identity
  // = (1,1,1,1); missing fields default to 1. Cheap (uniform write next
  // frame).
  setTint(id: number, t: SurfaceTint): Promise<void>;

  // 4x4 color matrix applied to the sampled rgba BEFORE the tint (Phase
  // 5.5a). Pass 16 numbers in column-major order (WGSL mat4x4f). null
  // restores identity.
  setColorMatrix(id: number, m: ColorMatrix | null): Promise<void>;
}

// The single-output placeholder id (kept in sync with OUTPUT_DEFAULT in
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

    setFloating(id, value) { return setHint(endpoint, id, "floating", value); },
    setFullscreen(id, value) { return setHint(endpoint, id, "fullscreen", value); },
    setMaximized(id, value) { return setHint(endpoint, id, "maximized", value); },
    setMinimized(id, value) { return setHint(endpoint, id, "minimized", value); },

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
  };

  return {
    windows,
    release(): void { observer.release(); },
  };
}

async function setHint(
  endpoint: Endpoint, id: number, field: HintField, value: boolean,
): Promise<void> {
  if (typeof id !== "number") throw new TypeError("setHint id must be a number");
  if (typeof value !== "boolean") throw new TypeError("setHint value must be boolean");
  await endpoint.request("windows.set", { id, field, value });
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
