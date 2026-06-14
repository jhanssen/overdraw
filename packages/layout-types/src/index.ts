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
  | "output-resized"  // the output dimensions changed
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
// `presentation` is NOT on this type because the WM's resolver dispatches
// non-managed modes (maximized / fullscreen / minimized) itself, before
// calling the plugin. The plugin only sees `managed` windows.
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
  // The region the plugin may place windows in. This is the output rect
  // minus reserved zones (layer-shell anchored surfaces, etc.) minus any
  // exclusion zones from non-managed windows on the same output. The
  // plugin treats this as its working area; it should not place windows
  // outside it (decoration layers handle anything that needs to draw
  // beyond).
  tileRegion: Rect;
  windows: ReadonlyArray<LayoutWindow>;
  reason: LayoutReason;
}

// One outer rect per window. The driver applies these to the compositor +
// fires xdg_toplevel.configure for windows whose size changed.
//
// `rects` is for windows the layout chose to place. Omitting a window
// from rects[] means "no opinion, leave its geometry alone." Use
// `hidden[]` to explicitly hide a window this frame (tabbed inactive
// tab, scratchpad-hidden, etc.) -- the WM will not draw it until the
// next layout pass restores it.
//
// rects[] order does NOT need to match windows[] order; the driver
// matches by id.
export interface LayoutResult {
  rects: ReadonlyArray<{ id: number; outer: Rect }>;
  hidden?: ReadonlyArray<number>;
}

// Relative adjustment to a layout's tunable parameters. Fields are deltas,
// not absolutes, so successive grow/shrink commands accumulate. A layout
// applies only the fields it understands and clamps to its own bounds.
export interface LayoutParamUpdate {
  // Change to the master-column fraction (the share of the working area the
  // master tile gets). Positive grows the master, negative shrinks it.
  masterFractionDelta?: number;
}

// The resolved parameter values after a setParams() call.
export interface LayoutParamSnapshot {
  masterFraction: number;
  gap: number;
}

// The contract a plugin claiming 'layout' implements. compute() is required;
// setParams() is optional (a layout with no tunable parameters may omit it).
//
// All methods async per the SDK contract; the master-stack plugin returns
// synchronously (Promise.resolve(...)).
export interface LayoutAPI {
  compute(inputs: LayoutInputs): Promise<LayoutResult>;
  // Adjust runtime parameters (master fraction, gap) and return the resolved
  // values. Bound via the layout.grow-master / layout.shrink-master actions.
  setParams?(update: LayoutParamUpdate): Promise<LayoutParamSnapshot>;
}
