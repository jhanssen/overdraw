// overdraw user-configuration API.
//
// This is the public, stable shape a user's config file declares. It lives in
// the core as a .ts so a standalone .d.ts can be generated later (for users who
// `import type { OverdrawConfig } from "overdraw"` in their config.ts — that
// type-only import is erased at runtime by Node's type stripping, so it works
// even before such a package export exists).
//
// A config file (config.{ts,cts,mts,js,cjs,mjs} under ~/.config/overdraw/, or a
// path given with --config) default-exports either an OverdrawConfig object or a
// function returning one (sync or async):
//
//   import type { OverdrawConfig } from "overdraw";
//   export default {
//     focus: { policy: "click-to-focus" },
//     plugins: [{ module: "/path/to/plugin.js" }],
//   } satisfies OverdrawConfig;
//
// Every field is optional; an absent config (or absent field) uses defaults.

export interface OutputConfig {
  // Logical output size. Phase 1 nested: today this is driven by the host window
  // size from addon.start(); a value here is an override hint only (real
  // wl_output / resize handling is not built yet — see docs/status.md).
  width?: number;
  height?: number;
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
  // DEFERRED — see PluginConfig. Declared/validated but not yet consumed.
  plugins?: PluginConfig[];
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
  // True for bundled plugins (loaded by core, ships with overdraw). When the
  // plugin calls sdk.registerPlugin without an explicit priority, bundled
  // defaults to 0 (the floor); user plugins default to 100. Bundled is also
  // a hook for the in-thread (vs Worker) transport later; not used yet.
  bundled: boolean;
  // Per-plugin config blob. For user plugins this is the raw PluginConfig
  // (preserves capability grants etc. that core doesn't know about yet).
  // For bundled plugins this is the value extracted from the user config
  // by the spec's configFrom (e.g. config.focus for plugin-focus-default).
  // Verbatim pass-through to the plugin's init(sdk, config) -- core does
  // NOT validate; the plugin owns its schema.
  raw: unknown;
}

// Fully-resolved config: every field present, defaults applied. This is what the
// loader returns and the launcher consumes.
export interface ResolvedConfig {
  output: { width: number; height: number } | null; // null = follow host window
  // Verbatim user value (or undefined if absent). Threaded into the bundled
  // focus plugin's config via bundled.ts's configFrom; the plugin validates.
  focus: unknown;
  plugins: ResolvedPlugin[];
  // Absolute path of the config file that was loaded, or null if none was found
  // (built-in defaults in effect).
  sourcePath: string | null;
}
