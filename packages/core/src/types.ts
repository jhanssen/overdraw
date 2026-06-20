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
  // start(gpuBin, onFrame?, onInput?, opts?)
  // opts is either:
  //   - { width, height }  -> headless (no output backend; offscreen render).
  //   - { backend: "kms" | "nested", card?: string }  -> bare-metal or nested.
  //   - omitted/null       -> KMS with default card.
  // Tests typically pass { width, height } (headless) or { backend: "nested" }.
  start(gpuBin: string, onFrame?: ((presented: number) => void) | null,
        onInput?: ((ev: InputEvent) => void) | null,
        opts?:
          | { width: number; height: number }
          | { backend: "kms" | "nested"; card?: string }
          | null): { width: number; height: number };
  stop(): void;
  presentedCount(): number;
  startServer(): string;
  stopServer(): void;

  registerProtocols(signatures: unknown[]): void;
  registerInterface(name: string, handler: unknown): void;
  createGlobal(name: string, handler: unknown): void;
  // Like createGlobal, but advertises another global for `name` tagged with
  // `outputId`. Each global gets its own bind handler so multiple wl_outputs
  // (etc.) can be advertised, one per dense outputId. The interface must
  // already be registered (registerProtocols). M6+ uses this for wl_output.
  createGlobalForOutput(name: string, outputId: number, handler: unknown): void;
  // Inverse of createGlobalForOutput: tear down the per-output global so
  // clients see wl_registry.global_remove. Idempotent (a missing entry is a
  // silent no-op). Used on output removal in M7. Callers must emit any
  // protocol-level "leave" events (wl_surface.leave, fractional-scale
  // re-emit) BEFORE this -- once the global is gone clients cannot identify
  // the wl_output the leave referenced.
  destroyGlobalForOutput(name: string, outputId: number): void;
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
    // The Shift-translated keysym against the post-update xkb state ('j' with
    // Shift held -> 'J'). 0 = no symbol (XKB_KEY_NoSymbol). Used for VT-switch
    // detection. Not sent on the wire (wl_keyboard.key carries the raw keycode).
    keysym: number;
    // The keysym at shift-level 0 (Shift-independent: 'j' stays 'j' under
    // Shift). Used by the binding-chain match path so a held Shift counts only
    // as a modifier bit. 0 = no symbol.
    baseKeysym: number;
  };

  // Request a kernel VT switch via libseat. Returns true if libseat accepted;
  // the actual switch is asynchronous and signaled through the seat's
  // enable/disable callbacks (which trigger overdraw's pause/resume). Returns
  // false in nested mode (no seat) or for out-of-range n.
  switchVT(n: number): boolean;

  // Schedule a frame. Drives the wake/render state machine described in the
  // addon's `wake()` C function. Idempotent and cheap when called repeatedly
  // before the next render fires; the implementation coalesces. Call this
  // when a JS-side change requests a render that no native event covers
  // (e.g. an animation tick that still has more to do, an IPC action that
  // mutated state). Native event sources (wayland-server pump, input poll,
  // ScanoutFlipComplete/FrameComplete) wake automatically.
  wake(): void;

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
  acquireOutputTexture(outputId: number): bigint | null;
  presentOutput(outputId: number): void;
  // The /dev/dri/renderD* node the GPU process renders on (same GPU as the
  // compositor's device). Tests allocate client dmabufs on this node.
  gpuRenderNode(): string;
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
  // Same as writeBeginAccess, but additionally attaches `acquireFenceFd` (a
  // sync_file fd from wp_linux_drm_syncobj_v1's acquire timeline point) to
  // the BeginAccess wire frame via SCM_RIGHTS. The GPU process uses that
  // fence as the Dawn acquire fence INSTEAD of running EXPORT_SYNC_FILE on
  // the dmabuf -- this is the explicit-sync path required for clients (e.g.
  // NVIDIA proprietary) that do not attach implicit fences to their dmabufs.
  // Consumes the WaylandFd. Returns false iff the import is unknown (same
  // JS-gate contract as writeBeginAccess).
  writeBeginAccessWithFence(importId: number, acquireFenceFd: WaylandFd): boolean;
  // wp_linux_drm_syncobj_v1 explicit-sync syncobj operations. The DRM fd is
  // opened lazily by the addon (KMS card fd in KMS mode; render node in
  // nested mode). All handles are per-fd-context: every ioctl against a
  // handle must use the same DRM fd, which is why these calls live in the
  // addon rather than being open-coded in JS.
  //   syncobjImportTimeline consumes the WaylandFd (drmSyncobjFDToHandle);
  //     returns 0 on failure.
  //   syncobjDestroy releases an imported timeline handle.
  //   syncobjExportSyncFile materializes (handle, point) into a sync_file
  //     WaylandFd suitable for writeBeginAccessWithFence; null on failure.
  //   syncobjTimelineSignal signals (handle, point) -- the client's
  //     release_point fires after the compositor's GPU sample completes.
  syncobjImportTimeline(fd: WaylandFd): number;
  syncobjDestroy(handle: number): void;
  syncobjExportSyncFile(handle: number, pointHi: number, pointLo: number): WaylandFd | null;
  syncobjTimelineSignal(handle: number, pointHi: number, pointLo: number): boolean;

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
  // Register callbacks fired on hotplug add / remove (M7). OutputAdded
  // carries the same fields as OutputDescriptor; OutputRemoved carries only
  // outputId. Called on the Node thread; pass null to clear.
  //
  // The handlers must run in this contract:
  //   onOutputAdded: create state.outputs[outputId]; call
  //     reserveScanoutForOutput(outputId, width, height) so the GPU process
  //     can finish its bring-up handshake; emit `output.added` on pluginBus.
  //   onOutputRemoved: emit `output.pre-remove` synchronously (workspace
  //     migration + wl_surface.leave run here while state.outputs[outputId]
  //     still exists); tear down state.outputs[outputId]; destroy the
  //     output's wl_output global via destroyGlobalForOutput; emit
  //     `output.removed`; call releaseScanoutForOutput(outputId).
  setOnOutputAdded(cb: ((d: OutputDescriptor) => void) | null): void;
  setOnOutputRemoved(cb: ((d: { outputId: number }) => void) | null): void;
  // Send a ScanoutReserve to the GPU process for a runtime-added output
  // (M7). Called by the onOutputAdded handler. KMS only; nested/headless are
  // silent no-ops.
  reserveScanoutForOutput(outputId: number, width: number, height: number): void;
  // Drop the core-side scanout state for an outputId on removal (M7). The
  // GPU process has already torn down its ring. KMS only; nested/headless
  // are silent no-ops.
  releaseScanoutForOutput(outputId: number): void;
  // Register a callback fired once per drained KMS flip-complete; the outputId
  // identifies WHICH output just flipped. JS uses this to dispatch
  // wl_callback.done per output (surfaces on a 60Hz output get `done` at 60Hz
  // even when a 240Hz output is flipping). Passing null clears.
  setOnFlipComplete(cb: ((outputId: number) => void) | null): void;
  // Update the input backend's view of the multi-output layout (used for
  // pointer-space mapping and cursor clamping). Rects are in global logical
  // pixels. Called whenever state.outputs changes. Silent no-op if no input
  // backend is active.
  updateOutputLayout(rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>): void;

  // Initialize the global spdlog registry (stdout + stderr sinks, optional
  // file sink) and the per-area level table. Idempotent. Call before start()
  // so cross-process records dispatched by the GPU log reader thread land in
  // a configured registry. `levelSpec` is the --log-level argument value
  // (`area=level` pairs, comma-separated; a bare level becomes the default).
  // Throws on a malformed levelSpec.
  logInit(opts?: { levelSpec?: string; logFile?: string }): void;

  // Emit a log record on the named area. The level matches
  // spdlog::level::level_enum (trace=0, debug=1, info=2, warn=3, err=4,
  // critical=5). Used by the log module and the console.* shim. Unknown
  // areas fall back to "js".
  nativeLog(level: number, area: string, message: string): void;
}

// One OutputDescriptor message delivered from the GPU process. Mirrors the
// fields in ipc::Tag::OutputDescriptor; updates state.outputs.
export interface OutputDescriptor {
  // Routing id of the output this descriptor concerns. Transient (a dense
  // index reused across hotplug); see multi-output-design §3.
  outputId: number;
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
  // Durable identifier derived from EDID (mfr-product-serial). Empty when
  // the connector has no usable EDID (e.g. nested-host backend). The
  // workspace plugin's `preferredOutputs` keys on this when non-empty and
  // falls back to `name` otherwise -- see multi-output-design §3.
  edidId: string;
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
