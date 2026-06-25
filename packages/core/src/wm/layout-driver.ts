// Layout driver + resolver. Sits between the WM (which owns the window
// list + structural state) and the layout plugin (which owns the geometry
// policy for managed windows).
//
// Responsibilities:
//   - Coalesce relayout requests (at most one compute() in flight; subsequent
//     invalidations queue and replace).
//   - Resolve non-managed lanes in core: a window with exclusive !== "none"
//     covers the workspace (tileRegion for maximized, full output for
//     fullscreen) and suppresses peers; an invisible (visible === false)
//     window is omitted from the result; a floating (tiling === "floating")
//     window uses its stored floatingRect.
//   - Build LayoutInputs from the WM's `managed`, non-exclusive, visible
//     windows + the tile region (output minus reserved zones), invoke
//     compute() on the active layout plugin.
//   - Merge the plugin's result with the driver-resolved rects and hand
//     the unified LayoutResult to the WM for apply.
//
// On compute failure (plugin throws, no plugin registered after timeout,
// permanent restart-budget exhaustion), the driver logs and leaves
// managed-window geometry untouched. Non-managed rects (exclusive,
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
import type { Tiling, Exclusive } from "../events/types.js";
import type { ReservedZoneRegistry } from "./reserved-zones.js";
import { log as coreLog } from "../log.js";

export type { LayoutInputs, LayoutResult, LayoutReason } from "@overdraw/layout-types";

// Snapshot the driver needs from the WM to build LayoutInputs + run the
// mode resolver. The WM produces this on demand; the driver consumes it
// and never holds onto references.
export interface LayoutSnapshot {
  // The WM's outputs, each carrying its global-logical-space rect + HiDPI
  // scale. The driver runs the layout plugin once per output.
  outputs: ReadonlyArray<{ id: number; rect: Rect; scale: number }>;
  // Every known window (every mapped toplevel), keyed by surfaceId for
  // lookup. The driver does NOT iterate this map -- it iterates
  // outputContent per output and looks up each id here.
  windows: ReadonlyMap<number, LayoutSnapshotWindow>;
  // Ordered per-output visible-window lists, master-front. When set for an
  // output, the layout-driver lays out EXACTLY these windows in this order.
  // Absent or empty for an output -> the driver lays out nothing on that
  // output. Provided by the workspace plugin via state.outputToplevelStacks
  // (which it keeps in sync as workspaces switch and windows move); the WM
  // copies that map into the snapshot at snapshot() time.
  outputContent: ReadonlyMap<number, ReadonlyArray<number>>;
}

// The driver's view of a window. Carries everything needed to either pass
// to the layout plugin (for managed/non-exclusive/visible) or resolve
// internally (for other lanes).
export interface LayoutSnapshotWindow extends LayoutWindow {
  tiling: Tiling;
  exclusive: Exclusive;
  visible: boolean;
  // The rect to place a floating window at. Used only when
  // tiling === "floating". Absent otherwise.
  floatingRect?: Rect;
  // For windows transitioning out of exclusive back to non-exclusive.
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

      // Accumulate the merged result across every output's pass; one final
      // apply() at the end so the WM sees a single transactional update.
      const mergedRects: Array<{ id: number; outer: Rect }> = [];
      let anyComputeFailed = false;

      for (const o of snap.outputs) {
        const outputRect: Rect = { ...o.rect };
        const tileRegion = deps.reservedZones
          ? deps.reservedZones.effectiveRect(o.id, outputRect)
          : outputRect;

        const resolvedRects: Array<{ id: number; outer: Rect }> = [];
        const managed: LayoutWindow[] = [];
        // The visible window order on this output comes from the workspace
        // plugin's outputContent map. An absent entry means "no workspace
        // is shown on this output," and nothing should be laid out there.
        const ids = snap.outputContent.get(o.id) ?? [];
        const bucket: LayoutSnapshotWindow[] = [];
        for (const id of ids) {
          const w = snap.windows.get(id);
          if (w) bucket.push(w);
        }

        // First pass: find an exclusive (maximized or fullscreen) window.
        // If one exists and is visible, it owns the workspace and every
        // peer (except a fullscreen-on-top floating, which is also owned
        // out of the way) is suppressed from this frame.
        let exclusiveWin: LayoutSnapshotWindow | null = null;
        for (const w of bucket) {
          if (!w.visible) continue;
          if (w.exclusive !== "none") { exclusiveWin = w; break; }
        }

        if (exclusiveWin !== null) {
          const outer = exclusiveWin.exclusive === "fullscreen" ? outputRect : tileRegion;
          resolvedRects.push({ id: exclusiveWin.id, outer });
          for (const r of resolvedRects) mergedRects.push(r);
          continue;
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
            // Floating windows keep their stored rect. Fall back to the
            // window's currentRect if none was captured, then to the
            // output rect so the window never vanishes.
            resolvedRects.push({
              id: w.id,
              outer: w.floatingRect ?? w.currentRect ?? outputRect,
            });
            continue;
          }
          // Managed lane: hand to the plugin.
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
            windows: managed,
            reason,
          };
          try {
            pluginResult = await deps.compute(inputs);
          } catch (e: unknown) {
            anyComputeFailed = true;
            const msg = e instanceof Error ? e.message : String(e);
            log(`compute(${reason}, output=${o.id}) failed: ${msg}`);
            // Skip this output's contribution; other outputs still apply.
            continue;
          }
        }

        for (const r of pluginResult.rects) mergedRects.push(r);
        for (const r of resolvedRects) mergedRects.push(r);
      }

      // Match the pre-multi-output behavior: if EVERY managed pass failed and
      // nothing was resolved either, suppress apply() rather than push an
      // empty result. Otherwise apply -- partial-success is preferable to
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
        setImmediate(() => { void runOnce(next); });
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
