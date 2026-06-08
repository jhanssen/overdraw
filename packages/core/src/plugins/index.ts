// Plugin runtime public entry.
//
// Scope B: worker isolation, lifecycle, watchdog, and restart policy. No GPU,
// window, surface, output, capture, input, or protocol SDK yet (docs/status.md).

export { PluginRuntime, DEFAULT_OPTIONS } from "./runtime.js";
export type { PluginState, RuntimeOptions } from "./runtime.js";
export type { PluginSdk, ShutdownCallback } from "./sdk.js";
