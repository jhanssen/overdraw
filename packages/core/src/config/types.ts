// overdraw user-configuration API.
//
// This is the public, stable shape a user's config file declares. The
// canonical import path is "overdraw/config":
//
//   import type { OverdrawConfig } from "overdraw/config";
//   export default {
//     focus: { policy: "click-to-focus" },
//     plugins: [{ module: "/path/to/plugin.js" }],
//   } satisfies OverdrawConfig;
//
// The type-only import is erased at runtime by Node's native .ts stripping;
// a .js config can omit the import entirely (the shape is structural).
//
// A config file (config.{ts,cts,mts,js,cjs,mjs} under ~/.config/overdraw/,
// or a path given with --config) default-exports either an OverdrawConfig
// object or a function returning one (sync or async).
//
// Every field is optional; an absent config (or absent field) uses
// defaults.

// Per-output overrides keyed by the output's durable identifier. The key
// is checked first against EDID (an OutputRecord whose `edidId` is
// non-empty); if no entry matches, the connector name (e.g. "DP-1") is
// tried. Same precedence the workspace plugin's preferredOutputs list
// uses. Values are restored on boot AND on hotplug add for the matching
// output -- they are equivalent to a sticky `wlr-output-management`
// set_position / set_scale, just declared statically.
export interface OutputConfigEntry {
  // Logical position in the global compositor coordinate space. Used by
  // the WM's layout rect, pointer clamping, and surface-residency.
  position?: { x: number; y: number };
  // HiDPI scale factor. Same semantics as the top-level `scale` field,
  // but scoped to one output. Fractional values allowed.
  scale?: number;
}

export interface OutputConfig {
  // Logical output size. The host window size drives this in nested mode;
  // a value here is only an override hint. Real wl_output / resize
  // handling is not built (see docs/status.md).
  width?: number;
  height?: number;
  // DRM card override for the KMS backend, e.g. "/dev/dri/card1". When
  // omitted, the first card with a connected connector is used. Ignored by
  // the nested backend.
  card?: string;
  // Output scale factor (HiDPI). Logical size = device pixels / scale.
  // Fractional values (e.g. 1.5) are allowed. When omitted, the scale is
  // auto-derived from the display's EDID DPI (KMS), falling back to 1.
  // Applies to every output that lacks a more-specific `byKey[<key>].scale`.
  scale?: number;
  // Per-output overrides. Keys are durable identifiers (EDID-derived
  // `<MFR>-<PRODUCT_HEX>-<SERIAL_HEX>`, or the connector name when EDID
  // is unavailable). Used at boot AND on hotplug add for the matching
  // output -- restoring `position` and `scale` after a replug or
  // session restart. See multi-output-design §10.
  byKey?: Record<string, OutputConfigEntry>;
}

// Restart behavior when a plugin fails (crash, OOM, watchdog termination, or
// init rejection). "on-failure" (default) restarts up to maxRestarts within a
// rolling windowSeconds, then marks the plugin permanently failed for the
// session; "never" disables restart.
export type RestartPolicy = "on-failure" | "never";

// Plugin entry. The plugin runtime (scope B: worker isolation, lifecycle,
// watchdog, restart policy) consumes `module`/`name`/`restart`/`maxRestarts`/
// `windowSeconds`. NOT yet consumed: capability grants and the GPU/window SDK
// surface (those land with the GPU-backed plugin work). The index signature
// reserves room for the capability schema without committing to its shape now.
export interface PluginConfig {
  // Module specifier / path to the plugin's ES module. Required.
  module: string;
  // Stable identifier (logging, restart counting, future capability grants).
  // Defaults to `module` when omitted.
  name?: string;
  // Restart policy. Default: "on-failure".
  restart?: RestartPolicy;
  // Max restarts within the rolling window before giving up. Default: 3.
  maxRestarts?: number;
  // Rolling-window length, in seconds, for the restart budget. Default: 60.
  windowSeconds?: number;
  [key: string]: unknown;
}

export interface OverdrawConfig {
  output?: OutputConfig;
  // Bundled-plugin config slice for the 'focus' namespace. Verbatim
  // pass-through to the active focus plugin's init(sdk, config). Core does
  // NOT validate; the focus plugin owns its schema (defaults to the bundled
  // `@overdraw/plugin-focus-default`, which accepts
  // `{ policy: 'follow-pointer' | 'click-to-focus', focusOnMap: boolean }`).
  // For IDE-friendly typing, users may
  // `import type { FocusPluginConfig } from '@overdraw/plugin-focus-default'`
  // and write `focus: cfg satisfies FocusPluginConfig`.
  focus?: unknown;
  // Bundled-plugin config slice for the 'hotkey' namespace. Same verbatim
  // pass-through pattern as `focus`: the bundled hotkey plugin owns the
  // schema (`KeyboardConfig` from `@overdraw/hotkey-types`). For typed
  // editing, users may
  // `import type { KeyboardConfig } from "@overdraw/hotkey-types"` and
  // write `hotkeys: cfg satisfies KeyboardConfig`.
  hotkeys?: unknown;
  // Bundled-plugin config slice for the decoration provider. Same verbatim
  // pass-through pattern: the bundled decoration plugin owns the schema
  // (`DecorationPluginConfig` from `@overdraw/decoration-types`). For typed
  // editing, users may
  // `import type { DecorationPluginConfig } from "@overdraw/decoration-types"`
  // and write `decoration: cfg satisfies DecorationPluginConfig`.
  decoration?: unknown;
  // Bundled-plugin config slice for the 'layout' namespace. Same verbatim
  // pass-through pattern: the bundled master-stack layout plugin owns the
  // schema (`LayoutPluginConfig` from `@overdraw/layout-types`: optional
  // `masterFraction` in [0.05, 0.95] and `gap` in px). For typed editing
  // users may
  // `import type { LayoutPluginConfig } from "@overdraw/layout-types"`
  // and write `layout: cfg satisfies LayoutPluginConfig`.
  layout?: unknown;
  // User-defined actions. Each entry is a name -> handler function
  // registered into the core action registry by the bundled
  // @overdraw/plugin-config-actions. Handlers run in the main thread
  // (the bundled plugin is in-thread); the handler receives `sdk` (the
  // plugin's SDK reference) and the action params. Use this to bind a
  // hotkey to inline JS without writing a full plugin:
  //
  //   actions: {
  //     "user.toggle-mute": async (sdk) => { ... },
  //   },
  //   hotkeys: { modes: { default: [
  //     { keys: "Mod+m", action: "user.toggle-mute" },
  //   ]}}
  //
  // Convention: prefix names with "user." to avoid colliding with
  // plugin-registered actions. Not enforced; collisions surface as
  // duplicate-registration errors at boot.
  actions?: { [name: string]: ActionHandler };
  // DEFERRED — see PluginConfig. Declared/validated but not yet consumed.
  plugins?: PluginConfig[];
  // Rootless XWayland. When `enabled` is true, the compositor spawns a
  // rootless Xwayland child at startup and exports its DISPLAY for X11
  // clients. `terminate` toggles Xwayland's `-terminate` (exit when the last
  // X client disconnects). `xwaylandPath` overrides the binary lookup (the
  // default resolves "Xwayland" on PATH). `displayNumber` requests an
  // explicit display (default 50, well outside the typical 0-9 range used
  // by primary sessions); set null to let Xwayland autopick from :0 upward
  // (NOT recommended on a host with an existing X session).
  // `scale` (integer 0..3) picks the global Xwayland scale (see
  // docs/xwayland-design.md "HiDPI"). 0 = auto: ceil(max(output.scale)) at
  // Xwayland start, clamped to [1,3]. 1..3 = explicit. Frozen for the
  // Xwayland session; output hotplug after start does not change it.
  xwayland?: {
    enabled?: boolean;
    terminate?: boolean;
    xwaylandPath?: string;
    displayNumber?: number | null;
    scale?: number;
  };
}

// Handler signature for OverdrawConfig.actions entries.
// `sdk` is the bundled plugin's SDK reference; `params` is the value
// the caller passed to sdk.actions.invoke (already with deferred refs
// resolved by the action registry).
export type ActionHandler =
  (sdk: unknown, params?: unknown) => unknown | Promise<unknown>;

// The config default export: an object, or a (sync/async) function returning one.
export type ConfigExport =
  | OverdrawConfig
  | (() => OverdrawConfig | Promise<OverdrawConfig>);

// A plugin entry with every runtime-relevant field resolved (defaults applied).
// `raw` carries the original user object so future fields (capabilities) survive
// without this type having to enumerate them yet.
export interface ResolvedPlugin {
  module: string;
  name: string;
  restart: RestartPolicy;
  maxRestarts: number;
  windowSeconds: number;
  // True for plugins that ship with overdraw. The runtime selects the
  // in-thread transport for bundled plugins; user plugins always run in a
  // Worker. Also drives the default priority on sdk.registerPlugin
  // (bundled -> 0, user -> 100).
  bundled: boolean;
  // Per-plugin config blob. For user plugins: the raw PluginConfig
  // (preserves capability grants etc.). For bundled plugins: the slice
  // extracted by the spec's configFrom. Passed verbatim to the plugin's
  // init(sdk, config); core does not validate.
  raw: unknown;
}

// Fully-resolved config: every field present, defaults applied.
export interface ResolvedConfig {
  output: { width: number; height: number } | null; // null = follow host window
  // DRM card override for the KMS backend (e.g. "/dev/dri/card1"), or null to
  // auto-detect the first card with a connected connector.
  card: string | null;
  // Output scale override, or null to auto-derive (EDID DPI on KMS, else 1).
  scale: number | null;
  // Per-durable-key overrides ({position, scale}). Maps from the durable
  // identifier (edidId when non-empty, else connector name) to the
  // user-declared overrides. Seeded into state.outputPositionMemory /
  // state.outputScaleMemory at boot so they take effect both at startup
  // and on hotplug add. Empty map = no per-output overrides.
  outputsByKey: Record<string, { position?: { x: number; y: number }; scale?: number }>;
  // Verbatim user value (or undefined). Threaded to the bundled focus
  // plugin via bundled.ts's configFrom; the plugin validates.
  focus: unknown;
  // Same verbatim pass-through to the bundled hotkey plugin.
  hotkeys: unknown;
  // Same verbatim pass-through to the bundled decoration plugin.
  decoration: unknown;
  // Same verbatim pass-through to the bundled layout plugin.
  layout: unknown;
  // User-defined action handlers. The bundled @overdraw/plugin-config-
  // actions registers each entry into the action registry. Function
  // references survive only because the plugin is in-thread (bundled);
  // verbatim pass-through.
  actions: unknown;
  plugins: ResolvedPlugin[];
  // Rootless XWayland settings. `enabled=false` skips spawning Xwayland.
  // `xwaylandPath` is null when the user did not override the lookup.
  // `displayNumber` is the X display to bind (default 50); null means let
  // Xwayland autopick from :0 upward (test-only; collides with live sessions).
  xwayland: {
    enabled: boolean;
    terminate: boolean;
    xwaylandPath: string | null;
    displayNumber: number | null;
    // 0 = auto (ceil(max output scale) at start, clamped to [1,3]); 1..3 = explicit.
    scale: number;
  };
  // Absolute path of the config file that was loaded, or null if none was found
  // (built-in defaults in effect).
  sourcePath: string | null;
}
