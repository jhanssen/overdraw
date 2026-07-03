// Per-surface Worker-mode intercept state. Two cross-device dmabuf
// rings:
//
//   - input ring: core produces (A2 copy of client texture) -> plugin
//     consumes (samples in render). Direction = AllocComposeBuf.
//   - output ring: plugin produces (writes into output.texture) -> core
//     consumes (composites). Direction = AllocSurfaceBuf (overlay
//     direction).
//
// The worker's SDK runs its own tick loop (Atomics.waitAsync on the
// input SAB). When a new input slot is PRESENTED, the worker invokes
// the plugin's render callback against (input.texture = consumer view
// of presented slot, output.texture = producer view of next free
// output slot), submits, and presents the output. Core polls the
// latest presented output slot each renderFrame and binds it as the
// surface's intercept output.
//
// State lifecycle (broker):
//   1. dispatchMatched -> create(state); allocator round-trip; both
//      rings allocated.
//   2. Per frame in core: state.tickCore(timeMs) copies client tex into
//      next FREE input slot + presents it; polls output consumer for
//      latest PRESENTED slot + installs.
//   3. dispatchUnmatched -> state.destroy(); rings torn down.

import {
  SlotStates, createSlotStates,
} from "../plugins/surface-slots.js";
import { SurfaceConsumer, SurfaceProducer } from "../plugins/surface-ring.js";
import type { TickResult } from "./inthread-state.js";
import type { Addon } from "../types.js";
import type { CompositorSink } from "../protocols/ctx.js";
import type { DawnWire } from "../gpu/compositor.js";

// Worker SDK -> core round-trip to allocate the rings.
export interface RingsAllocPayload {
  // Per-slot reservations the worker performed on its plugin wire.
  // Input slots: worker reserves consumer textures (it will SAMPLE
  // the core-produced dmabuf).
  inputConsumers: ReadonlyArray<{
    texId: number; texGen: number; devId: number; devGen: number;
    wireSerial: bigint;
  }>;
  // Output slots: worker reserves producer textures (it will WRITE
  // the dmabuf core composites).
  outputProducers: ReadonlyArray<{
    texId: number; texGen: number; devId: number; devGen: number;
    wireSerial: bigint;
  }>;
  width: number;
  height: number;
}

export interface RingsAllocResult {
  inputSab: SharedArrayBuffer;
  outputSab: SharedArrayBuffer;
  // Per-slot ids the worker uses to call writeConsumerBegin/End
  // (input) or writeProducerBegin/End (output).
  inputSurfaceBufIds: number[];
  outputSurfaceBufIds: number[];
}

export interface WorkerStateDeps {
  surfaceId: number;
  registrationId: number;
  pluginName: string;
  pluginConnId: number;
  width: number;
  height: number;
  // Allocators round-tripping AllocComposeBuf (input) / AllocSurfaceBuf
  // (output). Wrappers around the addon's coreAllocComposeBufferW /
  // pluginAllocSurfaceBufferW.
  allocCompose(connId: number, w: number, h: number,
               ctId: number, ctGen: number, cdId: number, cdGen: number,
               wireSerial: bigint): Promise<{ surfaceBufId: number }>;
  allocSurface(connId: number, w: number, h: number,
               ptId: number, ptGen: number, pdId: number, pdGen: number,
               wireSerial: bigint): Promise<{ surfaceBufId: number }>;
  addon: Addon;
  compositor: CompositorSink;
  dawn: DawnWire;
  coreDeviceHandle: bigint;
  textureUsage: typeof GPUTextureUsage;
  log: (line: string) => void;
}

const SLOTS = 3;

export class WorkerInterceptState {
  readonly surfaceId: number;
  readonly registrationId: number;
  readonly pluginName: string;
  readonly width: number;
  readonly height: number;

  // Input ring (core produces, plugin consumes).
  private inputSlotBufIds: number[] = [];
  private inputSlotTextures: (GPUTexture | null)[] = [];
  private inputSlotStates: SlotStates | null = null;
  private inputSab: SharedArrayBuffer | null = null;
  private inputProducer: SurfaceProducer | null = null;

  // Output ring (plugin produces, core consumes).
  private outputSlotBufIds: number[] = [];
  private outputSlotTextures: (GPUTexture | null)[] = [];
  private outputSlotViews: (GPUTextureView | null)[] = [];
  private outputSlotStates: SlotStates | null = null;
  private outputSab: SharedArrayBuffer | null = null;
  private outputConsumer: SurfaceConsumer | null = null;

  private destroyed = false;
  private currentOutputSlot = -1;        // slot the consumer currently has Begin open on
  private frameNumber = 0;

  // Failure counter (consecutive frames with no PRESENTED output slot
  // since the worker started). Crossing FAILURE_THRESHOLD signals the
  // broker that the worker isn't producing -- the surface falls back
  // to raw. We DON'T auto-unregister the registration on this signal
  // because a slow worker should keep retrying; it's the in-thread
  // path that auto-unregisters on render throws.
  private slowFrames = 0;
  static readonly STALE_FRAMES_LOG_THRESHOLD = 60;     // ~1s at 60Hz
  private warnedStale = false;

  private readonly deps: WorkerStateDeps;

  constructor(deps: WorkerStateDeps) {
    this.deps = deps;
    this.surfaceId = deps.surfaceId;
    this.registrationId = deps.registrationId;
    this.pluginName = deps.pluginName;
    this.width = deps.width;
    this.height = deps.height;
  }

  // Allocate both rings. Driven by the broker's intercept.alloc-rings
  // request from the worker SDK (which has already reserved the
  // worker-side textures).
  async allocate(payload: RingsAllocPayload): Promise<RingsAllocResult> {
    if (payload.inputConsumers.length !== SLOTS || payload.outputProducers.length !== SLOTS) {
      throw new Error(
        `intercept.alloc-rings: expected ${SLOTS} consumers/producers, got ` +
        `${payload.inputConsumers.length}/${payload.outputProducers.length}`);
    }

    // Input ring: core = producer, plugin = consumer.
    // AllocComposeBuf reserves the core-side producer texture and the
    // plugin-side consumer texture for the same dmabuf.
    for (let i = 0; i < SLOTS; i++) {
      const c = payload.inputConsumers[i];
      if (!c) {
        throw new Error(`intercept.alloc-rings: input consumer ${i} missing`);
      }
      const r = await this.deps.allocCompose(
        this.deps.pluginConnId, this.width, this.height,
        c.texId, c.texGen, c.devId, c.devGen, c.wireSerial);
      this.inputSlotBufIds.push(r.surfaceBufId);
    }
    this.inputSlotTextures = new Array(SLOTS).fill(null);
    const inputSlots = createSlotStates(SLOTS);
    this.inputSab = inputSlots.sab;
    this.inputSlotStates = new SlotStates(this.inputSab);

    // Output ring: plugin = producer, core = consumer.
    // pluginAllocSurfaceBufferW reserves the plugin-side producer and
    // the core-side consumer.
    for (let i = 0; i < SLOTS; i++) {
      const p = payload.outputProducers[i];
      if (!p) {
        throw new Error(`intercept.alloc-rings: output producer ${i} missing`);
      }
      const r = await this.deps.allocSurface(
        this.deps.pluginConnId, this.width, this.height,
        p.texId, p.texGen, p.devId, p.devGen, p.wireSerial);
      this.outputSlotBufIds.push(r.surfaceBufId);
    }
    this.outputSlotTextures = new Array(SLOTS).fill(null);
    this.outputSlotViews = new Array(SLOTS).fill(null);
    const outputSlots = createSlotStates(SLOTS);
    this.outputSab = outputSlots.sab;
    this.outputSlotStates = new SlotStates(this.outputSab);

    // Build core-side producer (input) and core-side consumer (output).
    this.inputProducer = new SurfaceProducer({
      slots: {
        surfaceBufId: (slot) => this.inputSlotBufIds[slot] ?? 0,
        textureFor: (slot) => this.inputTextureFor(slot),
      },
      slotStates: this.inputSlotStates,
      writeBegin: (id) => this.deps.addon.writeProducerBegin(id),
      writeEnd: (id) => this.deps.addon.writeProducerEnd(id),
      onPresented: () => {},
      // demoteStaleOnPresent: false. The worker's pull loop is tight;
      // demoting+freeing a PRESENTED slot the worker might also be
      // grabbing races with the worker's writeBegin on that slot,
      // producing "STM is already used to access" Dawn errors. The
      // alternative: tryAcquire returns null when all slots are busy,
      // core skips that frame's input feed, the worker eventually
      // consumes a slot via endConsume (which is properly gated on
      // GPU completion) and frees it. The worker may lag by a frame
      // or two; correctness wins over freshness.
      demoteStaleOnPresent: false,
    });
    this.outputConsumer = new SurfaceConsumer({
      slots: {
        surfaceBufId: (slot) => this.outputSlotBufIds[slot] ?? 0,
        textureFor: (slot) => this.outputTextureFor(slot),
      },
      slotStates: this.outputSlotStates,
      writeBegin: (id) => this.deps.addon.writeConsumerBegin(id),
      writeEnd: (id) => this.deps.addon.writeConsumerEnd(id),
      // After the compositor's frame samples the output slot, the
      // consumer End fires once the GPU read completes
      // (afterCurrentFrame -- same as the overlay path).
      afterReadDone: (cb) => {
        const c = this.deps.compositor;
        if (c.afterCurrentFrame) c.afterCurrentFrame(cb);
        else cb();
      },
    });

    return {
      inputSab: this.inputSab,
      outputSab: this.outputSab,
      inputSurfaceBufIds: this.inputSlotBufIds.slice(),
      outputSurfaceBufIds: this.outputSlotBufIds.slice(),
    };
  }

  // Core's per-frame tick. Called by the broker BEFORE compositor's
  // renderFrame.
  //   1. Input leg: copy current client texture into next FREE input
  //      slot; present it (worker picks up via Atomics.waitAsync).
  //   2. Output leg: poll output ring for the LATEST PRESENTED slot;
  //      if found, begin consume + install as the surface's intercept
  //      output view. The compositor's next renderFrame samples the
  //      installed view; the consumer End fires after that frame's
  //      submit completes (afterCurrentFrame).
  tickCore(_timeMs: number): TickResult {
    if (this.destroyed) return { ok: true, rendered: false };
    this.frameNumber += 1;

    // Skip if surface not currently being composited (off-screen) or
    // has no committed buffer.
    if (!this.deps.compositor.surfaceIsPresentable?.(this.surfaceId)) {
      return { ok: true, rendered: false };
    }
    const client = this.deps.compositor.surfaceClientTexture?.(this.surfaceId);
    if (!client) return { ok: true, rendered: false };

    // Input leg: try to claim a FREE input slot. If none is free, the
    // worker is behind on consuming; skip this frame's input feed. The
    // worker still has the PRIOR PRESENTED slot to sample from.
    const inProd = this.inputProducer;
    if (!inProd) return { ok: true, rendered: false };
    const got = inProd.tryAcquire();
    if (got) {
      // tryAcquire wrote producer Begin on the core wire.
      // Encode + submit the copy (also on the core wire), then
      // presentSync writes producer End. Order: Begin -> copy -> End,
      // all FIFO on the core wire, all enclosed in the dmabuf's
      // SharedTextureMemory access bracket.
      this.deps.compositor.copyClientToInterceptInputSlot?.({
        surfaceId: this.surfaceId,
        dstTex: got.texture,
      });
      inProd.presentSync();
      // After present, the SAB CAS is PRESENTED -> the worker (waiting
      // on Atomics.waitAsync) wakes and starts its render.
    }

    // Output leg: poll output for the latest PRESENTED slot. The worker
    // produced; we consume.
    const outConsumer = this.outputConsumer;
    const outStates = this.outputSlotStates;
    if (!outConsumer || !outStates) {
      return { ok: true, rendered: false };
    }
    const latest = outStates.presentedSlot();
    if (latest < 0) {
      // Worker hasn't presented anything yet (first frame after match
      // or a slow worker). Log a warning after a threshold; surface
      // still draws raw in the meantime.
      this.slowFrames += 1;
      if (this.slowFrames > WorkerInterceptState.STALE_FRAMES_LOG_THRESHOLD && !this.warnedStale) {
        this.deps.log(
          `[intercept ${this.pluginName}] surface ${this.surfaceId}: ` +
          `worker has produced no output for ${this.slowFrames} frames; falling back to raw`);
        this.warnedStale = true;
      }
      return { ok: true, rendered: false };
    }
    this.slowFrames = 0;
    this.warnedStale = false;

    // If we already have THIS slot open (the worker hasn't produced
    // a newer frame yet), reuse it -- the compositor's installed view
    // is still valid. No new bracket transitions needed.
    if (this.currentOutputSlot === latest) {
      return { ok: true, rendered: true };
    }

    // Close the prior consumer bracket BEFORE opening a new one (the
    // SurfaceConsumer.swapToLatest path handles this in one shot, but
    // we don't have an open-then-close in the same critical section
    // here -- the prior consumer End is gated on afterCurrentFrame
    // anyway). Use swapToLatest.
    const tex = outConsumer.swapToLatest(latest);
    if (!tex) {
      // Slot's texture isn't wrappable yet (the inject still in flight).
      return { ok: true, rendered: false };
    }
    this.currentOutputSlot = latest;
    const view = this.outputViewFor(latest);
    if (!view) return { ok: true, rendered: false };
    this.deps.compositor.installInterceptOutput?.(this.surfaceId, view, null);
    return { ok: true, rendered: true };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Close any outstanding consumer bracket.
    this.outputConsumer?.destroy();
    // Tear down compositor binding.
    this.deps.compositor.clearInterceptOutput?.(this.surfaceId);
    // Release the dmabufs. Defer to afterCurrentFrame so any in-
    // flight reads complete first; falls through to immediate if no
    // such hook (test mocks).
    const reap = (): void => {
      for (const id of this.inputSlotBufIds) this.deps.addon.pluginReleaseSurfaceBuffer(id);
      for (const id of this.outputSlotBufIds) this.deps.addon.pluginReleaseSurfaceBuffer(id);
    };
    if (this.deps.compositor.afterCurrentFrame) this.deps.compositor.afterCurrentFrame(reap);
    else reap();
  }

  // Test/introspection: surface bookkeeping.
  ids(): { input: number[]; output: number[] } {
    return {
      input: this.inputSlotBufIds.slice(),
      output: this.outputSlotBufIds.slice(),
    };
  }

  private inputTextureFor(slot: number): GPUTexture | null {
    const cached = this.inputSlotTextures[slot];
    if (cached) return cached;
    const bufId = this.inputSlotBufIds[slot];
    if (bufId === undefined) return null;
    const handle = this.deps.addon.pluginConsumerTexture(bufId);
    if (handle === 0n) return null;
    const t = this.deps.dawn.wrapTexture(this.deps.coreDeviceHandle, handle);
    this.inputSlotTextures[slot] = t;
    return t;
  }

  private outputTextureFor(slot: number): GPUTexture | null {
    const cached = this.outputSlotTextures[slot];
    if (cached) return cached;
    const bufId = this.outputSlotBufIds[slot];
    if (bufId === undefined) return null;
    const handle = this.deps.addon.pluginConsumerTexture(bufId);
    if (handle === 0n) return null;
    const t = this.deps.dawn.wrapTexture(this.deps.coreDeviceHandle, handle);
    this.outputSlotTextures[slot] = t;
    return t;
  }

  private outputViewFor(slot: number): GPUTextureView | null {
    const cached = this.outputSlotViews[slot];
    if (cached) return cached;
    const t = this.outputTextureFor(slot);
    if (!t) return null;
    const v = t.createView();
    this.outputSlotViews[slot] = v;
    return v;
  }
}
