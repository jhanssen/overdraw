// Plugin runtime: one Worker per configured plugin, with lifecycle, watchdog,
// and restart policy (architecture.md "Plugin model" / "Lifecycle" /
// "Restart policy" / "Isolation"). Scope B: no GPU, no window/surface SDK.
//
// Each plugin runs in its own worker_threads Worker (its own V8 isolate + event
// loop). The core's main thread owns the Worker handle, the Endpoint over it,
// the watchdog, and the restart bookkeeping. Failures are contained at the
// Worker boundary:
//   - init reject / runtime JS exception      -> reported by the bootstrap; failure
//   - OOM past the heap cap                    -> Worker aborts; 'error'/'exit'
//   - hot loop / synchronous block             -> watchdog: missed pongs -> terminate()
// All paths funnel to onExit, which applies the restart policy.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { ResolvedPlugin } from "../config/types.js";
import { Endpoint, channelFor } from "./protocol.js";
import type { Json } from "./protocol.js";
import type { DynamicBus } from "../events/dynamic-bus.js";
import { NamespaceRegistry } from "./namespace-registry.js";
import type { Registration } from "./namespace-registry.js";
import { ActionRegistry } from "./action-registry.js";
import { InThreadPlugin } from "./inthread-plugin.js";
import type { InThreadGpuDeps } from "./inthread-gpu.js";
import type { PluginController, PluginHandle, PluginState } from "./plugin-host.js";
import { BusBridge } from "./bus-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The built bootstrap (this file lives in dist/plugins/ after tsc).
const BOOTSTRAP = join(__dirname, "bootstrap.js");

// Lifecycle states are shared with the in-thread bundled-plugin transport.
// See plugin-host.ts.
export type { PluginState } from "./plugin-host.js";

// Tunables (injectable for fast tests). Defaults match architecture.md intent.
export interface RuntimeOptions {
  // Per-Worker heap cap, MiB (Worker resourceLimits.maxOldGenerationSizeMb).
  heapMb: number;
  // Watchdog ping interval, ms.
  pingIntervalMs: number;
  // Consecutive missed pongs before terminate().
  maxMissedPongs: number;
  // Graceful-shutdown onShutdown timeout, ms (architecture.md: 2s).
  shutdownTimeoutMs: number;
  // Override the bootstrap entry (tests point at a fixture-aware bootstrap if needed).
  bootstrapPath?: string;
  // Absolute paths to the plugin Worker addon + dawn.node. When set (and the
  // plugin has the gpu capability), the bootstrap brings up the plugin device
  // before init and sdk.gpu is available. main.ts provides these.
  pluginAddonPath?: string;
  dawnPath?: string;
  // Core-device GPU bundle for in-thread bundled plugins. When set, sdk.gpu
  // for bundled plugins shares core's GPUDevice; createOverlay allocates same-
  // device textures (no wire client, no cross-device fences). main.ts builds
  // it from the core compositor / overlay broker / dawn.node device. Tests
  // that don't need bundled-plugin GPU access omit it.
  inThreadGpu?: InThreadGpuDeps;
  // Sink for diagnostics (defaults to console). Lets tests capture/quiet logs.
  log?: (msg: string) => void;
  // Observe plugin->core events (name, data, plugin name). In scope B the only
  // plugin-originated event is `log`. Used by main.ts (print) and tests (assert).
  onEvent?: (pluginName: string, name: string, data: unknown) => void;
  // Handle plugin->core REQUESTS (the SDK's GPU/surface brokering: gpu.connect,
  // gpu.injectInstance, surface.alloc, surface.present, ...). The resolved value
  // is the response. main.ts provides this (it has the addon + compositor +
  // overlay broker); scope-B tests omit it. `pluginName` identifies the caller.
  onRequest?: (pluginName: string, method: string, params: unknown) => Promise<unknown> | unknown;
  // The dynamic event bus (core-plugin-api.md §3). When set, plugins can
  // subscribe to events via sdk.events.subscribe (routed to bus.subscribe) and
  // emit events via sdk.events.emit (routed to bus.emit). When unset (scope-B
  // tests with no bus), the SDK still exists but subscribe/emit are no-ops.
  bus?: DynamicBus;
  // Deferred-reference resolver for action params (Phase 7b). When set,
  // sdk.actions.invoke walks the params payload at invoke time and
  // substitutes every { $ref: name } sentinel with the resolver's
  // current value for `name`. main.ts populates the resolver map from
  // core state (seat, wm, workspace plugin). Tests stub it. When unset,
  // params pass through unchanged.
  resolveDeferredRefs?: (params: unknown) => unknown;
}

export const DEFAULT_OPTIONS: RuntimeOptions = {
  heapMb: 128,
  pingIntervalMs: 1000,
  maxMissedPongs: 3,
  shutdownTimeoutMs: 2000,
};

// A managed plugin: its config, current Worker generation, and lifecycle state.
class ManagedPlugin implements PluginHandle {
  readonly cfg: ResolvedPlugin;
  private opts: RuntimeOptions;
  private log: (msg: string) => void;
  private ns: PluginController;

  state: PluginState = "spawning";
  private worker: Worker | null = null;
  private endpoint: Endpoint | null = null;

  // Watchdog: outstanding pings not yet ponged. Reset to 0 on each pong.
  private pingTimer: NodeJS.Timeout | null = null;
  private pingSeq = 0;
  private missed = 0;

  // Restart bookkeeping: timestamps (ms) of restarts within the rolling window.
  private restartTimes: number[] = [];
  // True once intentionally stopped (stop()); suppresses restart on exit.
  private stopping = false;
  // Set while a forced terminate() is in flight so onExit knows it was a kill.
  private terminating = false;

  // The events.* SDK surface is delegated to a BusBridge so the in-thread
  // host (inthread-plugin.ts) and this Worker-backed host stay in lockstep.
  // The bridge owns the per-plugin Subscription maps and releases them on
  // Worker exit/terminate so a crashed plugin leaves no lingering
  // subscribers in the bus. It reads pluginName/bus/endpoint/log freshly
  // each dispatch via the host adapter (getter shape) below, so endpoint
  // reflects the current value rather than the value at construction time.
  private bridge: BusBridge;

  // Resolves when the plugin first reaches `live` or `failed` (initial spawn).
  private firstSettle: { resolve: () => void } | null = null;
  readonly ready: Promise<void>;

  constructor(cfg: ResolvedPlugin, opts: RuntimeOptions, ns: PluginController) {
    this.cfg = cfg;
    this.opts = opts;
    this.ns = ns;
    this.log = opts.log ?? ((m) => console.log(m));
    this.ready = new Promise<void>((resolve) => { this.firstSettle = { resolve }; });
    const self = this;
    this.bridge = new BusBridge({
      get pluginName() { return self.cfg.name; },
      get bus() { return self.opts.bus; },
      get endpoint() { return self.endpoint; },
      log: (m) => self.log(m),
    });
  }

  // Expose the endpoint so the runtime can send plugin.handle requests
  // (cross-plugin invocations) to this plugin's worker. Returns null when the
  // plugin is not live.
  endpointHandle(): Endpoint | null {
    return this.state === "live" ? this.endpoint : null;
  }

  private settleFirst(): void {
    if (this.firstSettle) { this.firstSettle.resolve(); this.firstSettle = null; }
  }

  // Spawn (or respawn) the Worker and await init.
  spawn(): void {
    this.state = "spawning";
    this.terminating = false;
    this.missed = 0;
    const bootstrap = this.opts.bootstrapPath ?? BOOTSTRAP;
    const worker = new Worker(bootstrap, {
      workerData: {
        module: this.cfg.module, name: this.cfg.name,
        // Verbatim per-plugin config; plugin's init(sdk, config?) consumes
        // it. Plugins that take no config ignore the second arg.
        config: this.cfg.raw,
        pluginAddonPath: this.opts.pluginAddonPath, dawnPath: this.opts.dawnPath,
      },
      resourceLimits: { maxOldGenerationSizeMb: this.opts.heapMb },
    });
    this.worker = worker;

    // Endpoint over the Worker handle (adapted to a typed Channel; no cast).
    const endpoint = new Endpoint(channelFor(worker));
    this.endpoint = endpoint;
    endpoint.handlePongs(() => { this.missed = 0; });
    endpoint.handleEvents((name, data) => { this.onPluginEvent(name, data); });
    // Plugin->core requests: try namespace + action plumbing first, then
    // fall back to onRequest (gpu/decoration brokers).
    const onReq = this.opts.onRequest;
    endpoint.handleRequests(async (method, params): Promise<Json> => {
      if (method === "plugin.invoke") {
        return await this.ns.onInvoke(this.cfg.name, params);
      }
      if (method === "plugin.wait-for-active") {
        return await this.ns.onWaitForActive(this.cfg.name, params);
      }
      if (method === "actions.invoke") {
        return await this.ns.onActionInvoke(this.cfg.name, params);
      }
      if (method === "actions.list") {
        return await this.ns.onActionList(this.cfg.name, params);
      }
      if (onReq) {
        return (await onReq(this.cfg.name, method, params)) as Json;
      }
      throw new Error(`no handler for request '${method}'`);
    });

    // The bootstrap posts {kind:'event', name:'init'} with {ok:true} or
    // {ok:false, error}. That is the init-resolve/reject signal.
    worker.on("error", (err) => { this.onWorkerError(err); });
    worker.on("exit", (code) => { this.onExit(code); });
  }

  private onPluginEvent(name: string, data: unknown): void {
    if (name === "init") {
      const d = data as { ok: boolean; error?: string };
      if (d.ok) {
        this.state = "live";
        this.startWatchdog();
        this.log(`[plugin ${this.cfg.name}] live`);
        this.settleFirst();   // reached a terminal-for-spawn state (live)
      } else {
        this.log(`[plugin ${this.cfg.name}] init failed: ${d.error ?? "unknown"}`);
        // Init failure counts toward the restart budget (architecture.md). Mark
        // it a non-graceful exit and terminate; onExit applies the restart policy
        // and settles `ready` with the terminal state (failed) or respawns. Do
        // NOT settle here -- state isn't terminal until onExit decides.
        this.terminating = true;
        void this.worker?.terminate();
      }
      return;
    }

    // SDK event-bus interactions are reserved one-way events; intercept before
    // surfacing to onEvent. core-plugin-api.md §3.
    if (this.bridge.handle(name, data)) return;

    // Namespace registry interactions (sdk.registerPlugin / unregister).
    // core-plugin-api.md §11.
    if (name === "plugin.register") { this.ns.onRegister(this.cfg.name, data); return; }
    if (name === "plugin.unregister") { this.ns.onUnregister(this.cfg.name, data); return; }

    // Action registry interactions (sdk.actions.register / unregister).
    // core-plugin-api.md §10.
    if (name === "actions.register") { this.ns.onActionRegister(this.cfg.name, data); return; }
    if (name === "actions.unregister") { this.ns.onActionUnregister(this.cfg.name, data); return; }

    // Surface other plugin->core events (scope B: `log`) to the observer.
    this.opts.onEvent?.(this.cfg.name, name, data);
  }

  private releaseBusSubs(): void { this.bridge.release(); }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.pingTimer = setInterval(() => {
      if (this.state !== "live") return;
      // If the previous ping(s) went unanswered, count a miss.
      this.missed++;
      if (this.missed > this.opts.maxMissedPongs) {
        this.log(`[plugin ${this.cfg.name}] unresponsive (${this.missed - 1} missed pongs); terminating`);
        this.forceTerminate();
        return;
      }
      this.endpoint?.ping(++this.pingSeq);
    }, this.opts.pingIntervalMs);
    // Don't let the watchdog timer keep the process alive on its own.
    this.pingTimer.unref?.();
  }

  private stopWatchdog(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private forceTerminate(): void {
    this.stopWatchdog();
    this.terminating = true;
    this.releaseBusSubs();
    this.ns.registry().unregisterAllFor(this.cfg.name);
    this.ns.actions().unregisterAllFor(this.cfg.name);
    this.endpoint?.close(`plugin ${this.cfg.name} terminated`);
    void this.worker?.terminate();
  }

  private onWorkerError(err: Error): void {
    // Uncaught throw on the Worker thread (incl. resourceLimits OOM surfaces here
    // on some Node versions). Treat as a crash; 'exit' follows and drives restart.
    this.log(`[plugin ${this.cfg.name}] worker error: ${err.message}`);
  }

  private onExit(code: number): void {
    this.stopWatchdog();
    this.releaseBusSubs();
    this.ns.registry().unregisterAllFor(this.cfg.name);
    this.ns.actions().unregisterAllFor(this.cfg.name);
    this.endpoint?.close(`plugin ${this.cfg.name} exited (code ${code})`);
    this.endpoint = null;
    this.worker = null;

    if (this.stopping) { this.state = "failed"; this.settleFirst(); return; }

    const crashed = this.terminating || code !== 0;
    if (!crashed && this.state === "shutting-down") {
      // Clean graceful exit; nothing to restart.
      this.state = "failed";
      this.settleFirst();
      return;
    }

    // Crash / forced termination / init failure: apply restart policy.
    if (this.cfg.restart === "never") {
      this.state = "failed";
      this.log(`[plugin ${this.cfg.name}] failed; restart="never"`);
      this.settleFirst();
      return;
    }

    const now = Date.now();
    const windowMs = this.cfg.windowSeconds * 1000;
    this.restartTimes = this.restartTimes.filter((t) => now - t < windowMs);
    if (this.restartTimes.length >= this.cfg.maxRestarts) {
      this.state = "failed";
      this.log(`[plugin ${this.cfg.name}] permanently failed: ${this.restartTimes.length} restarts in ${this.cfg.windowSeconds}s`);
      this.settleFirst();
      return;
    }
    this.restartTimes.push(now);
    this.log(`[plugin ${this.cfg.name}] restarting (${this.restartTimes.length}/${this.cfg.maxRestarts} in window)`);
    this.spawn();
  }

  // Graceful shutdown: ask the plugin to run onShutdown, await up to the timeout,
  // then terminate. Forced shutdown (watchdog/crash) never reaches here.
  async stop(): Promise<void> {
    this.stopping = true;
    this.stopWatchdog();
    if (!this.worker || !this.endpoint) {
      this.releaseBusSubs();
      this.ns.registry().unregisterAllFor(this.cfg.name);
      this.ns.actions().unregisterAllFor(this.cfg.name);
      this.state = "failed"; return;
    }
    this.state = "shutting-down";
    const ep = this.endpoint;
    const worker = this.worker;
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.opts.shutdownTimeoutMs);
      t.unref?.();
    });
    try {
      await Promise.race([ep.request("shutdown"), timeout]);
    } catch { /* plugin onShutdown threw; terminate anyway */ }
    await worker.terminate();
    this.state = "failed";
  }

  // Push a one-way event to this plugin's Worker (core -> plugin). No-op unless
  // the plugin is `live` (the Worker's event-loop is up and dispatching). Used for
  // the window-state stream (onMap/onUnmap) and any future core-originated event.
  emit(name: string, data: Json): void {
    if (this.state !== "live") return;
    this.endpoint?.emit(name, data);
  }

  // Test/introspection accessors.
  get currentState(): PluginState { return this.state; }
  get restartCount(): number { return this.restartTimes.length; }
}

// The registry: owns all managed plugins (Worker-mode + in-thread bundled).
export class PluginRuntime implements PluginController {
  private plugins: PluginHandle[] = [];
  private opts: RuntimeOptions;
  // Plugin namespace registry (sdk.registerPlugin / sdk.plugin). Shared
  // across all managed plugins; the runtime is the controller.
  private nsRegistry = new NamespaceRegistry();
  // Action registry (sdk.actions.register / invoke / list). Also shared.
  private actionRegistry = new ActionRegistry();
  // Pending `plugin.wait-for-active` waiters, keyed by namespace. Each
  // waiter's promise resolves when the registry's active winner appears (or
  // rejects on timeout / when the waiting plugin dies).
  private waiters = new Map<string, Set<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }>>();

  constructor(opts: Partial<RuntimeOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    // Resolve namespace waiters whenever the active winner appears.
    this.nsRegistry.onActiveChange((ns, _prev, next) => {
      if (!next) return;   // active became null; don't resolve waiters
      const set = this.waiters.get(ns);
      if (!set) return;
      for (const w of set) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve();
      }
      set.clear();
    });
  }

  // Spawn every configured plugin and await each one's first settle (live
  // or failed). cfg.bundled selects the transport: in-thread for bundled,
  // Worker for user plugins.
  async load(configs: readonly ResolvedPlugin[]): Promise<void> {
    for (const cfg of configs) {
      let p: PluginHandle;
      if (cfg.bundled) {
        const itp = new InThreadPlugin(cfg, {
          log: this.opts.log,
          onEvent: this.opts.onEvent,
          onRequest: this.opts.onRequest,
          bus: this.opts.bus,
          shutdownTimeoutMs: this.opts.shutdownTimeoutMs,
          inThreadGpu: this.opts.inThreadGpu,
        }, this);
        itp.spawn();
        p = itp;
      } else {
        const mp = new ManagedPlugin(cfg, this.opts, this);
        mp.spawn();
        p = mp;
      }
      this.plugins.push(p);
    }
    await Promise.all(this.plugins.map((p) => p.ready));
  }

  // Graceful shutdown of all plugins (parallel).
  async stop(): Promise<void> {
    await Promise.all(this.plugins.map((p) => p.stop()));
  }

  // Graceful shutdown of one plugin by name. Used by tests for failover
  // scenarios; the main launcher uses rt.stop() (whole-runtime teardown).
  // No-op if no such plugin or it isn't running.
  async stopByName(pluginName: string): Promise<void> {
    const p = this.plugins.find((x) => x.cfg.name === pluginName);
    if (p) await p.stop();
  }

  // Push a one-way event to one plugin by name (core -> plugin). No-op if no such
  // plugin or it is not `live`. Used by point-to-point flows like decoration
  // assignment; broad event delivery goes through the dynamic bus instead.
  emit(pluginName: string, name: string, data: Json): void {
    for (const p of this.plugins) {
      if (p.cfg.name === pluginName) { p.emit(name, data); return; }
    }
  }

  // Drain in-flight plugin work to a quiescent point. Tests call this after
  // triggering a state change (an emit on the bus, a synthetic input event)
  // and before asserting on plugin-observed state, so the assertion is not
  // racing the dispatch -> plugin -> broker -> reply chain.
  //
  // Quiescent = no plugin endpoint has any pending outbound request, across
  // a small number of microtask + macrotask hops. The implementation polls
  // pendingCount() across all plugins; once it's zero for two consecutive
  // rounds, the chain has fully settled (one round of zero is not enough --
  // a plugin can fire a follow-up request inside its reply handler).
  //
  // Bounded: gives up after `maxRounds` and returns; tests that rely on
  // flush() should still assert with a timeout so a stuck plugin produces a
  // diagnostic rather than a silent pass.
  async flush(maxRounds: number = 50): Promise<void> {
    let consecutiveQuiet = 0;
    for (let i = 0; i < maxRounds; i++) {
      // Macrotask hop: lets timers (setTimeout 0), I/O, and microtasks run.
      await new Promise<void>((r) => setImmediate(r));
      // Microtask hop: drains promise reactions enqueued by the macrotask.
      await Promise.resolve();
      let pending = 0;
      for (const p of this.plugins) {
        const ep = p.endpointHandle();
        if (ep) pending += ep.pendingCount();
      }
      if (pending === 0) {
        consecutiveQuiet++;
        if (consecutiveQuiet >= 2) return;
      } else {
        consecutiveQuiet = 0;
      }
    }
  }

  // Introspection. `bundled` distinguishes in-thread (true) from Worker
  // (false); in-thread plugins always report restarts=0 because the
  // transport has no restart machinery (a consumer that sees restarts=0
  // can't otherwise tell "never had to" from "can't").
  states(): Array<{ name: string; state: PluginState; restarts: number; bundled: boolean }> {
    return this.plugins.map((p) => ({
      name: p.cfg.name, state: p.currentState, restarts: p.restartCount,
      bundled: p.cfg.bundled,
    }));
  }

  // External-caller API for invoking actions (IPC, in-process scripts). Same
  // routing as plugin-to-plugin invocation, but with a clean
  // (name, params) -> Promise<result> contract. Caller identity is "<external>"
  // for audit logs.
  invokeAction(name: string, params: Json): Promise<Json> {
    return this.onActionInvoke("<external>", { name, params });
  }

  // External-caller API for listing actions (IPC list-actions / overdrawctl).
  listActions(): Promise<Json> {
    return this.onActionList("<external>", null);
  }

  // External-caller API for invoking a method on the active plugin in a
  // namespace (core-plugin-api.md §11 + §13). Used by core-side drivers
  // (the layout driver, focus driver) that need to call into a plugin
  // without going through the worker SDK. Args are passed positionally;
  // returns the plugin's result.
  //
  // Rejects if no plugin claims the namespace OR the method is unregistered.
  // Caller may catch + handle (e.g. the layout driver leaves windows alone
  // when compute rejects).
  invokeNamespace(namespace: string, method: string, args: Json[]): Promise<Json> {
    return this.onInvoke("<external>", { namespace, method, args });
  }

  // External-caller API for awaiting a namespace registration. Resolves when
  // some plugin claims `namespace`; rejects on timeout. Used by core-side
  // drivers that need to wait for their plugin before the system can serve
  // requests (e.g. the layout driver waits for the 'layout' namespace
  // before the WM applies its first layout).
  waitForNamespace(namespace: string, timeoutMs: number = 5_000): Promise<void> {
    return this.onWaitForActive("<external>", { namespace, timeoutMs })
      .then(() => undefined);
  }

  // -- NamespaceController implementation --------------------------------
  // Implements core-plugin-api.md §11 routing. The registry stores who claims
  // what; this controller routes invocations across plugins and gates
  // wait-for-active on registrations.

  registry(): NamespaceRegistry { return this.nsRegistry; }

  onRegister(pluginName: string, payload: unknown): void {
    if (!isRegisterPayload(payload)) {
      this.opts.log?.(`[plugin ${pluginName}] plugin.register: malformed payload; ignored`);
      return;
    }
    const isBundled = !!this.cfgOf(pluginName)?.bundled;
    const priority = typeof payload.priority === "number"
      ? payload.priority
      : (isBundled ? 0 : 100);
    try {
      this.nsRegistry.register({
        pluginName, namespace: payload.namespace,
        priority, methods: new Set(payload.methods),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`[plugin ${pluginName}] plugin.register('${payload.namespace}') rejected: ${msg}`);
    }
  }

  onUnregister(pluginName: string, payload: unknown): void {
    if (!isUnregisterPayload(payload)) {
      this.opts.log?.(`[plugin ${pluginName}] plugin.unregister: malformed payload; ignored`);
      return;
    }
    this.nsRegistry.unregister(pluginName, payload.namespace);
  }

  async onInvoke(callerName: string, payload: unknown): Promise<Json> {
    if (!isInvokePayload(payload)) {
      throw new Error("plugin.invoke: malformed payload");
    }
    const active = this.nsRegistry.active(payload.namespace);
    if (!active) {
      throw new Error(`plugin.invoke: no active plugin for namespace '${payload.namespace}'`);
    }
    if (!active.methods.has(payload.method)) {
      throw new Error(
        `plugin.invoke: '${payload.namespace}.${payload.method}' not registered ` +
        `by '${active.pluginName}'`);
    }
    // The active plugin may be the caller itself. That's legal (a plugin can
    // call its own API), but it means we route back into the same worker via
    // the existing endpoint -- no special case needed.
    const target = this.plugins.find((p) => p.cfg.name === active.pluginName);
    const ep = target?.endpointHandle();
    if (!ep) {
      throw new Error(
        `plugin.invoke: active plugin '${active.pluginName}' for ` +
        `'${payload.namespace}' is not live`);
    }
    void callerName;
    return await ep.request("plugin.handle", {
      namespace: payload.namespace, method: payload.method, args: payload.args,
    });
  }

  onWaitForActive(callerName: string, payload: unknown): Promise<Json> {
    if (!isWaitForActivePayload(payload)) {
      return Promise.reject(new Error("plugin.wait-for-active: malformed payload"));
    }
    void callerName;
    if (this.nsRegistry.active(payload.namespace)) {
      return Promise.resolve(null);
    }
    return new Promise<Json>((resolve, reject) => {
      const set = this.waiters.get(payload.namespace) ?? new Set();
      const entry = {
        resolve: () => resolve(null),
        reject,
        timer: null as NodeJS.Timeout | null,
      };
      if (payload.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          set.delete(entry);
          reject(new Error(
            `plugin.wait-for-active('${payload.namespace}'): ` +
            `timed out after ${payload.timeoutMs}ms`));
        }, payload.timeoutMs);
        entry.timer.unref?.();
      }
      set.add(entry);
      this.waiters.set(payload.namespace, set);
    });
  }

  // -- Action controller (core-plugin-api.md §10) --

  actions(): ActionRegistry { return this.actionRegistry; }

  onActionRegister(pluginName: string, payload: unknown): void {
    if (!isActionRegisterPayload(payload)) {
      this.opts.log?.(`[plugin ${pluginName}] actions.register: malformed payload; ignored`);
      return;
    }
    try {
      this.actionRegistry.register({
        pluginName, name: payload.name,
        description: payload.description,
        schema: payload.schema,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.log?.(`[plugin ${pluginName}] actions.register('${payload.name}') rejected: ${msg}`);
    }
  }

  onActionUnregister(pluginName: string, payload: unknown): void {
    if (!isActionUnregisterPayload(payload)) {
      this.opts.log?.(`[plugin ${pluginName}] actions.unregister: malformed payload; ignored`);
      return;
    }
    this.actionRegistry.unregister(pluginName, payload.name);
  }

  async onActionInvoke(callerName: string, payload: unknown): Promise<Json> {
    if (!isActionInvokePayload(payload)) {
      throw new Error("actions.invoke: malformed payload");
    }
    const owner = this.actionRegistry.lookup(payload.name);
    if (!owner) {
      throw new Error(`actions.invoke: no such action '${payload.name}'`);
    }
    const target = this.plugins.find((p) => p.cfg.name === owner.pluginName);
    const ep = target?.endpointHandle();
    if (!ep) {
      throw new Error(
        `actions.invoke: owner '${owner.pluginName}' of '${payload.name}' is not live`);
    }
    void callerName;
    // Deferred-reference resolution (Phase 7b): if the launcher
    // provided a resolver, walk params and substitute every
    // { $ref: name } sentinel with its current value. When unset,
    // params pass through unchanged. The resolved value is cast back
    // to Json -- the resolver's outputs (numbers, strings, ids) are
    // structured-clone-safe.
    let params: Json = payload.params;
    if (this.opts.resolveDeferredRefs) {
      params = this.opts.resolveDeferredRefs(payload.params) as Json;
    }
    return await ep.request("actions.handle",
      { name: payload.name, params });
  }

  onActionList(callerName: string, _payload: unknown): Promise<Json> {
    void callerName;
    // ActionInfo[] is structured-clone-safe by construction: name and
    // description are strings; schema arrived via postMessage from a worker
    // (which already enforces clone-safety), so it survives a round trip
    // back. Json's type machinery doesn't model the optional fields cleanly,
    // hence the assertion.
    // eslint-disable-next-line no-restricted-syntax
    return Promise.resolve(this.actionRegistry.list() as unknown as Json);
  }

  private cfgOf(pluginName: string): ResolvedPlugin | undefined {
    return this.plugins.find((p) => p.cfg.name === pluginName)?.cfg;
  }
}

// Type guards for the action-event payloads.

function isActionRegisterPayload(d: unknown): d is { name: string; description?: string; schema?: unknown } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.name !== "string" || o.name.length === 0) return false;
  if (o.description !== undefined && typeof o.description !== "string") return false;
  return true;
}

function isActionUnregisterPayload(d: unknown): d is { name: string } {
  return typeof d === "object" && d !== null
    && typeof (d as { name?: unknown }).name === "string";
}

function isActionInvokePayload(d: unknown): d is { name: string; params: Json } {
  return typeof d === "object" && d !== null
    && typeof (d as { name?: unknown }).name === "string"
    && "params" in (d as object);
}

// Payload guards for namespace and action registrations (the events.*
// guards live with the BusBridge in bus-bridge.ts). The worker is trusted
// (it's our bootstrap.ts) but malformed messages should be logged and
// dropped rather than corrupt a registry.

function isRegisterPayload(d: unknown): d is { namespace: string; methods: string[]; priority?: number } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.namespace !== "string" || o.namespace.length === 0) return false;
  if (!Array.isArray(o.methods)) return false;
  if (!o.methods.every((m) => typeof m === "string")) return false;
  if (o.priority !== undefined && typeof o.priority !== "number") return false;
  return true;
}

function isUnregisterPayload(d: unknown): d is { namespace: string } {
  return typeof d === "object" && d !== null
    && typeof (d as { namespace?: unknown }).namespace === "string";
}

function isInvokePayload(d: unknown): d is { namespace: string; method: string; args: Json[] } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  return typeof o.namespace === "string"
    && typeof o.method === "string"
    && Array.isArray(o.args);
}

function isWaitForActivePayload(d: unknown): d is { namespace: string; timeoutMs: number } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  return typeof o.namespace === "string"
    && typeof o.timeoutMs === "number";
}
