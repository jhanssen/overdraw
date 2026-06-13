// Layout driver + resolver. Sits between the WM (which owns the window
// list + structural state) and the layout plugin (which owns the geometry
// policy for managed windows).
//
// Responsibilities:
//   - Coalesce relayout requests (at most one compute() in flight; subsequent
//     invalidations queue and replace).
//   - Resolve mode-specific rects in core: presentation === 'maximized' /
//     'fullscreen' / 'minimized' are dispatched by the driver without
//     calling the plugin.
//   - Build LayoutInputs from the WM's `managed` windows + the tile region
//     (output minus reserved zones), invoke compute() on the active layout
//     plugin.
//   - Merge the plugin's result with the driver-resolved rects + hidden
//     list and hand the unified LayoutResult to the WM for apply.
//
// On compute failure (plugin throws, no plugin registered after timeout,
// permanent restart-budget exhaustion), the driver logs and leaves
// managed-window geometry untouched. Non-managed rects (maximize /
// fullscreen) still apply since the resolver computed them.
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
import type { Presentation } from "../events/types.js";
import type { ReservedZoneRegistry } from "./reserved-zones.js";
import { OUTPUT_DEFAULT } from "../protocols/ctx.js";

export type { LayoutInputs, LayoutResult, LayoutReason } from "@overdraw/layout-types";

// Snapshot the driver needs from the WM to build LayoutInputs + run the
// mode resolver. The WM produces this on demand; the driver consumes it
// and never holds onto references.
export interface LayoutSnapshot {
  output: { width: number; height: number };
  // Ordered windows (master-front; index 0 is the layout's master in the
  // managed subset). Carries presentation so the resolver can dispatch
  // before calling the plugin.
  windows: ReadonlyArray<LayoutSnapshotWindow>;
}

// The driver's view of a window. Carries everything needed to either pass
// to the layout plugin (for managed) or resolve internally (for other
// presentations).
export interface LayoutSnapshotWindow extends LayoutWindow {
  presentation: Presentation;
  // For windows transitioning out of maximize/fullscreen back to managed;
  // the driver does not consume this directly but the plugin may use it
  // (currentRect already covers the common case).
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
  // Diagnostic sink. Default: console.warn.
  log?: (msg: string) => void;
}

export function createLayoutDriver(deps: LayoutDriverDeps): LayoutDriver {
  const log = deps.log ?? ((m) => console.warn(`[layout] ${m}`));

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
      const outputRect: Rect = {
        x: 0, y: 0,
        width: snap.output.width,
        height: snap.output.height,
      };

      // Subtract reserved zones to get the tile region. Used by both the
      // resolver (maximized -> effectiveRect) and the layout plugin
      // (its working area).
      const tileRegion = deps.reservedZones
        ? deps.reservedZones.effectiveRect(OUTPUT_DEFAULT, outputRect)
        : outputRect;

      // Split windows by presentation. The driver resolves mode-specific
      // rects itself; only 'managed' windows go to the plugin.
      const resolvedRects: Array<{ id: number; outer: Rect }> = [];
      const hidden: number[] = [];
      const managed: LayoutWindow[] = [];

      for (const w of snap.windows) {
        switch (w.presentation) {
          case "maximized":
            resolvedRects.push({ id: w.id, outer: tileRegion });
            break;
          case "fullscreen":
            resolvedRects.push({ id: w.id, outer: outputRect });
            break;
          case "minimized":
            hidden.push(w.id);
            break;
          case "managed":
          default:
            // Strip the presentation field before handing to the plugin;
            // plugin's LayoutWindow type doesn't include it.
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
            break;
        }
      }

      // Call the plugin only when there are managed windows; otherwise
      // skip the round-trip.
      let pluginResult: LayoutResult = { rects: [] };
      if (managed.length > 0) {
        const inputs: LayoutInputs = {
          output: {
            id: OUTPUT_DEFAULT,
            rect: outputRect,
            scale: 1,
          },
          tileRegion,
          windows: managed,
          reason,
        };
        pluginResult = await deps.compute(inputs);
      }

      // Merge: plugin rects + resolver-computed rects. The plugin's hidden
      // list adds to the resolver's (minimized) list.
      const mergedHidden = [...hidden];
      if (pluginResult.hidden) mergedHidden.push(...pluginResult.hidden);
      const merged: LayoutResult = {
        rects: [...pluginResult.rects, ...resolvedRects],
        ...(mergedHidden.length > 0 ? { hidden: mergedHidden } : {}),
      };

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
