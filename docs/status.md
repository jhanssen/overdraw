# overdraw — implementation status

Tracks what is built and empirically proven versus what is still design only.
The design itself lives in `architecture.md`; this file is the ground truth for
"what exists right now."

Last updated: 2026-05-31 (rev 23).

## Protocol gaps & skeletons (READ FIRST)

What is advertised/wired but incomplete. These are the silent-gap risks — a
client may use them and get nothing, with no error. Listed worst-first. (Fully
working protocols are in "Built and proven"; this is the honest incomplete list.)

- **`xdg_toplevel` window-management requests — SILENT no-ops.** `move`, `resize`,
  `set_maximized`/`unset`, `set_fullscreen`/`unset`, `set_minimized`,
  `set_min_size`/`set_max_size`, `show_window_menu`, `set_parent` are accepted and
  IGNORED (no effect, no signal). Only `set_title`/`set_app_id` do anything.
  Gated on a real WM/policy layer (placement is a cascade stub; there is no
  maximize/fullscreen/interactive-move concept yet). Until that exists, these
  stay no-ops — but they are advertised, so clients think they work.

- **`wl_output` — FABRICATED.** It advertises one "monitor" whose refresh (60Hz),
  scale (1), transform, geometry (0,0), physical size, and make/model are all
  HARDCODED FICTION. The reported size is the nested host *window* size, not a
  real monitor. There is also NO host-window-resize handling: resizing the
  overdraw window does not update the output, the swapchain, the WM layout, or
  input coordinate mapping (all assume the initial size, scale 1, identity
  mapping). Doing `wl_output` properly = implementing output reconfiguration
  end-to-end: GPU process reads the host's real `wl_output` + tracks host-window
  resize → forwards to core → core updates output size → JS resends
  geometry/mode/scale/done → WM re-lays-out + input mapping + swapchain
  reconfigure. Build an output-backend SEAM (like the input backend) so phase-1
  (host output) and phase-2 (DRM connectors/EDID/hotplug) swap underneath without
  touching the WM/compositing/`wl_output` layers. Cross-cutting; its own subsystem.

- **`wl_region` — no-op stub.** `add`/`subtract` do nothing; opaque/input regions
  are not tracked (hit-testing uses whole-window rects). Low urgency.

- **Smaller flagged gaps (already noted in their sections):** `wl_subsurface`
  `place_above`/`place_below` sibling reordering (no-op); DnD drag-icon
  compositing (implemented, not pixel-tested); dmabuf `create` (async server-minted
  wl_buffer) not wired (the trampoline primitive now exists); single-plane dmabuf
  only; `wl_data_device` is complete (clipboard + primary + DnD).

- **Protocols foot probes that are advertised-absent (clean fallback, not gaps):**
  xdg-decoration (→ CSD), fractional-scale, cursor-shape, text-input, xdg-activation,
  toplevel-icon, system-bell. Not implemented; clients warn and fall back. See the
  protocol-coverage matrix lower in this file.

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
- **Fully non-blocking IPC (both sockets, both ends).** No write may ever park:
  a single-threaded peer blocked in `write()` (waiting for a full socket buffer
  to drain) while the other waits to be read is a mutual deadlock — observed
  under sustained WSI client traffic (GPU process parked in `FdSerializer::Flush`
  → `write` while the core's commit waited for its reply). Now: all fds are
  `O_NONBLOCK`; writers buffer what the socket can't take and drain on writable.
  - `native/ipc/transport.h`: `FdSerializer` queues framed wire batches and
    writes what fits (`Flush` never blocks; `pumpOut` drains on writable);
    `FrameReader` accumulates partial reads into whole frames; `CtrlSender`
    buffers SEQPACKET control datagrams (dup'ing fds when queued). Blocking
    `sendMessage`/`sendMessageFds` shims remain for the one-shot startup/handshake
    path only.
  - GPU process: an **`EventLoop` abstraction** (`gpu-process/src/event_loop.h`)
    with an **epoll** backend (`event_loop_epoll.cpp`) multiplexes wire / ctrl /
    host-`wl_display` fds; arms `kWrite` only when wire output is queued. The
    interface is backend-agnostic so a kqueue (BSD/macOS) backend can be added
    later. Replaced the prior `usleep` spin. Steady-state loop ~190 Hz (not a
    busy loop).
  - Core: libuv `uv_poll` arms `UV_WRITABLE` on the wire fd only when output is
    queued (`armWirePoll`), draining via `wirePumpOut`.
  - Ordering hazard fixed: a ctrl request (`ImportClientTex`) must not overtake
    the wire commands it depends on. Mechanism (traced through Dawn wire source,
    verified): `WireClient::ReserveTexture` emits NO wire command — it just
    allocates a client-side handle id, recycling freed ids with generation+1
    (`client/ObjectStore.cpp`). When the core drops the previous reserved/injected
    `wgpu::Texture`, `Client::Unregister` sends an `UnregisterObjectCmd` over the
    WIRE and recycles that id at generation+1 (`client/Client.cpp:196`). The GPU's
    server-side `InjectTexture` → `Allocate` requires the slot's recorded
    generation to be **strictly less** than the injected handle's generation
    (`server/ObjectStorage.h:243`), which holds only after the server has
    processed that `UnregisterObjectCmd`. `ImportClientTex` travels over CTRL; if
    it overtakes the still-queued wire UnregisterObjectCmd, the server slot still
    has the old generation → `Allocate` FatalError → `InjectTexture failed`.
    (NOT "the ReserveTexture command must arrive first" — there is no such
    command; an earlier note here said that and was wrong.)
  - Fixed with a **cross-channel wire serial** (no blocking): `FdSerializer`
    counts cumulative framed wire bytes (`bytesQueued`); the core flushes the
    reserve and tags `ImportClientTex` with that value (`Message.wireSerial`);
    the GPU's `FrameReader` counts framed bytes consumed (`bytesConsumed`) and
    **defers** the import (queued in `pendingImports`) until
    `bytesConsumed >= wireSerial` — i.e. the prior `UnregisterObjectCmd` has been
    handed to the wire server. Drained after every wire pump. This is an explicit
    happens-before across the two sockets with no `write()`/poll blocking.
    Verified: 0 `InjectTexture failed` across active + idle runs; an active run
    sustained 146 commits / 142 releases with no starvation.
  - Wire socket `SO_SNDBUF`/`SO_RCVBUF` enlarged to 8 MiB (`gpu_process.cpp`) so
    the kernel keeps draining queued bytes while we are busy (userspace buffering
    still covers the case where even that fills).
- **Async dmabuf commit (the prior synchronous wart is fixed).**
  `commitSurfaceDmabuf` no longer blocks: it reserves the texture handle, sends
  `ImportClientTex` (fd via SCM_RIGHTS), records a `PendingImport` keyed by the
  reserved texture handle id, and returns immediately. The held reservation
  (neither `Acquire`'d nor `Reclaim`'d until the reply) keeps its handle id from
  being recycled while in flight. The GPU process imports + injects
  asynchronously (already non-blocking, deferring on the wire serial) and replies
  `ClientTexImported`; the reply is dispatched on the Node thread by
  `Compositor::drainCtrl()` (`finishImport`: retire superseded buffer, adopt the
  injected texture, build bind group, mark present, report imported).
  - PREREQUISITE built: a **steady-state ctrl-fd drain**. `ctrlFd_` is now
    registered with libuv (`uv_poll` in `addon.cpp` → `onCtrlReadable` →
    `drainCtrl`); `onWireReadable` also calls `drainCtrl` after `drainWire` (the
    wire advancing may release deferred GPU-side imports). Replies are matched by
    reserved-texture handle id; per surface they complete in send order.
  - **Unified map-on-first-content.** Both shm and dmabuf commits now report
    presentable surfaces via `Compositor::takeImportedSurfaces()` (id + content
    size). The JS sweep in `dispatchFrameCallbacks` (`src/protocols/index.ts`)
    maps a toplevel on its first reported content (WM place + focus). The old
    inline map in `wl_surface.commit` (which relied on the synchronous dmabuf
    return) is gone; `commit` no longer infers map for either path. A
    `surfacesById` map gives the sweep id→record lookup.
  - **(HISTORICAL) Async readback.** This section documents the original
    native-compositor commit/readback path (`commitSurfaceShm`/`commitSurfaceDmabuf`,
    `surfaceReadback`, the `*-upload-smoke.mjs` tests). That path was REMOVED with
    the C++ compositing pass; compositing + readback now live in JS (see
    "Compositing pass runs in JS over the Dawn wire"). The two-process spine,
    non-blocking IPC, and async dmabuf import below remain accurate. Original note,
    for reference (RTX 5060 / driver 595.71.05): `dmabuf-upload-smoke.mjs` PASS
    (pixel-exact red, 0 bad components, 3/3 runs); `shm-upload-smoke.mjs` PASS
    (pixel-exact blue) through the unified path; structural `node --test` suite
    8/8. No leaked GPU process.
  - Steady state is now fully libuv-driven with no `write()`/pump blocking on the
    Node thread. Multi-client per-commit occupancy was not separately re-measured;
    the per-commit round-trip wait (the ~1.7 ms previously charged to the event
    loop) is eliminated by construction.
  - Further option (only if measured necessary): move the wire socket `write()`
    off the Node thread to a writer worker. Serialization (Dawn `Flush`, not
    thread-safe) stays on Node and produces framed bytes into the serializer's
    existing `out_` queue; a worker drains `out_` to the socket (write-only —
    inbound `HandleCommands` must stay on Node). The buffered transport already
    makes this a clean producer/consumer seam. NOT done; no measured write-path
    bottleneck yet.

### GPU process threading (Dawn facts verified; NOT yet implemented)
The GPU process pump (wire decode + `HandleCommands` + `DeviceTick` + present) is
**single-threaded today**. There is no measured bottleneck (steady state ~190 Hz),
but the design admits true parallelism because core and each plugin are independent
devices. Verified against the vendored Dawn (`~/dev/dawn`) so the threading model
rests on facts, not assumptions:

- **Each `wgpu::Device` is its own `VkDevice`.** `Device::Initialize` →
  `CreateDevice` → `vkCreateDevice` per Dawn device, on the shared
  `VkPhysicalDevice` (`src/dawn/native/vulkan/DeviceVk.cpp:129,758`). So core + each
  plugin get distinct `VkDevice`/`VkQueue`s and distinct submit timelines — no
  driver-side serialization point between them. Cross-device sharing is
  dmabuf-import-per-device + `SharedFence` (`SharedTextureMemoryVk.cpp` imports the
  dmabuf as a fresh `VkDeviceMemory`/`VkImage` on each `GetVkDevice()`), NOT a shared
  device handle or any GL-style shared-object namespace.
- **Dawn is thread-safe only under `Feature::ImplicitDeviceSynchronization`**
  (stable; `src/dawn/native/Features.cpp:168`), which makes public API methods safe
  across threads via a **per-device** `DeviceMutex` (`Device.h:694`) — with two
  caveats: (1) command **encoding is excluded** (encoders are never thread-safe;
  each must live on one thread), and (2) it is a lock, so calls to the *same* device
  serialize (correctness, not parallelism).
- **Implied model: thread-per-connection ownership, NOT the global feature.** Because
  the mutex is per-device, the clean design is one OS thread per wire connection,
  each thread *exclusively* owning its device (read socket → `HandleCommands` →
  encode + submit → `DeviceTick`). No device is touched by two threads, so
  `ImplicitDeviceSynchronization` is unnecessary (avoids the lock overhead AND the
  encoding restriction) and core/plugins ingest + submit in genuine parallel.
  Reserve the feature only for a device that must be touched by >1 thread.
- **What stays shared and must be guarded (NOT shardable per connection):** the
  `wgpu::Instance`/adapter, the GBM allocator, and the single DRM-master/KMS state
  (scanout ring + page-flip loop). Natural shape: N parallel per-connection device
  threads + one KMS/present thread owning the scanout ring + shared instance/allocator
  behind their own locks.
- Structurally simple (the per-connection seam mostly exists), but not literally
  trivial: the shared instance/allocator/KMS state above needs explicit locking, and
  Dawn-internal callback threads must be kept on the owning thread (pump
  `AllowProcessEvents` there) or routed carefully. **Decision: do it; sequence after
  the phase-2 KMS present loop lands so the KMS/present thread is the obvious home
  for the shared bits.** No correctness blocker found.

### JS layer / event loop (core is C++ + Node)
- The core is C++ + Node as the architecture specifies. Node owns `main()` and
  the libuv loop; the N-API addon (raw `node_api.h` C API, to avoid
  node-addon-api's exception/RTTI dependence under `-fno-rtti`) holds the native
  core. One-shot bring-up runs blocking inside `start()`; the **steady-state
  present loop is libuv-driven** — a `uv_poll_t` on the wire fd drains inbound
  wire frames and a `uv_timer_t` (~16ms) paces frame render+present. No
  hand-rolled C++ spin loop in steady state.
  - **GAP / divergence: the ~16ms timer is NOT the intended frame clock.** The
    architecture's frame loop is event-driven off a display-side completion
    signal (host `wl_surface.frame` callback in phase 1, KMS page-flip in phase
    2), NOT a free-running timer — a timer has no causal link to refresh and
    beats against real vsync (waste/stutter, and tearing/stalls under direct
    KMS). The timer is a phase-1 shortcut because Dawn's WSI swapchain owns
    `Present` and hides the host frame callback. The documented frame-loop
    trigger ("phase 1: host `wl_surface.frame` callback") is therefore NOT
    implemented today. See architecture.md "Frame clock: the trigger must
    originate at the display" and "Phase-2 present: a self-managed scanout
    swapchain" for the intended model (GPU-process `FrameDone`/`Present`
    side-channel events drive the loop; the timer is deleted).
- A **C++ -> JS event path** works: an optional `onFrame` JS callback is invoked
  from the frame timer (direct `napi_call_function`, same Node thread). The
  cross-thread path (Dawn-internal-thread callbacks -> `napi_threadsafe_function`)
  is **not yet exercised**.
- The **compositing renderer runs in JS** (see "Compositing pass runs in JS over
  the Dawn wire") — the documented C++/JS divergence is closed; there is no C++
  compositing pass. Protocol handlers are in JS (`src/protocols/`). Still
  C++-internal or absent: WM/policy beyond the placement stub, and the plugin
  model.
- Server-side Wayland (`wl_event_loop`) IS integrated into the libuv loop (see
  "Wayland server + generic trampoline"); the core is a real Wayland server. No
  host-window-resize handling. Host *input* arrives in the core (see "Host input
  forwarding") and both **pointer and keyboard** input are routed to clients via
  `wl_seat`/`wl_pointer`/`wl_keyboard` (see "Input routing to clients").

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
- Verified originally on the RTX 5060 / Hyprland with a real host seat: pointer
  enter/motion/frame and keyboard enter/key/modifiers all reach the JS callback;
  coordinates and evdev keycodes correct. The interactive harness that proved
  this (`test/input-smoke.mjs`) has since been REMOVED (interactive); the durable
  normalization + routing is now covered automatically by `injectHostInput` (see
  "Testing"). The host-seat→socket forwarding it also exercised is phase-1
  nesting scaffolding, not a durable path.
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
  surface, with **surface-local** pointer coordinates.
- **Focus policy is configurable** (`FocusOptions` via `installProtocols({ focus })`,
  interim until a real config system). Pointer events always follow the pointer
  (correct Wayland). *Keyboard* focus is governed by the policy: `follow-pointer`
  (default — keyboard focus tracks the surface under the pointer) or
  `click-to-focus` (focus changes on button press, persists when the pointer
  moves away). `focusOnMap` (default true) gives a freshly-mapped window keyboard
  focus so a launched app is typeable immediately — this fixed the "must click
  first" symptom (a window mapping under a stationary pointer otherwise never got
  a motion event to focus it under follow-pointer).
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
  release). Verified with real clients: `foot` and `kitty` both focus on map and
  type without a click (follow-pointer + focus-on-map). **PASS.**
- Not built: client cursor surfaces (`set_cursor` is a no-op; no software
  cursor), touch, multi-seat, key-repeat generation (repeat_info sent; client
  repeats), axis source/discrete refinement. kbFocus is not auto-moved when the
  focused window is closed (re-resolves on next pointer event; guarded against
  use of a destroyed surface).

### Real upstream client: `foot` runs end-to-end (verified)
An unmodified upstream `foot` terminal (1.25.0) connects, renders, and is
interactive in overdraw. Launch via `npm run compositor` (`src/main.ts`), which
brings up the compositor, starts the server, installs protocols, wires input,
prints `WAYLAND_DISPLAY`, and runs until SIGINT.

- Globals added so `foot` (and similar shm/buffer clients) get past startup:
  `wl_subcompositor`/`wl_subsurface`, `wl_output` (advertises one monitor at the
  host logical size, scale 1, 60Hz), `wl_data_device_manager`/`wl_data_device`/
  `wl_data_source`. `wl_callback` (frame callbacks). `zwp_linux_dmabuf_feedback_v1`
  (minimal `done`, crash-fix from earlier).
- **Frame callbacks** (`wl_surface.frame` → `wl_callback.done`): the JS layer's
  `dispatchFrameCallbacks` fires every compositor frame (driven from the now-
  per-frame `onFrame` hook). Without this a client renders one frame and waits
  forever — the bug that made `foot` show only its initial background.
- **Color fix**: the host advertises `RGBA8UnormSrgb` first; using it
  double-encoded sRGB (client bytes are already sRGB, the shader passes them
  through, an sRGB swapchain re-encodes → too bright). The GPU process now picks
  the first **non-sRGB** advertised format. Pass-through is correct for opaque
  content; NOTE alpha blending now happens in sRGB space (technically wrong for
  translucency — the proper linear-compositing pipeline is future work).
- Verified: `foot` renders its prompt, types interactively (keyboard routed,
  confirmed by running a command), colors match a real compositor. **PASS.**
- LIMITATIONS hit by `foot`, flagged: subsurfaces ARE composited with correct
  sync/desync commit semantics (see "Subsurface compositing" below); the only
  remaining subsurface gap is place_above/below sibling reordering (no-op);
  clipboard + primary selection ARE implemented now (see "Clipboard" below; DnD on
  the same interfaces is still a loud-no-op stub); no server-side decorations,
  fractional scale, xdg-activation, cursor-shape, text-input (advertised-absent →
  `foot` warns and falls back).
- `kitty` also runs (hardware EGL — no `LIBGL_ALWAYS_SOFTWARE` needed — renders,
  focuses on map, types). The pool-refcount fix (see "shm") was required: kitty
  creates buffers then destroys the pool before rendering.
- **dmabuf feedback is a stub** (minimal empty `done`, no `main_device`/
  `format_table`). GPU clients using `zwp_linux_dmabuf_v1` *feedback* to pick a
  render device get nothing and fall back (kitty logs
  `libEGL ... failed to get driver name for fd -1` / `MESA-LOADER` warnings, then
  works via fallback on this single-GPU setup). Real feedback (main_device +
  format_table + tranche, buildable from the GPU process's DRM device +
  `Allocator::usableModifiers`) is unbuilt — cosmetic for kitty here, but the
  correct implementation of a currently-stubbed protocol.

### Vulkan-WSI clients run (verified end-to-end on NVIDIA)
A client that presents via a Vulkan/WebGPU **swapchain on its `wl_surface`**
(Dawn `SurfaceSourceWaylandSurface` → `vkCreateWaylandSurfaceKHR` +
`vkCreateSwapchainKHR`) now runs interactively under overdraw. Verified
2026-05-30 with the MasterBandit terminal (Dawn/Vulkan WSI) on RTX 5060 / driver
595.71.05: it configures its swapchain, renders text, updates live, and sustains
continuous output without stalling. (An earlier revision of this file framed WSI
support as an "architectural boundary / out of scope"; that was wrong. WSI
clients are supported.)

This took four distinct fixes, each verified:

1. **Real dmabuf default-feedback** (`zwp_linux_dmabuf_v1` v4+ feedback). A
   Vulkan WSI advertising dmabuf v4+ derives swapchain formats ONLY from feedback
   (`format_table` + `tranche_formats`), ignoring the legacy `format`/`modifier`
   events. overdraw previously stubbed feedback (`done` only) → empty format list
   → `Surface.Configure(BGRA8Unorm)` rejected. Now the GPU process probes Dawn
   (`GetFormatCapabilities` + `DawnDrmFormatCapabilities`) for each format, builds
   the format_table (a sealed memfd, `{format u32, pad u32, modifier u64}`
   records), and ships it + `main_device` (DRM render-node dev_t) to the core via
   a `FeedbackData` side-channel message; the JS `zwp_linux_dmabuf_v1` handler
   sends `format_table` + `main_device` + one tranche + `done`.
   (`gpu-process/src/allocator.cpp` `probe`/`formatTable`, `gpu-process/src/main.cpp`
   FeedbackData, `native/napi/addon.cpp` `dmabufFeedbackInfo`,
   `src/protocols/zwp_linux_dmabuf_v1.ts` `sendFeedback`.)

2. **Advertise BOTH the alpha and opaque DRM fourcc per format.** A BGRA8 swapchain
   needs ARGB8888 **and** XRGB8888 advertised (the WSI picks the opaque sibling for
   an opaque surface). overdraw mapped `BGRA8Unorm → ARGB8888` only; adding the
   XRGB8888/XBGR8888/XBGR2101010 opaque variants (same modifiers) was the actual
   fix for the `Configure` rejection (NOT a Vulkan-vs-GBM modifier conflict, which
   was a mis-diagnosis). (`allocator.cpp` `fourccsFor`.)

3. **wl_seat/wl_pointer/wl_keyboard event version gating.** The NVIDIA WSI binds
   `wl_seat` at v1; overdraw sent `wl_seat.name` (since v2) / `wl_pointer.frame`
   (v5) / `wl_keyboard.repeat_info` (v4) unconditionally, aborting the client
   ("listener for opcode N is NULL"). Events are now gated on the resource's bound
   version (exposed JS-side as `Resource.version`). (`native/wayland/trampoline.cpp`,
   `src/protocols/wl_seat.ts`.)

4. **dmabuf buffer-release lifecycle.** A swapchain client blocks in
   `vkAcquireNextImageKHR` until the compositor releases buffers it has finished
   reading. overdraw samples client dmabufs zero-copy, so a buffer can only be
   released once the compositor frame that sampled it COMPLETES on the GPU. The
   compositor now tags each frame's submit with a serial + `OnSubmittedWorkDone`;
   a buffer superseded by a newer commit is freed once its retire-serial completes,
   and the freed bufferIds are reported to JS which sends `wl_buffer.release`.
   (`native/core/compositor.cpp` retiring_/freed_/`OnSubmittedWorkDone`,
   `src/protocols/index.ts` release sweep via `takeFreedBuffers`.)

The implicit-sync acquire (export the client dmabuf's read fence via
`DMA_BUF_IOCTL_EXPORT_SYNC_FILE`, import as a Dawn `SharedFence`, wait on it in
`BeginAccess`) is also implemented (`gpu-process/src/main.cpp`
`exportDmabufAcquireFence`), mirroring wlroots' implicit-sync interop.

Reference used: wlroots' Vulkan renderer (`render/vulkan/renderer.c`,
implicit-sync interop) and Mesa's `src/vulkan/wsi/wsi_common_wayland.c` (the
compositor-facing WSI contract). Hyprland's `LinuxDMABUF.cpp` was used to compare
on-wire feedback.

### Compositing pass runs in JS over the Dawn wire (dawn.node) — MIGRATION COMPLETE
The compositing pass lives entirely in core main-thread JS now (the documented
C++/JS "renderer in JS" divergence is closed). The C++ `Compositor` was reduced
to a WSI + interop service; there is no C++ compositing pass. WebGPU is exposed
to JS via a wire-retargeted `dawn.node` (see architecture.md "Exposing WebGPU to
JS"). This is also the foundation for the future plugin `sdk.gpu`.

- **Wire-retargeted `dawn.node`** (`jhanssen/dawn` @ `f01cb22e5c`, release
  `v20260531-linux-wayland-wire-alpha`, consumed by `3rdparty/dawn`): proc table
  = wire client; `wrapDevice(instanceHandle, deviceHandle)` and
  `wrapTexture(deviceHandle, textureHandle)` wrap host-provided wire handles into
  GPUDevice/GPUTexture; `AsyncRunner` pumps a `wgpu::Instance`; a wrapped device
  is borrowed (not Destroy()ed). Built with `-Wl,--exclude-libs,ALL` (else the
  bundled abseil interposes with V8's abseil → crash at `requestAdapter`).
- **`src/gpu/compositor.ts` (`JsCompositor`)** is THE compositor: WGSL pipeline +
  sampler, per-surface view/uniform/bind group, render pass (placement +
  premultiplied blend, JS-owned stack), submit. It implements the `CompositorSink`
  interface the protocol/WM layer drives (`commitSurfaceBuffer`/`commitSurfaceDmabuf`/
  `setSurfaceLayout`/`setStack`/`removeSurface`/`takeImportedSurfaces`/
  `takeFreedBuffers`/`renderFrame`). Headless renders into an owned offscreen
  target (read back, 256-aligned); nested presents to the host swapchain.
- **Native services kept** (the non-wire-propagatable / WSI bits): surface
  bring-up + `Configure`, `acquireOutputTexture`/`presentOutput`/`outputFormat`
  (host swapchain), `createTextureFromDmabuf` + `releaseDmabufImport` (dmabuf
  reserve/inject + STM/fd release, generation-matched), `shmView` (zero-copy
  external `ArrayBuffer` over the client shm mapping), `gpuHandles`, the wire link.
- **shm** (slice 1/1b): `commitSurfaceBuffer` → `shmView` + `queue.writeTexture`.
  **dmabuf** (slice 2): `createTextureFromDmabuf` (async, returns a Promise of the
  wire handle) → `wrapTexture` → sample; JS owns the buffer-release lifecycle
  (submit serial + `queue.onSubmittedWorkDone` → `wl_buffer.release` + explicit
  `ReleaseClientTex` of the server STM/fd). **nested present** (slice 3):
  `acquireOutputTexture` → wrap as render attachment → present. **slice 4**:
  deleted the C++ compositing pass; the JS compositor is the only path.
- **Lifetime/teardown fixes (load-bearing)**: JS WebGPU finalizers run at exit and
  call into the C++ wire client, so the client is `Disconnect()`'d but leaked at
  teardown (else UAF/SIGSEGV); the wire pump runs under an N-API `HandleScope`
  (resolves `dawn.node` promises); `stop()` drains the wire after halting the
  frame timer so the last `onSubmittedWorkDone` resolves Success before Disconnect
  (dawn.node throws on a cancelled callback).
- **Verified**: all GPU tests (`test/*.gpu.mjs`) run on the JS compositor —
  shm/dmabuf/subsurface/popup pixels, integration, clipboard, DnD, protocols,
  nested present, and a dmabuf buffer-cycling **leak test** (GPU-process fd count
  stays bounded over 40 cycled buffers → `ReleaseClientTex` reclaims). `foot`
  (shm) and a Vulkan-WSI terminal (dmabuf cycling) run on it manually. The
  launcher (`main.ts`) presents on the JS compositor on-screen.
- **Remaining gaps (flagged)**: on-screen (nested) PIXEL correctness is not
  auto-asserted (no post-present readback; it is inherited from the headless
  pixel tests, same render pass). The host-window frame clock is still a ~16ms
  timer, not display-driven (pre-existing divergence; see below).

### Config system (user config: --config / XDG, verified)
`src/config/` loads user config from `--config <path>` (hard error if missing)
else `$XDG_CONFIG_HOME/overdraw/config.*` then `~/.config/overdraw/config.*`,
probing `.ts/.cts/.mts/.js/.cjs/.mjs` (Node 24 native type-stripping; no
transpile). Default export may be an object or a (sync/async) function. Validates
`focus`/`output`; the launcher applies them. Unit tests in `test/config.test.js`.
- The `plugins` array is parsed, validated (`module` required; `name`/`restart`/
  `maxRestarts`/`windowSeconds` validated), and resolved (defaults applied), and
  is now CONSUMED by the plugin runtime (see "Plugin runtime (scope B)"). The
  capability sub-grant schema is not yet validated (lands with the GPU/window
  SDK).

### Plugin runtime (scope B: isolation + lifecycle + watchdog + restart; NO GPU/SDK surface yet)
A plugin module loads in its own worker_threads Worker, runs `init(sdk)`, and is
contained + supervised per architecture.md ("Plugin model"/"Lifecycle"/
"Isolation"/"Restart policy"). This is the lifecycle/isolation skeleton ONLY:
there is intentionally NO GPU, window, surface, output, capture, input, or
protocol SDK surface yet (those need the cross-device dmabuf producer/consumer
path, which is unverified — see "dmabuf interop path", "Not done"). A plugin in
scope B can do exactly: log, and register `onShutdown`.

- `src/plugins/protocol.ts`: the architecture's Worker↔core envelope
  (`{kind:'request'|'response'|'event'}`) with a pending-promise table, plus
  `ping`/`pong` control messages (kept OUTSIDE the request table so watchdog
  liveness never interacts with in-flight requests). Transport-agnostic
  (`Channel`); `channelFor()` adapts a Worker/MessagePort with no cast.
- `src/plugins/bootstrap.ts` (runs IN the Worker): builds the SDK, dynamically
  `import()`s the plugin module, calls its default `init(sdk)`, reports
  resolve/reject as an `init` event, auto-pongs pings (responsive event loop =
  liveness), and handles the `shutdown` request by running `onShutdown`.
- `src/plugins/sdk.ts`: the capability-shaped SDK object. Scope B exposes
  `name`, `log(...)`, `onShutdown(cb)`. All GPU/window/etc. methods are ABSENT
  (capabilities enforced by object shape per the design).
- `src/plugins/runtime.ts`: `PluginRuntime` owns one Worker per plugin with
  `resourceLimits.maxOldGenerationSizeMb` (heap cap), the lifecycle state
  machine (`spawning`→`live`→`shutting-down`/`failed`), the **watchdog**
  (core pings every N ms; >K missed pongs → `worker.terminate()`), and the
  **restart policy** (`on-failure` up to `maxRestarts` in a rolling
  `windowSeconds`, then permanently `failed`; `never` disables; init failure
  counts toward the budget). Graceful `stop()` awaits `onShutdown` up to
  `shutdownTimeoutMs` then terminates; forced paths (crash/OOM/watchdog) skip
  the callback. Timing tunables are injectable (fast tests).
- Wired into `src/main.ts`: configured plugins load after the server is up;
  plugin `module` paths (absolute / `./` / `../`) resolve relative to the config
  file's dir, bare specifiers pass through. Plugin `log` events are printed.
- **Verified** (`test/plugins.test.js`, GPU-free `node --test`, spawning REAL
  Workers + real fixture plugins in `test/fixtures/plugins/`): well-behaved
  plugin reaches `live`; init reject / missing-default-export → `failed`;
  graceful stop runs `onShutdown`; never-resolving `onShutdown` hits the
  shutdown timeout (no hang); a LIVE plugin that wedges its event loop in a hot
  loop is terminated by the watchdog and, after exhausting the restart budget,
  ends `failed`; OOM past the heap cap aborts the Worker and drives restart;
  multiple plugins are independent (one fails, one stays live). **PASS.**
- **GAPS / unbuilt (flagged):**
  - **No GPU/window/surface/output/capture/input/protocol SDK.** A scope-B
    plugin cannot draw, take input, or implement a protocol. The producer/
    consumer surface path it would use is unproven cross-device (see "dmabuf
    interop path"). This is the next plugin milestone, not done.
  - **No native-import restriction.** architecture.md says a custom Worker
    module loader rejects non-allowlisted native addons. NOT built — a scope-B
    plugin's `import()` is unrestricted. Deferred until there is an SDK native
    addon to allowlist; until then plugins are NOT sandboxed against loading
    arbitrary native modules. (Acceptable per "malicious plugins out of scope,"
    but it is a real unbuilt isolation control, flagged here so it is not
    mistaken for done.)
  - **Watchdog limit.** A missed pong proves the Worker EVENT LOOP isn't
    turning (catches hot loops + JS-level blocking). A plugin blocked in a
    synchronous NATIVE call would also miss pongs, but `terminate()` acts at JS
    boundaries and may not interrupt arbitrary native blocking. Scope B has no
    plugin-facing blocking native calls, so this is moot today; relevant once
    the SDK gains native methods.
  - **No capability sub-grant enforcement / config schema.** `capabilities` in
    plugin config is not validated or applied (no capabilities exist to grant).

### Compositing (multi-surface: per-surface placement + stacking + blending)
- The textured-quad compositing pass runs in JS (`src/gpu/compositor.ts`; see
  "Compositing pass runs in JS over the Dawn wire"): each surface drawn into its
  layout rect (per-surface uniform = normalized output rect), JS-owned
  back-to-front stack order, premultiplied-alpha blend, clear to black when empty.
- **Multi-surface verified** (`test/compositing.gpu.mjs`, headless pixel readback):
  two real shm clients composite at distinct cascaded positions; top-of-stack wins
  the overlap. **PASS**.
- Placement seam: the compositor consumes geometry only via the `CompositorSink`
  — `setSurfaceLayout(id,x,y,w,h)` and `setStack(ids[])`; JS owns it. `src/wm/
  index.ts` holds the window list/stack and pushes layout+order to the sink;
  `src/wm/placement.ts` is a STUB (cascade) — the one throwaway policy piece, to
  be replaced by a real layout model (dynamic tiling + floating) without touching
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
  resize handling. Output logical size == host window size (scale 1); `wl_output`
  is otherwise FABRICATED and there is no resize handling — see "Protocol gaps &
  skeletons (READ FIRST)" at the top. Pointer + keyboard routing to clients IS
  done (see "Input routing to clients").

### Client shm buffers end-to-end (upload → composite → present, pixel-verified)
NOTE: the IMPLEMENTATION below (`commitSurfaceShm`, native `WriteTexture`) was
replaced by the JS compositor — shm upload now goes JS-side via `addon.shmView`
(zero-copy `ArrayBuffer`) + `queue.writeTexture` (see "Compositing pass runs in
JS over the Dawn wire"). The capability (real shm client composites, pixel-
verified) still holds; the mechanism described here is historical.

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
NOTE: the IMPLEMENTATION below (native `commitSurfaceDmabuf` building the C++
compositing state) was replaced by the JS compositor — dmabuf import is now
`addon.createTextureFromDmabuf` (async, returns the wire handle) + dawn.node
`wrapTexture`, with JS owning the buffer-release lifecycle (see "Compositing pass
runs in JS over the Dawn wire"). The GPU-process import primitive (reserve →
`ImportClientTex`/inject → `ReleaseClientTex`) is unchanged. The capability still
holds; the core-side mechanism described here is historical.

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
  with the fd, then return (NON-BLOCKING — see "Async dmabuf commit" above). The
  `ClientTexImported` reply is later dispatched by `drainCtrl()` on the Node
  thread, which wraps the injected handle as a `wgpu::Texture` and builds the
  per-surface bind group — plugging into the same `clientSurfaces_` compositing/
  readback path as shm.
- Verified end-to-end (`test/dmabuf-test-client.c` + `test/dmabuf-upload-smoke.mjs`,
  needs GPU + host Wayland): client GBM-allocates a LINEAR ARGB8888 buffer filled
  solid red, sends it via `create_immed`, maps an `xdg_toplevel`, commits; the
  compositor imports the client dmabuf, composites, presents. GPU readback
  confirms pixel-exact red (BGRA `[0,0,255,255]`). **PASS.**
- Limitations: single plane only; `create` (async, server-minted wl_buffer) is
  NOT wired up here — though the trampoline CAN now mint a server-side new_id for
  an event (added for clipboard `data_offer`; see "Clipboard"), so this is now a
  matter of wiring the dmabuf `create` path, not a missing primitive. Today only
  `create_immed` (client supplies the buffer id) is used; no per-frame
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
- **Two-device cross-device sharing + cross-device fence wait: NOW VERIFIED**
  (was "assumed to work, unverified"). See "Cross-device dmabuf+fence verified
  (C-M1)" below. Still not done: multi-plane / YUV import; SCM_RIGHTS fence
  passing *cross-process* (the verification is in-process, two devices in the GPU
  process — the cross-PROCESS plumbing is C-M2).

### Cross-device dmabuf + fence verified (C-M1, the plugin producer/consumer primitive)
The one composition the plugin-surface design rested on as "assumed, unverified"
is now proven on the verification hardware (RTX 5060 / driver 595.71.05): two
independent `wgpu::Device`s sharing ONE GBM dmabuf, with a producer→consumer
handoff gated by a cross-device sync-fd fence.

- `overdraw-gpu-process --selftest-xdev` (`gpu-process/src/main.cpp`
  `selftestXDev()`): self-contained — NO wire, NO core, NO Worker. Each device is
  requested from its OWN adapter (a `wgpu::Adapter` mints one device; the plugin
  topology gives each device its own adapter anyway). Both devices require
  `SharedTextureMemoryDmaBuf` + `SharedFenceSyncFD`.
- Flow: one GBM dmabuf imported as `SharedTextureMemory` into BOTH devices
  (`Allocator::importTexture` is device-agnostic; STM props print twice,
  `usage=0x17`). Producer device A: `BeginAccess` (undefined→general) → render-
  pass CLEAR to a known color → submit → `EndAccess` → export a
  `SharedFenceSyncFD` (fenceCount=1), dup'd. Consumer device B: `BeginAccess`
  WAITING that fence (imported via `ImportSharedFence`, general→general,
  initialized) → `textureLoad`-sample the dmabuf into an offscreen RGBA8 target →
  `CopyTextureToBuffer` → `EndAccess` → map + readback. Asserts the read-back
  pixels equal the producer's color (±3/channel).
- **Verified**: `got RGBA(51,102,204,255) expected (51,102,204,255)` →
  `XDEV: PASS`. The fence wait in B's `BeginAccess` is the ordering proven
  (producer-done-before-consumer-read on the GPU timeline, no CPU handshake).
- Reuses the proven primitives: per-device STM import, the EndAccess sync-fd
  export (single-device path), and the SharedFence import + wait-in-BeginAccess
  (the verified WSI implicit-sync acquire). The bind group uses `textureLoad`
  (no sampler) to sidestep filterable-vs-unfilterable float sampling on the
  imported format.
- Test: `test/xdev-fence.gpu.mjs` spawns the selftest and asserts `XDEV: PASS`
  (GPU-gated; `npm run test:gpu`).
- **Scope of the claim:** in-process two-device on this driver. It does NOT yet
  prove the cross-PROCESS plugin path (second wire client + side-channel surface
  allocation + SCM_RIGHTS fence passing) — that is C-M2, built on this result.

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
  WM/policy (placement, focus, dynamic toplevel states — `xdg_toplevel`
  move/resize/maximize/fullscreen are silent no-ops); popups (`get_popup`) and
  positioners are no-ops. See "Protocol gaps & skeletons (READ FIRST)" at the top.

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

### Testing (pure-unit layer + state-query channel)
The reference compositors (wlroots, Hyprland) automate correctness via (1) pure
GPU-free unit tests and (2) a headless run + control-socket state queries +
synthetic input, asserting on geometry/focus/state strings — NOT pixel/golden
comparison (Hyprland's own tester flags visual testing as an open TODO). overdraw
follows the same model.

- **Pure-unit tests** (`npm test` → `node --test 'test/**/*.test.js'`, GPU-free):
  - `test/gen-protocol.test.js` — protocol-generator structural tests.
  - `test/placement.test.js` — the placement stub's cascade/wrap/clamp.
  - `test/wm.test.js` — `createWm` map/unmap (rect assignment, content-size
    fallback, idempotence, stack order pushed to a MOCK addon) + `windowAt`
    hit-testing (half-open bounds, topmost-on-overlap). The mock addon records
    `setSurfaceLayout`/`setStack` so the WM is tested without native/GPU.
  - `test/query.test.js` — the state-query channel snapshot.
  - `test/config.test.js` — config resolution/loading/validation.
  - (plus the protocol-coverage + server-only `*.test.js` listed below.)
  - All passing; no native build, no GPU, no Wayland.
- **State-query channel** (`src/query.ts`, `queryState(state)` → `StateSnapshot`):
  overdraw's analog of `hyprctl /activewindow` — a serializable, GPU-free snapshot
  of output size, windows (surfaceId + rect + title + app_id + role + mapped),
  back-to-front stack order, and pointer/keyboard focus surface ids. Attached to
  the state returned by `installProtocols` as `state.query()`. This is the seam a
  future integration harness asserts against (geometry/focus), without pixels.
- **Integration tests** (`npm run test:gpu` → `node --test 'test/*.gpu.mjs'`;
  require GPU + host Wayland, auto-skip when `WAYLAND_DISPLAY` unset). Drive REAL
  libwayland clients against the full stack and assert on `state.query()`
  (geometry / stacking / focus) — no pixel comparison, mirroring the reference
  compositors' model.
  - `test/harness.mjs`: brings up GPU process + present loop + server + protocols
    with input routed to the seat; `spawnClient(args)` (resolves on the client's
    "mapped" stdout line), `waitFor(query, pred)` (polls `query()` while yielding
    to libuv — completion-driven, not a timer guess), and `teardown()` that kills
    clients, stops the addon, and asserts NO GPU process leaked (scan by exact
    comm `overdraw-gpu-pr`, per the process-management rules).
  - `test/harness-client.c`: a controllable shm client — argv config (`--socket`,
    `--size WxH`, `--color AARRGGBB`, `--title`, `--app-id`), maps one toplevel,
    holds the surface until SIGTERM (harness controls lifetime; no sleeps).
  - **Synthetic input backend, two depths:**
    - `addon.injectInput(event)` feeds a normalized `InputEvent` directly into the
      `InputSink` the seat consumes (skips backend normalization).
    - `addon.injectHostInput(event)` feeds a forwarded `ipc::InputMessage` through
      the REAL `WaylandInputBackend` normalization (`convert()`, shared with the
      live `drain()` path: fixed-point↔logical, evdev codes, state/axis enums)
      then to the sink. Logical pointer coords are encoded to `wl_fixed_t` and
      converted back, exercising the round-trip. This is the analog of Hyprland's
      test plugin injecting at the input layer, reusing the existing
      `native/core/input.h` seam (no virtual-input protocol).
  - `test/integration.gpu.mjs`: client map→query (title/app_id/size),
    two-client stacking order, focus-on-map, follow-pointer focus enter/clear,
    click-to-focus press + persist-on-leave, plus two HOST-PATH tests via
    `injectHostInput`. All run HEADLESS now (no host window needed).
  - `test/compositing.gpu.mjs`: PIXEL tests against the headless offscreen
    frame — single client composites at its rect + black background; two clients
    at distinct positions both visible; top window wins the overlap (opaque
    stacking). Computed-expectation comparison (each client a known solid color
    at a `query()` rect, ±4/channel tolerance), no golden files.
  - `test/protocols.gpu.mjs`: protocol-delivery tests — `wl_output` (client
    receives a mode matching the output size + done), `wl_callback` (compositor
    fires `wl_surface.frame` → `wl_callback.done` each frame, client re-arms),
    `wl_keyboard` (key injected via the host path is delivered to the focused
    client as enter + key press/release). The harness-client reports what it
    RECEIVES on stdout; `spawnClient(...).waitForLine(re)` asserts it. (Fixed a
    latent harness-client bug: the hold loop dispatched the queue but never READ
    the socket, so server-sent events were never delivered — now polls + reads.)
  - `npm run test:gpu` runs `test/*.gpu.mjs` with `--test-concurrency=1` (each
    test owns the GPU + a compositor; serial avoids socket-name and
    GPU-process-leak-scan races).

### Headless mode (offscreen render, no host window)
- `addon.start(gpuBin, onFrame?, onInput?, { width, height })` runs HEADLESS: the
  GPU process is spawned `--headless WxH` (no `HostWindow`, no `wl_surface`, no
  host seat), brings up the device only, and skips `InjectSurface`/`SurfaceReady`;
  the core `Compositor` skips `ReserveSurface`/`Configure`/`Present`. Still
  requires the GPU. The JS compositor (`JsCompositor`, headless mode) creates its
  own offscreen `RenderAttachment|CopySrc` target (BGRA8Unorm) and renders into it.
- Frame readback is `JsCompositor.readback()` (the harness exposes it as
  `frameReadback()`): async `copyTextureToBuffer` + `mapAsync` of the offscreen
  target → tightly-packed BGRA. (The former native `addon.frameReadback`/
  `surfaceReadback`/`readbackTexture` were removed with the C++ compositing pass.)
- The real launcher (`main.ts`) passes no headless arg → stays NESTED (host
  window + swapchain), and presents on the JS compositor.
- **`input-smoke` removed** (was interactive — required a human to move the mouse
  / type over the nested window). Its durable, product-relevant coverage (the
  `WaylandInputBackend` normalization + seat routing → focus/clients) is now
  automated via `injectHostInput`. The only thing it additionally exercised was
  the phase-1 NESTING scaffolding — the GPU process binding the host
  `wl_seat`/`wl_pointer`/`wl_keyboard` (`host_window.cpp`) and `ipc::sendInput`
  forwarding over the socket — which is not a durable code path (it is replaced
  by a libinput backend at the same `InputBackend` seam in phase 2), so it is not
  worth an automated test. No interactive tests remain.
- **`compositing-eyeball` removed** (was interactive — a human confirmed two
  colored squares). Superseded by `compositing.gpu.mjs`, which asserts the same
  placement + distinct positioning automatically via pixel readback, and adds
  overlap-stacking coverage the eyeball test lacked. NO interactive tests remain.
- **Protocol coverage (what IS / is NOT behaviorally tested):**
  - Tested end-to-end: `wl_compositor`, `wl_surface` (attach/commit/frame),
    `xdg_wm_base`/`xdg_surface`/`xdg_toplevel` (configure, title/app_id),
    `wl_shm`/`wl_shm_pool`/`wl_buffer` (pixel-verified), `zwp_linux_dmabuf_v1`/
    `..._buffer_params_v1` (pixel-verified), `wl_seat`/`wl_pointer`/`wl_keyboard`
    (focus routing + key delivery), `wl_output` (mode/geometry), `wl_callback`
    (frame-callback delivery), `wl_data_device*`/`wl_data_offer` +
    `zwp_primary_selection_*` (CLIPBOARD selection round-trip, pixel-free, see
    "Clipboard"), `wl_subsurface` (sync/desync commit semantics, pixel-verified).
  - Implemented but NOT behaviorally tested: `wl_region` (no-op stub);
    `zwp_linux_dmabuf_feedback_v1` (feedback path; exercised by real WSI clients
    manually, no automated assertion).
  - `wl_data_device` drag-and-drop (full vertical, `test/dnd.gpu.mjs`); action
    negotiation unit-tested (`test/data-device-dnd.test.js`).
  - Structural: `gen-protocol.test.js` spot-checks specific interfaces, and
    `gen-protocol-all.test.js` validates ALL generated signatures (sequential
    unique opcodes, known arg types, interface references resolve, one makeEvents
    sender per event at the right opcode).
  - The server-only smokes are now GPU-free `node --test` files in `npm test`:
    `server.test.js`, `trampoline.test.js`, `fd-passing.test.js`,
    `xdg-shell.test.js` (shared `server-helpers.mjs`; each its own file for
    process isolation — see the start/stop note below). The old `*-smoke.mjs`
    versions were removed. `npm test` is GPU-free.
- **Known bug (flagged, not fixed): `startServer`/`stopServer` is NOT safely
  repeatable in one process** — a second lifecycle aborts with a libuv
  `uv__finish_close` assertion (`Server::stop()` mishandles uv handle teardown on
  reuse). Worked around in tests by one server lifecycle per file (node --test
  isolates files into separate processes). Matters if a long-running compositor
  ever restarts its server; needs a real fix in `native/wayland/server.cpp`.
- **Not yet built (testing):** a stdin command loop on the harness client for
  multi-step sequences (raise/move/resize) within one client lifetime.

### Subsurface compositing (`wl_subsurface`, pixel-verified)
A child `wl_surface` made a subsurface of a parent is composited above the parent
at parent-output-rect + the subsurface offset.
- A subsurface's `wl_surface` gets a texture on commit like any surface;
  `src/subsurfaces.ts` `applySubsurfaces()` gives it a layout rect (parent rect +
  `set_position` x/y) and a draw-stack slot directly above its parent, rebuilding
  both whenever it could change (child commit, `set_position`, `destroy`, parent
  map). Nested subsurfaces handled (recursive subtree). The native compositor
  already drew any placed `ClientSurface` in stack order, so this is JS-layer
  glue (no native change).
- **Commit semantics are spec-correct (double-buffered).** `wl_surface` requests
  accumulate into `pending`; `commit` either APPLIES the state or, for an
  effective-synchronized subsurface, CACHES it and applies it when the parent
  commits. Implemented in `wl_surface.commit` + `applySurfaceState`:
  - **sync** (the default for a subsurface): commit caches; the cache is applied
    atomically when the parent's state is applied (a parent apply cascades into
    every effective-sync child's cache, recursively).
  - **desync**: commit applies directly; a pre-existing cache is flushed as part
    of the apply.
  - **inherited sync**: a desync child of a sync-behaving parent is effectively
    sync (computed up the parent chain; the main surface is always desync).
  - **subsurface position** (`set_position`) is double-buffered and applied on the
    PARENT's commit regardless of child mode; `set_sync`/`set_desync` are
    immediate. Frame callbacks are likewise armed on apply (so a sync child's
    callbacks fire with the parent's frame).
- Verified (`test/subsurface.gpu.mjs`, headless pixel tests): green child over a
  blue parent composites at parent+offset (above parent); a **sync** child does
  NOT appear until the parent commits, then does; a **desync** child's content
  appears on its own commit. **PASS.**
- **Remaining gap (flagged):** `place_above`/`place_below` sibling reordering is a
  no-op (siblings draw in creation order). The WM's own `setStack` on map/unmap
  pushes toplevels-only; subsurfaces are re-expanded right after in the same
  sweep, but a future stand-alone WM restack must call `applySubsurfaces` too.

### Clipboard + primary selection (`wl_data_device` / `zwp_primary_selection_*`, verified)
Copy/paste and middle-click paste work end-to-end between two real clients.
- **Prerequisite built: server-minted new_id in EVENTS.** The trampoline's
  `postEvent` 'n' case now creates the `wl_resource` server-side (on the event
  target's client + the arg's interface), routes its requests to the registered
  handler, and returns the wrapped resource to JS so JS can immediately send
  events on it. JS passes a non-numeric value (null) for the new_id slot to mean
  "mint here". libwayland marshals a sent new_id from the `.o` (wl_object*) slot.
  This was the long-flagged gap; it also unblocks dmabuf `create`.
- Selection flow: source `create_data_source` → `offer(mime)` → `set_selection`;
  the compositor stores it and, to the KEYBOARD-FOCUSED client's data_device,
  mints a `data_offer`, sends `offer(mime)` per type, then `selection(offer)`.
  The receiver calls `data_offer.receive(mime, pipe-fd)`; the compositor forwards
  to the source via `data_source.send(mime, fd)` (the same WaylandFd flows request
  → event); the source writes, the receiver reads. Selection follows keyboard
  focus (resent on focus change via the seat's `onKbFocusChange` hook).
- Primary selection (`zwp_primary_selection_*`, middle-click) is the identical
  flow on its own interfaces + state (no DnD). The generator now also ingests
  `primary-selection-unstable-v1.xml` (35 generated interfaces; checked-in client
  glue for the test client).
- Verified (`test/clipboard.gpu.mjs`, two real clients; GPU-gated ONLY because the
  receiver maps a window to take keyboard focus): a known payload round-trips for
  both clipboard and primary selection, byte-exact. **PASS.**
### Drag-and-drop (`wl_data_device`, verified)
Full DnD vertical between two real clients.
- `start_drag` takes a SEAT POINTER GRAB (`seat.beginDrag`): while active,
  `handleInput` routes pointer motion/button to the DnD machinery instead of
  `wl_pointer` (matches real compositors; the dragged-over client gets DnD events,
  not pointer events). Modeled on Hyprland's `initiateDrag`/`updateDrag`/`dropDrag`.
- On motion, the surface under the pointer gets `data_device.enter` (with a
  freshly-minted `data_offer` + `offer(mime)` + `source_actions`), then `motion`;
  crossing surfaces sends `leave` + a new enter. Action negotiation
  (`negotiateDndAction`: intersect source+receiver masks, honor preferred else
  copy>move>ask) drives `data_offer.action` + `data_source.action`.
- Button release over an accepting target → `drop` + `dnd_drop_performed`; the
  target `receive`s (same fd-pipe transfer as clipboard), reads, `finish`es →
  `dnd_finished`. Release over nothing/rejected → `cancelled` + abort.
- Verified (`test/dnd.gpu.mjs`): source presses over its window → start_drag;
  harness drags the pointer onto the target and releases; the target receives the
  byte-exact payload via the copy action. **PASS.** Negotiation unit-tested
  (`test/data-device-dnd.test.js`).
- **FLAGGED (one untested sub-path):** the drag-ICON surface compositing
  (`updateDragIcon`: position the icon at the pointer, draw on top) is implemented
  but the DnD test passes a NULL icon, so it is not yet pixel-verified. Needs an
  icon + `frameReadback` assertion to close.

### Popups (`xdg_popup` / `xdg_positioner`, verified)
Menus/dropdowns/tooltips: a compositor-positioned, input-grabbing child surface.
- `xdg_positioner` accumulates size/anchor_rect/anchor/gravity/constraint/offset
  (`src/protocols/xdg_positioner.ts`). The constraint solver
  (`src/popup-position.ts`, pure + unit-tested in `test/popup-position.test.js`):
  anchor point on the anchor rect → gravity placement → offset → constrain to the
  output via flip (preferred) / slide / resize, per axis.
- `xdg_surface.get_popup` computes the rect, sends `xdg_popup.configure` +
  `xdg_surface.configure`; on first content the popup maps as a compositor-placed
  child drawn ABOVE its parent. The draw stack has a SINGLE owner
  (`rebuildStackWithPopups` = `computeBaseStack` [windows + subsurface subtrees] +
  popups on top); `applySubsurfaces` delegates to it (so subsurfaces + popups
  coexist — a regression where the popup rebuild dropped subsurfaces was caught by
  the subsurface tests and fixed). Nested popups + reposition supported.
- Grab + click-away dismiss: `xdg_popup.grab` records the grabbing popup; a pointer
  button press OUTSIDE the popup tree sends `popup_done` and is swallowed (seat
  `dismissGrabbedPopup` hook).
- A popup is a `wl_surface` and may itself PARENT subsurfaces; the stack rebuild
  walks each mapped popup's subsurface subtree above it (`emitSubtree`).
- Verified (`test/popup.gpu.mjs`): a popup with anchor_rect + bottom_left anchor +
  bottom_right gravity composites at the computed parent-relative position, and the
  client receives that position in `xdg_popup.configure`; a popup-parented
  subsurface composites above the popup at its offset. **PASS.**
- **FLAGGED (untested sub-paths):** the grab/click-away DISMISS path
  (`maybeDismissGrabbedPopup`) and `reposition` are implemented but not covered by
  a test (the e2e test covers positioning + map only). Constraint flip/slide/resize
  is unit-tested in the solver but not exercised end-to-end. `set_reactive`
  (reposition-on-parent-move) is a no-op.

## Not yet built (design only)

- **Live reload, WM / policy.** A real app can now map a window with both shm
  and dmabuf content end-to-end (see the two "end-to-end" sections above). Still
  missing: live handler reload; window management, focus, layout.
- **WM / policy in JS.** Window management, focus, layout — none built.
- **JS-owned core breadth.** The core is C++ + Node with a working trampoline
  and a frame event callback, but the protocol-handler/WM/plugin layers that
  "JS owns" per the design are unwritten.
- **Plugin model.** Worker isolation, lifecycle, watchdog, and restart policy
  ARE built (scope B — see "Plugin runtime (scope B)"). Still NOT built: the
  GPU/window/surface/output/capture/input/protocol SDK surface, capability
  grants/enforcement, and the native-import restriction. (The dmabuf surface
  buffer path the SDK would drive is proven single-device only; see "dmabuf
  interop path".) The capture/takeover design — one
  producer/consumer primitive run in both directions (plugin-on-top vs.
  plugin-captures/takes-over), capture uniform over the surface graph, the
  reversed-OffscreenCanvas model, and the overview-animation worked example — is
  recorded in architecture.md ("The producer/consumer primitive"). Unbuilt; also
  presupposes a workspace/WM layer that does not exist yet. A concrete buildable
  starting point — generic plugin-composited surfaces (overlay/decoration provider:
  request->core-grants-geometry->plugin-populates, stack-layer model, window-state
  events, inset + interactive-region declarations, 3-step build order) — is specced
  in architecture.md ("First plugin milestone: generic plugin-composited surfaces").
  This is the next thing to pick up.
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
