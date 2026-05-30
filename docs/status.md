# overdraw — implementation status

Tracks what is built and empirically proven versus what is still design only.
The design itself lives in `architecture.md`; this file is the ground truth for
"what exists right now."

Last updated: 2026-05-29.

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
The core (wire client) + GPU process (native Dawn + wire server) topology runs
as real, non-spike code and presents frames to a host window:

- GPU process (`gpu-process/`): owns the host Wayland output window and its
  `wl_display` connection, native Dawn instance + `dawn::wire::WireServer`,
  creates the `wgpu::Surface` from the host `wl_surface`, and `InjectSurface`s
  it at the client's reserved handle.
- Core (`core/`, pure C++ for now): `fork`+`exec`s the GPU process with
  inherited wire + side-channel socket fds, runs `dawn::wire::WireClient`,
  requests adapter + device over the wire, reserves the surface, configures the
  swapchain, and presents a cleared **red** frame each tick over the wire.
- IPC (`native/ipc/`): Dawn wire over one unix socket; a side channel over
  another carrying plain tagged POD control messages (`side_channel.h`) — not
  yet flatbuffers (see architecture.md "Side-channel message set").
- Clean lifecycle: bounded 240-frame run, then ordered shutdown; GPU process
  exits with code 0. Verified repeatable (5/5 runs).

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

- **overdraw as a Wayland server.** Accepting real clients; `wl_compositor`,
  `wl_surface`, `xdg_shell`, `linux-dmabuf-v1`; the generic C++ trampoline; the
  XML→JS protocol generator; live reload. None exists. overdraw is currently
  only a *client* of the host, not a server for its own clients.
- **Compositing.** Only a solid-color clear is done. No texture sampling, no
  per-surface quads, no client buffers, no multiple surfaces, no transforms,
  no multi-output, no damage.
- **Plugin path.** The dmabuf-backed `ReserveTexture`/`InjectTexture` handshake
  (plugin renders into a server-injected texture) is still not validated
  end-to-end. The plugin model, SDK, Worker isolation, watchdog, capability
  grants, restart policy — none built.
- **JS layer.** No Node, no N-API addon, no JS core. The core is pure C++.
- **Real event loop.** Bounded frame count, not run-until-closed. No libuv,
  no `wl_event_loop` integration, no input handling, no resize handling.
- **Crash recovery.** GPU-process respawn + state replay not implemented (the
  teardown fix above de-risks part of it).
- **Phase 2 / Phase 3.** KMS/DRM, libinput, libseat, the session supervisor,
  and XWayland are untouched.

## Spikes

Throwaway de-risking experiments live in `spikes/` (git-ignored). Their
findings are folded into architecture.md; the code is not part of the build.
Notable: stage3 (in-process host window + swapchain), stage4 (surface over the
wire — the cross-process presentation proof).
