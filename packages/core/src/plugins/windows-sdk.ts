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

  // Override the content-layer draw order for a specific output
  // (core-plugin-api.md §1). Pass `null` to clear the override and fall
  // back to the global stack. The workspace plugin (Phase 6) drives this
  // to push the currently-visible workspace's windows per output.
  //
  // Today's single-output system: use OUTPUT_DEFAULT (= 0) as outputId.
  // Multi-output reconfiguration (deferred per status.md) will assign
  // real ids.
  setOutputStack(outputId: number, ids: number[] | null): Promise<void>;

  // Explicit focus override (core-plugin-api.md §1). Bypasses the focus
  // plugin's decide() and immediately moves keyboard focus to `id`
  // (null clears focus). Use for unconditional focus moves (e.g. an IPC
  // action that selects a specific window); for policy-mediated focus
  // changes, emit an event the focus plugin observes.
  focus(id: number | null): Promise<void>;
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
