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

export type FocusPolicy = "follow-pointer" | "click-to-focus";

export interface FocusConfig {
  // Keyboard-focus policy. Pointer events always follow the pointer regardless.
  // Default: "follow-pointer".
  policy?: FocusPolicy;
  // Give keyboard focus to a window when it maps. Default: true.
  focusOnMap?: boolean;
}

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
  focus?: FocusConfig;
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
  raw: PluginConfig;
}

// Fully-resolved config: every field present, defaults applied. This is what the
// loader returns and the launcher consumes.
export interface ResolvedConfig {
  output: { width: number; height: number } | null; // null = follow host window
  focus: { policy: FocusPolicy; focusOnMap: boolean };
  plugins: ResolvedPlugin[];
  // Absolute path of the config file that was loaded, or null if none was found
  // (built-in defaults in effect).
  sourcePath: string | null;
}
