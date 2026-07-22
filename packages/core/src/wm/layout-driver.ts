// Layout driver + resolver. Sits between the WM (which owns the window
// list + structural state) and the layout plugin (which owns the geometry
// policy for managed windows).
//
// Responsibilities:
//   - Coalesce relayout requests (at most one compute() in flight; subsequent
//     invalidations queue and replace).
//   - Resolve non-managed lanes in core: a window with sizeMode !== "none"
//     gets an override rect (workarea for maximized, full output/glass for
//     fullscreen; any number may coexist -- which one shows is a stacking
//     concern); an invisible (visible === false) window is omitted from
//     the result; a floating (tiling === "floating") window uses its
//     stored floatingRect.
//   - Build LayoutInputs per island from its `managed`, non-fullscreen,
//     visible members + the island's tile region (implicit islands derive
//     it from the output minus reserved zones), invoke compute() on the
//     island's layout plugin.
//   - Merge the plugin's result with the driver-resolved rects and hand
//     the unified LayoutResult to the WM for apply.
//
// On compute failure (plugin throws, no plugin registered after timeout,
// permanent restart-budget exhaustion), the driver logs and leaves
// managed-window geometry untouched. Non-managed rects (sizeMode overrides,
// floating) still apply since the resolver computed them.
//
// The plugin contract is async. Tests inject a synchronous fake driver to
// stay deterministic without spinning up a worker.

import type {
  LayoutInputs,
  LayoutResult,
  LayoutWindow,
  LayoutReason,
  Rect,
} from "@overdraw/layout-types";
import type { Tiling, SizeMode } from "../events/types.js";
import type { ReservedZoneRegistry } from "./reserved-zones.js";
import { log as coreLog } from "../log.js";

export type { LayoutInputs, LayoutResult, LayoutReason } from "@overdraw/layout-types";

// One tiling region + its member windows (docs/canvas-design.md §5). The
// driver runs the layout plugin once per island. The WM derives one
// implicit island per output (id = outputId, rect = null) from the
// workspace plugin's per-output content; explicit islands carry their own
// world rect and share their output's scale/fullscreen context.
export interface LayoutIsland {
  // Stable island id. Implicit per-output islands use the outputId.
  id: number;
  // The output whose VIEW resolves this island's layout context: the
  // plugin sees this output's rect + scale, and a fullscreen member
  // covers it. Derived, not ownership -- the island source recomputes it
  // as cameras move (the output currently viewing the island); islands
  // do not belong to outputs (docs/canvas-design.md §3).
  contextOutputId: number;
  // The island's tile region in global logical coordinates (used
  // verbatim -- reserved zones never carve an explicit rect; the island
  // source sizes it to the workarea and the camera keeps it clear of
  // the bands), or null to derive it from the output (output rect minus
  // reserved zones) -- the implicit per-output island.
  rect: Rect | null;
  // Ordered member windows, master-front. The driver lays out EXACTLY
  // these windows in this order.
  members: ReadonlyArray<number>;
  // Optional per-island layout hint, passed through verbatim to the
  // layout plugin as LayoutInputs.island.layout (layout-types documents
  // the recognized shapes). Absent = the provider's default algorithm.
  layout?: unknown;
}

// Snapshot the driver needs from the WM to build LayoutInputs + run the
// mode resolver. The WM produces this on demand; the driver consumes it
// and never holds onto references.
export interface LayoutSnapshot {
  // The WM's outputs, each carrying its global-logical-space rect + HiDPI
  // scale. Islands reference these by outputId.
  outputs: ReadonlyArray<{ id: number; rect: Rect; scale: number }>;
  // Every known window (every mapped toplevel), keyed by surfaceId for
  // lookup. The driver does NOT iterate this map -- it iterates each
  // island's members and looks up each id here.
  windows: ReadonlyMap<number, LayoutSnapshotWindow>;
  // The islands to lay out. The WM builds one implicit island per output
  // from the workspace plugin's per-output content (an output with no
  // content contributes no island and nothing is laid out there).
  islands: ReadonlyArray<LayoutIsland>;
}

// The driver's view of a window. Carries everything needed to either pass
// to the layout plugin (for the managed lane) or resolve
// internally (for other lanes).
export interface LayoutSnapshotWindow extends LayoutWindow {
  tiling: Tiling;
  sizeMode: SizeMode;
  visible: boolean;
  // The rect to place a floating window at. Used only when
  // tiling === "floating". Absent otherwise.
  floatingRect?: Rect;
  // For windows transitioning out of a sizeMode back to "none".
  restoreRect?: Rect;
}

// What the driver does with the layout result.
export interface LayoutApplyTarget {
  apply(result: LayoutResult, reason: LayoutReason): void | Promise<void>;
}

// The function the driver uses to invoke the layout plugin. In production
// this wraps runtime.invokeNamespace('layout', 'compute', [inputs]).
export type ComputeFn = (inputs: LayoutInputs) => Promise<LayoutResult>;

export interface LayoutDriver {
  schedule(reason: LayoutReason): void;
  settled(): Promise<void>;
}

export interface LayoutDriverDeps {
  snapshot(): LayoutSnapshot;
  target: LayoutApplyTarget;
  compute: ComputeFn;
  // Reserved-zone registry. Optional: if absent, the driver treats the
  // full output rect as the tile region (no reservations).
  reservedZones?: ReservedZoneRegistry;
  // Diagnostic sink. Default: log.warn on 'core' area.
  log?: (msg: string) => void;
}

export function createLayoutDriver(deps: LayoutDriverDeps): LayoutDriver {
  const log = deps.log ?? ((m) => coreLog.warn("core", `layout: ${m}`));

  let running = false;
  let pendingReason: LayoutReason | null = null;
  let settleWaiters: Array<() => void> = [];

  function schedule(reason: LayoutReason): void {
    if (running) {
      pendingReason = reason;
      return;
    }
    void runOnce(reason);
  }

  async function runOnce(reason: LayoutReason): Promise<void> {
    running = true;
    try {
      const snap = deps.snapshot();
      const outputById = new Map(snap.outputs.map((o) => [o.id, o]));

      // Accumulate the merged result across every island's pass; one final
      // apply() at the end so the WM sees a single transactional update.
      const mergedRects: Array<{ id: number; outer: Rect }> = [];
      let anyComputeFailed = false;

      for (const island of snap.islands) {
        const o = outputById.get(island.contextOutputId);
        if (!o) {
          // An island referencing a departed output has nothing to resolve
          // fullscreen/scale against; its members keep their rects until
          // the island source repairs itself.
          log(`island ${island.id}: unknown output ${island.contextOutputId}; skipped`);
          continue;
        }
        const outputRect: Rect = { ...o.rect };
        // The island's tile region. An explicit world rect is pure
        // content space, used verbatim: reserved zones are glass
        // furniture (a bar lives on the lens, not in the world), so the
        // island source sizes its rects to the workarea and the camera
        // policy keeps them clear of the bands. Only the implicit
        // rect-null island, which derives from the output itself,
        // carves the context output's zones from its edges.
        const workarea = deps.reservedZones
          ? deps.reservedZones.effectiveRect(island.contextOutputId, outputRect)
          : outputRect;
        const tileRegion = island.rect ? { ...island.rect } : workarea;

        const resolvedRects: Array<{ id: number; outer: Rect }> = [];
        const managed: LayoutWindow[] = [];
        const bucket: LayoutSnapshotWindow[] = [];
        for (const id of island.members) {
          const w = snap.windows.get(id);
          if (w) bucket.push(w);
        }

        // Resolve sizing overrides. Every visible sizeMode window gets an
        // override rect; any number may coexist per island -- which one
        // the user sees is a stacking concern (focus picks the top), not
        // a geometry one, so none of them suppresses or reflows another.
        //
        // Fullscreen covers the whole glass and its surface is
        // OUTPUT-ANCHORED (camera-exempt; the WM stamps the flag): for an
        // anchored surface the arrangement-space output rect IS its glass
        // position, so the plain outputRect covers the monitor at every
        // camera position and zoom, with no per-frame updates.
        //
        // Maximized covers the usable glass, island-scoped: for an
        // explicit island a workarea-sized region at the island origin
        // (where the strip collapses to while the maximized member holds
        // focus), clamped to the island rect so a maximize never spills
        // into a sibling island; for the implicit island the tile region
        // itself.
        const overrides = new Map<number, Rect>();
        for (const w of bucket) {
          if (!w.visible || w.sizeMode === "none") continue;
          const outer = w.sizeMode !== "fullscreen"
            ? island.rect
              ? {
                  x: island.rect.x,
                  y: island.rect.y,
                  width: Math.min(workarea.width, island.rect.width),
                  height: Math.min(workarea.height, island.rect.height),
                }
              : tileRegion
            : outputRect;
          resolvedRects.push({ id: w.id, outer });
          overrides.set(w.id, outer);
        }

        for (const w of bucket) {
          // Invisible windows (visible === false) are simply omitted from
          // the result. The WM's applyLayout iterates only the windows in
          // result.rects, so an omitted window keeps its current rect and
          // the compositor's setStack (driven by outputToplevelStacks
          // filtered by visibility in the workspace plugin) ensures it is
          // not drawn.
          if (!w.visible) continue;
          if (w.tiling === "floating") {
            // An override rect is already resolved above; a second
            // (stored-rect) entry would win at apply time.
            if (overrides.has(w.id)) continue;
            // Floating windows keep their stored rect. Fall back to the
            // window's currentRect if none was captured, then to the
            // output rect so the window never vanishes.
            resolvedRects.push({
              id: w.id,
              outer: w.floatingRect ?? w.currentRect ?? outputRect,
            });
            continue;
          }
          // A fullscreen window is not a tile member by definition: it
          // leaves the compute and its peers reflow over the island. A
          // maximized managed window stays IN the compute so it keeps
          // occupying its slot (peers hold position; un-maximizing
          // restores the arrangement without a reflow); its slot rect is
          // dropped at merge in favor of the override.
          if (w.sizeMode === "fullscreen") continue;
          managed.push({
            id: w.id,
            appId: w.appId,
            title: w.title,
            role: w.role,
            layoutMode: w.layoutMode,
            layoutData: w.layoutData,
            constraints: w.constraints,
            currentRect: w.currentRect,
          });
        }

        let pluginResult: LayoutResult = { rects: [] };
        if (managed.length > 0) {
          const inputs: LayoutInputs = {
            output: { id: o.id, rect: outputRect, scale: o.scale },
            tileRegion,
            island: {
              id: island.id,
              ...(island.layout !== undefined ? { layout: island.layout } : {}),
            },
            windows: managed,
            reason,
          };
          try {
            pluginResult = await deps.compute(inputs);
          } catch (e: unknown) {
            anyComputeFailed = true;
            const msg = e instanceof Error ? e.message : String(e);
            log(`compute(${reason}, island=${island.id}) failed: ${msg}`);
            // Skip this island's contribution; other islands still apply.
            continue;
          }
        }

        for (const r of pluginResult.rects) {
          if (overrides.has(r.id)) continue;
          mergedRects.push(r);
        }
        for (const r of resolvedRects) mergedRects.push(r);
      }

      // If EVERY managed pass failed and nothing was resolved either,
      // suppress apply() rather than push an empty result. Otherwise apply
      // -- partial-success is preferable to
      // letting one output's plugin failure freeze every other output.
      if (anyComputeFailed && mergedRects.length === 0) {
        return;
      }
      const merged: LayoutResult = { rects: mergedRects };
      await deps.target.apply(merged, reason);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`compute(${reason}) failed: ${msg}`);
    } finally {
      running = false;
      const next = pendingReason;
      pendingReason = null;
      if (next !== null) {
        // Hold `running` through the setImmediate gap: settled() must not
        // observe the idle window between this pass ending and the
        // chained pass starting, or it resolves with a pass still owed.
        running = true;
        setImmediate(() => { running = false; void runOnce(next); });
      } else {
        const waiters = settleWaiters;
        settleWaiters = [];
        for (const w of waiters) w();
      }
    }
  }

  function settled(): Promise<void> {
    if (!running && pendingReason === null) return Promise.resolve();
    return new Promise<void>((resolve) => { settleWaiters.push(resolve); });
  }

  return { schedule, settled };
}
