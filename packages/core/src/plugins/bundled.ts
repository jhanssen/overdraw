// Bundled plugins: hardcoded, in-thread, register at priority 0 (the floor
// of the namespace priority chain). The list is intentionally not
// auto-discovered -- any matching package in node_modules would otherwise
// auto-load.

import type { ResolvedPlugin, ResolvedConfig } from "../config/types.js";
import { OUTPUT_FALLBACK, FALLBACK_OUTPUT_NAME } from "../protocols/ctx.js";

// Runtime context passed to bundled-plugin configFrom callbacks. Bridges
// state that bundled plugins need at init time but that lives outside the
// user config (primarily: which outputs are already live by the time the
// plugin runtime spawns). Populated by main.ts from state.outputs after
// installProtocols runs and the boot OutputDescriptor burst has drained.
export interface BundledRuntimeContext {
  // Durable identifier of the boot primary output (edidId when non-empty,
  // else connector name). Always a non-empty string in the real path; tests
  // may pass empty when they don't model outputs (the workspace plugin
  // then falls back to its no-runtime-context defaults).
  bootOutputDurableKey: string;
  // Snapshot of every live output known at plugin-resolution time. Each
  // entry carries the connector name (e.g. "DP-1") AND the EDID-derived
  // durable id, both as raw strings (empty when not present), plus the
  // output's arrangement geometry (global logical position + size +
  // scale) so geometry-aware plugins (canvas world slots) can seed
  // without waiting for an output.changed. The workspace plugin computes
  // its durable key as edidId-when-non-empty-else-name AND keeps the
  // pair around so a user-supplied output string (typically the
  // connector name) can be resolved back to an outputId. The boot
  // OutputDescriptor burst that fires output.added happens BEFORE the
  // plugin runtime spawns, so the plugin can't observe those events via
  // subscribe -- this snapshot is the catch-up mechanism.
  initialOutputs: ReadonlyArray<{
    outputId: number; name: string; edidId: string;
    x?: number; y?: number; width?: number; height?: number; scale?: number;
  }>;
}

// Default keybindings when the user supplies no `hotkeys` config. Deliberately
// minimal: a terminal launcher and an exit. Everything else is left to the
// user to bind. A user `hotkeys` config replaces this wholesale (so they can
// rebind or clear these). Bindings reference actions from the bundled action
// plugins (spawn, compositor.quit).
const DEFAULT_HOTKEYS = {
  modes: {
    default: {
      bindings: [
        { keys: "Super+t", action: "spawn", params: { command: "kitty" } },
        { keys: "Super+x", action: "compositor.quit" },
      ],
    },
  },
};

export interface BundledPluginSpec {
  name: string;
  // Bare specifier (e.g. "@overdraw/plugin-layout-default") or absolute path.
  module: string;
  // Project the user's config + runtime context to this plugin's config
  // slice. Omit when the plugin takes no config. The runtime context is
  // populated from compositor state available at plugin-resolution time
  // (post-installProtocols, post-first-OutputDescriptor); bundled specs
  // that don't need it can ignore the second arg.
  configFrom?: (config: ResolvedConfig, runtime: BundledRuntimeContext) => unknown;
}

// The canvas workspace provider (docs/canvas-design.md). Selected in place
// of workspace-default when the user config carries a `canvas` slice; same
// namespace, same runtime context, plus the user's canvas config.
const CANVAS_PLUGIN: BundledPluginSpec = {
  name: "canvas",
  module: "@overdraw/plugin-canvas",
  configFrom: (config, runtime) => ({
    fallbackOutputId: OUTPUT_FALLBACK,
    fallbackOutputName: FALLBACK_OUTPUT_NAME,
    bootOutputDurableKey: runtime.bootOutputDurableKey,
    initialOutputs: runtime.initialOutputs,
    canvas: config.canvas,
    // The layout gap doubles as the strip scroll-reveal margin, so a
    // revealed column keeps its gap band visible at the viewport edge.
    layoutGap: (config.layout as { gap?: unknown } | undefined)?.gap,
    // The provider's default mode, for islands that declare none. The
    // mode picks which end of the member list a new window joins.
    layoutMode: (config.layout as { mode?: unknown } | undefined)?.mode,
  }),
};

// The bundled set for a given config: the static list, with the workspace
// provider swapped for the canvas plugin when the config opts in.
export function selectBundledPlugins(
  config: Pick<ResolvedConfig, "canvas">,
): ReadonlyArray<BundledPluginSpec> {
  if (config.canvas === undefined) return BUNDLED_PLUGINS;
  return BUNDLED_PLUGINS.map((spec) =>
    spec.name === "workspace-default" ? CANVAS_PLUGIN : spec);
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
    configFrom: (config) => config.layout,
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
    // The workspace plugin needs three things from the core context:
    //   - fallbackOutputId / fallbackOutputName: where to park workspaces
    //     when no real output survives (state.fallbackOutput sentinel);
    //   - bootOutputDurableKey: the durable identifier of the boot
    //     primary output, so reg.init can seed preferredOutputs with the
    //     real EDID-id / connector name from frame zero (no placeholder
    //     to rebind on the first hotplug -- preferredOutputs entries are
    //     never rewritten by design).
    // All three are passed as config rather than imported across packages
    // so the plugin stays free of core internals.
    configFrom: (_config, runtime) => ({
      fallbackOutputId: OUTPUT_FALLBACK,
      fallbackOutputName: FALLBACK_OUTPUT_NAME,
      bootOutputDurableKey: runtime.bootOutputDurableKey,
      initialOutputs: runtime.initialOutputs,
    }),
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
    // Window rules. In-thread (so predicate/apply lambdas in the user config
    // survive) and intercepts window.preconfigure, applying float / imperative
    // policy by appId/title regex BEFORE the window maps. Load order is
    // immaterial -- nothing else intercepts preconfigure, and the event fires
    // at runtime, long after every bundled plugin has registered.
    name: "window-rules",
    module: "@overdraw/plugin-window-rules",
    configFrom: (config) => config.windowRules,
  },
  {
    // Loads LAST so any action it might bind (compositor.quit,
    // workspace.show, user.*, etc.) is already registered. The hotkey
    // plugin never needs other plugins' namespaces at init time, but
    // its BINDINGS are unmeaningful until the corresponding action
    // exists.
    name: "hotkey-default",
    module: "@overdraw/plugin-hotkey-default",
    configFrom: (config) => config.hotkeys ?? DEFAULT_HOTKEYS,
  },
  {
    // Decoration provider. Loads after everything else; the broker only
    // assigns windows when a provider is registered AND a window matches,
    // so load order relative to other plugins doesn't matter beyond core
    // bring-up. Placed last to keep boot-error surface for missing GPU
    // dependencies isolated.
    name: "decoration-default",
    module: "@overdraw/plugin-decoration-default",
    configFrom: (config) => config.decoration,
  },
];

// Convert a spec to the runtime's ResolvedPlugin shape. The restart fields
// are irrelevant for in-thread bundled plugins (init failures are fatal,
// no respawn) and exist only for shape compatibility with the user-plugin
// path. `runtime` carries context that lives outside ResolvedConfig (e.g.
// the boot primary output's durable identifier for the workspace plugin).
export function bundledToResolved(
  spec: BundledPluginSpec,
  module: string,
  resolvedConfig?: ResolvedConfig,
  runtime?: BundledRuntimeContext,
): ResolvedPlugin {
  const raw = resolvedConfig && spec.configFrom
    ? spec.configFrom(resolvedConfig,
        runtime ?? { bootOutputDurableKey: "", initialOutputs: [] })
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
