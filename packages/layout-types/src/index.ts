// Canonical types for the layout plugin namespace (core-plugin-api.md §13).
//
// Any plugin claiming the 'layout' namespace MUST conform to LayoutAPI. The
// shared package gives core's layout driver and the implementing plugin a
// single source of truth for the wire shape (Worker-postMessage serializes
// these values).
//
// Type-only: there is no runtime code here. The compiled output is an empty
// index.js + the .d.ts. The plugin and core both `import type { ... } from
// "@overdraw/layout-types"`.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Output {
  // Stable identity (OUTPUT_DEFAULT = 0 today; real ids when multi-output
  // reconfiguration lands per status.md).
  id: number;
  // The output's rect in compositor coordinates.
  rect: Rect;
  // HiDPI scale factor. 1 today (wl_output is fabricated; scale is hardcoded).
  scale: number;
}

// Why the layout driver is re-invoking compute(). Plugins may skip work for
// reasons that do not affect their policy.
export type LayoutReason =
  | "mapped"          // a window mapped (was added to the layout)
  | "unmapped"        // a window unmapped (was removed from the layout)
  | "output-resized"  // an existing output's dimensions changed
  | "output-added"    // a new output joined the set (hotplug add)
  | "output-removed"  // an existing output left the set (hotplug remove)
  | "focus-changed"   // keyboard / pointer focus changed
  | "reorder"         // explicit stack-order change (e.g. raise)
  | "param-changed"   // layout-specific config (master fraction, gap) changed
  | "state-changed"   // a window's behavioral state changed (presentation,
                      // layoutMode, layoutData, or constraints)
  | "reserved-zones-changed";  // a layer-shell exclusive zone was added,
                               // removed, or resized; the tile region
                               // (output minus reserved zones) shifted

// Protocol-defined size constraints from xdg_toplevel.set_min_size /
// set_max_size. Layouts should clamp the rects they assign within these
// bounds where possible; the WM does not auto-clamp.
export interface SizeConstraints {
  minSize?: { width: number; height: number };
  maxSize?: { width: number; height: number };
}

// What the layout sees about each window. The layout's compute() iterates
// these in order; index 0 is conventionally the 'master' in tiling layouts.
//
// The three decision axes (`tiling`, `exclusive`, `visible`) are NOT on
// this type because the WM's resolver dispatches non-managed lanes
// (exclusive, invisible, floating) itself, before calling the plugin.
// The plugin only sees windows whose tiling is "managed" AND exclusive
// is "none" AND visible is true.
export interface LayoutWindow {
  id: number;             // surface id (matches core's window record)
  appId?: string | null;
  title?: string | null;
  // Role in the compositor's surface tree. 'toplevel' is the normal case;
  // 'layer-shell' surfaces (status bars etc.) are NOT in the layout's window
  // list -- they are positioned by the layer-shell protocol. Listed here for
  // type completeness; today only toplevel is passed.
  role: "toplevel" | "layer-shell";
  // Layout-plugin-defined arrangement vocabulary. Opaque to core. The
  // bundled master-stack plugin ignores it; a more complex plugin (tabbed,
  // scrollable, scratchpad) consumes it to decide placement.
  layoutMode?: string;
  // Plugin-private per-window blob. Carried across compute() calls via the
  // WM's window state. Opaque to core; the plugin reads/writes it through
  // sdk.windows.propose. The plugin is responsible for keeping it
  // structured-clone-safe.
  layoutData?: unknown;
  // Protocol-defined size constraints. Layouts should respect them.
  constraints?: SizeConstraints;
  // The window's current outer rect, if any. Lets a layout animate from the
  // current position. The master-stack plugin ignores this.
  currentRect?: Rect;
}

export interface LayoutInputs {
  output: Output;
  // The region the plugin may place windows in: the island's rect
  // (docs/canvas-design.md §5). For the implicit per-output island this is
  // the output rect minus reserved zones (layer-shell anchored surfaces,
  // etc.); an explicit island supplies its own world rect. The plugin
  // treats this as its working area; it should not place windows outside
  // it (decoration layers handle anything that needs to draw beyond).
  tileRegion: Rect;
  // The island whose members are being laid out. One compute() call per
  // island; an output showing several islands produces several calls.
  // Implicit per-output islands use the outputId as their island id.
  // Layouts that key persistent parameters (master fraction, column
  // widths) should key them per island id, not per output id.
  //
  // `layout` is an optional per-island hint set by the island source
  // (the workspace-namespace plugin) and passed through verbatim: the
  // island's DECLARED layout, from user config / a runtime
  // workspace.set-layout -- never derived from the island's growth
  // (canvas-design.md §5 "Layout mode is declared"). Providers that
  // understand a hint honor it; others ignore it. The bundled plugin
  // recognizes `{ mode: "master-stack" | "columns", column?: number }`
  // (column = the default column-width fraction for this island) and
  // falls back to its configured default mode when absent.
  island: { id: number; layout?: unknown };
  windows: ReadonlyArray<LayoutWindow>;
  reason: LayoutReason;
}

// One outer rect per window. The driver applies these to the compositor +
// fires xdg_toplevel.configure for windows whose size changed.
//
// `rects` is for windows the layout chose to place. Omitting a window
// from rects[] means "do not draw this window this frame" -- the WM
// will not assign it a rect, the workspace plugin's outputToplevelStacks
// filtering will see no rect for it, and the compositor will not render
// it. The next layout pass that includes its id restores it.
//
// rects[] order does NOT need to match windows[] order; the driver
// matches by id.
export interface LayoutResult {
  rects: ReadonlyArray<{ id: number; outer: Rect }>;
}

// Relative adjustment to a layout's tunable parameters. Fields are deltas,
// not absolutes, so successive grow/shrink commands accumulate. A layout
// applies only the fields it understands and clamps to its own bounds.
export interface LayoutParamUpdate {
  // Change to the master-column fraction (the share of the working area the
  // master tile gets). Positive grows the master, negative shrinks it.
  masterFractionDelta?: number;
  // Change to the gap between tiles (and around the work-area edge), in px.
  // Positive grows the gap, negative shrinks it. The layout clamps to a
  // non-negative result.
  gapDelta?: number;
  // Change to ONE window's column-width fraction (columns mode). Both
  // fields together: `surfaceId` names the window, `widthDelta` is the
  // fraction delta (of the workarea width). The layout seeds an unseen
  // window at its default column fraction before applying the delta and
  // clamps the result to its own bounds.
  surfaceId?: number;
  widthDelta?: number;
}

// The resolved parameter values after a setParams() call.
export interface LayoutParamSnapshot {
  masterFraction: number;
  gap: number;
  // Default column-width fraction (columns mode seed value).
  column: number;
}

// What measure() sees: the would-be members (ids only -- the island
// source has already filtered lanes exactly as the driver does for
// compute(): managed, non-exclusive, visible) and the island's sizing
// authority, its home workarea (canvas-design.md §10b).
export interface MeasureInputs {
  // The would-be members, each with the size constraints compute() will
  // see for it. Core fills these in from window state; the island source
  // supplies only the ids.
  windows: ReadonlyArray<{ id: number; constraints?: SizeConstraints }>;
  workarea: { width: number; height: number };
  island: { id: number; layout?: unknown };
}

// A layout's natural size for the given members (canvas-design.md §5
// "Layout mode is declared; growth only sizes the region"). An elastic
// island's rect is this result; a fixed island keeps the workarea and
// the same algorithm compresses into it. Never smaller than the
// workarea (islands grow; they don't shrink below the glass).
export interface MeasureResult {
  width: number;
  height: number;
}

// Startup config for the bundled master-stack layout plugin. Read from
// the user's `config.layout` slice. Every field is optional; missing
// fields take the documented defaults.
export interface LayoutPluginConfig {
  // Which algorithm tiles an island when its hint doesn't say otherwise
  // (canvas-design.md §5 "Layout mode is declared"). "master-stack"
  // (default): master column + vertical stack. "columns": one
  // full-height column per window, per-window widths.
  mode?: "master-stack" | "columns";
  // Initial master-column fraction in [0.05, 0.95]. Default 0.5. The
  // layout.grow-master / shrink-master actions adjust this at runtime.
  // Consumed by master-stack mode.
  masterFraction?: number;
  // Default column-width fraction in [0.1, 1]. Default 0.5. Seeds each
  // window's column width in columns mode; the layout.grow-column /
  // shrink-column actions adjust one window's width at runtime.
  //
  // The fraction is of the workarea PITCH -- a column's share of the
  // glass INCLUDING its gap allotment -- so N columns at 1/N tile the
  // screen exactly with nothing offscreen (two 0.5 columns fit side by
  // side). With gap > 0 a column is therefore fractionally narrower
  // than `column x workarea`.
  column?: number;
  // Initial gap (logical px) between tiles AND around the outer edge of
  // the work area. Default 0 (no gap; tiles touch). The runtime gap
  // delta actions (layout.grow-gap / shrink-gap) adjust this on the
  // fly; the value is clamped to >= 0.
  gap?: number;
}

// The contract a plugin claiming 'layout' implements. compute() is required;
// setParams() is optional (a layout with no tunable parameters may omit it).
//
// All methods async per the SDK contract; the master-stack plugin returns
// synchronously (Promise.resolve(...)).
export interface LayoutAPI {
  compute(inputs: LayoutInputs): Promise<LayoutResult>;
  // Adjust runtime parameters (master fraction, gap, per-window column
  // width) and return the resolved values. Bound via the layout.grow-* /
  // shrink-* actions.
  setParams?(update: LayoutParamUpdate): Promise<LayoutParamSnapshot>;
  // The layout's natural size for these members in this workarea. The
  // island source calls this to size an elastic island's rect before
  // publishing; providers without it leave elastic islands at the
  // workarea (growth is inert).
  measure?(inputs: MeasureInputs): Promise<MeasureResult>;
}
