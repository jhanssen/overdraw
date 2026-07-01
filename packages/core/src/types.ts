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

  // Spawn a client that dies with the compositor (PR_SET_PDEATHSIG): argv
  // excludes argv0, env is a list of "KEY=VALUE" overrides on the inherited
  // environment. Returns the child pid, or -1 on fork failure. Exited children
  // are reaped from a SIGCHLD watcher on the event loop; reapChildren forces a
  // sweep if ever needed.
  spawnChild(command: string, argv: string[], env: string[]): number;
  reapChildren(): void;

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
  // Post a fatal protocol error on a client resource (wl_resource_post_error):
  // sends the error event and disconnects the client after the current
  // dispatch. `code` is the offending interface's error-enum value (from the
  // generated `<Iface>_Error` consts); `message` is a human-readable diagnostic.
  postError(resource: Resource, code: number, message: string): void;

  // Xwayland lifecycle (Phase 1: spawn a rootless Xwayland that connects to our
  // Wayland server as a client and report when it is ready). Returns the pid
  // synchronously; readiness is delivered asynchronously via `onReady` once
  // Xwayland writes its display number to the -displayfd pipe (the pipe is
  // polled on the libuv loop -- a blocking wait would deadlock the Wayland
  // server Xwayland is handshaking with). `onReady` receives a non-null error
  // string if Xwayland died before becoming ready. Throws only if the fork
  // itself fails.
  xwaylandStart(
    opts: {
      waylandDisplay: string;   // our wl socket name -> child's WAYLAND_DISPLAY
      xwaylandPath?: string;    // default "Xwayland" on PATH
      terminate?: boolean;      // -terminate (default false)
      enableWm?: boolean;       // pass -wm so the XWM can manage windows (default false)
      // Explicit display number to request. When set, Xwayland is asked to
      // bind ":N" and fails hard if :N is in use (no fallback). When unset,
      // -displayfd alone is used and Xwayland scans from :0 upward -- prone
      // to colliding with an existing X session.
      displayNumber?: number;
    },
    onReady: (err: string | null, info?: { displayNumber: number; display: string }) => void,
  ): { pid: number; wmFd: number };  // wmFd is -1 unless enableWm was set
  xwaylandStop(pid: number): void;

  // XWM (X11 window manager over the -wm socket). xwmStart connects xcb to the
  // wmFd from xwaylandStart, becomes the WM, and polls the xcb fd on the libuv
  // loop; each decoded X event is delivered to onEvent. One XWM at a time.
  // Returns { atoms } -- the interned X11 atom values keyed by name, used by
  // the TS XWM's property parsers to identify type/state/window-type atoms.
  xwmStart(
    wmFd: number,
    onEvent: (ev: import("./xwayland/xwm.js").XwmEventMsg) => void,
  ): { atoms: Record<string, number>; root: number; bookkeeper: number };
  xwmStop(): void;
  xwmMapWindow(window: number): void;
  xwmConfigureWindow(window: number, x: number, y: number, w: number, h: number): void;
  // Send a synthetic ConfigureNotify (ICCCM §4.2.3) carrying root-relative
  // coordinates. Pair with xwmConfigureWindow whenever the WM applies a
  // new rect -- some X clients (gtk/qt) rely on the synthetic form to read
  // an authoritative window position.
  xwmSendConfigureNotify(window: number, x: number, y: number, w: number, h: number): void;
  // Async property read. Returns a cookieId; the reply arrives as a
  // "property-reply" event with the same cookieId. The reply may be empty
  // (format=0) if the property is absent or the request errored.
  xwmGetProperty(window: number, atom: number, maxLengthWords?: number): number;
  // Send a WM_PROTOCOLS ClientMessage carrying `protocolAtom` (e.g.
  // WM_DELETE_WINDOW or WM_TAKE_FOCUS) to the window's client. `timestamp`
  // goes in data[1]; for WM_DELETE_WINDOW pass 0 (XCB_CURRENT_TIME), for
  // WM_TAKE_FOCUS pass a real X timestamp so focus-stealing prevention in
  // modern clients doesn't reject the focus offer.
  xwmSendWmProtocol(window: number, protocolAtom: number, timestamp?: number): void;
  // Force-kill the window's owning client (the fallback for clients that don't
  // advertise WM_DELETE_WINDOW).
  xwmKillClient(window: number): void;
  // SetInputFocus(window, RevertToPointerRoot, timestamp). Returns the X
  // request sequence number (consumed by xwm.ts to filter stale FocusIn
  // events from before the most recent WM-initiated focus change).
  xwmSetInputFocus(window: number, timestamp?: number): number;
  // Set/replace a property on a window. `format` is 8/16/32 (X11 units, not
  // bytes); `nelements` is the count in those units. `data` is a Buffer or
  // typed array whose byte-length matches nelements * format/8.
  xwmChangeProperty(
    window: number, atom: number, type: number, format: number,
    data: Uint8Array | Uint16Array | Uint32Array | Int32Array, nelements: number,
  ): void;
  // Delete a property on a window (used to clear _NET_WM_STATE_FOCUSED on
  // unfocus etc.).
  xwmDeleteProperty(window: number, atom: number): void;
  // Selection-bridge primitives. Used by src/xwayland/selection.ts to mediate
  // X11 CLIPBOARD / PRIMARY between X clients and Wayland clients.
  xwmCreateSelectionWindow(eventMask: number, inputOnly: boolean): number;
  xwmDestroyWindow(window: number): void;
  xwmSetSelectionOwner(selectionAtom: number, window: number, timestamp?: number): void;
  xwmConvertSelection(
    requestor: number, selection: number, target: number,
    property: number, timestamp?: number,
  ): void;
  xwmSendSelectionNotify(
    requestor: number, selection: number, target: number,
    property: number, timestamp?: number,
  ): void;
  xwmXfixesSelectSelectionInput(window: number, selectionAtom: number, mask: number): void;
  xwmInternAtom(name: string): number;
  // Async atom-name lookup. Returns a cookieId; reply arrives as an
  // "atom-name-reply" event with the same cookieId carrying `name`.
  xwmGetAtomName(atom: number): number;
  xwmFlush(): void;
  // Replace the event mask on a non-bridge-owned X window (typically a
  // client-owned requestor). Selecting our own mask is independent of any
  // mask the owning client has selected. The bridge uses this for
  // PROPERTY_CHANGE on requestor windows to observe INCR-continuation
  // PropertyNotify(Delete) events.
  xwmSelectWindowEvents(window: number, mask: number): void;
  // pipe(2): allocate a kernel pipe. Returns { readFd, writeFd } with
  // CLOEXEC on both and O_NONBLOCK on the read end. Used by the selection
  // bridge: writeFd is handed to a wayland data source via
  // events.wl_data_source.send_send; readFd is drained by the bridge.
  makePipe(): { readFd: number; writeFd: number };
  // Wrap a raw int fd into the WaylandFd object the trampoline expects for
  // fd-bearing wayland events. The wrapper owns the fd from this point.
  wrapFd(rawFd: number): WaylandFd;
  // Server-initiated destruction: drop the libwayland resource + wrapper.
  // For client-issued destructor requests (wl_buffer.destroy etc.) the
  // trampoline handles destruction automatically; JS only needs this for
  // events that destroy their target (wl_callback.done).
  destroyResource(resource: Resource): void;
  clientId(resource: Resource): number;

  // Keyboard: the ACTIVE keymap's memfd (as a WaylandFd) + format/size. The
  // active keymap is the default seat keymap unless setActiveKeymap() selected
  // a virtual keyboard's keymap. Each call dups the memfd (per-client mmap).
  keymapInfo(): { fd: WaylandFd; format: number; size: number } | null;

  // Compile a virtual keyboard's client-supplied keymap (a WaylandFd holding
  // XKB_KEYMAP_FORMAT_TEXT_V1 text, `size` bytes incl. NUL) and return its id
  // (>= 1), or 0 on a bad fd / compile failure. Takes ownership of the fd. The
  // id is passed as InputEvent.keymapId on injected keys, to setActiveKeymap,
  // and to unregisterKeymap.
  registerKeymap(fd: WaylandFd, size: number): number;
  // Drop a virtual keymap (id from registerKeymap). Reverts to the default if
  // it was active. No-op for 0 / unknown id.
  unregisterKeymap(id: number): void;
  // Select which keymap keyUpdate()/keymapInfo() use: 0 = default, else a
  // registered virtual keymap id. Returns true if the active keymap changed
  // (the seat then re-sends the keymap to bound wl_keyboards). Unknown id
  // falls back to the default.
  setActiveKeymap(id: number): boolean;
  // Set the active keymap's xkb modifier/layout state directly from serialized
  // masks (a virtual keyboard's explicit modifiers request, vs. deriving from
  // keys) and return the canonical masks to forward to clients.
  setModifiers(depressed: number, latched: number, locked: number, group: number): {
    modsDepressed: number; modsLatched: number; modsLocked: number; group: number;
  };

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
  // Allocate a sampleable BGRA8 wire texture for shm content on the named
  // surface. Returns the WGPUTexture pointer (as a bigint) for
  // dawn.wrapTexture, or null if the wire link is down. Internally:
  // ReserveTexture + AllocShmTex frame so the GPU process injects the
  // matching native VkImage.
  reserveShmTexture?(surfaceId: number, w: number, h: number): bigint | null;
  // Upload an shm region into a previously-reserveShmTexture'd texture.
  // The GPU process does queue.WriteTexture from its own mmap'd pool view,
  // so no large IPC transfer happens on this call. Returns the uploadSeq
  // (0 on failure). `damage` may be empty/undefined for full-buffer.
  commitShmUpload?(surfaceId: number, poolId: number, offset: number,
                   w: number, h: number, stride: number,
                   damage?: ReadonlyArray<{ x: number; y: number; width: number; height: number }>):
      number;
  // Drain the GPU-process ShmUploaded reply seqs received since the last
  // call. The JS layer keys a deferred wl_buffer.release on each seq.
  takeShmUploadAcks?(): number[];
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

  // Freeze/unfreeze the input backend's cursor accumulator for an active
  // zwp_locked_pointer_v1: while locked the cursor stays put but relative
  // deltas keep flowing. No-op on a backend with no accumulator (nested).
  setPointerLocked(locked: boolean): void;

  // Constrain the cursor to the union of these rects (global logical coords)
  // for an active zwp_confined_pointer_v1. Empty clears confinement.
  setPointerConfine(rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>): void;

  // shm pools. The pool fd is a WaylandFd; native takes the raw fd out of it.
  shmCreatePool(fd: WaylandFd, size: number): number;
  shmResizePool(poolId: number, size: number): void;
  shmDestroyPool(poolId: number): void;
  // Buffer lifetime: a wl_buffer keeps its pool's mapping alive past
  // wl_shm_pool.destroy (Wayland spec).
  shmBufferRef(poolId: number): void;
  shmBufferUnref(poolId: number): void;
  // Independent MAP_SHARED / PROT_READ|PROT_WRITE mapping over the pool's
  // fd for the requested region. The returned ArrayBuffer owns its own
  // mmap (finalized on GC). The default shmView mapping is read-only
  // private; capture destinations (ext_image_copy_capture_v1 shm output)
  // need writes to propagate back to the client's view of the fd. Returns
  // null on out-of-range or mmap failure.
  shmMapWritable(poolId: number, offset: number, length: number): ArrayBuffer | null;

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
  // Register a callback fired for each OutputModes frame from the GPU
  // process. Carries the full advertised mode list for one output;
  // arrives after the matching OutputDescriptor / OutputAdded so the
  // handler may assume state.outputs[outputId] exists. KMS only;
  // nested-host doesn't emit OutputModes. Passing null clears.
  setOnOutputModes(cb: ((d: {
    outputId: number;
    modes: ReadonlyArray<{
      width: number;
      height: number;
      refreshMhz: number;
      preferred: boolean;
    }>;
  }) => void) | null): void;
  // Send a ScanoutReserve to the GPU process for a runtime-added output
  // (M7). Called by the onOutputAdded handler. KMS only; nested/headless are
  // silent no-ops.
  reserveScanoutForOutput(outputId: number, width: number, height: number): void;
  // Drop the core-side scanout state for an outputId on removal (M7). The
  // GPU process has already torn down its ring. KMS only; nested/headless
  // are silent no-ops.
  releaseScanoutForOutput(outputId: number): void;
  // Request a KMS mode swap on `outputId`. width/height/refreshMhz MUST
  // match a mode the connector advertises (no custom modes today).
  // Asynchronous: the addon appends a SwitchMode wire frame and returns;
  // the GPU process tears down the ring + mode blob, allocates a fresh
  // ring at the new dims, and replies with ScanoutRebuild on the wire.
  // The core handler issues a fresh ScanoutReserve which the GPU
  // InjectTextures into the new ring. The OutputDescriptor that follows
  // updates JS state.outputs[outputId].deviceSize and triggers the
  // output.changed bus re-emit chain (wl_output.mode burst to bound
  // clients, etc.). KMS only; nested/headless are silent no-ops.
  switchOutputMode(outputId: number, width: number, height: number,
                   refreshMhz: number): void;
  // Register a callback fired once per drained KMS flip-complete; the outputId
  // identifies WHICH output just flipped. tvSec / tvNsec are the page-flip /
  // host-frame timestamp components on CLOCK_MONOTONIC (0/0 when no real
  // timestamp is available); seq is the kernel vsync sequence on KMS (0
  // elsewhere). JS uses (outputId) to dispatch wl_callback.done per output
  // and (tvSec, tvNsec, seq) to drive wp_presentation. tvSec is a bigint to
  // survive the u64 monotonic-clock range. Passing null clears.
  setOnFlipComplete(cb: ((outputId: number, tvSec: bigint, tvNsec: number,
                          seq: number) => void) | null): void;
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
    | "pointerAxis" | "pointerAxisSource" | "pointerAxisStop" | "pointerFrame"
    | "keyboardEnter" | "keyboardLeave" | "keyboardKey" | "keyboardModifiers";
  serial: number;
  time: number;
  x?: number;
  y?: number;
  // Relative pointer motion (logical pixels), present on pointerMotion from the
  // libinput backend. dx/dy accelerated; dxUnaccel/dyUnaccel unaccelerated.
  // Consumed by zwp_relative_pointer_v1. Absent (0) on the nested backend.
  dx?: number;
  dy?: number;
  dxUnaccel?: number;
  dyUnaccel?: number;
  button?: number;
  pressed?: boolean;
  horizontal?: boolean;
  value?: number;
  discrete?: number;
  // High-resolution wheel step in 1/120 detent units (wl_pointer.axis_value120,
  // v8). Nonzero only for the wheel source; downgraded to discrete for < v8.
  value120?: number;
  // pointerAxisSource: wl_pointer.axis_source enum (wheel/finger/continuous/
  // wheel_tilt).
  axisSource?: number;
  key?: number;
  modsDepressed?: number;
  modsLatched?: number;
  modsLocked?: number;
  group?: number;
  // keyboardKey: which keymap to interpret this key under. 0/absent = the
  // default seat keymap (all real input); a non-zero id (from registerKeymap)
  // selects a virtual keyboard's own keymap. The seat makes it active before
  // feeding the key; a real key (0) restores the default.
  keymapId?: number;
}
