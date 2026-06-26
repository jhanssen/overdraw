// In-thread plugin host for bundled plugins. Runs init on the main thread
// over a paired in-memory Channel; the loader is shared with the Worker
// path. Implements PluginHandle so the runtime can hold both transports in
// one list.
//
// No watchdog: liveness is co-extensive with the core's event loop. No
// restart: init throws are fatal startup errors; per-call exceptions catch
// at the Endpoint boundary and the plugin stays registered. stop() awaits
// the plugin's onShutdown then drops the endpoint.

import { Endpoint } from "./protocol.js";
import { createChannelPair } from "./pair-channel.js";
import type { Channel, Json } from "./protocol.js";
import type { DynamicBus } from "../events/dynamic-bus.js";
import type { ResolvedPlugin } from "../config/types.js";
import { runLoader } from "./loader.js";
import type { InThreadGpuDeps } from "./inthread-gpu.js";
import type { PluginController, PluginHandle, PluginState } from "./plugin-host.js";
import { makePluginRequestHandler, dispatchHostRegistryEvent } from "./plugin-host.js";
import { BusBridge } from "./bus-bridge.js";
import { log } from "../log.js";

export interface InThreadOptions {
  log?: (msg: string) => void;
  onEvent?: (pluginName: string, name: string, data: unknown) => void;
  onRequest?: (pluginName: string, method: string, params: unknown) => Promise<unknown> | unknown;
  bus?: DynamicBus;
  shutdownTimeoutMs: number;
  // Core-device GPU bundle. When set, the in-thread plugin gets a working
  // sdk.gpu whose .device IS core's GPUDevice and whose .createOverlay
  // allocates same-device GPUTextures. Omitting it (GPU-free unit tests,
  // headless harnesses with no compositor) leaves sdk.gpu absent -- the
  // SDK construction in loader.ts skips both GPU and decorations when the
  // bundle is missing.
  inThreadGpu?: InThreadGpuDeps;
  // Live outputId snapshot accessor. Used by sdk.compose to validate
  // outputId args; the closure reads state.outputs in the host so a freshly-
  // added monitor is immediately visible. Unset -> sdk.compose rejects every
  // outputId (test fixtures with no real outputs).
  liveOutputIds?: () => number[];
}

export class InThreadPlugin implements PluginHandle {
  readonly cfg: ResolvedPlugin;
  private opts: InThreadOptions;
  private log: (msg: string) => void;
  private ns: PluginController;

  state: PluginState = "spawning";
  private endpoint: Endpoint | null = null;
  private firstSettle: { resolve: () => void } | null = null;
  readonly ready: Promise<void>;

  // events.* surface is delegated to a BusBridge so the Worker-backed host
  // (runtime.ts) and the in-thread host stay in lockstep. The bridge reads
  // pluginName/bus/endpoint/log freshly each dispatch via the host adapter
  // below (getter shape so endpoint reflects the current value, not the
  // value at construction time).
  private bridge: BusBridge;

  constructor(cfg: ResolvedPlugin, opts: InThreadOptions, ns: PluginController) {
    this.cfg = cfg;
    this.opts = opts;
    this.ns = ns;
    this.log = opts.log ?? ((m) => log.info("plugin", m));
    this.ready = new Promise<void>((resolve) => { this.firstSettle = { resolve }; });
    const self = this;
    this.bridge = new BusBridge({
      get pluginName() { return self.cfg.name; },
      get bus() { return self.opts.bus; },
      get endpoint() { return self.endpoint; },
      log: (m) => self.log(m),
    });
  }

  endpointHandle(): Endpoint | null {
    return this.state === "live" ? this.endpoint : null;
  }

  private settleFirst(): void {
    if (this.firstSettle) { this.firstSettle.resolve(); this.firstSettle = null; }
  }

  // Kicks off the loader; returns synchronously. Init completion arrives
  // via the loader's 'init' event (onPluginEvent below).
  spawn(): void {
    this.state = "spawning";
    const pair = createChannelPair();
    this.wireCoreEndpoint(pair.a);
    // In-thread plugins read live outputIds directly (no Worker postMessage
    // boundary), so hasOutput reflects state.outputs in real time -- not a
    // spawn-time snapshot like the Worker path. opts.liveOutputIds() returns
    // a fresh array; the closure reads it on each compose-SDK call.
    const liveOutputIds = this.opts.liveOutputIds;
    void runLoader(pair.b, {
      module: this.cfg.module,
      name: this.cfg.name,
      config: this.cfg.raw,
      inThreadGpu: this.opts.inThreadGpu,
      hasOutput: liveOutputIds
        ? (id) => liveOutputIds().includes(id)
        : () => false,
    }).catch((err: unknown) => {
      // runLoader converts init errors into the 'init' event; a reject
      // here means something more fundamental failed (channel setup, SDK
      // construction). Treat as a fatal startup error.
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[plugin ${this.cfg.name}] loader fatal: ${msg}`);
      this.state = "failed";
      this.settleFirst();
    });
  }

  private wireCoreEndpoint(channel: Channel): void {
    const endpoint = new Endpoint(channel);
    this.endpoint = endpoint;
    endpoint.handleEvents((name, data) => { this.onPluginEvent(name, data); });

    endpoint.handleRequests(
      makePluginRequestHandler(this.ns, this.cfg.name, this.opts.onRequest));
  }

  private onPluginEvent(name: string, data: unknown): void {
    if (name === "init") {
      const d = data as { ok: boolean; error?: string };
      if (d.ok) {
        this.state = "live";
        this.log(`[plugin ${this.cfg.name}] live (in-thread)`);
        this.settleFirst();
      } else {
        this.log(`[plugin ${this.cfg.name}] init failed: ${d.error ?? "unknown"}`);
        this.state = "failed";
        this.ns.registry().unregisterAllFor(this.cfg.name);
        this.ns.actions().unregisterAllFor(this.cfg.name);
        this.releaseBusSubs();
        this.endpoint?.close(`plugin ${this.cfg.name} init failed`);
        this.endpoint = null;
        this.settleFirst();
      }
      return;
    }

    if (dispatchHostRegistryEvent(this.ns, this.cfg.name, this.bridge, name, data)) return;

    this.opts.onEvent?.(this.cfg.name, name, data);
  }

  private releaseBusSubs(): void { this.bridge.release(); }

  async stop(): Promise<void> {
    if (!this.endpoint || this.state === "failed") {
      this.releaseBusSubs();
      this.ns.registry().unregisterAllFor(this.cfg.name);
      this.ns.actions().unregisterAllFor(this.cfg.name);
      this.state = "failed";
      this.settleFirst();
      return;
    }
    this.state = "shutting-down";
    const ep = this.endpoint;
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.opts.shutdownTimeoutMs);
      t.unref?.();
    });
    try {
      await Promise.race([ep.request("shutdown"), timeout]);
    } catch { /* onShutdown threw; carry on */ }
    this.releaseBusSubs();
    this.ns.registry().unregisterAllFor(this.cfg.name);
    this.ns.actions().unregisterAllFor(this.cfg.name);
    ep.close(`plugin ${this.cfg.name} stopped`);
    this.endpoint = null;
    this.state = "failed";
    this.settleFirst();
  }

  emit(name: string, data: Json): void {
    if (this.state !== "live") return;
    this.endpoint?.emit(name, data);
  }

  get currentState(): PluginState { return this.state; }
  get restartCount(): number { return 0; }
}
