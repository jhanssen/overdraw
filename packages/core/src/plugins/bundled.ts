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
    // Loads first so its actions (compositor.quit, ...) are available for
    // any subsequent plugin that wants to bind them. Bundled plugins load
    // sequentially in this array's order.
    name: "core-actions",
    module: "@overdraw/plugin-core-actions",
  },
  {
    // Loads alongside core-actions for the same reason: cursor.* actions
    // should be available to hotkey bindings (registered later). Has no
    // namespace registration, just action registrations.
    name: "cursor-actions",
    module: "@overdraw/plugin-cursor-actions",
  },
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
    // must be registered by then.
    name: "workspace-default",
    module: "@overdraw/plugin-workspace-default",
  },
  {
    // Loads after all action-registering plugins so the user's actions
    // can call into theirs by name. Loads BEFORE hotkey-default so a
    // hotkey can bind to a user.* action.
    name: "config-actions",
    module: "@overdraw/plugin-config-actions",
    configFrom: (config) => config.actions,
  },
  {
    // Loads LAST so any action it might bind (compositor.quit,
    // workspace.show, user.*, etc.) is already registered. The hotkey
    // plugin never needs other plugins' namespaces at init time, but
    // its BINDINGS are unmeaningful until the corresponding action
    // exists.
    name: "hotkey-default",
    module: "@overdraw/plugin-hotkey-default",
    configFrom: (config) => config.hotkeys,
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
