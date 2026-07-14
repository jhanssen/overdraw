// Canvas workspace provider (docs/canvas-design.md). Registers in the
// 'workspace' namespace at priority 0 with the same verb/event/action
// surface as @overdraw/plugin-workspace-default, whose registry (the pure
// workspace state machine) it shares. On top of that surface it publishes
// each output's shown workspace as an explicit layout island (id = the
// workspace's durable handle, rect = null so the tile region derives from
// the output minus reserved zones, members = the pushed stack) -- so
// layouts see per-workspace island identity while on-screen behavior
// matches the default plugin exactly. World positions, camera policy, and
// bookmarks build on this island seam.

import type {
  WorkspaceAPI, WorkspaceHandle, WorkspaceIndex, WorkspaceSnapshot,
} from "@overdraw/workspace-types";
import type {
  PluginSdkShape, SceneHandleLike, PluginTransitionsLike,
} from "@overdraw/plugin-sdk-types";
import * as reg from "@overdraw/plugin-workspace-default/registry";
import type { SideEffect, WorkspaceState } from "@overdraw/plugin-workspace-default/registry";

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
interface CanvasPluginConfig {
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
  // time. Each entry carries the connector name and EDID-derived id
  // separately so user-supplied output strings can be resolved against
  // either alias. Lets the plugin seed its liveOutputs + alias maps
  // without missing the boot enumeration of secondary outputs (the
  // OutputDescriptor burst that introduces them fires BEFORE the
  // plugin runtime spawns, so the plugin can't observe those via
  // subscribe). After seeding the plugin recomputes once so secondary
  // outputs immediately satisfy the ≥1-workspace-per-output invariant.
  // When omitted (test harness), the plugin starts with empty maps and
  // learns outputs lazily from bus events.
  initialOutputs?: ReadonlyArray<{ outputId: number; name: string; edidId: string }>;
  // The user's `canvas` config slice (verbatim). No options yet: parity
  // mode has no knobs; the slice's presence is what selects this plugin.
  canvas?: unknown;
}

export default async function init(
  sdk: PluginSdkShape, config?: CanvasPluginConfig,
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
  // Parallel map tracking both connector name (e.g. "DP-1") and EDID id for
  // each live output. Used by resolveOutputName so user-supplied strings
  // can match against either identifier -- a user typing "DP-1" in a
  // config keybind should not have to know the EDID string.
  const outputAliasesById = new Map<number, { name: string; edidId: string }>();
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
  // Extract a payload's name + edidId for the aliases map. Unknown values
  // default to "" -- the resolver skips empties.
  function aliasesOf(p: { name?: unknown; edidId?: unknown }): { name: string; edidId: string } {
    return {
      name: typeof p.name === "string" ? p.name : "",
      edidId: typeof p.edidId === "string" ? p.edidId : "",
    };
  }
  // Resolve a user-supplied output identifier (e.g. "DP-1", or an EDID
  // string) to its live outputId. Tries each alias on each output; returns
  // the first match. Null when no live output matches the input. Empty
  // input never matches (an output's empty name/edidId are not addressable
  // by name).
  function resolveOutputName(input: string): number | null {
    if (input === "") return null;
    for (const [outputId, alias] of outputAliasesById) {
      if (alias.name === input || alias.edidId === input) return outputId;
    }
    return null;
  }
  // The output currently containing the keyboard-focused window. Tracks
  // window.change events whose `activated: true` field carries the new
  // focus. When the focused window unmaps or the workspace it's on is
  // hidden, the last-known focused output is retained -- so a hotkey
  // pressed on an empty workspace still resolves to the output the user
  // was last interacting with. Falls back to OUTPUT_DEFAULT when no
  // focus has ever been observed (test harness or boot-time keybind).
  let focusedSurfaceId: number | null = null;
  let focusedOutputIdCache = reg.OUTPUT_DEFAULT;
  function focusedOutputId(): number {
    return focusedOutputIdCache;
  }
  // Subscribe BEFORE init so a synchronous emit during startup doesn't drop.
  sdk.events.subscribe("output.changed", (_name, payload) => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as { outputId?: unknown };
    if (typeof p.outputId !== "number") return;
    const key = durableKeyOf(payload as { edidId?: unknown; name?: unknown });
    if (key !== null) liveOutputs.set(p.outputId, key);
    outputAliasesById.set(p.outputId, aliasesOf(payload as { name?: unknown; edidId?: unknown }));
  });
  // Keyboard focus tracking. Each window.change carries activated: bool; a
  // surface becoming activated is our signal that its output is the
  // user-facing focused output. When the focused surface unmaps (no
  // explicit "loses activation" event arrives), the cache retains the
  // last-known output so a hotkey on an empty workspace still targets
  // where the user was working.
  sdk.events.subscribe("window.change", (_name, payload) => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as { surfaceId?: unknown; activated?: unknown; changed?: unknown };
    if (typeof p.surfaceId !== "number") return;
    if (typeof p.activated !== "boolean") return;
    // Only react to events that actually carry an activation transition;
    // a window.change for a pure title/appId update may not have its
    // activated bit toggling.
    const changed = Array.isArray(p.changed) ? p.changed as unknown[] : [];
    if (!changed.includes("activated")) return;
    if (p.activated) {
      focusedSurfaceId = p.surfaceId;
      // Resolve surface -> workspace -> output. If the surface isn't
      // tracked (unmapped, layer-shell, popup) leave the cache as-is.
      const handle = state.surfaceToHandle.get(p.surfaceId);
      if (handle !== undefined) {
        const rec = state.byHandle.get(handle);
        if (rec) focusedOutputIdCache = rec.outputId;
      }
    } else if (focusedSurfaceId === p.surfaceId) {
      focusedSurfaceId = null;
      // Keep focusedOutputIdCache: the focus departed but the user's
      // pointer/keyboard is still anchored on that output.
    }
  });
  // Guard against hotplug events that arrive between subscribe() and reg.init
  // returning. reg.init runs synchronously right below; in practice nothing
  // emits during that window, but the closure references `state` so a hotplug
  // landing too early would dereference undefined.
  let stateReady = false;
  // Workspace migration on hotplug add / remove.
  sdk.events.subscribe("output.added", (_name, payload) => {
    if (!stateReady) return;
    if (!payload || typeof payload !== "object") return;
    const p = payload as { outputId?: unknown };
    if (typeof p.outputId !== "number") return;
    const key = durableKeyOf(payload as { edidId?: unknown; name?: unknown });
    if (key === null) return;
    liveOutputs.set(p.outputId, key);
    outputAliasesById.set(p.outputId, aliasesOf(payload as { name?: unknown; edidId?: unknown }));
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
    outputAliasesById.delete(p.outputId);
    // Focus may have been on this output; reset to OUTPUT_DEFAULT so the
    // next action targets a live output rather than the vanished one.
    if (focusedOutputIdCache === p.outputId) {
      focusedOutputIdCache = reg.OUTPUT_DEFAULT;
      focusedSurfaceId = null;
    }
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
      const durable = durableKeyOf(o);
      if (durable !== null) liveOutputs.set(o.outputId, durable);
      outputAliasesById.set(o.outputId, { name: o.name, edidId: o.edidId });
    }
    const r = reg.recomputeOutputs(
      state, liveOutputs, fallbackOutputId, fallbackOutputName);
    state = r.state;
    bootRecomputeEffects = r.sideEffects;
  }

  // One explicit island per output: the shown workspace's durable handle +
  // the exact stack pushed for it. Updated wherever a stack lands (the
  // setOutputStack side effect, or a transition's commit) and mirrored to
  // the WM, which schedules a relayout only when the set actually changed.
  // rect stays null in parity mode: the tile region derives from the
  // output minus reserved zones, exactly like the implicit island -- the
  // only observable delta is the island id layouts can key state on.
  const islandByOutput = new Map<
    number, { id: number; outputId: number; rect: null; members: number[] }>();
  async function updateIsland(outputId: number, ids: readonly number[] | null): Promise<void> {
    if (ids === null) {
      if (!islandByOutput.delete(outputId)) return;
    } else {
      const shown = state.shownByOutput.get(outputId);
      if (shown === undefined) return;
      islandByOutput.set(outputId,
        { id: shown, outputId, rect: null, members: [...ids] });
    }
    const list = [...islandByOutput.values()]
      .sort((a, b) => a.outputId - b.outputId);
    await sdk.windows.setIslands(list);
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
          await updateIsland(e.outputId, e.ids);
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
      // The commit applied the TO stack inside the completion tick,
      // bypassing applyEffects; publish the matching island now.
      await updateIsland(outputId, toIds ?? []);
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
    // Unplaced windows (no layout pass yet) seed onto the fallback output;
    // the workspace recompute re-homes them once a real output claims them.
    const outId = w.outputId ?? fallbackOutputId;
    const r = reg.applyMap(state, w.surfaceId, outId, outputNameOf(outId));
    state = r.state;
    await applyEffects(r.sideEffects);
  }

  // Map/unmap drive workspace membership. The map event carries the WM's
  // assigned outputId; the plugin honors that as the window's home output.
  // Placement happens here, at first content -- after the WM has resolved the
  // window's tiling lane -- so a floating window never joins the tiled stack.
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

  // A client asked to go fullscreen on a specific output (xdg_toplevel
  // .set_fullscreen with an output arg). Output placement is ours, so move the
  // window to that output's shown workspace; the WM already flagged it
  // exclusive=fullscreen and fullscreens it on whichever output it lands on.
  sdk.events.subscribe("window.fullscreen-output-request", (_name, payload) => {
    const p = payload as { surfaceId?: unknown; outputId?: unknown };
    if (typeof p.surfaceId !== "number" || typeof p.outputId !== "number") return;
    const outputId = p.outputId;
    const shown = state.shownByOutput.get(outputId);
    if (shown === undefined) return;
    const index = (state.positionsByOutput.get(outputId) ?? []).indexOf(shown);
    if (index < 0) return;
    // moveWindow throws if the surface isn't tracked yet (request arrived before
    // the map settled); ignore -- the window stays on its current output.
    try {
      const r = reg.moveWindow(state, p.surfaceId, asIndex(index), outputId, outputNameOf(outputId));
      state = r.state;
      void applyEffects(r.sideEffects);
    } catch { /* untracked surface; leave it where it is */ }
  });

  // ---- Actions -----------------------------------------------------------
  // Each handler validates its params (the trust boundary -- the IPC layer
  // doesn't validate against per-action schemas yet).

  sdk.actions.register({
    name: "workspace.create",
    description:
      "Append a new workspace on the given output (defaults to the focused output); returns its snapshot.",
    handler: async (params: unknown): Promise<WorkspaceSnapshot> => {
      const p = parseCreateParams(params, resolveOutputName, focusedOutputId());
      const r = reg.create(state, p, outputNameOf(p.outputId));
      state = r.state;
      await applyEffects(r.sideEffects);
      return r.snapshot;
    },
  });

  sdk.actions.register({
    name: "workspace.destroy",
    description:
      "Destroy the workspace at the given per-output index on the given output (defaults to the focused output); renumbers + relocates members.",
    handler: async (params: unknown): Promise<null> => {
      const p = parseIndexParams(params, resolveOutputName, focusedOutputId(), "workspace.destroy");
      const r = reg.destroy(state, p.index, p.outputId, outputNameOf(p.outputId));
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.show",
    description:
      "Show the workspace matching `name`. Matches user-set names first across all outputs; falls back to the durable handle when `name` is a digit string. Use `output` to restrict the search.",
    handler: async (params: unknown): Promise<null> => {
      const p = parseShowParams(state, params, resolveOutputName);
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
    name: "workspace.show-at-index",
    description:
      "Show the workspace at the given per-output index on the given output (defaults to the focused output).",
    handler: async (params: unknown): Promise<null> => {
      const p = parseIndexParams(
        params, resolveOutputName, focusedOutputId(), "workspace.show-at-index");
      const t = parseShowTransition(params, "workspace.show-at-index");
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
    description:
      "Move a window (by surfaceId) to a workspace identified by `name` (with handle-string fallback) or by `{index, output}`.",
    handler: async (params: unknown): Promise<null> => {
      const p = parseMoveParams(state, params, resolveOutputName, focusedOutputId());
      const r = reg.moveWindow(state, p.surfaceId, p.index, p.outputId, outputNameOf(p.outputId));
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.set-name",
    description: "Set or clear a workspace's display name (positional, requires per-output index).",
    handler: async (params: unknown): Promise<null> => {
      const p = parseSetNameParams(params, resolveOutputName, focusedOutputId());
      const r = reg.setName(state, p.index, p.name, p.outputId);
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.set-urgent",
    description: "Set or clear the urgent flag on a workspace (positional). Auto-clears on show.",
    handler: async (params: unknown): Promise<null> => {
      const p = parseSetUrgentParams(params, resolveOutputName, focusedOutputId());
      const r = reg.setUrgent(state, p.index, p.urgent, p.outputId);
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.list",
    description:
      "Workspaces on the given output, sorted by per-output index. Omit `output` to list every workspace on every live output.",
    handler: async (params: unknown): Promise<WorkspaceSnapshot[]> => {
      if (params === undefined || params === null) {
        // No output requested -> every workspace, every output.
        const out: WorkspaceSnapshot[] = [];
        for (const outputId of state.positionsByOutput.keys()) {
          out.push(...reg.snapshotsForOutput(state, outputId));
        }
        return out;
      }
      if (!isObj(params)) throw new TypeError("workspace.list: expected an object");
      if (params.output === undefined) {
        const out: WorkspaceSnapshot[] = [];
        for (const outputId of state.positionsByOutput.keys()) {
          out.push(...reg.snapshotsForOutput(state, outputId));
        }
        return out;
      }
      const outputId = parseOptionalOutput(params, resolveOutputName, -1, "workspace.list");
      return reg.snapshotsForOutput(state, outputId);
    },
  });

  sdk.actions.register({
    name: "workspace.current",
    description:
      "The currently-shown workspace on the given output (defaults to the focused output).",
    handler: async (params: unknown): Promise<WorkspaceSnapshot | null> => {
      const outputId = parseOptionalOutput(
        params, resolveOutputName, focusedOutputId(), "workspace.current");
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
    async setUrgent(index, urgent, outputId): Promise<void> {
      const outId = outputId ?? reg.OUTPUT_DEFAULT;
      const r = reg.setUrgent(state, index, urgent, outId);
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
  sdk.log("canvas plugin registered (workspace parity)");
}

// ---- Param parsers -------------------------------------------------------
// IPC / action callers send JSON-shaped objects; resolve to the branded
// types the registry uses. Throws TypeError on shape mismatch.
//
// User-facing actions take `output: string` (a connector name like "DP-1"
// or an EDID id); resolution happens here so the rest of the plugin
// works with the numeric outputId the registry uses.

function isObj(v: unknown): v is { [k: string]: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Resolve an action's `output: string` field to a live outputId. When
// the field is absent, returns `defaultOutputId` (typically the focused
// output, sometimes OUTPUT_DEFAULT for actions that don't have a
// natural focused-output semantic). Throws when an explicit output
// string doesn't match any live output -- silently falling back would
// hide misconfigured keybinds.
function parseOptionalOutput(
  params: unknown,
  resolve: (input: string) => number | null,
  defaultOutputId: number,
  label: string,
): number {
  if (params === undefined || params === null) return defaultOutputId;
  if (!isObj(params)) throw new TypeError(`${label}: expected an object`);
  const o = params.output;
  if (o === undefined) return defaultOutputId;
  if (typeof o !== "string" || o.length === 0) {
    throw new TypeError(`${label}: output must be a non-empty string`);
  }
  const id = resolve(o);
  if (id === null) {
    throw new Error(`${label}: no live output matches '${o}'`);
  }
  return id;
}

function parseCreateParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { name?: string; outputId: number; preferredOutputs?: string[] } {
  if (params === undefined || params === null) {
    return { outputId: defaultOutputId };
  }
  if (!isObj(params)) throw new TypeError("workspace.create: expected an object");
  const outputId = parseOptionalOutput(params, resolveOutput, defaultOutputId, "workspace.create");
  const out: { name?: string; outputId: number; preferredOutputs?: string[] } = { outputId };
  if (params.name !== undefined) {
    if (typeof params.name !== "string") {
      throw new TypeError("workspace.create: name must be a string");
    }
    out.name = params.name;
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

// Strict per-output positional. Used by destroy + set-name + set-urgent
// + workspace.show-at-index. `output` defaults to the focused output.
function parseIndexParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
  label: string,
): { index: WorkspaceIndex; outputId: number } {
  if (!isObj(params)) {
    throw new TypeError(`${label}: expected an object with { index, output? }`);
  }
  if (typeof params.index !== "number" || !Number.isInteger(params.index)
      || params.index < 1) {
    throw new TypeError(`${label}: index must be a positive integer`);
  }
  const outputId = parseOptionalOutput(params, resolveOutput, defaultOutputId, label);
  return { index: asIndex(params.index), outputId };
}

// workspace.show parameter parser. The action takes EITHER:
//   - a workspace name (user-set label OR a digit-string that resolves
//     to a durable WorkspaceHandle as a fallback), with optional
//     `output` to scope the lookup; or
//   - nothing else -- positional index is exposed via
//     workspace.show-at-index.
//
// Resolution order when `output` is omitted:
//   1. Match `name` against any workspace's user-set name across all
//      outputs. First positional match wins (insertion order across
//      outputs; positional order within an output).
//   2. If no user-set name matched AND `name` is an all-digits string
//      parseable as a positive integer, treat it as a durable handle;
//      return that workspace's (index, outputId).
//   3. Otherwise throw.
//
// When `output` is set, restrict the lookup to that output.
function parseShowParams(
  state: WorkspaceState,
  params: unknown,
  resolveOutput: (input: string) => number | null,
): { index: WorkspaceIndex; outputId: number } {
  if (!isObj(params)) {
    throw new TypeError("workspace.show: expected an object with { name, output? }");
  }
  if (typeof params.name !== "string" || params.name.length === 0) {
    throw new TypeError("workspace.show: name must be a non-empty string");
  }
  const explicitOutput = params.output !== undefined;
  // resolveOutput throws on unknown explicit output; pass a never-fire
  // default since we don't fall back to it.
  const restrictTo = explicitOutput
    ? parseOptionalOutput(params, resolveOutput, -1, "workspace.show")
    : null;

  // Pass 1: user-set name lookup.
  const outputsToSearch = restrictTo !== null
    ? [restrictTo]
    : [...state.positionsByOutput.keys()];
  for (const outputId of outputsToSearch) {
    const idx = reg.findIndexByName(state, params.name, outputId);
    if (idx !== null) return { index: idx, outputId };
  }

  // Pass 2: digit-string -> durable handle.
  if (/^[1-9][0-9]*$/.test(params.name)) {
    const handle = Number(params.name) as WorkspaceHandle;
    const rec = state.byHandle.get(handle);
    if (rec) {
      if (restrictTo !== null && rec.outputId !== restrictTo) {
        throw new Error(
          `workspace.show: workspace handle ${params.name} is on a different output`);
      }
      const idx = reg.findIndex(state, handle, rec.outputId);
      if (idx !== null) return { index: idx, outputId: rec.outputId };
    }
  }

  throw new Error(
    restrictTo !== null
      ? `workspace.show: no workspace named '${params.name}' on the requested output`
      : `workspace.show: no workspace named '${params.name}'`);
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

// workspace.move-window: explicit surfaceId + workspace identifier
// (name or positional index) + optional output. Mirrors the show
// shape: a `name` field that resolves through the same two-pass
// rules; or a positional `index` with `output`.
function parseMoveParams(
  state: WorkspaceState,
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { surfaceId: number; index: WorkspaceIndex; outputId: number } {
  if (!isObj(params)) {
    throw new TypeError(
      "workspace.move-window: expected an object with { surfaceId, name|index, output? }");
  }
  if (typeof params.surfaceId !== "number") {
    throw new TypeError("workspace.move-window: surfaceId must be a number");
  }
  const hasName = params.name !== undefined;
  const hasIndex = params.index !== undefined;
  if (hasName === hasIndex) {
    throw new TypeError(
      "workspace.move-window: pass exactly one of name or index");
  }
  if (hasName) {
    const r = parseShowParams(state, params, resolveOutput);
    return { surfaceId: params.surfaceId, index: r.index, outputId: r.outputId };
  }
  const r = parseIndexParams(params, resolveOutput, defaultOutputId, "workspace.move-window");
  return { surfaceId: params.surfaceId, index: r.index, outputId: r.outputId };
}

function parseSetUrgentParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { index: WorkspaceIndex; urgent: boolean; outputId: number } {
  const base = parseIndexParams(params, resolveOutput, defaultOutputId, "workspace.set-urgent");
  if (!isObj(params)) throw new TypeError("unreachable");
  if (typeof params.urgent !== "boolean") {
    throw new TypeError("workspace.set-urgent: urgent must be a boolean");
  }
  return { index: base.index, urgent: params.urgent, outputId: base.outputId };
}

function parseSetNameParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { index: WorkspaceIndex; name: string | undefined; outputId: number } {
  const base = parseIndexParams(params, resolveOutput, defaultOutputId, "workspace.set-name");
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

