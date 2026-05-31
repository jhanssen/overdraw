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
  // Sink for diagnostics (defaults to console). Lets tests capture/quiet logs.
  log?: (msg: string) => void;
  // Observe plugin->core events (name, data, plugin name). In scope B the only
  // plugin-originated event is `log`. Used by main.ts (print) and tests (assert).
  onEvent?: (pluginName: string, name: string, data: unknown) => void;
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
      workerData: { module: this.cfg.module, name: this.cfg.name },
      resourceLimits: { maxOldGenerationSizeMb: this.opts.heapMb },
    });
    this.worker = worker;

    // Endpoint over the Worker handle (adapted to a typed Channel; no cast).
    const endpoint = new Endpoint(channelFor(worker));
    this.endpoint = endpoint;
    endpoint.handlePongs(() => { this.missed = 0; });
    endpoint.handleEvents((name, data) => { this.onPluginEvent(name, data); });

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
    // Surface other plugin->core events (scope B: `log`) to the observer.
    this.opts.onEvent?.(this.cfg.name, name, data);
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
    if (!this.worker || !this.endpoint) { this.state = "failed"; return; }
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

  // Introspection.
  states(): Array<{ name: string; state: PluginState; restarts: number }> {
    return this.plugins.map((p) => ({
      name: p.cfg.name, state: p.currentState, restarts: p.restartCount,
    }));
  }
}
