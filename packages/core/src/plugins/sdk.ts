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
import type { PluginAnimations } from "./animations-sdk.js";
import type { PluginCompose } from "./compose-sdk.js";
import type { PluginInput } from "./input-sdk.js";
import type { PluginTransitions } from "./transitions-sdk.js";
import type { CursorAPI } from "@overdraw/cursor-types";
import type { InterceptAPI } from "@overdraw/intercept-types";
import type {
  PluginActionsLike, PluginEventsLike, PluginWindowsLike, PluginInputLike,
  PluginComposeLike, PluginTransitionsLike, PluginGpuLike,
} from "@overdraw/plugin-sdk-types";

// Compile-time drift guard: each real SDK slice must satisfy the published
// plugin-facing shape in @overdraw/plugin-sdk-types (what plugins program
// against instead of importing core). A mismatch is a build error here, not
// a runtime surprise in a plugin.
type SatisfiesPublished<Shape, T extends Shape> = T;
export type _ActionsSatisfyPublished = SatisfiesPublished<PluginActionsLike, PluginActions>;
export type _EventsSatisfyPublished = SatisfiesPublished<PluginEventsLike, PluginEvents>;
export type _WindowsSatisfyPublished = SatisfiesPublished<PluginWindowsLike, PluginWindows>;
export type _InputSatisfiesPublished = SatisfiesPublished<PluginInputLike, PluginInput>;
export type _ComposeSatisfiesPublished = SatisfiesPublished<PluginComposeLike, PluginCompose>;
export type _TransitionsSatisfyPublished = SatisfiesPublished<PluginTransitionsLike, PluginTransitions>;
export type _GpuSatisfiesPublished = SatisfiesPublished<PluginGpuLike, PluginGpu>;

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
  // Declarative animation runner (core-plugin-api.md §9). Submits an
  // AnimationSpec; core evaluates per frame. Targets are core-owned
  // per-surface state (window-opacity / window-transform /
  // window-output-margin). Always present.
  animations: PluginAnimations;
  // Keyboard binding chain (core-plugin-api.md §4). Plugins register
  // chord bindings and named modes; the seat dispatches each key-down
  // through the chain before forwarding to the focused client. Always
  // present.
  input: PluginInput;
  // Decoration provider: register an app_id pattern + observe assigned windows.
  // No capability gate yet (this tier is meant to be gated like tier 3 -- it sees
  // every matched window's app_id/state -- but the capability system is unbuilt;
  // flagged). Always present in the current runtime.
  decorations?: PluginDecorations;
  // Scene compose primitive (core-plugin-api.md §6): render a window subset
  // into a fresh texture. Present iff the plugin runs in-thread (it returns
  // GPUTexture handles that only cross the boundary for in-thread plugins
  // sharing core's device). Phase 5b adds the Worker variant.
  compose?: PluginCompose;
  // Built-in transitions (core-plugin-api.md §8): blend two SceneHandles
  // on screen via a kind-specific shader. Present iff the runtime brought
  // up the transitions broker + evaluator (transition machinery is core,
  // not Worker, so the SDK shape is the same for both transports; the
  // implementation differs in how the commit callback is delivered).
  transitions?: PluginTransitions;
  // Cursor control (cursor-design.md): named shape installs, custom
  // textures (in-thread only), declarative shape-by-kinematic-state
  // rules, compositor default. Present iff the runtime brought up the
  // cursor broker + rule engine (always, when the JS compositor's
  // cursor slot is wired).
  cursor?: CursorAPI;
  // Buffer intercept (intercept-design.md, Phase 10a): per-pixel
  // intercept of matched client surfaces. Plugin registers with a
  // match predicate + setup callback; the SDK runs setup once,
  // dispatches render every visible frame on matched surfaces, and
  // composites the plugin's output in place of the client buffer.
  // 10a: in-thread bundled plugins work end-to-end; Worker plugins
  // get the same SDK shape but `register` throws "not yet supported"
  // until the cross-device transport lands.
  intercept?: InterceptAPI;
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
                          animations: PluginAnimations,
                          input: PluginInput,
                          gpu?: PluginGpu,
                          decorations?: PluginDecorations,
                          compose?: PluginCompose,
                          transitions?: PluginTransitions,
                          cursor?: CursorAPI,
                          intercept?: InterceptAPI): SdkControl {
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
    animations,
    input,
    ...(gpu ? { gpu } : {}),
    ...(decorations ? { decorations } : {}),
    ...(compose ? { compose } : {}),
    ...(transitions ? { transitions } : {}),
    ...(cursor ? { cursor } : {}),
    ...(intercept ? { intercept } : {}),
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
