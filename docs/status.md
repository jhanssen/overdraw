# overdraw — implementation status

Tracks what is built and empirically proven versus what is still design only.
The design itself lives in `architecture.md`; this file is the ground truth for
"what exists right now."

Last updated: 2026-05-29 (rev 3).

## Verification environment

All "proven" claims below were exercised on:

- NVIDIA GeForce GTX 1660 SUPER, proprietary driver, Vulkan backend.
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
  grew, to preserve message boundaries. SCM_RIGHTS fd passing is not yet used.)
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
  Wayland server yet. No host input handling, no resize handling.

### Compositing (single textured quad)
- A textured-quad pipeline composites one surface: shaders, sampler, bind group,
  full-surface quad. It samples the dmabuf-backed texture (see below) and
  presents it; the host window shows the rendered colour (green).
- Still absent: multiple surfaces, per-surface transforms/opacity, blending,
  client buffers, multi-output, damage.

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
  dmabuf (write bracket), then samples it for compositing (read bracket).
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
- `native/wayland/trampoline.cpp`: `createGlobal()` registers a `wl_global`; on
  bind, creates a `wl_resource` with a generic dispatcher that decodes the
  `wl_argument` array into a typed tuple and calls the named JS handler method.
  new_id args create a child resource; object args decode to a cached per-
  resource JS wrapper. Outgoing events: `postEvent` encodes typed args and calls
  `wl_resource_post_event_array` (wired to the generated `makeEvents`). Resource
  destruction invalidates the JS wrapper (`destroyed=true`) and frees the ref.
- Verified end-to-end with a real libwayland client (`test/wl-test-client.c` +
  `test/trampoline-smoke.mjs`): client binds `wl_compositor` (runtime-registered
  global), calls `create_surface`; the JS handler fires, creates the
  `wl_surface`, sends `wl_surface.preferred_buffer_scale(2)` back (client
  receives it); after the client destroys the surface the wrapper is
  invalidated. This validates the generator metadata against real wire traffic.

Trampoline gaps (implemented or not):
- `fd` args decode/encode to nothing yet (no `WaylandFd`); blocks `wl_shm`,
  data-device, keymap.
- `array` encode/decode implemented but unproven on wire (every array-carrying
  message in our set is an event; encode will be exercised by
  `xdg_toplevel.configure` in the protocol-handler track; no core protocol has
  an array *request* arg, so decode has no exerciser).
- object arg passed *into* a handler: implemented, not yet end-to-end tested
  (needs a protocol with an existing-object request arg).
- per-arg since-versioning not handled.
- No protocols are actually *implemented* in JS yet (handlers tracking surfaces,
  xdg-shell roles, etc.); the trampoline is proven but the JS protocol layer on
  top is unwritten. No live reload yet.

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

- **Actual Wayland protocols in JS.** The server + trampoline + generator exist
  and are proven (see above), but no protocol is *implemented* yet: no handler
  modules tracking surfaces, no `xdg_shell` roles, no `linux-dmabuf-v1` client
  buffer import, no live reload. overdraw accepts clients and dispatches their
  requests to JS, but a real app cannot yet map a window. (The dmabuf import
  primitive a `linux-dmabuf-v1` handler would reuse is proven server-side;
  importing a *client-chosen* modifier we did not allocate is not yet exercised,
  and there is no `WaylandFd` to receive client buffer fds.)
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
