# overdraw — implementation status

Ground truth for what exists right now: current capabilities, known gaps, and
what remains. The design lives in `architecture.md`; this file does not restate
it. Present-tense only — no change history.

Last updated: 2026-06-15 (two GPU-flow fixes:
1. Client dmabuf `ImportClientTex` moved from ctrl to in-band on the wire as
   `kind=3`/`kind=4` frames with SCM_RIGHTS; fixes a ~1/20-launches silent-
   blank-surface bug where the dmabuf-import's `InjectTexture` could be
   overtaken by a subsequent `SurfaceGetCurrentTextureCmd` that allocated the
   next sequential wire texture id, hitting `Server::Allocate`'s
   `id > mKnown.size()` gap-rejection.
2. `onSubmittedWorkDone` now wakes the frame loop when the `gpuCompleted`
   lifecycle step queued a `sendWlRelease`. Fixes a hard deadlock observable
   under heavy client output (e.g. `find / -name '*'` in kitty): the client
   drains its dmabuf pool, all buffers are in-flight on our side, the GPU
   completes the last frame and queues releases, but no path picks them up
   because `wantNext=0` and nothing else wakes the loop. The buffer releases
   sit unsent; the client waits forever for them. The wake from
   `onSubmittedWorkDone` keeps the loop turning past the pool-drain moment.
See "IPC" + "dmabuf"). Earlier: HiDPI:
device/logical coordinate split + integer `set_buffer_scale` + fractional
`wp_viewporter`/`wp_fractional_scale_v1`, EDID-DPI scale auto-derivation, config
`output.scale`; plus KMS card auto-detect and adapter↔card GPU matching. See
"HiDPI / output scaling". All 1061 unit + 134 GPU tests pass. Earlier: post-slice-9 of phase-2 DRM/KMS work — flip-driven frame loop + tiled scanout. The 60Hz `uv_timer` trigger is gone: the core now wakes on `ScanoutFlipComplete` (KMS) and `FrameComplete` (nested-host `wl_surface.frame`) and dispatches the JS render from `runFrameIfReady` when a subsystem has set `wantNext` (animation, transition, intercept, client commit, etc.). Idle scenes draw zero frames. `onFrameComplete` runs `Server::drainEvents` before the render so a client commit that arrived between the last server-pump and the page-flip event is visible to `dispatchFrameCallbacks` this vsync, not next. Scanout buffers pick the first single-plane modifier the kernel advertises (typically `I915_FORMAT_MOD_X_TILED` on this Intel iGPU), with `DRM_FORMAT_MOD_LINEAR` as last fallback — the previous LINEAR-only choice forced render-to-scanout through the non-tiled GPU path, pushing the frame fence past the kernel's vblank deadline and capping a client-paced 256×256 shm-burst client at 80 commits/sec on a 165Hz panel; tiled scanout puts the fence under one vsync, same client now lands at ~154 commits/sec. Slices 1-7 remain in place; KMS still has no automated coverage. Design: `docs/drm-design.md`.

## Read first: gaps in advertised protocols (silent-gap risks)

These are wired/advertised but incomplete. A client may use them and get nothing,
with no error. Worst-first.

- **`xdg_toplevel` window-management state is implemented; residual no-ops are
  narrow.** `set_maximized`/`unset`, `set_fullscreen`/`unset`, `set_minimized`,
  `set_min_size`/`set_max_size`, and interactive `move`/`resize` route through
  `wm.propose` and take effect: maximized fills the reserved-zone tile region,
  fullscreen fills the whole output, minimized is excluded from the layout
  (hidden), floating uses a per-window stored rect, and `move`/`resize` start a
  seat pointer grab against that floating rect (`protocols/xdg_toplevel.ts` →
  `wm/index.ts` `propose` → `wm/layout-driver.ts` resolver; `wl_seat.ts`
  `beginGrab`). The next `configure` carries the resolved state in its states
  array (`protocols/xdg_surface.ts` `buildStatesArray`). **Genuinely still no-op
  / limited:** `show_window_menu` (no compositor-side menu); `set_fullscreen`'s
  per-output target hint is ignored (single output); `set_parent` is stored but
  does not drive stacking or modal behavior; reserved-zone exclusion applies to
  maximized/tiled windows but not to floating ones.

- **`wl_region` is a no-op stub.** `add`/`subtract` do nothing; opaque/input
  regions are not tracked (hit-testing uses whole-window rects). Low urgency.

- **`wl_surface.damage` / `damage_buffer` upload damage is implemented for
  shm; residual gaps are narrow.** `wl_surface.ts` accumulates damage rects
  (double-buffered, promoted on commit), reconciles them to buffer
  coordinates, and `commitSurfaceBuffer` → `uploadPixels` (`compositor.ts`)
  issues one `queue.writeTexture` per damage rect into the surface's
  persistent texture; the undamaged region retains prior pixels. A 4K shm
  client that changes a 200×50 status bar now uploads ~40KB, not 32MB.
  Residuals: (a) **surface-coordinate `damage` combined with a non-normal
  buffer transform or an active viewport falls back to a full-surface
  upload** — buffer-coordinate `damage_buffer` (what GTK/Qt/SDL/terminals
  use) is always honored regardless of scale/transform/viewport, and
  surface-coordinate `damage` is honored when scale-only; the fallback only
  costs the optimization, never correctness. (b) dmabuf is imported
  wholesale (no CPU upload, so upload-damage does not apply). (c) damage is
  not yet propagated to the compositing pass as a scissor (every frame still
  fully recomposites + clears) — see "composite-scissor damage" below; it is
  also a prereq for hardware cursor planes and direct-scanout heuristics.
  Tests: `wl-surface-damage.test.js` (accumulation + reconcile + fallbacks),
  `wl-surface-damage.gpu.mjs` (partial upload preserves the undamaged region).

- **Large shm clients (e.g. fullscreen software-decoded video) may serialize
  against vsync.** Each `wl_surface.commit` with new shm content triggers a
  `queue.writeTexture` upload (CPU memcpy into a Dawn staging buffer, then
  `vkCmdCopyBufferToImage` into the surface's single `s.texture` VkImage) in
  the same vkQueueSubmit as the compose pass that samples it. Vulkan inserts a
  write-after-read barrier against the previous frame's sample of that same
  `s.texture`. For small uploads (e.g. 256×256 burst client = 256KB) the
  barrier is logical and the cycle still fits under one vsync. For large
  uploads — a 4K shm video at 32MB/frame is the canonical concern — the
  combined CPU memcpy + GPU copy + barrier wait may push GPU completion past
  the kernel's vblank deadline, capping observable frame rate at half panel
  rate the same way the LINEAR-scanout-target bug did before slice 9. Real
  dmabuf-producing video clients (mpv with `--hwdec=auto`, VLC with vaapi,
  any zero-copy GBM path) are unaffected — they hand us a sampled
  `SharedTextureMemory` import, no `writeTexture` runs. Notable:
  Hyprland uploads through `glTexSubImage2D` against a single GL texture
  per surface, exactly the same write-after-read pattern we use, and
  does NOT see this stall — because Mesa's GL implementation
  automatically renames/ghosts the texture's backing storage when the
  GPU still references the old contents. Vulkan/Dawn makes that the
  application's job. The mitigations are: (a) honor damage regions
  (now implemented for shm, see the "Read first" damage entry), so an
  incremental upload is sub-rect sized and the barrier wait is short --
  but a full-frame shm video still re-damages the whole surface every
  commit, so this does not help that case; (b) per-surface ring of
  textures, rotating the write target each commit so the new write
  doesn't barrier against the previous sample. (b) is the explicit form
  of what Mesa does for Hyprland implicitly, and is not implemented; we
  have no shm-video client measurement today.

- **No `wl_resource_post_error` mechanism.** Requests that the spec defines
  as protocol errors (e.g. `zwlr_layer_surface_v1.invalid_size` when set_size
  has a 0 axis with no opposite-edge anchors, `wp_cursor_shape_v1.invalid_shape`
  for out-of-range shape enums, `wl_subsurface` place_above/place_below on
  a non-sibling, cross-role surface assignment) are silently dropped rather
  than disconnected. Compliant clients see no behavior change in the
  successful path; non-compliant clients don't get the spec'd disconnect.
  Each silent-drop site is commented with the error it would otherwise
  post. Adding a generic `post_error` path is its own piece of work.

- **Smaller advertised-incomplete items:** `wl_subsurface` `place_above`/
  `place_below` sibling reordering (no-op); DnD drag-icon compositing (implemented,
  not pixel-tested); dmabuf `create` (async server-minted `wl_buffer`) not wired
  (only `create_immed`); single-plane dmabuf only; `zwp_linux_dmabuf_feedback_v1`
  is functional for WSI clients but not automatically asserted.

- **`sdk.compose.windows` is in-thread-only.** The per-window-textures
  variant of compose works for in-thread bundled plugins (Phase 5a) but
  the Worker variant throws "not yet implemented for Worker plugins
  (phase 5b)". Loud failure, not silent -- a Worker plugin that calls
  it gets a clear error rather than missing pixels. Deferred until a
  real use case forces it; `core-plugin-api.md` §6 promises both
  variants. `sdk.compose.scene` (the single-composed-result variant)
  works for both in-thread and Worker plugins.

- **Advertised-absent (clean fallback, not gaps):**
  text-input, xdg-activation, toplevel-icon,
  system-bell. Clients warn and fall back. See the protocol-coverage matrix.
  (`wp_cursor_shape_v1`, `zxdg_decoration_manager_v1`, `wp_viewporter`, and
  `wp_fractional_scale_manager_v1` are now advertised; see their sections and
  "HiDPI / output scaling".)

## Verification environment

All "verified" claims were exercised on a single machine, single driver — nothing
is proven portable:

- NVIDIA GeForce RTX 5060 (GB206, Blackwell), proprietary driver 595.71.05, Vulkan
  backend.
- A live host Wayland session, overdraw running nested as a client of it.
- Dawn wire release `jhanssen/dawn` `v20260531-linux-wayland-wire-alpha2`
  (`6cfd29c89b`) for the wire libs, and `dawn.node` from `v20260531-linux-wayland-
  wire-alpha` (`f01cb22e5c`) for the JS WebGPU bindings.

## Architecture as built

### Process topology

Two processes per the design: a core (Node + N-API addon, Dawn wire client) and a
separate native GPU process (Dawn native + wire server). The core fork+execs the
GPU process and reaps it on shutdown (poll then SIGTERM, no orphan). The GPU
process owns the output target via an output-backend seam
(`gpu-process/src/output_backend.h`): `HostWindowOutputBackend`
(`output_host_window.{h,cpp}`) is the phase-1 implementation, owning the host
Wayland output window + its `wl_display` connection; the phase-2
`KmsOutputBackend` (DRM/KMS + GBM scanout) lands in slice 4 of
`docs/drm-design.md` against the same interface. The seam exposes
open/close/size/createWgpuSurface/eventFd/pump/shouldClose; acquire/present
primitives are not on the interface yet (slice 4 introduces them with a real
implementation). Headless mode has no `OutputBackend` -- the GPU process
branches on `headless` and never constructs one in that case. The GPU process
also owns the native Dawn instance + `dawn::wire::WireServer`, the `wgpu::
Surface` (injected at the client's reserved handle, built via
`OutputBackend::createWgpuSurface` in nested mode), and the GBM allocator. The
core runs the `dawn::wire::WireClient`, brings up adapter + device + surface
over the wire, hosts the JS protocol/WM/compositing/plugin layers, and is the
Wayland server for overdraw's own clients.

The core is C++ + Node: `packages/core/src/index.js`/`packages/core/src/main.ts` load `overdraw_native.node`;
native core in `native/core/` (`gpu_process`, `wire_link`, `compositor`). Node owns
`main()` and the libuv loop. The N-API addon uses the raw `node_api.h` C API (not
node-addon-api, to avoid exception/RTTI dependence under `-fno-rtti`).

### IPC (three sockets, fully non-blocking)

- **Dawn wire** over one `SOCK_STREAM` socket (length-prefixed, kind-tagged
  frames: `[len][kind][payload]`). `kind=0` is Dawn wire bytes; `kind=1`/`kind=2`
  are in-band access-bracket Begin/End frames (see INBAND-ACCESS.md);
  `kind=3` is `ImportClientTex` (client dmabuf fd attached via SCM_RIGHTS on the
  sendmsg that delivers the frame); `kind=4` is the matching `ClientTexImported`
  reply. The dmabuf import rides the wire because the server-side slot it
  allocates (`Server::InjectTexture`) shares the wire-client's texture id space
  with subsequent wire commands like `Surface::APIGetCurrentTexture` — putting
  the import on a separate ctrl channel let those later wire commands overtake
  it on the server, causing `Server::Allocate` to fail (id beyond `mKnown.size()`)
  and the surface to silently render black for the rest of the run on 1/~20
  launches. Linux AF_UNIX/STREAM sockets accept SCM_RIGHTS just fine; the
  per-frame fd attachment FIFO in `FdSerializer`/`FrameReader` is the wire-
  socket analogue of `CtrlSender`'s per-message SCM_RIGHTS path.
- **Control side channel** over a `SOCK_SEQPACKET` socket carrying fixed-size
  tagged POD messages (`native/ipc/side_channel.h`) — not flatbuffers. SCM_RIGHTS
  fd passing is used for transports that don't share an id space with the wire
  (e.g. `SetDrmFd`, `AddWireConn`, `FeedbackData`'s format-table memfd).
- **Input** over a dedicated `SOCK_SEQPACKET` socket (separate from control so
  unsolicited input never interleaves with request/reply traffic).

No write may ever park: all fds are `O_NONBLOCK`; writers buffer what the socket
can't take and drain on writable. `native/ipc/transport.h` provides `FdSerializer`
(queues framed wire batches; `pumpOut` drains on writable), `FrameReader`
(accumulates whole frames), `CtrlSender` (buffers SEQPACKET datagrams, dup'ing fds
when queued). Blocking shims remain only for one-shot startup/handshake.

- **GPU process** drives an `EventLoop` abstraction (`gpu-process/src/
  event_loop.h`) with an epoll backend, multiplexing wire / ctrl / host-
  `wl_display` fds; arms write-interest only when output is queued. Backend-
  agnostic so kqueue can be added. Steady-state loop ~190 Hz.
- **Core** uses libuv `uv_poll`, arming `UV_WRITABLE` on the wire fd only when
  output is queued (`armWirePoll`/`wirePumpOut`).
- Wire socket buffers enlarged to 8 MiB; userspace buffering covers overflow.

**Cross-channel ordering.** A control request that allocates a wire-server-side
slot (`AllocSurfaceBuf`'s producer/consumer `InjectTexture`s) must not overtake
the wire commands it depends on (the prior `UnregisterObjectCmd` that recycles a
handle at generation+1, the new `ReserveTexture`). Enforced by a wire serial:
`FdSerializer` counts cumulative framed wire bytes; the core tags the request
with that value; the GPU process defers it (via `ipc::WireBarrier`) until its
consumed-byte count reaches the serial. An explicit happens-before across the
two sockets, no blocking. Likewise `ReleaseClientTex` (ctrl) is gated on the
wire reader catching up past every in-band Begin/End bracket queued ahead of it.
`ImportClientTex` no longer rides ctrl at all (it is in-band on the wire as
`kind=3`, naturally FIFO-ordered); the per-FRAME access brackets are also wire
in-band (`kind=1`/`kind=2`). See INBAND-ACCESS.md.

### GPU process threading

The GPU process pump (wire decode + `HandleCommands` + `DeviceTick` + present) is
single-threaded today. No measured bottleneck. The design admits true parallelism
(core + each plugin are independent `wgpu::Device`s = independent `VkDevice`/
`VkQueue`s with distinct submit timelines), via thread-per-connection ownership:
one OS thread per wire connection, each exclusively owning its device, plus one
KMS/present thread owning the shared instance/allocator/scanout behind locks.
Decision: implement after the phase-2 KMS present loop lands. No correctness
blocker found. Not built.

### JS layer / event loop

One-shot bring-up runs blocking inside `start()`; the steady-state present loop is
libuv-driven (a `uv_poll_t` on the wire fd drains inbound frames; renders fire
from `runFrameIfReady` on `wake()` or `onFrameComplete` — no `uv_timer`). No
hand-rolled C++ spin loop in steady state.

A C++→JS path works: an optional `onFrame` callback fires from the frame
trigger (direct `napi_call_function`, same Node thread). The cross-thread
path (Dawn-internal callbacks → `napi_threadsafe_function`) is not yet exercised.

Server-side Wayland (`wl_event_loop`) is integrated into the libuv loop (see
"Wayland server + trampoline"); the core is a real Wayland server. Protocol
handlers, WM, compositing, and plugin runtime are in JS.

## Compositing (runs in JS over the Dawn wire)

The compositing pass lives entirely in core main-thread JS. There is no C++
compositing pass; the C++ `Compositor` is a WSI + interop service. WebGPU is
exposed to JS via a wire-retargeted `dawn.node` (proc table = wire client;
`wrapDevice`/`wrapTexture` wrap host-provided wire handles; `AsyncRunner` pumps the
instance; a wrapped device is borrowed, not destroyed). Built with
`-Wl,--exclude-libs,ALL` so the bundled abseil does not interpose with V8's.

- **`packages/core/src/gpu/compositor.ts` (`JsCompositor`)** is the compositor: WGSL pipeline +
  sampler, per-surface view/uniform/bind group, render pass (placement +
  premultiplied blend, JS-owned back-to-front stack), submit. It implements the
  `CompositorSink` interface the protocol/WM layer drives
  (`commitSurfaceBuffer`/`commitSurfaceDmabuf`/`setSurfaceLayout`/`setStack`/
  `setLayerSurfaces`/`setSurfaceTexture`/`removeSurface`/`takeImportedSurfaces`/
  `takeFreedBuffers`/`afterCurrentFrame`/`renderFrame`). Headless renders into an
  owned offscreen target (read back, 256-aligned); nested presents to the host
  swapchain.
- **Native services kept** (non-wire-propagatable / WSI bits): surface bring-up +
  `Configure`, `acquireOutputTexture`/`presentOutput`/`outputFormat`,
  `createTextureFromDmabuf` + `releaseDmabufImport` (generation-matched), `shmView`
  (zero-copy external `ArrayBuffer` over the client shm mapping), `gpuHandles`, the
  wire link.

### Stack layers + placement

- **Layers** (`background < below < content < above < overlay`), composited
  back-to-front. `content` holds windows + subsurfaces + popups (a single stack
  owner, `rebuildStackWithPopups`); other layers via `setLayerSurfaces`.
- **Placement seam + tiling WM:** the compositor consumes geometry only via
  `CompositorSink` (`setSurfaceLayout`, `setStack`/`setOutputStack`).
  `packages/core/src/wm/index.ts` owns the window list/stack, schedules
  relayouts through `packages/core/src/wm/layout-driver.ts`, and pushes
  layout+order + a sized configure. The layout *policy* lives in a bundled
  plugin: `packages/plugin-layout-default/`, registered in the `'layout'`
  namespace at priority 0 (the bundled-plugin floor). It is a **master-stack
  tiler** (dwm-style: first window = master in a left column at
  `masterFraction`; the rest share the right column as equal-height slices;
  a single window fills the output). A third-party layout plugin claiming the
  same namespace at higher priority displaces the bundled one; the
  priority-chain demotes back on failure. Params (`masterFraction`, `gap`) are
  plugin-internal defaults today (no config wiring yet).
- **Geometry is compositor-owned (proactive configure).** A toplevel is inserted
  into the layout at `get_toplevel` (becomes master), and the WM sends a sized
  `xdg_toplevel.configure` immediately (before the client has content); existing
  windows whose tiles changed are reconfigured too. The client renders at the
  configured size; first content makes it drawable + focusable. Unmap reflows +
  reconfigures the survivors. `ack_configure` records the acked size; the WM skips
  redundant configures.
- **Decoration insets are subtractive (outer-anchored).** The layout assigns the
  on-screen OUTER tile; the content rect = outer shrunk by the decoration insets
  (the client is reconfigured to the shrunk size). The decoration draws in the band
  inside the outer tile, so it is always on-screen — fixing the prior additive model
  where a window at (0,0) put its titlebar off-screen at negative y.
- Swapchain present mode is **Mailbox** (non-blocking acquire); FIFO blocks
  `GetCurrentTexture` on the single command thread and stalls other wire work.
- **Tiling verified** (headless pixel readback + query): 1/2/3 real clients tile to
  the master-stack rects, fill their tiles via the configure→resize loop, do not
  overlap, and survivors reflow on unmap.

Still absent: multi-output, composite-scissor damage (per-output damage ring
+ scissored partial-frame rendering; shm *upload* damage is implemented, see
the "Read first" damage entry), and linear-space alpha
compositing. (Per-surface opacity/transform/tint/mask, floating/fullscreen/
maximize/minimize, interactive move/resize, workspaces, and compositor
keybindings with general key interception — `wl_seat.ts` consults
`bindingChain` and suppresses client forwarding on a match — are all
implemented; see the WM behavioral-state, plugin SDK, and binding-chain
sections.) `wl_output` now reports real values: in nested mode they come from the host's `wl_output`
(slice 3 of `drm-design.md`); in KMS mode from the connector's EDID + mode
(slice 4+5). Output resize (nested) propagates end-to-end. Multi-output is
still single-output-only.

## Client buffers

### shm (`wl_shm`/`wl_shm_pool`/`wl_buffer`, pixel-verified)

`wl_shm` advertises ARGB8888/XRGB8888 on bind; `create_pool` hands the fd to native
`ShmRegistry` (`native/core/shm.cpp`) which `mmap`s it; `create_buffer` records an
(offset,w,h,stride,format) view. On commit the JS compositor takes a zero-copy
external `ArrayBuffer` (`addon.shmView`) and uploads via `queue.writeTexture`.
ARGB8888/XRGB8888 maps to BGRA8Unorm byte-for-byte on little-endian. `wl_buffer.
release` is sent after upload (bytes are copied). A pool-refcount fix supports
clients (e.g. kitty) that destroy the pool before rendering.

### dmabuf (`zwp_linux_dmabuf_v1` / `..._buffer_params_v1`, pixel-verified)

Advertises ARGB8888/XRGB8888 with LINEAR+INVALID modifiers; `add` records the plane
(fd + offset/stride/modifier); `create_immed` builds a dmabuf-tagged buffer. On
commit: `createTextureFromDmabuf` (async, returns a Promise of the wire handle) →
`wrapTexture` → sample. The dmabuf fd travels in-band on the wire socket as a
`kind=3` `ImportClientTex` frame with SCM_RIGHTS ancillary; the GPU process
imports it as `SharedTextureMemory` (reusing `Allocator::importTexture`), does an
initialized `BeginAccess`, `InjectTexture`s at the core's reserved handle, and
writes a `kind=4` `ClientTexImported` reply on the same wire. The commit is
non-blocking (reserve → enqueue wire frame → `PendingImport`, return; the reply
is dispatched from the wire reader on the Node thread). In-band on the wire
(rather than the older ctrl-channel `ImportClientTex`) so the server-side slot
allocation is FIFO-ordered with subsequent wire commands that allocate the next
sequential id (`Surface::APIGetCurrentTexture`) — splitting wire-state mutation
across two transports let those later commands overtake the import and fail
`Server::Allocate` with `id > mKnown.size()`, silently blanking the surface for
the rest of the run on ~1/20 launches.

**Buffer-release lifecycle (zero-copy).** A buffer is released only once the
compositor frame that sampled it completes on the GPU: the submit is tagged with a
serial + `onSubmittedWorkDone`; a buffer superseded by a newer commit is freed when
its retire-serial completes; freed ids drive `wl_buffer.release` + explicit
`ReleaseClientTex` of the server STM/fd. Verified by a buffer-cycling leak test
(GPU-process fd count bounded over 40 cycled buffers).

The `onSubmittedWorkDone` callback that delivers the gpuCompleted lifecycle
intent calls `addon.wake()` when its dispatch grew the pending-release set
(`this.freed`). Frame callbacks + buffer releases are sent only from
`dispatchFrameCallbacks`, which runs only from `notifyFrame` → only from
`runFrameIfReady` → only when `wantNext` is set. Without an explicit wake here,
a client that has just exhausted its dmabuf pool waiting on the very release
the GPU just produced will see no `wl_buffer.release` event -- the release sits
in `freed[]` while `wantNext=false` and nothing else schedules a frame. The
result is a hard deadlock that recovers only on the next external wake (mouse
motion, keypress). The wake from `gpuCompleted` keeps the loop turning past
the moment the client drained its pool.

Limitations: single plane only; `create` (async server-minted `wl_buffer`) not
wired (the trampoline can now mint server-side new_ids, so this is wiring, not a
missing primitive); no per-frame re-import optimization; the import `BeginAccess`
is never ended until teardown (fine single-device); no modifier negotiation beyond
a static advertised set (an unadvertised client modifier surfaces as a failed
commit).

## Real clients run end-to-end

- **`foot`** (1.25.0, shm) connects, renders, and is interactive: prompt renders,
  keyboard routes, colors match a real compositor.
- **`kitty`** (hardware EGL) renders, focuses on map, types.
- **Vulkan-WSI clients** (a client presenting via a Vulkan/WebGPU swapchain on its
  `wl_surface`) run interactively. Verified with a Dawn/Vulkan WSI terminal: it
  configures its swapchain, renders, updates live, and sustains continuous output.
  This required: real dmabuf default-feedback (format_table + main_device +
  tranche, built from Dawn `GetFormatCapabilities` + `DawnDrmFormatCapabilities`);
  advertising both the alpha and opaque DRM fourcc per format (e.g. ARGB8888 +
  XRGB8888); `wl_seat`/`wl_pointer`/`wl_keyboard` event version gating to the
  resource's bound version; and the dmabuf buffer-release lifecycle above. The
  implicit-sync acquire (export the client dmabuf's read fence via
  `DMA_BUF_IOCTL_EXPORT_SYNC_FILE`, import as a Dawn `SharedFence`, wait in
  `BeginAccess`) is implemented.

**Color:** the GPU process picks the first non-sRGB advertised swapchain format and
the shader passes client bytes (already sRGB) through. Correct for opaque content;
alpha blending currently happens in sRGB space (wrong for translucency — linear
compositing is future work).

**dmabuf feedback** is real for WSI format selection but the format_table is the
full probed set, not a curated tranche; cosmetically kitty logs a fallback warning
on this single-GPU setup before working.

## Output reconfiguration

The GPU process owns the display target (`OutputBackend`); the core owns
client-facing protocol state. They coordinate via a single side-channel
message, `ipc::Tag::OutputDescriptor` (see `native/ipc/side_channel.h`),
sent gpu → core at bring-up and again on any change.

**Initial descriptor** (`gpu-process/src/main.cpp`, post-`SurfaceReady`):
`HostWindowOutputBackend::describeOutput` synthesizes the descriptor from
the nested window size (width/height) plus host-derived refresh / scale /
transform / physical dims (HostWindow binds the host's `wl_output` and
records mode/scale/geometry events), plus overdraw-synthesized
make/model/name (we deliberately do not forward host monitor identity to
overdraw's clients).

**Resize path.** When the host fires `xdg_toplevel.configure(w,h)` and
`HostWindow::onSize` observes a real change, an `OutputBackend`
ResizeListener fires (installed in main.cpp). The listener does TWO things
synchronously in the GPU process: (1) `wgpu::Surface::Configure` natively
on the existing surface with the new w/h plus the cached
format/presentMode/alphaMode triple — done locally in the GPU process so
there's no "frame at the wrong size" between the host's configure-ack and
the swapchain Configure; (2) re-emit `OutputDescriptor` over the ctrl
socket.

**Core dispatch.** `Compositor::drainCtrl` parses `OutputDescriptor` into a
queue; the addon's `fireOutputDescriptors` invokes the JS callback
registered via `addon.setOnOutputDescriptor`. The callback in `main.ts`
runs the propagation in known order:

- Mutate `state.outputs.get(OUTPUT_DEFAULT)` in place with the new fields.
- `JsCompositor.setOutputSize(w, h)` — render passes pick up new dims.
- `addon.updateOutputSize(w, h)` — input backend's pointer mapping /
  cursor clamp gets the new rect.
- `state.wm.state.output.{width,height}` mutated — subsequent layout
  snapshots see the new dims.
- `state.relayout("output-resized")` — tiled clients reflow.
- `pluginBus.emit("output.changed", ...)` — external subscribers fire.

**External re-emit** (the bus-driven half). `wl_output.ts` and
`zxdg_output_manager_v1.ts` track bound resources on `state.wlOutputResources`
/ `state.xdgOutputResources` (state-scoped, populated on bind /
get_xdg_output, lazily scrubbed when destroyed). They each export a
`reemitWlOutput(state, outputId)` / `reemitXdgOutput(state, outputId)`
function. `main.ts` subscribes to `output.changed` and calls both. Each
re-emit walks its tracking set and resends the FULL event burst
(geometry / mode / scale / name / description / done for wl_output;
logical_position / logical_size / name / description / done for xdg_output)
with the updated values. Per spec the events are not delta — the full set
is resent and `done` is the atomic-commit signal.

**Verified.** Nested-mode bring-up on a 240Hz host advertises real values
(`mode 1900x1045 @240083mHz scale=1`, real physical dims, transform). On
host-triggered resize the descriptor re-fires and the swapchain is
reconfigured before the next acquire; the second `output:` log line appears
with the new dims and the chain runs end-to-end. Pure-unit coverage for
bind + re-emit + destroyed-resource scrub: `test/wl-output.test.js` (8
tests), `test/xdg-output.test.js` (8 tests including the 4 added for
re-emit).

HiDPI scaling (integer + fractional) is implemented -- see "HiDPI / output
scaling". Out of scope today: multi-output (single OUTPUT_DEFAULT entry; the
registry is sized for many, no second binding yet); KMS-side mode changes
(`SetOutputMode` core→gpu request from drm-design.md is not wired — only
the gpu→core direction is). Subpixel hint is hardcoded UNKNOWN.

## HiDPI / output scaling

The compositor works in two pixel spaces: **device** pixels (the scanout /
render target) and **logical** pixels (everything client-facing: WM layout,
`xdg_toplevel.configure` sizes, `xdg-output`, pointer coordinates). The bridge
is the output **scale**: `logical = round(device / scale)`. There is no
intermediate logical-resolution framebuffer -- each surface's buffer is
sampled directly into its `logical_rect × scale` device rectangle, so a
scale-aware client is pixel-perfect and a non-cooperating client is upscaled
(correct size, soft).

**Scale selection** is core policy (`src/output/scale.ts`, `resolveScale`):
an explicit `output.scale` config value wins; otherwise an EDID-DPI auto
fallback (KMS only -- a nested host window's physical dims describe the host
monitor, not our render target); otherwise 1. The fallback snaps DPI/96 to
quarter steps, clamped to [1,3]. `onOutputDescriptor` treats the descriptor
dims as device pixels, computes scale + logical, and routes device → the
compositor render target, logical → WM/input/xdg-output.

**Client negotiation** (no per-client branching in the compositor; clients
self-select a tier and we sample uniformly):

- **Integer** (`wl_surface.set_buffer_scale`, double-buffered): the surface's
  intrinsic logical size = buffer dims / buffer scale. `wl_output.mode`
  reports device pixels; `wl_output.scale` reports the integer ceiling of the
  (possibly fractional) scale, so integer-only clients oversample and stay
  crisp.
- **Fractional** (`wp_fractional_scale_v1` + `wp_viewporter`): the compositor
  sends `preferred_scale = round(scale × 120)` (re-emitted on scale change);
  the client renders a denser buffer and declares its logical size via
  `wp_viewport.set_destination`, which overrides the surface's logical size.
  `wp_viewport.set_source` crops the sampled buffer region (→ compositor
  `cropUV`). Both are double-buffered on `wl_surface.commit`.

`xdg_output.logical_size` reports logical; `wl_output.mode` reports device.
Surface placement uses the WM-assigned logical layout for toplevels, else the
viewport destination, else buffer/bufferScale.

**Verified** on the 2560×1600 @165Hz Intel panel: `output.scale=2` (integer,
kitty) and `output.scale=1.5` (fractional, kitty) both render crisp at the
correct logical size; default (no config) auto-derives ~2.0 from EDID. Unit
coverage: `output-scale.test.js`, `wl-surface-buffer-scale.test.js`,
`wp-viewporter.test.js`, `wp-fractional-scale.test.js`, plus `config.test.js`
(`output.scale`).

**Known gaps (deferred):** the software cursor is correct-size but **soft** at
scale>1 (a 1× bitmap upscaled -- needs a device-density cursor resolve + the
internal cursor's buffer scale; the theme resolver already takes a `scale`
arg, only 1 is passed). The subsurface logical-sizing render path is covered
at the protocol layer but not by a scale-aware-subsurface GPU test. Nested
mode does not auto-derive scale (config only).

`wl_surface.set_buffer_transform` is implemented: all 8 wl_output.transform
orientations (4 rotations x optional flip) are undone in the compose shader
when sampling, 90/270 swap the surface's logical w/h, and it is double-
buffered. Pixel-verified for all 8 against the spec (`buffer-transform.gpu.mjs`).
Limitation: combining a buffer transform with a `wp_viewport` source crop is
not spec-exact (the crop is composed after the transform rather than in
pre-transform surface coords); transform-alone and crop-alone are correct,
and no known client uses both together.

## KMS scanout backend (`--backend=kms`)

Bare-metal output via DRM/KMS. The GPU process opens a card (passed by
the core via libseat + SCM_RIGHTS), enumerates connector / CRTC /
primary plane, allocates a 3-slot scanout ring via GBM, imports each
buffer into the Dawn device as `SharedTextureMemory`, atomic-commits
the initial modeset, and drives subsequent frames as page-flip-paced
atomic commits with `IN_FENCE_FD` so the kernel waits for the
compositor's submit before latching.

### Backend selection

The Node core's `addon.start(...)` takes an `opts` object selecting the
output backend:

```
opts = { width, height }                        // headless (legacy + tests)
opts = { backend: "kms" | "nested", card? }    // production / dev
```

Production defaults to `kms` (`packages/core/src/main.ts`). Override with
`--backend=nested` or `OVERDRAW_BACKEND=nested` for dev under a host
Wayland session. Tests default to nested when an output backend is
requested (`headless: false` / `headless: null`); KMS tests must opt in
explicitly via `setupCompositor({ headless: false, backend: "kms" })`.

### Bring-up flow

1. Core selects the DRM card via libseat and holds the fd as long as the
   compositor runs. Selection precedence: `--card=<path>` CLI > config
   `output.card` > auto-detect. Auto-detect (`Seat::openFirstConnectedCard`)
   probes `/dev/dri/card*` in order and opens the first with a connected
   connector — the card driving a display. An explicit override uses
   `Seat::openDevice` on that exact node.
2. Core sends `ipc::Tag::SetDrmFd` to the GPU process via SCM_RIGHTS
   BEFORE the regular Hello handshake.
3. GPU process constructs `KmsOutputBackend(drmFd)`, calls `open()`:
   enables atomic + universal-planes caps, picks the first connected
   connector (env var `OVERDRAW_CONNECTOR` may pin a name), picks the
   preferred mode (or mode 0), finds a compatible CRTC, finds a primary
   plane, resolves all the atomic-commit property ids, creates a GBM
   device on the DRM fd.
3a. GPU process selects the Dawn adapter that owns the scanout card —
   it `fstat`s the card fd for the DRM primary major:minor and matches it
   against each Vulkan adapter's `WGPUAdapterPropertiesDrm` (the first
   adapter is no longer assumed). The GBM allocator's render node is
   derived from the chosen adapter's render major:minor, so buffer
   allocation and the wgpu device always land on the same GPU. No adapter
   matching the scanout card is a hard error (cross-GPU scanout is
   unsupported). In nested/headless mode there is no card; the first
   adapter is taken and the render node still follows it.
4. GPU process sends `OutputDescriptor` to the core with the connector's
   mode dimensions + EDID-derived physical mm + product name.
5. Core (now knowing the dims) ReserveTexture's 3 wire handles for the
   scanout ring slots, assigns a `surfaceBufId` per slot (re-using the
   existing producer/consumer SurfaceBuf machinery for access brackets),
   sends `ScanoutReserve { handles[3], bufIds[3], width, height }`.
6. GPU process calls `KmsOutputBackend::initScanout(coreDevice)`:
   allocates 3 GBM bo's. The modifier candidates come from the plane's
   `IN_FORMATS` list, tiled-first (typically `I915_FORMAT_MOD_X_TILED`
   / `_Y_TILED` / `_4_TILED` on Intel), with `DRM_FORMAT_MOD_LINEAR`
   appended last as a guaranteed-single-plane fallback. Per-modifier
   `tryAllocateSlot` does the GBM allocation + Dawn `ImportSharedTextureMemory`
   probe; if Dawn rejects (e.g. multi-plane CCS modifier), we fall through
   to the next candidate. Multi-plane support is not implemented in Dawn's
   dmabuf import (CCS RGB modifiers produce two separate FDs which Dawn
   rejects; see `Limitations of v1` below). Dual-imports each slot's bo as
   `SharedTextureMemory` + `wgpu::Texture` via the existing
   `Allocator::importTexture` helper, `AddFB2WithModifiers` per slot.
   For each slot it also registers a `SurfaceBuf` in the surface-buf
   machinery (`producerOnCore=true`, consumer side empty because the
   consumer is the kernel display engine, not another wgpu device).
7. GPU process `InjectTexture`s each slot's `wgpu::Texture` at the
   matching reserved wire handle, then sends `ScanoutReady { ok=1 }`.
8. Core proceeds with steady-state.

### Steady-state frame

1. JS compositor's `renderFrame()` calls `addon.acquireOutputTexture()`.
2. Core's `Compositor::acquireOutputTextureHandle()` picks the next
   FREE slot, writes an in-band BeginAccess frame (`kind=1`,
   `SurfaceAccessPayload{surfaceBufId, producer=true}`) on the wire,
   returns the slot's wire texture handle.
3. JS records render commands + calls `queue.submit`. The in-band Begin
   already opened the STM bracket so the submit is validated.
4. JS calls `addon.presentOutput()`. Core writes an in-band EndAccess
   frame on the wire, then sends `ipc::Tag::ScanoutPresent { surfaceBufId }`
   on ctrl, then flushes the wire.
5. GPU process's wire reader hits the EndAccess frame, calls
   `runSurfaceEnd(surfaceBufId, producer=true)` which calls `mem.EndAccess`.
   The exported sync_file fd is captured into
   `scanoutSlotFenceFd[slot]` (instead of the usual cross-device fence
   import path — there's no wgpu consumer device for scanout).
6. GPU process's ctrl handler dispatches `ScanoutPresent`: looks up
   `scanoutBufIdToSlot[surfaceBufId]` → slot index, picks up the
   captured fence fd, builds an atomic commit with the slot's `fb_id`
   on the primary plane + the fence fd on the plane's `IN_FENCE_FD`
   property. The kernel waits for the fence before latching.
7. Page-flip event arrives on the DRM fd. `KmsOutputBackend::pump()`
   (called from the GPU process's epoll loop) runs `drmHandleEvent`
   which calls the page-flip trampoline, which advances the ring's
   state machine (`PENDING_FLIP` → `SCANOUT`, prior `SCANOUT` → `FREE`)
   and sends `ipc::Tag::ScanoutFlipComplete { surfaceBufId }` on ctrl.
8. Core's `drainCtrl` consumes `ScanoutFlipComplete`, advances the
   local slot state machine. The retired slot is now FREE for the next
   acquire.

### Initial vs. steady-state atomic commit

The initial commit is `ALLOW_MODESET` only (no `PAGE_FLIP_EVENT`,
because the modeset is synchronous on return). Subsequent commits are
`PAGE_FLIP_EVENT | ATOMIC_NONBLOCK`. The atomic TEST_ONLY flag strips
both `PAGE_FLIP_EVENT` and `NONBLOCK` (the kernel rejects them on
TEST_ONLY); TEST_ONLY always precedes the real commit so a rejection
doesn't leave half-state. The initial commit additionally sets the
connector→CRTC link, CRTC mode blob, and CRTC active.

### Limitations of v1

- **Single-plane tiled modifiers only** for scanout buffers; CCS / AFBC
  (compressed multi-plane) modifiers fall back to plain tiled or LINEAR.
  On Intel iGPU the picked modifier is typically `I915_FORMAT_MOD_X_TILED`
  (whatever the plane's `IN_FORMATS` advertises first that Dawn imports).
  Compressed-color modifiers like `I915_FORMAT_MOD_4_TILED_MTL_RC_CCS`
  (gen 12+ Intel) and `I915_FORMAT_MOD_*_DCC*` (AMD) would save ~30%
  memory bandwidth on full-screen renders but Mesa allocates them with
  separate FDs per plane (`res->bo` for main + `res->aux.bo` for CCS),
  which Dawn rejects (Dawn supports `planeCount > 1` only when all FDs
  are the same — `crbug.com/42240514`, single-FD requirement at
  `SharedTextureMemoryVk.cpp:382-388`). On ARM platforms with AFBC the
  same constraint reduces us to LINEAR, which on AFBC-centric GPUs
  re-creates the slow-scanout problem this slice fixed on Intel.
  Mitigation if/when ARM matters: bypass Dawn's dmabuf import for the
  scanout slot — do `VK_KHR_external_memory_dma_buf` ourselves with
  `VK_IMAGE_CREATE_DISJOINT_BIT` in the GPU process, then `InjectTexture`
  the resulting wgpu handle. Scoped to overdraw's GPU process; ~1 week
  of work. Deferred until ARM/AFBC becomes a target.
- **`wl_buffer.release` is gated on `onSubmittedWorkDone`** (the
  compositor's submit completing). The slice 4+5 commit message and
  earlier revisions of `drm-design.md` claimed this was wrong for KMS
  ("a client buffer can be released while still being scanned out"),
  but the pipeline doesn't actually create that hazard: the compositor
  samples each client dmabuf into the scanout-ring slot's texture; the
  client buffer is read-only-input, not the scanout buffer itself.
  Once the render submit completes, the client's pixels have been
  consumed; what continues to be scanned out is the scanout slot, not
  the client buffer. A future zero-copy direct-scanout path (client
  dmabuf assigned to the plane) would resurrect this concern; until
  then `onSubmittedWorkDone` is correct.
- **No KMS coverage in the test suite** (per user direction, option A
  in the slice planning). KMS path verified only by manual run; tests
  use nested or headless. A future virtual-DRM (vkms) test harness
  would close this. The card auto-detect (`Seat::openFirstConnectedCard`)
  and the adapter↔card matching (`WGPUAdapterPropertiesDrm`) are part of
  the KMS bring-up and share this gap: both were verified by direct
  execution against the live seat / live Dawn enumeration on the test
  box (the compiled `openFirstConnectedCard` picked the connected card;
  the matcher selected the adapter whose primary node equals the card),
  not by an automated test. The config `output.card` override IS covered
  GPU-free in `test/config.test.js`.
- **NVIDIA / non-Intel scanout** unverified end-to-end. Code is
  driver-agnostic (libdrm atomic + libgbm) and the adapter/render-node
  matching reads real `WGPUAdapterPropertiesDrm` values from the NVIDIA
  proprietary driver as well as Intel (confirmed by probe), but a full
  scanout has only been driven on Intel i915. On a hybrid box the matcher
  pins the device + render node to whichever GPU owns the connected card.
- **`WGPUAdapterPropertiesDrm`-dependent matching.** Adapter↔card
  matching needs the Vulkan adapter to advertise its DRM nodes. Verified
  populated for Intel Mesa and NVIDIA proprietary on the test box. A
  driver that does not populate it would fail the KMS match (hard error,
  not a silent cross-GPU fallback); the render-node derivation then falls
  back to `renderD128`, which is only correct when that is the right GPU.
- **No mode changes** (the `SetOutputMode` core→gpu message family is
  not wired). The connector's preferred mode is used at bring-up and
  not changed thereafter.
- **No reactive output reconfiguration on resume.** Slice 7's
  `enable_seat` handler relies on the next render naturally re-running
  the modeset (via the GPU process's `didInitialCommit_` cleared on
  pause). If a frame is somehow not driven for a while after resume,
  the panel stays dark until one is. In practice the addon's frame
  timer ticks every ~16ms so the gap is invisible, but a future
  refactor that moves the JS render onto the flip-event clock will
  want to either force a render on resume or have `OutputResume`
  carry an explicit "re-run modeset now" intent.

### Files

- `packages/core/native/core/seat.{h,cpp}` — libseat wrapper (slice 1).
- `packages/core/native/ipc/side_channel.h` — `SetDrmFd`,
  `ScanoutReserve`, `ScanoutReady`, `ScanoutPresent`,
  `ScanoutFlipComplete`, `OutputPause`, `OutputResume` messages.
- `packages/core/native/core/compositor.{h,cpp}` — KMS-aware
  `acquireOutputTextureHandle` / `presentOutput`, scanout slot state
  machine, in-band Begin/End writes.
- `packages/core/gpu-process/src/drm_utils.{h,cpp}` — libdrm helpers
  (connector / CRTC / plane enumeration, atomic-commit helpers, EDID
  parsing, IN_FORMATS reader).
- `packages/core/gpu-process/src/kms_scanout_ring.{h,cpp}` — 3-slot
  ring (GBM bo + STM + wgpu::Texture + fb_id + state machine).
- `packages/core/gpu-process/src/kms_output.{h,cpp}` —
  `KmsOutputBackend` implementing `OutputBackend`. Two-phase init
  (`open()` for DRM topology; `initScanout(device)` for ring + import +
  initial modeset).

### Verified

Bare-metal run on a 16" 2560×1600 @165Hz Intel iGPU laptop with gdm
stopped and seatd active: the panel lights up at the compositor's
clear color, atomic commits succeed, page-flip events fire at the
panel's native refresh, no Dawn validation errors, clean shutdown
releases DRM master and closes all fds.

## Input

### Host input forwarding (host seat → GPU process → core → JS)

The GPU process binds the host `wl_seat` (`host_window.cpp`, pointer + keyboard, up
to v5) and forwards each event as a fixed-size `ipc::InputMessage` over the input
socket (non-blocking `MSG_DONTWAIT`; input is lossy by design). The core abstracts
this behind a backend seam (`native/core/input.h`: `InputEvent` in OUTPUT-space
doubles + raw evdev keycodes + ms timestamps, `InputSink`, `InputBackend`).
`WaylandInputBackend` (`input_wayland.cpp`) reads the socket, converts
`wl_fixed_t`, and emits `InputEvent`s. `LibinputBackend` (`input_libinput.cpp`)
is the bare-metal sibling: opens `/dev/input/event*` via libseat, reads from
libinput's pollable fd on the same libuv loop, accumulates relative pointer
motion into output-space coordinates with bounds clamping, and emits the same
`InputEvent`s (raw evdev keycodes, no XKB +8 offset). The input backend is
paired with the output backend (no separate selector): `--backend=kms` uses
`LibinputBackend`, `--backend=nested` uses `WaylandInputBackend`. libinput
requires the build option `OVERDRAW_KMS=ON` (default ON on Linux). The addon
drains the backend on the Node thread (`uv_poll_t`) and delivers to an
optional `onInput` JS callback.

Seat acquisition (`native/core/seat.{h,cpp}`) wraps libseat. libseat picks its
backend (logind or seatd) per `LIBSEAT_BACKEND`. For headless / SSH dev where
the SSH session is not attached to a seat, seatd (`apt install seatd`, user in
`video`) is the working path; logind requires an active console session on
`seat0`. The seat's poll fd is on libuv; libseat dispatches enable/disable
events through it (slice-1 callbacks are no-ops — VT-switch handling lands in
the KMS slice). Devices opened through the seat are released via
`closeDevice(deviceId)` + a separate `close(fd)`; `LibinputBackend` does this
in its libinput `close_restricted` trampoline.

Output size on resize is propagated to the input backend via
`addon.updateOutputSize`, called from main.ts's onOutputDescriptor callback
(see "Output reconfiguration" below); both `WaylandInputBackend` and
`LibinputBackend` update their pointer-mapping / cursor-clamp rect from it.
The rect is the LOGICAL output size (device / scale), so pointer coordinates
are in logical space end-to-end (matching surface placement + hit-testing).
See "HiDPI / output scaling".

Limitations: touch not forwarded; no keymap translation at this layer (raw
evdev codes). The libinput backend has no per-backend unit test in this
slice — the conversion layer (libinput event → `InputEvent`) is verified
end-to-end on the test box (real device → libinput → `LibinputBackend` → JS
`onInput`), not in isolation. Full coverage arrives with the KMS slice
(slice 6 of `drm-design.md`) when libinput drives a real client end-to-end.
The libinput backend also ignores hotplug device add/remove (the events
arrive but are not surfaced upward); v1 is laptop-internal devices only.

### Routing to clients (`wl_seat`/`wl_pointer`/`wl_keyboard`)

A real client receives mouse and keyboard on its surface. `wl_seat` advertises
pointer + keyboard; `handleInput` hit-tests the WM window stack (`wm.windowAt`),
tracks focus, and emits enter/leave/motion/button/axis/frame +
key/modifiers to the focused client's resources with surface-local coordinates.

- **Focus policy is a bundled plugin** (`@overdraw/plugin-focus-default`,
  Phase 3 of `build-order.md`). Pointer always follows the pointer; the
  seat is policy-free for keyboard focus and dispatches `decide()` on
  coarse events (pointer-enter / pointer-leave / pointer-button /
  window-mapped / window-unmapped / explicit) to the active plugin in the
  `'focus'` namespace via the focus driver
  (`packages/core/src/protocols/focus-driver.ts`). Fire-and-forget:
  `handleInput` does not await the result; sequence-tagged dispatches
  discard stale results so the pointer path stays synchronous. The
  bundled plugin implements `follow-pointer` (default) and
  `click-to-focus`, plus `focusOnMap` (default true). Config flows in
  through the bundled-plugin config channel (the user's `config.focus`
  is passed verbatim to the plugin's init; core does not validate).
- **Keymap + modifiers** (`native/wayland/keymap.{h,cpp}`, xkbcommon): a default
  keymap is compiled to a sealed memfd, sent via `wl_keyboard.keymap` (XKB_V1, fd
  delivered through the trampoline fd-encode path); each host key feeds xkb state
  and serialized modifier masks are emitted via `wl_keyboard.modifiers`.
- A stable per-client id (`Trampoline::clientIdOf` / addon `clientId`) associates
  the focused surface with the right client's input resources without exposing
  `wl_client` to JS.

Verified with `foot` and `kitty` (focus on map, type without a click). Not built:
touch, multi-seat, key-repeat generation (repeat_info sent; client repeats), axis
source/discrete refinement. kbFocus is not auto-moved when the focused window
closes (re-resolves on next pointer event; guarded against destroyed surfaces).

Client cursor surfaces are end-to-end wired in Phase 9c (see the "Cursor
system" section below): `wl_pointer.set_cursor` + `wp_cursor_shape_v1` route
the client's cursor selection through the compositor's software cursor slot,
which draws above every layer at the pointer position.

## Protocols

### Wayland server + generic trampoline

The core accepts real Wayland clients and dispatches their protocol to JS, with
interfaces built at runtime from generator metadata (no per-protocol C):

- `native/wayland/server.cpp`: `wl_display` + listening socket, integrated into
  libuv (uv_poll dispatch; uv_prepare flush_clients).
- `native/wayland/interface_registry.cpp`: builds `wl_interface`/`wl_message[]`/
  `types[]` at runtime from the generated signatures (two-pass cross-reference).
- `native/wayland/trampoline.cpp`: a generic dispatcher decodes the `wl_argument`
  array into a typed tuple and calls the named JS handler. new_id args create a
  child resource; object args decode to a cached per-resource JS wrapper.
  `postEvent` encodes typed args (incl. server-minted new_ids and fds) and calls
  `wl_resource_post_event_array`. Resource destruction invalidates the JS wrapper.
  `registerInterface` stores a handler without advertising a global (request-
  created interfaces); `createGlobal` also `wl_global_create`s.

Trampoline arg support: `fd` decode (via `WaylandFd`, dup-on-decode, owner-tracked
with finalizer-close) and `fd` encode (events carrying fds) both implemented;
`array` encode proven on the wire; `array` decode and object-arg-into-handler are
implemented but not yet exercised end-to-end. Per-arg since-versioning is not
represented (message-level only). No live reload.

### Protocol generator (XML → JS/TS)

`tools/gen-protocol/` parses Wayland XML and emits, per interface, a `.js`
signature module (request/event tables with opcodes/arg metadata/since-versions;
enums; a `makeEvents(post)` factory) and a `.d.ts` typed contract (branded resource
types, handler interface, event-sender interface, enums). Output to
`packages/core/src/protocols-gen/` (gitignored, reproduced from XML). Generates from core wayland
+ xdg-shell + linux-dmabuf-v1 + primary-selection-unstable-v1; all `.d.ts`
type-check under `tsc --strict`.

### xdg-shell

A real client can create + configure an `xdg_toplevel`. `wl_compositor`/
`xdg_wm_base` are globals; `wl_surface`/`wl_region`/`xdg_surface`/`xdg_toplevel`
are request-created. The configure handshake (`xdg_toplevel.configure` with a
sized rect + states array → `xdg_surface.configure` serial → client
`ack_configure`) works, plus `set_title`/`set_app_id`. The states array
(`xdg_surface.ts` `buildStatesArray`) carries the resolved presentation:
`maximized`/`fullscreen`, the four `tiled_*` edges for a managed tile, and
`activated` for the keyboard-focused window. The behavioral-state requests
(`set_maximized`/`set_fullscreen`/`set_minimized`/`set_min_size`/`set_max_size`/
`move`/`resize`) route through `wm.propose`; see the "Read first" entry for the
residual no-ops.

### Subsurfaces (`wl_subsurface`, pixel-verified)

A child surface is composited above its parent at parent-rect + offset, with
spec-correct double-buffered commit semantics: `wl_surface` requests accumulate
into `pending`; commit applies (desync) or caches and applies on the parent's
commit (effective-sync). Sync/desync/inherited-sync computed up the parent chain;
`set_position` is double-buffered and applied on the parent commit; `set_sync`/
`set_desync` are immediate; frame callbacks arm on apply. Nested subsurfaces
handled recursively. `packages/core/src/subsurfaces.ts` gives each a layout rect + a draw-stack
slot above its parent, rebuilt whenever it could change. Verified: green child over
blue parent at parent+offset; sync child appears only on parent commit; desync
child appears on its own commit. **Gap:** `place_above`/`place_below` reordering is
a no-op (siblings draw in creation order).

### Popups (`xdg_popup` / `xdg_positioner`, pixel-verified)

`xdg_positioner` accumulates size/anchor_rect/anchor/gravity/constraint/offset; the
constraint solver (`packages/core/src/popup-position.ts`, unit-tested) places the anchor point →
gravity → offset → constrain to the output via flip/slide/resize per axis.
`get_popup` computes the rect, sends `xdg_popup.configure` + `xdg_surface.
configure`; on first content the popup maps above its parent (single stack owner,
`rebuildStackWithPopups`). Grab + click-away dismiss (`xdg_popup.grab` →
`popup_done` on outside press). A popup may itself parent subsurfaces (subtree
walked above it). Nested popups + reposition supported. Verified: a popup composites
at the computed parent-relative position and the client receives it; a
popup-parented subsurface composites above the popup. **Untested sub-paths:** the
grab/click-away dismiss and `reposition` (positioning + map are tested); constraint
flip/slide/resize is unit-tested in the solver but not end-to-end; `set_reactive`
is a no-op.

### Clipboard + primary selection (`wl_data_device` / `zwp_primary_selection_*`, verified)

Copy/paste and middle-click paste work between two real clients. Source
`create_data_source` → `offer(mime)` → `set_selection`; the compositor stores it
and, to the keyboard-focused client, mints a `data_offer`, sends `offer(mime)` per
type, then `selection(offer)`. The receiver `receive(mime, pipe-fd)` →
`data_source.send(mime, fd)` (the same `WaylandFd` flows request → event); source
writes, receiver reads. Selection follows keyboard focus (resent on focus change).
Primary selection is the identical flow on its own interfaces. Verified byte-exact
for both.

### Drag-and-drop (`wl_data_device`, verified)

`start_drag` takes a seat pointer grab; while active, pointer motion/button route to
the DnD machinery instead of `wl_pointer`. On motion the surface under the pointer
gets `data_device.enter` (fresh `data_offer` + `offer(mime)` + `source_actions`)
then `motion`; crossing surfaces sends `leave` + a new enter. Action negotiation
(intersect masks, honor preferred else copy>move>ask) drives `data_offer.action` +
`data_source.action`. Button release over an accepting target → `drop` +
`dnd_drop_performed` → receiver `receive`s + `finish`es → `dnd_finished`; release
over nothing/rejected → `cancelled` + abort. Verified byte-exact via the copy
action; negotiation unit-tested. **Untested sub-path:** drag-icon compositing
(implemented; the test passes a NULL icon, so not pixel-verified).

## Plugins

### Runtime (isolation + lifecycle + watchdog + restart)

A plugin module loads in its own `worker_threads` Worker, runs `init(sdk)`, and is
supervised. `packages/core/src/plugins/protocol.ts` is the Worker↔core envelope
(`request`/`response`/`event` with a pending-promise table, plus `ping`/`pong`
control kept outside the request table). `packages/core/src/plugins/bootstrap.ts`
(in the Worker) builds the SDK, dynamically imports the module, calls `init`,
auto-pongs pings, and handles `shutdown`. `packages/core/src/plugins/runtime.ts`
(`PluginRuntime`) owns one Worker per plugin with
`resourceLimits.maxOldGenerationSizeMb`, the lifecycle state machine
(`spawning`→`live`→`shutting-down`/`failed`), the watchdog (>K missed pongs →
`terminate()`), and the restart policy (`on-failure` up to `maxRestarts` in a
rolling `windowSeconds`, then permanently `failed`; `never` disables). Graceful
`stop()` awaits `onShutdown` up to `shutdownTimeoutMs` then terminates; forced
paths skip the callback. Timing tunables are injectable.

**Bundled plugins** (Phase 2, `packages/core/src/plugins/bundled.ts`) load
first on boot, before user-config plugins; user-config plugins load after the
server is up (`packages/core/src/main.ts`). Bundled plugins register at
priority 0 in the namespace registry; user plugins claiming the same
namespace at a higher priority displace them, demoting on failure (priority
chain). Currently bundled: `@overdraw/plugin-layout-default`,
`@overdraw/plugin-focus-default`.

### GPU SDK (overlays + decorations)

The cross-process plugin GPU path is built and pixel-verified end to end:

- **Worker owns its wire client + device + rendering** (`overdraw_plugin_native.
  node`, context-aware; `native/plugin-napi/`). The core owns the side channel and
  brokers everything: connection (`AddWireConn`, GPU-end fd via SCM_RIGHTS),
  instance injection, `SetPluginTickDevice`, surface allocation (`AllocSurfaceBuf`),
  and the per-frame fence brackets — reached from the Worker via the runtime's
  `onRequest` hook (`packages/core/src/plugins/gpu-broker.ts`). No listening
  socket: a new connection can only be introduced by the trusted core over the
  inherited side channel (auth by construction).
- **SDK** (`packages/core/src/plugins/gpu.ts`): `sdk.gpu.device` (a dawn.node GPUDevice over the
  Worker's wire) + `sdk.gpu.createOverlay({layer, anchor, size})` → a `Surface` with
  `getCurrentTexture()` + `present()`. `createOverlay` → the core overlay broker
  decides rect + layer and allocates the shared buffer ring; the plugin renders;
  `present()` drives producer-End → consumer-Begin (waits the producer fence) → the
  JS compositor samples the consumer texture at the overlay rect+layer. The
  access brackets ride the wire sockets IN-BAND (kind=1/kind=2 frames), not the
  ctrl channel: producer Begin/End on the Worker's plugin wire, consumer Begin/End
  on the core wire, each FIFO-ordered against the render/sample commands on the
  same wire — no ctrl round-trip and no WireBarrier deferral in the per-frame path
  (see INBAND-ACCESS.md). The cross-device fence dance itself is unchanged.
- **Surface ring with SharedArrayBuffer slot-state**
  (`packages/core/src/plugins/surface-slots.ts`): 3 slots, each a shared dmabuf, with one Int32 per slot transitioning
  via atomic CAS (`FREE → ACQUIRED → PRESENTED → DRAINING → FREE`).
  `getCurrentTexture` is async: CAS-claims a FREE slot or `Atomics.waitAsync` (not
  `wait` — the Worker loop must keep turning for watchdog pongs) until one frees.
  The `DRAINING → FREE` flip is gated on the consumer's GPU completion
  (`onSubmittedWorkDone` via `afterCurrentFrame`), mirroring the SharedFence
  brackets. The plugin is oblivious — it calls only `getCurrentTexture` + `submit` +
  `present`; slots, fences, and brackets live in the SDK + broker + GPU process.
- **Verified**: a static overlay composites at its rect (black elsewhere); a plugin
  animates green→red→blue on its own clock and the composited output shows multiple
  distinct colors over time; a shipped example animates a shader-gradient titlebar
  with continuous presents and no access errors.

### Core event bus + window-state stream

A typed in-core bus (`packages/core/src/events/bus.ts`, `TypedBus<M>`:
`on`/`emit`/`clear`, synchronous fan-out, throwing listeners caught + logged)
with a concrete instance + event map
(`packages/core/src/events/window-bus.ts`, `CompositorEventMap`:
window.map/unmap/change + keyboard.focus). Payloads
(`packages/core/src/events/types.ts`) are structured-clone-safe (forwardable
over postMessage). Producers: the map sweep emits `window.map`; surface
teardown emits `window.unmap`; set_title/set_app_id + keyboard-focus changes
mark a per-frame dirty set drained into one coalesced `window.change` per
surface (consistent snapshot, closes the late-`set_app_id` hole). Plugin
side: `sdk.window` `onMap`/`onUnmap`/`onChange`
(`packages/core/src/plugins/window-observer.ts`), validating each payload at
the trust boundary; `main.ts` forwards window.* to the runtime
(`broadcast`/`emit`). **Gap:** `window.change` covers only
title/appId/activated. Presentation changes (maximized/fullscreen/minimized/
floating/parent) are not folded into `window.change`; they surface instead on
the `window.proposed`/`window.committed` events emitted by `wm.propose`. The
bus is ready to also carry them on `window.change` if a consumer needs the
unified stream.

**Pattern subscribe + plugin emit** (`dynamic-bus.ts`): on top of the
typed bus, a dynamic, string-keyed event bus supports
`sdk.events.subscribe(pattern, cb)` (exact name or glob — `'workspace.*'`,
`'*'`) and `sdk.events.emit(name, payload, opts?)`. Core re-publishes the
typed bus's `CompositorEventMap` events into the dynamic bus so plugin
subscribers see them under the same names; plugins emit into their own
namespaces. This is the substrate the IPC server's `subscribe` /
`unsubscribe` methods route through.

**Interception** (`dynamic-bus.ts intercept` + `events.ts`,
core-plugin-api.md §3.1): on top of passive subscription, the bus supports
`sdk.events.intercept(pattern, handler, {priority?})`. A handler may return
a new payload (modify), a `Promise` resolving to one (defer + modify), or
`undefined` (observe-only). `bus.emit(name, payload, {timeoutMs?})` runs
matching interceptors in priority order (lower first; registration order
breaks ties), then fans out observers with the FINAL payload. Hot path is
unchanged when no interceptors match: observers fan out synchronously and
the returned Promise is already-resolved. `emitSync` is the variant for
sync-only sites (frame timer, synchronous input handlers): observers run
synchronously; matching interceptors run for side effects but their
return values are discarded. `markSyncOnly(name)` declares a name as
sync-only so `intercept()` warns at registration. The plugin-side
interceptor handler runs over the same Endpoint as
subscribe/emit: `events.intercept-register` / `events.intercept-unregister`
(one-way), `events.intercept-handle` (core->plugin REQUEST whose reply
is the modified payload or an observe-only marker). Worker postMessage
round-trip is bounded by the per-handler `timeoutMs`. Same wiring in
both `runtime.ts` (Worker) and `inthread-plugin.ts` (bundled).

### Plugin SDK substrate (Phase 0)

Foundation primitives on which everything else layers; see
`core-plugin-api.md` for the API surface and `build-order.md` for the
sequencing.

- **Namespace registry** (Phase 0b,
  `packages/core/src/plugins/namespace-registry.ts` +
  `namespace.ts`/`runtime.ts`): a plugin claims a string namespace at a
  priority and exposes typed methods; the registry records all
  registrations sorted priority-descending. The head is the active winner;
  failure (Worker terminate, restart-budget exhaustion) demotes to the
  next-highest registration (priority chain). `sdk.registerPlugin(name,
  init, {priority?})` + `sdk.plugin(name)`; cross-Worker invocation routes
  through `runtime.invokeNamespace(namespace, method, args)`. Bundled
  plugins register at priority 0 (the floor) unless they explicitly
  override. The layout driver (Phase 2) is the first real consumer.

- **Action registry** (Phase 0c,
  `packages/core/src/plugins/action-registry.ts` + `actions.ts`):
  `sdk.actions.register({name, description?, schema?, handler})` /
  `sdk.actions.invoke(name, params?)` / `sdk.actions.list()`. Name
  collisions throw on registration. Actions are the IPC's primary entry
  point; the bundled actions surface today is empty (Phase 6+ greenfield
  plugins add their own actions).

- **Per-window state bag + `propose` + snapshots** (Phase 0d,
  `packages/core/src/plugins/windows-sdk.ts` + `windows-broker.ts`):
  `sdk.windows.propose(id, proposal, reason)` drives behavioral state
  (presentation maximized/fullscreen/minimized/floating, layoutMode,
  constraints, parent) through `wm.propose` and returns the committed
  `WindowState`; presentation changes take effect in the layout (see the WM
  behavioral-state section). `setState(id, key, value)` / `getState` /
  `deleteState` is the
  untyped per-window state bag; structured-clone-validated at the
  bundled/external boundary. `get(id)` / `list()` snapshot windows for
  the plugin (used by the layout driver and any plugin needing inputs
  without subscribing). Convention: namespace your keys
  (`'workspace.id'`, `'rules.tags'`) — ownership is conventional.

- **`setOutputStack`** (Phase 0e): `sdk.windows.setOutputStack(outputId,
  ids[]|null)` per-output stack ordering, primitive replacing the prior
  global `setStack`. The compositor filters its stack per output; passing
  `null` clears the per-output override and falls back to the global
  stack. Substrate for workspaces (Phase 6).

### IPC: JSON-RPC 2.0 server + `overdrawctl` (Phase 1)

- **Server** (`packages/core/src/ipc/server.ts`, ~330 lines): listens on
  `$XDG_RUNTIME_DIR/overdraw-<display>.sock` (mode 0700), strict JSON-RPC
  2.0 framing (LF-delimited JSON, one request per line). Methods:
  - `invoke {action, args?}` — dispatch into the action registry; result
    or JSON-RPC error.
  - `list-actions` — enumerate registered actions (`ActionInfo[]`).
  - `subscribe {pattern}` — register a dynamic-bus pattern; returns
    `{subscription}`. Matching events arrive as id-less notifications:
    `method: "event"`, `params: {subscription, name, payload}`.
  - `unsubscribe {subscription}`.

- **`overdrawctl`** (`packages/core/src/cli/overdrawctl.ts`, ~260 lines;
  shipped as `bin/overdrawctl` in the `overdraw` npm package): thin CLI
  wrapper mapping `overdrawctl <action> [args...]`, `overdrawctl list`,
  `overdrawctl subscribe <pattern>` to JSON-RPC over the socket.

Authentication is filesystem permissions on the socket; no token / per-
caller auth.

### In-thread bundled plugin transport + config channel (Phase 3)

Bundled plugins (those listed in `BUNDLED_PLUGINS`) load in-thread on
the main event loop, not in a worker_threads Worker. User-installed
plugins continue through the Worker path unchanged. Selection is by
`ResolvedPlugin.bundled`; the runtime branches on it in `load()`. The
SDK contract is uniform across both transports (every call returns a
Promise), but the in-thread path resolves on the next microtask via
direct call -- no postMessage, no structured clone, no watchdog
ping/pong, no `resourceLimits`. Bundled plugins are core's own code
and are trusted at the same level.

- **Pair channel** (`packages/core/src/plugins/pair-channel.ts`): two
  in-memory `Channel`s connected back-to-back. Either end's
  `postMessage` delivers to the other end's listener on the next
  microtask. The Endpoint (Worker path's transport adapter) talks to
  this channel unchanged -- the transport-agnostic shape is what makes
  the same SDK construction code run on both paths.
- **Loader extraction** (`packages/core/src/plugins/loader.ts`): the
  generic body of the former `bootstrap.ts` (build SDK; dynamic-import
  the plugin module; call `init(sdk, config?)`; report init result).
  `bootstrap.ts` is now a thin Worker entry that grabs `parentPort` and
  delegates; `inthread-plugin.ts` calls it on the main thread with the
  paired channel's other end.
- **InThreadPlugin** (`packages/core/src/plugins/inthread-plugin.ts`):
  implements the same `PluginHandle` interface as `ManagedPlugin`
  (`packages/core/src/plugins/plugin-host.ts`), so the runtime holds a
  mixed list. Failure handling differs: init throws are fatal startup
  errors (no respawn); per-call exceptions from registered methods are
  caught at the Endpoint boundary, logged, treated as null/empty result;
  the plugin stays registered. User-facing diagnostic surfacing is TBD.

**Per-bundled-plugin config channel.** Plugin `init` now takes a second
arg: `init(sdk, config?: unknown)`. Core passes the value verbatim --
no validation; the plugin owns its schema. For bundled plugins, the
config slice comes from the user config via `BundledPluginSpec.configFrom`
(e.g. `(config) => config.focus` for `plugin-focus-default`). For user
plugins, the slice is `ResolvedPlugin.raw` (the user's full plugin entry).
Plugins that don't take config simply ignore the second arg.

**In-thread `sdk.gpu` (core-device shared).** Bundled plugins get
`sdk.gpu.device === core's GPUDevice` -- the SAME JS object the JS
compositor uses; no separate device, no plugin-side wire client, no
`overdraw_plugin_native.node` load. `sdk.gpu.createOverlay({layer,
anchor, width, height})` returns a `Surface` whose slots are core-device
`GPUTexture`s allocated with `RENDER_ATTACHMENT | TEXTURE_BINDING`;
`present()` installs the just-rendered slot via
`compositor.setSurfaceTexture` and recycles the prior slot once the
compositor's GPU read of it completes (`afterCurrentFrame`). Triple-
buffered like the Worker path, but no SAB, no atomics, no fences --
same-device queue ordering guarantees the compositor's sample sees
the plugin's render writes (`packages/core/src/plugins/inthread-gpu.ts`).
The contract is the same `PluginGpu` interface (`packages/core/src/
plugins/gpu.ts`) the Worker path exposes; the plugin source is
identical across transports per `customization.md` "Two execution
paths, one SDK". Wired through `RuntimeOptions.inThreadGpu` ->
`InThreadPlugin` -> `loader.ts`; `main.ts` populates the bundle from
its already-built core device + overlay broker + compositor + dawn
globals.

A bundled plugin without `inThreadGpu` plumbed in (GPU-free unit
tests, headless harnesses with no compositor) gets `sdk.gpu`
absent -- same fallback as user plugins lacking `pluginAddonPath` /
`dawnPath`.

### Bundled plugins extracted from core (Phase 2 + 3)

- **`@overdraw/plugin-layout-default`** (Phase 2): master-stack
  tiling. Namespace `'layout'`, priority 0. Core seam:
  `packages/core/src/wm/layout-driver.ts`. Type contract:
  `@overdraw/layout-types`. Migrated to the in-thread transport in
  Phase 3 (no plugin code change; the runtime picks transport based on
  `bundled: true`).
- **`@overdraw/plugin-focus-default`** (Phase 3): follow-pointer +
  click-to-focus, plus focusOnMap. Namespace `'focus'`, priority 0.
  Internal state machine in `policy.ts`; pure (no async, no SDK
  references) and tested in isolation. Core seam:
  `packages/core/src/protocols/focus-driver.ts` (dispatches `decide()`
  fire-and-forget; applies result via the seat's `applyKeyboardFocus`).
  Type contract: `@overdraw/focus-types` (FocusAPI is `decide()`-only;
  no `getMode` / named modes / `'custom'` -- the bundled plugin is the
  named-mode floor, and any alternative focus plugin replaces it
  end-to-end). Config flows in from the user's `config.focus`
  verbatim; the plugin validates and throws on bad schema (manifests
  as a fatal startup error).

**`sdk.windows.focus(id)`** (Phase 3): explicit focus override. Bypasses
the focus plugin's `decide()` and applies via the seat directly. For
policy-mediated focus, plugins emit an event the focus plugin observes
(or wait for one of the standard coarse events). The `'explicit'`
`decide()` reason is reserved for future paths where a caller wants the
plugin's policy to apply (e.g. an IPC action that delegates).

### Animation evaluator (Phase 4b)

`sdk.animations.run(spec)` / `sdk.animations.cancel(target)`
(core-plugin-api.md §9). Plugins submit a declarative `AnimationSpec`;
core evaluates per compositor frame and writes the result through the
per-surface render state primitives (Phase 4a:
`setSurfaceOpacity` / `setSurfaceTransform` / `setSurfaceOutputMargin`).
One IPC call per animation regardless of duration -- the evaluator
ticks in-core.

- **Spec format** (`@overdraw/animation-types`): `tween` (cubic-bezier
  easing + the four CSS presets), `spring` (semi-implicit Euler with
  rest-velocity threshold; default stiffness 200, damping 20, mass 1),
  `sequence` (await items in order), `parallel` (await all items
  concurrently). `decay` / `keyframes` / `stagger` are deferred until
  concrete use cases demand them (per `core-plugin-api.md` "v1
  minimal"). User-function easings are not supported (not
  serializable); cubic-bezier covers the same envelope. The shared
  type package follows the same pattern as `@overdraw/layout-types`
  and `@overdraw/focus-types`: core's evaluator + broker, the
  `@overdraw/sdk-anim` builders, and any plugin that wants to
  type-check specs directly all import from one source.
- **Targets**: `window-opacity`, `window-transform` (full
  translate+scale object), `window-output-margin` (full margin
  object). One active leaf per (kind, windowId) at a time --
  cancel-on-replacement: a new leaf on the same target preempts the
  prior one (its `run()` Promise resolves cleanly, then the new leaf
  starts on the next tick). `cancel(target)` resolves the same way.
- **Evaluator** (`packages/core/src/animations/evaluator.ts`): holds
  the active leaf list keyed by `targetKey`; `tick(timeMs)` computes
  dt against the last tick, clamps to 100ms (covers first-tick / long-
  pause gaps without spawning huge accelerations), and steps each leaf
  once. Writes results via `CompositorSink` setters. Composite specs
  (sequence / parallel) unfold into leaves whose Promises the
  composite awaits.
- **Frame integration**: the evaluator's `tick(timeMs)` runs from
  `protocols/index.ts`'s `dispatchFrameCallbacks` via the new
  `state.beforeRender(timeMs)` hook, BEFORE the compositor's
  `renderFrame()`. Same `timeMs` the wl_surface.frame callbacks see;
  no separate clock. The hook is optional (GPU-free tests omitting
  the evaluator leave it unset).
- **From-required-in-v1**: `from` is required on tween / spring specs.
  When the evaluator gets a value-cache reading the surface's current
  state (to default `from` from there), this becomes optional --
  open per `core-plugin-api.md` §9.
- **Tests**: `test/animations-evaluator.test.js` (pure-unit, 15 tests:
  tween linear / preset easings / clamping / zero-duration / transform
  multi-field; spring overshoot + settle + critically-damped
  no-overshoot; cancel-on-replacement; sequence / parallel
  completion; payload validation), `test/animations-broker.test.js`
  (pure-unit, 7 tests: routing + malformed-payload rejection),
  `test/inthread-animation.gpu.mjs` (GPU integration via a bundled
  in-thread plugin running `sdk.animations.run` on opacity; readback
  at midpoint + completion).

### `@overdraw/sdk-anim` (Phase 4c)

The plugin-side spec builder library. Type-safe functions that
produce `AnimationSpec` values plugins submit via `sdk.animations.run`:

- `tween(target, { from, to, duration, easing? })` -> `TweenSpec`
- `spring(target, { from, to, stiffness?, damping?, mass?,
  initialVelocity? })` -> `SpringSpec`
- `sequence(...items)` / `parallel(...items)` -> composite specs
- `target.windowOpacity(id)` / `windowTransform(id)` /
  `windowOutputMargin(id)` -> `TargetRef` values
- `cubicBezier(x1, y1, x2, y2)` + `easings.*` (linear / ease / easeIn /
  easeOut / easeInOut) -> easing values

The builders are stateless functions over `AnimationSpec` shapes from
`@overdraw/animation-types`; no SDK runtime dependency. Tests:
`test/sdk-anim-builders.test.js` (pure-unit, 14 tests: shape checks
for each builder + composites + easings + statelessness),
`test/sdk-anim.gpu.mjs` (GPU integration via a bundled in-thread
plugin that uses `import { tween, target } from "@overdraw/sdk-anim"`
to construct a spec and submits it; midpoint + completion pixel
readback matches the hand-built-spec test).

The builder API diverges from the doc example in
`core-plugin-api.md:407-413` in one small way: the doc shows
`animate(...)` calling `sdk.animations.run`, but the builder pattern
chosen returns the spec value (the plugin author passes it to
`sdk.animations.run` themselves). Returning specs avoids requiring
the package to capture a Worker-bound SDK reference; the boilerplate
delta is one wrapping call per animation site.

### Event interception + window.relayout (Phase 4.5)

Generalizes the bus from observe-only into observe-or-modify. The bus
mechanism (intercept registration, async emit with chain, sync-only
variant) is described above under "Pattern subscribe + plugin emit".
This subsection describes what core EMITS on the bus that the new
mechanism gates.

- **`window.relayout`** (`packages/core/src/events/types.ts` +
  `wm/index.ts applyLayout`): emitted per affected window inside
  `applyLayout` BEFORE the WM mutates its outer rect, calls
  `compositor.setSurfaceLayout`, or fires `xdg_toplevel.configure`.
  Payload `{ surfaceId, oldOuter, newOuter }`. The WM awaits the emit
  with a 100ms per-handler timeout. An interceptor that returns a
  modified payload with a different `newOuter` redirects the WM's
  installed rect (validated as a finite-numbered Rect; garbage falls
  back to the layout's intended `newOuter`). An interceptor that
  returns `undefined` may still have done side-effects (e.g. submitted
  a `sdk.windows.setTransform` animation) before the WM proceeds. The
  `LayoutApplyTarget.apply` contract returns `void | Promise<void>`;
  the layout driver awaits it so coalesced relayouts serialize behind
  the interceptor chain.
- **Wiring**: `installProtocols({pluginBus})` threads the dynamic bus
  into the WM via `createWm({pluginBus})`. GPU-free tests that don't
  pass a bus get the no-emit path.
- **Tests**: `test/dynamic-bus-intercept.test.js` (pure-unit, 39 tests
  covering modify/defer/priority/timeout/sync-only/markSyncOnly/error
  handling), `test/wm-relayout-event.test.js` (pure-unit, 8 tests:
  emit payload shape, observer sees post-modification, interceptor
  modifies the installed rect, async interceptor defers WM mutation,
  garbage fallback, no-bus path, stuck-handler 100ms timeout),
  `test/sdk-events-intercept.test.js` (e2e through Worker + in-thread,
  9 tests: modify/observe/defer/priority/observer-payload/off()/teardown-
  release/in-thread-transport/per-handler-timeout),
  `test/relayout-intercept.gpu.mjs` (GPU integration: real wayland
  client maps, bundled plugin's intercept modifies newOuter, WM
  applies the intercepted rect; second test verifies the plugin sees
  both oldOuter and newOuter in the payload).

### Scene compose (Phase 5a)

`sdk.compose.scene` / `sdk.compose.windows` for in-thread bundled plugins.
Render a window subset into a fresh `GPUTexture`; two modes:
`'snapshot'` (one-shot at call time, frozen thereafter) and `'live'`
(re-rendered every on-screen `renderFrame()`, kept in sync with
compositor state). The texture is on core's GPU device; the plugin
shares that device in-thread and can sample/copy/blit it as if it
were any other resource. core-plugin-api.md §6 is the spec; the
intercept-chain language there is forward-looking (Phase 10) -- the
chain is not yet applied to compose textures.

- **Refactor** (`packages/core/src/gpu/compositor.ts`):
  - `composite({encoder, targetView, drawList, outW, outH, placements?, cropUV?})`
    is a pure pass-encoder. Both `renderFrame` (on-screen) and the
    compose path encode their passes through it; the on-screen frame
    skipping work when nothing changed will live in this single
    chokepoint when dirty-tracking lands.
  - `openImportBrackets(drawList, bracketed)` / `closeImportBrackets(bracketed)`
    factor the dmabuf BeginAccess / EndAccess pair, de-duping on
    `importId` (the GPU process forbids two Begins without an End on
    one import). The frame's brackets cover the UNION of imports
    across on-screen + every live composer's window list; one Begin
    per import per frame regardless of how many passes sample it.
  - `updateUniforms(s, ow, oh, overrides?)` takes target dims as
    parameters; compose passes targeting non-output-sized textures
    normalize their per-surface placement to the actual target. The
    `cropUV` override (Map<surfaceId, {u0,v0,u1,v1}>) is the
    sub-region of the surface texture to sample; `placements`
    overrides the per-surface output rect for the duration of a
    compose pass.

- **WGSL** (`compositor.ts:41-117`): `Uniforms` gains a `cropUV vec4f`
  slot (UNIFORM_BYTES 64 -> 80). The fragment shader maps
  `surfUV` through `mix(cropUV.xy, cropUV.zw, surfUV)` before
  sampling the surface texture; identity (0,0,1,1) is the default
  for every surface, so on-screen pixels are unchanged from before
  the refactor.

- **Snapshot** (`composeScene` / `composeWindows`): allocate a
  `RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC` texture in
  `this.format`, open its own short-lived dmabuf brackets, encode
  one composite pass, submit, close brackets. Synchronous wrt the
  on-screen frame loop (JS is single-threaded; the snapshot returns
  before the next tick). Does NOT drive the lifecycle state machine
  (frameStart / frameSampled / submitted / gpuCompleted) -- that
  cycle exists to track client `wl_buffer` release and snapshot
  sampling of cached imports has no bearing on it. Wire-level
  brackets are still required so the GPU process can keep the
  access window open around its sample commands; `openImportBrackets`
  handles them.

- **Live** (`registerLiveScene` / `registerLiveWindows`): the
  compositor holds a list of live targets; every `renderFrame()`
  iterates them after the on-screen pass, encoding one composite
  per live target into the same command encoder. One `submit`
  closes everything together; one set of brackets covers the union.
  `release()` removes the registration and destroys the underlying
  texture (the holder polls texture contents between frames; the
  texture handle is stable across frames, only its contents update).

- **Per-window crop** (`composeWindows`): the `rect` parameter is a
  source-crop rect in surface-local pixels. Each per-window target
  is sized to the crop's dims; the crop region fills the entire
  output via the placement-override + cropUV-override mechanism.
  Per-surface render state (opacity / transform / mask /
  outputMargin) is NOT applied to per-window compose textures
  today -- those are on-screen placement state, and a per-window
  crop is content extraction.

- **SDK** (`packages/core/src/plugins/compose-sdk.ts`):
  `PluginCompose.scene(args)` / `PluginCompose.windows(args)`
  return `Promise<SceneHandle>` / `Promise<WindowComposition>`
  with `texture` (or per-window `windows[i].texture`), `outW`/`outH`
  (or per-window `rect`), and `release(): Promise<void>`. Wired in
  `sdk.ts` / `loader.ts` only when the loader is the in-thread
  path; Worker plugins receive `sdk.compose === undefined`
  (capability-by-shape; Phase 5b adds the dmabuf-import transport
  for them).   `outputId` validation rejects anything other than
  `OUTPUT_DEFAULT` -- overdraw is single-output today (drm-design.md
  defers multi-output enumeration + per-output frame clocks).

- **Tests** (`test/compose.gpu.mjs`, 7 tests, all real Wayland clients
  through `setupCompositor`): snapshot byte-identical to on-screen
  composite; snapshot frozen across subsequent state changes;
  live reflects per-surface state and matches on-screen the same
  frame; per-window crop extracts a sub-region; two-window
  compose.windows produces two textures; release destroys the
  texture and removes the live registration (idempotent); SDK
  wrapper (`createInThreadCompose`) handles snapshot + live + the
  outputId validation. 66/66 GPU tests pass (was 59; +7 compose).

**Not yet built (Phase 5b live mode and beyond)**: live mode for
Worker plugins (snapshot is in; live is the per-frame variant where
the same dmabuf is re-rendered each `renderFrame` and the plugin
samples it between frames -- the fence-bracket dance is per-frame,
not per-snapshot). The intercept chain (Phase 10) that
`core-plugin-api.md` §6 references as "applied" to compose textures
-- the per-surface state currently baked in is opacity / transform /
mask / outputMargin plus decoration surface splicing, but no
per-pixel plugin transform. Multi-output: `outputId` is plumbed
honestly but only `OUTPUT_DEFAULT` is meaningful until multi-output
enumeration lands (output resize/reconfiguration itself is built --
see "Output reconfiguration").

### Cross-device compose for Worker plugins (Phase 5b — snapshot + live)

`sdk.compose.scene({mode:'snapshot'|'live'})` for Worker plugins --
the plugin gets a `GPUTexture` on ITS OWN device backed by a dmabuf
the core produced into. Uses the same cross-device dmabuf machinery
as the plugin-overlay path with the producer/consumer roles SWAPPED:
core = producer (writes), plugin = consumer (samples). Producer
Begin/End ride the core wire; consumer Begin/End ride the plugin wire.

Snapshot is one-shot: core renders ONCE into a dmabuf, plugin samples
once, both release. Live is per-frame: core renders into a 3-slot
ring every `renderFrame`, plugin samples the LATEST presented slot
via `sample(cb)`. The ring's atomic SAB-CAS slot state machine + per-
slot SharedFence brackets keep producer and consumer non-racing
(they work on different physical memory at any moment).

- **New wire op**: `AllocComposeBuf` (`'c'`). Same payload shape
  as `AllocSurfaceBuf` -- the GPU process reads the direction
  flag (a new `SurfaceBuf.producerOnCore`) to know which side
  of each wire field is the producer vs consumer.
- **GPU-process dispatchers** (`packages/core/gpu-process/src/main.cpp`):
  the in-band Surface frame dispatchers on the core wire + each
  plugin wire are role-parameterized. Each surface declares its
  direction at allocation; the dispatchers validate each in-band
  frame's `producer` bit against the surface's recorded
  direction. Missing surface = release race; silently skipped
  on End (matches pre-refactor behavior for the overlay path).
- **Refactor**: the `AllocSurfaceBuf` + `AllocComposeBuf` handlers
  share one `allocSurfaceBufImpl(m, producerOnCore)` lambda. The
  Allocator + GBM + dual-import code is unchanged; only the
  device-resolution and inject-routing flips.
- **Core C++**: `Compositor::reserveCoreComposeTexture` (reserves
  with `RENDER_ATTACHMENT|TEXTURE_BINDING|COPY_SRC` on the core
  device), `sendAllocComposeBuf` (mirror of `sendAllocSurfaceBuf`
  for the new tag), `writeProducerBegin/EndAccess` (in-band on
  the core wire). napi `coreAllocComposeBufferW`,
  `writeProducerBegin/End`.
- **Plugin C++**: `WorkerWireClient::reserveConsumerTexture` (the
  inverse of `reserveProducerTexture`; reserves with
  `TextureBinding|CopySrc` on the plugin device),
  `consumerTexture` / `forgetConsumerReservation`. In-band
  `writeConsumerBegin/EndAccess` on the plugin wire. napi
  `reserveConsumerTexture` / `consumerTexture` /
  `forgetConsumerReservation` / `writeConsumerBegin/End`.
- **Producer/Consumer abstractions** (`packages/core/src/plugins/
  surface-ring.ts`): `SurfaceProducer` and `SurfaceConsumer` over a
  `SlotStates` ring. Direction-agnostic: parameterized by which
  wire writes the brackets (writeBegin/End) and a `textureFor` per-
  slot wrapper. The overlay path (plugin = producer / core =
  consumer) and the compose path (core = producer / plugin =
  consumer) both build on these abstractions; the SAB-CAS slot
  state machine in `surface-slots.ts` is shared unchanged.
  - `SurfaceProducer.tryAcquire/present` (sync) used by
    renderFrame's per-frame produce; `acquire/present` (async)
    used by the worker's overlay path.
  - `SurfaceConsumer.swapToLatest` for push notifications (overlay
    surface.present); `beginConsume + endConsume` for pull
    sampling (compose.live).
  - `demoteStaleOnPresent` flag (set for compose-live): the
    producer demotes other PRESENTED slots on each new present so
    the pull consumer's `presentedSlot()` always returns the
    LATEST.
- **JS broker** (`gpu-broker.ts`): new `compose.snapshot` (one-
  shot AllocComposeBuf + composeIntoView) and `compose.live`
  (per-slot AllocComposeBuf + registerLiveProducer + per-frame
  tryAcquire/composeIntoView/presentSync). `compose.release`
  handles both shapes (single surfaceBufId for snapshot, array
  for live).
- **JS compositor** (`compositor.ts`): `composeIntoView(args)`
  for the snapshot path (one render pass into a pre-allocated
  target view, optionally wrapped in producer Begin/End on the
  core wire). `registerLiveProducer(cb)` for per-frame produce:
  the compositor invokes `cb` after the on-screen frame submits;
  each callback owns its own ring + SurfaceProducer.
- **JS plugin SDK** (`compose-sdk.ts`): `createWorkerCompose`
  builds a `PluginCompose` backed by the broker round-trips. The
  `SceneHandle` exposes `sample(cb)`: in snapshot mode and the
  in-thread variants it's a no-op wrapper (runs cb with the
  texture immediately); in Worker live mode it wraps cb in
  consumer Begin/End brackets so the cross-device fence chain
  serializes the plugin's reads against the core's per-frame
  writes. Wired into `loader.ts` so Worker plugins receive
  `sdk.compose` (in-thread plugins keep `createInThreadCompose`,
  unchanged).

**Verified**:
- `test/compose-worker.gpu.mjs` (snapshot): a Worker plugin
  calls `sdk.compose.scene({mode:'snapshot'})` against a real
  Wayland client's window, reads back the texture on its own
  device via `copyTextureToBuffer`+`mapAsync`, and asserts the
  center pixel matches the client's color.
- `test/compose-worker-live.gpu.mjs` (live): same setup with
  `mode:'live'`. The test mutates `setSurfaceOpacity` on the
  source surface and verifies both samples reflect the new
  state. (The mutation is applied BEFORE the plugin loads
  because the worker-to-main-thread `sdk.log` events have
  multi-second propagation latency through the plugin runtime's
  Endpoint, so mutating between two log-driven sample events is
  unreliable. Mutate-before-load proves the cross-device fence
  chain correctly delivers the producer's writes to the
  consumer's GPU on every sampled frame.)

68/68 GPU tests pass (was 66 pre-5b; +1 snapshot, +1 live).

**Not yet built**: `compose.windows` for Worker plugins (the per-
window crop variant). Deferred until a real use case forces it
(the in-thread `compose.windows` works; Worker version throws a
clear error).

### Per-surface color primitives (Phase 5.5a)

Tint + color matrix extend the existing per-surface uniform path
(`setOpacity`/`setTransform`/`setMask`/`setOutputMargin`). One sample
per pixel modulated by uniforms; no neighbor sampling. Effects that
need to read neighbor pixels (blur, distortion) are for the buffer-
intercept path (Phase 10), not core primitives.

- **`sdk.windows.setTint(id, {r?, g?, b?, a?})`**
  (`packages/core/src/plugins/windows-sdk.ts`,
  `gpu/compositor.ts setSurfaceTint`): per-channel multiplier on the
  sampled rgba. Missing fields default to 1 (identity). Common cases:
  workspace inactive dim `{r:0.5, g:0.5, b:0.5}`; alpha fade `{a:0.5}`.
- **`sdk.windows.setColorMatrix(id, mat4 | null)`**
  (`gpu/compositor.ts setSurfaceColorMatrix`): 4x4 column-major matrix
  applied to the sampled rgba BEFORE the tint. Caller passes 16
  numbers (or a `Float32Array`); `null` restores identity. Covers
  saturation, hue rotation, contrast, brightness, channel swap,
  arbitrary linear color transforms.
- **WGSL**: `Uniforms` extended with `tint vec4f` (slot 5) and
  `colorMatrix mat4x4f` (slots 6-9 as 4 column vectors). Total
  uniform size 160 bytes (was 80). Fragment shader applies
  `surf = colorMatrix * surf; surf = surf * tint;` before the
  existing `inside * mAlpha * opacity` modulation. Identity
  defaults make the rendering byte-identical to pre-5.5a when no
  plugin has touched these values.
- **Broker** (`packages/core/src/plugins/windows-broker.ts`):
  `windows.set-tint` / `windows.set-color-matrix` routes; SDK-side
  validation in `windows-sdk.ts` (finite numbers; matrix length =
  16); broker re-validates at the boundary.
- **Tests**: pure-unit
  (`test/windows-broker-fx.test.js`: 13 new tests on payload
  validation + sink-missing-method rejection;
  `test/sdk-windows.test.js`: 2 end-to-end Worker round-trips
  through the driver fixture). GPU
  (`test/compositor-fx.gpu.mjs`: 7 new tests on identity defaults,
  per-channel tint scaling, swap-rg matrix, matrix-before-tint
  order, `Float32Array` accepted, `null` clears).

75/75 GPU tests pass (was 68 pre-5.5a; +7 from compositor-fx).
479/479 unit tests pass.

**Skipped**: 5.5b (3D LUT) -- per build-order.md, skip until a real
consumer wants it.

### Workspaces (Phase 6)

Dynamic workspaces driven by the first greenfield bundled plugin.
The plugin owns the registry; core sees only per-output stack
overrides via `sdk.windows.setOutputStack(outputId, ids[])`. Switching
workspaces changes WHAT THE COMPOSITOR DRAWS on that output -- the
WM's layout is unchanged (it has no concept of workspaces). A window
on a hidden workspace keeps its tile geometry; the compositor renders
that tile's region as the clear color (opaque black) because the
hidden surface isn't in the per-output draw list.

**Two-id model.** Each workspace has two identifiers:
- `WorkspaceHandle` (branded number, stable, monotonic, never reused):
  stored in the per-window state bag under `'workspace.id'` and carried
  in event payloads. Subscribers caching this id don't break when other
  workspaces are destroyed.
- `WorkspaceIndex` (branded number, 1-based position): what hotkeys,
  CLI (`overdrawctl workspace.show 2`), and status bars use. Dense;
  shifts down on destroy.

Methods that take user input (the action surface) accept an Index and
resolve it to a handle at the boundary.

**Bundled plugin** (`@overdraw/plugin-workspace-default`): in-thread,
namespace `'workspace'`, priority 0. Loads after `focus-default` (so
`requestFocusDecision` reaches a live focus plugin). Maintains:
- Workspace registry: `byHandle` (records), `positionsByOutput`
  (ordering), `shownByOutput`, `surfaceToHandle` (reverse index),
  `nextHandle` (monotonic counter).
- An invariant: at least one workspace exists per output that has
  been touched. Workspace 1 is created on init.
- Destroy policy: removes the workspace at the requested index;
  shifts subsequent indices down; relocates members to the workspace
  that took the destroyed position (or the new last one when
  destroying the tail); if positions become empty, allocates a fresh
  handle for the new index 1.

**Action surface** (registered via `sdk.actions.register`, dispatched
by `overdrawctl` and any future hotkey plugin):
- `workspace.create({name?, outputId?}) -> WorkspaceSnapshot`
- `workspace.destroy({index, outputId?}) -> null`
- `workspace.show({index, outputId?}) -> null`
- `workspace.move-window({surfaceId, index, outputId?}) -> null`
- `workspace.set-name({index, name | null | undefined, outputId?}) -> null`
- `workspace.list({outputId?}) -> WorkspaceSnapshot[]`
- `workspace.current({outputId?}) -> WorkspaceSnapshot | null`

**Event family** (emitted via `sdk.events.emit`):
- `workspace.created` `{handle, index, outputId, name?}`
- `workspace.destroyed` `{handle, formerIndex, outputId}`
- `workspace.shown` `{handle, index, outputId}`
- `workspace.hidden` `{handle, index, outputId}`
- `workspace.renumbered` `{outputId, changes: [{handle, oldIndex, newIndex}]}`
- `workspace.renamed` `{handle, index, outputId, name?}`
- `workspace.window-moved` `{surfaceId, fromHandle, toHandle, fromIndex, toIndex, fromOutputId, toOutputId}`

**Substrate added for Phase 6:**
- `sdk.windows.requestFocusDecision(reason, trigger?)`: lets a plugin
  trigger the focus driver to re-decide via the active focus plugin's
  policy. Used by `workspace.show` to re-resolve focus under the new
  stack. Goes through `windows.request-focus-decision` (broker route)
  -> `state.seat.dispatchFocusEvent(reason, trigger)` (new SeatState
  method) -> `focusDriver.dispatch(...)` (existing). Fire-and-forget;
  result applies asynchronously per the focus driver's normal
  sequence-tagged path.
- Focus plugin policy fix: `workspace-changed` under `follow-pointer`
  now returns `{keyboardFocus: pointer.surfaceUnderPointer}` (was
  `{}`). Switching workspaces re-resolves focus to whatever's now
  under the pointer; under `click-to-focus` it remains a no-op.

**Per-window state bag.** When a window joins a workspace, the plugin
writes `state['workspace.id'] = WorkspaceHandle` via
`sdk.windows.setState`. Move clears the source and writes to the
target; unmap deletes the entry. Other plugins (status bar,
overdraw-ctl, window rules) read this key to know which workspace a
window is on.

**Caveats:**
- Single-output today. `outputId` defaults to `OUTPUT_DEFAULT=0`;
  passing anything else routes through the registry but only output 0
  is meaningful until multi-output enumeration lands (output
  resize/reconfiguration is built; multi-output is not).
- Animated transitions (Phase 8) land via the optional
  `transition: {kind, duration, easing?}` arg on `workspace.show`
  (action + namespace API). When omitted, the swap is instant
  (the original Phase 6 behavior). See "Built-in transitions
  (Phase 8)" below.
- One-frame flash on map into a hidden workspace: a window enters the
  WM's layout at `xdg_surface.get_toplevel` (before the plugin sees
  `window.map`), so its tile can be configured + render in the brief
  interval before the workspace plugin observes the map and pushes a
  filtered `setOutputStack`. Accepted limitation in v1.
- No workspace persistence across compositor restarts.

**Files:**
- `packages/workspace-types/src/index.ts` (canonical type contract).
- `packages/plugin-workspace-default/src/registry.ts` (pure state
  machine with side-effect-tuple return for SDK translation).
- `packages/plugin-workspace-default/src/index.ts` (plugin wrapper:
  subscribes to onMap/onUnmap; registers actions + namespace + emits).
- `packages/core/src/plugins/bundled.ts` (`workspace-default` entry).
- `packages/core/src/plugins/windows-sdk.ts`,
  `packages/core/src/plugins/windows-broker.ts`,
  `packages/core/src/protocols/ctx.ts`,
  `packages/core/src/protocols/wl_seat.ts`
  (`requestFocusDecision` substrate).
- `packages/plugin-focus-default/src/policy.ts`
  (`workspace-changed` policy update).

**Tests:**
- Pure-unit: `test/plugin-workspace-default/registry.test.js` (34
  tests on the state machine in isolation -- destroy renumber +
  relocation, always-at-least-one invariant, map/unmap idempotence,
  show no-op same-workspace, etc.).
- Pure-unit: `test/plugin-workspace-default/integration.test.js` (15
  tests through a real `PluginRuntime` against a mock CompositorSink
  + seat stub; verifies setOutputStack effects, event payloads,
  focus-driver dispatch, malformed-params rejection).
- Pure-unit: `test/windows-broker-request-focus-decision.test.js` (8
  tests on the new broker route + payload validation).
- Pure-unit: focus policy tests
  (`test/plugin-focus-default/policy.test.js`) updated; +3 new tests
  for the `workspace-changed` branches.
- GPU integration: `test/plugin-workspace-default/workspaces.gpu.mjs`
  (2 tests: one-client membership wiring; two-client pixel readback
  proving `move-window` + `show` flip what composites where).

**Test framework gaps closed alongside Phase 6:**
- `harness.mjs` defaults: brings up the typed core bus +
  `coreBus -> pluginBus` republish + windows broker by default, so
  plugins under `setupCompositor` see the same SDK wiring `main.ts`
  provides. Previously a bundled plugin using `sdk.windows.*` would
  silently fail in tests.
- `PluginRuntime.flush()`: drains in-flight plugin endpoint requests
  across microtask + macrotask hops until quiescent; tests call it
  after triggering a state change before asserting. Exposed via
  `c.runtime.flush()`.
- `harness.mjs settled(producer, pred, opts)`: polls an arbitrary
  async producer until pred(value) is truthy; replaces ad-hoc polling
  loops in tests.
- Loud-not-silent runtime warnings: `if (!bus) return;` in
  `inthread-plugin.ts` and `runtime.ts` (events.subscribe/emit/
  intercept-register) now route through `warnRuntimeMisconfig(...)`
  -> `console.error`, bypassing test-silenced log hooks. Combined
  with making the `window.*` observer subscription lazy (only on
  first onMap/onUnmap/onChange handler), tests that don't observe
  windows no longer trigger spurious warnings -- but a plugin that
  does observe a no-bus runtime gets a clear stderr message.
- `Endpoint.pendingCount()`: introspection hook flush() uses.

540/540 unit tests pass (was 479 pre-6; +61 from the additions
above). 77/77 GPU tests pass (was 75 pre-6; +2 from
workspaces.gpu.mjs).

### Keyboard binding chain + bundled hotkey plugin (Phase 7a)

Keyboard hotkeys driven by user config, with chord (multi-step
binding) and mode (named binding set) support. Modes form a stack;
the top mode's binding trie is consulted on each key-down, before the
seat forwards to the focused client. Modes are isolated: a key not
bound in the top mode does NOT fall through to a lower mode -- it
forwards to the client (the user's typing reaches their app).

**Binding chain** (`packages/core/src/input/binding-chain.ts`): a per-
mode trie of registered chord bindings + a stack of active modes.
Owned by the seat (constructed in `installProtocols`). Each key-down,
the seat builds a `KeyStep = {mods, keysym}` from the xkb-resolved
state, then dispatches against the top mode's trie:
- **Match** (leaf): fire handler async, reset path, consume.
- **Prefix** (intermediate node): advance path, consume.
- **Miss**: if the chord pointer is at root AND `exitOnEscape` is true
  AND the key is plain Escape on a non-default mode, pop the mode;
  otherwise reset path and forward to the client.

Mods are compared after stripping `Lock` (CapsLock) and `Mod2`
(NumLock) -- otherwise a NumLock-on user would see no bindings ever
match.

**Key-spec parser** (`packages/core/src/input/keyspec.ts`): turns
human strings into KeySteps. Supports `Mod`/`Super`/`Logo` (all
Mod4), `Alt` (Mod1), `Ctrl`, `Shift`, plus the explicit `Mod2..Mod5`
aliases. Chord syntax accepts a single string (`"Mod+a, Mod+b"` or
`"Mod+a Mod+b"`), a string array (`["Mod+a", "Mod+b"]`), or pre-
parsed `KeyStep[]`. Keysym lookup goes through a curated table of
~100 common keys (letters, digits, Function keys, navigation,
common punctuation) at `keysyms.ts`; the table values mirror
`<xkbcommon/xkbcommon-keysyms.h>`.

**Native plumbing**: `xkbcommon` resolves keycode -> keysym in the
seat's `Keymap::keysym()` method (new in Phase 7a). The native
`keyUpdate(evdevKey, pressed)` returns the post-update modifier
masks AND the resolved keysym in one round-trip. The seat passes
that pair into the chain.

**SDK** (`packages/core/src/plugins/input-sdk.ts`):
- `sdk.input.bind({ keys, mode?, handler, priority? })`: returns a
  Promise of an unregister handle. Resolves after the chain has the
  binding (request/reply round-trip, not fire-and-forget, so the
  plugin's init awaits before subsequent key events can race).
  Rejects on conflict (duplicate, prefix-mask) or unknown mode.
- `sdk.input.defineMode(name, { exitOnEscape? })`: Promise of an
  undefine handle. Default `exitOnEscape: true` for sub-modes; the
  `'default'` mode is built-in (cannot be defined or undefined) and
  has `exitOnEscape: false`.
- `sdk.input.pushMode(name)`: idempotent if name is already on top.
- `sdk.input.popMode()`: no-op at root.

**Bus events** (`input.*`, emitted to the plugin bus when
installProtocols is given one): `input.mode-pushed`, `input.mode-
popped`, `input.chord-entered`, `input.chord-cancelled`, `input.
chord-matched`. Future status bars (Phase 11) consume these to show
"Mode: resize" or "Prefix: Mod+a, waiting…" UI.

**Bundled core-actions plugin** (`@overdraw/plugin-core-actions`):
loads first (before any plugin that might bind one of its actions).
Today registers a single action:
- `compositor.quit`: emits `compositor.shutdown` on the plugin bus.
  `main.ts` subscribes and runs its existing `shutdown(signal)`
  path (graceful: IPC server stop, plugin runtime stop, Wayland
  server stop, GPU process stop, then `process.exit(0)`).

**Bundled hotkey plugin** (`@overdraw/plugin-hotkey-default`): in-
thread, namespace `'hotkey'`, priority 0. Loads last (after every
plugin that might register actions it binds). Reads `config.hotkeys`
(verbatim from the user's `OverdrawConfig.hotkeys`); validates the
schema; defines each non-default mode; binds each entry via
`sdk.input.bind`. Each binding's handler dispatches per the spec:
- `{ action: "name", params?: <unknown> }` -> `sdk.actions.invoke`.
- `{ pushMode: "name" }` -> `sdk.input.pushMode`.
- `{ popMode: true }` -> `sdk.input.popMode`.

Validation: exactly one outcome per binding; `keys` is a string or
array; `modes.default` is required; unknown key spec rejects at
init (fatal startup error per the in-thread bundled-plugin
transport).

**Config schema** (`@overdraw/hotkey-types`):
```ts
interface KeyboardConfig {
  modes: {
    default: BindingSpec[] | ModeSpec;
    [name: string]: BindingSpec[] | ModeSpec;
  };
}
interface BindingSpec {
  keys: string | string[];           // single step or chord
  action?: string;
  params?: unknown;
  pushMode?: string;
  popMode?: true;                    // literal true
}
interface ModeSpec {
  bindings: BindingSpec[];
  exitOnEscape?: boolean;            // default: true (false for "default")
}
```

User config example (`@overdraw/hotkey-types` is a type-only
package; the data structure flows verbatim to the plugin's init):
```ts
import type { OverdrawConfig } from "overdraw/config";
import type { KeyboardConfig } from "@overdraw/hotkey-types";

export default {
  hotkeys: {
    modes: {
      default: [
        { keys: "Mod+q", action: "compositor.quit" },
        { keys: "Mod+1", action: "workspace.show", params: { index: 1 } },
        { keys: "Mod+r", pushMode: "resize" },
        { keys: ["Mod+a", "Mod+b"], action: "user.demo" },
      ],
      resize: [
        { keys: "Return", popMode: true },
      ],
    } satisfies KeyboardConfig["modes"],
  },
} satisfies OverdrawConfig;
```

**Package surface**: the `overdraw` package now publishes an
`exports` map with a `./config` subpath (`overdraw/config`). The
subpath re-exports the config types (`OverdrawConfig`,
`OutputConfig`, `PluginConfig`, `RestartPolicy`, `ConfigExport`).
Type-only today; Phase 7b adds runtime exports (deferred-ref
helpers).

**Files:**
- `packages/core/src/input/{keysyms.ts, keyspec.ts, binding-chain.ts}`.
- `packages/core/src/plugins/{input-sdk.ts, input-broker.ts}`.
- `packages/core/src/protocols/wl_seat.ts` (key-down consults the
  chain before forwarding).
- `packages/core/src/protocols/ctx.ts` (CompositorState.bindingChain).
- `packages/core/src/protocols/index.ts` (constructs chain +
  subscribes its events to the plugin bus).
- `packages/core/native/wayland/keymap.{h,cpp}` (keysym lookup).
- `packages/core/native/napi/addon.cpp` (keyUpdate returns keysym).
- `packages/core/src/types.ts` (keyUpdate type signature).
- `packages/core/src/main.ts` (compositor.shutdown subscriber +
  input broker wiring).
- `packages/hotkey-types/` (new).
- `packages/plugin-core-actions/` (new).
- `packages/plugin-hotkey-default/` (new).
- `packages/core/package.json` (exports map: `.` + `./config`).
- `packages/core/src/config/{types.ts, index.ts, load.ts}`
  (`hotkeys` field; `overdraw/config` subpath).

**Tests:**
- Pure-unit: `test/input-keyspec.test.js` (30 tests: mod aliases,
  case-insensitivity, chord parsing, malformed spec rejection,
  keysym table coverage).
- Pure-unit: `test/binding-chain.test.js` (27 tests: single-step +
  chord match, NumLock-mod-stripping, conflict rejection (duplicate
  / prefix-mask), unbind + trie pruning, mode push/pop + isolation,
  Escape exit, listener invocation, handler error containment).
- Pure-unit: `test/plugin-hotkey-default/integration.test.js` (12
  tests through a real PluginRuntime + BindingChain + brokers:
  empty config, single-step fires, chord enter+match, mode push/
  pop, Escape default behavior, exitOnEscape: false, schema
  validation (missing default / multiple outcomes / no outcome /
  unknown key spec), NumLock tolerance).
- Pure-unit: `test/input-worker.test.js` (1 test: a Worker plugin
  uses `sdk.input.bind` + `defineMode` + `pushMode/popMode` end-
  to-end. The input SDK is transport-agnostic -- both in-thread
  bundled plugins and Worker plugins drive the same chain through
  the same broker route).
- GPU: `test/plugin-hotkey-default/hotkey.gpu.mjs` (1 test: real
  wayland client + injected Mod+q -> compositor.shutdown observed
  on the bus).

610/610 unit tests pass (was 540 pre-7a; +70 from the additions
above: +30 keyspec, +27 binding-chain, +12 hotkey integration, +1
Worker-input). 78/78 GPU tests pass (was 77 pre-7a; +1
hotkey.gpu.mjs).

**Deferred to Phase 7b:**
- Deferred-ref helpers (`ref.surfaceUnderPointer`, etc.) so action
  params can resolve runtime state at chord-match time.
- `OverdrawConfig.actions` (user-defined JS handlers registered as
  actions, so a hotkey can bind to arbitrary user code without
  writing a full plugin).
- Workspace action revisions: `workspace.move-window` defaulting
  `surfaceId` to focused window; `workspace.show` + `move-window`
  accepting `{ name }` as an alternative to `{ index }`.

**Caveats:**
- Bindings fire on key-DOWN only. No release-event bindings, no
  mouse-button bindings (keyboard-only in 7a).
- Modifier-only chord steps (e.g. "tap Super" as a binding) are
  not supported; the parser requires a non-modifier keysym.
- Chord cancellation forwards the non-matching key to the client
  but does NOT replay the consumed prefix (a prefix-then-cancel is
  user error and the prefix keys are gone).
- The hotkey plugin loads LAST among bundled plugins, so any
  action it might bind is already registered. An action that
  doesn't exist at bind time is allowed (bind succeeds; the
  invoke at match time surfaces "no such action" via `sdk.log`).

### Deferred refs + user-config actions + workspace by-name lookup (Phase 7b)

Closes the "hotkey config can't carry runtime state or inline JS" gaps
left by 7a. Three pieces:

**1. Deferred-reference resolution in the action registry.** When the
config writes `{ $ref: "focusedWindow" }` (or the typed sugar
`ref.focusedWindow`) inside an action's params, the action registry
walks the params at invoke time and substitutes each `{$ref}` sentinel
with the current value from a resolver map. Resolvers are populated by
the launcher from core state (the seat, the WM, the workspace plugin's
cached current workspace) and read on each invoke; no caching, no
async. Recognized refs:
- `ref.surfaceUnderPointer` -> number | null (state.seat.focus.surfaceId).
- `ref.focusedWindow` -> number | null (state.seat.kbFocus.surfaceId).
- `ref.pointerX` / `ref.pointerY` -> number (state.seat.pointerPosition).
- `ref.activeOutput` -> number (OUTPUT_DEFAULT=0 today; multi-output
  enumeration is not yet built).
- `ref.currentWorkspace` -> number | null (cached from workspace.shown
  events; the workspace plugin's namespace methods are async, so a
  bus subscription keeps the value live without blocking the resolver).

Refs are recognized by the `{ $ref: string }` shape, NOT by reference
equality with the `ref.X` exports. This is deliberate: refs survive
structured-clone (IPC, postMessage); user configs may write
`{ $ref: "name" }` literals; the resolver works the same in every
transport. Unknown ref names resolve to undefined (action sees the
slot as missing).

**2. User-config actions.** `OverdrawConfig.actions: { [name]:
(sdk, params?) => unknown }` lets the user declare action handlers
inline in their config. Registered by a new bundled
`@overdraw/plugin-config-actions` (in-thread; loads after every other
action-registering plugin so user handlers can call into them).
Handlers receive `sdk` (the bundled plugin's SDK reference, so the
handler can `sdk.actions.invoke`, push modes, log) and `params`
(already with deferred refs resolved). Convention: prefix user action
names with `user.`.

Combined with 7a's hotkey + 7b's deferred refs, this means a user can
bind a chord to arbitrary JS that reads current core state, without
writing a full plugin:

```ts
import type { OverdrawConfig } from "overdraw/config";
import { ref } from "overdraw/config";

export default {
  actions: {
    "user.print-focus": async (sdk, params) => {
      console.log("focused surface:", params.surface);
    },
  },
  hotkeys: {
    modes: {
      default: [
        { keys: "Mod+u", action: "user.print-focus",
          params: { surface: ref.focusedWindow } },
      ],
    },
  },
} satisfies OverdrawConfig;
```

**3. Workspace by-name lookup.** `workspace.show` and
`workspace.move-window` accept `{ name }` as an alternative to
`{ index }`. The registry's `findIndexByName` resolves at action
parse time; an unknown name throws ("no workspace named '...' on
output ..."). Combined with deferred refs, the user can write
`{ surfaceId: ref.focusedWindow, name: "mail" }` for a "move the
focused window to the mail workspace" binding. (Note: this assumes
a workspace with a stable name exists; sway-style workspace IDs
that may renumber after destroy are still the user's concern.)

**Files:**
- `packages/core/src/config/refs.ts` (new): `ref` namespace,
  `DeferredRef<T>` type, `isDeferredRef` predicate.
- `packages/core/src/config/index.ts`: re-export `ref` + types.
- `packages/core/src/plugins/deferred-refs.ts` (new): `resolveRefs`
  walker, `buildResolver` factory.
- `packages/core/src/plugins/runtime.ts`: `RuntimeOptions.resolveDeferredRefs`
  hook; `onActionInvoke` calls it before forwarding.
- `packages/core/src/config/{load.ts,types.ts}`: `actions` field +
  `ActionHandler` type.
- `packages/core/src/main.ts`: resolver map populated from core state;
  workspace.shown subscription caches `currentWorkspaceIndex`.
- `packages/core/src/plugins/bundled.ts`: new `config-actions` entry.
- `packages/core/src/protocols/wl_seat.ts`,
  `packages/core/src/protocols/ctx.ts`:
  `SeatState.pointerPosition()` exposes (lastX, lastY).
- `packages/plugin-config-actions/` (new): bundled plugin.
- `packages/plugin-workspace-default/src/index.ts`: action handlers
  for show + move-window accept `{name}` as alternative to `{index}`.
- `packages/plugin-workspace-default/src/registry.ts`:
  `findIndexByName(state, name, outputId)`.
- `test/harness.mjs`: matching resolver wiring so tests under
  setupCompositor get the same behavior as main.ts.

**Tests:**
- Pure-unit: `test/deferred-refs.test.js` (15 tests: ref exports,
  isDeferredRef predicate, recursive substitution, unknown ref ->
  undefined, null pass-through, immutability, error propagation,
  buildResolver live-read semantics).
- Pure-unit: `test/plugin-workspace-default/registry.test.js` (+3
  tests on findIndexByName).
- Pure-unit: `test/plugin-workspace-default/integration.test.js`
  (+5 tests: workspace.show / move-window by name; unknown name
  rejects; both index+name rejects; neither rejects).
- Pure-unit: `test/plugin-hotkey-default/integration.test.js` (+4
  tests: user-defined action fires; deferred refs resolved in
  params; resolver returning null passes through; user handler
  invokes other actions via sdk).
- GPU: `test/plugin-hotkey-default/hotkey-7b.gpu.mjs` (1 test: real
  client + Mod+u with ref.focusedWindow in params + user.observe-focus
  handler; verifies the ref resolved to the actual focused
  surfaceId).

637/637 unit tests pass (was 610 pre-7b; +27). All workspace + hotkey
GPU tests on the target set still pass.

**Caveats:**
- `ref.currentWorkspace` is cached from `workspace.shown` events. If
  the workspace plugin is not loaded (a different hotkey plugin
  replaces it), the cache stays null. Resolving the ref gives null
  in that case; action handlers should treat it as "no current
  workspace info available."
- `ref.activeOutput` is constant 0 today (single-output). When
  multi-output enumeration lands, the resolver will read from the
  seat's notion of the active output.
- The user-config `actions` map is a verbatim pass-through to the
  in-thread `plugin-config-actions`. A Worker plugin can't be the
  receiver of `config.actions` because function references can't
  cross postMessage; this is documented and intentional. Worker
  plugins consume user actions via `sdk.actions.invoke(name)`,
  same as any other action.
- `findIndexByName`'s first-match-wins behavior on duplicate names
  is deterministic but not enforced: the workspace API doesn't
  prevent two workspaces from sharing a name. Documented in the
  registry.

### Built-in transitions (Phase 8)

`sdk.transitions.run(opts)` blends two `SceneHandle`s on screen via
a kind-specific shader (core-plugin-api.md §8). Closed set of six
built-in kinds: `crossfade`, `slide-left` / `slide-right` /
`slide-up` / `slide-down`, `scale`. Each kind is one branch of a
single WGSL fragment shader that samples both inputs and writes the
final premultiplied pixel directly to the on-screen target
(replacing the normal per-surface composite while a transition is
active). All four scene-input combinations are supported:

| Scene mode  | In-thread plugin              | Worker plugin                                     |
|-------------|-------------------------------|---------------------------------------------------|
| `snapshot`  | core-owned texture, direct    | STM-backed dmabuf; once-per-pin producer Begin/End on the core wire (`acquireForSampling`) covers the consumer's reads |
| `live`      | stable core-device texture    | ring-backed; per-frame producer Begin/End on the latest PRESENTED slot's `surfaceBufId`, written by the compositor wrapping the transition pass encode |

**Architecture.** Three pieces:

- **Transition evaluator** (`packages/core/src/transitions/evaluator.ts`):
  pure time-machine. One active transition at a time; `install({
  durationMs, easing?, commit? })` returns a `Promise<void>`;
  `tick(timeMs)` advances; at `t >= 1` the commit callback fires
  synchronously THEN the Promise resolves. Decoupled from the
  compositor (no GPU state) and from the broker (no SDK plumbing) --
  just the lifecycle.

- **Transitions broker** (`packages/core/src/plugins/transitions-broker.ts`):
  routes `transitions.run` requests from the runtime. Resolves
  `fromSceneId` / `toSceneId` via the `SceneRegistry` to core-side
  GPUTextures + (for ring-backed scenes) per-frame bracket
  callbacks. Pins both scenes for the transition's lifetime so a
  buggy plugin's `SceneHandle.release()` during the transition
  defers the underlying resource teardown instead of yanking. On
  completion, applies the declarative commit (today: a list of
  `setOutputStack` ops) synchronously against the compositor BEFORE
  the next renderFrame -- so the post-transition state is visible
  on the very next frame with no glitch.

- **Compositor pipeline** (`packages/core/src/gpu/compositor.ts`):
  a separate `transitionPipeline` (no blend; the shader writes the
  final premultiplied pixel). `setActiveTransition({fromTex, toTex,
  kind, getProgress, resolveTextures?})` installs;
  `clearActiveTransition()` tears down; renderFrame branches on
  `activeTransition` and routes to `encodeTransitionPass` instead of
  the normal per-surface composite. Live composers + live producers
  continue to run while a transition is active so live-scene inputs
  keep tracking; the transition pass samples whatever the ring
  currently has presented.

**SceneRegistry** (`packages/core/src/plugins/scene-registry.ts`):
the new substrate that lets any SceneHandle (in-thread or Worker)
be referenced by integer id across the SDK boundary. Mints
monotonic, never-reused ids; producer registers with a teardown
closure + optional `acquireForSampling` (per-pin bracket
management); consumer pins/unpins. Pins defer the teardown until
the last release; an entry in the teardown-pending state refuses
new pins. Designed for reuse -- the future intercept / overview /
recording paths will plug into the same shape.

**Declarative commit.** `TransitionRunOpts.commit` is data, not a
function -- structured-clone-safe so the same shape works
unchanged for in-thread and Worker plugins (an earlier landing
shipped a function-commit + side-table token for in-thread + loud
rejection for Worker; collapsed to one shape in a refactor).
Today's vocabulary is one field: `setOutputStack`. New atomic-
commit operations are added by extending `TransitionCommit` +
broker's `applyCommit` interpreter; the SDK boundary doesn't
change.

**Conflict policy.** Reject overlapping transitions on the same
output. The evaluator's `install` throws synchronously; the broker
rolls back the compositor's `setActiveTransition` + scene pins
before propagating to the caller.

**Pre-conditions / limitations.**
- Single-output (`outputId === 0` only) -- the broker validates
  loudly. Multi-output transitions wait for multi-output
  enumeration (not yet built).
- No `AbortSignal` / cancellation in v1. A plugin can choose
  not to await `run()` -- but the transition still runs to
  completion on the compositor's clock.
- Closed set of kinds. Anything beyond crossfade / 4 slides / scale
  uses `sdk.output.takeover` (per-plugin per-frame render) when
  that primitive lands.
- Easing: same `EasingSpec` types as the animation evaluator
  (linear / preset / cubic-bezier); `resolveEasing` is shared.
  Default linear.

**Workspace integration (Phase 8b).** `workspace.show` (action +
namespace API) accepts an optional `transition: {kind, duration,
easing?}` arg. The plugin: captures FROM scene snapshot of the
currently-shown stack; mutates registry to produce sideEffects +
the TO stack; applies non-stack-non-focus sideEffects normally;
captures TO scene snapshot; runs the transition with `commit: {
setOutputStack: [{outputId, ids: TO}] }`; releases both scenes;
fires the deferred `requestFocusDecision` so focus re-decides
under the post-transition stack. When omitted, the swap is
instant (Phase 6 behavior preserved). The transition path
throws loudly if `sdk.compose` or `sdk.transitions` is absent
(older harnesses, builds without GPU).

**Files (new):**
- `packages/transition-types/` (npm name `@overdraw/transition-types`):
  TransitionKind (the 6-kind union), TransitionSpec, plus the
  `TRANSITION_KINDS` runtime-checkable array. Type-only.
- `packages/core/src/transitions/evaluator.ts`.
- `packages/core/src/plugins/scene-registry.ts`.
- `packages/core/src/plugins/transitions-broker.ts`.
- `packages/core/src/plugins/transitions-sdk.ts`.
- `packages/plugin-workspace-default/src/index.ts`
  (`showWithTransition`).
- `packages/workspace-types/src/index.ts`
  (`WorkspaceTransitionSpec`, optional 3rd arg to `WorkspaceAPI.show`).

**Files (modified):**
- `packages/core/src/gpu/compositor.ts`: WGSL `TRANSITION_WGSL`,
  `transitionPipeline`, `setActiveTransition` /
  `clearActiveTransition`, `encodeTransitionPass`, renderFrame
  routing + per-frame `pendingEndRead` for live brackets.
- `packages/core/src/plugins/gpu-broker.ts`: every Worker compose
  (snapshot + live) registers in the SceneRegistry. Snapshot's
  `acquireForSampling` re-opens producer Begin/End on the 0->1 pin
  edge. Live's `resolveTexture` returns
  `{texture, beginRead, endRead}` per-slot.
- `packages/core/src/plugins/compose-sdk.ts`: SceneHandle gains
  `id`; both in-thread variants and Worker variants register on
  construction; `release()` calls `sceneRegistry.unregister(id)`.
- `packages/core/src/plugins/loader.ts`: single `createTransitions`
  for both transports; `inThreadGpu.sceneRegistry` plumbed through.
- `packages/core/src/plugins/sdk.ts`: `sdk.transitions?: PluginTransitions`.
- `packages/core/src/protocols/ctx.ts`: `CompositorSink` gains
  optional `setActiveTransition` / `clearActiveTransition`.
- `packages/core/src/main.ts`: scene registry, transition evaluator,
  transitions broker; evaluator ticks via `state.beforeRender`
  alongside the animation evaluator; runtime onRequest routes
  `transitions.*`.
- `test/harness.mjs`: `opts.transitions = true` brings up the
  registry + evaluator + broker + the `inThreadGpu` bundle so
  bundled plugins get `sdk.compose` + `sdk.transitions`.

**Tests:**
- Pure-unit (`test/transitions-evaluator.test.js`, 18 tests):
  install / tick / completion / commit-before-resolve / commit
  sees idle / commit-installing-follow-up / commit throw recovery
  / easing / clock-backwards clamp / re-install after completion.
- GPU (`test/transitions-compositor.gpu.mjs`, 11 tests): each of
  the six kinds verified at midpoint with the expected pixel
  layout; `resolveTextures` identity-change path; null-resolver
  opaque-black fallback; double-install rejection;
  `hasActiveTransition` lifecycle; on-screen pass replacement
  invariant.
- GPU (`test/inthread-transitions.gpu.mjs`, 1 test): bundled
  in-thread plugin runs sdk.transitions.run end-to-end; pixel
  readback at p=0 / 0.5 / past-end through the SDK + broker
  chain.
- GPU (`test/worker-transitions.gpu.mjs`, 1 test): Worker plugin
  with snapshot scenes; verifies install state, completion,
  scene release, NO Dawn `SharedTextureMemory` validation errors
  (per-pin producer Begin/End is correct).
- GPU (`test/worker-transitions-live.gpu.mjs`, 1 test): Worker
  plugin with LIVE scenes; same Dawn-clean-stderr check across
  the per-frame slot rotation.
- GPU (`test/plugin-workspace-default/workspace-transition.gpu.mjs`,
  2 tests): full workspace.show + transition path with two real
  Wayland clients; verifies in-flight transition pixels are
  neither FROM nor TO pure state (the master-tile center passes
  through intermediate blue values as crossfade progresses) AND
  the post-transition state is visible on the very next frame
  (master=blue, stack=black, workspace.current=2). Plus a
  regression test that the no-transition path still works.

97/97 GPU tests pass (the standard `npm run test:gpu` glob was
fixed in this phase from `test/*.gpu.mjs` to `test/**/*.gpu.mjs`
so prior `test/plugin-*/*.gpu.mjs` files now also run). 674/674
unit tests pass.

### Phantom-based closing animations (Phase 9a)

A mapped toplevel that unmaps (client destroyed it or disconnected)
can be replaced briefly by a phantom: a core-owned snapshot of its
last visible state, displayed at the closing window's prior screen
rect. A plugin registered in the `'window-closing'` namespace
animates the phantom (fade / shrink / slide / transition-to-empty)
and then destroys it. The client gets cleaned up immediately the
moment it unmaps -- the snapshot decouples the visual from the
client lifetime entirely, so a buggy or slow plugin animation
can never delay the client teardown.

**Architecture.** Three pieces:

- **JsCompositor.createClosingPhantom / destroyClosingPhantom**:
  the compositor-side primitive. `createClosingPhantom` collects
  the closing window's surface set (toplevel + decoration +
  subsurfaces), composites them into a fresh core-owned texture
  sized to the outer rect (one-shot `composeSnapshot` with a
  per-surface placement override translating absolute screen
  coords into phantom-local coords), then mints a phantom surface
  entry via the standard `setSurfaceLayout` / `setSurfaceTexture`
  setters. The compositor tracks active phantoms in a private
  `phantoms[]` list; `drawOrder` injects them ABOVE the content
  layer (so they sit on top of the survivors reflowing into the
  closing window's vacated tile). `destroyClosingPhantom` is
  symmetric: removes from `phantoms`, removes the surface entry,
  destroys the snapshot texture.

- **packages/core/src/protocols/closing-driver.ts**: the
  integration point. Reads `hasPluginHandler` (a callback the
  launcher wires to `runtime.registry().active('window-closing')`).
  When no plugin claims the namespace, the driver is a no-op and
  unmap is instant -- the pre-9a behavior is preserved bit-for-bit.
  When a plugin IS registered, the driver:
    1. Mints a fresh `phantomSurfaceId` via `state.serial()`.
    2. Walks the surface set (decoration / toplevel /
       subsurface subtree).
    3. Calls `compositor.createClosingPhantom(...)`.
    4. Emits `WINDOW_EVENT.closing` on the typed bus with the
       phantom's id + the closing window's outerRect + the
       toplevel's appId / title.
    5. Arms a 10s backstop timer (configurable for tests).

- **unmapAndTeardownSurface** (in `wl_surface.ts`) calls
  `state.closingDriver?.beforeUnmap` BEFORE the WM/compositor
  teardown so the source surfaces are still sampleable. The
  emit order is `window.closing` → `window.unmap` → WM unmap
  → compositor removeSurface; subscribers see the closing event
  first, then the unmap (which the rest of the system already
  reacts to).

**Plugin API.** Plugin claims the `'window-closing'` namespace
(`sdk.registerPlugin('window-closing', () => ({}))`), subscribes
to `window.closing` on the bus, and on each event runs its
animation against the phantom's surfaceId via the existing per-
surface SDK -- `sdk.windows.setOpacity` / `setTransform` /
`sdk.animations.run({target: {kind: 'window-opacity', windowId:
phantomSurfaceId}, ...})` / `sdk.transitions.run({from: ...,
to: ..., ...})`. When the animation completes the plugin calls
`sdk.windows.destroyPhantom(phantomSurfaceId)`, which cancels
the backstop + tears down the phantom.

If the plugin fails to call destroyPhantom (forgot, threw, etc.),
the 10s backstop fires and the compositor destroys the phantom
on its own. Tests can override the timeout via
`opts.closingBackstopMs`.

**Caveats / known limitations.**
- One composited phantom per window (subsurfaces baked in). Per-
  element animation (titlebar peels off independently while content
  shrinks) is deferred; the snapshot + SceneRegistry plumbing from
  Phase 8 could be extended for that if a real consumer needs it.
- The closing driver returns no-op when the closing surface isn't
  fully mapped yet (no first content commit). A client that
  disconnects between `get_toplevel` and first content gets the
  pre-9a instant-unmap behavior. Tests must wait for first-content
  before killing the client to exercise the closing path.
- Phantoms are placed above the content layer regardless of their
  original z. For the master-stack tiler this matches the expected
  visual (closing window is "leaving"); future designs may want
  z-aware splicing if a closing window had others above it (popups
  currently close with their toplevel, so this isn't a real case
  today).
- One plugin wins via the namespace priority chain. Other plugins
  observing `window.closing` are watch-only -- they see the event
  but the phantom is the registered plugin's to animate. No
  per-plugin phantom (each closing produces ONE phantom that the
  registered plugin owns).
- Phase 9b (originally: smoothed pointer velocity in a
  `PointerEvent` payload pushed to plugins) was folded into Phase
  9c's declarative rule engine. Plugins consume velocity / shake /
  idle state via `sdk.cursor.defineRule({when: {speedRange / shake /
  idle}})` rather than subscribing to per-event motion. Phase 9c is
  landed -- see the "Cursor system" section below.

**Files (new):**
- `packages/core/src/protocols/closing-driver.ts`.
- `test/fixtures/plugins/closing-animation.mjs` (fixture plugin
  for the GPU tests; not a bundled plugin).

**Files (modified):**
- `packages/core/src/gpu/compositor.ts`: `createClosingPhantom` /
  `destroyClosingPhantom` / `activePhantomIds`, `phantoms[]` +
  `phantomTextures` state, drawOrder branch.
- `packages/core/src/protocols/wl_surface.ts`: hook
  `state.closingDriver?.beforeUnmap` into
  `unmapAndTeardownSurface`.
- `packages/core/src/protocols/ctx.ts`: optional
  `CompositorSink.createClosingPhantom` /
  `destroyClosingPhantom`; optional
  `CompositorState.closingDriver`.
- `packages/core/src/events/types.ts`: `WINDOW_EVENT.closing` +
  `WindowClosingEvent` + cloneability assertion.
- `packages/core/src/events/window-bus.ts`: map entry for
  `window.closing`.
- `packages/core/src/plugins/windows-broker.ts`:
  `windows.destroy-phantom` route + payload validator + closing-
  driver dependency for backstop cancel.
- `packages/core/src/plugins/windows-sdk.ts`:
  `PluginWindows.destroyPhantom(id)`.
- `packages/core/src/main.ts`: closing driver construction +
  hasPluginHandler wired to the runtime's namespace registry,
  republish of `window.closing` from typed bus to plugin bus.
- `test/harness.mjs`: `opts.closingAnimations` /
  `opts.closingBackstopMs` / `opts.animations` flags +
  bringup of the closing driver + animations broker.

**Tests:**
- GPU (`test/phantoms.gpu.mjs`, 2 tests): compositor-direct test
  of `createClosingPhantom` / `destroyClosingPhantom` + draw
  order (phantom appears at original rect with the captured
  pixels; phantom draws above the content layer).
- GPU (`test/closing-animation.gpu.mjs`, 3 tests):
    * baseline -- no plugin, instant unmap, no phantom, no event.
    * with-plugin -- fixture plugin runs a 400ms opacity fade on
      the phantom; pixel readback observes intermediate alpha
      values mid-animation; plugin calls destroyPhantom on
      completion.
    * backstop -- plugin runs the fade but never calls
      destroyPhantom; the configurable backstop (500ms in the
      test) fires and the compositor force-destroys the phantom.

102/102 GPU tests pass (was 97 pre-Phase-9a; +2 phantoms.gpu.mjs +
3 closing-animation.gpu.mjs). 674/674 unit tests pass (unchanged
-- Phase 9a's logic is exercised end-to-end through GPU tests
because the snapshot path requires the compositor; the closing
driver itself is small enough that the GPU coverage is sufficient).

### Cursor system (Phase 9c)

Software cursor compositing end-to-end: XCursor theme resolver,
`wl_pointer.set_cursor`, `wp_cursor_shape_v1`, `sdk.cursor` (set
shape / set image / hide / show / set default / clear override /
define rule), kinematic state machine (windowed velocity + KWin-
style shake detector + idle timer), declarative rule engine. Phase
9b (smoothed pointer velocity in a `PointerEvent` payload) is folded
into the rule engine -- rules with `when: { speedRange / idle /
shake }` consume the kinematic snapshot directly; no per-event
push to plugins.

Priority resolution (cursor-design.md):
1. Plugin explicit override (`sdk.cursor.setShape/setImage/hide`)
   or a matched plugin rule.
2. Client cursor (`wl_pointer.set_cursor` or
   `wp_cursor_shape_v1.set_shape`).
3. `sdk.cursor.setDefault` shape (when present).
4. Built-in default ('default' from the XCursor theme, with the
   built-in 16x16 arrow fallback for environments missing a theme).

- **Theme resolver**
  (`packages/core/native/cursor/xcursor.{h,cpp}` +
   `packages/core/src/cursor/theme-resolver.ts`): XDG-conventional
  theme discovery (`XCURSOR_THEME` / `XCURSOR_SIZE` / `XCURSOR_PATH`
  +
  `$XDG_DATA_HOME/icons:$XDG_DATA_DIRS/icons:~/.icons:/usr/share/icons:/usr/share/pixmaps`).
  Walks `[Icon Theme] Inherits=` chains with cycle guard + depth cap
  16. Parses Xcursor binary files (`Xcur` magic + TOC of image
  chunks). Picks the smallest nominal size ≥ requested, else the
  largest available. v1 limitation: always picks subimage 0 (no
  animation -- the `wait` spinner displays as frame 0 forever).
  Pixels are returned as BGRA8 (matches the compositor's format
  byte-for-byte on LE; XCursor's "ARGB pixels" are uint32-packed
  ARGB, identical to BGRA8 in memory). Premultiplied alpha
  (consistent with wlroots; matches the compositor's blend mode).
  Built-in fallback arrow (16x16 BGRA, white body + black border)
  for `'default'` only -- so tests don't depend on host themes.
  Native binding `addon.resolveCursorShape(name, sizePx, scale)`;
  JS `CursorThemeResolver` wraps it with an LRU cache (default
  64 entries).

- **Cursor compositing slot**
  (`packages/core/src/gpu/compositor.ts`): a singleton surface drawn
  above every other layer. `drawOrder()` appends the cursor target
  surfaceId last whenever visible + textured.
  - `setCursorPixels(bytes, w, h, hotX, hotY)`: uploads BGRA8 bytes
    to a core-device texture via `queue.writeTexture` and installs
    into the slot. Used by the theme resolver path + the bundled
    boot default + plugin shape rules.
  - `setCursorFromSurface(surfaceId, hotX, hotY)`: points the slot at
    an existing surface whose own buffer pipeline drives its texture.
    Used by `wl_pointer.set_cursor`: the client's cursor surface
    commits its buffer through the standard shm/dmabuf path; the
    slot just observes.
  - `setCursorTexture(tex, w, h, hotX, hotY)`: install an already-on-
    device GPUTexture directly (test fixtures + future plugin
    setImage paths).
  - `setCursorPosition(x, y)`: per pointer motion; the cursor draws
    at `(pointerX - hotspotX, pointerY - hotspotY)`.
  - `setCursorVisible(bool)` / `clearCursor()`.
  - Internal cursor surface id `0x7FFFFFF0` (reserved, outside any
    WM range; never in client-buffer lifecycle, never in any layer
    or stack list).

- **`wl_pointer.set_cursor`**
  (`packages/core/src/protocols/wl_seat.ts`): the previously-silent
  no-op now routes end-to-end. The seat tracks the most-recent
  `pointer.enter` serial per pointer resource (recorded in
  `sendEnter`; cleared in `sendLeave` + on resource release). On
  `set_cursor(serial, surface, hx, hy)`: serial < latest-enter is
  silently dropped (protocol convention). NULL `surface` records
  "hidden" for the client (pointer over this client's surfaces
  hides the cursor). Otherwise the surface is locked to role
  `"cursor"` (other role-attach paths checking `s.role` must reject
  it; the cross-role error post is TBD). Per-client cursor state
  (`SeatCursorOps.setClientCursor`) is stored and applied when the
  client gains pointer focus (`sendEnter` -> `applyClientCursor`).
  Cursor surface commits trigger the seat's `onCursorSurfaceCommit`
  hook from `wl_surface.commit`, which re-applies the slot so the
  new texture is observed without waiting for a focus change.

- **`wp_cursor_shape_v1`**
  (`packages/core/src/protocols/cursor_shape.ts`): two-interface
  protocol, manager + per-pointer device. `get_pointer(pointer)`
  returns a device bound to that pointer; `set_shape(serial,
  shape)` validates the serial against the bound pointer's
  enter-serial and looks up the shape name via the theme resolver.
  Shape enum maps to standard XCursor names (`pointer`, `text`,
  `wait`, `*-resize`, ...). Out-of-range shape values are silently
  dropped (the `invalid_shape` protocol error isn't wired). Unknown
  shapes that the active theme doesn't ship (and aren't `default`)
  resolve to null and leave the previous cursor in place. The
  protocol's `get_tablet_tool_v2` is accepted but the resulting
  device is inert (no tablet protocol advertised). One v1
  limitation: shapes installed via set_shape are NOT cached against
  the focus's client (the seat's `applyClientCursor` only handles
  surface-or-hidden); clients must re-call `set_shape` on every
  `pointer.enter`, which is what they already do for the
  `wl_pointer.set_cursor` mechanism.

  Generator + native wiring: the cursor-shape XML is in
  `tools/gen-protocol`'s default inputs; the interface registry
  tolerates unresolved cross-protocol object types (e.g. the
  manager's `zwp_tablet_tool_v2` reference -- which we don't
  implement -- now resolves to a null `types[]` slot rather than
  refusing to build the registry). The C client test glue
  references `zwp_tablet_tool_v2_interface`; we ship a tiny
  link-time stub (`test/tablet-stub.c`) so test clients link
  without pulling in the tablet protocol.

- **Kinematic state machine**
  (`packages/core/src/cursor/kinematics.ts`): windowed finite-
  difference velocity (port of hypr-dynamic-cursors' ModeTilt /
  ModeStretch math), KWin-style shake detector (trail / diagonal-of-
  bounding-box ratio, with the 100-px diagonal jitter suppression),
  idle timer driven by `beforeRender(timeMs)`. Refcounted lazy
  enablement: the rule engine bumps a refcount per rule that uses
  each capability; pointer-motion updates are no-ops while the
  refcount is zero. The sample-count math still uses a hardcoded
  60Hz constant; the actual frame rate is now panel-rate (165Hz on
  the verification box), so smoothing windows are ~2.75× shorter
  than the math assumes. Low impact (the math is forgiving) but
  worth fixing — replace the constant with the dispatched `timeMs`
  delta when this becomes user-visible.

- **Rule engine**
  (`packages/core/src/cursor/rule-engine.ts`): stores `CursorRuleSpec`
  registrations in order. Per frame (driven by `state.beforeRender`
  in main.ts): evaluates predicates against the kinematic snapshot;
  first-match-wins; installs the matched rule's outcome (shape via
  resolver + setCursorPixels, or texture via setCursorTexture)
  through a `RuleInstaller` adapter. Explicit overrides
  (`sdk.cursor.setShape/setImage/hide`) preempt rule installs --
  the rule engine has a `setExplicitOverride(bool)` flag the broker
  flips. `unregister` drops kinematic refcounts and re-evaluates.

- **`sdk.cursor`** (`packages/core/src/plugins/cursor-sdk.ts`):
  ```ts
  interface CursorAPI {
    setShape(name): Promise<void>;
    setImage(texture): Promise<void>;
    hide(): Promise<void>;
    show(): Promise<void>;
    clearOverride(): Promise<void>;
    setDefault(shape | null): Promise<void>;
    defineRule(spec): Promise<{ unregister(): Promise<void> }>;
  }
  ```
  `setImage` and texture-outcome rules require in-thread bundled
  plugin (cross-device cursor textures from Worker plugins throw
  "not supported; in-thread only in v1"). All other methods work
  for both transports. Plugin release auto-unregisters outstanding
  rules. The shared type contract lives in `@overdraw/cursor-types`.

- **Cursor broker** (`packages/core/src/plugins/cursor-broker.ts`):
  routes `cursor.*` plugin-to-core requests. Owns the resolver,
  rule engine, kinematic state, and the `RuleInstaller`. Per-plugin
  rule tracking so a crashed plugin's rules get dropped (the broker
  exposes `releasePluginRules(pluginName)` for the runtime to call
  on plugin exit; the wiring is in cursor-broker.ts but the runtime
  hook isn't yet called -- low-impact since the SDK's `release()`
  unregisters them voluntarily on graceful shutdown).

- **Boot default**: `main.ts` resolves `'default'` at boot and
  installs it on the cursor slot, so something is visible even
  before any client connects or any plugin loads.

- **Bundled `@overdraw/plugin-cursor-actions`**: registers
  `cursor.set-shape`, `cursor.hide`, `cursor.show`,
  `cursor.clear-override`, `cursor.set-default`. Wraps the SDK.
  Loads alongside `plugin-core-actions` so the actions are
  available for hotkey bindings before the hotkey plugin loads.

**Verified**:
- `test/cursor-theme.test.js` (8): LRU semantics + native built-in
  fallback (always succeeds for `default`) + miss returns null.
- `test/cursor-kinematics.test.js` (13): enable/disable refcount;
  windowed velocity in both axes; shake detector fires/doesn't fire
  in expected scenarios; idle counter; reset.
- `test/cursor-rule-engine.test.js` (17): spec validation; first-
  match-wins; speedRange/idle/shake predicates; predicate AND;
  explicit override preempts; unregister + re-evaluate;
  refcount-per-capability; clear(); maxVelocityWindowMs.
- `test/cursor.gpu.mjs` (9 sub-tests): cursor invisible by default;
  setCursorVisible + position; hotspot offsets; draws above content
  layer; clearCursor; resize reallocation; native default fallback
  renders; cursorState introspection; setCursorFromSurface.
- `test/cursor-set-cursor.gpu.mjs` (1): real Wayland client maps a
  red toplevel + a green cursor surface, calls `set_cursor`; the
  compositor shows green at the pointer position over the red
  window.
- `test/cursor-shape.gpu.mjs` (1): real Wayland client uses
  `wp_cursor_shape_v1.set_shape(default)`; the resolver's fallback
  arrow renders at the pointer position.
- `test/cursor-sdk.gpu.mjs` (3): bundled fixture plugin uses
  `sdk.cursor.setShape` + `sdk.cursor.hide` + `sdk.cursor.defineRule`
  with `speedRange` predicate; readback verifies the cursor pixel
  is visible/hidden as expected.

712/712 unit tests pass (was 674 pre-Phase-9c; +13 kinematics + 17
rule engine + 8 theme = +38). 117/117 GPU tests pass (was 102
pre-Phase-9c; +9 cursor compositing + 1 set_cursor + 1 cursor-shape
+ 3 cursor SDK + 1 outer wrapper = +15).

**Caveats / known limitations**:
- **`wait` cursor is static**: animated XCursor frames not supported
  (v1 picks subimage 0). Real themes' `wait` / `progress` /
  `left_ptr_watch` display as a single frame.
- **HiDPI cursor not scaled**: resolver takes a `scale` arg from
  day one (so no retrofit), but core only ever passes scale 1, so the
  cursor is correct-size but soft at output scale > 1 (see "HiDPI /
  output scaling"). Independent of multi-output.
- **`enlarge` rule outcome is no-op in v1**: the rule engine accepts
  the field but doesn't apply a scale to the cursor texture. Would
  need either pre-scaled uploads or a compositor scale uniform on
  the cursor surface specifically. Punted until a real consumer
  needs shake-to-find magnification.
- **Subsurfaces on cursor surfaces ignored**: the protocol permits
  them; we don't composite them. Warning is NOT logged (silent gap).
- **Cross-device cursor textures from Worker plugins unsupported**:
  `sdk.cursor.setImage` + texture-outcome rules throw with a clear
  message from in-thread harness; Worker plugins can call
  `setShape` + shape-outcome rules just fine (the resolver runs in
  core).
- **Cursor surface protocol-error post unwired**: a surface already
  bound to a different role being passed to `set_cursor` should
  raise a protocol error per spec; we drop silently
  (`post_error`-wired errors don't exist in this compositor yet).
- **`wp_cursor_shape_v1` shapes don't persist across pointer enter/
  leave for the client**: clients re-issue `set_shape` on each
  `pointer.enter`, the same convention they follow for
  `wl_pointer.set_cursor`. The seat could cache shape selections
  the same way it caches `set_cursor` surfaces, but the current
  `applyClientCursor` path only handles surface-or-hidden.
- **`enlarge` from continuous transforms** (tilt / rotate / stretch
  from hypr-dynamic-cursors): not in v1. The kinematic primitives
  expose enough state for a future plugin to port them, but the
  rule engine's outcome vocabulary is shape-or-texture only; per-
  frame rotation / tilt of the cursor texture itself would need
  either a cursor-specific render pass or extending the per-surface
  transform path to apply to the cursor slot.

### Buffer intercept (Phase 10a)

Per-pixel intercept v1. A plugin registers against a client (by
`app_id` regex); for each matched toplevel, the plugin's `render`
callback runs every visible frame and writes a new texture core
composites instead of the client buffer. Use cases: blur, color
grading via custom shaders, distortion, CRT effects -- anything that
needs the client texture as input. Effects that fit core's "one
sample per pixel modulated by uniforms" criterion (opacity, mask,
tint, color matrix, transform, margin) belong in Phase 5.5's per-
surface state path; intercept is for genuine shader passes.

**10a scope (landed):** in-thread + Worker transports, single
intercept per surface, render every visible frame, output texture
replaces client buffer in the compositor's per-surface render pass,
optional `outputRect` return for per-frame placement override,
render-throw fallback to raw, consecutive-failure auto-unregister
(in-thread only).

**Deferred to 10b:** multi-stage chains with categorized ordering
(`pixels` -> `geometry` -> `composition`), per-stage caching keyed
on commit-since-last-render, hold-last-output on render failure
(v1 falls back to raw), A1 input optimization (re-export client
dmabuf vs. the A2 copy ring 10a uses), popups + subsurfaces of
matched clients (10a covers toplevels only), capture/takeover
integration of the chain. Design: `intercept-design.md`.

**Architecture.** Four pieces in core:

- **Match engine** (`packages/core/src/intercept/match-engine.ts`):
  pure JS, tracks each mapped toplevel's `(surfaceId, appId, title)`;
  on register / unregister / window.map / window.change(appId) /
  window.unmap, computes first-match-wins assignments and emits
  abstract matched/unmatched events the broker translates to plugin
  callbacks. First-registered match wins for clients matching
  multiple registrations.

- **InThreadInterceptState**
  (`packages/core/src/intercept/inthread-state.ts`): per-surface
  state for bundled plugins sharing core's `GPUDevice`. Owns a 3-
  slot output ring of core-device textures (`RENDER_ATTACHMENT |
  TEXTURE_BINDING | COPY_SRC | COPY_DST`, reallocated on dimension
  change). Each per-frame `tick(timeMs)` reads the surface's current
  client texture, rotates the ring, calls the plugin's `render`,
  installs the just-rendered slot as the surface's intercept output
  view + optional outputRect. K consecutive render throws (default
  30) trigger auto-unregister.

- **WorkerInterceptState**
  (`packages/core/src/intercept/worker-state.ts`): per-surface state
  for Worker plugins on their own `GPUDevice`. Two cross-device
  dmabuf rings:
  - **Input ring** (core produces, plugin consumes): core encodes
    `copyTextureToTexture(clientTex, ringSlot)` each tick (A2
    "copy ring"; A1 "re-export the client's dmabuf" is the 10b
    optimization). Producer Begin/End ride the core wire; consumer
    Begin/End ride the plugin wire.
  - **Output ring** (plugin produces, core consumes): plugin's
    `render` writes to the output slot; producer Begin/End ride the
    plugin wire; consumer Begin/End ride the core wire (FIFO behind
    the compositor's sample). Same `SurfaceProducer` / `SurfaceConsumer`
    abstractions the overlay + compose-live paths use.
  - The worker's per-surface tick loop pulls on the input SAB
    (`Atomics.waitAsync` on slot state), invokes `render`, presents
    the output. Core polls the latest PRESENTED output slot each
    frame and binds it as the surface's intercept output view via
    `JsCompositor.installInterceptOutput`.

- **Broker** (`packages/core/src/intercept/broker.ts`): listens on
  the typed window-event bus, routes matched/unmatched events to
  the right transport, runs setup + per-frame `tick`. The plugin-
  facing route for Worker requests lives in
  `packages/core/src/plugins/intercept-plugin-broker.ts`
  (`intercept.register`, `intercept.unregister`,
  `intercept.alloc-rings`).

**Compositor integration**
(`packages/core/src/gpu/compositor.ts`):

- `Surface.interceptOutputView` field added. When set,
  `rebuildBindGroup` substitutes this view for the surface's
  sampled texture in the per-surface render pass.
- `Surface.interceptPlacement` field added. When set, the per-
  surface composite uses this rect instead of the surface's
  `(x, y, layoutW, layoutH)` -- the `outputRect` return from
  the plugin's render callback.
- `installInterceptOutput(surfaceId, view, placement)` /
  `clearInterceptOutput(surfaceId)` on the sink interface.
- `copyClientToInterceptInputSlot(surfaceId, dstTex)`: encode +
  submit a single `copyTextureToTexture` from the surface's
  current client texture into a dmabuf the Worker plugin will
  sample. Wraps in producer Begin/End on the core wire.
- The shm client-texture path now creates surface textures with
  `COPY_SRC` in addition to `TEXTURE_BINDING | COPY_DST` so the
  Worker input-leg copy can use them as source.

**`sdk.intercept`**
(`packages/core/src/plugins/intercept-sdk.ts`,
`@overdraw/intercept-types`):

```ts
interface InterceptAPI {
  register(spec: InterceptSpec): Promise<{ unregister(): Promise<void> }>;
}

interface InterceptSpec {
  name: string;
  match: {
    appId?: { source: string; flags: string };   // serialized RegExp
    roles?: ReadonlyArray<"toplevel" | "popup" | "subsurface">;
  };
  contributes?: ReadonlyArray<"pixels" | "geometry" | "composition">;
  setup(ctx: { device: GPUDevice }): Promise<InterceptHandlers> | InterceptHandlers;
}

interface InterceptHandlers {
  onSurfaceMatched?(surface: InterceptSurfaceInfo): void;
  onSurfaceUnmatched?(surface: InterceptSurfaceInfo): void;
  render(args: {
    input: { texture: GPUTexture; rect: Rect };
    output: { texture: GPUTexture; rect: Rect };
    ctx: { surfaceId: number; frameNumber: number; time: number };
  }): { outputRect?: Rect } | void;
  destroy?(): void;
}
```

The plugin source is **identical** for in-thread and Worker. The
SDK transparently routes to the right transport. `setup()` runs
LOCALLY in both cases -- in-thread with core's `GPUDevice`, in a
Worker with the worker's own device. The cross-device dmabuf ring
plumbing is invisible to the plugin.

**Worker-side runLoop**
(`packages/core/src/plugins/intercept-sdk.ts` `WorkerPerSurfaceState`):
synchronous per-surface event loop driven by `Atomics.waitAsync` on
the input SAB. On each iteration: wait for a PRESENTED input slot
-> consumer Begin on it -> acquire next FREE output slot (producer
Begin) -> call `render` (plugin encodes + submits) -> producer End
-> consumer End. Exits when the SDK's per-state `stop()` flips the
`stopped` flag (driven by `onSurfaceUnmatched` notifications from
core and by the plugin's `unregister` call).

**Compositor displacement priority.** Within the on-screen
composite pass, a surface's sampled texture is its
`interceptOutputView` if non-null, else its client texture
(`view`). The placement is `interceptPlacement` if non-null,
else the surface's WM-assigned rect. The intercept broker
sets/clears these per frame via the sink.

**Verified**:
- `test/intercept-match.test.js` (23 pure-unit): first-match-wins
  registration order, app_id regex compile + match, predicate
  AND-combination is N/A for intercept (no chained conditions),
  re-evaluation on app_id change, unmap clears assignments,
  remove-registration re-assigns freed surfaces.
- `test/intercept-broker.test.js` (11 pure-unit): setup runs once,
  bus-driven lifecycle, render-throw -> log + skip, K-failures ->
  auto-unregister (in-thread), unregister fires onSurfaceUnmatched
  + destroy, in-thread transport required for registerInThread,
  invalid app_id regex rejects.
- `test/intercept-inthread.gpu.mjs` (4): invert demo (real Wayland
  client showing red, fixture plugin renders cyan via WGSL invert,
  pixel readback confirms displacement); outputRect override (the
  same plugin returns `{outputRect: {x:64,y:64,w:64,h:64}}` -->
  cyan inside that rect, black outside, NO client buffer at the
  WM rect); match scope (two clients, only matched is inverted);
  unmatched fires when the client unmaps.
- `test/intercept-worker.gpu.mjs` (1): same invert demo through
  the Worker SDK + cross-device dmabuf chain. Core copies the
  client texture into the input ring; the worker plugin samples
  it + writes inverted cyan into the output ring; core composites
  the output ring's latest slot. Pixel readback matches in-thread.

746/746 unit tests pass (was 712 pre-10a; +23 match + 11 broker).
123/123 GPU tests pass (was 117 pre-10a; +4 inthread + 1 worker +
1 wrapping suite).

**Caveats / known limitations (10a):**
- **No chain**: only ONE intercept can apply per surface. First-
  registered wins for clients matching multiple registrations.
  Chains land in 10b.
- **No per-stage cache**: render is called every visible frame even
  if neither inputs nor effect state changed. Plugin caches its own
  work if needed.
- **No hold-last-output on failure**: render throw -> draw raw for
  that frame (visible flicker). Hold-last-output is 10b.
- **Worker input is A2 (copy)**: per-frame `copyTextureToTexture`
  cost per intercepted surface on core device. A1 (direct dmabuf
  re-export) is the 10b optimization. For typical 1080p surfaces
  the copy is ~8MB/frame which is bounded but noticeable.
- **`contributes` field recorded but unused**: 10b's chain dispatch
  consumes it.
- **HiDPI**: ring textures sized to the client buffer's pixel
  dimensions. Scale factor is 1 today; awaits `wl_output`
  reconfiguration.
- **Decoration + cursor surfaces always excluded**: not user-
  selectable in 10a or 10b.
- **Popups + subsurfaces of matched clients draw raw**: 10a matches
  toplevels only. 10b extends to all content surfaces via parent-
  walking + a surfaceCreated/Destroyed event.
- **`outputRect` interacts oddly with the WM**: the WM still owns
  the surface's "logical" rect (for hit-testing + layout). The
  compositor uses `outputRect` for placement, but input events
  hit-test against the WM's rect. Plugins that animate `outputRect`
  far from the WM rect will get hit-tests that don't match the
  visual position.
- **Worker test teardown flake**: `test/intercept-worker.gpu.mjs`
  intermittently fails in `addon.stop()` teardown. Two failure modes,
  both about ~15-20% per run in isolation (the full `npm run test:gpu`
  passes 129/129 reliably since the flake is per-process and the suite
  serializes tests):

  Mode A: `Napi::CallbackScope::~CallbackScope` aborts when a Dawn-wire
  tracked event fires its JS callback with the "instance no longer
  exists" status during `WireClient::Disconnect()`. The callback (e.g.
  the `onSubmittedWorkDone` registered for a per-frame submit) throws
  because it expected GPU success; the throw escapes through Napi's
  destructor with no JS frame above to catch it.

  Mode B: the GPU process itself aborts (signal 6) somewhere in its
  control-frame dispatch -- a Begin/End access frame arriving after the
  matching surfaceBuf state was torn down hits one of several
  hard-aborts on the path. Verified by `/tmp/overdraw-gpu-crash.txt`:
  the backtrace lands in `dispatchControl` (plugin wire) or
  `allocSurfaceBufImpl`'s `finalize` (core wire), both reached via stale
  deferred work after the worker died.

  Equivalent in-thread test (`intercept-inthread.gpu.mjs`) doesn't
  flake -- both modes are specific to cross-device Worker submits.

  Root cause is architectural and two-layered: (1) the cross-device
  fence chain has core-side submits whose completion depends on the
  worker's submits; when the worker is terminated mid-frame, the GPU
  process holds work whose fence dependencies will never resolve, and
  the matching `onSubmittedWorkDone` tracked events on the core wire
  remain pending until `Disconnect()` cancels them with errors. (2) the
  GPU process is built around "hard-abort on unexpected state" (a
  steady-state correctness invariant; the comments call out the design
  choice explicitly) which conflicts with the partial-state realities
  of shutdown -- in-flight wire frames against torn-down state, barrier
  deferred actions whose preconditions vanished, etc.

  Attempted fix in this session: a shutdown handshake protocol
  (`Tag::ShutdownAck`) where the GPU process force-ends open
  surface-buf access brackets + ticks each device + flushes completion
  responses + acks before the core proceeds to `Disconnect()`. The
  handshake mechanism worked (verified with logging: ack arrives in
  ~0ms when nothing else races), but didn't move the flake rate
  measurably (baseline 17/100, with-fix 22/100 -- within noise).
  Reverted. The issue isn't a single missing pump or drain step;
  several abort sites in the GPU process need shutdown-aware paths,
  and properly fixing it is a multi-day refactor with risk of
  breaking the steady-state correctness invariants the aborts
  protect. Recorded here as architectural debt to address before the
  intercept-Worker code path takes production traffic.

### wlr-layer-shell (`zwlr_layer_shell_v1` / `zwlr_layer_surface_v1`)

Desktop-shell-component surfaces (status bars, wallpapers, app launchers,
notifications): a client roles a `wl_surface` as a layer surface in one of
four named layers (background / bottom / top / overlay), with anchor,
size, margin, exclusive zone, and keyboard-interactivity state. The
compositor computes the output-space rect from anchor + size + margin
against the appropriate output rect (raw output for `zone != 0`, output
minus other surfaces' reservations for `zone == 0`), registers the
surface's own exclusive zone (when valid) with the reserved-zone
registry, and composites it in the requested layer above or below
toplevels.

- **Globals + child interfaces** advertised at the standard versions
  (v4 for both, the latest the wlr protocol publishes).
- **Configure / ack handshake** mirrors xdg-shell: get_layer_surface
  defers the first configure; the client commits with no buffer; the
  compositor sends `configure(serial, w, h)`; the client acks; the next
  commit attaches a buffer and maps. A buffer attached before the first
  ack is dropped (would post `invalid_surface_state`; see "Read first"
  for the no-`post_error` gap).
- **Anchor + size + margin + zone math** lives in
  `packages/core/src/protocols/layer-shell-position.ts`, pure +
  unit-tested (`placeLayerSurface`, `resolveExclusiveEdge`,
  `computeReservedThickness`; 27 tests). Size 0 on an axis means "span
  the anchored opposite edges"; v5 `set_exclusive_edge` resolves the
  corner-anchor ambiguity for the reservation.
- **Reserved-zone registry**
  (`packages/core/src/wm/reserved-zones.ts`): a layer surface with
  `zone > 0` and a resolvable edge installs a per-edge band. The WM's
  layout driver reads `effectiveRect()` to compute the tile region;
  tiled windows reflow inside it and `maximized` resolves to it.
  `Wm.schedule('reserved-zones-changed')` triggers the relayout when a
  zone changes. Sibling zone==0 layer surfaces re-place against the new
  effective rect on every apply (and on the panel's destroy).
- **Layer-stack merge** (`packages/core/src/layer-stack.ts`): the
  overlay broker (plugin overlays + decorations on flat layers) and the
  zwlr_layer_surface_v1 registry both write into the same compositor
  non-content layers; `rebuildLayerStack(state, layer?)` merges them
  before pushing `setLayerSurfaces`. Order per layer: overlay-broker
  ids first (compositor chrome), then layer-shell ids (user content
  for the layer). Protocol "bottom" maps to compositor "below";
  "top" -> "above".
- **`window.map` discriminator**: layer surfaces fire
  `window.map { role: 'layer-shell', appId: null, title: null }` on
  the typed core bus (the protocol carries a `namespace` string instead
  of app_id/title; not surfaced on this event today). `LayoutWindow.role`
  already had the value reserved.
- **Pointer hit-testing**: the seat's `pick()` now searches layer
  surfaces above toplevels (overlay > top) before toplevels, and below
  (bottom > background) after. Input regions are honored on layer
  surfaces too.
- **Keyboard interactivity** (`none` / `on_demand` / `exclusive`):
  - `none` (default): not eligible for keyboard focus. Pointer/touch
    routes normally.
  - `on_demand` (v4+): participates in the normal focus path. The
    bundled focus plugin's `decide()` sees the surface id under the
    pointer and resolves focus through its existing policy (no plugin
    change needed; the focus seam is surface-id-shaped).
  - `exclusive` on the `top` or `overlay` layer: a core-level override
    above the focus driver. While at least one such surface is mapped,
    the seat's `applyKeyboardFocus` and `dispatchFocus` short-circuit
    and force kbFocus to the topmost-overlay-then-topmost-top exclusive
    surface; tie-break is creation order. The bundled focus plugin is
    not consulted. `bottom` and `background` exclusive requests are
    silently treated as `on_demand` (spec: "the compositor is allowed
    to use normal focus semantics" there).
- **Popups parented to layer surfaces**:
  `zwlr_layer_surface_v1.get_popup` accepts an `xdg_popup` created with
  NULL parent (the spec's escape hatch). `xdg_surface.get_popup` now
  accepts NULL; its configure is deferred until the layer-shell
  get_popup supplies the layer parent. `popupOutputOrigin` resolves
  both xdg-shell and layer-shell parents; per-output filtered stacks
  always include layer-parented popups (workspaces don't model layer
  surfaces). Destroying a layer surface drops its popups.

**Limitations / known gaps:**

- **Single output** (`OUTPUT_DEFAULT = 0` only). The `output` arg to
  `get_layer_surface` is accepted but ignored; every layer surface
  targets the single output. Multi-output enumeration + per-output
  frame clocks are deferred (drm-design.md "Out (deferred)").
- **Protocol-error posts are silent-drops.** This compositor has no
  `wl_resource_post_error` mechanism (cursor-shape, seat, subsurfaces
  follow the same convention). Each silent-drop site in the layer-shell
  handler is commented with the spec error it would otherwise raise:
  `role` (existing role on the wl_surface), `already_constructed`
  (buffer attached before role), `invalid_layer`, `invalid_anchor`,
  `invalid_keyboard_interactivity`, `invalid_size` (size==0 axis
  without opposite-edge anchors), `invalid_exclusive_edge`,
  `invalid_surface_state` (buffer attached before first ack). Clients
  that violate these see no visible behavior change vs. a compliant
  compositor in most cases (the request is dropped + the surface
  proceeds with default state).
- **`closed` event not emitted.** The spec lets the compositor send
  `closed` (e.g. on output destruction); there is no output destruction
  yet, so this event isn't used. Client-initiated destroy proceeds
  through the normal destructor path.
- **Animated cursors and HiDPI** are inherited limitations from the
  cursor / output substrates, not layer-shell-specific.

**Files** (new):
- `packages/core/protocols/wlr-layer-shell-unstable-v1.xml` (vendored).
- `packages/core/src/protocols/layer-shell-position.ts` (pure math).
- `packages/core/src/protocols/zwlr_layer_shell_v1.ts` (both
  interfaces' handler factories + the apply pipeline +
  applyLayerSurfaceInitial / applyLayerSurfacePending /
  markLayerSurfaceMapped / teardownLayerSurface).
- `packages/core/src/layer-stack.ts` (merged push).
- `packages/core/native/wayland/generated/wlr-layer-shell-unstable-v1-*`
  (wayland-scanner output for the C test client).
- `packages/core/test/layer-shell-test-client.c` (GPU test client).
- `test/layer-shell-position.test.js` (27 unit tests),
  `test/layer-stack.test.js` (8), `test/layer-shell-registry.test.js`
  (22), `test/wm-reserved-zones.test.js` (5),
  `test/layer-shell.gpu.mjs` (4 GPU).

**Files** (modified):
- `packages/core/src/protocols/ctx.ts`: LayerSurfaceRecord +
  state.layerSurfaces / layerSurfacesBySurface / reservedZones /
  relayout / overlayLayerIds; PopupRecord.parent widened to
  XdgSurfaceRecord | null + PopupRecord.layerParent;
  SeatState.reevaluateExclusiveLayerFocus.
- `packages/core/src/events/types.ts`: WindowMapEvent gains
  optional `role: 'toplevel' | 'layer-shell'`.
- `packages/core/src/protocols/index.ts`: GLOBALS + CHILD_INTERFACES
  add the two interfaces; InstallOptions.reservedZones threaded
  through; state.relayout = wm.schedule; the imported-surfaces sweep
  fires window.map for layer surfaces.
- `packages/core/src/protocols/wl_surface.ts`: initial-commit
  detection branches on s.layerSurface; pre-ack buffer is dropped;
  apply path calls applyLayerSurfacePending. unmapAndTeardownSurface
  emits window.unmap for layer_surface role and calls
  teardownLayerSurface.
- `packages/core/src/protocols/xdg_surface.ts`: get_popup accepts
  NULL parent.
- `packages/core/src/protocols/xdg_popup.ts`: parentOutputOrigin
  handles XdgSurfaceRecord | null; popupOutputOrigin resolves
  layer-parented popups via PopupRecord.layerParent;
  rebuildStackWithPopups always includes layer-parented popups in
  per-output filtered stacks.
- `packages/core/src/protocols/wl_seat.ts`: pickLayer; exclusive-
  layer focus override (focusTargetFor, pickExclusiveLayerSurface,
  reevaluateExclusiveLayerFocus). applyKeyboardFocus + dispatchFocus
  consult the override.
- `packages/core/src/wm/index.ts`: Wm.schedule(reason).
- `packages/core/src/overlay.ts`: pushLayer routes through
  rebuildLayerStack; state.overlayLayerIds published.
- `packages/core/src/main.ts`: reservedZones passed into
  installProtocols (was layout-driver only).
- `packages/layout-types/src/index.ts`: LayoutReason gains
  'reserved-zones-changed'.
- `packages/core/CMakeLists.txt`: layer-shell-test-client target.
- `packages/core/tools/gen-protocol/gen-protocol.js`: XML added to
  DEFAULT_INPUTS.
- `test/harness.mjs`: constructs and threads reservedZones into
  installProtocols + the layout driver factory.

966/966 unit tests pass; 129/129 GPU tests pass.

### xdg-decoration (`zxdg_decoration_manager_v1` / `zxdg_toplevel_decoration_v1`)

The wire-level negotiation a client uses to ask "do you want me to draw my
own decorations?" The compositor's answer is unconditional: `server_side`,
on initial `get_toplevel_decoration` and on every `set_mode`/`unset_mode`.
The client's preference is ignored -- the compositor's policy is "draw
decorations server-side"; a well-behaved client suppresses its CSD on
receiving the SSD configure.

The protocol is decoupled from the actual decoration drawing, which lives
in the per-app_id decoration broker (`packages/core/src/decorations.ts`).
Binding `zxdg_decoration_manager_v1` does NOT cause decorations to appear
around a toplevel -- a decoration plugin still has to match the client's
`app_id` and draw. The protocol's contribution is the SSD signal that
tells well-behaved GTK/Qt clients to suppress their own titlebar. A
toplevel whose `app_id` has no matching decoration plugin: under the
protocol it gets the "SSD will be drawn" signal but no decoration plugin
actually draws one -- the client may have already suppressed its CSD,
leaving a borderless window. An end-user-visible papercut for clients
with no matching style rule; a universal fallback decorator plugin (a
catch-all regex at priority 0) closes it.

Silent-drops (no `post_error`; see "Read first"): `already_constructed`
(second `get_toplevel_decoration` on the same xdg_toplevel),
`unconfigured_buffer`, `orphaned`, `invalid_mode` (out-of-range enum
value -- a configure with `server_side` is still sent in reply).

Files: `packages/core/src/protocols/zxdg_decoration_manager_v1.ts`
(both interfaces), `test/xdg-decoration.test.js` (7 unit tests).

### xdg-output (`zxdg_output_manager_v1` / `zxdg_output_v1`)

A side-channel on `wl_output` that reports the output's logical position
(in the global compositor coordinate space), logical size (post-scale),
name, and description. Carries the same identity `wl_output` v4 advertises
(name + description); xdg-output is the path clients that want this data
without requiring v4 use. waybar specifically binds it at startup and
refuses to run when the global is absent -- adding xdg-output is the
single change that takes waybar from "exits with 'Failed to acquire
required resources'" to "runs". Advertised at protocol version 3.

`state.outputs: Map<number, OutputRecord>` is the underlying registry the
handler reads from. One entry today (`OUTPUT_DEFAULT = 0`) populated in
`installProtocols` from a seed (overdraw-internal default), then overwritten
by the GPU process's `OutputDescriptor` ctrl message during bring-up
(real host `wl_output` data in nested mode; connector EDID + active mode
in KMS). The fields are: `logicalPosition` (`{0, 0}` today; multi-output
will put each connector at a real position), `logicalSize` (the output
dims at scale 1), `scale`, `refreshMhz`, `transform`, `physicalWidthMm`/
`physicalHeightMm`, `name`, `make`, `model`, `description`. Re-emission
on output reconfigure is wired for nested host-window resize (slice 3 of
drm-design.md) and runs through `bus.emit("output.changed")` to the
`wl_output` + `xdg_output` re-emit subscribers.

`get_xdg_output(wl_output)` emits the full burst on creation:
`logical_position` -> `logical_size` -> `name` -> `description` -> `done`.
The `done` event is marked deprecated since v3 in favor of `wl_output.done`
but compositors must still support it; we emit it for v1/v2 clients.

**Wired**: re-emission on output change. The `xdg-output` handler walks
its bound resources on every `output.changed` bus emission and re-sends
the full burst + `done` (`reemitXdgOutput` in
`protocols/zxdg_output_manager_v1.ts`). Same for `wl_output`. Today this
fires on nested host-window resize; KMS mode change would route through
the same path once `SetOutputMode` lands (drm-design.md "Output
configuration"). Multi-output (multiple outputs in state.outputs) is
still deferred.

Files: `packages/core/src/protocols/zxdg_output_manager_v1.ts` (both
interfaces), `test/xdg-output.test.js` (4 unit tests). Type:
`OutputRecord` in `packages/core/src/protocols/ctx.ts`; state field
`CompositorState.outputs`.

### wlr-foreign-toplevel-management (`zwlr_foreign_toplevel_manager_v1` / `zwlr_foreign_toplevel_handle_v1`)

Lets a client observe every mapped toplevel and request state changes on
them. The data backbone for taskbars (waybar's `wlr/taskbar` module),
docks, and window switchers. Advertised at protocol version 3.

**Security model**: every client that binds the global gets the full
toplevel list. No per-client auth check; same model as the reference
compositors -- sandbox / portal layers handle isolation, not the
compositor. A toggle to disable advertising the manager is not built;
the implicit assumption is the user trusts everything in their session.

**Per-manager bookkeeping**: each bound manager resource holds its own
per-toplevel handle resource. Map size = (#managers) × (#mapped
toplevels). On bind, the handler emits `toplevel` + the initial property
burst (app_id, title, state array, done) for every currently-mapped
toplevel (the catch-up). New mappings emit on every bound manager via
the typed bus.

**Emission sources**:

- `window.map` (typed bus) -> emit `toplevel` + initial burst on every
  bound manager. layer-shell window.map's (role: 'layer-shell') are
  filtered out -- only toplevels go through this protocol.
- `window.unmap` (typed bus) -> emit `closed` on every manager's
  matching handle; drop the per-manager mapping. The handle resource
  stays alive (spec: "becomes inert") until the client destroys it.
- `window.change` (typed bus, coalesced per frame) -> re-emit
  `title` / `app_id` / `state` (when `activated` flipped) followed by
  `done`.
- `window.committed` (plugin bus) -> re-emit `state` (when
  `presentation` changed) and/or `parent` (when the parent slot
  changed) followed by `done`. The parent event's argument resolves to
  the new parent's handle on the SAME manager; on a different manager
  the same surfaceId resolves to that manager's own handle.

**Inbound requests**:

- `set_maximized` / `unset_maximized` / `set_minimized` /
  `unset_minimized` / `set_fullscreen(wl_output | null)` /
  `unset_fullscreen`: route through `wm.propose(surfaceId, {
  presentation: ... }, "plugin")`. The proposal goes through the
  intercept chain (so a focus plugin / window-rules plugin can veto)
  and committed; the resulting `window.committed` emit re-flows back
  into the handle as a state array. `set_fullscreen`'s `output` arg
  is currently ignored (single-output; see "Read first").
- `activate(wl_seat)`: bypasses the focus driver and calls
  `seat.applyKeyboardFocus(surfaceId)` directly. The reasoning: a
  foreign-toplevel client is a window switcher / taskbar / dock; its
  selection is explicit user intent. Policy plugins shouldn't
  second-guess.
- `close`: emits `xdg_toplevel.close` on the target's xdg_toplevel
  resource. The client decides whether to honor (typically yes;
  sometimes with a "save your work" prompt). No force-kill.
- `set_rectangle(wl_surface, x, y, w, h)`: minimize-to-icon animation
  hint. Accepted; no minimize animation is wired today so the
  rectangle is recorded only at the wire layer.
- `destroy`: drops the per-manager bookkeeping. The window may still
  be mapped; this just means this client is done with the handle.

**Stop request**: `manager.stop` emits `finished` and marks the manager
inactive. Subsequent events suppress; the client is expected to destroy
the resource.

**Limitations / known gaps**:

- **`output_enter` / `output_leave` not emitted.** Single-output today
  (`OUTPUT_DEFAULT` only). When multi-output enumeration lands, a
  per-client wl_output resource accessor is needed to find the bound
  resources for a given client + output before this can fire. Most
  consumers (waybar's taskbar in single-output configurations) don't
  depend on it.
- **No GPU end-to-end test.** The harness has no foreign-toplevel C
  client. Unit coverage on the wire shape is comprehensive (17 tests);
  a real waybar against overdraw is the integration check. Worth
  adding a dedicated C client when a behavioral regression surfaces.

**Files**: `packages/core/src/protocols/zwlr_foreign_toplevel_manager_v1.ts`
(both interfaces, ~310 lines), `test/foreign-toplevel.test.js`
(17 unit tests). XML vendored at `packages/core/protocols/wlr-foreign-toplevel-management-unstable-v1.xml`.

### Decoration provider (registration + insets + drawing + atomic gating)

Server-side decorations end to end: a plugin registers an app_id pattern, is told
which mapped windows it owns, and draws a decoration surface the core composites at
the window's inset rect, with the window's content gated until the decoration's
first frame (content + decoration appear together). A provider that never draws is
deregistered on a timeout and the window is shown undecorated.

- **Registration** (`packages/core/src/decorations.ts`, GPU-free): `sdk.decorations.register(
  pattern, flags?)` (RegExp source) + `onAssigned(cb)`. Subscribes to `window.map`
  + `window.change`, assigns the first-registered matching provider (match-once),
  emits `decoration.assigned {surfaceId, appId, title, rect}`.
- **createDecoration**: `sdk.decorations.createDecoration(windowId, {insets,
  layer?})` — the core reserves additive insets (WM `setInsets`: outer rect =
  content grown by insets; content + client unchanged), returns the outer rect, and
  the Worker allocates a producer/consumer ring there (the same ring `createOverlay`
  uses, window-bound). Only the plugin a window is assigned to may decorate it.
- **Content gating**: on assignment the broker gates the window's content (WM
  `setContentGated` skips it in the stack) and arms a first-frame timeout (default
  500ms). The decoration surface's first present releases the gate. On timeout the
  broker logs, permanently deregisters the provider, notifies it
  (`decoration.deregistered`), and releases the gate (window shown undecorated).
  Unmap before the first frame releases the gate without deregistering.
- **Per-window z-binding**: each decoration is z-bound to its window
  (`Window.decorationSurfaceId`) and spliced directly below its window's content in
  `computeBaseStack` (unified order `decoA, A, decoB, B`), so a decoration is not
  occluded by another window's content. Window-bound surfaces use
  `overlays.createWindowBound` (no flat layer; the WM stack owns z-order);
  output-anchored overlays still use the flat layers.
- **Surface teardown on unmap**: `Surface.destroy()` → stop compositing
  immediately, then (gated on `afterCurrentFrame`) end the consumer bracket +
  `pluginReleaseSurfaceBuffer` per slot → GPU-process `ReleaseSurfaceBuf` (end
  brackets, drop STM/textures/fences, release the dmabuf). `window.unmap` fires on
  client disconnect (not just explicit destroy) via an idempotent
  `unmapAndTeardownSurface` driven by both the destroy request and a per-frame
  resource-destroyed sweep, so a crashed client's ring + fences are released.
- **Verified**: registry/broker unit tests (match/first-wins/match-once/late-app_id/
  auth/gating/timeout/unmap-before-draw); a real client + provider (decoration
  composites in the inset band, content below, gate released); a broken provider
  (timeout → deregistered + content shown); two cascading decorated windows
  (top window's titlebar shows over the lower window's content); fd count flat
  across map/unmap cycles.

### Cross-device dmabuf + fence (the producer/consumer primitive)

Two independent `wgpu::Device`s sharing one GBM dmabuf, with a producer→consumer
handoff gated by a cross-device sync-fd fence, verified in-process via
`overdraw-gpu-process --selftest-xdev`: one GBM dmabuf imported as
`SharedTextureMemory` into both devices; producer device A clears it
(`BeginAccess` → render → `EndAccess` exports a `SharedFenceSyncFD`); consumer
device B `BeginAccess` waits that fence → samples → reads back; asserts the pixels
equal the producer's color. This is the GPU-timeline ordering the plugin path rests
on. **Scope:** in-process two-device on this driver; does not prove the
cross-process variant beyond what the plugin overlay path exercises. Not done:
multi-plane/YUV import.

### dmabuf interop primitives (single device)

GBM allocator + DRM modifier probe in the GPU process (`GetFormatCapabilities` +
`DawnDrmFormatCapabilities` intersected with `gbm_bo_create_with_modifiers`; on
NVIDIA, 7 Dawn-importable BGRA8 modifiers, 6 GBM-allocatable, single-plane). Import
as `SharedTextureMemory` on the wire-resolved device, `ReserveTexture`/
`InjectTexture` over the wire, `BeginAccess`/`EndAccess` with mandatory Vulkan
image-layout state, `SharedFenceSyncFD` on EndAccess. These are the primitives the
`linux-dmabuf-v1` handler and plugin rings reuse.

## Testing

The model mirrors the reference compositors (wlroots/Hyprland): pure GPU-free unit
tests + a headless run with state queries + synthetic input, asserting on
geometry/focus/state and computed-expectation pixels — no golden files. No
interactive (human-in-the-loop) tests.

### Pure-unit (`npm test` → `node --test 'test/**/*.test.js'`, GPU-free)

Generator + protocols: `gen-protocol.test.js`, `gen-protocol-all.test.js`
(validates ALL generated signatures), `popup-position.test.js`,
`data-device-dnd.test.js`. WM: `wm.test.js` (map/unmap + `windowAt`,
additive insets + gating filter, against a mock addon),
`wm-hints-state.test.js`. Layout (Phase 2,
`test/plugin-layout-default/`): `master-stack.test.js` (algorithm),
`integration.test.js` (driver + bundled plugin invocation end to end).
Snapshot / query: `query.test.js`. Config: `config.test.js`. Overlays /
decorations: `overlay.test.js`, `decorations.test.js`,
`decoration-zbind.test.js`. Events / windows brokers (Phase 0a/0d/0e):
`window-events.test.js` + `window-changes.test.js` (bus + observer +
coalescing, incl. a real Worker), `dynamic-bus.test.js` (pattern subscribe
+ plugin emit), `sdk-events.test.js`, `sdk-windows.test.js`,
`windows-broker-output-stack.test.js` (includes the `windows.focus`
explicit-override path added in Phase 3). Namespace / actions registries
(Phase 0b/0c): `namespace-registry.test.js`, `sdk-namespace.test.js`,
`action-registry.test.js`, `sdk-actions.test.js`. IPC (Phase 1):
`ipc-protocol.test.js`, `ipc-server.test.js`. Plugin runtime:
`plugins.test.js` (real Workers + real fixture plugins:
live/failed/graceful-stop/watchdog-terminate/OOM/independence). Phase 3:
`inthread-plugin.test.js` (in-thread bundled transport: register +
invoke; init throw -> failed state with no respawn; per-bundled-plugin
config channel verbatim pass-through);
`test/plugin-focus-default/policy.test.js` (the follow-pointer /
click-to-focus state machine in isolation + validateConfig);
`test/plugin-focus-default/integration.test.js` (focus driver + real
runtime + bundled plugin end to end; stale-result discard; bad-config
init throw). Buffers / wire / fds:
`client-buffer-lifecycle.test.js`, `wire-barrier.test.js`,
`scm-rights.test.js`. Server-only smokes: `server.test.js`,
`trampoline.test.js`, `fd-passing.test.js`, `xdg-shell.test.js`, shared
`server-helpers.mjs`, one server lifecycle per file.

### State-query channel (`packages/core/src/query.ts`)

`queryState(state)` → `StateSnapshot`: output size, windows (surfaceId + rect +
title + app_id + role + mapped), back-to-front stack order, pointer/keyboard focus
ids. The analog of `hyprctl /activewindow`; attached as `state.query()`. The seam an
integration harness asserts against without pixels.

### Integration / GPU (`npm run test:gpu` → `node --test 'test/**/*.gpu.mjs'`)

Require GPU + host Wayland (auto-skip when `WAYLAND_DISPLAY` unset), run with
`--test-concurrency=1`. `test/harness.mjs` brings up GPU process + present
loop + server + protocols + plugin runtime with the bundled plugins
(layout + focus) loaded in-thread, with layout + focus driver factories
wired against the runtime; `spawnClient` (resolves on the client's
"mapped" stdout line), `waitFor(query, pred)` (polls while yielding to
libuv), and `teardown()` (stops the runtime, then the addon; asserts no
GPU process leaked, scanning by exact comm `overdraw-gpu-pr`). Synthetic
input at two depths: `addon.injectInput` (straight into the `InputSink`)
and `addon.injectHostInput` (through the real `WaylandInputBackend`
normalization, round-tripping `wl_fixed_t`).

Coverage: `integration.gpu.mjs` (map→query, stacking, focus-on-map,
follow-pointer, click-to-focus, plus host-path input);
`compositing.gpu.mjs` (pixel: placement, two-client positions, overlap
stacking); `tiling.gpu.mjs` (master-stack tiling under real clients, post-
extraction); `protocols.gpu.mjs` (`wl_output` mode, `wl_callback` per-frame,
keyboard delivery via the host path); the JS-compositor suite
(`js-compositor*.gpu.mjs` incl. a dmabuf buffer-cycling leak test);
`overlay-layers.gpu.mjs`; `subsurface.gpu.mjs`; `popup.gpu.mjs`;
`clipboard.gpu.mjs`; `dnd.gpu.mjs`; `window-change-e2e.gpu.mjs`;
`xdev-fence.gpu.mjs`; `wire-serial-regression.gpu.mjs`; the plugin suite
(`plugin-overlay*.gpu.mjs`, `worker-gpu.gpu.mjs`, `decoration-*.gpu.mjs`
incl. `decoration-two-windows.gpu.mjs`, `example-decoration.gpu.mjs`,
`inthread-gpu.gpu.mjs` for the in-thread bundled-plugin core-device path,
`inthread-mask.gpu.mjs` for sdk.windows.setMask via a real bundled plugin,
`inthread-animation.gpu.mjs` for sdk.animations.run end-to-end,
`sdk-anim.gpu.mjs` for @overdraw/sdk-anim builders end-to-end);
per-surface render state primitives (`compositor-fx.gpu.mjs`).

### Protocol coverage matrix

- **Tested end-to-end**: `wl_compositor`, `wl_surface` (attach/commit/frame),
  `xdg_wm_base`/`xdg_surface`/`xdg_toplevel` (configure + states array,
  title/app_id, maximize/fullscreen/minimize/floating via `wm.propose`,
  interactive move/resize grab),
  `wl_shm`/`wl_shm_pool`/`wl_buffer` (pixel), `zwp_linux_dmabuf_v1`/
  `..._buffer_params_v1` (pixel), `wl_seat`/`wl_pointer`/`wl_keyboard` (focus +
  key delivery), `wl_output` (mode/geometry), `wl_callback`, `wl_data_device*`/
  `wl_data_offer` + `zwp_primary_selection_*` (clipboard round-trip),
  `wl_subsurface` (sync/desync, pixel), `xdg_popup`/`xdg_positioner` (pixel),
  `wl_data_device` DnD (full vertical),
  `zwlr_layer_shell_v1`/`zwlr_layer_surface_v1` (anchor + exclusive zone
  reflow, window.map role, exclusive keyboard interactivity override,
  popup re-parenting),
  `zxdg_decoration_manager_v1`/`zxdg_toplevel_decoration_v1` (unconditional
  server-side reply; the configure handshake is unit-tested, no GPU
  coverage since the protocol carries no visible state of its own --
  decorations come from the per-app_id broker),
  `zxdg_output_manager_v1`/`zxdg_output_v1` (logical_position +
  logical_size + name + description + done burst on bind; sourced from
  state.outputs which has one OUTPUT_DEFAULT entry today),
  `zwlr_foreign_toplevel_manager_v1`/`zwlr_foreign_toplevel_handle_v1`
  (taskbar protocol; window list + state observation + inbound state
  requests routed through wm.propose; unit-tested wire shape, no GPU
  test client today).
- **HiDPI (unit + GPU-readback tested)**:
  `wl_surface.set_buffer_scale` (double-buffer + compositor propagation +
  invalid-drop), `wp_viewporter`/`wp_viewport` (one-per-surface, double-buffered
  set_source/set_destination apply, validation, destroy-clears),
  `wp_fractional_scale_manager_v1`/`wp_fractional_scale_v1` (preferred_scale
  value + re-emit + untrack). `viewport-crop.gpu.mjs` pixel-verifies the
  source-crop path headless (src->cropUV conversion, X/Y orientation,
  size-from-source). Crisp rendering at `output.scale` 2 (integer) and 1.5
  (fractional) also confirmed by eye on the Intel panel. The scale-aware
  *subsurface* render path still has no dedicated GPU test (toplevel +
  direct-surface crop are covered). See "HiDPI / output scaling".
- **Implemented, not behaviorally tested**: `wl_region` (no-op stub);
  `zwp_linux_dmabuf_feedback_v1` (exercised by real WSI clients, no automated
  assertion).

### Headless mode

`addon.start(gpuBin, onFrame?, onInput?, { width, height })` spawns the GPU process
`--headless WxH` (no host window/`wl_surface`/host seat), brings up the device only,
skips `InjectSurface`/`Configure`/`Present`. The JS compositor renders into an
owned offscreen BGRA8Unorm target; `JsCompositor.readback()` (exposed as
`frameReadback()`) does `copyTextureToBuffer` + `mapAsync` → tightly-packed BGRA.
The real launcher passes no headless arg → stays nested + presents on screen.

### Known testing bugs / gaps

- **`startServer`/`stopServer` is not safely repeatable in one process** — a second
  lifecycle aborts with a libuv `uv__finish_close` assertion (uv handle teardown on
  reuse in `native/wayland/server.cpp`). Worked around with one server lifecycle per
  test file. Matters if a long-running compositor ever restarts its server; needs a
  real fix.
- No stdin command loop on the harness client for multi-step sequences
  (raise/move/resize) within one client lifetime.
- On-screen (nested) pixel correctness is not auto-asserted (no post-present
  readback; inherited from the headless pixel tests, same render pass).

## Config

`packages/core/src/config/` loads from `--config <path>` (hard error if missing) else
`$XDG_CONFIG_HOME/overdraw/config.*` then `~/.config/overdraw/config.*`, probing
`.ts/.cts/.mts/.js/.cjs/.mjs` (Node 24 native type-stripping, no transpile).
Default export may be an object or a (sync/async) function. Validates
`focus`/`output` (`output.width`/`height`, `output.card` for the KMS DRM
node, `output.scale` for HiDPI); the launcher applies them. The `plugins` array is parsed,
validated, resolved, and consumed by the runtime (module paths resolve relative to
the config file's dir); bundled plugins (from
`packages/core/src/plugins/bundled.ts`) are resolved separately and load
first. The capability sub-grant schema is not yet validated (no
capabilities exist to grant).

## Not yet built (design only)

- **Logging.** TS surface migrated; native surface not yet migrated.
  Infrastructure (designed in `architecture.md` Logging section) is in
  place: spdlog 1.17.0 (`3rdparty/spdlog` via FetchContent, compiled
  mode), fixed area set (`core`/`wayland`/`xdg`/`ipc`/`seat`/`input`/
  `gpu`/`dawn`/`plugin`/`js`), severity-based stdout/stderr split (≤info
  to stdout, ≥warn to stderr), opt-in `--log-file=PATH` (truncate on
  start, no rotation), per-area `--log-level=SPEC` (e.g.
  `--log-level=debug` or `--log-level=core=debug,gpu=info`). The host
  parses these in `packages/core/src/log.ts` and calls
  `addon.logInit(...)`; `installConsoleShim()` replaces
  `globalThis.console.{log,info,warn,error,debug,trace}` so every
  `console.*` routes via `addon.nativeLog` on area `"js"`. Per-area
  emission uses `import { log } from "./log.js"; log.info("wayland",
  "client %d", id)` (TypeScript-checked area string). All TS call sites
  in `packages/core/src/**/*.ts` are migrated to either the `log` module
  (with a specific area) or `console.*` (catch-all `"js"` area); the only
  intentional exceptions are `packages/core/src/log.ts` itself (the shim
  installer) and `packages/core/src/plugins/runtime-warnings.ts` (which
  deliberately uses raw `console.error` to bypass test log stubs).
  Cross-process flow: the GPU process is spawned with a fourth socket
  (`--log-fd=N`, `SOCK_SEQPACKET`); records are fragmented into
  `LogPacket`s (480-byte payload per fragment, header carries
  level/area/seq/fragIdx/fragCount); the host's `IpcSource` thread
  reassembles + dispatches into the host registry's logger for that
  area. A bounded ring (256 records) in the GPU-process `IpcSink` buffers
  records emitted before `--log-fd` is parsed; oldest drops with a
  single `warn`-level overflow notice on `ipc`. The advertised-but-
  unimplemented `Fault { reason }` GPU→core event listed in
  `architecture.md` is subsumed (no separate event; a fault becomes a
  normal `err`-level log on `gpu`).

  **Not yet migrated:** native call sites (140 `fprintf(stderr, "[gpu] ...")` /
  `printf("[core] ...")` sites across `packages/core/native/**` and
  `packages/core/gpu-process/src/**`). These still write directly to the
  inherited stderr instead of going through `LOG_*(Area, ...)` macros.
  Result: GPU/core native diagnostics bypass the `--log-file` sink and
  the runtime level filter, but everything still appears on the
  terminal. Migration is a mechanical sweep with judgment on the right
  area per file.

  **Known soundness gap (low impact):** `overdraw::log::logger(Area)`
  returns a `spdlog::logger&` to a `shared_ptr` held in a mutex-guarded
  registry; the lock is dropped on return, so a concurrent `logInit`
  could in principle delete the pointee while the reference is in
  use. `IpcSource` works around this by resolving via
  `spdlog::get(name)` (returns `shared_ptr`, keeps the logger alive
  across the call). The hot path is fine in practice (`logInit` is
  called once before any records flow) but the API is technically
  unsound; a future change would either return `shared_ptr` or hand
  out a wrapper that owns the lifetime.
- **WM behavioral-state residual gaps.** The behavioral handling of
  `xdg_toplevel` state requests is built: `move`/`resize`/`set_maximized`/
  `set_fullscreen`/`set_minimized`/`set_min_size`/`set_max_size` route through
  `wm.propose` → the `layout-driver` resolver (maximized → reserved-zone tile
  region, fullscreen → full output, minimized → hidden, floating → stored rect),
  with interactive move/resize as seat pointer grabs and the resolved state
  reflected in the next configure's states array. Covered by
  `xdg-toplevel-state-requests.test.js`, `xdg-toplevel-states.gpu.mjs`,
  `wm-floating.test.js`, `wm-state.test.js`, `seat-grab.test.js`,
  `xdg-toplevel-grab.test.js`, `layout-driver-resolver.test.js`. **Still not
  done:** `show_window_menu` (no compositor menu); `set_parent` stored but not
  driving stacking/modality; per-output fullscreen target (single output);
  floating windows ignore reserved zones.
- **Multi-output.** Single `OUTPUT_DEFAULT` binding only (output resize /
  reconfiguration on that one output is built and verified -- see "Output
  reconfiguration"). Multi-output enumeration, per-output frame clocks, and
  `output_enter`/`output_leave` are deferred (also noted under "Phase 2
  partially shipped").
- **User-facing diagnostic surfacing.** Plugin errors (in-thread init
  throws, per-call method exceptions, bad config from the focus plugin's
  validateConfig) currently only log. A real channel for surfacing them
  to the user (status-bar notification, IPC event, CLI command) is open
  per the corresponding open item in `core-plugin-api.md`.
- **Plugin SDK breadth.** Built: scope-B runtime + `sdk.gpu.createOverlay`
  + `sdk.window` observer + `sdk.decorations`; namespace registry + action
  registry + dynamic event bus (Phase 0); `sdk.windows` hint setters +
  state bag + snapshots + `setOutputStack` (Phase 0d/0e); IPC JSON-RPC
  server + `overdrawctl` (Phase 1); in-thread bundled-plugin transport +
  per-bundled-plugin config channel + `sdk.windows.focus(id)` (Phase 3);
  per-surface render state primitives `setOpacity` / `setTransform` /
  `setOutputMargin` / `setMask` (Phase 4a); declarative animation
  evaluator `sdk.animations.run` / `cancel` with tween + spring +
  sequence + parallel (Phase 4b); `@overdraw/sdk-anim` plugin-side
  spec builders (Phase 4c); per-surface tint + 4x4 color matrix
  primitives `setTint` / `setColorMatrix` (Phase 5.5a);
  `sdk.windows.requestFocusDecision(reason, trigger?)` policy-mediated
  focus dispatch + the bundled workspace plugin's `'workspace'`
  namespace API (Phase 6); `sdk.input.bind` / `defineMode` /
  `pushMode` / `popMode` keyboard binding chain + the bundled hotkey
  + core-actions plugins (Phase 7a); deferred-ref resolution
  (`ref.surfaceUnderPointer` etc.) in action params + `config.actions`
  + bundled `plugin-config-actions` + workspace by-name lookup
  (Phase 7b); built-in transitions `sdk.transitions.run` (six kinds:
  crossfade, slide-left/right/up/down, scale) with declarative
  atomic commit, snapshot + live scene inputs, in-thread + Worker
  transports (Phase 8a); animated `workspace.show` opt-in via the
  `transition` arg (Phase 8b); `window.closing` event + phantom
  snapshot + `sdk.windows.destroyPhantom` + 10s backstop, gated on
  a registered `'window-closing'` namespace plugin (Phase 9a);
  `sdk.cursor` (set shape / image / hide / show / set default /
  clear override / define rule) backed by an XCursor theme
  resolver, a kinematic state machine (windowed velocity + shake +
  idle), and a declarative rule engine -- plus the `wl_pointer.
  set_cursor` and `wp_cursor_shape_v1` client-cursor protocols
  routed into the same compositor slot (Phase 9c, with Phase 9b
  folded in); `sdk.intercept` (per-client app_id match, in-thread
  + Worker, per-surface render callback every visible frame,
  output texture replaces client buffer in the compositor's
  sampled-texture slot, optional `outputRect` for geometry
  control) backed by a match engine + per-surface output ring
  (in-thread = core-device textures; Worker = cross-device dmabuf
  rings via A2 copy on the input leg + overlay-style brackets on
  the output leg) (Phase 10a). Not built: animated cursor frames
  (static frame 0); HiDPI cursor scaling (resolver takes scale
  arg but core only ever passes 1); continuous cursor transforms
  (tilt/rotate/stretch); intercept chains + per-stage caching +
  hold-last-output + A1 input optimization + popups/subsurfaces
  (10b); plugin-visible output observation (multi-output / mode
  changes / DPI / refresh changes -- the core's `wl_output` is
  real today but the SDK does not expose it); protocol SDK
  surface; interactive-region hit-testing; `sdk.onFrame` (Phase 5+).
- **Capability enforcement.** No capability gate on `sdk.gpu`/`sdk.window`/
  `sdk.decorations` (every plugin gets them); no native-import restriction (a
  plugin's `import()` is unrestricted — deferred until there is an SDK native addon
  to allowlist); no sub-grant schema/enforcement.
- **Plugin teardown wiring.** `unregisterPlugin` exists in the broker but `main.ts`
  does not call it on plugin exit; a crashed provider's registration lingers (its
  gated windows are released by unmap/timeout).
- **Strict typing of the plugin GPU broker.** `packages/core/src/plugins/gpu-broker.ts` + `gpu.ts`
  pass an `unknown` request bag cast field-by-field with `as` (passes lint via a
  known loophole — eslint bans `as any`/`as unknown` but not `x as ConcreteType`).
  A typed request map is wanted; not done.
- **Cross-thread N-API marshaling.** `napi_threadsafe_function` for Dawn-thread
  callbacks not exercised.
- **Crash recovery.** GPU-process respawn + state replay not implemented.
  Crash handlers in both processes dump a backtrace -- GPU process to
  `/tmp/overdraw-gpu-crash.txt`, core addon to `/tmp/overdraw-core-crash.txt`.
- **Linear compositing.** Alpha blending currently happens in sRGB space.
- **Phase 2 partially shipped:** KMS/DRM scanout, libinput, libseat, VT
  switching (drm-design.md slices 1-7). Still deferred from phase 2:
  multi-output enumeration + per-output frame clocks, hardware cursor
  plane, hotplug, scanout from a GPU other than the laptop's iGPU,
  DRM lease, content protection, mode changes (`SetOutputMode` not wired).
  See drm-design.md "Out (deferred)".
- **Phase 3 (XWayland, session supervisor).** Untouched.
- **Live reload.** Not built.

## Spikes

Throwaway de-risking experiments live in `spikes/` (git-ignored); findings are
folded into architecture.md, the code is not part of the build.
