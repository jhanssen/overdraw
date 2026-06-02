// Shared types for the handwritten JS/TS layer.
//
// These are pragmatic, hand-maintained types for the native addon surface and
// the trampoline resource wrapper. They are intentionally not exhaustive — the
// addon is a raw N-API module and the resource wrappers are dynamic — but they
// capture enough shape to type the protocol/WM layer usefully. The generated
// protocol modules are typed by their own emitted .d.ts (signature/makeEvents),
// resolved via the #protocols-gen/* subpath import.

// The trampoline resource wrapper. Single source of truth is the generated
// wayland-types module (the protocol contracts use the same Resource/ResourceOf),
// re-exported here so the handwritten layer has one import site.
import type { Resource, WaylandFd } from "#protocols-gen/wayland-types.js";
export type { Resource, ResourceOf, WaylandFd } from "#protocols-gen/wayland-types.js";

// Wayland event-sender args: wire scalars, a resource, a WaylandFd (event fd
// args like wl_keyboard.keymap), an array buffer, or null.
export type EventArg = number | string | Resource | WaylandFd | Uint8Array | null;
// One interface's generated event senders (e.g. { send_capabilities, send_name }).
export type EventSenders = Record<string, (...args: EventArg[]) => unknown>;
// The per-interface event-sender set: interfaceName -> its senders.
export type EventsByInterface = Record<string, EventSenders>;

// The native N-API addon (build/overdraw_native.node). Only the methods the
// JS layer calls are declared; add as needed.
export interface Addon {
  start(gpuBin: string, onFrame?: ((presented: number) => void) | null,
        onInput?: ((ev: InputEvent) => void) | null,
        headless?: { width: number; height: number } | null): { width: number; height: number };
  stop(): void;
  presentedCount(): number;
  startServer(): string;
  stopServer(): void;

  registerProtocols(signatures: unknown[]): void;
  registerInterface(name: string, handler: unknown): void;
  createGlobal(name: string, handler: unknown): void;
  postEvent(resource: Resource, opcode: number, args: unknown[]): void;
  clientId(resource: Resource): number;

  // Keyboard: keymap memfd (as a WaylandFd) + xkb modifier state.
  keymapInfo(): { fd: WaylandFd; format: number; size: number } | null;

  // linux-dmabuf-v1 default-feedback data sourced from the GPU process.
  // formatTableFd is a WaylandFd for the {format,pad,modifier} table memfd;
  // mainDevice/trancheFormats are pre-encoded byte arrays for the 'a' args.
  // null if the GPU process supplied no feedback (fall back to v3 events).
  dmabufFeedbackInfo(): {
    formatTableFd: WaylandFd; formatTableSize: number; entryCount: number;
    mainDevice: Uint8Array; trancheFormats: Uint8Array;
  } | null;
  keyUpdate(evdevKey: number, pressed: boolean): {
    modsDepressed: number; modsLatched: number; modsLocked: number; group: number;
  };

  // JS-compositor bridge (wire WebGPU via dawn.node). The compositing pass lives
  // in JS (src/gpu/compositor.ts); the native side provides WSI (surface acquire/
  // present), dmabuf import, and shm pixel access.
  gpuHandles(): { instance: bigint; device: bigint } | null;
  outputFormat(): GPUTextureFormat;
  acquireOutputTexture(): bigint | null;
  presentOutput(): void;
  shmView(poolId: number, offset: number, length: number): ArrayBuffer | null;
  createTextureFromDmabuf(fd: WaylandFd, w: number, h: number, fourcc: number,
                          modHi: number, modLo: number, offset: number, stride: number,
                          cb: (handle: bigint | null) => void): number;
  releaseDmabufImport(importId: number): void;

  // Plugin GPU brokering (core side; the Worker owns the wire client). Callbacks
  // are node-style (result|null or ok); the broker Promise-wraps them.
  pluginCreateConnection(cb: (r: { connId: number; fd: number } | null) => void): void;
  pluginInjectInstance(connId: number, id: number, gen: number, cb: (ok: boolean) => void): void;
  pluginSetTickDevice(connId: number, id: number, gen: number): void;
  // `pluginReservePointSerial` (bigint) is the PLUGIN-wire bytesQueued sampled
  // AFTER the flush that committed the producer-texture reserve (the WORKER's
  // reserveProducerTexture returns it directly). Required: the GPU process
  // defers its plugin-side InjectTexture until its plugin-conn wire reader has
  // consumed >= this many framed bytes -- the recycled-handle hazard.
  pluginAllocSurfaceBufferW(connId: number, w: number, h: number, ptId: number, ptGen: number,
                            pdId: number, pdGen: number,
                            pluginReservePointSerial: bigint,
                            cb: (r: { surfaceBufId: number } | null) => void): void;
  pluginSurfaceProducerBegin(surfaceBufId: number, cb: (ok: boolean) => void): void;
  pluginSurfaceProducerEndW(surfaceBufId: number, wireSerial: bigint): void;
  pluginSurfaceConsumerBegin(surfaceBufId: number, cb: (ok: boolean) => void): void;
  pluginSurfaceConsumerEnd(surfaceBufId: number): void;
  pluginConsumerTexture(surfaceBufId: number): bigint;
  // Destroy a plugin ring slot's surfaceBuf (GPU process frees dmabuf/STM/textures;
  // core reclaims its reservation). Caller gates on the consumer GPU read completing.
  pluginReleaseSurfaceBuffer(surfaceBufId: number): void;

  // Synthetic input (test seam): feed a normalized InputEvent through the same
  // sink the host seat uses, so it routes to onInput / the seat exactly as a real
  // host event would. Used by integration tests to drive focus/pointer behavior.
  injectInput(event: InputEvent): void;
  // Like injectInput, but routes through the REAL WaylandInputBackend
  // normalization (fixed-point -> output space, evdev codes) -- the layer
  // injectInput skips. Pointer x/y are logical output-space coords. Returns false
  // if no input backend is active. Supersedes the manual input-smoke path (all
  // but the GPU-process host-seat listener, which needs a real device).
  injectHostInput(event: InputEvent): boolean;

  // shm pools. The pool fd is a WaylandFd; native takes the raw fd out of it.
  shmCreatePool(fd: WaylandFd, size: number): number;
  shmResizePool(poolId: number, size: number): void;
  shmDestroyPool(poolId: number): void;
  // Buffer lifetime: a wl_buffer keeps its pool's mapping alive past
  // wl_shm_pool.destroy (Wayland spec).
  shmBufferRef(poolId: number): void;
  shmBufferUnref(poolId: number): void;
}

// Normalized input event delivered to the onInput callback (mirror of
// native/core/input.h InputEvent, marshaled to a plain object).
export interface InputEvent {
  type:
    | "pointerEnter" | "pointerLeave" | "pointerMotion" | "pointerButton"
    | "pointerAxis" | "pointerFrame"
    | "keyboardEnter" | "keyboardLeave" | "keyboardKey" | "keyboardModifiers";
  serial: number;
  time: number;
  x?: number;
  y?: number;
  button?: number;
  pressed?: boolean;
  horizontal?: boolean;
  value?: number;
  discrete?: number;
  key?: number;
  modsDepressed?: number;
  modsLatched?: number;
  modsLocked?: number;
  group?: number;
}
