# overdraw — implementation status

Tracks what is built and empirically proven versus what is still design only.
The design itself lives in `architecture.md`; this file is the ground truth for
"what exists right now."

Last updated: 2026-05-30 (rev 10).

## Verification environment

All "proven" claims below were exercised on:

- NVIDIA GeForce RTX 5060 (GB206, Blackwell), proprietary driver
  595.71.05, Vulkan backend.
- A live host Wayland session (`wayland-1`), overdraw running nested as a
  client of it.
- Dawn wire release `jhanssen/dawn` `v20260529-linux-wayland-wire-alpha2`
  (commit `7af36c56902d10775e2229b2f1491f2a38bb476b`).

Single machine, single driver. Nothing here is proven portable yet.

## Built and proven

### Build / dependency integration
- Top-level CMake downloads the Dawn wire release tarball, runs
  `find_package(Dawn)`, and links `dawn::webgpu_dawn` (native + wire server)
  and `dawn::webgpu_dawn_wire` (wire client). See `3rdparty/dawn/CMakeLists.txt`.
- `wayland-scanner`-generated xdg-shell client glue is checked in
  (`native/wayland/generated/`); the build has no build-time dependency on
  `wayland-scanner`.

### Two-process presentation spine (phase 1 nested)
The core (Node + N-API addon, wire client) + GPU process (native Dawn + wire
server) topology runs as real, non-spike code and presents to a host window:

- GPU process (`gpu-process/`): owns the host Wayland output window and its
  `wl_display` connection, native Dawn instance + `dawn::wire::WireServer`,
  creates the `wgpu::Surface` from the host `wl_surface`, and `InjectSurface`s
  it at the client's reserved handle. Also holds the GBM allocator (see
  "dmabuf interop").
- Core: now **Node-hosted C++**. `src/index.js` loads the N-API addon
  (`overdraw_native.node`); the native side lives in `native/core/`
  (`gpu_process`, `wire_link`, `compositor`) compiled into a static lib. The
  addon `fork`+`exec`s the GPU process, runs `dawn::wire::WireClient`, brings
  up adapter + device + surface over the wire, and composites.
- IPC (`native/ipc/`): Dawn wire over one `SOCK_STREAM` socket (length-prefixed
  frames); a side channel over a `SOCK_SEQPACKET` socket carrying fixed-size
  tagged POD control messages (`side_channel.h`) — not yet flatbuffers. (The
  side channel was STREAM originally; switched to SEQPACKET once control traffic
  grew, to preserve message boundaries. SCM_RIGHTS fd passing IS now used — the
  `ImportClientTex` message carries a client dmabuf fd this way.)
- Clean lifecycle: runs until `stop()`, then ordered shutdown; GPU process
  exits cleanly and is reaped (poll then SIGTERM fallback so it cannot orphan).

### JS layer / event loop (core is C++ + Node)
- The core is C++ + Node as the architecture specifies. Node owns `main()` and
  the libuv loop; the N-API addon (raw `node_api.h` C API, to avoid
  node-addon-api's exception/RTTI dependence under `-fno-rtti`) holds the native
  core. One-shot bring-up runs blocking inside `start()`; the **steady-state
  present loop is libuv-driven** — a `uv_poll_t` on the wire fd drains inbound
  wire frames and a `uv_timer_t` (~16ms) paces frame render+present. No
  hand-rolled C++ spin loop in steady state.
- A **C++ -> JS event path** works: an optional `onFrame` JS callback is invoked
  from the frame timer (direct `napi_call_function`, same Node thread). The
  cross-thread path (Dawn-internal-thread callbacks -> `napi_threadsafe_function`)
  is **not yet exercised**.
- Still C++-internal / not in JS: protocol semantics, WM/policy, the plugin
  model. "JS owns this" per the design has not started beyond the entry script.
- `wl_event_loop` (server-side Wayland) integration does not exist — there is no
  Wayland server yet. No resize handling. Host *input* arrives in the core (see
  "Host input forwarding") and both **pointer and keyboard** input are routed to
  clients via `wl_seat`/`wl_pointer`/`wl_keyboard` (see "Input routing to
  clients").

### Host input forwarding (host seat -> GPU process -> core -> JS, verified)
Host pointer/keyboard events reach the core as normalized events. The seam is a
backend abstraction so a phase-2 libinput source can replace the phase-1 source
without touching anything above it.

- Phase-1 source: the GPU process binds the host `wl_seat` (`host_window.cpp`,
  pointer + keyboard, up to wl_seat v5) and forwards each event as a fixed-size
  `ipc::InputMessage` over a **dedicated SEQPACKET input socket** — separate
  from the control side channel so unsolicited input never interleaves with
  control request/reply traffic. Send is non-blocking (`MSG_DONTWAIT`): input is
  lossy by design and the GPU loop must never block on a full socket buffer
  (doing so stops it servicing the host connection -> the host marks the window
  unresponsive). The third socket fd is passed at fork/exec
  (`gpu_process.cpp`, `argv[3]`, optional).
- Core abstraction (`native/core/input.h`): `InputEvent` (normalized,
  OUTPUT-space doubles, raw evdev keycodes, ms timestamps), `InputSink`, and an
  `InputBackend` interface. `WaylandInputBackend` (`input_wayland.cpp`) reads the
  input socket, converts `wl_fixed_t` (24.8) to logical pixels, and emits
  `InputEvent`s. A future `LibinputBackend` implements the same interface.
- Addon bridge (`addon.cpp`): a `uv_poll_t` on the input fd drains the backend on
  the Node main thread; events are delivered to an optional `onInput` JS callback
  (`start(gpuBin, onFrame?, onInput?)`) as plain objects — same-thread
  `napi_call_function`, no threadsafe function needed.
- Verified end-to-end **interactively** (`test/input-smoke.mjs`, needs GPU + host
  Wayland + a human) on the RTX 5060 / Hyprland: pointer enter/motion/frame and
  keyboard enter/key/modifiers all reach the JS callback; coordinates and evdev
  keycodes correct. **PASS.** (Not CI-able: input requires real user activity.)
- Fixed while building this: the GPU process's host-connection `pump()` only
  called `wl_display_dispatch_pending` (drains the in-memory queue) and never
  READ the socket, so host events sat unread forever. Now does
  prepare_read + non-blocking poll on the wl fd + read_events. This was latent
  before (nothing consumed post-startup host events) and would also have broken
  future resize/output handling.
- Limitations: coordinate mapping is currently identity (output logical size ==
  host window size, scale 1; `setOutputSize()` hook exists but is uncalled — real
  mapping waits on resize/scale handling). Touch not forwarded. No keymap
  translation (raw evdev codes only).

### Input routing to clients (wl_seat / wl_pointer / wl_keyboard, verified)
A real Wayland client receives mouse AND keyboard events on its surface — the
phase-1 interactivity goal (connect → place → receive input) is met for both.

- `src/protocols/wl_seat.ts`: the `wl_seat` global advertises **pointer +
  keyboard** capability; the seat module tracks `wl_pointer`/`wl_keyboard`
  resources per client and routes the normalized `onInput` stream. `handleInput`
  hit-tests the WM window stack (`wm.windowAt`), tracks focus, and emits
  `wl_pointer` enter/leave/motion/button/axis/frame and `wl_keyboard`
  enter/leave/key/modifiers to the resources of the client that owns the focused
  surface, with **surface-local** pointer coordinates. Keyboard focus follows
  pointer focus (focus-follows-mouse) for this phase — a deliberate v1
  simplification, not a real WM focus policy.
- `Trampoline::clientIdOf` + addon `clientId(resource)`: a stable per-client id
  (the `wl_client*`) associates the focused surface with the right client's
  input resources without exposing `wl_client` to JS.
- WM hit-test: `mapWindow` records the effective window size (committed buffer
  dims when the placement stub leaves size 0) so `windowAt` has real bounds.
- `onInput` is wired through `installProtocols`' returned `state.seat.handleInput`.
- **Keyboard keymap + modifiers** (`native/wayland/keymap.{h,cpp}`, xkbcommon):
  a default keymap is compiled and serialized to a sealed memfd; `get_keyboard`
  sends it via `wl_keyboard.keymap` (XKB_V1). Each host key feeds the xkb state
  (`xkb_state_update_key`, evdev+8) and the serialized modifier masks are emitted
  via `wl_keyboard.modifiers`. The keymap fd is delivered as a `WaylandFd` and
  encoded into the event via the now-implemented trampoline fd-**encode** path
  (`postEvent` 'h' takes the raw fd from the WaylandFd, libwayland dups it into
  the wire, we close our copy).
- Verified interactively (`test/compositing-eyeball.mjs` + `test/color-client.c`):
  hovering/clicking produces correct per-window pointer enter/leave + surface-
  local motion + buttons; the client receives a readable keymap (mmap shows
  `xkb_keymap {`); typing routes key press/release to the focused client with
  **correct modifier masks** (Shift → dep bit 0, Alt → dep bit 3, cleared on
  release); keyboard focus tracks the pointer. **PASS.**
- Not built: client cursor surfaces (`set_cursor` is a no-op; no software
  cursor), touch, multi-seat, click-to-focus / keyboard focus independent of the
  pointer, key-repeat generation (repeat_info sent; client repeats), axis
  source/discrete refinement.

### Compositing (multi-surface: per-surface placement + stacking + blending)
- A textured-quad pipeline composites client surfaces: shaders, sampler,
  per-surface bind group. Each surface is drawn into its layout rect (a per-
  surface uniform holding a normalized output rect; the vertex shader places the
  unit quad), in JS-owned back-to-front stack order, with premultiplied-alpha
  blending. With an empty stack the pass clears to black.
- **Multi-surface verified** (`test/compositing-eyeball.mjs`, needs GPU + host
  Wayland + eyeball): two real shm clients (red 300x300, green 350x250) map and
  appear simultaneously at distinct cascaded positions. **PASS** (visual).
- Placement seam: native consumes geometry only — `setSurfaceLayout(id,x,y,w,h)`
  and `setStack(ids[])` (addon -> `Compositor`); JS owns it. `src/wm/index.js`
  holds the window list/stack and pushes layout+order to native; `src/wm/
  placement.js` is a STUB (cascade) — the one throwaway policy piece, to be
  replaced by a real layout model (dynamic tiling + floating) without touching
  the seam. `mapWindow` fires on a toplevel's first buffered commit
  (`wl_surface.commit`).
- **Transport fix found while building this:** the Dawn wire socket is
  non-blocking; `FdSerializer::writeAll` treated `EAGAIN` as fatal, so any frame
  larger than the socket send buffer (~200KB, i.e. windows bigger than ~192x192
  in BGRA) was dropped/truncated. The peer then deserialized garbage (a corrupt
  `dataLayout.offset` reaching `WriteTexture` validation) -> upload failed ->
  black. Now `writeAll` polls `POLLOUT` and retries on EAGAIN/EINTR. This was a
  latent bug independent of multi-surface; large shm uploads now work.
- The interop dmabuf test quad (a server-allocated dmabuf texture the core used
  to render green into and hold open) has been **removed** from the compositor;
  it was spike scaffolding superseded by real client-buffer compositing. The
  dmabuf import primitive itself stays proven (see "dmabuf interop path") and is
  still exercised GPU-side, but the core no longer reserves/injects a dmabuf
  texture or holds a perpetual `SharedTextureMemory` access bracket in steady
  state.
- Swapchain present mode is **Mailbox** (non-blocking acquire), chosen from the
  surface's advertised modes. FIFO blocked `Surface::GetCurrentTexture` on the
  GPU process's single command thread whenever the host compositor wasn't
  consuming frames (e.g. an unviewed nested window), which stalled all other
  wire work behind it (including buffer-map). Mailbox avoids that.
- Still absent: per-surface transforms/opacity/rotation/scale, fractional scale,
  multi-output, damage, real WM/layout policy (placement is a cascade stub),
  resize handling. Output logical size == host window size (scale 1). Pointer +
  keyboard routing to clients IS done (see "Input routing to clients").

### Client shm buffers end-to-end (upload → composite → present, pixel-verified)
A real Wayland client can map a window with content and have its pixels reach
the screen, verified by GPU readback:

- JS handlers `src/protocols/wl_shm.js`, `wl_shm_pool.js`, `wl_buffer.js`:
  `wl_shm` advertises ARGB8888/XRGB8888 on bind (via a new trampoline on-bind
  hook) and creates pools; `create_pool` hands the fd (opaque handle) to native,
  which `mmap`s it (`native/core/shm.cpp` `ShmRegistry`); `create_buffer` records
  an (offset,w,h,stride,format) view; `wl_surface.commit` resolves the committed
  buffer and uploads it.
- Native bridge (`addon.cpp` + `core/compositor.cpp`): `commitSurfaceBuffer`
  resolves the pool region and calls `Compositor::commitSurfaceShm`, which
  creates/recreates a `BGRA8Unorm` wgpu texture over the wire
  (`Device::CreateTexture`) and uploads CPU pixels via `Queue::WriteTexture`,
  then builds a per-surface bind group. ARGB8888/XRGB8888 shm memory maps to
  BGRA8Unorm byte-for-byte (no swizzle) on little-endian. After upload the
  compositor sends `wl_buffer.release` (shm bytes are copied at upload time).
- Verified end-to-end (`test/shm-test-client.c` + `test/shm-upload-smoke.mjs`,
  needs GPU + host Wayland): a client binds `wl_shm`+`wl_compositor`+
  `xdg_wm_base`, fills a 64×64 buffer with solid blue, maps an `xdg_toplevel`,
  attaches+commits; the server uploads, composites, and presents. A GPU readback
  (`CopyTextureToBuffer`+`MapAsync`) confirms the uploaded texture is pixel-exact
  (BGRA `[255,0,0,255]` at sampled points). **PASS.**
- This also established that device/queue async over the wire (`MapAsync`,
  `OnSubmittedWorkDone`) needs the GPU process to call
  `dawn::native::DeviceTick(device)` in its pump loop (instance-level
  `InstanceProcessEvents` alone is insufficient); added to `gpu-process/main.cpp`.
- `WriteTexture` over the wire serializes pixels through the socket (no
  `MemoryTransferService` configured) — functional, per-upload copy cost
  unmeasured. Throughput is not yet a concern at this stage.
- Still absent: multi-surface placement, damage-driven partial upload, format
  conversion beyond ARGB/XRGB8888.

### Client dmabuf buffers end-to-end (`linux-dmabuf-v1`, pixel-verified)
A real client can now pass its **own** dmabuf (zero-copy GPU buffer) and have it
imported + composited — the two items previously flagged unverified (SCM_RIGHTS
fd passing; importing a client-chosen modifier we did not allocate) are now
proven on the RTX 5060:

- **SCM_RIGHTS fd passing** over the side channel: new `sendMessageFds`/
  `recvMessageNBFds` in `native/ipc/transport.h` attach/parse fds via `cmsg`/
  `SCM_RIGHTS`. Unit-verified standalone (`test/scm-rights-test.cpp`: an fd sent
  over a SEQPACKET pair arrives as a distinct dup'd fd reading the same file).
- JS handlers `src/protocols/zwp_linux_dmabuf_v1.js` + `zwp_linux_buffer_params_v1.js`:
  advertise ARGB8888/XRGB8888 with LINEAR+INVALID modifiers on bind; `add`
  records the plane (fd handle + offset/stride/modifier); `create_immed` builds a
  dmabuf-tagged buffer descriptor. `wl_surface.commit` branches dmabuf vs shm and
  does NOT release the dmabuf buffer (zero-copy; sampled directly).
- New side-channel `ImportClientTex` (core→gpu) carries the client dmabuf params
  + the fd via SCM_RIGHTS. The GPU process builds a `DmabufBuffer` (no GBM bo),
  reuses `Allocator::importTexture` (it never assumed GBM origin) to import the
  client fd as `SharedTextureMemory`, does a `BeginAccess` (initialized) so it is
  sampleable, and `InjectTexture`s at the core's reserved handle. Per-surface STM
  + texture + fd kept in a keyed map for lifetime.
- Core `Compositor::commitSurfaceDmabuf`: `ReserveTexture`, send `ImportClientTex`
  with the fd, await `ClientTexImported`, wrap the injected handle as a
  `wgpu::Texture`, build the per-surface bind group — plugging into the same
  `clientSurfaces_` compositing/readback path as shm.
- Verified end-to-end (`test/dmabuf-test-client.c` + `test/dmabuf-upload-smoke.mjs`,
  needs GPU + host Wayland): client GBM-allocates a LINEAR ARGB8888 buffer filled
  solid red, sends it via `create_immed`, maps an `xdg_toplevel`, commits; the
  compositor imports the client dmabuf, composites, presents. GPU readback
  confirms pixel-exact red (BGRA `[0,0,255,255]`). **PASS.**
- Limitations: single plane only; `create` (async, server-minted wl_buffer) is
  NOT supported — the trampoline can't mint a server-side new_id for an event, so
  only `create_immed` (client supplies the buffer id) works; no per-frame
  re-import optimization / fence-synced release; the held BeginAccess is never
  ended until teardown (fine single-device, revisit for multi-device); no
  modifier *negotiation* beyond advertising a static set (import may reject an
  unadvertised client modifier, surfacing as a failed commit).

### dmabuf interop path (single device, validated end-to-end)
The plugin/surface buffer path from the design is proven as real, non-spike code
on the verification hardware (single device — producer and consumer are the same
core device):

- GBM allocator + DRM modifier probe in the GPU process: `GetFormatCapabilities`
  chained with `DawnDrmFormatCapabilities` on a native adapter, intersected with
  `gbm_bo_create_with_modifiers`. On NVIDIA: 7 Dawn-importable BGRA8 modifiers,
  6 also GBM-allocatable (single-plane only for now). `native/.../allocator`.
- Import the dmabuf as `SharedTextureMemory` on the wire-resolved device and
  create a `wgpu::Texture` (usage incl. RenderAttachment + TextureBinding).
- `ReserveTexture` (client) / `InjectTexture` (server) over the wire: a client
  texture handle resolves to the server-allocated dmabuf texture.
- `BeginAccess`/`EndAccess` with mandatory Vulkan image-layout state; EndAccess
  produces a `SharedFenceSyncFD` (fenceCount=1). The client renders into the
  dmabuf (write bracket), then samples it for compositing (read bracket). NOTE:
  the core no longer drives this in steady state — the perpetual read bracket
  and the dmabuf test quad were removed from the compositor (see "Compositing").
  The GPU-side allocate/import/inject + access-bracket code remains and is the
  primitive a future `linux-dmabuf-v1` handler reuses; it is just not exercised
  by the current present loop.
- **Not done:** two-device cross-device sharing (plugin device renders, core
  device samples) and cross-process fence *consumption* — the sync-fd is
  produced but not waited on across a device boundary. Assumed to work
  (multi-device STM import is the same primitive), unverified. Multi-plane / YUV
  import not done. SCM_RIGHTS fence passing not done.

### Protocol generator (XML -> JS/TS)
- `tools/gen-protocol/` parses Wayland protocol XML (per wayland.dtd) and emits,
  per interface, a `.js` signature module (request/event tables with opcodes,
  arg metadata, since-versions; enums; a `makeEvents(post)` event-sender
  factory) and a `.d.ts` typed contract (branded per-interface resource types,
  handler interface for requests, event-sender interface, enums; `fixed`->
  number, `fd`->WaylandFd, object/new_id->branded resource, array->Uint8Array).
- Output goes to `src/protocols-gen/` (gitignored; reproduced from XML). 31
  interfaces generate from core wayland + xdg-shell + linux-dmabuf-v1; all
  `.d.ts` type-check under `tsc --strict`; structural tests (`test/`) assert
  opcodes/types/enums/since.
- Limitation: per-arg since-versioning not represented (message-level only).

### Wayland server + generic trampoline (the core is now a Wayland *server*)
overdraw accepts real Wayland clients and dispatches their protocol to JS, with
interfaces built at runtime from the generator metadata (no per-protocol C):

- `native/wayland/server.cpp`: `wl_display` + listening socket, integrated into
  Node's libuv loop (uv_poll on the event-loop fd -> dispatch; uv_prepare ->
  flush_clients).
- `native/wayland/interface_registry.cpp`: builds `wl_interface`/`wl_message[]`/
  `types[]` at runtime from the generated signature (libwayland signature
  strings; two-pass cross-reference resolution).
- `native/wayland/trampoline.cpp`: a generic dispatcher decodes the
  `wl_argument` array into a typed tuple and calls the named JS handler method.
  new_id args create a child resource; object args decode to a cached per-
  resource JS wrapper. Outgoing events: `postEvent` encodes typed args and calls
  `wl_resource_post_event_array` (wired to the generated `makeEvents`). Resource
  destruction invalidates the JS wrapper (`destroyed=true`) and frees the ref.
  Two registration entry points: `registerInterface(name, handler)` stores a
  handler without advertising a global (for request-created interfaces like
  `xdg_surface`/`xdg_toplevel` — child resources from a new_id arg find their
  handler here); `createGlobal(name, handler)` does the same *and*
  `wl_global_create`s so clients can bind.
- Verified end-to-end with a real libwayland client (`test/wl-test-client.c` +
  `test/trampoline-smoke.mjs`): client binds `wl_compositor` (runtime-registered
  global), calls `create_surface`; the JS handler fires, creates the
  `wl_surface`, sends `wl_surface.preferred_buffer_scale(2)` back (client
  receives it); after the client destroys the surface the wrapper is
  invalidated. This validates the generator metadata against real wire traffic.

Trampoline gaps (implemented or not):
- `fd` request-arg **decode** is implemented via the `WaylandFd` wrapper
  (`native/wayland/wayland_fd.{h,cpp}`): on decode the fd is `dup`'d and handed
  to JS as a `WaylandFd` object that owns it (state OPEN/TAKEN/CLOSED in a napi
  external; finalizer closes iff still OPEN, with a leak warning). JS calls
  `fd.takeRawFd()` / `fd.close()`; native consumers call `takeWaylandFd()` to
  pull the raw fd out by reference. There is no longer a native fd handle table
  (the old `fdTake`/`fdClose` handle API was removed). Proven over
  `wl_shm.create_pool` (`test/fd-passing-smoke.mjs`: server reads the client's
  marker bytes via `takeRawFd`) and the shm/dmabuf e2e (native `takeWaylandFd` →
  `mmap` / SCM_RIGHTS). The read/write methods on `WaylandFd` for data-transfer
  fds (pipes) are declared but not implemented (no consumer yet).
- `fd` **encode** (events carrying fds) is implemented: `postEvent` 'h' takes
  the raw fd out of a `WaylandFd`, hands it to `wl_resource_post_event_array`
  (which dups into the wire), then closes the copy. Proven by `wl_keyboard.keymap`
  delivering a readable keymap memfd to real clients (see "Input routing").
- `array` encode is proven on the wire (`xdg_toplevel.configure` sends a
  non-empty `states` `wl_array` of one uint32; the client receives 4 bytes
  decoding to `ACTIVATED`, asserting both byte length and value). `array`
  *decode* still has no exerciser (no core protocol has an array request arg).
- object arg passed *into* a handler: implemented, not yet end-to-end tested
  (needs a protocol with an existing-object request arg).
- per-arg since-versioning not handled.
- No live reload yet.

### JS protocol layer: xdg-shell toplevel creation (first light, no buffer)
A handwritten JS protocol layer now sits on the trampoline. A real client can
create and configure an `xdg_toplevel`; it cannot yet show pixels (no buffer
path).

- `src/protocols/index.js`: minimal loader. Imports every generated signature,
  calls `registerProtocols`, then wires handlers — globals (`wl_compositor`,
  `xdg_wm_base`) via `createGlobal`, request-created interfaces (`wl_surface`,
  `wl_region`, `xdg_surface`, `xdg_toplevel`) via `registerInterface` — and
  builds the per-interface event senders from `makeEvents(addon.postEvent)`. No
  C++/core-JS/plugin layering or override semantics yet (deferred until plugins
  exist).
- `src/protocols/*.js`: handler modules tracking surfaces (pending/committed
  buffer, frame-callback queue), xdg roles, and the configure handshake
  (`xdg_toplevel.configure` empty-states → `xdg_surface.configure` serial →
  client `ack_configure`), plus `set_title`/`set_app_id`.
- Verified end-to-end (`test/xdg-test-client.c` + `test/xdg-toplevel-smoke.mjs`):
  a real libwayland client binds `wl_compositor` + `xdg_wm_base`, creates a
  surface, `get_xdg_surface` + `get_toplevel`, sets title/app_id, receives both
  configure events and acks; server-side state (toplevel, title, app_id, role,
  configured-after-ack) is asserted. **PASS.**
- The configure sends `states = [activated]` (a non-empty `wl_array`), which
  doubles as the on-wire proof of non-empty array encoding.
- Buffer attach/commit now uploads + composites shm buffers (see "Client shm
  buffers end-to-end"). Still: configure sends 0×0 (client picks size); no
  WM/policy (placement, focus, dynamic toplevel states); popups (`get_popup`)
  and positioners are no-ops.

### Load-bearing facts established (recorded in architecture.md "Validated against Dawn")
- A Wayland-backed `wgpu::Surface` swapchain works **over the Dawn wire**: a
  wire client drives `Configure`/`GetCurrentTexture`/`Present` against a
  server-side surface + device; frames reach the host window.
- `ReserveSurface`/`InjectSurface` exist and mirror the texture reserve/inject
  pattern.
- The host output window's Wayland client connection must live in the GPU
  process (a `wl_surface` is not shareable across processes). This corrected
  the original "core is the Wayland client of the host" framing.

### Upstream Dawn fix (made and published)
- `dawn::wire::server::Server::~Server()` crashed at process exit when it owned
  a configured swapchain: devices were destroyed before surfaces, so the
  swapchain detach in `~Surface` dereferenced freed device state (SIGSEGV in
  `FencedDeleter`). Fixed by releasing surfaces before devices in `~Server`
  (`DestroyAllSurfaces()`). Committed to `jhanssen/dawn` (`7af36c5`) and
  published as the `-alpha2` release overdraw now consumes. overdraw verified
  against the published artifact.

## Not yet built (design only)

- **Live reload, WM / policy.** A real app can now map a window with both shm
  and dmabuf content end-to-end (see the two "end-to-end" sections above). Still
  missing: live handler reload; window management, focus, layout.
- **WM / policy in JS.** Window management, focus, layout — none built.
- **JS-owned core breadth.** The core is C++ + Node with a working trampoline
  and a frame event callback, but the protocol-handler/WM/plugin layers that
  "JS owns" per the design are unwritten.
- **Plugin model.** SDK, Worker isolation, watchdog, capability grants, restart
  policy — none built. (The dmabuf surface buffer path the SDK drives is proven
  single-device; see "dmabuf interop path".)
- **Multi-surface / real compositing.** Multiple surfaces, transforms, opacity,
  blending, client buffers, multi-output, damage — none done.
- **Cross-thread N-API marshaling.** `napi_threadsafe_function` for Dawn-thread
  callbacks not exercised.
- **Crash recovery.** GPU-process respawn + state replay not implemented (the
  teardown fix above de-risks part of it). A crash handler in the GPU process
  dumps a backtrace to `/tmp` (added while debugging the dmabuf path).
- **Phase 2 / Phase 3.** KMS/DRM, libinput, libseat, the session supervisor,
  and XWayland are untouched.

## Spikes

Throwaway de-risking experiments live in `spikes/` (git-ignored). Their
findings are folded into architecture.md; the code is not part of the build.
Notable: stage3 (in-process host window + swapchain), stage4 (surface over the
wire — the cross-process presentation proof).
