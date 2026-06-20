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
  outputId: number;
  state: { [key: string]: unknown };
}
interface PluginWindowsLike {
  setState(id: number, key: string, value: unknown): Promise<void>;
  deleteState(id: number, key: string): Promise<void>;
  setOutputStack(outputId: number, ids: number[] | null): Promise<void>;
  requestFocusDecision(reason: FocusReason, trigger?: number): Promise<void>;
  list(): Promise<WindowSnapshotLike[]>;
  onMap(cb: (ev: { surfaceId: number; outputId: number }) => void): void;
  onUnmap(cb: (ev: { surfaceId: number }) => void): void;
}
// Compose + transitions surfaces the plugin uses for animated
// workspace.show. Optional: when the runtime didn't bring them up
// (older harnesses, builds without GPU), the plugin falls back to
// the instant-swap path -- transitions are opt-in by the caller
// AND require runtime support.
interface SceneHandleLike {
  texture: unknown;
  outW: number;
  outH: number;
  id: number;
  release(): Promise<void>;
}
interface PluginComposeLike {
  scene(args: {
    outputId: number;
    windows: readonly number[];
    mode: "snapshot" | "live";
    outW?: number;
    outH?: number;
  }): Promise<SceneHandleLike>;
}
interface PluginTransitionsLike {
  run(opts: {
    outputId: number;
    kind: string;
    duration: number;
    easing?: unknown;
    from: SceneHandleLike;
    to: SceneHandleLike;
    commit?: { setOutputStack?: ReadonlyArray<{ outputId: number; ids: readonly number[] | null }> };
  }): Promise<void>;
}
interface SdkLike {
  readonly name: string;
  log(...args: unknown[]): void;
  registerPlugin<A>(name: string, init: () => Promise<A> | A,
                   opts?: { priority?: number }): Promise<{ unregister(): void }>;
  actions: PluginActionsLike;
  events: PluginEventsLike;
  windows: PluginWindowsLike;
  compose?: PluginComposeLike;
  transitions?: PluginTransitionsLike;
}

// The state-bag key under which each window's owning WorkspaceHandle is
// stored. Other plugins can read it (typed as WorkspaceHandle via the
// workspace-types augmentation in user TS configs).
const STATE_KEY = "workspace.id";

// Helpers: cast a plain number to a branded id at the boundary.
const asIndex = (n: number): WorkspaceIndex => n as WorkspaceIndex;

// Config passed by the core bundled bootstrap (packages/core/src/plugins/
// bundled.ts). The fallback constants are core-owned sentinels; the boot
// durable key is the primary output's durable identifier known to the core
// at plugin-resolution time. Passed through this surface rather than
// imported across packages so the plugin module stays cross-package-clean.
// Tests can pass synthetic values (or omit them entirely).
interface WorkspacePluginConfig {
  // Sentinel outputId for the virtual fallback output (state.fallbackOutput
  // on the core). Workspaces park here when no real output is live. -1 in
  // the core today; the plugin treats it as opaque.
  fallbackOutputId?: number;
  // Durable identifier of the fallback. Used as the preferredOutputs entry
  // for parked workspaces so the resolver treats it like any real output.
  fallbackOutputName?: string;
  // Durable identifier of the boot primary output (edidId when non-empty,
  // else connector name). Seeds the very first workspace's preferredOutputs
  // so the boot output is remembered correctly from frame zero. When empty
  // (test harness without a real output), the registry falls back to a
  // placeholder that the bus output.changed handler will NOT rewrite --
  // preferredOutputs entries are never rewritten by design.
  bootOutputDurableKey?: string;
  // Snapshot of every live output known to the core at plugin-resolution
  // time. Each entry maps an outputId to its durable key. Lets the plugin
  // seed its liveOutputs map without missing the boot enumeration of
  // secondary outputs (the OutputDescriptor burst that introduces them
  // fires BEFORE the plugin runtime spawns, so the plugin can't observe
  // those via subscribe). After seeding the plugin recomputes once so
  // secondary outputs immediately satisfy the ≥1-workspace-per-output
  // invariant. When omitted (test harness), the plugin starts with an
  // empty liveOutputs map and learns outputs lazily from bus events.
  initialOutputs?: ReadonlyArray<{ outputId: number; durableKey: string }>;
}

export default async function init(
  sdk: SdkLike, config?: WorkspacePluginConfig,
): Promise<void> {
  // Resolve fallback config. Empty defaults make this safe to run in
  // non-core harnesses (the recompute will throw if a workspace ever has
  // no live home in such a harness; tests stay clear of that case).
  const fallbackOutputId = config?.fallbackOutputId ?? -1;
  const fallbackOutputName = config?.fallbackOutputName ?? "";
  // The durable identifier of the boot primary output. The core's main.ts
  // populates this from state.outputs[OUTPUT_DEFAULT] before the plugin
  // runtime spawns -- so by the time we initialize the registry, the boot
  // workspace's preferredOutputs entry is the real key (edidId or
  // connector name), not a placeholder. A test harness without core
  // wiring receives "" and we fall back to a stable placeholder; the
  // placeholder remains in preferredOutputs forever (entries are durable),
  // which is fine for tests but would be a small wart in production (the
  // user would never see "boot" as their durable id because main.ts
  // always populates a real one).
  const bootOutputDurableKey = config?.bootOutputDurableKey ?? "";
  const BOOT_OUTPUT_NAME = bootOutputDurableKey !== ""
    ? bootOutputDurableKey
    // Stable placeholder used only in test harnesses that don't wire core.
    // Never overwritten (the design forbids rewrites of durable identifiers).
    : "boot";

  // Live output identifiers, kept in sync via output.added / output.removed /
  // output.changed. Maps outputId -> durable key (edidId when non-empty,
  // else name). Used by recomputeOutputs to resolve preferredOutputs entries
  // to a live outputId on every hotplug.
  const liveOutputs = new Map<number, string>();
  function outputNameOf(outputId: number): string {
    return liveOutputs.get(outputId) ?? BOOT_OUTPUT_NAME;
  }
  // Pick the durable key for an output: prefer edidId when non-empty (stable
  // across port swaps); fall back to name when EDID is unreadable. Matches
  // the "two durable keys checked in order" rule from multi-output-design §3.
  function durableKeyOf(p: { edidId?: unknown; name?: unknown }): string | null {
    if (typeof p.edidId === "string" && p.edidId.length > 0) return p.edidId;
    if (typeof p.name === "string" && p.name.length > 0) return p.name;
    return null;
  }
  // Subscribe BEFORE init so a synchronous emit during startup doesn't drop.
  sdk.events.subscribe("output.changed", (_name, payload) => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as { outputId?: unknown };
    if (typeof p.outputId !== "number") return;
    const key = durableKeyOf(payload as { edidId?: unknown; name?: unknown });
    if (key !== null) liveOutputs.set(p.outputId, key);
  });
  // Guard against hotplug events that arrive between subscribe() and reg.init
  // returning. reg.init runs synchronously right below; in practice nothing
  // emits during that window, but the closure references `state` so a hotplug
  // landing too early would dereference undefined.
  let stateReady = false;
  // M7 hotplug: workspace migration on add / remove.
  sdk.events.subscribe("output.added", (_name, payload) => {
    if (!stateReady) return;
    if (!payload || typeof payload !== "object") return;
    const p = payload as { outputId?: unknown };
    if (typeof p.outputId !== "number") return;
    const key = durableKeyOf(payload as { edidId?: unknown; name?: unknown });
    if (key === null) return;
    liveOutputs.set(p.outputId, key);
    const r = reg.recomputeOutputs(
      state, liveOutputs, fallbackOutputId, fallbackOutputName);
    state = r.state;
    void applyEffects(r.sideEffects);
  });
  sdk.events.subscribe("output.pre-remove", (_name, payload) => {
    if (!stateReady) return;
    if (!payload || typeof payload !== "object") return;
    const p = payload as { outputId?: unknown };
    if (typeof p.outputId !== "number") return;
    const key = durableKeyOf(payload as { edidId?: unknown; name?: unknown });
    if (key === null) return;
    // Refresh lastActiveByOutputName one last time, while the output is
    // still in our liveOutputs map and has a shown workspace. The design
    // (§10 "Active workspace memory") calls this out specifically: focus
    // changes during the output's lifetime may not have routed through a
    // workspace.show() call (e.g. shown by ensureOutput on first map), so
    // we record the current shown here as the definitive last-active.
    const shown = state.shownByOutput.get(p.outputId);
    if (shown !== undefined) {
      state.lastActiveByOutputName.set(key, shown);
    }
    // Migration runs on output.removed below (after core has updated its
    // state.outputs); doing it here would race the residency diff and the
    // destroyGlobalForOutput step in hotplug.ts.
  });
  sdk.events.subscribe("output.removed", (_name, payload) => {
    if (!stateReady) return;
    if (!payload || typeof payload !== "object") return;
    const p = payload as { outputId?: unknown };
    if (typeof p.outputId !== "number") return;
    liveOutputs.delete(p.outputId);
    const r = reg.recomputeOutputs(
      state, liveOutputs, fallbackOutputId, fallbackOutputName);
    state = r.state;
    void applyEffects(r.sideEffects);
  });

  const r0 = reg.init(BOOT_OUTPUT_NAME);
  let state: WorkspaceState = r0.state;
  stateReady = true;

  // Seed liveOutputs from the boot snapshot the core passed in. The boot
  // OutputDescriptor burst happens before the plugin runtime spawns, so
  // we cannot observe the resulting output.added emits via subscribe;
  // initialOutputs is the catch-up mechanism. After seeding we run a
  // recompute so the donor invariant creates a fresh workspace on every
  // secondary output (the boot workspace already lives on the primary).
  let bootRecomputeEffects: SideEffect[] = [];
  if (config?.initialOutputs && config.initialOutputs.length > 0) {
    for (const o of config.initialOutputs) {
      if (o.durableKey !== "") liveOutputs.set(o.outputId, o.durableKey);
    }
    const r = reg.recomputeOutputs(
      state, liveOutputs, fallbackOutputId, fallbackOutputName);
    state = r.state;
    bootRecomputeEffects = r.sideEffects;
  }

  // Apply each side effect against the SDK. Errors from SDK calls bubble up;
  // the registry's invariants are preserved either way (state is updated
  // synchronously before effects fire).
  //
  // skipKinds: side-effect kinds to omit (used by the transition path,
  // which applies setOutputStack atomically via the transition's commit
  // payload + defers requestFocusDecision until after the run resolves).
  async function applyEffects(
    effects: SideEffect[],
    skipKinds: ReadonlySet<SideEffect["kind"]> = new Set(),
  ): Promise<void> {
    for (const e of effects) {
      if (skipKinds.has(e.kind)) continue;
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

  // Animated workspace.show: capture FROM + TO scene snapshots, run
  // the transition with a setOutputStack commit that fires atomically
  // with completion, then defer focus-decide until after.
  //
  // Falls back to caller's responsibility: if sdk.compose or
  // sdk.transitions is absent (runtime didn't bring them up), the
  // caller's transition param was honored but we have nothing to
  // run -- throw a clear error so the caller knows the runtime
  // doesn't support it. (Plain instant show is reached via NOT
  // passing a transition.)
  async function showWithTransition(
    index: WorkspaceIndex, outputId: number, t: ShowTransitionSpec,
  ): Promise<void> {
    if (!sdk.compose || !sdk.transitions) {
      throw new Error(
        "workspace.show: transition requested but the runtime didn't " +
        "wire sdk.compose + sdk.transitions (need an in-thread bundled " +
        "plugin path with the transitions broker + scene registry).");
    }
    // Capture the FROM stack (what's on screen now).
    const fromIds = reg.stackFor(state, outputId);
    // Mutate state to produce the TO stack + the rest of the show's
    // side effects. The setOutputStack effect carries the TO ids; we
    // extract it and skip the normal apply because the transition's
    // commit will apply it atomically with completion.
    const r = reg.show(state, index, outputId, outputNameOf(outputId));
    state = r.state;
    const setStackEffect = r.sideEffects.find(
      (e): e is Extract<SideEffect, { kind: "setOutputStack" }> =>
        e.kind === "setOutputStack" && e.outputId === outputId);
    const toIds = setStackEffect ? setStackEffect.ids : [];
    // Apply all OTHER side effects normally (emit hidden/shown,
    // setStateBag, etc.). Skip setOutputStack (commit owns it) and
    // requestFocusDecision (deferred to after-run).
    await applyEffects(r.sideEffects, new Set(["setOutputStack", "requestFocusDecision"]));

    // Capture snapshots. compose.scene without outW/outH defaults to
    // the compositor's output dims, which is what the transition
    // shader expects.
    const fromScene = await sdk.compose.scene({
      outputId, mode: "snapshot", windows: fromIds,
    });
    let toScene: SceneHandleLike | null = null;
    try {
      toScene = await sdk.compose.scene({
        outputId, mode: "snapshot", windows: toIds ?? [],
      });
      // Run the transition. The broker applies the commit's
      // setOutputStack synchronously inside the completion tick, so
      // the very next renderFrame draws the TO stack via the normal
      // composite path. easing is optional and passed through.
      const runOpts: Parameters<PluginTransitionsLike["run"]>[0] = {
        outputId, kind: t.kind, duration: t.duration,
        from: fromScene, to: toScene,
        commit: { setOutputStack: [{ outputId, ids: toIds ?? [] }] },
      };
      if (t.easing !== undefined) runOpts.easing = t.easing;
      await sdk.transitions.run(runOpts);
    } finally {
      // Release scenes regardless of throw / success. The transitions
      // broker unpins on completion (or on its install-time throw);
      // the registry's deferred teardown only frees the underlying
      // surfaceBuf after the last pin drops, so release() now is safe.
      await fromScene.release();
      if (toScene) await toScene.release();
    }
    // Now fire the deferred focus-decide. requestFocusDecision is
    // fire-and-forget on the focus driver's per-event sequence
    // machinery.
    const focusEffect = r.sideEffects.find(
      (e): e is Extract<SideEffect, { kind: "requestFocusDecision" }> =>
        e.kind === "requestFocusDecision");
    if (focusEffect) {
      await sdk.windows.requestFocusDecision(focusEffect.reason);
    }
  }

  // Emit the boot-time workspace.created for workspace 1, plus any side
  // effects from the boot-time recompute (donor-replenishment workspaces
  // for secondary outputs, setOutputStack for each, etc.). Subscribers
  // that attached before plugin init see these; status bars / IPC
  // listeners that attach later observe via list/current.
  await applyEffects(r0.sideEffects);
  await applyEffects(bootRecomputeEffects);

  // Seed membership from windows that are already mapped at plugin init
  // (defensive: bundled plugins load before any client maps in practice, so
  // this is usually empty, but the runtime makes no such guarantee).
  const existing = await sdk.windows.list();
  for (const w of existing) {
    const r = reg.applyMap(state, w.surfaceId, w.outputId, outputNameOf(w.outputId));
    state = r.state;
    await applyEffects(r.sideEffects);
  }

  // Map/unmap drive workspace membership. The map event carries the WM's
  // assigned outputId; the plugin honors that as the window's home output.
  sdk.windows.onMap((ev) => {
    const r = reg.applyMap(state, ev.surfaceId, ev.outputId, outputNameOf(ev.outputId));
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
      const outId = p.outputId ?? reg.OUTPUT_DEFAULT;
      const r = reg.create(state, p, outputNameOf(outId));
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
      const r = reg.destroy(state, p.index, p.outputId, outputNameOf(p.outputId));
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.show",
    description: "Make the workspace at the given index (or matching name) the visible one.",
    handler: async (params: unknown): Promise<null> => {
      const p = parseIndexOrNameParams(state, params, "workspace.show");
      const t = parseShowTransition(params, "workspace.show");
      if (t) {
        await showWithTransition(p.index, p.outputId, t);
        return null;
      }
      const r = reg.show(state, p.index, p.outputId, outputNameOf(p.outputId));
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.move-window",
    description: "Move a window to the workspace at the given index (or matching name).",
    handler: async (params: unknown): Promise<null> => {
      const p = parseMoveParams(state, params);
      const r = reg.moveWindow(state, p.surfaceId, p.index, p.outputId, outputNameOf(p.outputId));
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
      const outId = spec?.outputId ?? reg.OUTPUT_DEFAULT;
      const r = reg.create(state, spec ?? {}, outputNameOf(outId));
      state = r.state;
      await applyEffects(r.sideEffects);
      return r.snapshot;
    },
    async destroy(index, outputId): Promise<void> {
      const outId = outputId ?? reg.OUTPUT_DEFAULT;
      const r = reg.destroy(state, index, outId, outputNameOf(outId));
      state = r.state;
      await applyEffects(r.sideEffects);
    },
    async show(index, outputId, transition): Promise<void> {
      if (transition) {
        await showWithTransition(
          index, outputId ?? 0,
          { kind: transition.kind, duration: transition.duration, easing: transition.easing },
        );
        return;
      }
      const outId = outputId ?? reg.OUTPUT_DEFAULT;
      const r = reg.show(state, index, outId, outputNameOf(outId));
      state = r.state;
      await applyEffects(r.sideEffects);
    },
    async moveWindow(surfaceId, index, outputId): Promise<void> {
      const outId = outputId ?? reg.OUTPUT_DEFAULT;
      const r = reg.moveWindow(state, surfaceId, index, outId, outputNameOf(outId));
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
    async reorder(surfaceId, op): Promise<boolean> {
      const r = reg.reorder(state, surfaceId, op);
      state = r.state;
      await applyEffects(r.sideEffects);
      return r.changed;
    },
    async ensureOutput(outputId): Promise<WorkspaceSnapshot> {
      // Idempotent: if outputId already has any workspaces, return the
      // shown one; otherwise create workspace 1 there (no extra workspaces
      // appended). Useful for callers that need to land a window on an
      // output that hasn't been touched yet (e.g. window.move-to-output
      // when the target output has no windows of its own).
      const r = reg.ensureOutput(state, outputId, outputNameOf(outputId));
      state = r.state;
      await applyEffects(r.sideEffects);
      const cur = reg.current(state, outputId);
      if (!cur) throw new Error(`ensureOutput: no shown workspace on output ${outputId}`);
      return cur;
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

function parseCreateParams(params: unknown): {
  name?: string; outputId?: number; preferredOutputs?: string[];
} {
  if (params === undefined || params === null) return {};
  if (!isObj(params)) throw new TypeError("workspace.create: expected an object");
  const out: { name?: string; outputId?: number; preferredOutputs?: string[] } = {};
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
  if (params.preferredOutputs !== undefined) {
    if (!Array.isArray(params.preferredOutputs)
        || !params.preferredOutputs.every((n): n is string => typeof n === "string")) {
      throw new TypeError(
        "workspace.create: preferredOutputs must be an array of strings");
    }
    out.preferredOutputs = params.preferredOutputs;
  }
  return out;
}

// Parse params that strictly identify a workspace by its 1-based
// index. Used by destroy + set-name (where adding name lookup would
// be ambiguous with the value being set).
function parseIndexParams(params: unknown, label: string,
                          ): { index: WorkspaceIndex; outputId: number } {
  if (!isObj(params)) {
    throw new TypeError(`${label}: expected an object with { index, outputId? }`);
  }
  if (typeof params.index !== "number" || !Number.isInteger(params.index)
      || params.index < 1) {
    throw new TypeError(`${label}: index must be a positive integer`);
  }
  return { index: asIndex(params.index), outputId: parseOptionalOutputId(params) };
}

// Parse params that identify a workspace EITHER by 1-based index OR by
// display name. Exactly one must be set (both is ambiguous; neither is
// missing). When `name` is set, the registry's findIndexByName resolves
// it to an index at parse time (so the rest of the handler treats it
// uniformly). A name that doesn't match any workspace throws.
function parseIndexOrNameParams(
  state: WorkspaceState, params: unknown, label: string,
): { index: WorkspaceIndex; outputId: number } {
  if (!isObj(params)) {
    throw new TypeError(`${label}: expected an object with { index | name, outputId? }`);
  }
  const outputId = parseOptionalOutputId(params);
  const hasIndex = params.index !== undefined;
  const hasName = params.name !== undefined;
  if (hasIndex && hasName) {
    throw new TypeError(`${label}: pass either index or name, not both`);
  }
  if (!hasIndex && !hasName) {
    throw new TypeError(`${label}: missing required field 'index' or 'name'`);
  }
  if (hasIndex) {
    if (typeof params.index !== "number" || !Number.isInteger(params.index)
        || params.index < 1) {
      throw new TypeError(`${label}: index must be a positive integer`);
    }
    return { index: asIndex(params.index), outputId };
  }
  if (typeof params.name !== "string" || params.name.length === 0) {
    throw new TypeError(`${label}: name must be a non-empty string`);
  }
  const resolved = reg.findIndexByName(state, params.name, outputId);
  if (resolved === null) {
    throw new Error(
      `${label}: no workspace named '${params.name}' on output ${outputId}`);
  }
  return { index: resolved, outputId };
}

// Optional transition spec for workspace.show (and friends). When the
// caller passes this, the plugin captures FROM and TO scene snapshots
// + invokes sdk.transitions.run with a setOutputStack commit. When
// absent (or when the runtime didn't bring up sdk.transitions),
// workspace.show is an instant swap.
interface ShowTransitionSpec {
  kind: string;
  duration: number;
  easing?: unknown;
}
function parseShowTransition(params: unknown, label: string): ShowTransitionSpec | null {
  if (!isObj(params)) return null;
  const t = (params as { transition?: unknown }).transition;
  if (t === undefined || t === null) return null;
  if (!isObj(t)) {
    throw new TypeError(`${label}: transition must be an object`);
  }
  if (typeof t.kind !== "string") {
    throw new TypeError(`${label}: transition.kind must be a string`);
  }
  if (typeof t.duration !== "number" || !(t.duration > 0)) {
    throw new TypeError(
      `${label}: transition.duration must be > 0 (got ${String(t.duration)})`);
  }
  return {
    kind: t.kind,
    duration: t.duration,
    easing: (t as { easing?: unknown }).easing,
  };
}

function parseMoveParams(state: WorkspaceState, params: unknown,
                         ): { surfaceId: number; index: WorkspaceIndex; outputId: number } {
  const base = parseIndexOrNameParams(state, params, "workspace.move-window");
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
