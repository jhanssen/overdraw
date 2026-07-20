// Bundled layout plugin: master-stack and columns modes. Registers in the
// 'layout' namespace at priority 0 (the floor; bundled default). A
// user-installed third-party layout plugin claiming the same namespace at a
// higher priority displaces this one at runtime; if that plugin fails, the
// priority-chain promotes this one back.
//
// Which mode tiles an island is declared (canvas-design.md §5 "Layout mode
// is declared; growth only sizes the region"): `config.layout.mode` sets the
// default, the island's layout hint overrides per island. Growth never
// selects the algorithm -- it only changes the region compute() receives,
// and measure() tells the island source what region an elastic island
// wants.
//
// The SDK passed to init() comes from the plugin Worker's bootstrap. The
// plugin's only responsibility is to call sdk.registerPlugin('layout', ...);
// core's layout driver invokes compute() via sdk.plugin('layout').compute(...)
// (in the driver's case: directly via runtime.invokeNamespace).

import type {
  LayoutAPI, LayoutInputs, LayoutResult, LayoutParamUpdate, LayoutParamSnapshot,
  MeasureInputs, MeasureResult, SizeConstraints,
} from "@overdraw/layout-types";
import type { PluginSdkShape } from "@overdraw/plugin-sdk-types";
import {
  masterStackLayout, columnsLayout, columnsMeasure, DEFAULT_LAYOUT,
  type LayoutParams, type ColumnBounds,
} from "./master-stack.js";

// Master-fraction bounds; matches the clamp masterStackLayout applies.
const MASTER_MIN = 0.05;
const MASTER_MAX = 0.95;

// Column-width fraction bounds (of the workarea width). A column may span
// the full workarea; narrower than a tenth stops being a usable tile.
const COLUMN_MIN = 0.1;
const COLUMN_MAX = 1;

// Validate the raw config. Returns a populated LayoutParams; throws on
// schema deviation. Missing fields take the DEFAULT_LAYOUT values.
function validateConfig(raw: unknown): LayoutParams {
  if (raw === null || raw === undefined) return { ...DEFAULT_LAYOUT };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`layout config must be an object (got ${typeof raw})`);
  }
  const o = raw as { [k: string]: unknown };
  const out: LayoutParams = { ...DEFAULT_LAYOUT };
  if (o.mode !== undefined) {
    if (o.mode !== "master-stack" && o.mode !== "columns") {
      throw new TypeError(
        `layout.mode must be "master-stack" or "columns" (got ${JSON.stringify(o.mode)})`);
    }
    out.mode = o.mode;
  }
  if (o.masterFraction !== undefined) {
    if (typeof o.masterFraction !== "number"
        || !Number.isFinite(o.masterFraction)
        || o.masterFraction < MASTER_MIN || o.masterFraction > MASTER_MAX) {
      throw new TypeError(
        `layout.masterFraction must be a finite number in [${MASTER_MIN}, ${MASTER_MAX}]`);
    }
    out.masterFraction = o.masterFraction;
  }
  if (o.column !== undefined) {
    if (typeof o.column !== "number"
        || !Number.isFinite(o.column)
        || o.column < COLUMN_MIN || o.column > COLUMN_MAX) {
      throw new TypeError(
        `layout.column must be a finite number in [${COLUMN_MIN}, ${COLUMN_MAX}]`);
    }
    out.column = o.column;
  }
  if (o.gap !== undefined) {
    if (typeof o.gap !== "number" || !Number.isFinite(o.gap) || o.gap < 0) {
      throw new TypeError(`layout.gap must be a non-negative finite number`);
    }
    out.gap = o.gap;
  }
  return out;
}

export default async function init(sdk: PluginSdkShape, rawConfig?: unknown): Promise<void> {
  // Config validation is eager (a bad config fails the plugin at load);
  // everything else -- state, subscriptions, the API -- lives in the
  // activation callback below, so a displaced claim leaves no trace.
  const params: LayoutParams = validateConfig(rawConfig);

  // Priority 0 is the bundled-plugin floor (set by the runtime when
  // ResolvedPlugin.bundled is true). Pass undefined here so the runtime's
  // default applies; an explicit value would shadow the bundled marker.
  await sdk.registerPlugin("layout", () => activate(sdk, params));
}

function activate(sdk: PluginSdkShape, params: LayoutParams): LayoutAPI {
  // Per-window column-width fractions (of the workarea width), columns
  // mode. Keyed by surface id so a width follows its window through
  // reorders and across islands. ONLY user-resized windows appear here
  // (grow-column / shrink-column): a window with no entry follows its
  // island's effective column fraction, so re-declaring an island's
  // layout re-sizes everything the user hasn't pinned by hand.
  const colWidths = new Map<number, number>();
  // The island column fraction each window was last laid out at -- the
  // base a resize starts from, since setParams carries no island
  // context. Written by compute/measure, never a user value.
  const lastSeed = new Map<number, number>();
  sdk.windows.onUnmap((ev) => {
    colWidths.delete(ev.surfaceId);
    lastSeed.delete(ev.surfaceId);
  });

  // The effective mode + default column fraction for one island: the
  // declared hint wins over the configured default. Unknown hint shapes
  // fall back to the config (a provider ignores hints it doesn't
  // understand).
  function islandParams(hint: unknown): { mode: LayoutParams["mode"]; column: number } {
    let mode = params.mode;
    let column = params.column;
    if (hint !== null && typeof hint === "object") {
      const h = hint as { mode?: unknown; column?: unknown };
      if (h.mode === "master-stack" || h.mode === "columns") mode = h.mode;
      if (typeof h.column === "number" && Number.isFinite(h.column)) {
        column = Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, h.column));
      }
    }
    return { mode, column };
  }

  function widthOf(id: number, islandColumn: number): number {
    lastSeed.set(id, islandColumn);
    return colWidths.get(id) ?? islandColumn;
  }

  // The width half of a window's size constraints, as column bounds.
  // Columns are full-height by construction, so the height half is not
  // expressible here: an island's height is its workarea's, and strips
  // grow along x only. A window needing more height than the glass is
  // beyond what this mode can express.
  function widthBounds(c: SizeConstraints | undefined): ColumnBounds | undefined {
    const min = c?.minSize?.width;
    const max = c?.maxSize?.width;
    const out: ColumnBounds = {};
    if (typeof min === "number" && Number.isFinite(min) && min > 0) out.min = min;
    if (typeof max === "number" && Number.isFinite(max) && max > 0) out.max = max;
    return out.min === undefined && out.max === undefined ? undefined : out;
  }

  const api: LayoutAPI = {
    async compute(inputs: LayoutInputs): Promise<LayoutResult> {
      // Consumes the window ids, their width constraints, and the working
      // rect; layoutMode, layoutData, currentRect are ignored. Tiles are
      // placed within `tileRegion` (the island's rect; for the implicit
      // per-output island that is the output minus reserved zones); the
      // core resolver dispatched non-managed presentations before we were
      // called. Columns divide the region by weight, so a region sized by
      // measure() lands each on its target and a workarea-sized one
      // compresses them instead.
      const region = inputs.tileRegion;
      const { mode, column } = islandParams(inputs.island?.layout);
      const dims = { width: region.width, height: region.height };
      const rects = mode === "columns"
        ? columnsLayout(
            inputs.windows.map((w) => widthOf(w.id, column)), dims, params.gap,
            inputs.windows.map((w) => widthBounds(w.constraints)))
        : masterStackLayout(inputs.windows.length, dims, params);
      return {
        rects: inputs.windows.map((w, i) => ({
          id: w.id,
          outer: {
            // Translate the algorithm's region-local rect into compositor
            // coordinates by adding the tile region's origin.
            x: rects[i].x + region.x,
            y: rects[i].y + region.y,
            width: rects[i].width,
            height: rects[i].height,
          },
        })),
      };
    },

    async setParams(update: LayoutParamUpdate): Promise<LayoutParamSnapshot> {
      if (typeof update?.masterFractionDelta === "number"
          && Number.isFinite(update.masterFractionDelta)) {
        params.masterFraction = Math.min(MASTER_MAX, Math.max(MASTER_MIN,
          params.masterFraction + update.masterFractionDelta));
      }
      if (typeof update?.gapDelta === "number"
          && Number.isFinite(update.gapDelta)) {
        params.gap = Math.max(0, params.gap + update.gapDelta);
      }
      if (typeof update?.widthDelta === "number"
          && Number.isFinite(update.widthDelta)
          && typeof update?.surfaceId === "number") {
        // Resize from what the window currently shows: its own pinned
        // width, else the island fraction it was last laid out at.
        const cur = colWidths.get(update.surfaceId)
          ?? lastSeed.get(update.surfaceId)
          ?? params.column;
        colWidths.set(update.surfaceId, Math.min(COLUMN_MAX,
          Math.max(COLUMN_MIN, cur + update.widthDelta)));
      }
      return {
        masterFraction: params.masterFraction,
        gap: params.gap,
        column: params.column,
      };
    },

    async measure(inputs: MeasureInputs): Promise<MeasureResult> {
      const wa = inputs.workarea;
      const { mode, column } = islandParams(inputs.island?.layout);
      if (mode !== "columns") {
        // Master-stack always fits its region; its natural size IS the
        // workarea (growth is inert -- canvas-design.md §5).
        return { width: wa.width, height: wa.height };
      }
      const widthsPx = inputs.windows.map(
        (w) => widthOf(w.id, column) * wa.width);
      return columnsMeasure(widthsPx, wa, params.gap,
        inputs.windows.map((w) => widthBounds(w.constraints)));
    },
  };

  sdk.log(`layout activated (mode=${params.mode}, masterFraction=${params.masterFraction}, column=${params.column}, gap=${params.gap})`);
  return api;
}

// Re-export the user-facing config type so plugin authors can
// `satisfies LayoutPluginConfig` from a single import.
export type { LayoutPluginConfig } from "@overdraw/layout-types";
