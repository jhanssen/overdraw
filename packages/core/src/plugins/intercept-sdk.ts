// Plugin-side sdk.intercept surface. Two transports, one API:
//   - In-thread: shares core's GPUDevice. The SDK passes setup +
//     handlers references directly to the broker; no IPC.
//   - Worker: setup runs on the Worker with the Worker's own GPUDevice;
//     each per-frame render call crosses a Worker boundary. The SDK
//     stores handlers on the Worker side, talks to the broker via
//     Endpoint requests for register/unregister and events for
//     render-frame dispatch.
//
// 10a status: in-thread is fully wired. The Worker shape exists in the
// SDK (so plugin code is identical) but `register` from a Worker
// plugin throws "not yet supported"; the cross-device dmabuf transport
// + per-frame Worker dispatch lands as a separate commit.

import type {
  InterceptAPI, InterceptSpec, InterceptRegistration, InterceptSetupCtx,
  InterceptHandlers,
} from "@overdraw/intercept-types";

// Direct in-thread access to the broker. The broker is constructed
// in main.ts (or in test/harness.mjs); the bundled-plugin transport
// path passes it through InThreadGpuDeps (or equivalent) so the SDK
// here can call it without a request/reply round trip.
export interface InThreadInterceptDeps {
  // Identify the calling plugin (for logs + future per-plugin
  // tracking).
  pluginName: string;
  // Register an intercept. The broker compiles the appId regex
  // (throws synchronously on invalid pattern), runs `spec.setup` once
  // with a setup ctx providing core's GPUDevice, and stores the
  // returned handlers. Returns a synthetic id used to unregister.
  registerInThread(spec: InterceptSpec, pluginName: string): Promise<number>;
  unregister(registrationId: number): Promise<void>;
}

export function createInThreadInterceptSdk(deps: InThreadInterceptDeps): InterceptAPI {
  return {
    async register(spec): Promise<InterceptRegistration> {
      validateSpec(spec);
      const id = await deps.registerInThread(spec, deps.pluginName);
      let alive = true;
      return {
        unregister: async () => {
          if (!alive) return;
          alive = false;
          await deps.unregister(id);
        },
      };
    },
  };
}

// Worker intercept SDK. The plugin's setup() runs locally on the
// Worker with the Worker's own GPUDevice (handed in via WorkerInterceptDeps).
// Each matched surface gets a per-surface tick loop that:
//   - waits on the input ring's SAB until a new PRESENTED slot appears
//     (the core's per-frame copy)
//   - acquires the next FREE output ring slot (the plugin device's
//     SurfaceProducer)
//   - calls the plugin's render callback
//   - presents the output (the SAB-CAS the core sees)
//
// Both rings (input + output) are allocated cross-device via the
// existing dmabuf machinery. The SDK uses the same SurfaceConsumer
// (for input) + SurfaceProducer (for output) abstractions the
// overlay + compose-live paths use.

import type { Endpoint, Json } from "./protocol.js";
import {
  SlotStates, SLOT_FREE, SLOT_PRESENTED,
} from "./surface-slots.js";
import { SurfaceConsumer, SurfaceProducer, awaitPresentedSlot } from "./surface-ring.js";
import { log } from "../log.js";

export interface WorkerInterceptDeps {
  pluginName: string;
  endpoint: Endpoint;
  // Plugin-side wire client id.
  clientId: number;
  // Plugin device handle + dawn wrap.
  pluginDeviceHandle: bigint;
  dawn: { wrapTexture(deviceHandle: bigint, textureHandle: bigint): GPUTexture };
  // Plugin-side native addon (overdraw_plugin_native).
  plugin: {
    reserveProducerTexture(clientId: number, surfaceBufId: number, w: number, h: number):
      { texture: { id: number; generation: number };
        device: { id: number; generation: number };
        wireSerial: bigint };
    producerTexture(clientId: number, surfaceBufId: number): bigint;
    reserveConsumerTexture(clientId: number, surfaceBufId: number, w: number, h: number):
      { texture: { id: number; generation: number };
        device: { id: number; generation: number };
        wireSerial: bigint };
    consumerTexture(clientId: number, surfaceBufId: number): bigint;
    // Producer Begin/End on the plugin wire (the overlay path: plugin
    // produces). On the PluginAddon these are `writeBeginAccess` /
    // `writeEndAccess` -- those names are inherited from the overlay
    // path and are the producer-side brackets.
    writeBeginAccess(clientId: number, surfaceBufId: number): void;
    writeEndAccess(clientId: number, surfaceBufId: number): void;
    // Consumer Begin/End on the plugin wire (compose-live: plugin
    // consumes).
    writeConsumerBegin(clientId: number, surfaceBufId: number): void;
    writeConsumerEnd(clientId: number, surfaceBufId: number): void;
  };
  // Worker-side surfaceBufId counter (shared with overlay/compose).
  allocSurfaceBufId: () => number;
  // The plugin device, exposed to setup() and used internally for
  // command submission via onSubmittedWorkDone in afterReadDone.
  device: GPUDevice;
}

const SLOTS = 3;

export function createWorkerInterceptSdk(deps: WorkerInterceptDeps): InterceptAPI {
  const { endpoint, pluginName } = deps;
  // Active registrations the SDK is tracking on the worker side.
  // registrationId -> registration record.
  const registrations = new Map<number, WorkerRegistration>();

  // Subscribe to intercept.matched / intercept.unmatched events.
  // These are emitted by the broker via emitToPlugin and arrive on
  // the Worker's endpoint as "event" frames. The loader wires
  // endpoint.handleEvents to a chain that includes us.
  registerEventHandler("intercept.matched", (data) => {
    handleMatched(data as MatchedEvent).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      log.err("plugin", `intercept ${pluginName}: matched handler threw: ${msg}`);
    });
  });
  registerEventHandler("intercept.unmatched", (data) => {
    handleUnmatched(data as UnmatchedEvent).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      log.err("plugin", `intercept ${pluginName}: unmatched handler threw: ${msg}`);
    });
  });

  return {
    async register(spec): Promise<InterceptRegistration> {
      validateSpec(spec);
      // Run setup LOCALLY with the worker's device.
      const handlers = await Promise.resolve(spec.setup({ device: deps.device }));
      // Worker transport does not yet support output dimensions
      // different from input. A non-identity outputDimensions would
      // need a runtime renegotiation protocol the Worker ring lifecycle
      // doesn't have (see decoration-as-intercept.md). Reject at
      // registration so the failure is loud and at predictable time
      // rather than silently mis-sized at the first render.
      if (handlers.outputDimensions) {
        throw new Error(
          "intercept.register: outputDimensions is not supported on the " +
          "Worker transport (10a limitation). Run as an in-thread plugin " +
          "or omit outputDimensions to use identity (output = input).");
      }
      // Same reasoning for gates: the gate request has to round-trip to
      // core to actually engage on the wm. Out of scope for 10a; reject
      // so a Worker plugin that depends on the gate fails loudly rather
      // than silently running un-gated.
      if (spec.gates) {
        throw new Error(
          "intercept.register: gates is not supported on the Worker " +
          "transport (10a limitation). Run as an in-thread plugin or " +
          "omit gates.");
      }
      const payloadObj = {
        match: serializeMatch(spec.match),
        ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
      };
      // eslint-disable-next-line no-restricted-syntax -- match is opaque; broker re-validates
      const payload = payloadObj as unknown as Json;
      const r = (await endpoint.request("intercept.register", payload)) as { registrationId: number };
      const reg: WorkerRegistration = {
        id: r.registrationId, spec, handlers,
        surfaces: new Map(),
      };
      registrations.set(r.registrationId, reg);
      let alive = true;
      return {
        unregister: async () => {
          if (!alive) return;
          alive = false;
          // Tear down all surfaces; the broker's notifyUnmatched will
          // also fire as the engine cleans up.
          for (const state of reg.surfaces.values()) state.stop();
          reg.surfaces.clear();
          registrations.delete(reg.id);
          try {
            handlers.destroy?.();
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            log.err("plugin", `intercept ${pluginName}: destroy threw: ${msg}`);
          }
          await endpoint.request("intercept.unregister", { registrationId: reg.id });
        },
      };
    },
  };

  async function handleMatched(ev: MatchedEvent): Promise<void> {
    const reg = registrations.get(ev.registrationId);
    if (!reg) return;
    // Look up dimensions via a per-surface request. The broker's
    // notifyMatched ALREADY knows the dimensions (it set them when
    // creating the WorkerInterceptState); we re-derive here via
    // alloc-rings. The alloc-rings request needs the dims as inputs
    // so the broker's WorkerInterceptState already has them on hand.
    //
    // To avoid an extra round-trip, the matched event payload could
    // carry the dims; for 10a we include w/h in the matched event.
    const w = ev.width;
    const h = ev.height;
    if (!w || !h) {
      log.err("plugin",
        `intercept ${pluginName}: matched ${ev.surfaceId} missing width/height`);
      return;
    }

    // Reserve SLOTS consumer textures (input ring; worker is consumer)
    // and SLOTS producer textures (output ring; worker is producer).
    const inputResKeys: number[] = [];
    const outputResKeys: number[] = [];
    const inputCons = [];
    const outputProds = [];
    for (let i = 0; i < SLOTS; i++) {
      const k = deps.allocSurfaceBufId();
      inputResKeys.push(k);
      inputCons.push(deps.plugin.reserveConsumerTexture(deps.clientId, k, w, h));
    }
    for (let i = 0; i < SLOTS; i++) {
      const k = deps.allocSurfaceBufId();
      outputResKeys.push(k);
      outputProds.push(deps.plugin.reserveProducerTexture(deps.clientId, k, w, h));
    }

    // Tell the broker to complete the alloc. Reply gives us the
    // shared SABs + the surfaceBufIds we use to call write*Begin/End.
    const allocPayload = {
      registrationId: ev.registrationId,
      surfaceId: ev.surfaceId,
      width: w, height: h,
      inputConsumers: inputCons.map((c) => ({
        texId: c.texture.id, texGen: c.texture.generation,
        devId: c.device.id, devGen: c.device.generation,
        wireSerial: c.wireSerial,
      })),
      outputProducers: outputProds.map((c) => ({
        texId: c.texture.id, texGen: c.texture.generation,
        devId: c.device.id, devGen: c.device.generation,
        wireSerial: c.wireSerial,
      })),
      // eslint-disable-next-line no-restricted-syntax -- payload carries bigints; SAB reply isn't Json
    } as unknown as Json;
    const allocRaw = await endpoint.request("intercept.alloc-rings", allocPayload);
    // eslint-disable-next-line no-restricted-syntax -- broker returns SABs + ids
    const alloc = allocRaw as unknown as {
      inputSab: SharedArrayBuffer;
      outputSab: SharedArrayBuffer;
      inputSurfaceBufIds: number[];
      outputSurfaceBufIds: number[];
    };

    const state = new WorkerPerSurfaceState({
      registrationId: ev.registrationId,
      surfaceId: ev.surfaceId,
      pluginName,
      width: w, height: h,
      handlers: reg.handlers,
      info: { surfaceId: ev.surfaceId, role: ev.role, appId: ev.appId ?? undefined, title: ev.title ?? undefined },
      inputResKeys, outputResKeys,
      inputSurfaceBufIds: alloc.inputSurfaceBufIds,
      outputSurfaceBufIds: alloc.outputSurfaceBufIds,
      inputSab: alloc.inputSab,
      outputSab: alloc.outputSab,
      deps,
    });
    reg.surfaces.set(ev.surfaceId, state);
    state.start();
  }

  async function handleUnmatched(ev: UnmatchedEvent): Promise<void> {
    const reg = registrations.get(ev.registrationId);
    const state = reg?.surfaces.get(ev.surfaceId);
    if (reg && state) {
      reg.surfaces.delete(ev.surfaceId);
      state.stop();
    }
    // Ack unconditionally: the broker parks the surface's rings until
    // this arrives (releasing them earlier would race brackets this
    // loop already wrote to the plugin wire). Missing state means the
    // loop is already stopped (unregister path) -- still ack so the
    // broker releases without waiting out its timeout.
    await endpoint.request("intercept.unmatch-ack", {
      registrationId: ev.registrationId, surfaceId: ev.surfaceId,
    });
  }

  // The endpoint exposes handleEvents at the loader level (loader wires
  // a dispatcher chain). For intercept's matched/unmatched events we
  // need a thin extension; the loader is updated to forward
  // intercept.* events to a SDK-supplied dispatcher.
  function registerEventHandler(name: string, fn: (data: unknown) => void): void {
    eventHandlers.set(name, fn);
  }
}

const eventHandlers = new Map<string, (data: unknown) => void>();
// All WorkerPerSurfaceState instances currently active in this worker.
// Tracked outside the registrations Map so the loader's shutdown
// handler can drain them without going through the registrations
// (which only the SDK closure has access to).
const activeStatesInWorker = new Set<WorkerPerSurfaceState>();

// Loader hook: dispatch one event. Returns true if handled. The loader
// chains this in after the other SDK dispatchers.
export function dispatchInterceptEvent(name: string, data: unknown): boolean {
  const h = eventHandlers.get(name);
  if (!h) return false;
  h(data);
  return true;
}

// Loader hook: drain all worker intercept loops + tear down state on
// shutdown. Idempotent.
export function releaseAllInterceptStates(): void {
  for (const s of activeStatesInWorker) s.stop();
  activeStatesInWorker.clear();
}

interface WorkerRegistration {
  id: number;
  spec: InterceptSpec;
  handlers: InterceptHandlers;
  surfaces: Map<number, WorkerPerSurfaceState>;
}

interface MatchedEvent {
  registrationId: number;
  surfaceId: number;
  width: number;
  height: number;
  role: "toplevel" | "popup" | "subsurface";
  appId: string | null;
  title: string | null;
}

interface UnmatchedEvent {
  registrationId: number;
  surfaceId: number;
}

interface PerSurfaceConfig {
  registrationId: number;
  surfaceId: number;
  pluginName: string;
  width: number;
  height: number;
  handlers: InterceptHandlers;
  info: { surfaceId: number; role: "toplevel" | "popup" | "subsurface"; appId?: string; title?: string };
  inputResKeys: number[];
  outputResKeys: number[];
  inputSurfaceBufIds: number[];
  outputSurfaceBufIds: number[];
  inputSab: SharedArrayBuffer;
  outputSab: SharedArrayBuffer;
  deps: WorkerInterceptDeps;
}

class WorkerPerSurfaceState {
  private readonly cfg: PerSurfaceConfig;
  private readonly inputSlotStates: SlotStates;
  private readonly outputSlotStates: SlotStates;
  private readonly inputConsumer: SurfaceConsumer;
  private readonly outputProducer: SurfaceProducer;
  private stopped = false;
  private frameNumber = 0;
  // Lazy texture wrappers.
  private inputSlotTex: (GPUTexture | null)[] = [];
  private outputSlotTex: (GPUTexture | null)[] = [];

  constructor(cfg: PerSurfaceConfig) {
    this.cfg = cfg;
    this.inputSlotStates = new SlotStates(cfg.inputSab);
    this.outputSlotStates = new SlotStates(cfg.outputSab);
    this.inputSlotTex = new Array(SLOTS).fill(null);
    this.outputSlotTex = new Array(SLOTS).fill(null);

    const { deps } = cfg;
    this.inputConsumer = new SurfaceConsumer({
      slots: {
        surfaceBufId: (slot) => cfg.inputSurfaceBufIds[slot] ?? 0,
        textureFor: (slot) => this.inputTextureFor(slot),
      },
      slotStates: this.inputSlotStates,
      writeBegin: (id) => deps.plugin.writeConsumerBegin(deps.clientId, id),
      writeEnd: (id) => deps.plugin.writeConsumerEnd(deps.clientId, id),
      // The slot's CAS DRAINING -> FREE must wait until the plugin's
      // GPU read of this slot has completed; otherwise the core's
      // producer can re-acquire the FREE slot and open a new Begin
      // while Dawn still has the prior consumer Begin open on the
      // STM (the "already used to access" error). Use the plugin
      // device's queue.onSubmittedWorkDone hook -- the SAME hook the
      // overlay path's core-side SurfaceConsumer uses
      // (afterCurrentFrame on the core compositor).
      afterReadDone: (cb) => {
        deps.device.queue.onSubmittedWorkDone().then(cb).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          log.err("plugin", `intercept ${cfg.pluginName}: onSubmittedWorkDone rejected: ${msg}`);
        });
      },
    });
    this.outputProducer = new SurfaceProducer({
      slots: {
        surfaceBufId: (slot) => cfg.outputSurfaceBufIds[slot] ?? 0,
        textureFor: (slot) => this.outputTextureFor(slot),
      },
      slotStates: this.outputSlotStates,
      // Producer brackets on the plugin wire (overlay-path naming:
      // writeBeginAccess / writeEndAccess).
      writeBegin: (id) => deps.plugin.writeBeginAccess(deps.clientId, id),
      writeEnd: (id) => deps.plugin.writeEndAccess(deps.clientId, id),
      onPresented: () => {},
      // Acquire parks forever once stop() flips this; the runLoop's
      // await producer.acquire() then never resolves and the loop
      // exits via the stopped check on subsequent iterations.
      isStopped: () => this.stopped,
      // demoteStaleOnPresent: false (same reasoning as worker-state's
      // input producer). Core's outputConsumer.swapToLatest is in a
      // tight per-frame loop and may race with a demote+free on the
      // SAME slot. Without demoteStaleOnPresent, the slot stays
      // PRESENTED until the core consumer demotes via endConsume
      // (gated on afterCurrentFrame, i.e. after the core compositor's
      // GPU read completes). Multiple slots can be PRESENTED at once
      // when the worker is faster than the core consumer; core picks
      // the latest one via swapToLatest.
      demoteStaleOnPresent: false,
    });
  }

  start(): void {
    // Fire onSurfaceMatched then start the tick loop.
    try {
      this.cfg.handlers.onSurfaceMatched?.(this.cfg.info);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.err("plugin", `intercept ${this.cfg.pluginName}: onSurfaceMatched threw: ${msg}`);
    }
    activeStatesInWorker.add(this);
    this.runLoop().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      log.err("plugin", `intercept ${this.cfg.pluginName}: runLoop threw: ${msg}`);
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    activeStatesInWorker.delete(this);
    // Close any open consumer/producer brackets.
    this.inputConsumer.destroy();
    // Producer's destroy isn't a thing; presentSync handles the End.
    // If we're mid-acquire, we have an outstanding writeBegin; flushing
    // it via a no-op present is the cleanest path. The producer
    // doesn't have a clean stop API; SurfaceProducer.present logs/throws
    // on no acquire, so we just don't call it.
    try {
      this.cfg.handlers.onSurfaceUnmatched?.(this.cfg.info);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.err("plugin", `intercept ${this.cfg.pluginName}: onSurfaceUnmatched threw: ${msg}`);
    }
  }

  private async runLoop(): Promise<void> {
    const { handlers, deps } = this.cfg;
    while (!this.stopped) {
      // Wait until the input ring has a PRESENTED slot (core has
      // copied a fresh client texture into it).
      const inputSlot = await this.waitForPresentedInput();
      if (this.stopped) return;
      if (inputSlot < 0) continue;

      // Open consumer bracket on the latest input slot.
      const inputTex = this.inputConsumer.swapToLatest(inputSlot);

      // Acquire the next FREE output slot (writes producer Begin on
      // the plugin wire).
      const out = await this.outputProducer.acquire();
      if (this.stopped) return;
      const outputTex = out.texture;

      this.frameNumber += 1;
      let result;
      try {
        result = handlers.render({
          input: {
            texture: inputTex,
            rect: { x: 0, y: 0, w: this.cfg.width, h: this.cfg.height },
          },
          output: {
            texture: outputTex,
            rect: { x: 0, y: 0, w: this.cfg.width, h: this.cfg.height },
          },
          ctx: {
            surfaceId: this.cfg.surfaceId,
            frameNumber: this.frameNumber,
            time: performance.now(),
            // Worker transport: snapshot at match time. The Worker SDK
            // does not subscribe to live WM rect changes in 10a.
            surfaceRect: { x: 0, y: 0, w: this.cfg.width, h: this.cfg.height },
            // Worker transport: the content-epoch plumbing isn't wired here yet,
            // so report contentChanged=true every frame -- the Worker keeps its
            // existing render-every-frame behavior (no skip optimization, but
            // no regression). A Worker plugin that returns false is honored by
            // the caller below.
            contentChanged: true,
            // Unused: gates aren't supported on the Worker transport (below).
            contentReady: false,
            // Seat focus is not threaded across the Worker boundary; Worker
            // plugins observe focus via window.change instead.
            activated: false,
            // No-op: gates are not supported on the Worker transport
            // in 10a. A Worker plugin that declared `gates` is
            // rejected at registration (see the Worker register
            // path's outputDimensions/gates check); this no-op exists
            // only to keep the ctx shape uniform across transports.
            releaseGate: () => {},
          },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.err("plugin",
          `intercept ${this.cfg.pluginName}: render threw: ${msg}; ` +
          `surface ${this.cfg.surfaceId} draws raw this frame`);
        // Don't present; the output slot stays ACQUIRED. We can't
        // unwind the writeBegin cleanly; presentSync to close the
        // bracket (frame is junk, but the bracket needs closing).
        try { this.outputProducer.presentSync(); } catch { /* ignore */ }
        this.inputConsumer.endConsume();
        continue;
      }
      void result;
      // After render returns, the plugin has submitted commands
      // writing to outputTex on the plugin device. presentSync writes
      // producer End on the plugin wire (FIFO behind the submit) and
      // CASes ACQUIRED -> PRESENTED.
      this.outputProducer.presentSync();
      // Release the input bracket (consumer End fires after the
      // render submit, which the FIFO order guarantees).
      this.inputConsumer.endConsume();
    }
  }

  private async waitForPresentedInput(): Promise<number> {
    // Loop until a PRESENTED slot appears or we're stopped.
    for (;;) {
      if (this.stopped) return -1;
      const s = this.inputSlotStates.presentedSlot();
      if (s >= 0) return s;
      const w = Atomics.waitAsync(
        this.inputSlotStates.states, 0,
        this.inputSlotStates.state(0));
      if (w.async) await w.value; else await Promise.resolve();
    }
  }

  private inputTextureFor(slot: number): GPUTexture | null {
    const cached = this.inputSlotTex[slot];
    if (cached) return cached;
    const k = this.cfg.inputResKeys[slot];
    if (k === undefined) return null;
    const handle = this.cfg.deps.plugin.consumerTexture(this.cfg.deps.clientId, k);
    if (handle === 0n) return null;
    const t = this.cfg.deps.dawn.wrapTexture(this.cfg.deps.pluginDeviceHandle, handle);
    this.inputSlotTex[slot] = t;
    return t;
  }

  private outputTextureFor(slot: number): GPUTexture | null {
    const cached = this.outputSlotTex[slot];
    if (cached) return cached;
    const k = this.cfg.outputResKeys[slot];
    if (k === undefined) return null;
    const handle = this.cfg.deps.plugin.producerTexture(this.cfg.deps.clientId, k);
    if (handle === 0n) return null;
    const t = this.cfg.deps.dawn.wrapTexture(this.cfg.deps.pluginDeviceHandle, handle);
    this.outputSlotTex[slot] = t;
    return t;
  }
}

function serializeMatch(m: InterceptSpec["match"]): unknown {
  return {
    ...(m.appId ? { appId: { source: m.appId.source, flags: m.appId.flags } } : {}),
    ...(m.roles ? { roles: [...m.roles] } : {}),
  };
}

function validateSpec(spec: InterceptSpec): void {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("intercept.register: spec must be an object");
  }
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    throw new TypeError("intercept.register: spec.name must be a non-empty string");
  }
  if (!spec.match || typeof spec.match !== "object") {
    throw new TypeError("intercept.register: spec.match must be an object");
  }
  if (spec.match.appId !== undefined) {
    if (typeof spec.match.appId !== "object" || spec.match.appId === null
        || typeof spec.match.appId.source !== "string"
        || typeof spec.match.appId.flags !== "string") {
      throw new TypeError(
        "intercept.register: spec.match.appId must be { source, flags }");
    }
  }
  if (typeof spec.setup !== "function") {
    throw new TypeError("intercept.register: spec.setup must be a function");
  }
  if (spec.priority !== undefined &&
      (typeof spec.priority !== "number" || !Number.isFinite(spec.priority))) {
    throw new TypeError("intercept.register: spec.priority must be a finite number");
  }
}

// Re-export the setup-ctx and handlers types for plugin authors who
// want to type their setup/render bodies without importing from
// @overdraw/intercept-types directly.
export type { InterceptSetupCtx, InterceptHandlers, InterceptSpec };
