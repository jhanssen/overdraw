// In-thread bundled plugin host. Mirrors ManagedPlugin's external shape but
// runs the plugin on the main thread instead of a worker_threads Worker.
//
// Used for bundled plugins (ResolvedPlugin.bundled === true) per the
// "Bundled plugins run in-thread" decision in core-plugin-api.md. The
// plugin's init runs on the main event loop; the SDK construction code in
// loader.ts is reused unchanged. The transport is a paired in-memory
// Channel: the loader's Endpoint talks on side B; the runtime's Endpoint
// talks on side A.
//
// Differences from ManagedPlugin (Worker-mode):
//   - No Worker is spawned. No watchdog ping/pong (liveness is co-extensive
//     with the core's event loop).
//   - No restart on failure: init throws are fatal startup errors (release-
//     blocking bug per core-plugin-api.md decided list); per-call exceptions
//     from registered namespace/action methods are caught at the Endpoint
//     boundary as today.
//   - stop() awaits the shutdown request, then drops the endpoints. No
//     terminate() is needed (no thread to kill).
//
// External contract: the same `PluginHandle` interface that ManagedPlugin
// implements, so PluginRuntime can hold both kinds in one list.

import { Endpoint } from "./protocol.js";
import { createChannelPair } from "./pair-channel.js";
import type { Channel, Json } from "./protocol.js";
import type { DynamicBus, Subscription } from "../events/dynamic-bus.js";
import type { ResolvedPlugin } from "../config/types.js";
import { runLoader } from "./loader.js";
import type { PluginController, PluginHandle, PluginState } from "./plugin-host.js";

export interface InThreadOptions {
  log?: (msg: string) => void;
  onEvent?: (pluginName: string, name: string, data: unknown) => void;
  onRequest?: (pluginName: string, method: string, params: unknown) => Promise<unknown> | unknown;
  bus?: DynamicBus;
  // shutdownTimeoutMs only governs the await on the plugin's onShutdown
  // callback; no terminate() follows on the in-thread path.
  shutdownTimeoutMs: number;
}

export class InThreadPlugin implements PluginHandle {
  readonly cfg: ResolvedPlugin;
  private opts: InThreadOptions;
  private log: (msg: string) => void;
  private ns: PluginController;

  state: PluginState = "spawning";
  private endpoint: Endpoint | null = null;
  // The loader-side endpoint stays alive for the plugin's lifetime; we don't
  // hold a direct reference, but the paired channel keeps both endpoints
  // referenced so neither is GC'd.
  private busSubs = new Map<number, Subscription>();
  private firstSettle: { resolve: () => void } | null = null;
  readonly ready: Promise<void>;
  private stopping = false;

  constructor(cfg: ResolvedPlugin, opts: InThreadOptions, ns: PluginController) {
    this.cfg = cfg;
    this.opts = opts;
    this.ns = ns;
    this.log = opts.log ?? ((m) => console.log(m));
    this.ready = new Promise<void>((resolve) => { this.firstSettle = { resolve }; });
  }

  endpointHandle(): Endpoint | null {
    return this.state === "live" ? this.endpoint : null;
  }

  private settleFirst(): void {
    if (this.firstSettle) { this.firstSettle.resolve(); this.firstSettle = null; }
  }

  // Start the plugin. Sets up the paired channel + endpoints, wires the
  // request/event chain that ManagedPlugin wires, then kicks off runLoader on
  // the loader side. Returns synchronously; init completion arrives via the
  // 'init' event the loader emits (caught in onPluginEvent below).
  spawn(): void {
    this.state = "spawning";
    const pair = createChannelPair();
    this.wireCoreEndpoint(pair.a);
    // Fire the loader. The promise it returns resolves after init either
    // succeeds or fails (and the loader emits the corresponding 'init'
    // event), so we don't need to await it here.
    void runLoader(pair.b, {
      module: this.cfg.module,
      name: this.cfg.name,
      // ResolvedPlugin.raw is the user-config blob for user plugins, or the
      // BundledPluginSpec.config value for bundled plugins; pass through
      // verbatim. Plugins that don't expect a config simply ignore the arg.
      config: this.cfg.raw,
    }).catch((err: unknown) => {
      // runLoader itself shouldn't reject (it converts init errors into the
      // 'init' event); a reject here means something more fundamental went
      // wrong (e.g. createChannelPair / SDK construction). Treat as a fatal
      // startup error -- log and mark failed; no respawn.
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[plugin ${this.cfg.name}] loader fatal: ${msg}`);
      this.state = "failed";
      this.settleFirst();
    });
  }

  private wireCoreEndpoint(channel: Channel): void {
    const endpoint = new Endpoint(channel);
    this.endpoint = endpoint;
    // No watchdog; in-thread plugins don't need pongs. The Endpoint's
    // default ping handler would auto-pong, which is fine but we don't send
    // pings either way.
    endpoint.handleEvents((name, data) => { this.onPluginEvent(name, data); });

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
  }

  private onPluginEvent(name: string, data: unknown): void {
    if (name === "init") {
      const d = data as { ok: boolean; error?: string };
      if (d.ok) {
        this.state = "live";
        this.log(`[plugin ${this.cfg.name}] live (in-thread)`);
        this.settleFirst();
      } else {
        // Init failure for an in-thread bundled plugin is a fatal startup
        // error per core-plugin-api.md. No restart, no respawn. Surface
        // through the log; user-facing diagnostic stream is TBD.
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

    if (name === "events.subscribe") { this.onEventsSubscribe(data); return; }
    if (name === "events.unsubscribe") { this.onEventsUnsubscribe(data); return; }
    if (name === "events.emit") { this.onEventsEmit(data); return; }
    if (name === "plugin.register") { this.ns.onRegister(this.cfg.name, data); return; }
    if (name === "plugin.unregister") { this.ns.onUnregister(this.cfg.name, data); return; }
    if (name === "actions.register") { this.ns.onActionRegister(this.cfg.name, data); return; }
    if (name === "actions.unregister") { this.ns.onActionUnregister(this.cfg.name, data); return; }

    this.opts.onEvent?.(this.cfg.name, name, data);
  }

  private onEventsSubscribe(data: unknown): void {
    const bus = this.opts.bus;
    if (!bus) return;
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
    if (!sub) return;
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

  private releaseBusSubs(): void {
    for (const sub of this.busSubs.values()) sub.off();
    this.busSubs.clear();
  }

  // Graceful shutdown: ask the plugin to run onShutdown, await up to the
  // timeout, then release. No terminate() (no thread to kill).
  async stop(): Promise<void> {
    this.stopping = true;
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
  // No restart bookkeeping for in-thread; always 0 (failures are fatal).
  get restartCount(): number { return 0; }
}

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
