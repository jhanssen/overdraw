// Canvas workspace provider (docs/canvas-design.md). Registers in the
// 'workspace' namespace at priority 0 with the same verb/event/action
// surface as @overdraw/plugin-workspace-default, whose registry (the pure
// workspace state machine) it shares. Two modes, selected by the user's
// `canvas` config slice:
//
//   parity (default): each output's SHOWN workspace publishes as an
//   explicit island (id = durable handle, rect = null so the tile region
//   derives from the output minus reserved zones, members = the pushed
//   stack). On-screen behavior matches the default plugin exactly.
//
//   world (`world: true`): EVERY workspace publishes as an island at a
//   world rect along its output's row (slot pitch = output width +
//   SLOT_GUTTER); hidden members lay out at their slots (pre-sized on
//   show) while the draw stack still gates visibility; `show` docks the
//   output's camera on the shown island instantly, or FLIES it there when
//   the caller passes a `transition` (duration + easing drive a camera
//   tween; the union of departure + destination stacks rides the output
//   for the journey so the world visibly slides by). `workspace.fit`
//   zooms the camera out (optically) to frame a consecutive run of
//   workspaces; `workspace.pan` / `workspace.zoom` roam the camera
//   freely (every workspace on the output stays visible while the
//   camera is off its dock, and the shown workspace follows focus);
//   `workspace.unfit` zooms back in to one; `workspace.bookmark-*`
//   name camera framings (dock / fit range / free rect+zoom) and fly
//   back to them. Config `canvas.bookmarks` seeds bookmarks each start.

import type {
  WorkspaceAPI, WorkspaceHandle, WorkspaceIndex, WorkspaceSnapshot,
} from "@overdraw/workspace-types";
import type {
  PluginSdkShape, SceneHandleLike, PluginTransitionsLike, WindowSnapshotLike,
} from "@overdraw/plugin-sdk-types";
import type { EasingSpec, TweenSpec } from "@overdraw/animation-types";
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
  // learns outputs lazily from bus events. The geometry fields (global
  // logical position + size) feed world slots; entries without them
  // behave as unknown-geometry outputs.
  initialOutputs?: ReadonlyArray<{
    outputId: number; name: string; edidId: string;
    x?: number; y?: number; width?: number; height?: number;
  }>;
  // The user's `canvas` config slice (verbatim). `world: true` enables
  // world slots: each workspace gets a world-rect island along its
  // output's row and `show` docks the output's camera on it (instantly,
  // or via a camera flight when the caller passes a transition).
  // Absent/false = workspace parity (islands colocated with outputs,
  // identity cameras).
  canvas?: unknown;
}

// Horizontal spacing between neighboring slot rects in a row. Visible as
// the void between islands while a camera flight crosses it.
const SLOT_GUTTER = 128;

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

  // World slots (docs/canvas-design.md sequencing step 4c): each workspace
  // becomes an island at a world rect along its output's row; `show` docks
  // the camera. Off = workspace parity.
  const worldMode = !!config?.canvas && typeof config.canvas === "object"
    && (config.canvas as { world?: unknown }).world === true;

  // Elastic strips (canvas-design.md §5): every workspace island grows
  // along its row as managed members exceed the viewport -- one column of
  // `column` × viewport width per managed member, tiled by the layout
  // provider's columns mode -- and the docked camera scrolls within the
  // strip to follow focus. Off = fixed islands (classic compression).
  const elasticRaw = worldMode
    ? (config?.canvas as { elastic?: unknown }).elastic : undefined;
  const elasticMode = elasticRaw === true
    || (typeof elasticRaw === "object" && elasticRaw !== null);
  let colFraction = 0.5;
  if (typeof elasticRaw === "object" && elasticRaw !== null) {
    const c = (elasticRaw as { column?: unknown }).column;
    if (typeof c === "number" && Number.isFinite(c)) {
      colFraction = Math.min(1, Math.max(0.1, c));
    }
  }
  // Camera scroll animation within a strip (ms).
  const SCROLL_MS = 150;

  // Snapshot-based show transitions capture arrangement-anchored scenes
  // and cannot represent a world-docked view; in world mode a `transition`
  // instead requests a camera FLIGHT to the destination island (the kind
  // is irrelevant to a real camera move -- only duration and easing carry
  // over). Logged once.
  let flightNoteShown = false;
  function noteFlight(kind: string): void {
    if (flightNoteShown) return;
    flightNoteShown = true;
    sdk.log(`canvas: world mode show transitions fly the camera (kind '${kind}' ignored; duration/easing honored)`);
  }

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
  // Arrangement geometry per output (global logical position + size), fed
  // by output.added/changed payloads + the initialOutputs seed. World
  // slots derive their rects from this; an output with unknown geometry
  // publishes rect-null islands (parity behavior) until it reports.
  const outputGeom = new Map<
    number, { x: number; y: number; width: number; height: number }>();
  function recordGeom(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const p = payload as {
      outputId?: unknown; x?: unknown; y?: unknown;
      width?: unknown; height?: unknown;
    };
    if (typeof p.outputId !== "number") return;
    if (typeof p.x !== "number" || typeof p.y !== "number"
      || typeof p.width !== "number" || typeof p.height !== "number") return;
    outputGeom.set(p.outputId,
      { x: p.x, y: p.y, width: p.width, height: p.height });
  }
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
    recordGeom(payload);
    // Geometry may have moved/resized the row: republish slot rects.
    if (stateReady) void publishWorld();
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
        // While an output's camera is overridden (fit or free roam)
        // every visible window is focusable (click, or hover under
        // follow-pointer focus), so the shown workspace FOLLOWS focus:
        // the bar highlight and the default unfit target always name
        // the workspace the user selected. The registry show flips
        // truth only -- the override's union stack and camera stay in
        // place (the setOutputStack override and publishWorld's gates
        // keep them), and the focus decision is skipped: focus is the
        // cause here, not an effect.
        if (rec && worldMode && override.has(rec.outputId)
            && state.shownByOutput.get(rec.outputId) !== handle) {
          const idx = reg.findIndex(state, handle, rec.outputId);
          if (idx !== null) {
            const r = reg.show(state, idx, rec.outputId, outputNameOf(rec.outputId));
            state = r.state;
            void applyEffects(r.sideEffects, new Set(["requestFocusDecision"]));
          }
        }
        // Elastic strips: keep the newly focused window inside the
        // docked view -- scroll the camera minimally within its island.
        if (rec && elasticMode && !override.has(rec.outputId)
            && state.shownByOutput.get(rec.outputId) === handle) {
          const sid = p.surfaceId;
          void (async () => {
            const snap = await sdk.windows.get(sid);
            // A window no layout pass has placed yet carries a
            // degenerate placeholder rect; its retile will land through
            // the stack.relayout trigger instead.
            if (!snap?.outer || snap.outer.width <= 0) return;
            if (focusedSurfaceId !== sid) return;
            if (ensureVisibleScroll(rec.outputId, handle, snap.outer) !== null) {
              await applyScroll(rec.outputId);
            }
          })();
        }
      }
    } else if (focusedSurfaceId === p.surfaceId) {
      focusedSurfaceId = null;
      // Keep focusedOutputIdCache: the focus departed but the user's
      // pointer/keyboard is still anchored on that output.
    }
  });
  // Elastic strips: after each layout pass, if the focused window's rect
  // moved (retile, new column at the strip's head), keep it inside the
  // docked view. stack.relayout carries the fresh post-layout rects, so
  // this needs no extra windows.get round trip.
  sdk.events.subscribe("stack.relayout", (_name, payload) => {
    if (!worldMode || !elasticMode || focusedSurfaceId === null) return;
    if (!payload || typeof payload !== "object") return;
    const wins = (payload as { windows?: unknown }).windows;
    if (!Array.isArray(wins)) return;
    const entry = wins.find((w): w is { newOuter: { x: number; width: number } } =>
      isObj(w) && w.surfaceId === focusedSurfaceId && isObj(w.newOuter)
      && typeof (w.newOuter as { width?: unknown }).width === "number"
      && (w.newOuter as { width: number }).width > 0);
    if (!entry) return;
    const handle = state.surfaceToHandle.get(focusedSurfaceId);
    if (handle === undefined) return;
    const rec = state.byHandle.get(handle);
    if (!rec || override.has(rec.outputId)) return;
    if (state.shownByOutput.get(rec.outputId) !== handle) return;
    if (ensureVisibleScroll(rec.outputId, handle, entry.newOuter) !== null) {
      void applyScroll(rec.outputId);
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
    recordGeom(payload);
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
    outputGeom.delete(p.outputId);
    override.delete(p.outputId);
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
      recordGeom(o);
    }
    const r = reg.recomputeOutputs(
      state, liveOutputs, fallbackOutputId, fallbackOutputName);
    state = r.state;
    bootRecomputeEffects = r.sideEffects;
  }

  // Parity mode: one explicit island per output -- the shown workspace's
  // durable handle + the exact stack pushed for it. Updated wherever a
  // stack lands (the setOutputStack side effect, or a transition's
  // commit) and mirrored to the WM, which schedules a relayout only when
  // the set actually changed. rect stays null: the tile region derives
  // from the output minus reserved zones, exactly like the implicit
  // island -- the only observable delta is the island id layouts can key
  // state on. World mode replaces this with publishWorld below.
  const islandByOutput = new Map<
    number, { id: number; contextOutputId: number; rect: null; members: number[] }>();
  async function updateIsland(outputId: number, ids: readonly number[] | null): Promise<void> {
    if (worldMode) return;
    if (ids === null) {
      if (!islandByOutput.delete(outputId)) return;
    } else {
      const shown = state.shownByOutput.get(outputId);
      if (shown === undefined) return;
      islandByOutput.set(outputId,
        { id: shown, contextOutputId: outputId, rect: null, members: [...ids] });
    }
    const list = [...islandByOutput.values()]
      .sort((a, b) => a.contextOutputId - b.contextOutputId);
    await sdk.windows.setIslands(list);
  }

  // ---- World mode ---------------------------------------------------------
  // Every workspace is an island at a world rect along its output's row:
  // slot s of output O sits at O.arrangement + s * (O.width + SLOT_GUTTER)
  // horizontally. Slots are per-workspace-handle, assigned on first
  // placement and kept for the workspace's lifetime; collisions after a
  // hotplug migration resolve to the lowest free slot on the new row. ALL
  // workspaces publish (hidden ones too, so their members are laid out at
  // their slots and arrive pre-sized on show); the draw stack still gates
  // visibility. `show` docks the camera on the shown island's rect.
  const slotByHandle = new Map<WorkspaceHandle, number>();
  // Per-workspace scroll offset within an elastic island wider than the
  // viewport (world px from the island's left edge; clamped on use, so a
  // shrinking island self-corrects).
  const scrollByHandle = new Map<WorkspaceHandle, number>();
  // Row arrangement computed by publishWorld: each workspace's island
  // rect, keyed per output. camXFor / fitCameraFor read this cache
  // synchronously; publishWorld refreshes it on every structural change.
  const rowRectsByOutput = new Map<
    number,
    Map<WorkspaceHandle, { x: number; y: number; width: number; height: number }>>();
  const lastCamByOutput = new Map<number, number>();
  // Outputs with a camera flight in progress, keyed to the flight's token.
  // While an output flies, publishWorld skips docking its camera (the
  // flight owns it); the settle step (or a preempting flight / an instant
  // show's cancelFlight) reclaims it.
  const flying = new Map<number, number>();
  let flightSeq = 0;
  // The ids most recently pushed to each output's draw stack. During a
  // flight this is the departure+destination union, which the registry's
  // stackFor cannot know about -- a preempting flight unions against it
  // so nothing pops off screen mid-journey.
  const lastPushedStack = new Map<number, number[]>();
  // Camera override per output: the camera has left its docked slot
  // framing. Two kinds:
  //   fit  -- workspace.fit frames a consecutive workspace set; the
  //           framing re-solves when members / geometry change.
  //   free -- workspace.pan / workspace.zoom / a free bookmark parked
  //           the camera at an arbitrary world framing; structural
  //           changes never move it.
  // While overridden the output's draw stack carries a union (the
  // framed workspaces for fit, every workspace on the output for free)
  // so the world is visible, and the SHOWN workspace follows focus.
  // Registry truth is otherwise untouched; any show exits the override.
  interface FitOverride {
    kind: "fit";
    handles: WorkspaceHandle[];
    // Last settled fit camera; null while the entry tween is in flight.
    cam: { x: number; y: number; zoom: number } | null;
  }
  interface FreeOverride {
    kind: "free";
    // The parked (or in-flight target) camera.
    cam: { x: number; y: number; zoom: number };
  }
  const override = new Map<number, FitOverride | FreeOverride>();

  function exitOverride(outputId: number): void {
    // The dock cache tracks camera x at zoom 1; an override camera
    // invalidates it, so the next dock re-sends even a previously-sent
    // value.
    if (override.delete(outputId)) lastCamByOutput.delete(outputId);
  }

  // The workspaces an override unions onto the draw stack: the framed
  // set for fit, everything on the output for free roaming.
  function overrideHandles(
    outputId: number, o: FitOverride | FreeOverride,
  ): WorkspaceHandle[] {
    return o.kind === "fit"
      ? o.handles
      : [...(state.positionsByOutput.get(outputId) ?? [])];
  }

  // The draw stack for a fitted output: the union of the framed
  // workspaces' members (position order), plus the shown workspace's
  // members when it lies outside the framed range -- registry truth stays
  // on the shown workspace, so its windows must not vanish from the
  // output while the camera frames the range.
  function fitStackFor(
    outputId: number, handles: ReadonlyArray<WorkspaceHandle>,
  ): number[] {
    const ids: number[] = [];
    const add = (h: WorkspaceHandle | undefined): void => {
      if (h === undefined) return;
      const rec = state.byHandle.get(h);
      if (!rec) return;
      for (const id of rec.members) if (!ids.includes(id)) ids.push(id);
    };
    for (const h of handles) add(h);
    add(state.shownByOutput.get(outputId));
    return ids;
  }

  // Camera framing the union of the given workspaces' slot rects: zoomed
  // out just enough to fit (never past 1), centered both ways. The camera
  // views the world from (originX + x, originY + y) over logical/zoom
  // world units, so x/y are offsets from the output's arrangement
  // position; y goes negative to letterbox the slot band vertically.
  function fitCameraFor(
    outputId: number, handles: ReadonlyArray<WorkspaceHandle>,
  ): { x: number; y: number; zoom: number } | null {
    const g = outputGeom.get(outputId);
    if (!g) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const h of handles) {
      const r = islandRectFor(outputId, h);
      if (!r) continue;
      minX = Math.min(minX, r.x);
      maxX = Math.max(maxX, r.x + r.width);
    }
    if (minX === Infinity) return null;
    const zoom = Math.min(g.width / (maxX - minX), 1);
    return {
      x: (minX + maxX) / 2 - (g.width / zoom) / 2 - g.x,
      y: (g.height - g.height / zoom) / 2,
      zoom,
    };
  }

  // Minimal scroll bringing `rect` fully into the docked viewport of
  // `handle`'s island (left edge wins for windows wider than the view).
  // Updates scrollByHandle; returns the new scroll, or null when the
  // current view already contains the rect.
  function ensureVisibleScroll(
    outputId: number, handle: WorkspaceHandle,
    rect: { x: number; width: number },
  ): number | null {
    const g = outputGeom.get(outputId);
    const isl = islandRectFor(outputId, handle);
    if (!g || !isl) return null;
    const maxScroll = Math.max(0, isl.width - g.width);
    const prev = scrollByHandle.get(handle) ?? 0;
    let s = Math.min(maxScroll, Math.max(0, prev));
    if (rect.x + rect.width > isl.x + s + g.width) {
      s = rect.x + rect.width - g.width - isl.x;
    }
    if (rect.x < isl.x + s) s = rect.x - isl.x;
    s = Math.min(maxScroll, Math.max(0, s));
    scrollByHandle.set(handle, s);
    return s !== prev ? s : null;
  }

  // Move a docked camera to its (re-clamped) scroll position within the
  // shown island: a short tween (denied tweens -- grabs -- fall back to
  // the instant write), then one settled write. Overridden / flying
  // outputs are left alone; their owner re-docks through camXFor, which
  // reads the same scroll state.
  async function applyScroll(outputId: number): Promise<void> {
    if (override.has(outputId) || flying.has(outputId)) return;
    const shown = state.shownByOutput.get(outputId);
    if (shown === undefined) return;
    const target = camXFor(outputId, shown);
    if (lastCamByOutput.get(outputId) === target) return;
    if (sdk.animations) {
      const token = ++flightSeq;
      flying.set(outputId, token);
      try {
        const cur = await sdk.windows.getOutputCamera(outputId);
        if (cur.x !== target || cur.y !== 0 || cur.zoom !== 1) {
          const spec: TweenSpec = {
            type: "tween",
            target: { kind: "output-camera", outputId },
            from: cur,
            to: { x: target, y: 0, zoom: 1 },
            duration: SCROLL_MS,
            easing: "ease-in-out" as EasingSpec,
          };
          try {
            await sdk.animations.run(spec);
          } catch { /* denied (grab active); settle instantly below */ }
        }
        if (flying.get(outputId) !== token) return;  // preempted; the winner settles
        flying.delete(outputId);
      } finally {
        if (flying.get(outputId) === token) flying.delete(outputId);
      }
    }
    // Settle against LIVE scroll state: another trigger may have moved
    // the scroll while the tween flew (it bailed on our flying token and
    // relies on this settle to land its value).
    const settleX = camXFor(outputId, shown);
    lastCamByOutput.set(outputId, settleX);
    await sdk.windows.setOutputCamera(outputId, settleX, 0);
  }

  // Keep each overridden output's union stack (and, for fits, the
  // framing camera) in step with structural changes (membership,
  // workspace create/destroy, geometry). An override whose workspaces
  // all vanished dissolves; publishWorld's dock loop then re-docks the
  // camera on the shown slot. Free cameras stay parked -- the user put
  // them there.
  async function refreshOverrides(): Promise<void> {
    for (const [outputId, o] of [...override]) {
      const positions = state.positionsByOutput.get(outputId) ?? [];
      const live = o.kind === "fit"
        ? positions.filter((h) => o.handles.includes(h))
        : [...positions];
      if (live.length === 0 || !outputGeom.has(outputId)) {
        exitOverride(outputId);
        continue;
      }
      if (o.kind === "fit") o.handles = live;
      const union = fitStackFor(outputId, live);
      const last = lastPushedStack.get(outputId);
      if (!last || last.length !== union.length
          || union.some((v, i) => v !== last[i])) {
        await pushStack(outputId, union);
      }
      // Only fit framings re-solve; an entry tween owns the camera
      // until it settles.
      if (o.kind !== "fit" || flying.has(outputId)) continue;
      const cam = fitCameraFor(outputId, live);
      if (!cam) continue;
      if (o.cam && o.cam.x === cam.x && o.cam.y === cam.y
          && o.cam.zoom === cam.zoom) continue;
      o.cam = cam;
      await sdk.windows.setOutputCamera(outputId, cam.x, cam.y, cam.zoom);
    }
  }

  function islandRectFor(
    outputId: number, handle: WorkspaceHandle,
  ): { x: number; y: number; width: number; height: number } | null {
    return rowRectsByOutput.get(outputId)?.get(handle) ?? null;
  }

  // Dock target for a workspace: its island's row origin plus the
  // clamped scroll offset (elastic islands wider than the viewport
  // scroll to follow focus; fixed islands always clamp to 0).
  function camXFor(outputId: number, handle: WorkspaceHandle): number {
    const g = outputGeom.get(outputId);
    const r = islandRectFor(outputId, handle);
    if (!g || !r) return 0;
    const maxScroll = Math.max(0, r.width - g.width);
    const s = Math.min(maxScroll, Math.max(0, scrollByHandle.get(handle) ?? 0));
    return (r.x - g.x) + s;
  }

  async function pushStack(outputId: number, ids: number[]): Promise<void> {
    lastPushedStack.set(outputId, ids);
    await sdk.windows.setOutputStack(outputId, ids);
  }

  // Abort an in-progress flight so an instant camera dock can land: the
  // token bump makes the flight's settle step a no-op, and cancelling the
  // evaluator leaf stops the per-frame camera writes (the flight's
  // pending run() promise resolves cleanly). The camera cache is
  // invalidated too -- the flight left the camera somewhere between
  // slots, so the next dock must re-send even a value we sent before.
  async function cancelFlight(outputId: number): Promise<void> {
    if (!flying.delete(outputId)) return;
    lastCamByOutput.delete(outputId);
    await sdk.animations?.cancel({ kind: "output-camera", outputId });
  }

  function resolveSlots(
    handles: ReadonlyArray<WorkspaceHandle>,
  ): Map<WorkspaceHandle, number> {
    const used = new Set<number>();
    const out = new Map<WorkspaceHandle, number>();
    // First pass: keep existing non-colliding slots (position order wins
    // a collision; the later claimant moves).
    for (const h of handles) {
      const s = slotByHandle.get(h);
      if (s !== undefined && !used.has(s)) { used.add(s); out.set(h, s); }
    }
    for (const h of handles) {
      if (out.has(h)) continue;
      let s = 0;
      while (used.has(s)) s++;
      used.add(s);
      out.set(h, s);
      slotByHandle.set(h, s);
    }
    return out;
  }

  // Elastic growth policy: each visible managed member takes one column
  // of colFraction × viewport width; floating members take none. An
  // exclusive (maximized / fullscreen) member collapses the strip to the
  // viewport -- the layout hands it the whole tile region, and a
  // maximize should cover the screen, not a multi-screen strip.
  function elasticWidth(
    g: { width: number }, members: ReadonlyArray<number>,
    snapById: Map<number, WindowSnapshotLike>,
  ): number {
    let cols = 0;
    for (const id of members) {
      const ws = snapById.get(id)?.windowState;
      if (!ws) { cols++; continue; }   // unknown lane (pre-map): assume a column
      if (!ws.visible) continue;
      if (ws.exclusive !== "none") return g.width;
      if (ws.tiling === "managed") cols++;
    }
    const colW = Math.max(1, Math.round(g.width * colFraction));
    return Math.max(g.width, cols * colW);
  }

  async function publishWorld(): Promise<void> {
    if (!worldMode) return;
    // Drop slots + scroll for destroyed workspaces.
    for (const h of [...slotByHandle.keys()]) {
      if (!state.byHandle.has(h)) slotByHandle.delete(h);
    }
    for (const h of [...scrollByHandle.keys()]) {
      if (!state.byHandle.has(h)) scrollByHandle.delete(h);
    }
    // Elastic growth reads each member's lane from a windows snapshot.
    const snapById = new Map<number, WindowSnapshotLike>();
    if (elasticMode) {
      for (const s of await sdk.windows.list()) snapById.set(s.surfaceId, s);
    }
    const islands: Array<{
      id: number; contextOutputId: number;
      rect: { x: number; y: number; width: number; height: number } | null;
      members: number[];
      layout?: { [k: string]: unknown };
    }> = [];
    rowRectsByOutput.clear();
    for (const [outputId, handles] of state.positionsByOutput) {
      const slots = resolveSlots(handles);
      const g = outputGeom.get(outputId);
      // Row arrangement: sticky slot ORDER, per-island widths (viewport
      // for fixed, column-grown for elastic), cumulative origins with
      // SLOT_GUTTER between islands. A growing island shoves its
      // right-hand neighbors along the row -- order-preserving and
      // monotone (canvas-design.md §6's shove, scoped to one row).
      const row = new Map<
        WorkspaceHandle, { x: number; y: number; width: number; height: number }>();
      if (g) {
        const ordered = [...handles].sort(
          (a, b) => (slots.get(a) ?? 0) - (slots.get(b) ?? 0));
        let x = g.x;
        for (const h of ordered) {
          const rec = state.byHandle.get(h);
          const width = elasticMode && rec
            ? elasticWidth(g, rec.members, snapById)
            : g.width;
          row.set(h, { x, y: g.y, width, height: g.height });
          x += width + SLOT_GUTTER;
        }
      }
      rowRectsByOutput.set(outputId, row);
      for (const h of handles) {
        const rec = state.byHandle.get(h);
        if (!rec) continue;
        islands.push({
          id: h,
          contextOutputId: outputId,
          rect: row.get(h) ?? null,
          members: [...rec.members],
          ...(elasticMode ? { layout: { mode: "columns" } } : {}),
        });
      }
    }
    islands.sort((a, b) => a.id - b.id);
    await sdk.windows.setIslands(islands);
    // Overridden outputs maintain their own union stack + camera.
    await refreshOverrides();
    // Dock each output's camera on its shown island (instant). Identity
    // when geometry is unknown (rect null islands tile in place). A
    // flying output's camera belongs to its flight; the settle step
    // docks it. An overridden output's camera belongs to its override.
    for (const [outputId, shown] of state.shownByOutput) {
      if (flying.has(outputId) || override.has(outputId)) continue;
      const camX = camXFor(outputId, shown);
      if (lastCamByOutput.get(outputId) === camX) continue;
      lastCamByOutput.set(outputId, camX);
      await sdk.windows.setOutputCamera(outputId, camX, 0);
    }
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
        case "setOutputStack": {
          // An overridden output's stack stays the override union:
          // replaying the shown workspace's stack verbatim would hide
          // the other visible workspaces' windows for a frame until
          // refreshOverrides re-unions.
          const o = worldMode ? override.get(e.outputId) : undefined;
          if (o) {
            await pushStack(e.outputId,
              fitStackFor(e.outputId, overrideHandles(e.outputId, o)));
          } else {
            lastPushedStack.set(e.outputId, e.ids ? [...e.ids] : []);
            await sdk.windows.setOutputStack(e.outputId, e.ids);
          }
          await updateIsland(e.outputId, e.ids);
          break;
        }
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
    // World mode: any effect batch may have changed workspace structure
    // (create/destroy touch no stacks but do add/remove islands) --
    // republish islands + re-dock cameras. Dedupe-safe: wm.setIslands
    // compares; camera pushes are cached per output.
    if (worldMode && effects.length > 0) await publishWorld();
  }

  // Hyprland-style create-on-reference: a well-formed show/move `name`
  // that matches nothing and is all digits creates a DYNAMIC workspace
  // with that user-set name (it evaporates once empty and hidden; see
  // the registry's reapIfEmpty) on the explicit `output` when given,
  // else the focused output. Non-digit names still throw -- an
  // unmatched word is more likely a typo'd bind than an intent.
  async function resolveOrCreateByName(
    params: unknown, label: string,
  ): Promise<{ index: WorkspaceIndex; outputId: number }> {
    const r = tryResolveShowName(state, params, resolveOutputName);
    if (r !== null) return r;
    const name = (params as { name: string }).name;
    if (!/^[1-9][0-9]*$/.test(name)) {
      throw new Error(`${label}: no workspace named '${name}'`);
    }
    const outputId = parseOptionalOutput(
      params, resolveOutputName, focusedOutputId(), label);
    const c = reg.create(state, { name, outputId }, outputNameOf(outputId));
    state = c.state;
    await applyEffects(c.sideEffects);
    return { index: c.snapshot.index, outputId };
  }

  // workspace.move-window target: `name` (create-on-reference, like
  // show) or positional `{index, output}`.
  async function parseMoveTarget(
    params: unknown,
  ): Promise<{ surfaceId: number; index: WorkspaceIndex; outputId: number }> {
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
    const r = hasName
      ? await resolveOrCreateByName(params, "workspace.move-window")
      : parseIndexParams(params, resolveOutputName, focusedOutputId(), "workspace.move-window");
    return { surfaceId: params.surfaceId, index: r.index, outputId: r.outputId };
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
      lastPushedStack.set(outputId, toIds ? [...toIds] : []);
      await updateIsland(outputId, toIds ?? []);
      if (worldMode) await publishWorld();
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

  // World-mode workspace.show with a transition: fly the camera to the
  // destination island instead of teleporting. The registry state flips
  // to the destination immediately (workspace.shown/hidden events, bar
  // highlight, focus policy all see the new truth at takeoff); only the
  // optics travel. For the journey the output's draw stack carries the
  // UNION of what was visible and what will be, so the world slides by
  // instead of a void. Settle = final stack + one settled camera write
  // (residency sweep, X re-narration, pointer repick) + the deferred
  // focus decision.
  //
  // Falls back to an instant dock when the runtime has no sdk.animations
  // or when the evaluator refuses (camera animations are denied during
  // interactive grabs/drags). A flight preempted by a newer show abandons
  // its settle -- the winner (whose tween starts from the live mid-flight
  // camera) owns the output from that point.
  async function showWithFlight(
    index: WorkspaceIndex, outputId: number, t: ShowTransitionSpec,
  ): Promise<void> {
    noteFlight(t.kind);
    exitOverride(outputId);
    const fromIds = lastPushedStack.get(outputId) ?? reg.stackFor(state, outputId);
    const r = reg.show(state, index, outputId, outputNameOf(outputId));
    state = r.state;
    const setStackEffect = r.sideEffects.find(
      (e): e is Extract<SideEffect, { kind: "setOutputStack" }> =>
        e.kind === "setOutputStack" && e.outputId === outputId);
    const toIds = setStackEffect ? [...setStackEffect.ids ?? []] : [];
    const prevFlight = flying.get(outputId);
    const token = ++flightSeq;
    flying.set(outputId, token);
    try {
      await applyEffects(r.sideEffects, new Set(["setOutputStack", "requestFocusDecision"]));
      const union = [...fromIds.filter((id) => !toIds.includes(id)), ...toIds];
      await pushStack(outputId, union);
      // Stop a preempted flight's leaf before reading the camera: run()
      // below would replace it anyway, but the no-animation branch (the
      // camera is already at the target) would otherwise leave the old
      // leaf flying the camera away from where we settle.
      if (prevFlight !== undefined) {
        await sdk.animations?.cancel({ kind: "output-camera", outputId });
      }
      const shown = state.shownByOutput.get(outputId);
      const target = shown !== undefined ? camXFor(outputId, shown) : 0;
      const cur = await sdk.windows.getOutputCamera(outputId);
      if (sdk.animations
          && (cur.x !== target || cur.y !== 0 || cur.zoom !== 1)) {
        const spec: TweenSpec = {
          type: "tween",
          target: { kind: "output-camera", outputId },
          from: cur,
          to: { x: target, y: 0, zoom: 1 },
          duration: t.duration,
          easing: (t.easing ?? "ease-in-out") as EasingSpec,
        };
        try {
          await sdk.animations.run(spec);
        } catch (err) {
          sdk.log(`canvas: camera flight fell back to instant dock (${String(err)})`);
        }
      }
      if (flying.get(outputId) !== token) return;  // preempted; the winner settles
      flying.delete(outputId);
      // Settle against LIVE state: a destroy/move that landed mid-flight
      // may have changed the shown workspace under us.
      const settleShown = state.shownByOutput.get(outputId);
      await pushStack(outputId, reg.stackFor(state, outputId));
      const settleX = settleShown !== undefined ? camXFor(outputId, settleShown) : 0;
      lastCamByOutput.set(outputId, settleX);
      await sdk.windows.setOutputCamera(outputId, settleX, 0);
      const focusEffect = r.sideEffects.find(
        (e): e is Extract<SideEffect, { kind: "requestFocusDecision" }> =>
          e.kind === "requestFocusDecision");
      if (focusEffect) {
        await sdk.windows.requestFocusDecision(focusEffect.reason);
      }
    } finally {
      if (flying.get(outputId) === token) flying.delete(outputId);
    }
  }

  // Shared enter-override flow: install the override record, push its
  // union stack, then move the camera to `cam` (tweened when a
  // transition is given, with the flight preemption contract; denied
  // tweens -- grabs -- fall back to the instant write). Either way one
  // settled camera write sweeps residency + X narration at the end.
  async function engageOverride(
    outputId: number, rec: FitOverride | FreeOverride,
    cam: { x: number; y: number; zoom: number },
    t: CameraTransitionSpec | null, label: string,
  ): Promise<void> {
    await cancelFlight(outputId);
    override.set(outputId, rec);
    lastCamByOutput.delete(outputId);
    await pushStack(outputId,
      fitStackFor(outputId, overrideHandles(outputId, rec)));
    if (t && sdk.animations) {
      const token = ++flightSeq;
      flying.set(outputId, token);
      try {
        const cur = await sdk.windows.getOutputCamera(outputId);
        if (cur.x !== cam.x || cur.y !== cam.y || cur.zoom !== cam.zoom) {
          const spec: TweenSpec = {
            type: "tween",
            target: { kind: "output-camera", outputId },
            from: cur,
            to: cam,
            duration: t.duration,
            easing: (t.easing ?? "ease-in-out") as EasingSpec,
          };
          try {
            await sdk.animations.run(spec);
          } catch (err) {
            sdk.log(`canvas: ${label} camera fell back to instant (${String(err)})`);
          }
        }
        if (flying.get(outputId) !== token) return;  // preempted; the winner settles
        flying.delete(outputId);
      } finally {
        if (flying.get(outputId) === token) flying.delete(outputId);
      }
    }
    if (override.get(outputId) !== rec) return;  // a show exited the override mid-tween
    // Settle against live geometry: a mid-tween structural change may
    // have re-solved a fit framing (refreshOverrides skipped the camera
    // while the tween owned it). Free cameras settle where they aimed.
    const settleCam = rec.kind === "fit"
      ? (fitCameraFor(outputId, rec.handles) ?? cam)
      : rec.cam;
    if (rec.kind === "fit") rec.cam = settleCam;
    await sdk.windows.setOutputCamera(
      outputId, settleCam.x, settleCam.y, settleCam.zoom);
  }

  // Frame a specific set of workspaces (all on outputId). Registry truth
  // is untouched -- only the optics widen, with the fit union riding the
  // draw stack so every framed workspace composites. The framed set is
  // resolved once, here; workspaces created later don't join it.
  async function fitHandles(
    outputId: number, handles: ReadonlyArray<WorkspaceHandle>,
    t: CameraTransitionSpec | null, label: string,
  ): Promise<void> {
    const positions = state.positionsByOutput.get(outputId) ?? [];
    const live = handles.filter((h) => {
      const rec = state.byHandle.get(h);
      return rec !== undefined && rec.outputId === outputId;
    });
    if (live.length === 0) {
      throw new Error(`${label}: no live workspaces to frame`);
    }
    if (!outputGeom.has(outputId)) {
      throw new Error(`${label}: output ${outputId} has unknown geometry`);
    }
    resolveSlots(positions);
    const cam = fitCameraFor(outputId, live);
    if (!cam) {
      throw new Error(`${label}: no slot geometry for the range`);
    }
    await engageOverride(
      outputId, { kind: "fit", handles: [...live], cam: null }, cam, t, label);
  }

  // workspace.fit: frame workspaces [start..end] (per-output positions;
  // defaults first..last).
  async function fitRange(
    outputId: number, start: number | undefined, end: number | undefined,
    t: CameraTransitionSpec | null,
  ): Promise<void> {
    const positions = state.positionsByOutput.get(outputId) ?? [];
    if (positions.length === 0) {
      throw new Error("workspace.fit: no workspaces on the target output");
    }
    const s = start ?? 1;
    const e = end ?? positions.length;
    if (s < 1 || e > positions.length || s > e) {
      throw new Error(
        `workspace.fit: range ${s}..${e} out of bounds (1..${positions.length})`);
    }
    await fitHandles(outputId, positions.slice(s - 1, e), t, "workspace.fit");
  }

  // Free roaming (workspace.pan / workspace.zoom / free bookmarks): park
  // the camera at an arbitrary framing. Every workspace on the output
  // rides the stack so the world is visible as it goes by; the camera
  // stays where the user put it until a show / unfit / new movement.
  async function freeCamera(
    outputId: number, cam: { x: number; y: number; zoom: number },
    t: CameraTransitionSpec | null, label: string,
  ): Promise<void> {
    const positions = state.positionsByOutput.get(outputId) ?? [];
    if (positions.length === 0) {
      throw new Error(`${label}: no workspaces on the target output`);
    }
    if (!outputGeom.has(outputId)) {
      throw new Error(`${label}: output ${outputId} has unknown geometry`);
    }
    resolveSlots(positions);
    await engageOverride(outputId, { kind: "free", cam }, cam, t, label);
  }

  // ---- Bookmarks -----------------------------------------------------------
  // Named camera framings (docs/canvas-design.md §2): what the camera is
  // doing when the bookmark is set decides its shape. A dock captures the
  // shown workspace (island), a fit captures the framed set (range), a
  // roam captures the raw camera (free; offsets are output-relative).
  // Runtime bookmarks live for the session; config-declared ones
  // (canvas.bookmarks) are re-seeded every start and reference
  // workspaces by NAME, resolved at go time (create-on-reference, like
  // show).
  type BookmarkFraming =
    | { kind: "island"; handle: WorkspaceHandle }
    | { kind: "island-name"; workspace: string }
    | { kind: "range"; handles: WorkspaceHandle[] }
    | { kind: "range-index"; start?: number; end?: number }
    | { kind: "free"; x: number; y: number; zoom: number };
  const bookmarks = new Map<string, BookmarkFraming>();

  function seedBookmarks(canvasSlice: unknown): void {
    if (!canvasSlice || typeof canvasSlice !== "object") return;
    const list = (canvasSlice as { bookmarks?: unknown }).bookmarks;
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      sdk.log("canvas: config bookmarks must be an array; ignored");
      return;
    }
    for (const entry of list) {
      if (!isObj(entry) || typeof entry.name !== "string" || entry.name === "") {
        sdk.log(`canvas: config bookmark without a name skipped (${JSON.stringify(entry)})`);
        continue;
      }
      if (typeof entry.workspace === "string" && entry.workspace !== "") {
        bookmarks.set(entry.name, { kind: "island-name", workspace: entry.workspace });
      } else if (typeof entry.x === "number" && typeof entry.y === "number") {
        const zoom = entry.zoom === undefined ? 1 : entry.zoom;
        if (typeof zoom !== "number" || !(zoom > 0)) {
          sdk.log(`canvas: config bookmark '${entry.name}' has invalid zoom; skipped`);
          continue;
        }
        bookmarks.set(entry.name, { kind: "free", x: entry.x, y: entry.y, zoom });
      } else if (entry.start !== undefined || entry.end !== undefined) {
        const ok = (v: unknown): v is number | undefined =>
          v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 1);
        if (!ok(entry.start) || !ok(entry.end)) {
          sdk.log(`canvas: config bookmark '${entry.name}' has invalid start/end; skipped`);
          continue;
        }
        bookmarks.set(entry.name,
          { kind: "range-index", start: entry.start, end: entry.end });
      } else {
        sdk.log(`canvas: config bookmark '${entry.name}' matches no framing shape ` +
          "(need workspace, x/y[/zoom], or start/end); skipped");
      }
    }
  }
  seedBookmarks(config?.canvas);

  // Capture the invoking output's current framing under `name`.
  function setBookmark(name: string, outputId: number): BookmarkFraming {
    const o = override.get(outputId);
    let framing: BookmarkFraming;
    if (o?.kind === "free") {
      framing = { kind: "free", x: o.cam.x, y: o.cam.y, zoom: o.cam.zoom };
    } else if (o?.kind === "fit") {
      framing = { kind: "range", handles: [...o.handles] };
    } else {
      const shown = state.shownByOutput.get(outputId);
      if (shown === undefined) {
        throw new Error("workspace.bookmark-set: no shown workspace to capture");
      }
      framing = { kind: "island", handle: shown };
    }
    bookmarks.set(name, framing);
    return framing;
  }

  // Fly/dock a camera to the bookmark's framing. Island framings are a
  // show on the workspace's home output; range framings re-fit; free
  // framings park the invoking output's camera.
  async function gotoBookmark(
    name: string, outputId: number, t: CameraTransitionSpec | null,
  ): Promise<void> {
    const f = bookmarks.get(name);
    if (!f) throw new Error(`workspace.bookmark-go: no bookmark '${name}'`);
    const showAt = async (index: WorkspaceIndex, outId: number): Promise<void> => {
      if (t) {
        await showWithFlight(index, outId,
          { kind: "camera", duration: t.duration, easing: t.easing });
        return;
      }
      exitOverride(outId);
      await cancelFlight(outId);
      const r = reg.show(state, index, outId, outputNameOf(outId));
      state = r.state;
      await applyEffects(r.sideEffects);
    };
    switch (f.kind) {
      case "island": {
        const rec = state.byHandle.get(f.handle);
        if (!rec) {
          throw new Error(
            `workspace.bookmark-go: bookmark '${name}' points at a destroyed workspace`);
        }
        const idx = reg.findIndex(state, f.handle, rec.outputId);
        if (idx === null) {
          throw new Error(`workspace.bookmark-go: bookmark '${name}' is unresolvable`);
        }
        await showAt(idx, rec.outputId);
        return;
      }
      case "island-name": {
        const p = await resolveOrCreateByName(
          { name: f.workspace }, "workspace.bookmark-go");
        await showAt(p.index, p.outputId);
        return;
      }
      case "range": {
        const live = f.handles.filter((h) => state.byHandle.has(h));
        const home = live.length > 0 ? state.byHandle.get(live[0]) : undefined;
        if (!home) {
          throw new Error(
            `workspace.bookmark-go: bookmark '${name}' frames only destroyed workspaces`);
        }
        await fitHandles(home.outputId, live, t, "workspace.bookmark-go");
        return;
      }
      case "range-index":
        await fitRange(outputId, f.start, f.end, t);
        return;
      case "free":
        await freeCamera(outputId,
          { x: f.x, y: f.y, zoom: f.zoom }, t, "workspace.bookmark-go");
        return;
    }
  }

  // workspace.unfit: zoom back in to a single workspace. Exits any
  // camera override (fit or free roam);
  // a target different from the shown workspace is a normal show (flown
  // when a transition is given), while unfitting onto the shown
  // workspace itself restores camera + stack without touching registry
  // truth (the fit never moved it).
  //
  // Default target: the workspace of the focused window when it lives on
  // this output -- while fitted every framed window is focusable
  // (click, or hover under follow-pointer focus), so "zoom back in"
  // lands on what the user selected. Falls back to the shown workspace
  // when nothing framed holds focus.
  async function unfitTo(
    outputId: number, index: number | undefined, t: CameraTransitionSpec | null,
  ): Promise<void> {
    exitOverride(outputId);
    const positions = state.positionsByOutput.get(outputId) ?? [];
    const shown = state.shownByOutput.get(outputId);
    const shownIdx = shown !== undefined ? positions.indexOf(shown) + 1 : 0;
    let defaultIdx = shownIdx;
    if (focusedSurfaceId !== null) {
      const h = state.surfaceToHandle.get(focusedSurfaceId);
      const focusRec = h !== undefined ? state.byHandle.get(h) : undefined;
      if (focusRec && focusRec.outputId === outputId && h !== undefined) {
        const i = positions.indexOf(h);
        if (i >= 0) defaultIdx = i + 1;
      }
    }
    const target = index ?? defaultIdx;
    if (target < 1 || target > positions.length) {
      throw new Error(
        `workspace.unfit: index ${target} out of bounds (1..${positions.length})`);
    }
    if (target !== shownIdx) {
      if (t) {
        await showWithFlight(asIndex(target), outputId,
          { kind: "camera", duration: t.duration, easing: t.easing });
        return;
      }
      await cancelFlight(outputId);
      const r = reg.show(state, asIndex(target), outputId, outputNameOf(outputId));
      state = r.state;
      await applyEffects(r.sideEffects);
      return;
    }
    // Zoom back onto the shown workspace: optics only. The fit union
    // keeps riding the stack for the journey; settle collapses it.
    await cancelFlight(outputId);
    const camX = shown !== undefined ? camXFor(outputId, shown) : 0;
    if (t && sdk.animations) {
      const token = ++flightSeq;
      flying.set(outputId, token);
      try {
        const cur = await sdk.windows.getOutputCamera(outputId);
        if (cur.x !== camX || cur.y !== 0 || cur.zoom !== 1) {
          const spec: TweenSpec = {
            type: "tween",
            target: { kind: "output-camera", outputId },
            from: cur,
            to: { x: camX, y: 0, zoom: 1 },
            duration: t.duration,
            easing: (t.easing ?? "ease-in-out") as EasingSpec,
          };
          try {
            await sdk.animations.run(spec);
          } catch (err) {
            sdk.log(`canvas: unfit camera fell back to instant (${String(err)})`);
          }
        }
        if (flying.get(outputId) !== token) return;  // preempted; the winner settles
        flying.delete(outputId);
      } finally {
        if (flying.get(outputId) === token) flying.delete(outputId);
      }
    }
    await pushStack(outputId, reg.stackFor(state, outputId));
    lastCamByOutput.set(outputId, camX);
    await sdk.windows.setOutputCamera(outputId, camX, 0);
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
      "Show the workspace matching `name` (user-set names first across all outputs, then durable-handle fallback for digit strings; `output` restricts the search). An all-digits name that matches nothing creates a dynamic workspace with that name.",
    handler: async (params: unknown): Promise<null> => {
      const p = await resolveOrCreateByName(params, "workspace.show");
      const t = parseShowTransition(params, "workspace.show");
      if (t && worldMode) {
        await showWithFlight(p.index, p.outputId, t);
        return null;
      }
      if (t) {
        await showWithTransition(p.index, p.outputId, t);
        return null;
      }
      exitOverride(p.outputId);
      await cancelFlight(p.outputId);
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
      if (t && worldMode) {
        await showWithFlight(p.index, p.outputId, t);
        return null;
      }
      if (t) {
        await showWithTransition(p.index, p.outputId, t);
        return null;
      }
      exitOverride(p.outputId);
      await cancelFlight(p.outputId);
      const r = reg.show(state, p.index, p.outputId, outputNameOf(p.outputId));
      state = r.state;
      await applyEffects(r.sideEffects);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.fit",
    description:
      "World mode: zoom the output's camera out to frame the consecutive workspace range [start..end] (per-output positions; defaults first..last). The shown workspace, bar state, and focus stay put. Optional transition {duration, easing?} animates the zoom.",
    handler: async (params: unknown): Promise<null> => {
      if (!worldMode) {
        throw new Error(
          "workspace.fit: requires canvas world mode (canvas: { world: true })");
      }
      const p = parseFitParams(params, resolveOutputName, focusedOutputId());
      const t = parseCameraTransition(params, "workspace.fit");
      await fitRange(p.outputId, p.start, p.end, t);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.unfit",
    description:
      "World mode: zoom the camera back in to one workspace, exiting a workspace.fit. Target = per-output `index` when given, else the focused window's workspace, else the shown one. A target other than the shown workspace behaves like show. Optional transition {duration, easing?} animates the zoom.",
    handler: async (params: unknown): Promise<null> => {
      if (!worldMode) {
        throw new Error(
          "workspace.unfit: requires canvas world mode (canvas: { world: true })");
      }
      const p = parseUnfitParams(params, resolveOutputName, focusedOutputId());
      const t = parseCameraTransition(params, "workspace.unfit");
      await unfitTo(p.outputId, p.index, t);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.pan",
    description:
      "World mode: pan the output's camera by {dx, dy} glass logical px (scaled by the current zoom into world units), entering free roaming -- every workspace on the output stays visible as the world goes by. Optional transition {duration, easing?} animates the step.",
    handler: async (params: unknown): Promise<null> => {
      if (!worldMode) {
        throw new Error(
          "workspace.pan: requires canvas world mode (canvas: { world: true })");
      }
      const p = parsePanParams(params, resolveOutputName, focusedOutputId());
      const t = parseCameraTransition(params, "workspace.pan");
      const cur = await sdk.windows.getOutputCamera(p.outputId);
      await freeCamera(p.outputId, {
        x: cur.x + p.dx / cur.zoom,
        y: cur.y + p.dy / cur.zoom,
        zoom: cur.zoom,
      }, t, "workspace.pan");
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.zoom",
    description:
      "World mode: multiply the output's camera zoom by `factor` (anchored at the view center; clamped to [0.05, 8]), entering free roaming. Optional transition {duration, easing?} animates it.",
    handler: async (params: unknown): Promise<null> => {
      if (!worldMode) {
        throw new Error(
          "workspace.zoom: requires canvas world mode (canvas: { world: true })");
      }
      const p = parseZoomParams(params, resolveOutputName, focusedOutputId());
      const t = parseCameraTransition(params, "workspace.zoom");
      const g = outputGeom.get(p.outputId);
      if (!g) {
        throw new Error(`workspace.zoom: output ${p.outputId} has unknown geometry`);
      }
      const cur = await sdk.windows.getOutputCamera(p.outputId);
      const z = Math.min(8, Math.max(0.05, cur.zoom * p.factor));
      // Keep the world point at the viewport center fixed across the
      // zoom change.
      await freeCamera(p.outputId, {
        x: cur.x + (g.width / 2) * (1 / cur.zoom - 1 / z),
        y: cur.y + (g.height / 2) * (1 / cur.zoom - 1 / z),
        zoom: z,
      }, t, "workspace.zoom");
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.bookmark-set",
    description:
      "World mode: save the output's current camera framing under `name` -- a dock captures the shown workspace, a fit captures the framed range, a roam captures the raw rect + zoom.",
    handler: async (params: unknown): Promise<{ name: string; kind: string }> => {
      if (!worldMode) {
        throw new Error(
          "workspace.bookmark-set: requires canvas world mode (canvas: { world: true })");
      }
      const p = parseBookmarkParams(params, resolveOutputName, focusedOutputId(),
        "workspace.bookmark-set");
      const framing = setBookmark(p.name, p.outputId);
      return { name: p.name, kind: framing.kind };
    },
  });

  sdk.actions.register({
    name: "workspace.bookmark-go",
    description:
      "World mode: fly/dock the camera to the bookmark `name`. Island bookmarks show that workspace; range bookmarks re-fit; free bookmarks park the camera. Optional transition {duration, easing?}.",
    handler: async (params: unknown): Promise<null> => {
      if (!worldMode) {
        throw new Error(
          "workspace.bookmark-go: requires canvas world mode (canvas: { world: true })");
      }
      const p = parseBookmarkParams(params, resolveOutputName, focusedOutputId(),
        "workspace.bookmark-go");
      const t = parseCameraTransition(params, "workspace.bookmark-go");
      await gotoBookmark(p.name, p.outputId, t);
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.bookmark-delete",
    description: "World mode: delete the bookmark `name`. Returns whether it existed.",
    handler: async (params: unknown): Promise<{ deleted: boolean }> => {
      const p = parseBookmarkParams(params, resolveOutputName, focusedOutputId(),
        "workspace.bookmark-delete");
      return { deleted: bookmarks.delete(p.name) };
    },
  });

  sdk.actions.register({
    name: "workspace.bookmark-list",
    description: "World mode: list saved bookmarks (name + framing).",
    handler: async (): Promise<Array<{ name: string } & BookmarkFraming>> => {
      return [...bookmarks].map(([name, f]) => ({ name, ...f }));
    },
  });

  sdk.actions.register({
    name: "workspace.move-window",
    description:
      "Move a window (by surfaceId) to a workspace identified by `name` (with handle-string fallback) or by `{index, output}`.",
    handler: async (params: unknown): Promise<null> => {
      const p = await parseMoveTarget(params);
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
      const t = transition ?? null;
      if (t && worldMode) {
        await showWithFlight(
          index, outputId ?? reg.OUTPUT_DEFAULT,
          { kind: t.kind, duration: t.duration, easing: t.easing },
        );
        return;
      }
      if (t) {
        await showWithTransition(
          index, outputId ?? 0,
          { kind: t.kind, duration: t.duration, easing: t.easing },
        );
        return;
      }
      const outId = outputId ?? reg.OUTPUT_DEFAULT;
      exitOverride(outId);
      await cancelFlight(outId);
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
  sdk.log(`canvas plugin registered (${worldMode ? "world" : "workspace parity"} mode)`);
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
): { name?: string; outputId: number; preferredOutputs?: string[];
     persistent?: boolean } {
  if (params === undefined || params === null) {
    return { outputId: defaultOutputId };
  }
  if (!isObj(params)) throw new TypeError("workspace.create: expected an object");
  const outputId = parseOptionalOutput(params, resolveOutput, defaultOutputId, "workspace.create");
  const out: { name?: string; outputId: number; preferredOutputs?: string[];
               persistent?: boolean } = { outputId };
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
  if (params.persistent !== undefined) {
    if (typeof params.persistent !== "boolean") {
      throw new TypeError("workspace.create: persistent must be a boolean");
    }
    out.persistent = params.persistent;
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

// Resolve a show/move `name` parameter. The caller passes EITHER:
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
//   3. Otherwise return null -- the caller decides between throwing and
//      create-on-reference (resolveOrCreateByName).
//
// When `output` is set, restrict the lookup to that output. Malformed
// params still throw TypeErrors; null strictly means "well-formed name,
// no such workspace".
function tryResolveShowName(
  state: WorkspaceState,
  params: unknown,
  resolveOutput: (input: string) => number | null,
): { index: WorkspaceIndex; outputId: number } | null {
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

  return null;
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

// Optional camera transition for workspace.fit / workspace.unfit: a
// camera move has no snapshot kind, so only duration (+ optional easing)
// matter; a `kind` field is tolerated and ignored so keybinds can share
// one transition object with workspace.show.
interface CameraTransitionSpec {
  duration: number;
  easing?: unknown;
}
function parseCameraTransition(
  params: unknown, label: string,
): CameraTransitionSpec | null {
  if (!isObj(params)) return null;
  const t = (params as { transition?: unknown }).transition;
  if (t === undefined || t === null) return null;
  if (!isObj(t)) {
    throw new TypeError(`${label}: transition must be an object`);
  }
  if (typeof t.duration !== "number" || !(t.duration > 0)) {
    throw new TypeError(
      `${label}: transition.duration must be > 0 (got ${String(t.duration)})`);
  }
  return { duration: t.duration, easing: (t as { easing?: unknown }).easing };
}

// workspace.fit: optional start/end per-output positions + optional output.
function parseFitParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { start?: number; end?: number; outputId: number } {
  if (params === undefined || params === null) {
    return { outputId: defaultOutputId };
  }
  if (!isObj(params)) throw new TypeError("workspace.fit: expected an object");
  const outputId = parseOptionalOutput(
    params, resolveOutput, defaultOutputId, "workspace.fit");
  const out: { start?: number; end?: number; outputId: number } = { outputId };
  for (const key of ["start", "end"] as const) {
    const v = params[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new TypeError(`workspace.fit: ${key} must be a positive integer`);
    }
    out[key] = v;
  }
  return out;
}

// workspace.unfit: optional per-output index (default: the shown
// workspace) + optional output.
function parseUnfitParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { index?: number; outputId: number } {
  if (params === undefined || params === null) {
    return { outputId: defaultOutputId };
  }
  if (!isObj(params)) throw new TypeError("workspace.unfit: expected an object");
  const outputId = parseOptionalOutput(
    params, resolveOutput, defaultOutputId, "workspace.unfit");
  const out: { index?: number; outputId: number } = { outputId };
  if (params.index !== undefined) {
    if (typeof params.index !== "number" || !Number.isInteger(params.index)
        || params.index < 1) {
      throw new TypeError("workspace.unfit: index must be a positive integer");
    }
    out.index = params.index;
  }
  return out;
}

// workspace.pan: dx/dy in glass logical px (either may be omitted = 0).
function parsePanParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { dx: number; dy: number; outputId: number } {
  if (!isObj(params)) {
    throw new TypeError("workspace.pan: expected an object with { dx?, dy?, output? }");
  }
  const outputId = parseOptionalOutput(
    params, resolveOutput, defaultOutputId, "workspace.pan");
  const num = (v: unknown, label: string): number => {
    if (v === undefined) return 0;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new TypeError(`workspace.pan: ${label} must be a finite number`);
    }
    return v;
  };
  const dx = num(params.dx, "dx");
  const dy = num(params.dy, "dy");
  if (dx === 0 && dy === 0) {
    throw new TypeError("workspace.pan: pass a non-zero dx and/or dy");
  }
  return { dx, dy, outputId };
}

// workspace.zoom: multiplicative factor (> 0).
function parseZoomParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { factor: number; outputId: number } {
  if (!isObj(params)) {
    throw new TypeError("workspace.zoom: expected an object with { factor, output? }");
  }
  if (typeof params.factor !== "number" || !Number.isFinite(params.factor)
      || params.factor <= 0) {
    throw new TypeError("workspace.zoom: factor must be a positive finite number");
  }
  const outputId = parseOptionalOutput(
    params, resolveOutput, defaultOutputId, "workspace.zoom");
  return { factor: params.factor, outputId };
}

// Bookmark verbs: { name, output? }.
function parseBookmarkParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
  label: string,
): { name: string; outputId: number } {
  if (!isObj(params)) {
    throw new TypeError(`${label}: expected an object with { name, output? }`);
  }
  if (typeof params.name !== "string" || params.name === "") {
    throw new TypeError(`${label}: name must be a non-empty string`);
  }
  const outputId = parseOptionalOutput(params, resolveOutput, defaultOutputId, label);
  return { name: params.name, outputId };
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

