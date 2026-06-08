// The plugin SDK object handed to init(sdk) (architecture.md "Plugin SDK
// surface"). Capabilities are enforced by the SHAPE of this object: a method
// the plugin's grant doesn't include is simply absent (no in-band check).
//
// Scope B is lifecycle-only: there is no GPU, window, surface, output, capture,
// input, or protocol surface yet. Those land with the GPU-backed plugin work.
// What exists: identity, logging, and onShutdown registration.

export type ShutdownCallback = () => void | Promise<void>;

import type { PluginGpu } from "./gpu.js";
import type { PluginWindows } from "./windows-sdk.js";
import type { PluginDecorations } from "./decorations.js";
import type { PluginEvents } from "./events.js";
import type {
  PluginNamespace, InitFn, RegisterOptions, RegistrationHandle, RegisteredApi,
} from "./namespace.js";
import type { PluginActions } from "./actions.js";

export interface PluginSdk {
  // The plugin's stable name (config `name`, defaulting to its module).
  readonly name: string;
  // Structured log from the plugin, tagged + forwarded to the core.
  log(...args: unknown[]): void;
  // Register a graceful-shutdown callback. Awaited (with a timeout) by the core
  // before the Worker is terminated. Forced shutdown (crash/watchdog) skips it.
  onShutdown(cb: ShutdownCallback): void;
  // Event bus (subscribe by pattern, emit by name). core-plugin-api.md §3.
  // Always present; no capability gate (the bus is the primary observation
  // mechanism for everything plugin-facing).
  events: PluginEvents;
  // Plugin namespace registry: claim a namespace ('workspace', 'layout', ...)
  // by exposing an API; or consume another plugin's namespace. Both shapes are
  // promoted to top-level for ergonomics so plugin authors don't write
  // `sdk.namespace.registerPlugin`. core-plugin-api.md §11.
  registerPlugin: <API extends RegisteredApi>(
    name: string, init: InitFn<API>, opts?: RegisterOptions
  ) => Promise<RegistrationHandle>;
  plugin: <API extends RegisteredApi>(name: string) => Promise<API>;
  // Action registry: named operations (core-plugin-api.md §10). Other
  // plugins, hotkeys, IPC clients all invoke through this single surface.
  actions: PluginActions;
  // GPU + overlay surfaces (present iff the plugin has the `gpu` capability and
  // the runtime brought the device up). Absent otherwise (capability by shape).
  gpu?: PluginGpu;
  // Window observation + mutation (core-plugin-api.md §1). Always present;
  // no capability gate yet (the observer half is privacy-sensitive but
  // capability gating is unbuilt).
  windows: PluginWindows;
  // Decoration provider: register an app_id pattern + observe assigned windows.
  // No capability gate yet (this tier is meant to be gated like tier 3 -- it sees
  // every matched window's app_id/state -- but the capability system is unbuilt;
  // flagged). Always present in the current runtime.
  decorations?: PluginDecorations;
}

// Internal handle the bootstrap uses to drive the SDK (run the shutdown cb, etc.)
// without exposing these controls on the plugin-facing object.
export interface SdkControl {
  sdk: PluginSdk;
  runShutdown(): Promise<void>;
}

export function createSdk(name: string, emitLog: (line: string) => void,
                          events: PluginEvents, ns: PluginNamespace,
                          actions: PluginActions, windows: PluginWindows,
                          gpu?: PluginGpu,
                          decorations?: PluginDecorations): SdkControl {
  let shutdownCb: ShutdownCallback | null = null;

  const sdk: PluginSdk = {
    name,
    log(...args: unknown[]): void {
      const line = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
      emitLog(line);
    },
    onShutdown(cb: ShutdownCallback): void {
      if (typeof cb !== "function") throw new TypeError("onShutdown expects a function");
      shutdownCb = cb;
    },
    events,
    registerPlugin: ns.registerPlugin,
    plugin: ns.plugin,
    actions,
    windows,
    ...(gpu ? { gpu } : {}),
    ...(decorations ? { decorations } : {}),
  };

  return {
    sdk,
    async runShutdown(): Promise<void> {
      if (shutdownCb) await shutdownCb();
    },
  };
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
