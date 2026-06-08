// Canonical types for the layout plugin namespace (core-plugin-api.md §13).
//
// Any plugin claiming the 'layout' namespace MUST conform to LayoutAPI. The
// shared package gives core's layout driver and the implementing plugin a
// single source of truth for the wire shape (Worker-postMessage serializes
// these values).
//
// Why a separate package: per core-plugin-api.md "Namespace = API contract",
// two plugins claiming 'layout' must implement the same canonical interface.
// Pinning that interface in its own package means an implementing plugin
// 'declare module 'overdraw'' augmentation references the same exact type
// (not a copy that could drift); npm dedup makes the workspace see one
// definition.
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

// Why the layout driver is re-invoking compute(). The plugin may use this to
// skip work in some cases (e.g. ignore 'focus-changed' if focus does not
// affect layout in this plugin's policy).
export type LayoutReason =
  | "mapped"          // a window mapped (was added to the layout)
  | "unmapped"        // a window unmapped (was removed from the layout)
  | "output-resized"  // the output dimensions changed
  | "focus-changed"   // keyboard / pointer focus changed (relevant to follow-focus layouts)
  | "reorder"         // explicit stack-order change (e.g. raise)
  | "param-changed";  // layout-specific config (master fraction, gap) changed

export interface WindowHints {
  // Client-requested geometry constraints. The xdg_toplevel set_min_size /
  // set_max_size requests populate these; until those handlers land
  // (status.md "Read first") they are undefined.
  minSize?: { width: number; height: number };
  maxSize?: { width: number; height: number };
  // Client-requested or plugin-imposed state. The layout plugin treats these
  // as inputs: e.g. a fullscreen window fills the output regardless of the
  // tiling algorithm; a floating window is omitted from the tile.
  wantsFullscreen?: boolean;
  wantsMaximized?: boolean;
  wantsMinimized?: boolean;
  floating?: boolean;
}

// What the layout sees about each window. The layout's compute() iterates
// these in order; index 0 is conventionally the 'master' in tiling layouts.
export interface LayoutWindow {
  id: number;             // Surface id (matches core's window record).
  appId?: string | null;
  title?: string | null;
  // Role in the compositor's surface tree. 'toplevel' is the normal case;
  // 'layer-shell' surfaces (status bars etc.) are NOT in the layout's window
  // list -- they are positioned by the layer-shell protocol. Listed here for
  // type completeness; today only toplevel is passed.
  role: "toplevel" | "layer-shell";
  hints: WindowHints;
  // The window's current outer rect, if any. Lets a layout animate from the
  // current position (a future plugin might transition rects smoothly). The
  // master-stack plugin ignores this.
  currentRect?: Rect;
}

export interface LayoutInputs {
  output: Output;
  windows: ReadonlyArray<LayoutWindow>;
  reason: LayoutReason;
}

// One outer rect per window. The driver applies these to the compositor +
// fires xdg_toplevel.configure for windows whose size changed.
//
// Layouts that want to omit a window from the layout (e.g. a minimized
// window) may simply not include it in rects[]. The driver treats omitted
// windows as hidden (their last rect is removed from the compositor).
//
// rects[] order does NOT need to match windows[] order; the driver matches
// by id. (Master-stack returns them in the order it consumed; another
// layout might reorder.)
export interface LayoutResult {
  rects: ReadonlyArray<{ id: number; outer: Rect }>;
}

// The contract a plugin claiming 'layout' implements. compute() is the only
// method today; future revisions may add others (e.g. an animation hook).
//
// All methods async per the SDK contract; the master-stack plugin returns
// synchronously (Promise.resolve(...)).
export interface LayoutAPI {
  compute(inputs: LayoutInputs): Promise<LayoutResult>;
}
