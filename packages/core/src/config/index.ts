// Public surface of overdraw's config types. The user's config file
// imports from here:
//
//   import type { OverdrawConfig } from "overdraw/config";
//   export default { focus: { ... }, hotkeys: { ... } } satisfies OverdrawConfig;
//
// Type-only re-exports today. Phase 7b adds runtime `ref` helpers for
// deferred-resolution refs in action params.

export type {
  OverdrawConfig, OutputConfig, PluginConfig, RestartPolicy, ConfigExport,
} from "./types.js";
