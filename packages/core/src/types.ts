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

// The native N-API addon. Only the methods the JS layer calls are declared;
// add as needed.
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
  // Server-initiated destruction: drop the libwayland resource + wrapper.
  // For client-issued destructor requests (wl_buffer.destroy etc.) the
  // trampoline handles destruction automatically; JS only needs this for
  // events that destroy their target (wl_callback.done).
  destroyResource(resource: Resource): void;
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
    // The keysym resolved against the post-update xkb state. 0 = no symbol
    // (XKB_KEY_NoSymbol). Used by the binding-chain match path; not sent on
    // the wire (wl_keyboard.key carries the raw evdev keycode).
    keysym: number;
  };

  // XCursor theme resolver. Looks up a named shape in the current theme
  // (XCURSOR_THEME env, with [Icon Theme] Inherits= walk). Returns BGRA8
  // pixels tightly packed at width*height*4. For 'default', a built-in
  // 16x16 fallback ensures success even when no theme is installed; for
  // other shapes a true theme miss returns null.
  resolveCursorShape(name: string, sizePx: number, scale: number): {
    width: number;
    height: number;
    hotspotX: number;
    hotspotY: number;
    rgba: Uint8Array;
  } | null;

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
  // In-band per-frame BeginAccess/EndAccess on a cached client dmabuf import
  // (Layer C of docs/client-buffer-lifecycle.md): write a kind=1/kind=2 control
  // frame on the core WIRE socket (not ctrl). FIFO-ordered against the Dawn
  // sample commands, so no ctrl round-trip (the Node thread never blocks), no
  // wireSerial, no WireBarrier. The addon flushes staged Dawn bytes before each
  // frame. writeBeginAccess returns false iff the import is unknown (a JS-gate
  // desync the caller surfaces).
  writeBeginAccess(importId: number): boolean;
  writeEndAccess(importId: number): void;

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
  // Reverse-direction alloc (phase 5b): the core is the PRODUCER for a compose
  // buffer, the plugin is the CONSUMER. The worker reserves its consumer-side
  // texture on the plugin wire and passes the handles; the core reserves its
  // producer-side texture (RENDER_ATTACHMENT|TEXTURE_BINDING|COPY_SRC) and
  // sends AllocComposeBuf. cb({surfaceBufId} | null) -- the worker already has
  // its consumer handle. The pluginReservePointSerial gates the consumer-side
  // InjectTexture on the PLUGIN wire's barrier.
  coreAllocComposeBufferW(connId: number, w: number, h: number, ctId: number, ctGen: number,
                          cdId: number, cdGen: number,
                          pluginReservePointSerial: bigint,
                          cb: (r: { surfaceBufId: number } | null) => void): void;
  // In-band consumer Begin/End on the core wire. Synchronous frame writes:
  // Begin's FIFO position before the next compositor sample opens the bracket
  // in time; End is gated by the caller on afterCurrentFrame. No begin-done cb.
  // (Producer Begin/End live on the plugin wire, written by the Worker; the
  // core does not mediate them -- see src/plugins/gpu.ts.)
  writeConsumerBegin(surfaceBufId: number): void;
  writeConsumerEnd(surfaceBufId: number): void;
  // In-band producer Begin/End on the core wire (phase 5b, for compose
  // buffers where the core is the producer). Inverted from plugin-overlay
  // surfaces where producer Begin/End ride the plugin wire.
  writeProducerBegin(surfaceBufId: number): void;
  writeProducerEnd(surfaceBufId: number): void;
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

  // Register a callback fired once per OutputDescriptor message from the GPU
  // process. The descriptor carries the output's identity + geometry (see
  // drm-design.md "Output configuration"). Called on the Node thread from the
  // ctrl/wire poll; may be called multiple times if the output reconfigures.
  // Passing null clears the callback. Descriptors that arrived before the
  // callback was registered (during bring-up) are drained synchronously.
  setOnOutputDescriptor(cb: ((d: OutputDescriptor) => void) | null): void;
  // Update the input backend's notion of output size (used by both the
  // wayland and libinput backends to map / clamp pointer coordinates). Called
  // when the output reconfigures. Silent no-op if no input backend is active.
  updateOutputSize(width: number, height: number): void;
}

// One OutputDescriptor message delivered from the GPU process. Mirrors the
// fields in ipc::Tag::OutputDescriptor; updates state.outputs.
export interface OutputDescriptor {
  width: number;
  height: number;
  refreshMhz: number;
  scale: number;
  transform: number;
  physicalWidthMm: number;
  physicalHeightMm: number;
  name: string;
  make: string;
  model: string;
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
