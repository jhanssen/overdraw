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
import type { DynamicBus, Subscription } from "../events/dynamic-bus.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The built bootstrap (this file lives in dist/plugins/ after tsc).
const BOOTSTRAP = join(__dirname, "bootstrap.js");

// Lifecycle states (architecture.md "Lifecycle").
export type PluginState =
  | "spawning"     // Worker created, awaiting init(sdk) to resolve
  | "live"         // init resolved; watchdog running; events flow
  | "shutting-down" // graceful onShutdown in progress
  | "failed";      // permanently failed (restart budget exhausted, or restart="never")

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
}

export const DEFAULT_OPTIONS: RuntimeOptions = {
  heapMb: 128,
  pingIntervalMs: 1000,
  maxMissedPongs: 3,
  shutdownTimeoutMs: 2000,
};

// A managed plugin: its config, current Worker generation, and lifecycle state.
class ManagedPlugin {
  readonly cfg: ResolvedPlugin;
  private opts: RuntimeOptions;
  private log: (msg: string) => void;

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

  // Plugin-owned bus subscriptions: the plugin's own subId -> the bus
  // Subscription handle. Released on Worker exit/terminate so a crashed plugin
  // leaves no lingering subscribers in the bus. The plugin mints the subIds
  // (its sdk.events.subscribe call uses a local counter); core stores them
  // verbatim and uses them as the discriminator on `events.dispatch` back to
  // the worker.
  private busSubs = new Map<number, Subscription>();

  // Resolves when the plugin first reaches `live` or `failed` (initial spawn).
  private firstSettle: { resolve: () => void } | null = null;
  readonly ready: Promise<void>;

  constructor(cfg: ResolvedPlugin, opts: RuntimeOptions) {
    this.cfg = cfg;
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.log(m));
    this.ready = new Promise<void>((resolve) => { this.firstSettle = { resolve }; });
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
    // Plugin->core requests (SDK GPU/surface brokering) delegate to onRequest.
    const onReq = this.opts.onRequest;
    if (onReq) {
      endpoint.handleRequests(async (method, params) =>
        (await onReq(this.cfg.name, method, params)) as import("./protocol.js").Json);
    }

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
    if (name === "events.subscribe") { this.onEventsSubscribe(data); return; }
    if (name === "events.unsubscribe") { this.onEventsUnsubscribe(data); return; }
    if (name === "events.emit") { this.onEventsEmit(data); return; }

    // Surface other plugin->core events (scope B: `log`) to the observer.
    this.opts.onEvent?.(this.cfg.name, name, data);
  }

  private onEventsSubscribe(data: unknown): void {
    const bus = this.opts.bus;
    if (!bus) return;  // no bus configured (scope-B tests): silently ignore
    if (!isSubscribePayload(data)) {
      this.log(`[plugin ${this.cfg.name}] events.subscribe: malformed payload; ignored`);
      return;
    }
    const { subId, pattern } = data;
    if (this.busSubs.has(subId)) {
      this.log(`[plugin ${this.cfg.name}] events.subscribe: duplicate subId ${subId}; ignored`);
      return;
    }
    let sub: Subscription;
    try {
      sub = bus.subscribe(pattern, (evName, payload) => {
        // Deliver to the worker as a one-way event. The endpoint may be null
        // mid-teardown; the emit() guard there is a no-op.
        this.endpoint?.emit("events.dispatch",
          { subId, name: evName, payload: payload as Json });
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[plugin ${this.cfg.name}] events.subscribe('${pattern}') rejected: ${msg}`);
      return;
    }
    this.busSubs.set(subId, sub);
  }

  private onEventsUnsubscribe(data: unknown): void {
    if (!isUnsubscribePayload(data)) {
      this.log(`[plugin ${this.cfg.name}] events.unsubscribe: malformed payload; ignored`);
      return;
    }
    const sub = this.busSubs.get(data.subId);
    if (!sub) return;       // unknown subId (late unsubscribe after teardown): ignore
    sub.off();
    this.busSubs.delete(data.subId);
  }

  private onEventsEmit(data: unknown): void {
    const bus = this.opts.bus;
    if (!bus) return;
    if (!isEmitPayload(data)) {
      this.log(`[plugin ${this.cfg.name}] events.emit: malformed payload; ignored`);
      return;
    }
    try {
      bus.emit(data.name, data.payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[plugin ${this.cfg.name}] events.emit('${data.name}') rejected: ${msg}`);
    }
  }

  // Release all bus subscriptions this plugin holds. Called on Worker exit
  // (crash, terminate, graceful) so a dead plugin leaves no lingering
  // bus subscribers (which would otherwise try to emit to a closed endpoint).
  private releaseBusSubs(): void {
    for (const sub of this.busSubs.values()) sub.off();
    this.busSubs.clear();
  }

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

// The registry: owns all managed plugins.
export class PluginRuntime {
  private plugins: ManagedPlugin[] = [];
  private opts: RuntimeOptions;

  constructor(opts: Partial<RuntimeOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  // Spawn every configured plugin and await each one's first settle (live or
  // failed). Returns the managed handles (for introspection / tests).
  async load(configs: readonly ResolvedPlugin[]): Promise<void> {
    for (const cfg of configs) {
      const p = new ManagedPlugin(cfg, this.opts);
      this.plugins.push(p);
      p.spawn();
    }
    await Promise.all(this.plugins.map((p) => p.ready));
  }

  // Graceful shutdown of all plugins (parallel).
  async stop(): Promise<void> {
    await Promise.all(this.plugins.map((p) => p.stop()));
  }

  // Push a one-way event to one plugin by name (core -> plugin). No-op if no such
  // plugin or it is not `live`. Used by point-to-point flows like decoration
  // assignment; broad event delivery goes through the dynamic bus instead.
  emit(pluginName: string, name: string, data: Json): void {
    for (const p of this.plugins) {
      if (p.cfg.name === pluginName) { p.emit(name, data); return; }
    }
  }

  // Introspection.
  states(): Array<{ name: string; state: PluginState; restarts: number }> {
    return this.plugins.map((p) => ({
      name: p.cfg.name, state: p.currentState, restarts: p.restartCount,
    }));
  }
}

// Payload guards for the events.* reserved one-way events. The worker is
// trusted (it's our bootstrap.ts) but malformed messages should be logged and
// dropped rather than corrupt the bus.

function isSubscribePayload(d: unknown): d is { subId: number; pattern: string } {
  return typeof d === "object" && d !== null
    && typeof (d as { subId?: unknown }).subId === "number"
    && typeof (d as { pattern?: unknown }).pattern === "string";
}

function isUnsubscribePayload(d: unknown): d is { subId: number } {
  return typeof d === "object" && d !== null
    && typeof (d as { subId?: unknown }).subId === "number";
}

function isEmitPayload(d: unknown): d is { name: string; payload: Json } {
  return typeof d === "object" && d !== null
    && typeof (d as { name?: unknown }).name === "string"
    && "payload" in (d as object);
}
