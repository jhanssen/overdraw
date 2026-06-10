// Bundled plugins: hardcoded, in-thread, register at priority 0 (the floor
// of the namespace priority chain). The list is intentionally not
// auto-discovered -- any matching package in node_modules would otherwise
// auto-load.

import type { ResolvedPlugin, ResolvedConfig } from "../config/types.js";

export interface BundledPluginSpec {
  name: string;
  // Bare specifier (e.g. "@overdraw/plugin-layout-default") or absolute path.
  module: string;
  // Project the user's config to this plugin's config slice. Omit when the
  // plugin takes no config.
  configFrom?: (config: ResolvedConfig) => unknown;
}

export const BUNDLED_PLUGINS: ReadonlyArray<BundledPluginSpec> = [
  {
    name: "layout-default",
    module: "@overdraw/plugin-layout-default",
  },
  {
    name: "focus-default",
    module: "@overdraw/plugin-focus-default",
    configFrom: (config) => config.focus,
  },
  {
    // Loads AFTER focus-default so the workspace plugin's show() can call
    // sdk.windows.requestFocusDecision; the broker forwards through the
    // seat which dispatches through the focus driver -- the focus plugin
    // must be registered by then. Bundled plugins load sequentially in
    // this array's order.
    name: "workspace-default",
    module: "@overdraw/plugin-workspace-default",
  },
];

// Convert a spec to the runtime's ResolvedPlugin shape. The restart fields
// are irrelevant for in-thread bundled plugins (init failures are fatal,
// no respawn) and exist only for shape compatibility with the user-plugin
// path.
export function bundledToResolved(
  spec: BundledPluginSpec,
  module: string,
  resolvedConfig?: ResolvedConfig,
): ResolvedPlugin {
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
