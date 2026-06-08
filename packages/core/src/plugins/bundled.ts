// Bundled plugin loader. core-plugin-api.md "No-plugin-loaded fallback" /
// build-order.md phase 0b. Bundled plugins ship with overdraw and load on
// boot before user-config plugins. They register at priority 0 (the floor)
// unless they explicitly override via sdk.registerPlugin's opts.priority.
//
// The list is hardcoded -- explicit and editable in a release-level change.
// Dynamic discovery (looking for node_modules/@overdraw/plugin-*) is rejected
// as fragile (security concern: any matching package would auto-load).
//
// Currently empty: Phase 2 (layout extraction) introduces the first bundled
// plugin. The shape is here so that lands as a one-line addition to the
// BUNDLED_PLUGINS list.
//
// Bundled plugin entries are resolved at runtime: the module path is computed
// either as a bare specifier (resolved relative to the overdraw root via
// require.resolve) or as a filesystem path (for tests / dev installations).

import type { ResolvedPlugin } from "../config/types.js";

// One bundled plugin descriptor. Keep this small; bundled plugins are core's
// own code, so most settings (restart policy etc.) get defaults that match
// the "essential infrastructure" expectation.
export interface BundledPluginSpec {
  // The plugin's stable name (used in logs + namespace registry attribution).
  name: string;
  // Either a bare module specifier (e.g. "@overdraw/plugin-layout-master-stack")
  // or an absolute path. main.ts resolves and converts to a file:// URL.
  module: string;
}

// The canonical list of bundled plugins. Empty in Phase 0b. Phase 2 adds the
// layout plugin here.
export const BUNDLED_PLUGINS: ReadonlyArray<BundledPluginSpec> = [
  // Phase 2: { name: "layout-master-stack", module: "@overdraw/plugin-layout-master-stack" },
];

// Convert a bundled plugin spec to a ResolvedPlugin (the runtime's loading
// shape). The module string is whatever the caller resolved it to (file:// URL
// or bare specifier). Restart policy is "on-failure" with the normal budget;
// bundled plugins are core's own code so they shouldn't fail, but if they do
// the priority-chain fallback handles it (next-lower in the namespace, often
// nothing -- so a bundled-plugin failure manifests as a degraded system).
export function bundledToResolved(spec: BundledPluginSpec, module: string): ResolvedPlugin {
  return {
    module,
    name: spec.name,
    restart: "on-failure",
    maxRestarts: 3,
    windowSeconds: 60,
    bundled: true,
    raw: { module: spec.module, name: spec.name },
  };
}
