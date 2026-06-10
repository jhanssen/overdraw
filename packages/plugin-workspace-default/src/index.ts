// Bundled workspace plugin. Registers in the 'workspace' namespace at
// priority 0 (the floor; bundled default). Exposes the workspace action
// surface; emits workspace.* events on the bus; maintains the per-window
// 'workspace.id' state-bag entry; pushes setOutputStack as the active
// workspace's membership changes.

import type {
  WorkspaceAPI, WorkspaceHandle, WorkspaceIndex, WorkspaceSnapshot,
} from "@overdraw/workspace-types";
import type { FocusReason } from "@overdraw/focus-types";
import * as reg from "./registry.js";
import type { SideEffect, WorkspaceState } from "./registry.js";

// Minimal plugin SDK shape we depend on. Same pattern as the bundled focus +
// layout plugins -- the plugin's runtime SDK comes from the bootstrap; we
// declare only what we use.
interface ActionRegisterSpec {
  name: string;
  description?: string;
  handler: (params: unknown) => unknown | Promise<unknown>;
}
interface ActionRegistration { unregister(): void }
interface PluginActionsLike {
  register(spec: ActionRegisterSpec): ActionRegistration;
}
interface EventSubscription { off(): void }
interface PluginEventsLike {
  emit(name: string, payload: unknown): void;
  subscribe(pattern: string, cb: (name: string, payload: unknown) => void): EventSubscription;
}
interface WindowSnapshotLike {
  surfaceId: number;
  state: { [key: string]: unknown };
}
interface PluginWindowsLike {
  setState(id: number, key: string, value: unknown): Promise<void>;
  deleteState(id: number, key: string): Promise<void>;
  setOutputStack(outputId: number, ids: number[] | null): Promise<void>;
  requestFocusDecision(reason: FocusReason, trigger?: number): Promise<void>;
  list(): Promise<WindowSnapshotLike[]>;
  onMap(cb: (ev: { surfaceId: number }) => void): void;
  onUnmap(cb: (ev: { surfaceId: number }) => void): void;
}
interface SdkLike {
  readonly name: string;
  log(...args: unknown[]): void;
  registerPlugin<A>(name: string, init: () => Promise<A> | A,
                   opts?: { priority?: number }): Promise<{ unregister(): void }>;
  actions: PluginActionsLike;
  events: PluginEventsLike;
  windows: PluginWindowsLike;
}

// The state-bag key under which each window's owning WorkspaceHandle is
// stored. Other plugins can read it (typed as WorkspaceHandle via the
// workspace-types augmentation in user TS configs).
const STATE_KEY = "workspace.id";

// Helpers: cast a plain number to a branded id at the boundary.
const asIndex = (n: number): WorkspaceIndex => n as WorkspaceIndex;

export default async function init(sdk: SdkLike, _config?: unknown): Promise<void> {
  const r0 = reg.init();
  let state: WorkspaceState = r0.state;

  // Apply each side effect against the SDK. Errors from SDK calls bubble up;
  // the registry's invariants are preserved either way (state is updated
  // synchronously before effects fire).
  async function applyEffects(effects: SideEffect[]): Promise<void> {
    for (const e of effects) {
      switch (e.kind) {
        case "setOutputStack":
          await sdk.windows.setOutputStack(e.outputId, e.ids);
          break;
        case "setStateBag":
          await sdk.windows.setState(e.surfaceId, STATE_KEY, e.handle);
          break;
        case "deleteStateBag":
          await sdk.windows.deleteState(e.surfaceId, STATE_KEY);
          break;
        case "requestFocusDecision":
          await sdk.windows.requestFocusDecision(e.reason);
          break;
        case "emit":
          sdk.events.emit(e.name, e.payload);
          break;
      }
    }
  }

  // Emit the boot-time workspace.created for workspace 1. Subscribers that
  // attached before plugin init see this; status bars / IPC listeners that
  // attach later observe the workspace via list/current.
  await applyEffects(r0.sideEffects);

  // Seed membership from windows that are already mapped at plugin init
  // (defensive: bundled plugins load before any client maps in practice, so
  // this is usually empty, but the runtime makes no such guarantee).
  const existing = await sdk.windows.list();
  for (const w of existing) {
    const r = reg.applyMap(state, w.surfaceId);
    state = r.state;
    await applyEffects(r.sideEffects);
  }

  // Map/unmap drive workspace membership.
  sdk.windows.onMap((ev) => {
    const r = reg.applyMap(state, ev.surfaceId);
    state = r.state;
    void applyEffects(r.sideEffects);
  });
  sdk.windows.onUnmap((ev) => {
    const r = reg.applyUnmap(state, ev.surfaceId);
    state = r.state;
    void applyEffects(r.sideEffects);
  });

  // ---- Actions -----------------------------------------------------------
  // Each handler validates its params (the trust boundary -- the IPC layer
  // doesn't validate against per-action schemas yet).

  sdk.actions.register({
    name: "workspace.create",
    description: "Append a new workspace; returns its snapshot.",
    handler: async (params: unknown): Promise<WorkspaceSnapshot> => {
      const p = parseCreateParams(params);
      const r = reg.create(state, p);
      state = r.state;
      await applyEffects(r.sideEffects);
      return r.snapshot;
    },
  });

  sdk.actions.register({
    name: "workspace.destroy",
    description: "Destroy the workspace at the given index; renumbers + relocates members.",
    handler: async (params: unknown): Promise<null> => {
      const p = parseIndexParams(params, "workspace.destroy");
      const r = reg.destroy(state, p.index, p.outputId);
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.show",
    description: "Make the workspace at the given index the visible one.",
    handler: async (params: unknown): Promise<null> => {
      const p = parseIndexParams(params, "workspace.show");
      const r = reg.show(state, p.index, p.outputId);
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.move-window",
    description: "Move a window to the workspace at the given index.",
    handler: async (params: unknown): Promise<null> => {
      const p = parseMoveParams(params);
      const r = reg.moveWindow(state, p.surfaceId, p.index, p.outputId);
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.set-name",
    description: "Set or clear a workspace's display name.",
    handler: async (params: unknown): Promise<null> => {
      const p = parseSetNameParams(params);
      const r = reg.setName(state, p.index, p.name, p.outputId);
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.list",
    description: "All workspaces on the given output, sorted by index.",
    handler: async (params: unknown): Promise<WorkspaceSnapshot[]> => {
      const outputId = parseOptionalOutputId(params);
      return reg.snapshotsForOutput(state, outputId);
    },
  });

  sdk.actions.register({
    name: "workspace.current",
    description: "The currently-shown workspace on the given output.",
    handler: async (params: unknown): Promise<WorkspaceSnapshot | null> => {
      const outputId = parseOptionalOutputId(params);
      return reg.current(state, outputId);
    },
  });

  // ---- Namespace API ----------------------------------------------------
  // Same surface as actions, but typed (consumed by other plugins via
  // sdk.plugin('workspace')).

  const api: WorkspaceAPI = {
    async create(spec): Promise<WorkspaceSnapshot> {
      const r = reg.create(state, spec ?? {});
      state = r.state;
      await applyEffects(r.sideEffects);
      return r.snapshot;
    },
    async destroy(index, outputId): Promise<void> {
      const r = reg.destroy(state, index, outputId);
      state = r.state;
      await applyEffects(r.sideEffects);
    },
    async show(index, outputId): Promise<void> {
      const r = reg.show(state, index, outputId);
      state = r.state;
      await applyEffects(r.sideEffects);
    },
    async moveWindow(surfaceId, index, outputId): Promise<void> {
      const r = reg.moveWindow(state, surfaceId, index, outputId);
      state = r.state;
      await applyEffects(r.sideEffects);
    },
    async setName(index, name, outputId): Promise<void> {
      const r = reg.setName(state, index, name, outputId);
      state = r.state;
      await applyEffects(r.sideEffects);
    },
    async list(outputId): Promise<WorkspaceSnapshot[]> {
      return reg.snapshotsForOutput(state, outputId ?? reg.OUTPUT_DEFAULT);
    },
    async current(outputId): Promise<WorkspaceSnapshot | null> {
      return reg.current(state, outputId);
    },
  };

  await sdk.registerPlugin("workspace", () => api);
  sdk.log("workspace plugin registered");
}

// ---- Param parsers -------------------------------------------------------
// IPC / action callers send JSON-shaped objects; resolve to the branded
// types the registry uses. Throws TypeError on shape mismatch.

function isObj(v: unknown): v is { [k: string]: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseOptionalOutputId(params: unknown): number {
  if (params === undefined || params === null) return reg.OUTPUT_DEFAULT;
  if (!isObj(params)) {
    throw new TypeError("expected an object or null for params");
  }
  const o = params.outputId;
  if (o === undefined) return reg.OUTPUT_DEFAULT;
  if (typeof o !== "number") throw new TypeError("outputId must be a number");
  return o;
}

function parseCreateParams(params: unknown): { name?: string; outputId?: number } {
  if (params === undefined || params === null) return {};
  if (!isObj(params)) throw new TypeError("workspace.create: expected an object");
  const out: { name?: string; outputId?: number } = {};
  if (params.name !== undefined) {
    if (typeof params.name !== "string") {
      throw new TypeError("workspace.create: name must be a string");
    }
    out.name = params.name;
  }
  if (params.outputId !== undefined) {
    if (typeof params.outputId !== "number") {
      throw new TypeError("workspace.create: outputId must be a number");
    }
    out.outputId = params.outputId;
  }
  return out;
}

function parseIndexParams(params: unknown, label: string,
                          ): { index: WorkspaceIndex; outputId: number } {
  if (!isObj(params)) {
    throw new TypeError(`${label}: expected an object with { index, outputId? }`);
  }
  if (typeof params.index !== "number" || !Number.isInteger(params.index) || params.index < 1) {
    throw new TypeError(`${label}: index must be a positive integer`);
  }
  return { index: asIndex(params.index), outputId: parseOptionalOutputId(params) };
}

function parseMoveParams(params: unknown,
                         ): { surfaceId: number; index: WorkspaceIndex; outputId: number } {
  const base = parseIndexParams(params, "workspace.move-window");
  if (!isObj(params)) throw new TypeError("unreachable");
  if (typeof params.surfaceId !== "number") {
    throw new TypeError("workspace.move-window: surfaceId must be a number");
  }
  return { surfaceId: params.surfaceId, index: base.index, outputId: base.outputId };
}

function parseSetNameParams(params: unknown,
                            ): { index: WorkspaceIndex; name: string | undefined; outputId: number } {
  const base = parseIndexParams(params, "workspace.set-name");
  if (!isObj(params)) throw new TypeError("unreachable");
  let name: string | undefined;
  if (params.name === undefined || params.name === null) {
    name = undefined;
  } else if (typeof params.name === "string") {
    name = params.name;
  } else {
    throw new TypeError("workspace.set-name: name must be a string, null, or undefined");
  }
  return { index: base.index, name, outputId: base.outputId };
}

// Silence unused-warning for the WorkspaceHandle import (it's part of the
// runtime contract via state-bag entries but the type isn't referenced in
// signatures here).
type _UnusedHandle = WorkspaceHandle;
