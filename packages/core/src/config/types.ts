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

// The window-state proposal a windowRules `apply` lambda may mutate. This is
// the same WindowState the window.preconfigure event exposes to interceptors;
// re-exported here so config authors can type their lambdas.
import type { WindowState } from "../events/types.js";
export type { WindowState } from "../events/types.js";

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
  // pass-through pattern: the bundled layout plugin owns the schema
  // (`LayoutPluginConfig` from `@overdraw/layout-types`: optional `mode`
  // ("master-stack" | "columns"), `masterFraction` in [0.05, 0.95],
  // `column` in [0.1, 1], and `gap` in px). For typed editing
  // users may
  // `import type { LayoutPluginConfig } from "@overdraw/layout-types"`
  // and write `layout: cfg satisfies LayoutPluginConfig`.
  layout?: unknown;
  // Opt into the canvas workspace provider (docs/canvas-design.md): when
  // set (any object, {} for defaults), @overdraw/plugin-canvas loads in
  // place of @overdraw/plugin-workspace-default as the 'workspace'
  // namespace owner. The canvas plugin owns the slice's schema; verbatim
  // pass-through. Absent = the default workspace plugin.
  canvas?: unknown;
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
  // exec-once: commands launched detached at startup with WAYLAND_DISPLAY set
  // (and DISPLAY when Xwayland is enabled). A bare string runs via `sh -c`
  // (shell parsing, like Hyprland's exec-once); `{ command, args }` execs
  // directly with no shell.
  autostart?: (string | { command: string; args?: string[] })[];
  // Window rules: match windows by appId/title (regex) and apply pre-map
  // policy (float, or an imperative lambda). Consumed by the bundled in-thread
  // @overdraw/plugin-window-rules, which intercepts window.preconfigure so the
  // rule applies BEFORE the window is mapped. Function references (predicate
  // match / `apply`) survive because the plugin is in-thread.
  windowRules?: WindowRule[];
}

// Handler signature for OverdrawConfig.actions entries.
// `sdk` is the bundled plugin's SDK reference; `params` is the value
// the caller passed to sdk.actions.invoke (already with deferred refs
// resolved by the action registry).
export type ActionHandler =
  (sdk: unknown, params?: unknown) => unknown | Promise<unknown>;

// Read-only view of a window at preconfigure (pre-map) time, passed to a
// windowRules predicate or `apply` lambda. `appId` is the wayland app_id, or
// the xwayland WM_CLASS class (the two are unified). Both `appId` and `title`
// may be null when the client never set them.
export interface WindowRuleQuery {
  surfaceId: number;
  appId: string | null;
  title: string | null;
  // True for xwayland (X11) clients, false for native wayland toplevels.
  xwayland: boolean;
}

// Facade passed to a rule's `apply` lambda. The read fields mirror
// WindowRuleQuery; `state` is the mutable pre-map proposal. Assign any field
// of `state` (tiling, exclusive, visible, modal, constraints, parent,
// layoutMode/layoutData) and it takes effect before the window is mapped (no
// flicker). The compositor validates the result; an out-of-shape value is
// ignored (the original state stands).
//
//   apply: (win) => {
//     win.state.tiling = "floating";
//     if (win.title?.includes("Picture-in-Picture")) win.state.exclusive = "none";
//   }
export interface WindowRuleTarget extends WindowRuleQuery {
  state: WindowState;
}

// A rule's match clause: regex strings tested against the window's appId /
// title (when both are present, BOTH must match), OR a predicate over the
// window for arbitrary logic. Regex strings are passed to `new RegExp(...)`;
// an invalid pattern fails at config load.
export type WindowRuleMatch =
  | { appId?: string; title?: string }
  | ((win: WindowRuleQuery) => boolean);

// One window rule. `match` selects windows; the remaining fields are applied
// to each match in array order (later rules win per axis). At least one of the
// action fields should be set for the rule to do anything.
export interface WindowRule {
  match: WindowRuleMatch;
  // Known declarative action: force the window floating (true) or tiled
  // (false) on map. Omit to leave the lane to the default policy.
  float?: boolean;
  // Imperative escape hatch: arbitrary JS run in-thread at preconfigure with a
  // mutable window facade. Runs after the declarative fields above.
  apply?: (win: WindowRuleTarget) => void;
}

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
  // Canvas opt-in slice (undefined = default workspace plugin; any object
  // = @overdraw/plugin-canvas replaces it and owns this schema).
  canvas: unknown;
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
  // exec-once commands, normalized to direct command+args (bare strings become
  // `sh -c <string>`). Spawned detached at startup by main.ts.
  autostart: { command: string; args: string[] }[];
  // Window rules, verbatim from the user config (function refs preserved for
  // the in-thread plugin). Empty array when none declared.
  windowRules: WindowRule[];
  // Absolute path of the config file that was loaded, or null if none was found
  // (built-in defaults in effect).
  sourcePath: string | null;
}
