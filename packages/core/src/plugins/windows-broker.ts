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
    return NOT_HANDLED;
  };

  // Explicit-override focus (core-plugin-api.md §1: "sdk.windows.focus(id):
  // // explicit override"). Bypasses the focus plugin's decide() and applies
  // directly via the seat. id of null clears focus. The 'explicit' decide()
  // reason is reserved for callers that want the plugin's policy to apply --
  // sdk.windows.focus is the unconditional path.
  //
  // Returns null when the seat isn't bound yet (the request is silently
  // dropped) or the surface no longer exists.
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
