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
import type { DynamicBus, Subscription } from "../events/dynamic-bus.js";
import type { ResolvedPlugin } from "../config/types.js";
import { runLoader } from "./loader.js";
import type { InThreadGpuDeps } from "./inthread-gpu.js";
import type { PluginController, PluginHandle, PluginState } from "./plugin-host.js";
import { warnRuntimeMisconfig } from "./runtime-warnings.js";

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
}

export class InThreadPlugin implements PluginHandle {
  readonly cfg: ResolvedPlugin;
  private opts: InThreadOptions;
  private log: (msg: string) => void;
  private ns: PluginController;

  state: PluginState = "spawning";
  private endpoint: Endpoint | null = null;
  private busSubs = new Map<number, Subscription>();
  private busIntercepts = new Map<number, Subscription>();
  private firstSettle: { resolve: () => void } | null = null;
  readonly ready: Promise<void>;

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

  // Kicks off the loader; returns synchronously. Init completion arrives
  // via the loader's 'init' event (onPluginEvent below).
  spawn(): void {
    this.state = "spawning";
    const pair = createChannelPair();
    this.wireCoreEndpoint(pair.a);
    void runLoader(pair.b, {
      module: this.cfg.module,
      name: this.cfg.name,
      config: this.cfg.raw,
      inThreadGpu: this.opts.inThreadGpu,
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
    if (name === "events.intercept-register") { this.onEventsInterceptRegister(data); return; }
    if (name === "events.intercept-unregister") { this.onEventsInterceptUnregister(data); return; }
    if (name === "plugin.register") { this.ns.onRegister(this.cfg.name, data); return; }
    if (name === "plugin.unregister") { this.ns.onUnregister(this.cfg.name, data); return; }
    if (name === "actions.register") { this.ns.onActionRegister(this.cfg.name, data); return; }
    if (name === "actions.unregister") { this.ns.onActionUnregister(this.cfg.name, data); return; }

    this.opts.onEvent?.(this.cfg.name, name, data);
  }

  private onEventsSubscribe(data: unknown): void {
    const bus = this.opts.bus;
    if (!bus) {
      warnRuntimeMisconfig(this.cfg.name, "events.subscribe", "subscription will never fire");
      return;
    }
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
    if (!bus) {
      warnRuntimeMisconfig(this.cfg.name, "events.emit", "emit dropped");
      return;
    }
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

  private onEventsInterceptRegister(data: unknown): void {
    const bus = this.opts.bus;
    if (!bus) {
      warnRuntimeMisconfig(this.cfg.name, "events.intercept-register",
        "interceptor will never fire");
      return;
    }
    if (!isInterceptRegisterPayload(data)) {
      this.log(`[plugin ${this.cfg.name}] events.intercept-register: malformed payload; ignored`);
      return;
    }
    const { interceptId, pattern, priority } = data;
    if (this.busIntercepts.has(interceptId)) {
      this.log(`[plugin ${this.cfg.name}] events.intercept-register: duplicate interceptId ${interceptId}; ignored`);
      return;
    }
    let sub: Subscription;
    try {
      sub = bus.intercept(pattern, (evName, payload) => {
        const ep = this.endpoint;
        if (!ep) return undefined;
        return ep.request("events.intercept-handle",
          { interceptId, name: evName, payload: payload as Json })
          .then((reply) => {
            if (!isInterceptReply(reply)) return undefined;
            if (!reply.modified) return undefined;
            return reply.payload;
          });
      }, priority !== undefined ? { priority } : undefined);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[plugin ${this.cfg.name}] events.intercept-register('${pattern}') rejected: ${msg}`);
      return;
    }
    this.busIntercepts.set(interceptId, sub);
  }

  private onEventsInterceptUnregister(data: unknown): void {
    if (!isInterceptUnregisterPayload(data)) {
      this.log(`[plugin ${this.cfg.name}] events.intercept-unregister: malformed payload; ignored`);
      return;
    }
    const sub = this.busIntercepts.get(data.interceptId);
    if (!sub) return;
    sub.off();
    this.busIntercepts.delete(data.interceptId);
  }

  private releaseBusSubs(): void {
    for (const sub of this.busSubs.values()) sub.off();
    this.busSubs.clear();
    for (const sub of this.busIntercepts.values()) sub.off();
    this.busIntercepts.clear();
  }

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

function isInterceptRegisterPayload(d: unknown): d is { interceptId: number; pattern: string; priority?: number } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.interceptId !== "number") return false;
  if (typeof o.pattern !== "string") return false;
  if (o.priority !== undefined && typeof o.priority !== "number") return false;
  return true;
}

function isInterceptUnregisterPayload(d: unknown): d is { interceptId: number } {
  return typeof d === "object" && d !== null
    && typeof (d as { interceptId?: unknown }).interceptId === "number";
}

function isInterceptReply(d: unknown): d is { modified: false } | { modified: true; payload: Json } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (o.modified === false) return true;
  if (o.modified === true) return "payload" in o;
  return false;
}
