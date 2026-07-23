// Canvas workspace provider (docs/canvas-design.md). Claims the
// 'workspace' namespace at priority 0 with the same verb/event/action
// surface as @overdraw/plugin-workspace-default, whose registry (the pure
// workspace state machine) it shares. All side effects live in the
// activation callback, so a higher-priority claim replaces this provider
// wholesale. Two modes, selected by the user's `canvas` config slice:
//
//   parity (default): each output's SHOWN workspace publishes as an
//   explicit island (id = durable handle, rect = null so the tile region
//   derives from the output minus reserved zones, members = the pushed
//   stack). On-screen behavior matches the default plugin exactly.
//
//   world (`world: true`): EVERY workspace publishes as an island at a
//   world rect along its output's row (slot pitch = output width +
//   canvas.gutter); hidden members lay out at their slots (pre-sized on
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
  // identity cameras). `elastic` sets the growth default; `bookmarks`
  // seeds named camera framings; `workspaces` declares named workspaces
  // that exist from boot (persistent by default, optional per-entry
  // output / elastic).
  canvas?: unknown;
  // The layout provider's configured gap (config.layout.gap). Used as
  // the strip scroll-reveal margin: revealing a column keeps its gap
  // band visible instead of sitting flush at the viewport edge. Static
  // (a runtime layout.grow-gap drifts the margin slightly; cosmetic).
  layoutGap?: unknown;
  // The layout provider's default mode (config.layout.mode), for islands
  // that declare no mode of their own.
  layoutMode?: unknown;
}

// Default spacing between neighboring island rects (both axes in grid
// arrangement). Visible as the void between islands while a camera
// flight crosses it or while fitted. `canvas.gutter` overrides.
const SLOT_GUTTER = 128;

export default async function init(
  sdk: PluginSdkShape, config?: CanvasPluginConfig,
): Promise<void> {
  // Everything -- state seeding, subscriptions, action registrations,
  // camera control -- happens on activation, so a displaced claim leaves
  // no trace.
  await sdk.registerPlugin("workspace", () => activate(sdk, config));
}

async function activate(
  sdk: PluginSdkShape, config?: CanvasPluginConfig,
): Promise<WorkspaceAPI> {
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

  // Elastic growth (canvas-design.md §5 "Layout mode is declared;
  // growth only sizes the region"): an elastic workspace island grows
  // along its row to the layout provider's natural size for its members
  // (measure()) and the docked camera scrolls within it to follow
  // focus. Fixed = the workarea rect; the same layout compresses into
  // it. Growth is strictly a sizing flag -- it never selects the
  // algorithm; which layout tiles the island is declared via
  // `config.layout.mode` and per-workspace `layout` entries. Config
  // `canvas.elastic` (boolean) sets the growth DEFAULT and
  // workspace.set-elastic overrides one workspace either way at runtime.
  // World arrangement (canvas-design.md §6): how workspace islands are
  // placed in the world. "rows" (default) = one horizontal filmstrip per
  // output; "grid" = row-major grid per output, wrapping at whatever
  // width shapes the world's bounds most like the screen (packRows) --
  // workspace.fit then frames a screen-shaped block instead of a long
  // strip, wasting far less glass on wide monitors.
  const arrangement = worldMode
    && (config?.canvas as { arrangement?: unknown }).arrangement === "grid"
    ? "grid" : "rows";
  const elasticRaw = worldMode
    ? (config?.canvas as { elastic?: unknown }).elastic : undefined;
  if (elasticRaw !== undefined && typeof elasticRaw !== "boolean") {
    sdk.log("canvas: config elastic must be a boolean (layout mode and "
      + "column width are declared in the layout config); ignored");
  }
  const elasticDefault = elasticRaw === true;
  // Strip camera behavior knobs (canvas slice, world mode only):
  //   scrollOnHover (default false): hover-driven focus (follow-pointer's
  //     pointer-enter) scrolls the strip to center the focused column.
  //     Off, only deliberate focus -- click, keyboard cycle, workspace
  //     switch, window map -- moves the camera.
  //   clickReveals (default true): a pointer press centers the pressed
  //     window's column (the pointer path to a partially visible column
  //     when scrollOnHover is off).
  //   unfitKeepsFocus (default true): workspace.unfit re-asserts the
  //     window focused at invoke time instead of letting the focus policy
  //     hand focus to whatever the landing leaves under the cursor.
  const boolOpt = (key: string, dflt: boolean): boolean => {
    const v = worldMode
      ? (config?.canvas as { [k: string]: unknown })[key] : undefined;
    if (v === undefined) return dflt;
    if (typeof v === "boolean") return v;
    sdk.log(`canvas: config ${key} must be a boolean; using ${dflt}`);
    return dflt;
  };
  const scrollOnHover = boolOpt("scrollOnHover", false);
  const clickReveals = boolOpt("clickReveals", true);
  const unfitKeepsFocus = boolOpt("unfitKeepsFocus", true);
  // Camera scroll animation within a strip (ms).
  const SCROLL_MS = 150;
  // Scroll-reveal margin (the layout gap): a revealed column sits this
  // many world px from the viewport edge, keeping the inter-column gap
  // visible -- the neighbor ends exactly at the edge.
  const scrollMargin = (typeof config?.layoutGap === "number"
    && Number.isFinite(config.layoutGap) && config.layoutGap >= 0)
    ? config.layoutGap : 0;
  const defaultLayoutMode = typeof config?.layoutMode === "string"
    ? config.layoutMode : "master-stack";

  // Island spacing (canvas.gutter, world px; default SLOT_GUTTER).
  const gutterRaw = worldMode
    ? (config?.canvas as { gutter?: unknown }).gutter : undefined;
  const gutter = (typeof gutterRaw === "number"
    && Number.isFinite(gutterRaw) && gutterRaw >= 0)
    ? Math.round(gutterRaw) : SLOT_GUTTER;

  // Empty-island backdrops: a translucent world-space quad marks each
  // island with no members, so empty (typically persistent) workspaces
  // are visible while fitted or roaming instead of reading as void.
  // `canvas.islandBackdrop` overrides the color ("#rrggbb" or
  // "#rrggbbaa"); false disables.
  function parseBackdropColor(
    v: unknown,
  ): { r: number; g: number; b: number; a: number } | null {
    if (v === false) return null;
    const def = { r: 128, g: 128, b: 128, a: 56 };
    if (typeof v !== "string") return def;
    const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(v);
    if (!m) {
      sdk.log(`canvas: islandBackdrop must be #rrggbb[aa]; using the default`);
      return def;
    }
    const n = parseInt(m[1], 16);
    return {
      r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff,
      a: m[2] !== undefined ? parseInt(m[2], 16) : 56,
    };
  }
  const backdropColor = worldMode
    ? parseBackdropColor((config?.canvas as { islandBackdrop?: unknown }).islandBackdrop)
    : null;
  let lastBackdropsJson = "";

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
  // Per-output activity memory (mirrors the WM's stacking rule): the last
  // activated window on each output. Collapse and zoom transience key on
  // THIS, not on seat-global focus, so focus or camera changes on another
  // output never release a strip's collapse or unzoom its member.
  const activeByOutput = new Map<number, number>();
  function outputOfSurface(sid: number): number | null {
    const h = state.surfaceToHandle.get(sid);
    if (h === undefined) return null;
    return state.byHandle.get(h)?.outputId ?? null;
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
  // A reserved zone changed (a bar mapped, resized, or unmapped): the
  // workarea moved, so islands resize to it and docked cameras re-offset.
  // publishWorld re-reads the workarea itself; downstream dedupe (island
  // compare, camera cache) absorbs the no-op case.
  sdk.events.subscribe("output.workarea-changed", (_name, payload) => {
    if (!worldMode || !stateReady) return;
    const p = payload as { outputId?: unknown };
    if (!payload || typeof payload !== "object" || typeof p.outputId !== "number") return;
    void publishWorld();
  });
  // Keyboard focus tracking. Each window.change carries activated: bool; a
  // surface becoming activated is our signal that its output is the
  // user-facing focused output. When the focused surface unmaps (no
  // explicit "loses activation" event arrives), the cache retains the
  // last-known output so a hotkey on an empty workspace still targets
  // where the user was working.
  sdk.events.subscribe("window.change", (_name, payload) => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as { surfaceId?: unknown; activated?: unknown; changed?: unknown;
                           focusReason?: unknown };
    if (typeof p.surfaceId !== "number") return;
    if (typeof p.activated !== "boolean") return;
    // Only react to events that actually carry an activation transition;
    // a window.change for a pure title/appId update may not have its
    // activated bit toggling.
    const changed = Array.isArray(p.changed) ? p.changed as unknown[] : [];
    if (!changed.includes("activated")) return;
    if (p.activated) {
      const prevFocused = focusedSurfaceId;
      focusedSurfaceId = p.surfaceId;
      // Collapse follows focus: focus moving onto or off a sizeMode
      // member engages/releases the island collapse -- re-solve.
      if (sizeModeMembers.has(p.surfaceId)
          || (prevFocused !== null && sizeModeMembers.has(prevFocused))) {
        void publishWorld();
      }
      // Resolve surface -> workspace -> output. If the surface isn't
      // tracked (unmapped, layer-shell, popup) leave the cache as-is.
      const handle = state.surfaceToHandle.get(p.surfaceId);
      if (handle !== undefined) {
        const rec = state.byHandle.get(handle);
        if (rec) focusedOutputIdCache = rec.outputId;
        // Zoom is focus-transient in world mode: activity moving to
        // ANOTHER window on the SAME output releases the collapse,
        // expands the strip, and moves the world under the maximized
        // member -- so rather than leave it as a strip-anchored cover it
        // unzooms (the layout recompute restores its slot). The edge is
        // derived from the OUTPUT's previous active window, not the
        // seat's previous focus: focus may have detoured through a
        // launcher (layer surface), another output, or a window that
        // already unmapped, and the release must still fire. Activity is
        // output-local: focus landing on a different output changes
        // nothing for the zoomed member's output. Fullscreen is
        // untouched -- it is glass furniture, not a strip resident.
        const prevActive = rec ? activeByOutput.get(rec.outputId) : undefined;
        if (rec) activeByOutput.set(rec.outputId, p.surfaceId);
        if (rec && prevActive !== undefined && prevActive !== p.surfaceId
            && sizeModeMembers.get(prevActive) === "maximized") {
          void sdk.windows.propose(prevActive, { sizeMode: "none" });
        }
        // The collapse keys on activeByOutput: an activity change onto
        // or off a sizeMode member re-solves the world even when the
        // seat-global focus edge (checked above) missed it.
        if (rec && prevActive !== p.surfaceId
            && (sizeModeMembers.has(p.surfaceId)
                || (prevActive !== undefined && sizeModeMembers.has(prevActive)))) {
          void publishWorld();
        }
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
        // Unless scrollOnHover opts in, pointer-caused focus that isn't a
        // press -- hover crossings (pointer-enter) and world-moved-under-
        // cursor repicks -- is exempt: the strip must not shift under a
        // merely-moving cursor. A deliberate focus -- click, keyboard
        // cycle, workspace switch, window map -- still reveals; so does
        // an event with no reason (core versions that don't stamp one).
        // Fullscreen members never drive the strip reveal: their outer is
        // the output rect, and revealing it resets the scroll (see
        // revealSurface).
        if (rec && worldMode && isElastic(handle) && !override.has(rec.outputId)
            && state.shownByOutput.get(rec.outputId) === handle
            && sizeModeMembers.get(p.surfaceId) !== "fullscreen"
            && (scrollOnHover || (p.focusReason !== "pointer-enter"
                                  && p.focusReason !== "pointer-repick"))) {
          const sid = p.surfaceId;
          void (async () => {
            const snap = await sdk.windows.get(sid);
            // A window no layout pass has placed yet carries a
            // degenerate placeholder rect; its retile will land through
            // the stack.relayout trigger instead.
            if (!snap?.outer || snap.outer.width <= 0) return;
            if (focusedSurfaceId !== sid) return;
            // Focus-driven: minimal reveal, unless scrollOnHover opted
            // back into the always-center behavior wholesale.
            const align = scrollOnHover ? "center" : "visible";
            if (revealScroll(rec.outputId, handle, snap.outer, align) !== null) {
              await applyScroll(rec.outputId);
            }
          })();
        }
      }
    } else if (focusedSurfaceId === p.surfaceId) {
      focusedSurfaceId = null;
      // Deactivation without a successor (focus went to a layer surface
      // or nothing): output activity is sticky, so a zoomed member stays
      // zoomed and its collapse holds until another window on its output
      // activates. Keep focusedOutputIdCache too: the focus departed but
      // the user's pointer/keyboard is still anchored on that output.
    }
  });
  // A pointer press is deliberate intent: center the pressed window's
  // column in its docked strip. Hover-driven focus never scrolls (the
  // gate in the window.change handler), so the click is the pointer path
  // that commits to a partially visible column.
  sdk.events.subscribe("pointer.pressed", (_name, payload) => {
    if (!worldMode || !clickReveals) return;
    if (!payload || typeof payload !== "object") return;
    const sid = (payload as { surfaceId?: unknown }).surfaceId;
    if (typeof sid !== "number") return;
    void revealSurface(sid);
  });

  // State changes that re-solve the world: a member floating/unfloating
  // joins or leaves the tiled set an elastic island is measured for, an
  // active maximized member collapses its strip to the viewport (a
  // fullscreen member never touches the strip -- glass furniture), and a
  // size constraint changes what the layout measures for that member (a
  // client may state its minimum at any point in its life, not only
  // before it maps). window.committed is the observe-only signal for
  // behavioral-state commits.
  const MEASURED_FIELDS = ["tiling", "sizeMode", "visible", "constraints"];
  // Members currently holding sizeMode != none (value = which mode),
  // tracked from committed events so focus edges can tell when the
  // collapse engages/releases (collapse follows the FOCUSED sizeMode
  // member; see tiledMembers) and whether the departed member was
  // maximized (zoom is focus-transient in world mode; see below).
  const sizeModeMembers = new Map<number, string>();
  sdk.events.subscribe("window.committed", (_name, payload) => {
    if (!worldMode || !payload || typeof payload !== "object") return;
    const p = payload as { surfaceId?: unknown; changed?: unknown;
                           current?: { sizeMode?: unknown } };
    if (typeof p.surfaceId !== "number" || !Array.isArray(p.changed)) return;
    if (p.changed.includes("sizeMode")) {
      if (typeof p.current?.sizeMode === "string" && p.current.sizeMode !== "none") {
        sizeModeMembers.set(p.surfaceId, p.current.sizeMode);
      } else {
        sizeModeMembers.delete(p.surfaceId);
      }
    }
    if (!p.changed.some((f) => MEASURED_FIELDS.includes(f as string))) return;
    if (!state.surfaceToHandle.has(p.surfaceId)) return;
    void publishWorld();
  });

  // Layout parameter changes (gap, per-window column widths) change
  // what measure() returns, so elastic island rects re-solve. The
  // launcher emits this after routing any layout.setParams.
  sdk.events.subscribe("layout.params-changed", () => {
    if (!worldMode) return;
    void publishWorld();
  });

  // Elastic strips: after each layout pass, if the focused window's rect
  // moved (retile, new column at the strip's head), keep it inside the
  // docked view. stack.relayout carries the fresh post-layout rects, so
  // this needs no extra windows.get round trip.
  sdk.events.subscribe("stack.relayout", (_name, payload) => {
    if (!worldMode || focusedSurfaceId === null) return;
    if (!payload || typeof payload !== "object") return;
    const wins = (payload as { windows?: unknown }).windows;
    if (!Array.isArray(wins)) return;
    const entry = wins.find(
      (w): w is { newOuter: { x: number; y: number; width: number; height: number };
                  oldOuter?: { x: number; y: number; width: number; height: number } } =>
        isObj(w) && w.surfaceId === focusedSurfaceId && isObj(w.newOuter)
        && typeof (w.newOuter as { width?: unknown }).width === "number"
        && (w.newOuter as { width: number }).width > 0);
    if (!entry) return;
    // Only chase rects that MOVED. A pass that re-delivered the same rect
    // (a reserved-zones re-check, a sibling-only retile) reveals nothing;
    // without this, a layer client committing every frame would re-reveal
    // the focused column on every hover-focus change.
    const o = entry.oldOuter;
    const n = entry.newOuter;
    if (o && o.x === n.x && o.y === n.y
        && o.width === n.width && o.height === n.height) return;
    // A member ENTERING fullscreen reports its outer jumping to the
    // output rect -- following that would reset the strip scroll (see
    // revealSurface).
    if (sizeModeMembers.get(focusedSurfaceId) === "fullscreen") return;
    const handle = state.surfaceToHandle.get(focusedSurfaceId);
    if (handle === undefined || !isElastic(handle)) return;
    const rec = state.byHandle.get(handle);
    if (!rec || override.has(rec.outputId)) return;
    if (state.shownByOutput.get(rec.outputId) !== handle) return;
    if (revealScroll(rec.outputId, handle, entry.newOuter, "visible") !== null) {
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
    activeByOutput.delete(p.outputId);
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
  // slot s of output O sits at O.arrangement + s * (O.width + gutter)
  // horizontally. Slots are per-workspace-handle, assigned on first
  // placement and kept for the workspace's lifetime; collisions after a
  // hotplug migration resolve to the lowest free slot on the new row. ALL
  // workspaces publish (hidden ones too, so their members are laid out at
  // their slots and arrive pre-sized on show); the draw stack still gates
  // visibility. `show` docks the camera on the shown island's rect.
  const slotByHandle = new Map<WorkspaceHandle, number>();
  // Per-workspace scroll offset within an elastic island wider than the
  // viewport (world px from the island's left edge; clamped on use, so a
  // shrinking island self-corrects). Scroll is x-only: strips grow along
  // their (grid) row.
  const scrollByHandle = new Map<WorkspaceHandle, number>();
  // Per-workspace growth. Precedence: runtime override
  // (workspace.set-elastic, session-scoped, pruned with the workspace) >
  // config declaration by NAME (canvas.workspaces entries -- survives
  // destroy/recreate cycles since it keys on the name) > config default.
  const growthByHandle = new Map<WorkspaceHandle, boolean>();
  const elasticByName = new Map<string, boolean>();
  // Per-workspace declared layout, published verbatim as the island's
  // layout hint (`{ mode, column? }`; layout-types documents the
  // shapes). Same precedence as growth: runtime override
  // (workspace.set-layout, keyed by handle, session-scoped) > config
  // declaration by NAME (canvas.workspaces `layout` entries) > absent
  // (the layout provider's configured default mode).
  const layoutByName = new Map<string, { [k: string]: unknown }>();
  const layoutByHandle = new Map<WorkspaceHandle, { [k: string]: unknown }>();
  function isElastic(handle: WorkspaceHandle): boolean {
    const override = growthByHandle.get(handle);
    if (override !== undefined) return override;
    const name = state.byHandle.get(handle)?.name;
    const declared = name !== undefined ? elasticByName.get(name) : undefined;
    return declared ?? elasticDefault;
  }
  function layoutHintFor(handle: WorkspaceHandle): { [k: string]: unknown } | undefined {
    const override = layoutByHandle.get(handle);
    if (override !== undefined) return override;
    const name = state.byHandle.get(handle)?.name;
    return name !== undefined ? layoutByName.get(name) : undefined;
  }
  // Which end of the member list a newly mapped window joins. The member
  // order IS the column order in columns mode, so a new window belongs at
  // the tail -- the strip reads left to right in the order things opened,
  // and the head is where the oldest window lives. Master-stack's head is
  // its master slot, where a new window is meant to land.
  function insertEndFor(handle: WorkspaceHandle | undefined): "head" | "tail" {
    if (handle === undefined) return "head";
    const mode = (layoutHintFor(handle)?.mode as string | undefined)
      ?? defaultLayoutMode;
    return mode === "columns" ? "tail" : "head";
  }
  // Which grid row each workspace occupies ("grid" arrangement). Sticky
  // against churn: a changed island set or slot order repacks outright,
  // but a width change only repacks when the better packing wins by
  // REPACK_MARGIN. Growth must be able to rewrap -- a workspace is empty
  // when it is created and only becomes a long strip later, so a wrap
  // frozen at creation would pack every strip as if it were one screen
  // wide. The margin is what keeps that from twitching: one more window
  // in an already-wide island leaves the grid alone; a strip doubling in
  // length rewraps it.
  const rowByHandle = new Map<WorkspaceHandle, number>();
  const packedSetByOutput = new Map<number, string>();
  const REPACK_MARGIN = 0.85;
  // Row arrangement computed by publishWorld: each workspace's island
  // rect, keyed per output. camPosFor / fitCameraFor read this cache
  // synchronously; publishWorld refreshes it on every structural change.
  const rowRectsByOutput = new Map<
    number,
    Map<WorkspaceHandle, { x: number; y: number; width: number; height: number }>>();
  const lastCamByOutput = new Map<number, { x: number; y: number }>();
  // Usable glass per output (viewport minus reserved zones, e.g. the
  // bar's band), OUTPUT-LOCAL coords. The bar lives on the LENS, not in
  // the world: islands are sized to this and the docked camera offsets
  // them into it, so the world never carries dead bands. Fit framings
  // center in it too. Refreshed on publish, before each fit, and on
  // output.workarea-changed (zones move when bars map/unmap).
  const workareaByOutput = new Map<
    number, { x: number; y: number; width: number; height: number }>();
  function workareaOf(
    outputId: number, g: { width: number; height: number },
  ): { x: number; y: number; width: number; height: number } {
    return workareaByOutput.get(outputId)
      ?? { x: 0, y: 0, width: g.width, height: g.height };
  }
  async function refreshWorkarea(outputId: number): Promise<void> {
    const g = outputGeom.get(outputId);
    if (!g) return;
    try {
      const wa = await sdk.windows.getOutputWorkarea(outputId);
      if (wa) {
        workareaByOutput.set(outputId,
          { x: wa.x - g.x, y: wa.y - g.y, width: wa.width, height: wa.height });
      }
    } catch { /* broker without workarea support (harness): full viewport */ }
  }
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
  // out just enough to fit the 2D bounds (never past 1), centered both
  // ways. The camera views the world from (originX + x, originY + y)
  // over logical/zoom world units, so x/y are offsets from the output's
  // arrangement position; the non-binding axis letterboxes.
  function fitCameraFor(
    outputId: number, handles: ReadonlyArray<WorkspaceHandle>,
  ): { x: number; y: number; zoom: number } | null {
    const g = outputGeom.get(outputId);
    if (!g) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const h of handles) {
      const r = islandRectFor(outputId, h);
      if (!r) continue;
      minX = Math.min(minX, r.x);
      maxX = Math.max(maxX, r.x + r.width);
      minY = Math.min(minY, r.y);
      maxY = Math.max(maxY, r.y + r.height);
    }
    if (minX === Infinity) return null;
    // Frame within the WORKAREA (viewport minus reserved zones): the
    // zoom fits the bounds into the usable glass, and the bounds center
    // maps to the workarea's center -- not the viewport's -- so the
    // fitted world sits below the bar instead of under it.
    const wa = workareaOf(outputId, g);
    const zoom = Math.min(
      wa.width / (maxX - minX), wa.height / (maxY - minY), 1);
    return {
      x: (minX + maxX) / 2 - g.x - (wa.x + wa.width / 2) / zoom,
      y: (minY + maxY) / 2 - g.y - (wa.y + wa.height / 2) / zoom,
      zoom,
    };
  }

  // Where the focused column `rect` sits in the docked view of `handle`'s
  // island -- the WORKAREA-wide window onto the strip. Two alignments:
  //   "center" (pointer commits: a press, workspace.reveal): the column's
  //     place in the strip picks the framing -- neighbors both sides ->
  //     CENTERED so both peek in and either can be hovered or clicked;
  //     only one neighbor -> flush to ITS side (head sits left, tail
  //     sits right), spending the slack on the direction that has strip
  //     in it rather than on void.
  //   "visible" (focus-driven reveals: keyboard cycling, retile follow,
  //     flight aiming): minimal scroll -- a column already fully in view
  //     leaves the camera alone (focus walking across visible columns
  //     must not shift the strip); an off-view column scrolls just
  //     enough to sit flush at the edge it entered from.
  // A column wider than the view can't do either; its left edge wins.
  // Updates scrollByHandle; returns the new scroll, or null when the view
  // already sits there.
  function revealScroll(
    outputId: number, handle: WorkspaceHandle,
    rect: { x: number; width: number },
    align: "center" | "visible" = "center",
  ): number | null {
    const g = outputGeom.get(outputId);
    const isl = islandRectFor(outputId, handle);
    if (!g || !isl) return null;
    const wa = workareaOf(outputId, g);
    const maxScroll = Math.max(0, isl.width - wa.width);
    const prev = scrollByHandle.get(handle) ?? 0;
    // The margin keeps the layout's inter-column gap visible at the view
    // edge: the neighbor ends exactly at the edge. The head/tail columns
    // keep their island-edge gap since clamping lands on 0 / maxScroll.
    const m = Math.min(scrollMargin, wa.width / 4);
    // Strip-local column edges.
    const left = rect.x - isl.x;
    const right = left + rect.width;
    const slack = wa.width - rect.width;
    let s: number;
    if (align === "visible") {
      if (left - m >= prev && right + m <= prev + wa.width) return null;
      s = slack <= 0 || left - m < prev
        ? left - m                      // entered from the left / oversized
        : right + m - wa.width;         // entered from the right
    } else {
      // Columns tile the island edge to edge, so anything but the head
      // has strip to its left and anything but the tail to its right.
      const hasLeft = left > m;
      const hasRight = isl.width - right > m;
      if (slack <= 0 || (!hasLeft && hasRight)) {
        s = left - m;
      } else if (hasLeft && hasRight) {
        s = Math.round(left - slack / 2);
      } else {
        s = right + m - wa.width;
      }
    }
    s = Math.min(maxScroll, Math.max(0, s));
    scrollByHandle.set(handle, s);
    return s !== prev ? s : null;
  }

  // Fold the focused window's reveal into `handle`'s stored strip scroll
  // WITHOUT touching the camera -- callers about to compute a flight
  // target (unfit, show-with-flight) use it so the tween aims at the
  // view that will hold after the post-settle reveal, instead of flying
  // to a stale scroll and snapping. No-op when the focused window isn't
  // a member of `handle` or the strip isn't elastic.
  async function foldFocusIntoScroll(
    outputId: number, handle: WorkspaceHandle,
  ): Promise<void> {
    const sid = focusedSurfaceId;
    if (sid === null || !isElastic(handle)) return;
    if (state.surfaceToHandle.get(sid) !== handle) return;
    const snap = await sdk.windows.get(sid);
    if (!snap?.outer || snap.outer.width <= 0) return;
    revealScroll(outputId, handle, snap.outer, "visible");
  }

  // Center/reveal `sid`'s column within its docked elastic strip. No-op
  // when the surface isn't tracked, the island isn't an elastic strip, or
  // the output is overridden (fit / free roam) or showing another
  // workspace. Serves the deliberate reveal paths: pointer presses and
  // the workspace.reveal action.
  async function revealSurface(sid: number): Promise<void> {
    // A fullscreen member is glass furniture: its outer is the world-space
    // output rect, not a strip column -- "revealing" it would clamp the
    // strip scroll to 0 and lose the user's framing while the (opaque,
    // camera-exempt) surface covers the glass anyway.
    if (sizeModeMembers.get(sid) === "fullscreen") return;
    const handle = state.surfaceToHandle.get(sid);
    if (handle === undefined || !worldMode || !isElastic(handle)) return;
    const rec = state.byHandle.get(handle);
    if (!rec || override.has(rec.outputId)) return;
    if (state.shownByOutput.get(rec.outputId) !== handle) return;
    const snap = await sdk.windows.get(sid);
    if (!snap?.outer || snap.outer.width <= 0) return;
    if (revealScroll(rec.outputId, handle, snap.outer) !== null) {
      await applyScroll(rec.outputId);
    }
  }

  // Move a docked camera to its (re-clamped) scroll position within the
  // shown island: a short tween (denied tweens -- grabs -- fall back to
  // the instant write), then one settled write. Overridden / flying
  // outputs are left alone; their owner re-docks through camPosFor, which
  // reads the same scroll state.
  async function applyScroll(outputId: number): Promise<void> {
    if (override.has(outputId) || flying.has(outputId)) return;
    const shown = state.shownByOutput.get(outputId);
    if (shown === undefined) return;
    const target = camPosFor(outputId, shown);
    const last = lastCamByOutput.get(outputId);
    if (last && last.x === target.x && last.y === target.y) return;
    if (sdk.animations) {
      const token = ++flightSeq;
      flying.set(outputId, token);
      try {
        const cur = await sdk.windows.getOutputCamera(outputId);
        if (cur.x !== target.x || cur.y !== target.y || cur.zoom !== 1) {
          const spec: TweenSpec = {
            type: "tween",
            target: { kind: "output-camera", outputId },
            from: cur,
            to: { x: target.x, y: target.y, zoom: 1 },
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
    const settle = camPosFor(outputId, shown);
    lastCamByOutput.set(outputId, settle);
    await sdk.windows.setOutputCamera(outputId, settle.x, settle.y);
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

  // Dock target for a workspace: the camera that places the island's
  // origin at the output's WORKAREA origin (below/beside any bar band --
  // the reservation lives in the camera, not the world), plus the
  // clamped x scroll offset (elastic islands wider than the workarea
  // scroll to follow focus; fixed islands always clamp to 0).
  function camPosFor(
    outputId: number, handle: WorkspaceHandle,
  ): { x: number; y: number } {
    const g = outputGeom.get(outputId);
    const r = islandRectFor(outputId, handle);
    if (!g || !r) return { x: 0, y: 0 };
    const wa = workareaOf(outputId, g);
    const maxScroll = Math.max(0, r.width - wa.width);
    const s = Math.min(maxScroll, Math.max(0, scrollByHandle.get(handle) ?? 0));
    return { x: (r.x - g.x - wa.x) + s, y: r.y - g.y - wa.y };
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

  // How far a row assignment's bounds miss the output's shape. Compared in
  // log space so 2x too wide and 2x too tall count as the same sin, where
  // a linear difference would call the wide one worse. 0 = bounds exactly
  // the screen's shape; lower is better.
  function rowsScore(
    ordered: ReadonlyArray<WorkspaceHandle>,
    rows: ReadonlyMap<WorkspaceHandle, number>,
    widthOf: (h: WorkspaceHandle) => number,
    rowHeight: number,
    aspect: number,
  ): number {
    const widthByRow = new Map<number, number>();
    let lastRow = 0;
    for (const h of ordered) {
      const r = rows.get(h) ?? 0;
      widthByRow.set(r, (widthByRow.get(r) ?? 0) + widthOf(h) + gutter);
      lastRow = Math.max(lastRow, r);
    }
    let widest = 0;
    for (const w of widthByRow.values()) widest = Math.max(widest, w - gutter);
    if (widest <= 0) return Infinity;
    const used = lastRow + 1;
    const height = used * rowHeight + (used - 1) * gutter;
    return Math.abs(Math.log((widest / height) / aspect));
  }

  // Wrap islands into grid rows whose overall bounds sit closest to the
  // output's aspect, so workspace.fit frames a block shaped like the
  // screen instead of a long ribbon. Rows are uniform-height, so only the
  // wrap width is in question: try every row count, greedily fill in slot
  // order against the width that count's bounds could afford, and keep the
  // packing that scores best. Wide (elastic) islands therefore wrap after
  // fewer columns than narrow ones -- a count-based wrap can only assume
  // every island is workarea-wide.
  function packRows(
    ordered: ReadonlyArray<WorkspaceHandle>,
    widthOf: (h: WorkspaceHandle) => number,
    rowHeight: number,
    aspect: number,
  ): { rows: Map<WorkspaceHandle, number>; score: number } | null {
    if (ordered.length === 0 || rowHeight <= 0 || aspect <= 0) return null;
    let best: { rows: Map<WorkspaceHandle, number>; score: number } | null = null;
    for (let r = 1; r <= ordered.length; r++) {
      const budget = aspect * (r * rowHeight + (r - 1) * gutter);
      const rows = new Map<WorkspaceHandle, number>();
      let row = 0;
      let x = 0;
      for (const h of ordered) {
        const w = widthOf(h);
        // An island wider than the budget still takes its own row rather
        // than leaving an empty one above it.
        if (x > 0 && x + w > budget) { row++; x = 0; }
        rows.set(h, row);
        x += w + gutter;
      }
      const score = rowsScore(ordered, rows, widthOf, rowHeight, aspect);
      // Strict: ties keep the earlier (flatter) packing.
      if (!best || score < best.score) best = { rows, score };
    }
    return best;
  }

  // The members the layout will tile, mirroring the driver's compute()
  // lane filter: managed, visible, not fullscreen. Returns null when the
  // output's ACTIVE member is maximized: the collapse squeezes the island
  // to the workarea (a maximize covers the usable glass, not a
  // multi-screen strip). Fullscreen members never affect the strip in
  // either direction -- they are glass furniture covering the monitor on
  // their own, so activating one leaves the columns untouched. A
  // non-active maximized MANAGED member still occupies its slot and
  // counts toward the measured width. A member without a WM snapshot
  // counts for nothing: undersizing (workarea-width island) is always
  // recoverable, oversizing stretches windows past the output.
  function tiledMembers(
    members: ReadonlyArray<number>,
    snapById: Map<number, WindowSnapshotLike>,
    outputId: number,
  ): number[] | null {
    // Collapse follows OUTPUT-LOCAL activity, not seat-global focus: a
    // zoomed member stays collapsed while it is the last-activated
    // window on ITS output, even when focus sits on another output.
    const active = activeByOutput.get(outputId) ?? focusedSurfaceId;
    const tiled: number[] = [];
    for (const id of members) {
      const ws = snapById.get(id)?.windowState;
      if (!ws) continue;
      if (!ws.visible) continue;
      // Fullscreen is glass furniture: it covers the monitor by itself
      // (output-anchored surface), so it neither counts toward the strip
      // nor EVER collapses it -- activating a fullscreen member must
      // leave the tiled columns exactly as they are, or cycling through
      // it would compress the strip into the workarea and back. Only an
      // active MAXIMIZED member collapses (maximize covers the usable
      // glass; the camera docks on it).
      if (ws.sizeMode === "fullscreen") continue;
      if (ws.sizeMode !== "none" && id === active) return null;
      if (ws.tiling === "managed") tiled.push(id);
    }
    return tiled;
  }

  // Elastic island widths come from the layout provider's natural size
  // (measure(); canvas-design.md §5 "growth only sizes the region"),
  // never computed here -- two owners of one geometry drift apart.
  // Floored at the workarea: islands grow, they never shrink below the
  // glass. A provider without measure() leaves growth inert.
  async function measuredWidth(
    handle: WorkspaceHandle,
    members: ReadonlyArray<number>,
    wa: { width: number; height: number },
    snapById: Map<number, WindowSnapshotLike>,
  ): Promise<number> {
    const rec = state.byHandle.get(handle);
    const tiled = tiledMembers(members, snapById, rec?.outputId ?? reg.OUTPUT_DEFAULT);
    // No tiled members -> the workarea, without asking: every provider
    // floors its measure there, and publishWorld runs on each structural
    // change across every island.
    if (tiled === null || tiled.length === 0) return wa.width;
    const hint = layoutHintFor(handle);
    const m = await sdk.windows.measureIsland({
      islandId: handle,
      windows: tiled,
      workarea: { width: wa.width, height: wa.height },
      ...(hint !== undefined ? { layout: hint } : {}),
    });
    return Math.max(wa.width, m?.width ?? wa.width);
  }

  // publishWorld awaits many round trips (workareas, elastic measures,
  // setIslands, cameras) and is invoked fire-and-forget from independent
  // event handlers, so runs must not overlap: an older run resuming after
  // a newer one would push a stale island set / camera and poison the
  // dedupe caches (lastCamByOutput, lastBackdropsJson) and
  // rowRectsByOutput. Serialize: one run at a time; calls during a run
  // coalesce into a single rerun that starts from fresh state once the
  // active run finishes.
  let publishRun: Promise<void> | null = null;
  let publishAgain = false;

  function publishWorld(): Promise<void> {
    if (publishRun) {
      publishAgain = true;
      return publishRun;
    }
    publishRun = (async () => {
      do {
        publishAgain = false;
        await publishWorldPass();
      } while (publishAgain);
    })().finally(() => { publishRun = null; });
    return publishRun;
  }

  async function publishWorldPass(): Promise<void> {
    if (!worldMode) return;
    // Drop slots + scroll + growth overrides for destroyed workspaces.
    for (const h of [...slotByHandle.keys()]) {
      if (!state.byHandle.has(h)) slotByHandle.delete(h);
    }
    for (const h of [...scrollByHandle.keys()]) {
      if (!state.byHandle.has(h)) scrollByHandle.delete(h);
    }
    for (const h of [...growthByHandle.keys()]) {
      if (!state.byHandle.has(h)) growthByHandle.delete(h);
    }
    for (const h of [...layoutByHandle.keys()]) {
      if (!state.byHandle.has(h)) layoutByHandle.delete(h);
    }
    for (const h of [...rowByHandle.keys()]) {
      if (!state.byHandle.has(h)) rowByHandle.delete(h);
    }
    // Elastic growth reads each member's lane from a windows snapshot.
    // Any source of elasticity counts: the config default, runtime
    // set-elastic overrides, AND per-name declarations (canvas.workspaces
    // entries) -- forgetting the last starved declared-elastic strips of
    // their snapshots and every member counted as nothing.
    const anyElastic = elasticDefault
      || [...growthByHandle.values()].some((v) => v)
      || [...elasticByName.values()].some((v) => v);
    const snapById = new Map<number, WindowSnapshotLike>();
    if (anyElastic) {
      for (const s of await sdk.windows.list()) snapById.set(s.surfaceId, s);
    }
    const islands: Array<{
      id: number; contextOutputId: number;
      rect: { x: number; y: number; width: number; height: number } | null;
      members: number[];
      layout?: { [k: string]: unknown };
    }> = [];
    // Workareas first: the arrangement rebuild below must stay
    // synchronous -- rowRectsByOutput is read by event handlers (drops,
    // scroll), so it must never be observable half-built.
    for (const outputId of state.positionsByOutput.keys()) {
      await refreshWorkarea(outputId);
    }
    // Elastic widths second, for the same reason: measure() is an async
    // round trip to the layout provider, so every grown width is
    // resolved before the rebuild starts.
    const widthByHandle = new Map<WorkspaceHandle, number>();
    for (const [outputId, handles] of state.positionsByOutput) {
      const g = outputGeom.get(outputId);
      if (!g) continue;
      const wa = workareaOf(outputId, g);
      for (const h of handles) {
        if (!isElastic(h)) continue;
        const rec = state.byHandle.get(h);
        if (!rec) continue;
        widthByHandle.set(h,
          await measuredWidth(h, rec.members, wa, snapById));
      }
    }
    rowRectsByOutput.clear();
    for (const [outputId, handles] of state.positionsByOutput) {
      const slots = resolveSlots(handles);
      const g = outputGeom.get(outputId);
      // Arrangement: sticky slot ORDER, per-island widths (workarea for
      // fixed, layout-measured for elastic), cumulative x origins with
      // canvas.gutter between islands. Islands are WORKAREA-sized (the
      // usable glass): bars are lens furniture, so the world packs pure
      // content edge-to-edge and the docked camera offsets each island
      // into the workarea. "rows" is one filmstrip; "grid" wraps
      // row-major at the width that shapes the fit bounds like the
      // screen (packRows), stepping y by island height + gutter.
      // A growing island shoves its right-hand neighbors along its own
      // (grid) row -- order-preserving and monotone (canvas-design.md
      // §6's shove, scoped to one row; grid rows are independent).
      const row = new Map<
        WorkspaceHandle, { x: number; y: number; width: number; height: number }>();
      if (g) {
        const wa = workareaOf(outputId, g);
        const ordered = [...handles].sort(
          (a, b) => (slots.get(a) ?? 0) - (slots.get(b) ?? 0));
        if (arrangement === "grid" && g.height > 0) {
          const aspect = g.width / g.height;
          const widthOf = (h: WorkspaceHandle) => widthByHandle.get(h) ?? wa.width;
          const key = ordered.join(",");
          const reshaped = packedSetByOutput.get(outputId) !== key
            || ordered.some((h) => !rowByHandle.has(h));
          packedSetByOutput.set(outputId, key);
          const best = packRows(ordered, widthOf, wa.height, aspect);
          if (best) {
            const current = reshaped
              ? Infinity
              : rowsScore(ordered, rowByHandle, widthOf, wa.height, aspect);
            if (best.score < current * REPACK_MARGIN) {
              for (const [h, r] of best.rows) rowByHandle.set(h, r);
            }
          }
        }
        // x advances per row: rows are independent strips.
        const xByRow = new Map<number, number>();
        for (const h of ordered) {
          const gridRow = arrangement === "grid" ? (rowByHandle.get(h) ?? 0) : 0;
          const x = xByRow.get(gridRow) ?? g.x;
          const width = widthByHandle.get(h) ?? wa.width;
          row.set(h, {
            x, y: g.y + gridRow * (wa.height + gutter),
            width, height: wa.height,
          });
          xByRow.set(gridRow, x + width + gutter);
        }
      }
      rowRectsByOutput.set(outputId, row);
      for (const h of handles) {
        const rec = state.byHandle.get(h);
        if (!rec) continue;
        const hint = layoutHintFor(h);
        islands.push({
          id: h,
          contextOutputId: outputId,
          rect: row.get(h) ?? null,
          members: [...rec.members],
          ...(hint !== undefined ? { layout: hint } : {}),
        });
      }
    }
    islands.sort((a, b) => a.id - b.id);
    await sdk.windows.setIslands(islands);
    // Mark empty islands with a translucent backdrop so they're visible
    // while fitted / roaming. Dedupe on content -- publishWorld runs on
    // every structural change and the sink repaints on each set.
    if (backdropColor) {
      const backdrops = islands
        .filter((i) => i.members.length === 0 && i.rect !== null)
        .map((i) => ({ ...(i.rect as { x: number; y: number; width: number; height: number }), color: backdropColor }));
      const json = JSON.stringify(backdrops);
      if (json !== lastBackdropsJson) {
        lastBackdropsJson = json;
        try {
          await sdk.windows.setIslandBackdrops(backdrops);
        } catch { /* sink without backdrop support (harness) */ }
      }
    }
    // Overridden outputs maintain their own union stack + camera.
    await refreshOverrides();
    // Dock each output's camera on its shown island (instant). Identity
    // when geometry is unknown (rect null islands tile in place). A
    // flying output's camera belongs to its flight; the settle step
    // docks it. An overridden output's camera belongs to its override.
    for (const [outputId, shown] of state.shownByOutput) {
      if (flying.has(outputId) || override.has(outputId)) continue;
      const cam = camPosFor(outputId, shown);
      const last = lastCamByOutput.get(outputId);
      if (last && last.x === cam.x && last.y === cam.y) continue;
      lastCamByOutput.set(outputId, cam);
      await sdk.windows.setOutputCamera(outputId, cam.x, cam.y);
    }
  }

  // A move carries no activation edge, so the at-most-one-zoom rule the
  // activation handler enforces needs settling here: a zoomed window
  // arriving in an island that already holds a zoomed member wins, and
  // the incumbent demotes (mirrors the activation edge, where the
  // newcomer wins). Fullscreen members are glass furniture and coexist.
  async function settleZoomAfterMove(p: { surfaceId: number }): Promise<void> {
    const sid = p.surfaceId;
    if (sizeModeMembers.get(sid) !== "maximized") return;
    const handle = state.surfaceToHandle.get(sid);
    const rec = handle !== undefined ? state.byHandle.get(handle) : undefined;
    if (!rec) return;
    for (const m of [...rec.members]) {
      if (m !== sid && sizeModeMembers.get(m) === "maximized") {
        await sdk.windows.propose(m, { sizeMode: "none" });
      }
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
          if (e.name === "workspace.window-moved") {
            await settleZoomAfterMove(
              e.payload as { surfaceId: number });
          }
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
  // `keepFocus`: a surface that should hold keyboard focus once the
  // flight settles, pre-empting the deferred policy decide -- under
  // follow-pointer that decide would hand focus to whatever the landing
  // leaves under the stationary cursor. Honored only if the surface still
  // lives on the settled shown workspace.
  async function showWithFlight(
    index: WorkspaceIndex, outputId: number, t: ShowTransitionSpec,
    keepFocus?: number,
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
      // Aim at the final view: fold the focused window's reveal into the
      // destination strip's scroll before computing the target (see
      // foldFocusIntoScroll -- avoids the fly-then-snap when the reveal
      // would move the camera again after settle).
      if (shown !== undefined) await foldFocusIntoScroll(outputId, shown);
      const target = shown !== undefined
        ? camPosFor(outputId, shown) : { x: 0, y: 0 };
      const cur = await sdk.windows.getOutputCamera(outputId);
      if (sdk.animations
          && (cur.x !== target.x || cur.y !== target.y || cur.zoom !== 1)) {
        const spec: TweenSpec = {
          type: "tween",
          target: { kind: "output-camera", outputId },
          from: cur,
          to: { x: target.x, y: target.y, zoom: 1 },
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
      if (settleShown !== undefined) {
        await foldFocusIntoScroll(outputId, settleShown);
      }
      const settle = settleShown !== undefined
        ? camPosFor(outputId, settleShown) : { x: 0, y: 0 };
      lastCamByOutput.set(outputId, settle);
      await sdk.windows.setOutputCamera(outputId, settle.x, settle.y);
      if (keepFocus !== undefined
          && state.surfaceToHandle.get(keepFocus) === settleShown) {
        await sdk.windows.focus(keepFocus);
      } else {
        const focusEffect = r.sideEffects.find(
          (e): e is Extract<SideEffect, { kind: "requestFocusDecision" }> =>
            e.kind === "requestFocusDecision");
        if (focusEffect) {
          await sdk.windows.requestFocusDecision(focusEffect.reason);
        }
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
    // Zones move when bars map/unmap without a structural republish;
    // re-read the workarea so the framing centers below a fresh bar.
    await refreshWorkarea(outputId);
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
    | { kind: "island"; handle: WorkspaceHandle; name?: string }
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
      // Carry the workspace's name so the bookmark survives evaporation:
      // names are the durable identity, handles die with the workspace.
      const wsName = state.byHandle.get(shown)?.name;
      framing = {
        kind: "island", handle: shown,
        ...(wsName !== undefined ? { name: wsName } : {}),
      };
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
          // The workspace evaporated. Degrade to its captured name
          // (create-on-reference, like config bookmarks); a nameless
          // one is genuinely gone.
          if (f.name !== undefined) {
            const p = await resolveOrCreateByName(
              { name: f.name }, "workspace.bookmark-go");
            await showAt(p.index, p.outputId);
            return;
          }
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
    // The window focused when the action fired keeps focus through the
    // zoom-in (unfitKeepsFocus): the camera motion parks the cursor
    // wherever the landing leaves it, and the policy decide would hand
    // focus to that window instead.
    const keep = unfitKeepsFocus ? focusedSurfaceId : null;
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
      const keepFocus = keep !== null
        && state.surfaceToHandle.get(keep) === positions[target - 1]
        ? keep : undefined;
      if (t) {
        await showWithFlight(asIndex(target), outputId,
          { kind: "camera", duration: t.duration, easing: t.easing },
          keepFocus);
        return;
      }
      await cancelFlight(outputId);
      const r = reg.show(state, asIndex(target), outputId, outputNameOf(outputId));
      state = r.state;
      if (keepFocus !== undefined) {
        await applyEffects(r.sideEffects, new Set(["requestFocusDecision"]));
        await sdk.windows.focus(keepFocus);
      } else {
        await applyEffects(r.sideEffects);
      }
      return;
    }
    // Zoom back onto the shown workspace: optics only. The fit union
    // keeps riding the stack for the journey; settle collapses it.
    await cancelFlight(outputId);
    // Aim the flight at the FINAL view: fold the focused window's reveal
    // into the strip scroll BEFORE computing the target. Focus moved
    // while overridden doesn't scroll (the override gate), so the stored
    // scroll is pre-fit stale -- flying there and letting the
    // post-settle relayout reveal correct it reads as a zoom to the old
    // view followed by a snap.
    if (shown !== undefined) await foldFocusIntoScroll(outputId, shown);
    const cam = shown !== undefined
      ? camPosFor(outputId, shown) : { x: 0, y: 0 };
    if (t && sdk.animations) {
      const token = ++flightSeq;
      flying.set(outputId, token);
      try {
        const cur = await sdk.windows.getOutputCamera(outputId);
        if (cur.x !== cam.x || cur.y !== cam.y || cur.zoom !== 1) {
          const spec: TweenSpec = {
            type: "tween",
            target: { kind: "output-camera", outputId },
            from: cur,
            to: { x: cam.x, y: cam.y, zoom: 1 },
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
    lastCamByOutput.set(outputId, cam);
    await sdk.windows.setOutputCamera(outputId, cam.x, cam.y);
  }

  // Emit the boot-time workspace.created for workspace 1, plus any side
  // effects from the boot-time recompute (donor-replenishment workspaces
  // for secondary outputs, setOutputStack for each, etc.). Subscribers
  // that attached before plugin init see these; status bars / IPC
  // listeners that attach later observe via list/current.
  await applyEffects(r0.sideEffects);
  await applyEffects(bootRecomputeEffects);

  // Declarative workspaces (canvas.workspaces): each entry names a
  // workspace that exists from boot. Created persistent by default (a
  // declared workspace shouldn't evaporate mid-session; it would only be
  // re-declared next boot); `persistent: false` opts back into dynamic
  // lifetime. `output` picks the home output (and seeds preferredOutputs
  // so a replug reclaims it); an unresolvable output falls back to the
  // default output. `elastic` declares growth by NAME (see isElastic);
  // `layout` declares the workspace's layout mode by NAME (see
  // layoutHintFor). `default: true` makes the entry the initially shown
  // workspace on its output -- the auto-created unnamed boot workspace,
  // now empty and unshown, evaporates, so the output boots straight onto
  // the declared set. First default-entry per output wins. Registry
  // create is idempotent on name, so re-seeding is safe.
  async function seedWorkspaces(canvasSlice: unknown): Promise<void> {
    if (!canvasSlice || typeof canvasSlice !== "object") return;
    const list = (canvasSlice as { workspaces?: unknown }).workspaces;
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      sdk.log("canvas: config workspaces must be an array; ignored");
      return;
    }
    const shownSeeded = new Set<number>();
    for (const entry of list) {
      if (!isObj(entry) || typeof entry.name !== "string" || entry.name === "") {
        sdk.log(`canvas: config workspace without a name skipped (${JSON.stringify(entry)})`);
        continue;
      }
      if (entry.elastic !== undefined) {
        // Growth only; the workspace's layout (mode, column width) is
        // declared via the `layout` entry below.
        if (typeof entry.elastic === "boolean") {
          elasticByName.set(entry.name, entry.elastic);
        } else {
          sdk.log(`canvas: config workspace '${entry.name}' elastic must be a boolean; skipped`);
          continue;
        }
      }
      if (entry.layout !== undefined) {
        // Declared per-workspace layout: { mode: "master-stack" |
        // "columns", column?, columns? }. Published verbatim as the
        // island's layout hint; the provider validates/clamps what it
        // consumes. `columns` is per-position width fractions (member
        // order) -- the shape workspace.list/current report back, so an
        // extracted arrangement pastes in unchanged.
        if (!isObj(entry.layout)
            || (entry.layout.mode !== "master-stack" && entry.layout.mode !== "columns")) {
          sdk.log(`canvas: config workspace '${entry.name}' layout must be `
            + `{ mode: "master-stack" | "columns", column?, columns? }; skipped`);
          continue;
        }
        const hint: { [k: string]: unknown } = { mode: entry.layout.mode };
        if (entry.layout.column !== undefined) {
          if (typeof entry.layout.column !== "number"
              || !Number.isFinite(entry.layout.column)) {
            sdk.log(`canvas: config workspace '${entry.name}' layout.column must be a number; ignored`);
          } else {
            hint.column = entry.layout.column;
          }
        }
        if (entry.layout.columns !== undefined) {
          if (!Array.isArray(entry.layout.columns)
              || !entry.layout.columns.every(
                (v) => typeof v === "number" && Number.isFinite(v))) {
            sdk.log(`canvas: config workspace '${entry.name}' layout.columns must be a number array; ignored`);
          } else {
            hint.columns = [...entry.layout.columns];
          }
        }
        layoutByName.set(entry.name, hint);
      }
      if (entry.persistent !== undefined && typeof entry.persistent !== "boolean") {
        sdk.log(`canvas: config workspace '${entry.name}' persistent must be a boolean; skipped`);
        continue;
      }
      let outputId = reg.OUTPUT_DEFAULT;
      const preferredOutputs: string[] = [];
      if (entry.output !== undefined) {
        if (typeof entry.output !== "string" || entry.output === "") {
          sdk.log(`canvas: config workspace '${entry.name}' output must be a non-empty string; skipped`);
          continue;
        }
        preferredOutputs.push(entry.output);
        outputId = resolveOutputName(entry.output) ?? reg.OUTPUT_DEFAULT;
      }
      const c = reg.create(state, {
        name: entry.name,
        outputId,
        persistent: entry.persistent ?? true,
        ...(preferredOutputs.length > 0 ? { preferredOutputs } : {}),
      }, outputNameOf(outputId));
      state = c.state;
      await applyEffects(c.sideEffects);
      if (entry.default !== undefined && typeof entry.default !== "boolean") {
        sdk.log(`canvas: config workspace '${entry.name}' default must be a boolean; ignored`);
      } else if (entry.default === true) {
        const wsOutput = c.snapshot.outputId;
        if (shownSeeded.has(wsOutput)) {
          sdk.log(`canvas: config workspace '${entry.name}' default: true ignored `
            + `(another entry already claims the default on its output)`);
        } else {
          shownSeeded.add(wsOutput);
          const idx = reg.findIndex(state, c.snapshot.handle, wsOutput);
          if (idx !== null) {
            const r = reg.show(state, idx, wsOutput, outputNameOf(wsOutput));
            state = r.state;
            await applyEffects(r.sideEffects);
          }
        }
      }
    }
  }
  await seedWorkspaces(config?.canvas);

  // Seed membership from windows that are already mapped at plugin init
  // (defensive: bundled plugins load before any client maps in practice, so
  // this is usually empty, but the runtime makes no such guarantee).
  const existing = await sdk.windows.list();
  for (const w of existing) {
    // Unplaced windows (no layout pass yet) seed onto the fallback output;
    // the workspace recompute re-homes them once a real output claims them.
    const outId = w.outputId ?? fallbackOutputId;
    const r = reg.applyMap(state, w.surfaceId, outId, outputNameOf(outId),
      insertEndFor(state.shownByOutput.get(outId)));
    state = r.state;
    await applyEffects(r.sideEffects);
  }

  // Map/unmap drive workspace membership. The map event carries the WM's
  // assigned outputId; the plugin honors that as the window's home output.
  // Placement happens here, at first content -- after the WM has resolved the
  // window's tiling lane -- so a floating window never joins the tiled stack.
  //
  // This handler is the PLACEMENT RESOLVER (canvas-design.md §7): a
  // `workspace.place` state-bag hint (stamped by plugin-window-rules
  // during preconfigure) overrides the camera-relative default. The hint
  // carries { name?, output?, show? }: a workspace NAME resolves across
  // all outputs (created on reference when absent -- any name; a rule is
  // explicit config, not a typo'd bind); an OUTPUT alone targets that
  // monitor's shown workspace ("appear on the TV, whatever it shows") and
  // scopes where a created workspace homes; `show` makes the placement
  // grab attention (the target workspace is shown), default quiet.
  interface PlacementHint { name?: string; output?: string; show?: boolean }
  function parsePlacementHint(v: unknown): PlacementHint | null {
    if (!isObj(v)) return null;
    const out: PlacementHint = {};
    if (typeof v.name === "string" && v.name !== "") out.name = v.name;
    if (typeof v.output === "string" && v.output !== "") out.output = v.output;
    if (typeof v.show === "boolean") out.show = v.show;
    return out.name !== undefined || out.output !== undefined ? out : null;
  }
  // Resolve a workspace name to its handle: user-set names first across
  // all outputs (position order within an output), then the digit-string
  // durable-handle fallback -- the same order workspace.show uses.
  function findHandleByName(name: string): WorkspaceHandle | null {
    for (const outputId of state.positionsByOutput.keys()) {
      const idx = reg.findIndexByName(state, name, outputId);
      if (idx !== null) return reg.findHandle(state, idx, outputId);
    }
    if (/^[1-9][0-9]*$/.test(name)) {
      const h = Number(name) as WorkspaceHandle;
      if (state.byHandle.has(h)) return h;
    }
    return null;
  }
  async function placeOnMap(ev: { surfaceId: number; outputId: number }): Promise<void> {
    let hint: PlacementHint | null = null;
    try {
      hint = parsePlacementHint(
        await sdk.windows.getState(ev.surfaceId, "workspace.place"));
    } catch { /* no bag / broker without get-state: default placement */ }
    if (!hint) {
      const r = reg.applyMap(state, ev.surfaceId, ev.outputId, outputNameOf(ev.outputId),
        insertEndFor(state.shownByOutput.get(ev.outputId)));
      state = r.state;
      await applyEffects(r.sideEffects);
      return;
    }
    // The hint is one-shot; consume it before any await can re-enter.
    void sdk.windows.deleteState(ev.surfaceId, "workspace.place").catch(() => { /* */ });
    // An unresolvable output (unplugged monitor) falls back per intent:
    // a named workspace still resolves/creates elsewhere (home-region
    // keeps working while the monitor is away); an output-only hint has
    // no target left and places camera-relative.
    const ruleOutputId = hint.output !== undefined
      ? resolveOutputName(hint.output) : null;
    let handle: WorkspaceHandle | null = null;
    if (hint.name !== undefined) {
      handle = findHandleByName(hint.name);
      if (handle === null) {
        const homeOutput = ruleOutputId ?? focusedOutputId();
        const c = reg.create(state,
          { name: hint.name, outputId: homeOutput }, outputNameOf(homeOutput));
        state = c.state;
        await applyEffects(c.sideEffects);
        handle = c.snapshot.handle;
      }
    } else if (ruleOutputId !== null) {
      const r = reg.applyMap(state, ev.surfaceId, ruleOutputId, outputNameOf(ruleOutputId),
        insertEndFor(state.shownByOutput.get(ruleOutputId)));
      state = r.state;
      await applyEffects(r.sideEffects);
      return;
    }
    if (handle === null) {
      const r = reg.applyMap(state, ev.surfaceId, ev.outputId, outputNameOf(ev.outputId),
        insertEndFor(state.shownByOutput.get(ev.outputId)));
      state = r.state;
      await applyEffects(r.sideEffects);
      return;
    }
    const r = reg.applyMapAt(state, ev.surfaceId, handle, insertEndFor(handle));
    state = r.state;
    await applyEffects(r.sideEffects);
    if (hint.show === true) {
      const rec = state.byHandle.get(handle);
      const idx = rec ? reg.findIndex(state, handle, rec.outputId) : null;
      if (rec && idx !== null && state.shownByOutput.get(rec.outputId) !== handle) {
        exitOverride(rec.outputId);
        await cancelFlight(rec.outputId);
        const s = reg.show(state, idx, rec.outputId, outputNameOf(rec.outputId));
        state = s.state;
        await applyEffects(s.sideEffects);
      }
    }
  }
  sdk.windows.onMap((ev) => {
    void placeOnMap(ev).then(() => {
      // The activation edge for this window may have arrived BEFORE
      // placement populated surfaceToHandle (the handler tolerates the
      // race and skips). Catch up here: if the window is the current
      // focus, stamp its output's activity and fire the same
      // maximized-release edge the activation handler would have.
      if (focusedSurfaceId !== ev.surfaceId) return;
      const outId = outputOfSurface(ev.surfaceId);
      if (outId === null) return;
      const prevActive = activeByOutput.get(outId);
      activeByOutput.set(outId, ev.surfaceId);
      if (prevActive !== undefined && prevActive !== ev.surfaceId
          && sizeModeMembers.get(prevActive) === "maximized") {
        void sdk.windows.propose(prevActive, { sizeMode: "none" });
      }
      focusedOutputIdCache = outId;
    });
  });

  // Membership on drag (canvas-design.md §3): a move grab's drop
  // re-parents the window to the island under the CURSOR (the seat
  // reports the pointer's world position through the content camera, so
  // drops land where you're pointing while fitted/roaming too). Tiled
  // stays tiled: a window that was managed before the grab floated it
  // re-tiles wherever it drops -- into another island (cross-island
  // move), at the drop position within its own island's order
  // (rearrange), or back into its old slot (void drop; nothing to point
  // at). Floating is an explicit verb (window.toggle-floating), never a
  // drag side effect. A window the user floated stays floating wherever
  // it's dropped; only its membership follows the cursor.
  //
  // The drop-position -> member-index mapping is a heuristic: land at
  // the hit window's slot (its left half -- the dragged window shoves it
  // over) or just past it (right half). Horizontal-flow-oriented, which
  // matches the bundled layouts (master-stack, elastic columns); a
  // layout-owned drop-index query is future work.
  function dropIndexFor(
    members: ReadonlyArray<number>, surfaceId: number,
    snaps: ReadonlyArray<WindowSnapshotLike>, x: number, y: number,
  ): number | null {
    const tiled = snaps.filter((s) =>
      s.surfaceId !== surfaceId && members.includes(s.surfaceId)
      && s.windowState?.tiling === "managed" && s.windowState.visible
      && s.windowState.sizeMode === "none"
      && s.outer && s.outer.width > 0);
    if (tiled.length === 0) return null;
    const contains = (s: WindowSnapshotLike): boolean => {
      const o = s.outer as { x: number; y: number; width: number; height: number };
      return x >= o.x && x < o.x + o.width && y >= o.y && y < o.y + o.height;
    };
    const dist = (s: WindowSnapshotLike): number => {
      const o = s.outer as { x: number; y: number; width: number; height: number };
      const dx = x - (o.x + o.width / 2);
      const dy = y - (o.y + o.height / 2);
      return dx * dx + dy * dy;
    };
    const hit = tiled.find(contains)
      ?? tiled.reduce((a, b) => (dist(a) <= dist(b) ? a : b));
    const o = hit.outer as { x: number; y: number; width: number };
    const before = x < o.x + o.width / 2;
    const hitIdx = members.indexOf(hit.surfaceId);
    const dragIdx = members.indexOf(surfaceId);
    // moveToIndex is the FINAL index (post-removal splice): the hit's
    // post-removal index to land before it, +1 to land after.
    const h = hitIdx - (dragIdx >= 0 && dragIdx < hitIdx ? 1 : 0);
    return before ? h : h + 1;
  }
  sdk.events.subscribe("window.drag-dropped", (_name, payload) => {
    if (!worldMode || !payload || typeof payload !== "object") return;
    const p = payload as {
      surfaceId?: unknown; wasManaged?: unknown; x?: unknown; y?: unknown;
    };
    if (typeof p.surfaceId !== "number"
      || typeof p.x !== "number" || typeof p.y !== "number") return;
    const surfaceId = p.surfaceId;
    const dropX = p.x;
    const dropY = p.y;
    const from = state.surfaceToHandle.get(surfaceId);
    if (from === undefined) return;
    // The island under the drop point, across every output's arrangement.
    let target: { handle: WorkspaceHandle; outputId: number } | null = null;
    for (const [outputId, row] of rowRectsByOutput) {
      for (const [h, r] of row) {
        if (dropX >= r.x && dropX < r.x + r.width
          && dropY >= r.y && dropY < r.y + r.height) {
          target = { handle: h, outputId };
          break;
        }
      }
      if (target) break;
    }
    // Floating windows only follow the cursor's island; dropping on the
    // own island or on void leaves everything as the drag put it.
    if (p.wasManaged !== true && (!target || target.handle === from)) return;
    void (async () => {
      if (target && target.handle !== from) {
        const idx = reg.findIndex(state, target.handle, target.outputId);
        if (idx === null) return;
        const r = reg.moveWindow(
          state, surfaceId, idx, target.outputId, outputNameOf(target.outputId));
        state = r.state;
        await applyEffects(r.sideEffects);
      }
      if (p.wasManaged !== true) return;
      // Rearrange by drop position within the (possibly new) island's
      // order, then snap back into the tiling.
      const handle = state.surfaceToHandle.get(surfaceId);
      const rec = handle !== undefined ? state.byHandle.get(handle) : undefined;
      if (rec) {
        const idx = dropIndexFor(
          rec.members, surfaceId, await sdk.windows.list(), dropX, dropY);
        if (idx !== null) {
          const r = reg.reorder(state, surfaceId, { moveToIndex: idx });
          state = r.state;
          await applyEffects(r.sideEffects);
        }
      }
      await sdk.windows.propose(surfaceId, { tiling: "managed" }, "user-input");
    })();
  });
  sdk.windows.onUnmap((ev) => {
    sizeModeMembers.delete(ev.surfaceId);
    for (const [o, id] of activeByOutput) {
      if (id === ev.surfaceId) activeByOutput.delete(o);
    }
    const r = reg.applyUnmap(state, ev.surfaceId);
    state = r.state;
    void applyEffects(r.sideEffects);
  });

  // A client asked to go fullscreen on a specific output (xdg_toplevel
  // .set_fullscreen with an output arg). Output placement is ours, so move the
  // window to that output's shown workspace; the WM already flagged it
  // sizeMode=fullscreen and fullscreens it on whichever output it lands on.
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
      "Append a new workspace on the given output (defaults to the focused output); returns its snapshot. A `name` matching an existing workspace is a no-op returning that workspace.",
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
    name: "workspace.reveal",
    description:
      "World mode: scroll the docked elastic strip to center a window's column. Params: { surfaceId?: number } -- default the focused window. No-op when the window's workspace isn't an elastic strip in the docked view.",
    handler: async (params: unknown): Promise<null> => {
      if (!worldMode) {
        throw new Error(
          "workspace.reveal: requires canvas world mode (canvas: { world: true })");
      }
      const p = (params ?? {}) as { surfaceId?: unknown };
      if (p.surfaceId !== undefined && p.surfaceId !== null
          && typeof p.surfaceId !== "number") {
        throw new TypeError("workspace.reveal: params.surfaceId must be a number");
      }
      const sid = typeof p.surfaceId === "number" ? p.surfaceId : focusedSurfaceId;
      if (typeof sid === "number") await revealSurface(sid);
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
      "World mode: multiply the output's camera zoom by `factor` (anchored at the view center), entering free roaming. `min`/`max` clamp the result within [0.05, 8] -- e.g. max: 1 for a wheel bind that zooms back in no further than native. A clamped no-change zoom is a no-op. Optional transition {duration, easing?} animates it.",
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
      const lo = Math.max(0.05, p.min ?? 0.05);
      const hi = Math.min(8, p.max ?? 8);
      const z = Math.min(hi, Math.max(lo, cur.zoom * p.factor));
      // Already at the clamp (a wheel detent past the cap): change
      // nothing -- entering the roaming override for a no-op zoom would
      // needlessly union the stack.
      if (z === cur.zoom) return null;
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
    name: "workspace.set-elastic",
    description:
      "World mode: set a workspace's growth -- elastic strip (true) or fixed island (false); omit `elastic` to toggle. Positional {index?, output?}; index defaults to the shown workspace on the focused output.",
    handler: async (params: unknown): Promise<{ elastic: boolean }> => {
      if (!worldMode) {
        throw new Error(
          "workspace.set-elastic: requires canvas world mode (canvas: { world: true })");
      }
      const p = parseSetElasticParams(params, resolveOutputName, focusedOutputId());
      const positions = state.positionsByOutput.get(p.outputId) ?? [];
      let handle: WorkspaceHandle | undefined;
      if (p.index !== undefined) {
        handle = positions[p.index - 1];
        if (handle === undefined) {
          throw new Error(
            `workspace.set-elastic: index ${p.index} out of bounds (1..${positions.length})`);
        }
      } else {
        handle = state.shownByOutput.get(p.outputId);
        if (handle === undefined) {
          throw new Error("workspace.set-elastic: no shown workspace on the target output");
        }
      }
      const next = p.elastic ?? !isElastic(handle);
      growthByHandle.set(handle, next);
      await publishWorld();
      return { elastic: next };
    },
  });

  sdk.actions.register({
    name: "workspace.set-layout",
    description:
      "World mode: declare a workspace's layout -- { mode: \"master-stack\" | \"columns\", column?, columns? } (column = default column-width fraction; columns = fractions by column position, the shape workspace.current reports). Positional {index?, output?}; index defaults to the shown workspace on the focused output. Session-scoped override; omit `mode` to clear it (back to config/default).",
    handler: async (params: unknown): Promise<{ mode: string | null }> => {
      if (!worldMode) {
        throw new Error(
          "workspace.set-layout: requires canvas world mode (canvas: { world: true })");
      }
      const p = parseSetLayoutParams(params, resolveOutputName, focusedOutputId());
      const positions = state.positionsByOutput.get(p.outputId) ?? [];
      let handle: WorkspaceHandle | undefined;
      if (p.index !== undefined) {
        handle = positions[p.index - 1];
        if (handle === undefined) {
          throw new Error(
            `workspace.set-layout: index ${p.index} out of bounds (1..${positions.length})`);
        }
      } else {
        handle = state.shownByOutput.get(p.outputId);
        if (handle === undefined) {
          throw new Error("workspace.set-layout: no shown workspace on the target output");
        }
      }
      if (p.mode === undefined) {
        layoutByHandle.delete(handle);
      } else {
        const hint: { [k: string]: unknown } = { mode: p.mode };
        if (p.column !== undefined) hint.column = p.column;
        if (p.columns !== undefined) hint.columns = p.columns;
        layoutByHandle.set(handle, hint);
      }
      await publishWorld();
      return { mode: p.mode ?? null };
    },
  });

  sdk.actions.register({
    name: "workspace.pan-grab",
    description:
      "World mode: start a drag-pan -- while the triggering button is held, pointer motion pans the camera 1:1 (free roaming; every workspace on the output stays visible). Bind with releaseAction: 'workspace.pan-grab-end'.",
    handler: async (params: unknown): Promise<null> => {
      if (!worldMode) {
        throw new Error(
          "workspace.pan-grab: requires canvas world mode (canvas: { world: true })");
      }
      const outputId = parseOptionalOutput(
        params, resolveOutputName, focusedOutputId(), "workspace.pan-grab");
      // Enter free roaming AT the current camera (union stack rides so
      // the world is visible as it slides by), then hand the pointer to
      // the seat's camera-pan grab.
      const cur = await sdk.windows.getOutputCamera(outputId);
      await freeCamera(outputId, cur, null, "workspace.pan-grab");
      const ok = await sdk.windows.beginCameraPan(outputId);
      if (!ok) {
        // Another grab owns the pointer (or no seat): back out of the
        // override so the stack and camera return to the shown dock.
        exitOverride(outputId);
        await pushStack(outputId, reg.stackFor(state, outputId));
        await publishWorld();
      }
      return null;
    },
  });

  sdk.actions.register({
    name: "workspace.pan-grab-end",
    description:
      "End a drag-pan (the bind's releaseAction): settles the camera where it was dragged and keeps free roaming there.",
    handler: async (params: unknown): Promise<null> => {
      if (!worldMode) return null;
      const outputId = parseOptionalOutput(
        params, resolveOutputName, focusedOutputId(), "workspace.pan-grab-end");
      const cam = await sdk.windows.endCameraPan(outputId);
      const o = override.get(outputId);
      if (o?.kind === "free") o.cam = cam;
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

  // Attach the effective column-width fractions (member order) to a
  // columns-mode workspace's snapshot -- the exact value a config
  // `layout: { mode: "columns", columns: [...] }` entry needs to
  // reproduce the current sizing, so `overdrawctl invoke
  // workspace.current` is the extraction path. Omitted for master-stack
  // workspaces and when the layout provider doesn't expose the widths.
  async function withColumns(snap: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    const hint = layoutHintFor(snap.handle);
    const mode = (hint?.mode as string | undefined) ?? defaultLayoutMode;
    if (mode !== "columns" || snap.members.length === 0) return snap;
    try {
      const r = await sdk.actions.invoke("layout.column-widths", {
        surfaceIds: [...snap.members],
        ...(hint !== undefined ? { layout: hint } : {}),
      });
      const w = (r as { widths?: unknown } | null)?.widths;
      if (Array.isArray(w) && w.every((v) => typeof v === "number")) {
        return { ...snap, columns: w as number[] };
      }
    } catch { /* provider without layout.column-widths */ }
    return snap;
  }

  sdk.actions.register({
    name: "workspace.list",
    description:
      "Workspaces on the given output, sorted by per-output index. Omit `output` to list every workspace on every live output. Columns-mode workspaces include `columns` (effective width fractions in member order; paste into a config workspaces entry's layout.columns to reproduce).",
    handler: async (params: unknown): Promise<WorkspaceSnapshot[]> => {
      const snapshots = (): WorkspaceSnapshot[] => {
        const out: WorkspaceSnapshot[] = [];
        for (const outputId of state.positionsByOutput.keys()) {
          out.push(...reg.snapshotsForOutput(state, outputId));
        }
        return out;
      };
      let list: WorkspaceSnapshot[];
      if (params === undefined || params === null) {
        list = snapshots();
      } else {
        if (!isObj(params)) throw new TypeError("workspace.list: expected an object");
        if (params.output === undefined) {
          list = snapshots();
        } else {
          const outputId = parseOptionalOutput(params, resolveOutputName, -1, "workspace.list");
          list = reg.snapshotsForOutput(state, outputId);
        }
      }
      return Promise.all(list.map(withColumns));
    },
  });

  sdk.actions.register({
    name: "workspace.current",
    description:
      "The currently-shown workspace on the given output (defaults to the focused output). Columns-mode workspaces include `columns` (effective width fractions in member order; paste into a config workspaces entry's layout.columns to reproduce).",
    handler: async (params: unknown): Promise<WorkspaceSnapshot | null> => {
      const outputId = parseOptionalOutput(
        params, resolveOutputName, focusedOutputId(), "workspace.current");
      const cur = reg.current(state, outputId);
      return cur === null ? null : withColumns(cur);
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

  sdk.log(`canvas plugin activated (${worldMode ? "world" : "workspace parity"} mode)`);
  return api;
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

  // Pass 2: digit-string -> durable handle, UNNAMED workspaces only
  // (boot / hotplug-donor workspaces, which have no user-set name to
  // match in pass 1). A workspace explicitly named something else must
  // never be addressable by its internal handle: durable handles drift
  // from user-visible numbering as workspaces evaporate and re-create
  // (a re-created "2" may hold handle 3, and `name: "3"` landing on it
  // sends windows to the wrong workspace).
  if (/^[1-9][0-9]*$/.test(params.name)) {
    const handle = Number(params.name) as WorkspaceHandle;
    const rec = state.byHandle.get(handle);
    if (rec && rec.name === undefined) {
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

// workspace.zoom: multiplicative factor (> 0) + optional min/max clamps.
function parseZoomParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { factor: number; min?: number; max?: number; outputId: number } {
  if (!isObj(params)) {
    throw new TypeError("workspace.zoom: expected an object with { factor, min?, max?, output? }");
  }
  if (typeof params.factor !== "number" || !Number.isFinite(params.factor)
      || params.factor <= 0) {
    throw new TypeError("workspace.zoom: factor must be a positive finite number");
  }
  const outputId = parseOptionalOutput(
    params, resolveOutput, defaultOutputId, "workspace.zoom");
  const out: { factor: number; min?: number; max?: number; outputId: number } =
    { factor: params.factor, outputId };
  for (const key of ["min", "max"] as const) {
    const v = params[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new TypeError(`workspace.zoom: ${key} must be a positive finite number`);
    }
    out[key] = v;
  }
  return out;
}

// workspace.set-layout: optional per-output index (default: the shown
// workspace) + optional mode (absent = clear the override) + optional
// column fraction + optional output.
function parseSetLayoutParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { index?: number; mode?: "master-stack" | "columns"; column?: number;
    columns?: number[]; outputId: number } {
  if (params === undefined || params === null) {
    return { outputId: defaultOutputId };
  }
  if (!isObj(params)) {
    throw new TypeError("workspace.set-layout: expected an object");
  }
  const outputId = parseOptionalOutput(
    params, resolveOutput, defaultOutputId, "workspace.set-layout");
  const out: {
    index?: number; mode?: "master-stack" | "columns"; column?: number;
    columns?: number[]; outputId: number;
  } = { outputId };
  if (params.index !== undefined) {
    if (typeof params.index !== "number" || !Number.isInteger(params.index)
        || params.index < 1) {
      throw new TypeError("workspace.set-layout: index must be a positive integer");
    }
    out.index = params.index;
  }
  if (params.mode !== undefined) {
    if (params.mode !== "master-stack" && params.mode !== "columns") {
      throw new TypeError(
        "workspace.set-layout: mode must be \"master-stack\" or \"columns\"");
    }
    out.mode = params.mode;
  }
  if (params.column !== undefined) {
    if (typeof params.column !== "number" || !Number.isFinite(params.column)) {
      throw new TypeError("workspace.set-layout: column must be a finite number");
    }
    out.column = params.column;
  }
  if (params.columns !== undefined) {
    if (!Array.isArray(params.columns)
        || !params.columns.every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new TypeError("workspace.set-layout: columns must be a number array");
    }
    out.columns = [...(params.columns as number[])];
  }
  return out;
}

// workspace.set-elastic: optional per-output index (default: the shown
// workspace) + optional elastic flag (absent = toggle) + optional output.
function parseSetElasticParams(
  params: unknown,
  resolveOutput: (input: string) => number | null,
  defaultOutputId: number,
): { index?: number; elastic?: boolean; outputId: number } {
  if (params === undefined || params === null) {
    return { outputId: defaultOutputId };
  }
  if (!isObj(params)) {
    throw new TypeError("workspace.set-elastic: expected an object");
  }
  const outputId = parseOptionalOutput(
    params, resolveOutput, defaultOutputId, "workspace.set-elastic");
  const out: { index?: number; elastic?: boolean; outputId: number } = { outputId };
  if (params.index !== undefined) {
    if (typeof params.index !== "number" || !Number.isInteger(params.index)
        || params.index < 1) {
      throw new TypeError("workspace.set-elastic: index must be a positive integer");
    }
    out.index = params.index;
  }
  if (params.elastic !== undefined) {
    if (typeof params.elastic !== "boolean") {
      throw new TypeError("workspace.set-elastic: elastic must be a boolean");
    }
    out.elastic = params.elastic;
  }
  return out;
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

