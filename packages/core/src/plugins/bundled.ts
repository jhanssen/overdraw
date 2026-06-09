// Bundled plugin loader. core-plugin-api.md "No-plugin-loaded fallback" /
// build-order.md phase 0b. Bundled plugins ship with overdraw and load on
// boot before user-config plugins. They register at priority 0 (the floor)
// unless they explicitly override via sdk.registerPlugin's opts.priority.
//
// The list is hardcoded -- explicit and editable in a release-level change.
// Dynamic discovery (looking for node_modules/@overdraw/plugin-*) is rejected
// as fragile (security concern: any matching package would auto-load).
//
// Per Phase 3 of build-order.md, bundled plugins run in-thread (cf.
// inthread-plugin.ts) rather than in a worker_threads Worker. The transport
// is invisible to the plugin author; the runtime selects it via the
// ResolvedPlugin.bundled flag.
//
// Bundled plugin entries are resolved at runtime: the module path is computed
// either as a bare specifier (resolved relative to the overdraw root via
// require.resolve) or as a filesystem path (for tests / dev installations).
// Per-plugin config is computed from the user's loaded config (e.g.
// config.focus -> focus-default's config) and threaded through the
// in-thread loader.

import type { ResolvedPlugin, ResolvedConfig } from "../config/types.js";

// One bundled plugin descriptor. Keep this small; bundled plugins are core's
// own code, so most settings (restart policy etc.) get defaults that match
// the "essential infrastructure" expectation.
export interface BundledPluginSpec {
  // The plugin's stable name (used in logs + namespace registry attribution).
  name: string;
  // Either a bare module specifier (e.g. "@overdraw/plugin-layout-master-stack")
  // or an absolute path. main.ts resolves and converts to a file:// URL.
  module: string;
  // Pull the per-plugin config value out of the loaded user config.
  // Returns undefined when the user did not specify anything relevant; the
  // plugin's init receives undefined and applies its defaults. The default
  // for plugins that take no config is to omit this function.
  configFrom?: (config: ResolvedConfig) => unknown;
}

// The canonical list of bundled plugins. Each ships with overdraw and is
// resolved as a bare npm package specifier via Node's module resolution
// (workspace symlinks point at packages/plugin-<name>/dist/index.js).
//
// Adding a new bundled plugin: add a workspace package under
// packages/, declare its `name` here, and `npm install` to refresh the
// symlinks. The runtime will load it on boot at priority 0.
export const BUNDLED_PLUGINS: ReadonlyArray<BundledPluginSpec> = [
  {
    // Master-stack tiling layout (dwm-style). The floor of the 'layout'
    // namespace; replaceable by a higher-priority user plugin.
    name: "layout-master-stack",
    module: "@overdraw/plugin-layout-master-stack",
    // No user-config knob today (params are plugin-internal defaults).
  },
  {
    // Default focus policy plugin (follow-pointer / click-to-focus +
    // focusOnMap). The floor of the 'focus' namespace.
    name: "focus-default",
    module: "@overdraw/plugin-focus-default",
    configFrom: (config) => config.focus,
  },
];

// Convert a bundled plugin spec to a ResolvedPlugin (the runtime's loading
// shape). The module string is whatever the caller resolved it to (file:// URL
// or bare specifier). The resolvedConfig is the loaded user config (so the
// spec's configFrom can pull out the relevant subset).
//
// Restart policy is "on-failure" / 3 / 60s by tradition; in-thread bundled
// plugins ignore these fields (in-thread failures are fatal, no respawn) but
// they're set for symmetry with the Worker path's ResolvedPlugin shape.
export function bundledToResolved(
  spec: BundledPluginSpec,
  module: string,
  resolvedConfig?: ResolvedConfig,
): ResolvedPlugin {
  // Compute the per-plugin config slice from the user config (if any). The
  // plugin's init(sdk, config) receives this. Passing through verbatim --
  // core does NOT validate; the plugin owns its config schema.
  const raw = resolvedConfig && spec.configFrom
    ? spec.configFrom(resolvedConfig)
    : { module: spec.module, name: spec.name };
  return {
    module,
    name: spec.name,
    restart: "on-failure",
    maxRestarts: 3,
    windowSeconds: 60,
    bundled: true,
    raw,
  };
}
