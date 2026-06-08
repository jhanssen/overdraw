# overdraw — implementation status

Ground truth for what exists right now: current capabilities, known gaps, and
what remains. The design lives in `architecture.md`; this file does not restate
it. Present-tense only — no change history.

Last updated: 2026-06-08.

## Read first: gaps in advertised protocols (silent-gap risks)

These are wired/advertised but incomplete. A client may use them and get nothing,
with no error. Worst-first.

- **`xdg_toplevel` window-management *state* requests are silent no-ops.** `move`,
  `resize`, `set_maximized`/`unset`, `set_fullscreen`/`unset`, `set_minimized`,
  `set_min_size`/`set_max_size`, `show_window_menu`, `set_parent` are accepted and
  ignored (no effect, no signal). Only `set_title`/`set_app_id` do anything. The WM
  is a fixed master-stack tiler that owns all geometry, so these client-initiated
  state requests have no meaning yet — there is no maximize/fullscreen/floating/
  interactive-move concept. They stay no-ops until those land (M2: floating +
  fullscreen + keybindings), but they are advertised, so clients think they work.

- **`wl_output` is fabricated.** It advertises one monitor whose refresh (60Hz),
  scale (1), transform, geometry (0,0), physical size, and make/model are
  hardcoded. The reported size is the nested host window size, not a real monitor.
  There is no host-window-resize handling: resizing the overdraw window does not
  update the output, the swapchain, the WM layout, or input coordinate mapping
  (all assume the initial size, scale 1, identity mapping). Doing `wl_output`
  properly means output reconfiguration end-to-end (GPU process reads the host's
  real output + tracks host-window resize → core updates output size → JS resends
  geometry/mode/scale/done → WM re-lays-out + input mapping + swapchain
  reconfigure), behind an output-backend seam (like the input backend) so phase-1
  host-output and phase-2 DRM/EDID/hotplug swap underneath without touching the
  WM/compositing/`wl_output` layers.

- **`wl_region` is a no-op stub.** `add`/`subtract` do nothing; opaque/input
  regions are not tracked (hit-testing uses whole-window rects). Low urgency.

- **Frame clock is a ~16ms timer, not display-driven.** The architecture's frame
  loop is event-driven off a display-side completion signal (host
  `wl_surface.frame` in phase 1, KMS page-flip in phase 2). Today a `uv_timer`
  paces render+present, which has no causal link to refresh and beats against real
  vsync. This is a phase-1 shortcut because Dawn's WSI swapchain owns `Present` and
  hides the host frame callback. See architecture.md "Frame clock" and "Phase-2
  present".

- **Smaller advertised-incomplete items:** `wl_subsurface` `place_above`/
  `place_below` sibling reordering (no-op); DnD drag-icon compositing (implemented,
  not pixel-tested); dmabuf `create` (async server-minted `wl_buffer`) not wired
  (only `create_immed`); single-plane dmabuf only; `zwp_linux_dmabuf_feedback_v1`
  is functional for WSI clients but not automatically asserted.

- **Advertised-absent (clean fallback, not gaps):** xdg-decoration (→ CSD),
  fractional-scale, cursor-shape, text-input, xdg-activation, toplevel-icon,
  system-bell. Clients warn and fall back. See the protocol-coverage matrix.

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
process owns the host Wayland output window + its `wl_display` connection, the
native Dawn instance + `dawn::wire::WireServer`, the `wgpu::Surface` (injected at
the client's reserved handle), and the GBM allocator. The core runs the
`dawn::wire::WireClient`, brings up adapter + device + surface over the wire, hosts
the JS protocol/WM/compositing/plugin layers, and is the Wayland server for
overdraw's own clients.

The core is C++ + Node: `packages/core/src/index.js`/`packages/core/src/main.ts` load `overdraw_native.node`;
native core in `native/core/` (`gpu_process`, `wire_link`, `compositor`). Node owns
`main()` and the libuv loop. The N-API addon uses the raw `node_api.h` C API (not
node-addon-api, to avoid exception/RTTI dependence under `-fno-rtti`).

### IPC (three sockets, fully non-blocking)

- **Dawn wire** over one `SOCK_STREAM` socket (length-prefixed, kind-tagged
  frames: `[len][kind][payload]`; kind=0 is Dawn wire bytes, kind=1/kind=2 are
  in-band access-bracket Begin/End frames — see INBAND-ACCESS.md).
- **Control side channel** over a `SOCK_SEQPACKET` socket carrying fixed-size
  tagged POD messages (`native/ipc/side_channel.h`) — not flatbuffers. SCM_RIGHTS
  fd passing is used (e.g. `ImportClientTex` carries a client dmabuf fd).
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

**Cross-channel ordering.** A control request (`ImportClientTex`, and the
producer/consumer `AllocSurfaceBuf` injects) must not overtake the wire commands it
depends on (the GPU's `InjectTexture` requires the server to have processed the
prior `UnregisterObjectCmd` that recycles the handle at generation+1). Enforced by
a wire serial: `FdSerializer` counts cumulative framed wire bytes; the core tags
the request with that value; the GPU process defers it (via `ipc::WireBarrier`)
until its consumed-byte count reaches the serial. An explicit happens-before across
the two sockets, no blocking. These are the only remaining per-buffer-lifetime
cross-channel deferrals: the per-FRAME access brackets (client-texture Begin/End,
producer/consumer Begin/End) no longer ride ctrl at all — they are multiplexed
in-band on the wire socket as kind=1/kind=2 frames, FIFO-ordered against the Dawn
commands, removing both the synchronous Begin round-trip and the EndAccess
WireBarrier deferral (see INBAND-ACCESS.md).

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
libuv-driven (a `uv_poll_t` on the wire fd drains inbound frames, a `uv_timer_t`
paces render+present). No hand-rolled C++ spin loop in steady state.

A C++→JS path works: an optional `onFrame` callback fires from the frame timer
(direct `napi_call_function`, same Node thread). The cross-thread path
(Dawn-internal callbacks → `napi_threadsafe_function`) is not yet exercised.

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
  plugin: `packages/plugin-layout-master-stack/`, registered in the `'layout'`
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

Still absent: per-surface transforms/opacity/rotation/scale, fractional scale,
multi-output, damage, host-window/output resize (`wl_output` still fabricated),
floating windows, fullscreen/maximize, workspaces/tags, compositor keybindings
(no key interception yet — every key is forwarded to the focused client).

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
`wrapTexture` → sample. The fd travels over the side channel via SCM_RIGHTS
(`ImportClientTex`); the GPU process imports it as `SharedTextureMemory` (reusing
`Allocator::importTexture`), does an initialized `BeginAccess`, and `InjectTexture`s
at the core's reserved handle. The commit is non-blocking (reserve → send →
`PendingImport`, return; the `ClientTexImported` reply is dispatched on the Node
thread).

**Buffer-release lifecycle (zero-copy).** A buffer is released only once the
compositor frame that sampled it completes on the GPU: the submit is tagged with a
serial + `onSubmittedWorkDone`; a buffer superseded by a newer commit is freed when
its retire-serial completes; freed ids drive `wl_buffer.release` + explicit
`ReleaseClientTex` of the server STM/fd. Verified by a buffer-cycling leak test
(GPU-process fd count bounded over 40 cycled buffers).

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

## Input

### Host input forwarding (host seat → GPU process → core → JS)

The GPU process binds the host `wl_seat` (`host_window.cpp`, pointer + keyboard, up
to v5) and forwards each event as a fixed-size `ipc::InputMessage` over the input
socket (non-blocking `MSG_DONTWAIT`; input is lossy by design). The core abstracts
this behind a backend seam (`native/core/input.h`: `InputEvent` in OUTPUT-space
doubles + raw evdev keycodes + ms timestamps, `InputSink`, `InputBackend`).
`WaylandInputBackend` (`input_wayland.cpp`) reads the socket, converts
`wl_fixed_t`, and emits `InputEvent`s; a future `LibinputBackend` implements the
same interface. The addon drains the backend on the Node thread (`uv_poll_t`) and
delivers to an optional `onInput` JS callback.

Limitations: coordinate mapping is identity (output size == host window size, scale
1); touch not forwarded; no keymap translation at this layer (raw evdev codes).

### Routing to clients (`wl_seat`/`wl_pointer`/`wl_keyboard`)

A real client receives mouse and keyboard on its surface. `wl_seat` advertises
pointer + keyboard; `handleInput` hit-tests the WM window stack (`wm.windowAt`),
tracks focus, and emits enter/leave/motion/button/axis/frame +
key/modifiers to the focused client's resources with surface-local coordinates.

- **Focus policy** is configurable (`FocusOptions`): pointer always follows the
  pointer; keyboard focus is `follow-pointer` (default) or `click-to-focus`.
  `focusOnMap` (default true) gives a freshly-mapped window keyboard focus so a
  launched app is typeable immediately.
- **Keymap + modifiers** (`native/wayland/keymap.{h,cpp}`, xkbcommon): a default
  keymap is compiled to a sealed memfd, sent via `wl_keyboard.keymap` (XKB_V1, fd
  delivered through the trampoline fd-encode path); each host key feeds xkb state
  and serialized modifier masks are emitted via `wl_keyboard.modifiers`.
- A stable per-client id (`Trampoline::clientIdOf` / addon `clientId`) associates
  the focused surface with the right client's input resources without exposing
  `wl_client` to JS.

Verified with `foot` and `kitty` (focus on map, type without a click). Not built:
client cursor surfaces (`set_cursor` is a no-op; no software cursor), touch,
multi-seat, key-repeat generation (repeat_info sent; client repeats), axis
source/discrete refinement. kbFocus is not auto-moved when the focused window
closes (re-resolves on next pointer event; guarded against destroyed surfaces).

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
are request-created. The configure handshake (`xdg_toplevel.configure`
empty-states → `xdg_surface.configure` serial → client `ack_configure`) works, plus
`set_title`/`set_app_id`. configure sends `states = [activated]` (the on-wire proof
of non-empty array encoding) and 0×0 (client picks size). See the WM-request no-ops
in "Read first".

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
chain). Currently bundled: `@overdraw/plugin-layout-master-stack`.

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
title/appId/activated — maximized/fullscreen/minimized/resized/parent are not
emitted (those `xdg_toplevel` requests are no-ops with no backing state); the
bus is ready for them.

**Pattern subscribe + plugin emit** (Phase 0a, `dynamic-bus.ts`): on top of
the typed bus, a dynamic, string-keyed event bus supports
`sdk.events.subscribe(pattern, cb)` (exact name or glob — `'workspace.*'`,
`'*'`) and `sdk.events.emit(name, payload)`. Core re-publishes the typed
bus's `CompositorEventMap` events into the dynamic bus so plugin
subscribers see them under the same names; plugins emit into their own
namespaces. This is the substrate the IPC server's `subscribe` /
`unsubscribe` methods route through.

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

- **Per-window state bag + hint setters** (Phase 0d,
  `packages/core/src/plugins/windows-sdk.ts` + `windows-broker.ts`):
  `sdk.windows.setFloating` / `setFullscreen` / `setMaximized` /
  `setMinimized` store opaque hint state (no behavioral change in core
  today; the WM is still a fixed tiler — see "Read first" silent-gap
  list). `setState(id, key, value)` / `getState` / `deleteState` is the
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
`test/layout-master-stack/`): `master-stack.test.js` (algorithm),
`integration.test.js` (driver + bundled plugin invocation end to end).
Snapshot / query: `query.test.js`. Config: `config.test.js`. Overlays /
decorations: `overlay.test.js`, `decorations.test.js`,
`decoration-zbind.test.js`. Events / windows brokers (Phase 0a/0d/0e):
`window-events.test.js` + `window-changes.test.js` (bus + observer +
coalescing, incl. a real Worker), `dynamic-bus.test.js` (pattern subscribe
+ plugin emit), `sdk-events.test.js`, `sdk-windows.test.js`,
`windows-broker-output-stack.test.js`. Namespace / actions registries
(Phase 0b/0c): `namespace-registry.test.js`, `sdk-namespace.test.js`,
`action-registry.test.js`, `sdk-actions.test.js`. IPC (Phase 1):
`ipc-protocol.test.js`, `ipc-server.test.js`. Plugin runtime:
`plugins.test.js` (real Workers + real fixture plugins:
live/failed/graceful-stop/watchdog-terminate/OOM/independence). Buffers /
wire / fds: `client-buffer-lifecycle.test.js`, `wire-barrier.test.js`,
`scm-rights.test.js`. Server-only smokes: `server.test.js`,
`trampoline.test.js`, `fd-passing.test.js`, `xdg-shell.test.js`, shared
`server-helpers.mjs`, one server lifecycle per file. No native build,
no GPU.

### State-query channel (`packages/core/src/query.ts`)

`queryState(state)` → `StateSnapshot`: output size, windows (surfaceId + rect +
title + app_id + role + mapped), back-to-front stack order, pointer/keyboard focus
ids. The analog of `hyprctl /activewindow`; attached as `state.query()`. The seam an
integration harness asserts against without pixels.

### Integration / GPU (`npm run test:gpu` → `node --test 'test/*.gpu.mjs'`)

Require GPU + host Wayland (auto-skip when `WAYLAND_DISPLAY` unset), run with
`--test-concurrency=1`. `test/harness.mjs` brings up GPU process + present loop +
server + protocols with input routed; `spawnClient` (resolves on the client's
"mapped" stdout line), `waitFor(query, pred)` (polls while yielding to libuv), and
`teardown()` that asserts no GPU process leaked (scan by exact comm
`overdraw-gpu-pr`). Synthetic input at two depths: `addon.injectInput` (straight
into the `InputSink`) and `addon.injectHostInput` (through the real
`WaylandInputBackend` normalization, round-tripping `wl_fixed_t`).

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
incl. `decoration-two-windows.gpu.mjs`, `example-decoration.gpu.mjs`).

### Protocol coverage matrix

- **Tested end-to-end**: `wl_compositor`, `wl_surface` (attach/commit/frame),
  `xdg_wm_base`/`xdg_surface`/`xdg_toplevel` (configure, title/app_id),
  `wl_shm`/`wl_shm_pool`/`wl_buffer` (pixel), `zwp_linux_dmabuf_v1`/
  `..._buffer_params_v1` (pixel), `wl_seat`/`wl_pointer`/`wl_keyboard` (focus +
  key delivery), `wl_output` (mode/geometry), `wl_callback`, `wl_data_device*`/
  `wl_data_offer` + `zwp_primary_selection_*` (clipboard round-trip),
  `wl_subsurface` (sync/desync, pixel), `xdg_popup`/`xdg_positioner` (pixel),
  `wl_data_device` DnD (full vertical).
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
`focus`/`output`; the launcher applies them. The `plugins` array is parsed,
validated, resolved, and consumed by the runtime (module paths resolve relative to
the config file's dir); bundled plugins (from
`packages/core/src/plugins/bundled.ts`) are resolved separately and load
first. The capability sub-grant schema is not yet validated (no
capabilities exist to grant).

## Not yet built (design only)

- **WM behavioral state.** Layout policy is a bundled plugin (master-stack
  tiler, Phase 2) — that piece is built. What is not: behavioral handling of
  the `xdg_toplevel` state requests (move/resize/maximize/fullscreen/
  minimize). The hint setters (`sdk.windows.setFloating` etc., Phase 0d)
  store opaque state and emit on the bus, but the WM and the bundled
  layout do not react to those hints. This is the gate for the `xdg_toplevel`
  WM-state silent-gap items in "Read first", and for any user-driven
  interactive move/resize/keybinding feature.
- **Focus policy still in core.** `follow-pointer`/`click-to-focus`/
  `focusOnMap` live in `packages/core/src/protocols/wl_seat.ts`, not in
  a plugin. Phase 3 extracts this into a bundled `'focus'`-namespace
  plugin per `build-order.md`.
- **`wl_output` reconfiguration + host-window resize.** See "Read first".
- **Display-driven frame clock.** See "Read first" and architecture.md.
- **Plugin SDK breadth.** Built: scope-B runtime + `sdk.gpu.createOverlay`
  + `sdk.window` observer + `sdk.decorations`; namespace registry + action
  registry + dynamic event bus (Phase 0); `sdk.windows` hint setters +
  state bag + snapshots + `setOutputStack` (Phase 0d/0e); IPC JSON-RPC
  server + `overdrawctl` (Phase 1). Not built: per-surface state
  primitives (opacity/mask/transform/output-margin per
  `core-plugin-api.md` §1, scheduled Phase 4a); `sdk.compose` /
  `sdk.transitions` (Phases 5, 8); animation evaluator (Phase 4); cursor
  / closing / velocity (Phase 9); input chain (`sdk.input.bind`, Phase
  7); output observation beyond a fabricated `wl_output`; protocol SDK
  surface; interactive-region hit-testing; `sdk.onFrame` (animation uses
  a plugin-driven loop today).
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
- **Crash recovery.** GPU-process respawn + state replay not implemented. A crash
  handler in the GPU process dumps a backtrace to `/tmp/overdraw-gpu-crash.txt`.
- **Linear compositing.** Alpha blending currently happens in sRGB space.
- **Phase 2 / Phase 3.** KMS/DRM, libinput, libseat, the session supervisor, and
  XWayland are untouched.
- **Live reload.** Not built.

## Spikes

Throwaway de-risking experiments live in `spikes/` (git-ignored); findings are
folded into architecture.md, the code is not part of the build.
