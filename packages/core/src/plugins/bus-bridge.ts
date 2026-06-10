// BusBridge: per-plugin owner of the events.* protocol surface (subscribe,
// unsubscribe, emit, intercept-register, intercept-unregister) between a
// plugin's Endpoint and the host's DynamicBus.
//
// Lives in its own module because both plugin hosts (Worker-backed
// ManagedPlugin in runtime.ts and InThreadPlugin) implement the same SDK
// protocol. Without this, ~150 lines of byte-identical handlers + type
// guards lived in both classes -- a refactor that has to stay in lockstep
// across reloads is a refactor that drifts.
//
// The bridge owns the two subscription maps (busSubs, busIntercepts) and
// releases them on plugin teardown. The hosts retain the actual lifecycle
// (process spawn / Worker watchdog / restart for the managed variant; none
// of those for the in-thread variant).

import type { DynamicBus, Subscription } from "../events/dynamic-bus.js";
import type { Endpoint, Json } from "./protocol.js";
import { warnRuntimeMisconfig } from "./runtime-warnings.js";

// What BusBridge needs from its owner. Both plugin hosts already have
// these; passing the host directly keeps the call chain short.
export interface BusBridgeHost {
  readonly pluginName: string;
  readonly bus: DynamicBus | undefined;
  // The Endpoint may be null mid-teardown (Worker exit, in-thread stop);
  // the bridge reads it freshly each dispatch.
  readonly endpoint: Endpoint | null;
  log(msg: string): void;
}

export class BusBridge {
  private host: BusBridgeHost;
  private busSubs = new Map<number, Subscription>();
  private busIntercepts = new Map<number, Subscription>();

  constructor(host: BusBridgeHost) {
    this.host = host;
  }

  // Returns true if this name belongs to the events.* surface and was
  // handled here (so the caller stops the dispatch chain). False means the
  // caller should continue into its remaining branches (plugin.register,
  // actions.register, log, ...).
  handle(name: string, data: unknown): boolean {
    if (name === "events.subscribe") { this.onSubscribe(data); return true; }
    if (name === "events.unsubscribe") { this.onUnsubscribe(data); return true; }
    if (name === "events.emit") { this.onEmit(data); return true; }
    if (name === "events.intercept-register") { this.onInterceptRegister(data); return true; }
    if (name === "events.intercept-unregister") { this.onInterceptUnregister(data); return true; }
    return false;
  }

  // Drop every subscription + interceptor the plugin holds. Called by the
  // host on plugin teardown (Worker exit -- crash, terminate, graceful --
  // or in-thread stop). Without this, a dead plugin's subscriptions stay
  // wired to the bus and fire callbacks against a closed endpoint.
  release(): void {
    for (const sub of this.busSubs.values()) sub.off();
    this.busSubs.clear();
    for (const sub of this.busIntercepts.values()) sub.off();
    this.busIntercepts.clear();
  }

  // --- handlers ---

  private onSubscribe(data: unknown): void {
    const bus = this.host.bus;
    if (!bus) {
      // Runtime constructed without a bus: the subscription has nowhere to
      // wire to. Warn loudly through console.error -- bypassing host.log
      // so a test that silences logs still sees the misconfiguration.
      warnRuntimeMisconfig(this.host.pluginName, "events.subscribe",
        "subscription will never fire");
      return;
    }
    if (!isSubscribePayload(data)) {
      this.host.log(`[plugin ${this.host.pluginName}] events.subscribe: malformed payload; ignored`);
      return;
    }
    const { subId, pattern } = data;
    if (this.busSubs.has(subId)) {
      this.host.log(`[plugin ${this.host.pluginName}] events.subscribe: duplicate subId ${subId}; ignored`);
      return;
    }
    let sub: Subscription;
    try {
      sub = bus.subscribe(pattern, (evName, payload) => {
        // Deliver to the plugin as a one-way event. The endpoint may be
        // null mid-teardown; the optional-chain on host.endpoint guards.
        this.host.endpoint?.emit("events.dispatch",
          { subId, name: evName, payload: payload as Json });
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.log(`[plugin ${this.host.pluginName}] events.subscribe('${pattern}') rejected: ${msg}`);
      return;
    }
    this.busSubs.set(subId, sub);
  }

  private onUnsubscribe(data: unknown): void {
    if (!isUnsubscribePayload(data)) {
      this.host.log(`[plugin ${this.host.pluginName}] events.unsubscribe: malformed payload; ignored`);
      return;
    }
    const sub = this.busSubs.get(data.subId);
    if (!sub) return;  // unknown subId (late unsubscribe after teardown): ignore
    sub.off();
    this.busSubs.delete(data.subId);
  }

  private onEmit(data: unknown): void {
    const bus = this.host.bus;
    if (!bus) {
      warnRuntimeMisconfig(this.host.pluginName, "events.emit", "emit dropped");
      return;
    }
    if (!isEmitPayload(data)) {
      this.host.log(`[plugin ${this.host.pluginName}] events.emit: malformed payload; ignored`);
      return;
    }
    try {
      bus.emit(data.name, data.payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.host.log(`[plugin ${this.host.pluginName}] events.emit('${data.name}') rejected: ${msg}`);
    }
  }

  private onInterceptRegister(data: unknown): void {
    const bus = this.host.bus;
    if (!bus) {
      warnRuntimeMisconfig(this.host.pluginName, "events.intercept-register",
        "interceptor will never fire");
      return;
    }
    if (!isInterceptRegisterPayload(data)) {
      this.host.log(`[plugin ${this.host.pluginName}] events.intercept-register: malformed payload; ignored`);
      return;
    }
    const { interceptId, pattern, priority } = data;
    if (this.busIntercepts.has(interceptId)) {
      this.host.log(`[plugin ${this.host.pluginName}] events.intercept-register: duplicate interceptId ${interceptId}; ignored`);
      return;
    }
    let sub: Subscription;
    try {
      sub = bus.intercept(pattern, (evName, payload) => {
        // Forward to the plugin as a request; the plugin's reply is the
        // (possibly modified) payload. The bus enforces its per-handler
        // timeout on the returned Promise, so a stuck plugin can't stall
        // the chain.
        const ep = this.host.endpoint;
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
      this.host.log(`[plugin ${this.host.pluginName}] events.intercept-register('${pattern}') rejected: ${msg}`);
      return;
    }
    this.busIntercepts.set(interceptId, sub);
  }

  private onInterceptUnregister(data: unknown): void {
    if (!isInterceptUnregisterPayload(data)) {
      this.host.log(`[plugin ${this.host.pluginName}] events.intercept-unregister: malformed payload; ignored`);
      return;
    }
    const sub = this.busIntercepts.get(data.interceptId);
    if (!sub) return;
    sub.off();
    this.busIntercepts.delete(data.interceptId);
  }
}

// --- type guards (module-private; mirror the SDK's outgoing payload shape) ---

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
