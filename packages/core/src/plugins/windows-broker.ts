// Windows broker: services the plugin-side sdk.windows.* requests
// (core-plugin-api.md §1). Translates `windows.*` plugin->core requests into
// WM mutations and emits the appropriate events on the typed bus + the
// dynamic bus so plugin subscribers see the change.
//
// Routed from main.ts's onRequest chain. Pure JS broker; no GPU.

import type { Wm, HintField } from "../wm/index.js";
import { HINT_FIELDS } from "../wm/index.js";
import type { CompositorBus } from "../events/window-bus.js";
import type { DynamicBus } from "../events/dynamic-bus.js";
import { WINDOW_EVENT } from "../events/types.js";
import type { WindowStateChangedEvent } from "../events/types.js";
import { markWindowChanged } from "../protocols/window-changes.js";
import type { CompositorState, CompositorSink } from "../protocols/ctx.js";

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
  const { wm, compositor, state, pluginBus } = deps;

  return (pluginName: string, method: string, params: unknown): unknown | typeof NOT_HANDLED => {
    void pluginName;   // available for future audit / capability gating

    if (method === "windows.set") return handleSet(params);
    if (method === "windows.set-state") return handleSetState(params);
    if (method === "windows.delete-state") return handleDeleteState(params);
    if (method === "windows.get-state") return handleGetState(params);
    if (method === "windows.get") return handleGet(params);
    if (method === "windows.list") return wm.listSnapshots();
    if (method === "windows.set-output-stack") return handleSetOutputStack(params);
    if (method === "windows.focus") return handleFocus(params);
    if (method === "windows.set-opacity") return handleSetOpacity(params);
    if (method === "windows.set-transform") return handleSetTransform(params);
    if (method === "windows.set-output-margin") return handleSetOutputMargin(params);
    if (method === "windows.set-mask") return handleSetMask(params);
    return NOT_HANDLED;
  };

  function handleSetMask(p: unknown): null {
    if (!isSetMaskPayload(p)) throw new Error("windows.set-mask: malformed payload");
    if (!compositor.setSurfaceMask) {
      throw new Error("windows.set-mask: not supported by this compositor");
    }
    compositor.setSurfaceMask(p.id, p.mask);
    return null;
  }

  function handleSetOpacity(p: unknown): null {
    if (!isSetOpacityPayload(p)) throw new Error("windows.set-opacity: malformed payload");
    if (!compositor.setSurfaceOpacity) {
      throw new Error("windows.set-opacity: not supported by this compositor");
    }
    compositor.setSurfaceOpacity(p.id, p.opacity);
    return null;
  }

  function handleSetTransform(p: unknown): null {
    if (!isSetTransformPayload(p)) throw new Error("windows.set-transform: malformed payload");
    if (!compositor.setSurfaceTransform) {
      throw new Error("windows.set-transform: not supported by this compositor");
    }
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

  // Explicit focus override. Bypasses the focus plugin's decide() and
  // applies via the seat directly (core-plugin-api.md §1). null clears.
  // Silent no-op when the seat is not bound yet or the surface is gone.
  function handleFocus(p: unknown): null {
    if (!isFocusPayload(p)) throw new Error("windows.focus: malformed payload");
    state.seat?.applyKeyboardFocus(p.id);
    return null;
  }

  function handleSetOutputStack(p: unknown): null {
    if (!isSetOutputStackPayload(p)) {
      throw new Error("windows.set-output-stack: malformed payload");
    }
    if (!compositor.setOutputStack) {
      throw new Error("windows.set-output-stack: not supported by this compositor");
    }
    compositor.setOutputStack(p.outputId, p.ids);
    return null;
  }

  function handleSet(p: unknown): null {
    if (!isSetPayload(p)) throw new Error("windows.set: malformed payload");
    if (!(HINT_FIELDS as readonly string[]).includes(p.field)) {
      throw new Error(`windows.set: unknown field '${p.field}'`);
    }
    if (typeof p.value !== "boolean") {
      throw new Error(`windows.set: '${p.field}' value must be a boolean`);
    }
    const changed = wm.setHint(p.id, p.field as HintField, p.value);
    if (changed) {
      // Use the same coalescing path as title/appId/activated -- one change
      // event per surface per frame regardless of how many fields toggled.
      markWindowChanged(state, p.id, p.field as HintField);
    }
    return null;
  }

  function handleSetState(p: unknown): null {
    if (!isSetStatePayload(p)) throw new Error("windows.set-state: malformed payload");
    const changed = wm.setState(p.id, p.key, p.value);
    if (changed) {
      const ev: WindowStateChangedEvent = {
        surfaceId: p.id, key: p.key, value: p.value, deleted: false,
      };
      pluginBus.emit(WINDOW_EVENT.stateChanged, ev);
    }
    return null;
  }

  function handleDeleteState(p: unknown): null {
    if (!isDeleteStatePayload(p)) throw new Error("windows.delete-state: malformed payload");
    const removed = wm.deleteState(p.id, p.key);
    if (removed) {
      const ev: WindowStateChangedEvent = {
        surfaceId: p.id, key: p.key, value: null, deleted: true,
      };
      pluginBus.emit(WINDOW_EVENT.stateChanged, ev);
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

function isSetPayload(d: unknown): d is { id: number; field: string; value: unknown } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  return typeof o.id === "number"
    && typeof o.field === "string"
    && "value" in o;
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

function isSetMaskPayload(d: unknown): d is { id: number; mask: GPUTexture | null } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  // GPUTexture is an opaque interface; we can't structurally verify it
  // without false positives. Accept null or "looks like an object" and
  // let the compositor surface a clear error if the wrong thing was passed.
  return o.mask === null || typeof o.mask === "object";
}
