# overdraw — architecture

A Wayland compositor with a thin C++ core, a JS protocol/policy layer, and a
separate native GPU process running Dawn. Plugins are JS modules loaded as
worker threads inside the core; they use a granular internal SDK, not Wayland.

This document is the design. For what is actually built and proven so far
versus what is still design only, see `status.md`.

## Goals

- Wayland compositor. Phase 1 nested in a host Wayland session (the
  compositor appears as a window); phase 2 bare metal (DRM/KMS).
- Plugins are JS, run in-process as worker threads. A plugin code problem
  must not take down the compositor.
- Malicious plugins are out of scope. Containment targets accidental
  failures: logic bugs, hot loops, plugin OOM, GPU misuse, driver crashes.
- The C++ core is intentionally thin. Protocol semantics, window management,
  policy, and (most) protocol implementations live in JS.
- Wayland is the *external* protocol for normal clients (browsers,
  terminals, toolkit applications). Plugins do *not* use Wayland; they use
  an internal SDK.
- Run Wayland apps generally, **including** clients that present via a
  Vulkan/EGL swapchain on their `wl_surface` (Vulkan WSI), not only clients
  that submit shm/dmabuf buffers. WSI clients run (see `status.md` "Real
  clients run end-to-end"). The rendering section below describes only the
  buffer-submission path; its silence on WSI is not a decision to exclude it.

## Process topology

```
+----------------------------------------------------------+
| core process (C++ + Node)                                |
|   - libwayland-server (C++): wire, fds, object lifecycle |
|   - Protocol semantics + WM + policy (JS, mostly)        |
|   - Plugin workers (one Worker per plugin)               |
|   - libinput, libseat, DRM master  (phase 2)             |
|   - Dawn wire client (core's compositing device)         |
+----------------------------------------------------------+
                              | Dawn wire (unix socket)
                              | + side channel (SCM_RIGHTS)
+----------------------------------------------------------+
| GPU process (native, no JS)                              |
|   - Dawn (Instance + every Device: core + plugins)       |
|   - Dawn wire server                                     |
|   - GBM dmabuf allocator                                 |
|   - SharedTextureMemory / SharedFence (dmabuf + sync-fd) |
|   - KMS scanout (phase 2)                                |
+----------------------------------------------------------+
```

Two processes in v1: core and GPU. Phase 2 adds a small session supervisor.

### Core process

- C++ + Node. The N-API addon loads with the Node main script.
- C++ owns: `libwayland-server` integration (overdraw's *own* clients), fd
  handling (SCM_RIGHTS), DRM master / KMS / libinput / libseat (phase 2), the
  Dawn wire client for the core's own compositing device, and a generic
  protocol-trampoline surface that lets JS implement Wayland protocols.
  - **Phase 1 caveat:** the host output window's Wayland *client* connection
    lives in the GPU process, not the core (a `wl_surface` cannot be shared
    across processes; the surface and device live GPU-side). The core remains
    the Wayland *server* for overdraw's own clients and drives the host
    swapchain over the wire. See "GPU process". This refines the original
    framing of the core as "the Wayland client of the host."
- JS owns: protocol semantics, window management, focus policy, plugin
  registry, capability grants. Most protocols are implemented in JS;
  some hot or foundational ones may be in C++ (see "Protocol layers").
- Single owner thread (Node main) for the core's wire client, all
  `wl_resource`s, libuv, and the core's JS — including the per-output
  frame loop / compositing renderer. Plugin workers are separate V8
  isolates with their own event loops and their own wire clients.
- The renderer (per-output frame loop, compositing pass) runs on the
  main thread in JS, over the Dawn wire (IMPLEMENTED — see status.md
  "Compositing"; there is no C++ compositing pass). Running on the main thread is a v1 choice: it is a
  candidate for promotion to a dedicated worker thread (sharing the
  surface graph via `SharedArrayBuffer` + `Atomics`) if profiling shows
  GC pauses or protocol-traffic contention is hurting frame pacing.
  This is internal refactoring; neither the plugin SDK nor the Wayland
  protocol surface is affected. The decision waits until measurements
  on real workloads justify it.

### GPU process

- Native, no Node, no JS. Forked + exec'd by the core at startup.
- Owns Dawn (`wgpu::Instance` + every `wgpu::Device` — core's and one per
  plugin), the wire server, the GBM allocator, and KMS scanout (phase 2).
- On crash, the core respawns it and replays state (see "GPU process
  crash recovery"). In v1 the core does this directly; in phase 2 the
  session supervisor handles process lifecycle.
- **Phase 1 only: owns the host Wayland *client* connection used for output
  presentation.** A `wl_surface` is a client-side proxy bound to one
  `wl_display` connection and cannot be shared across processes by pointer;
  the `wgpu::Surface` is created from that `wl_surface` via
  `SurfaceSourceWaylandSurface`. Since the surface and the compositing device
  both live in the GPU process, the host output window's Wayland connection
  must live there too. The core's wire client drives the swapchain
  (`Configure`/`GetCurrentTexture`/`Present`) over the wire against that
  server-side surface (validated; see "Validated against Dawn"). Host input
  events arrive on this connection in the GPU process and are forwarded to the
  core over the side channel. Phase 2 (KMS) has no host window, so this is
  phase-1-specific.

### IPC

- **Dawn wire** over a unix socket per wire client (core + one per plugin
  worker). One `dawn::wire::Server` instance in the GPU process per
  connected client; no multiplexing layer. We provide the transport;
  Dawn provides `CommandSerializer`/`CommandHandler`.
  - **Flush policy:** Dawn batches wire commands in its `CommandSerializer`
    and flushes them to the socket on its own batch boundaries; an API call
    such as `queue.submit` does NOT by itself guarantee its commands are
    flushed to the wire. Code that needs commands committed (e.g. to sample a
    correct cumulative-bytes ordering serial, or to ensure a peer sees a
    command before a side-channel message that depends on it) must call an
    explicit `flush()` and only then read the serial. We also flush at
    wire-internal sync points (callback returns, buffer-map completions).
    Per-call flushes are not used.
  - **Backpressure:** fully non-blocking. All fds are `O_NONBLOCK`; a
    writer buffers what the socket can't take and drains on writable, so a
    write never parks (a single-threaded peer blocked in `write()` while the
    other waits to be read is a mutual deadlock). See status.md "IPC".
- **Side channel** unix socket(s) between the core and the GPU process.
  Built as two `SOCK_SEQPACKET` sockets — one for control (fixed-size tagged
  POD messages, `native/ipc/side_channel.h`), one dedicated to input — not
  the length-prefixed flatbuffers framing originally sketched. Fds attached
  via SCM_RIGHTS in the same `sendmsg`.
- The side channel is line-of-sight to the GPU process; plugin workers
  do *not* speak to the GPU process directly except via the wire. All
  control traffic goes through the core.

#### Why wire, not ctrl: the cross-fd ordering rule

**Load-bearing invariant.** The ctrl socket is for boot handshake and
out-of-band hard-kill ONLY. Once the wire is up, every GPU-process /
output / surface message rides the **wire** as a non-Dawn frame
(`FrameKind != 0`). New IPC messages MUST go on the wire by default;
adding a new ctrl tag is a code smell and needs a documented reason
falling under one of the carve-outs below.

**Why.** Wire and ctrl are two independent fds. The kernel orders bytes
within ONE fd (FIFO) but makes no ordering guarantees across two fds.
When a message on ctrl logically precedes a wire frame the recipient
relies on (e.g. ctrl tells the GPU "this surface buffer now exists";
the next frame on wire references it), the recipient may dispatch the
wire frame BEFORE the ctrl message and fail on the unknown reference.
This is the cross-fd race class. It bit M7 step 4 (`ScanoutReserve`
on ctrl raced `ProducerBegin` on wire — fixed by moving Reserve to
wire, commit `447a905`), then bit `ImportClientTex` (`m`/`M` tags moved
to wire as `kind=3`/`kind=4`), and the same hazard exists today for
every remaining ctrl tag that has a wire dependency.

Putting BOTH dependent messages on the wire makes the recipient
dispatch them in FIFO order by construction — no per-message
synchronization, no spin-pump, no buffering. The wire framing
(`[length:u32][kind:u8][payload]`) cleanly separates Dawn-byte frames
(`kind=0`) from control frames (`kind=1..N`), and SCM_RIGHTS attaches
to specific frames via `sendmsg`, so the wire can carry the SAME
messages ctrl carries with no loss of fidelity.

**Tags that legitimately stay on ctrl.** Three categories, all about
the wire NOT existing yet OR needing to outlive the wire:

1. **Pre-wire handshake.** `Hello` / `HelloReply` build the wire's
   peer configuration. They cannot ride a wire that hasn't been
   constructed.
2. **Wire fd passing.** `SetDrmFd` (drm card fd via SCM_RIGHTS, sent
   BEFORE Hello in KMS mode) and `AddWireConn` (passes the plugin's
   wire-connection fd) carry the very fds wire frames will travel on.
3. **Out-of-band lifecycle.** `Shutdown` and `OutputPause` /
   `OutputResume` are informational; they exist deliberately
   separated so a wedged wire can still be killed and so VT-switch
   pause cannot race the wire it is pausing.

Everything else SHOULD be on the wire. The repo is mid-migration: a
few tier-1 tags (output lifecycle, surface-buffer alloc/release,
`ReleaseClientTex`) still live on ctrl for historical reasons. New
work MUST NOT add to that list; new messages start on wire.

When in doubt, **wire by default**. Look at how `ScanoutReserve` /
`SwitchMode` / `ScanoutRebuild` / `ImportClientTex` are dispatched
(transport.h `FrameKind` + side_channel.h variable-length payload
helpers) and copy the pattern.

#### Side-channel message set (v1)

Core → GPU process requests:

- `Hello` — version handshake.
- `ProbeFormats` → `FormatsResult { entries: [{ format, modifier,
  usageOnPlugin, usageOnCore }] }` — sent once at startup. The modifier list
  must come from Dawn's `GetFormatCapabilities` + `DawnDrmFormatCapabilities`
  on a native (server-side) adapter, intersected with GBM via
  `gbm_bo_create_with_modifiers` — implicit GBM allocation is rejected by Dawn
  on NVIDIA (spike finding). `DawnDrmFormatCapabilities` is not available over
  the wire, so this probe is inherently GPU-process-side.
- `CreateCompositingDevice { descriptor }` → `{ deviceWireHandle }`.
- `CreatePluginDevice { descriptor }` → `{ deviceWireHandle }` — one per
  plugin Worker.
  - NOTE (spike finding): devices are not created by a side-channel request.
    Dawn has no `InjectDevice`; the device is created by the wire client over
    the wire (`RequestAdapter`/`RequestDevice` through an injected instance),
    and the GPU process resolves the native device via
    `WireServer::GetDevice(id, generation)`. These two messages are better
    modeled as "ensure a device exists at this wire handle" bookkeeping than as
    server-side device construction. See "Validated against Dawn".
- `DestroyDevice { deviceWireHandle }` → `{}`.
- `AllocateSurfaceBuffer { surfaceId, deviceWireHandle, format, width,
  height, reservedTextureHandle }` → `{ dmabufFd (SCM_RIGHTS), modifier,
  stride, offset, coreTextureHandle }`. Probe-checked combo.
- `ReleaseSurfaceBuffer { surfaceId, dmabufFd }` → `{}`.
- `BeginAccess { surfaceId, deviceWireHandle, textureHandle, oldLayout,
  newLayout }` → `{}` — before plugin renders into the texture. The Vulkan
  image-layout state (old/new) is required by Dawn's Vulkan backend (spike
  finding); it is not optional.
- `EndAccess { surfaceId, deviceWireHandle, textureHandle }` →
  `{ fenceFd (SCM_RIGHTS), endLayout }` — after plugin submits. Carries the
  resulting Vulkan image layout back for the next BeginAccess.
- `SetDrmFd { drmFd (SCM_RIGHTS) }` → `{}` — phase 2 only.
- `Shutdown` — clean termination.

GPU process → core events:

- `Hello` — handshake reply.
- `DeviceLost { deviceWireHandle, reason }` — deterministic device-lost
  notification.

Non-fatal errors and general diagnostics from the GPU process go through
the logging IPC sink (see Logging), not a dedicated event.

Notes:

- `BeginAccess`/`EndAccess` are explicit side-channel messages from the
  core, not transparent to the GPU process. The core knows when the
  plugin is about to present (via the plugin's `surface.present`
  postMessage); it issues `EndAccess`, collects the fence, hands it to
  the renderer. Before granting a fresh `getCurrentTexture()`, the core
  issues `BeginAccess`. Optimization to make this implicit on the wire
  is deferred.
- Buffer pools are built one buffer at a time. The SDK calls
  `AllocateSurfaceBuffer` lazily as it needs more pool slots and
  rotates through them.
- KMS-related side-channel messages (commit, page-flip) are not in v1.

## Plugin model

A plugin is a JS module. The core loads it in a Node `worker_threads`
Worker. Plugins are **not Wayland clients** and have no Wayland
connection. They use the overdraw SDK.

### Plugin module shape

A plugin is an ES module exporting an async `init` function:

```js
export default async function init(sdk) {
  const win = await sdk.window.create({ role: 'panel', size: { width: 400, height: 60 } });
  // ... set up GPU, register handlers, etc. ...
  sdk.onShutdown(async () => { /* optional cleanup */ });
}
```

- The Worker bootstraps the SDK (native bits + JS), constructs the SDK
  object scoped to the plugin's capabilities, dynamically imports the
  plugin module, and calls `init(sdk)`.
- Init resolving → plugin is "live"; watchdog starts; SDK events flow.
- Init rejecting → plugin marked failed for this attempt; restart policy
  decides whether to retry.
- Return value is ignored; everything is registered via SDK methods
  during init (`sdk.window.create`, `sdk.onShutdown`, event handlers).

### Lifecycle

- **Spawn.** Core forks a Worker per configured plugin, loads the SDK,
  awaits `init(sdk)`.
- **Live.** Plugin is running; watchdog pings; events delivered.
- **Graceful shutdown.** Core calls registered `onShutdown` callback,
  awaits its returned promise with a 2-second timeout. After resolve
  or timeout, terminates the Worker.
- **Forced shutdown.** Crash, OOM, watchdog termination → no callback
  runs; `worker.terminate()`. Core then tears down overdraw-owned
  resources (surfaces, wire handles, GPU device, side-channel state).

The core always handles tear-down of overdraw-owned resources, regardless
of how the plugin ends. The plugin's shutdown callback is only for
plugin-owned cleanup (files, network connections, etc.).

### Restart policy

Default: restart on failure, max 3 restarts in a 60-second window, then
give up. Plugin marked permanently failed for this session; user must
fix and restart the compositor. Init failure on first boot counts
toward the budget.

Per-plugin override in config:

```toml
[plugins.my-panel]
restart = "on-failure" | "never"
max_restarts = 3
window_seconds = 60
```

### Isolation

- Each plugin runs in its own V8 isolate. Logic errors, JS exceptions,
  hot loops, OOM-within-cap contained at the Worker boundary.
- Per-Worker `resourceLimits` (heap cap) bounds memory. An OOM throws
  inside that Worker, not the core.
- Watchdog: the core's main thread pings each plugin every N ms; K missed
  pongs → `worker.terminate()`. Catches hot loops and synchronously
  blocking work.
- Plugins cannot load native addons other than the SDK's. A custom
  Worker module loader rejects non-allowlisted native imports.

### Plugin SDK surface

The SDK is the entire API a plugin sees. Capabilities are enforced by
the *shape* of the SDK object handed to the Worker: methods outside the
plugin's grant are not present on the object. There is no in-band
capability check at call time — if the method exists, the plugin may
call it.

Top-level SDK shape (illustrative, names not final):

- `gpu` — standard WebGPU (`navigator.gpu` shape). Backed by a Dawn wire
  client. The plugin's `GPUDevice` lives server-side.
  - `gpu.getPreferredCanvasFormat()` returns `bgra8unorm` on Linux,
    matching `navigator.gpu.getPreferredCanvasFormat()`.
- `window` (tier 1) — create windows; each has a primary `surface`.
  See "Window and Surface" below.
- `output` (tier 2) — request output takeover. Returns a `Surface` that
  replaces the output's content. Receives input events directly.
- `capture` (tier 3) — subscribe to compositor-rendered thumbnails or,
  with sub-grant, raw window dmabufs (as `GPUTexture` handles).
- `input` — structured input events on the plugin's surfaces:
  `onPointerMove`, `onButton`, `onKey`, `onScroll`, etc. *Not* Wayland's
  `wl_pointer`/`wl_keyboard` shape.
- `protocol` (tier 4) — implement a Wayland protocol. The plugin
  registers a handler module for an interface; the core routes binds
  and requests from real Wayland clients to the plugin. Capability
  sub-grant lists which interfaces.
- `onShutdown(cb)` — register a graceful-shutdown callback.

### Window and Surface

A **Surface** is a persistent renderable: it has a current size, a
sequence of `GPUTexture` buffers over its lifetime (rotated through a
pool), placement, and input routing. It is *not* a `GPUTexture` — a
single surface has many textures over time.

A **Window** is a placement + role + input-routing container. Every
window has exactly one primary surface (`window.surface`). Tier 2 and
tier 3 SDK objects return surfaces directly (not in a window).

Surface API:

```js
surface.format;              // 'bgra8unorm' — read-only
surface.size;                // { width, height } — read-only, current actual size
surface.getCurrentTexture(); // GPUTexture at current size, render-attachment-capable
surface.present();           // hand the current texture to the compositor for display
surface.onFrame(cb);         // request a frame callback (rAF-shaped)
surface.createSubsurface({ position, size }); // see below
surface.destroy();
```

Window API:

```js
const win = await sdk.window.create({
  role: 'panel' | 'overlay' | 'background' | 'normal',
  size: { width, height },
  output: outputId | 'primary' | null,
  position: { x, y } | null,  // role-dependent; WM may override
});
win.surface;                  // the primary Surface
win.resize({ width, height }); // returns Promise<actualSize>
win.onResize(cb);             // (newSize) => {} — fires for any resize
win.onFocus(cb);              // (focused: boolean) => {}
win.onVisibilityChange(cb);   // (visible: boolean) => {}
win.destroy();
```

**Subsurfaces.** A subsurface is a child Surface attached to a parent
Surface, positioned relative to the parent. Created via
`parent.createSubsurface({ position, size })`. Mirrors Wayland's
`wl_subsurface`. Subsurfaces compose hierarchically (a subsurface can
itself have subsurfaces). Multiple subsurfaces of the same parent stack
in creation order; `subsurface.setStacking('above'|'below', sibling)`
reorders.

Subsurface sync mode:

- `sync = true` (default): subsurface `present()` is deferred until the
  parent surface commits. Atomic updates across parent + children.
- `sync = false`: subsurface commits independently of its parent.

### Surface lifecycle

**Resize.** Symmetric: compositor-initiated (WM, tiling layout, output
change) and plugin-initiated (`window.resize()`). The WM may reject or
adjust plugin-initiated resizes; the returned promise resolves to the
actual size granted. `onResize` fires on every actual resize regardless
of initiator.

The SDK transparently swaps the buffer pool on resize. The plugin's
next `getCurrentTexture()` returns a texture at the new size. Plugins
with size-dependent pipeline state subscribe to `onResize`.

**Pool generations.** When a surface resizes (or is destroyed), its
current pool is marked retired. Buffers from the retired pool continue
their in-flight GPU work; on completion they are released and the pool
is freed once empty. `present()` on a texture from a retired pool is a
no-op (logged warning). The plugin's wasted render is silently
discarded — the alternative (presenting a wrong-sized buffer for one
frame) is worse.

**Destroy.** `surface.destroy()` (or `window.destroy()`, which destroys
the primary surface and any subsurfaces) is synchronous from the
plugin's perspective: the SDK objects are immediately invalidated and
the compositor stops including the surface in compositing on the next
frame. Resource cleanup is asynchronous: the buffer pool drains as
in-flight GPU work completes, then dmabufs, textures, wire handles, and
side-channel state are released. The plugin doesn't observe this.

**Plugin termination.** Same flow as explicit destroy, applied by the
core to every surface owned by the dead plugin.

### Capability tiers

1. **Surface provider.** Panels, widgets, backgrounds, overlays. Get
   `window` + `surface` + `gpu` + `input` for their own surfaces.
2. **Output/region takeover.** "I own this output." Get `output` +
   `surface` + `gpu` + `input` for the taken output. On
   disconnect/crash the core reclaims the output and falls back.
   - **Input routing.** Per-output focus partitioning. Pointer events on
     the owned output go only to the plugin. Keyboard focus follows the
     seat's normal policy and may move between the plugin and other
     clients as the user moves between outputs. Takeover does not imply
     a session-wide keyboard grab. Cross-output input (global hotkeys)
     is a separate capability.
   - **Other clients on the owned output.** Their surfaces may remain
     visible if the plugin chooses (translucent overlay), but they
     receive no input while the plugin owns the output.
3. **Content capture / overview.**
   - **Compositor-rendered thumbnails (preferred).** Core renders each
     workspace into a downscaled offscreen texture and exposes it as a
     `GPUTexture` to the plugin via the wire. Cheap, lower-privilege.
   - **Raw per-surface forwarding (gate carefully).** Plugin receives
     the dmabuf-backed `GPUTexture` of each named window. Full-resolution
     access; equivalent to a screen recorder. "Malicious plugins out of
     scope" means the user is trusted to grant this deliberately, not
     that it is harmless.
4. **Protocol provider.** See "Protocol layers" below. Sub-grant lists
   the interfaces the plugin may implement. Overriding standard
   protocols (e.g. `xdg-shell`) requires explicit listing.

A plugin cannot inject GPU commands into the core's render pass; it
contributes buffers and policy. Shared-device drawing would forfeit
isolation and is out of scope.

### The producer/consumer primitive (one mechanism, two directions)

"Plugin renders on top" (tiers 1/2 contribution) and "plugin captures /
takes over" (tier 3, and tier-2 takeover) are the **same primitive run in
opposite directions**, not two subsystems. Building it once is the goal.

The primitive: a producer renders into its own ring of dmabuf-backed
buffers (2-3, dual-imported as `SharedTextureMemory` into both the
producer's and the consumer's device, see "Dmabuf-backed surfaces"); the
consumer samples the **most-recently-presented** buffer (latest-wins, drop
superseded); a `SharedFence` from the producer's `EndAccess` is waited on in
the consumer's `BeginAccess` (producer-done-before-consumer-read, on the GPU
timeline, no CPU handshake); the buffer the consumer is reading returns to
the producer's free pool once the consumer's sample submit completes. The
two sides run on their own frame clocks, **one frame pipelined**, on separate
`VkDevice`s. The cross-device dmabuf+fence handoff is verified in-process (see
status.md "Cross-device dmabuf + fence"); running the per-connection devices
*concurrently* (thread-per-connection) is designed but the GPU-process pump is
single-threaded today (see status.md "GPU process threading").

- **Contribution (forward):** plugin is producer, core is consumer. The
  core samples the plugin's latest presented buffer into its compositing
  pass and blends it over the scene (premultiplied; see "Compositing").
- **Capture / takeover (reverse):** core is producer, plugin is consumer.
  The core keeps *rendering* but redirects output from scanout into a
  capture ring; the plugin samples the core's latest presented frame as a
  texture. On full output takeover the plugin also becomes the thing that
  *presents* to that output (tier 2): core produces source frames, plugin
  composites + presents. This is the "reversed OffscreenCanvas": the core's
  composited output is an OffscreenCanvas the plugin samples, exactly as a
  plugin surface is an OffscreenCanvas the core samples.

Capture is **uniform over the surface graph**, not an API per renderable.
Everything the core draws is a `Surface` (client, plugin, and internal
targets are indistinguishable to compositing). Any *node* in that graph — a
single surface, a per-workspace composited target, a whole output, or
another plugin's surface — can be designated a capture target, meaning
"render this node into a `SharedTextureMemory` texture and publish a
per-frame ready+fence event stream for it." So the SDK is one
`capture(node, opts)` selector, capability-gated (tier 3 is the
gate-carefully tier; raw per-surface forwarding ~= a screen recorder), not
`subscribeWorkspace`/`subscribeOutput`/`subscribeWindow` as separate calls.

Two constraints keep "subscribe to anything" honest:

- **A node is only capturable if the core has a reason to render it into a
  texture.** Capturing something the core wasn't already rendering (e.g. an
  off-screen workspace) means adding a render pass + its cost; this is where
  per-node damage/dirty tracking matters (idle nodes reuse their last
  texture). Subscription is push-based: the producer renders on its own
  clock and posts one-way `capture.frame(subscriptionId, slot, fence)`
  events; the consumer samples the latest at its own tick. NEVER synchronous
  per-frame RPC (that risks blowing the frame budget on a dependency chain).
- **Ownership transfer is fence-gated, not message-gated.** A plugin asking
  the core to "stop rendering so I can take this texture" must receive the
  GPU-completion fence for the core's final submit (the existing
  `OnSubmittedWorkDone`/submit-serial), waited in the plugin's first
  `BeginAccess`. A CPU-side "acked" says nothing about whether the GPU is
  done — relying on it is the race.

A `getCurrentCoreTexture(node)`-style call returns the core's render target
for that node dual-imported into the plugin's device, **plus** the
completion fence — the source, not the scanout destination. (Sampling the
core's own workspace render target is the zero-copy form of capture: no
separate "capture texture" copy.) Note the source/destination distinction:
the output/scanout buffer is where pixels *land*; an overview animation
needs the workspace *as a source* to shrink, which is a different texture.

**Overview animation (worked example).** A workspace-overview plugin starts
exactly as the live desktop renders, then shrinks it and reveals other
workspaces. Snapshot form (cheapest, GNOME-style, recommended v1): capture
each workspace target ONCE at takeover (fence-gated), animate the frozen
textures entirely on the plugin's clock — zero per-frame core<->plugin
messaging, and "start exactly as core rendered" is automatic. Live form
(workspaces keep updating while shrinking): the core keeps re-rendering each
subscribed workspace and pushes frame events; the plugin re-samples; needs
per-workspace dirty tracking to be affordable. The seamless present handoff
between core-live and plugin-takeover (no dropped/duplicated frame at the
switch vblank) is a separate hard detail, distinct from the buffer sharing.

### First plugin milestone: generic plugin-composited surfaces

A concrete, buildable target that turns the producer/consumer primitive into a
real feature and is the foundation for decorations, overlays, panels, and HUDs
(all of which become thin policy bundles on top of it). Largely built (see the
build order below for what remains). The guiding shape: **the plugin requests, the core
decides authoritative geometry and allocates, the plugin populates.** A plugin
never invents surface sizes — it declares intent, the core computes the real
rect (only it knows the window's outer rect, output size, layout) and hands
back the truth; the plugin renders to what it is given. This mirrors the
existing surface-resize contract (`window.resize()` returns the actual granted
size; pool generations retire on resize — see "Surface lifecycle").

The milestone is the smallest end-to-end path: **one plugin produces one
surface that the core composites on top of the scene at a core-decided rect,
with input routed per the plugin's declaration.** Decorations follow by adding
"bound to a window's reserved edge insets" as the placement policy.

Three things the plugin tells the core (declarations / requests):

- **Overlay placement** (free-floating use): `createOverlay({ layer, anchor,
  size })` -> core returns the actual rect + the allocated surface. `layer` is
  the stack-layer (below); `anchor`/`size` are a request the core may clamp to
  the output.
- **Decoration insets** (window-bound use): `requestInsets(windowId,
  {top,right,bottom,left})` -> core reserves that edge space, recomputes the
  window's inner (content) rect, and returns the actual insets + the decoration
  surface rect granted (it MAY clamp/override — e.g. zero side insets when
  maximized). Insets flow plugin->core; resulting geometry flows core->plugin.
- **Interactive regions**: rects in surface-local coords tagged with semantics
  -- `move` (drag => interactive move), `resize:<edge|corner>` (=> interactive
  resize), `action:<close|maximize|minimize>` (=> core performs the WM action),
  `custom:<id>` (=> core forwards a click event to the plugin). The core
  hit-tests against these; anything interactive MUST be declared here because
  the core owns hit-testing (the renderer/shader is purely presentational).

What the core tells the plugin (events; all one-way, push, never per-frame RPC):

- **Window-state stream** (decoration use): created/destroyed, focus
  gained/lost, **resized (new outer + inner + decoration rects)**,
  maximized/fullscreen toggled, title/app_id changed. The plugin re-renders the
  affected decoration ONLY on these events (idle windows reuse their last
  buffer -- decorations are static between state changes).
- **Authoritative surface size** for each overlay/decoration surface, so the
  plugin allocates its buffer ring at the right dimensions and reallocates
  (pool-generation retire) on size change.
- **Frame ticks** (`surface.onFrame`) for surfaces that animate; static
  decorations need not subscribe.
- **Input events** for `custom:` regions and any input the surface accepts.

Surface ownership: core-allocated, plugin-populated. The core brokers the
dmabuf ring at the size it computed (the producer/consumer primitive, plugin =
producer); the plugin reserves texture handles and renders into them on its own
device; the core samples the latest presented buffer (fence-waited,
premultiplied) into its compositing pass at the rect + stack-layer it decided.

Minimal stack-layer model (new): an ordered set of layers the core composites
back-to-front -- e.g. `background < below < content < above < overlay`.
Client/plugin windows live in `content`; decorations bind just behind their
window's content; overlays pick a layer. This is the smallest generalization of
the current single flat `stack_` that lets "above/below content" be expressed
without a full layout engine.

New capability implied: a **decoration/surface provider** tier, distinct from
surface-provider (tier 1, "my own windows") and output-takeover (tier 2, "the
whole output"): "render surfaces bound to windows the core lays out (or to a
chosen layer), declaring insets and interactive regions." It carries a
capture-like privilege (the provider sees every window's title/state), so it is
gated deliberately like tier 3.

Build order (current state annotated): (1) the generic plugin-surface
producer/consumer primitive + `createOverlay` + the stack-layer model (prove one
animated overlay composites on top, end to end) — **BUILT** (status.md "GPU SDK",
"Stack layers + placement", "Cross-device dmabuf + fence"); (2) the window-state
event stream + `requestInsets` + interactive-region declaration + hit-test routing
— **PARTIAL**: the window-state stream + additive insets are built (status.md
"Core event bus + window-state stream", "Decoration provider"), but
interactive-region declaration + hit-test routing are NOT, and the currently-no-op
`xdg_toplevel` move/resize/maximize this step is meant to force into real behavior
remain no-ops (status.md "Read first: gaps in advertised protocols"); (3)
decorations as a thin policy bundle on top (bind a provider surface to each
window's reserved insets) — **BUILT** (status.md "Decoration provider"). Each later step is
small once (1) is generic.

### First decoration milestone (scoped to avoid throwaway work) — BUILT

Server-side window decorations drawn by a plugin. Built end to end (see status.md
"Plugins" → "Decoration provider"). Scoped deliberately narrow to avoid building
anything the (undesigned) WM/layout model would force a rewrite of:

- **Decoration-provider registration by `app_id` regex.** A plugin registers as a
  decoration compositor with a regex matched against a window's `app_id` (the
  Wayland field set via `xdg_toplevel.set_app_id`). On map, if the regex matches,
  that plugin gets to decorate the window. If multiple registered plugins match,
  the FIRST registered to match wins (deterministic, registration order).
- **Fixed size — no `xdg_toplevel` geometry.** v1 uses the window's AS-MAPPED
  content size and does NOT send the client any configure/resize. This keeps
  decorations decoupled from the no-op `xdg_toplevel` resize/maximize path
  (status.md "Read first: gaps in advertised protocols"), which must NOT be implemented until the WM/layout
  policy is designed — otherwise that work is throwaway. Real resize/maximize +
  `xdg_toplevel` geometry is explicitly deferred to the layout-model milestone.
- **Additive insets (outer grows, content unchanged).** `requestInsets(windowId,
  {top,right,bottom,left})` makes the window's OUTER rect = the as-mapped content
  rect GROWN by the insets; the content rect stays the as-mapped size and the
  client is never told anything (it rendered NxM and still does). The decoration
  surface occupies the inset border region around the content. This is distinct
  from the eventual "insets shrink content within a fixed outer" form, which needs
  client configure (the deferred geometry work). The core still decides/clamps the
  granted insets and returns them.
- **Compositing order is free.** Decoration surface and content occupy (mostly)
  disjoint regions, so the core may composite decoration-then-content or
  content-then-decoration; the decoration binds to a stack layer just behind/
  around its window's content.
- **Window-state events:** `onMap` / `onUnmap` / `onChange` (the last carrying
  title/app_id/activated; see status.md "Core event bus + window-state stream").
  Resize-driven re-decoration is deferred with the layout/geometry work (the size
  is fixed, so a decorated window is otherwise static after map).
- **`xdg-decoration` negotiation deferred.** v1 does NOT negotiate server- vs
  client-side decorations, so a client that draws its own CSD would get BOTH its
  CSD and the plugin frame. Acceptable for v1 (target `app_id`s known to be
  server-decoration-friendly); proper `xdg-decoration` (tell the client "server
  decorates, don't self-decorate") lands with the layout/geometry milestone.

The new capability is the **decoration/surface-provider tier** noted above
(sees every matched window's `app_id`/state, so gated deliberately like tier 3).
The decoration surface itself is the existing producer/consumer ring (the same
machinery `createOverlay` uses), just placed at a window-relative inset rect
instead of a free overlay rect.

## Wayland protocols: implementation layers

Wayland is the compositor's external API. Real clients (browsers,
terminals) connect over a unix socket, speak the protocol, and the core
dispatches to whichever implementation is registered.

### Three layers

1. **C++.** Built-in handler in the core's native addon. Used selectively
   for hot or foundational protocols. Compile-time. Typical workflow:
   prototype in core JS, profile, promote to C++ only if profiling shows
   it matters. The override semantics make this migration transparent to
   any other code.
2. **Core JS.** JS handler module loaded by the core at startup.
   Runtime-registered; live-reloadable.
3. **Plugin JS.** Handler registered by a plugin via `sdk.protocol`.
   Runtime-registered; live with the plugin.

Higher layer overrides lower at bind time: when a client binds an
interface, the highest-layer current handler wins. Lower layers stay
registered but dormant.

### Conflict and override semantics

- Within a layer, second registration of the same interface throws.
  First load order wins. The conflicting load fails with a clear error.
- Across layers, higher wins. C++ may register and be silently
  overridden by core JS or a plugin (with capability).
- Resources bound while an override is active stay on that handler
  until disconnect, even if the override is removed. New binds go to
  the now-highest handler.

### Layer gating

The three layers are not selectable via an argument. Each layer has its
own register function, bound at a different point in the C++ addon, and
exposed only to code at that layer:

- **C++ layer.** Registration is native-only. Not exposed to JS at all.
- **Core JS layer.** A register function on the core's N-API object,
  accessible only to the core's main-thread JS. Plugin Workers do not
  have this object in scope.
- **Plugin JS layer.** A register function on the plugin's
  `sdk.protocol` object. Different function symbol, internally tagged
  as the plugin layer with the plugin's identity.

A plugin cannot register at the core-JS layer; the function isn't on
its scope. A plugin's `sdk.protocol.implement` is the only protocol-
registration entry point it ever sees, and it's gated by the `protocol`
capability being present at all.

#### Plugin sub-grants

The `protocol` capability has a sub-grant listing which interfaces the
plugin may implement:

```toml
[plugins.my-shell.capabilities]
protocol = { interfaces = ["xdg_shell", "my_custom_protocol_v1"] }
```

- Overriding a *standard* protocol (any interface already implemented at
  the C++ or core JS layer) requires that interface name in the list.
- Claiming a *plugin-defined* protocol (interface name not yet seen by
  any layer) is allowed if the name appears in the list. There is no
  bare "any new protocol" grant; new protocols must still be listed by
  name so config inspection shows what the plugin will claim.
- `"*"` is supported but discouraged; the user must type it deliberately.

### Generic C++ trampoline

The C++ side does *not* contain per-protocol code, except for the
protocols deliberately implemented at the C++ layer. For everything
else, C++ exposes a generic surface:

- `core.protocol.registerInterface(name, version, signatureMetadata)` —
  registers a `wl_interface` with libwayland-server using metadata
  constructed at runtime from the JS layer's protocol descriptors.
- Incoming requests: libwayland decodes the typed args; the C++
  trampoline forwards them to the registered JS handler. Args are
  passed as a typed tuple (ints, fixed-point, strings, arrays, object
  handles, fd handles) — JS does not see raw wire bytes for incoming
  traffic.
- Outgoing events: JS calls a generated event sender; the C++ side
  converts the typed args to a `wl_argument` array and calls
  `wl_resource_post_event_array`.
- Fds: stay in C++. JS sees integer handles. Requests with fds: C++
  receives the fd, allocates a handle, passes the handle to JS. JS
  passes the handle back into the SDK / core APIs when it wants to use
  the fd (import as dmabuf, register as shm pool, etc.).
- `wl_resource` lifetime is C++-owned. JS holds weak handles. Resource
  destruction notifies JS.

Adding a Wayland protocol means: drop in a JS module that declares the
interface signature (parsed from XML by the generator) and implements
the request handlers. No C++ rebuild. The interface metadata is
registered with libwayland at first use.

### Generator (XML → JS)

A script parses Wayland XML and emits, per interface, a JS module
containing:

- Interface signature (request/event tables with arg types, enum values,
  since-versions).
- Event sender helpers callable from JS handler code:
  `iface.events.send_configure(resource, serial)` etc.
- A handler interface definition (TypeScript-style, optional) for IDE
  support.

The handwritten part per protocol is the *handler module* implementing
the requests. The generator emits no C++.

### Live reload

- **JS handler reload.** File watcher on handler modules. On change:
  drop the relevant `require.cache` entry, re-`require`, re-register
  the implementation. Existing resources stay on the prior handler
  until disconnect; new binds use the reloaded handler.
- **Module-level state.** Lost on reload. Handler modules should keep
  long-lived state in a separate, non-reloaded module.
- **C++ protocol changes.** Require a core restart. Rare, since most
  protocols are pure JS.

## Plugin → core internals

Plugins talk to the core via the SDK, which uses three transports:

1. **Same-process JS calls.** Most SDK methods are direct calls into
   core-side JS via per-Worker `postMessage`. See "Worker ↔ core message
   protocol" below.
2. **Dawn wire.** WebGPU commands. Each Worker has its own wire client
   talking to the GPU process directly over a unix socket. The core
   does not see these commands.
3. **Side channel via core.** Plugin asks the core to allocate a
   surface; core asks the GPU process; GPU process allocates dmabuf
   and injects textures; core hands the plugin the wire handles for
   its `GPUTexture`. The plugin never sees the dmabuf fd.

The SDK in the Worker wraps all of this as a uniform JS API. The
plugin author writes WebGPU + SDK calls; the transport choices are
implementation detail.

### Worker ↔ core message protocol

Bidirectional. Three message kinds, same envelope shape both directions:

```
{ kind: 'request',  id, method, params }
{ kind: 'response', id, result }       // or { id, error }
{ kind: 'event',    name, data }
```

Either side may originate any kind. Requests carry an originator-
generated ID; responses echo it back; the originator's pending-promise
table resolves/rejects. Events are one-way (no response expected, no
ID).

The SDK builds a promise-shaped API on top of the request/response
half. Events stay as subscriber callbacks (`surface.onFrame(cb)`); they
do not become promises.

### Method enumeration (v1, illustrative)

Plugin → core requests:

- `window.create(opts)` → `{ windowId, surfaceId, size }`
- `window.resize(windowId, size)` → `{ size }` (actual granted)
- `window.destroy(windowId)` → `{}`
- `surface.allocateBuffer(surfaceId, wireHandle)` → `{ wireHandle, size }`
- `surface.present(surfaceId, wireHandle, fenceFd)` → `{}`
- `surface.createSubsurface(parentSurfaceId, opts)` → `{ surfaceId }`
- `surface.setSubsurfaceSync(surfaceId, sync)` → `{}`
- `surface.setStacking(surfaceId, mode, sibling)` → `{}`
- `surface.destroy(surfaceId)` → `{}`
- `output.takeover(outputId)` → `{ surfaceId, size }`
- `output.release(outputId)` → `{}`
- `capture.subscribe(opts)` → `{ subscriptionId }`
- `capture.unsubscribe(subscriptionId)` → `{}`
- `protocol.implement(interfaceName, version)` → `{}`
- `protocol.postEvent(resourceId, opcode, args)` → `{}`

Core → plugin events:

- `window.{resized, focus, visibility}(windowId, ...)`
- `surface.{frame, bufferReleased}(surfaceId, ...)`
- `input.{pointerMove, pointerButton, scroll, pointerEnter, pointerLeave,
   keyDown, keyUp, focusGained, focusLost}(surfaceId, ...)`
- `capture.frame(subscriptionId, surfaceId, wireHandle)`
- `protocol.{bind, request, destroy}(interfaceName, resourceId, ...)`
- `gpu.deviceLost(deviceId, reason)`
- `shutdown()`

Out of scope for v1 but worth a future pass: review compositor extension
APIs from sway, hyprland, niri, KWin scripting, GNOME Shell extensions,
river. The protocol shape should be revisited once real plugins exist.

## Crash isolation and recovery

| Failure                                  | Contained by                       | Recovery                                                            |
|------------------------------------------|------------------------------------|---------------------------------------------------------------------|
| Plugin JS exception                      | Worker boundary                    | Caught by SDK; logged; plugin continues                             |
| Plugin OOM within heap cap               | `resourceLimits`                   | Worker throws; plugin may continue                                  |
| Plugin OOM exceeding cap                 | `resourceLimits` aborts Worker     | Core sees Worker death; restarts per config                         |
| Plugin hot loop                          | Watchdog                           | `worker.terminate()`; restart per config                            |
| Plugin "bad" WGSL                        | Tint validation                    | Plugin gets a JS error; no GPU effect                               |
| Plugin GPU misuse caught by validation   | Dawn validation                    | Plugin's device emits error; surface stays last-known-good          |
| Plugin shader hang                       | GPU watchdog (TDR/hangcheck)       | Plugin's `wgpu::Device` lost; SDK requests new device; recovers     |
| GPU-wide reset                           | Hardware                           | All devices lost; core + each plugin re-request                     |
| GPU process crash                        | Process boundary                   | Core respawns GPU process; replays state (see below)                |
| Core crash                               | Not contained                      | Session ends (v1); supervisor restarts (v2)                         |

WebGPU's design (validation + Tint shader checks + robust buffer access)
prevents most plugin GPU misuse from reaching the driver. Driver crashes
from valid usage are rare but possible; the GPU process contains them.

One GPU process serves all devices. A driver bug triggered by plugin A's
GPU usage will device-lost everyone simultaneously, then everyone
recovers. Deliberate trade vs. one-GPU-process-per-plugin.

## GPU process crash recovery

State the core retains, CPU-side, so it can be replayed to a fresh GPU
process:

- Device descriptors (per device: features, limits, label).
- Core compositing shader source (WGSL) and pipeline descriptors.
- Per-surface allocation state: format, modifier, size, current pool
  contents (dmabuf fds, wire handles, attached state).
- Imported dmabuf fds for client buffers (held by core, never GPU-process-
  exclusive).

Recovery sequence:

1. Core's wire client(s) disconnect; SDK in each plugin worker sees its
   `GPUDevice.lost`.
2. Core respawns GPU process. Hands DRM fd via SCM_RIGHTS (phase 2).
3. Core replays its own compositing device + pipelines over the new wire.
4. Per surface: core re-requests dmabuf-backed render targets (re-using
   existing dmabuf fds, re-importing into the new devices) and
   re-injects textures so plugin wire handles resolve again.
5. Core sends `wl_buffer.release` for every outstanding client buffer.
   `wl_buffer` objects survive (they're protocol-level); clients
   re-attach on their next frame, re-importing into the new device.
6. Plugin workers' SDK requests new `GPUDevice`s, re-creates plugin
   pipelines. Plugins can subscribe to a device-lost callback to
   re-create their own JS-side resources (uploaded textures, etc.).
7. Display: between (1) and (6), KMS keeps showing the last committed
   buffer (phase 2), or the host compositor shows the last presented
   frame (phase 1). ~200–500 ms freeze acceptable.

Crash-loop guard: N crashes in M seconds → core gives up and exits.
v2 supervisor catches the core's exit and surfaces failure to user.

## Rendering and buffer interop

### Exposing WebGPU to JS: wire-retargeted `dawn.node` (DECISION)

Both the core compositing renderer (which the design puts in JS — see "Core
process") and the plugin SDK `gpu` need the same thing: a JS WebGPU
implementation whose objects are backed by a Dawn **wire client** (the device
lives in the GPU process). Decision: **use Dawn's own `dawn.node` bindings,
retargeted onto the wire client**, rather than hand-writing a WebGPU shim.

Rationale (verified, not assumed): `dawn.node`'s ~60 `GPUxxx` object bindings +
the WebIDL-generated interop layer dispatch entirely through the Dawn proc
table, so they are backend-agnostic and work unchanged over the wire. The only
native coupling is the bootstrap (proc-table selection + instance/adapter
creation), which is small and localized. So the large per-object binding surface
is free; only the bootstrap is forked.

Mechanism:

- The proc table is process-global and set to `dawn::wire::client::GetProcs()`.
  There is **no native Dawn in the core process** — it all lives in the GPU
  process. So the core renderer and every plugin worker share the one wire proc
  table; this is consistent (all of them target the GPU process over a wire).
- The host application brings up the wire instance/device (the existing
  reserve-instance → side-channel inject → `RequestAdapter`/`RequestDevice`
  handshake) and hands `dawn.node` the resulting handles. The fork adds
  `wrapDevice(instanceHandle, deviceHandle)` and `wrapTexture(deviceHandle,
  textureHandle)` entry points (wrapping host-provided wire handles), and an
  `AsyncRunner` that pumps a `wgpu::Instance`. A wrapped device is *borrowed*
  (its destructor does not `Destroy()` it).
- Non-wire-propagatable resources stay native and are exposed to JS as wrappable
  handles: dmabuf import (`SharedTextureMemory` reserve/inject) becomes a native
  `createTextureFromDmabuf(...) -> handle` that JS wraps via `wrapTexture`; shm
  pixels are exposed as a zero-copy external `ArrayBuffer` over the client
  mapping for `queue.writeTexture`; the swapchain `GetCurrentTexture`/`Present`
  stay native. The rule: *normal wire WebGPU ops happen in JS; only the
  non-wire-propagatable bits are native calls returning wrappable handles.*

Lifetime constraint (load-bearing): JS WebGPU object finalizers run at process
exit and call into the C++ wire client, so **the wire client must outlive the JS
GPU objects** — the host marks the client shared-with-JS and, on teardown,
`Disconnect()`s but leaks it rather than freeing it (a use-after-free / crash
otherwise). The wire pump must also run inside an N-API `HandleScope` once JS
WebGPU shares the connection (it can resolve `dawn.node` promises).

Packaging: the `jhanssen/dawn` fork's release build ships `dawn.node` alongside
the wire libs from one commit (ABI must match the host's wire client). The
node-binding link must hide static-archive symbols (`-Wl,--exclude-libs,ALL`) so
the bundled abseil does not interpose with the abseil inside V8/Node.

See `status.md` for what is built/proven: the core compositing pass runs entirely
in JS over the wire (shm + dmabuf + nested present); the C++ compositing pass has
been removed. `wrapTexture` + the dmabuf import/release + fence machinery are the
same primitives the plugin `Surface` rings will use.

### Dmabuf-backed surfaces, end to end

Used for both plugin surfaces and real Wayland clients (via
`linux-dmabuf-v1`). No shm path.

**Plugin surface allocation (first frame or after present):**

1. Plugin SDK in the Worker calls
   `wireClient.ReserveTexture(device, descriptor)` → returns
   `ReservedTexture { texture, handle, deviceHandle }`. Client-side
   proxy; no server allocation yet.
2. SDK sends `handle` + descriptor + format + modifier to the core via
   `postMessage`.
3. Core forwards the allocation request to the GPU process over the
   side channel.
4. GPU process:
   - Allocates a dmabuf via GBM with the requested `(format, modifier)`.
     Probed at startup: must support `RenderAttachment` on the plugin's
     device and `TextureBinding`/`CopySrc` on the core's device.
   - Imports the dmabuf into both devices as `SharedTextureMemory`
     (feature `SharedTextureMemoryDmaBuf`).
   - Creates a `wgpu::Texture` on each device.
   - `wireServer.InjectTexture(pluginTex, handle, deviceHandle)` so the
     plugin's reserved handle now resolves server-side. Same for the
     core's texture handle.
   - Returns to the core (via side channel + SCM_RIGHTS): dmabuf fd,
     modifier, stride, offset, core's wire handle.
5. Core registers the surface internally (an opaque overdraw `Surface`
   object — *not* a `wl_surface`; plugins don't create those). Tracks
   the dmabuf fd for the core's own buffer recycling logic.
6. Plugin renders into the `GPUTexture` returned by
   `surface.getCurrentTexture()`.

**Per frame after first:**

7. Plugin SDK submits via the wire; commands reference the reserved
   `handle`; the wire server resolves to the dmabuf-backed `wgpu::Texture`.
8. GPU process does `EndAccess` on the `SharedTextureMemory`, gets a
   `SharedFence` sync-fd. Sends sync-fd to core via side channel.
9. SDK calls `surface.present()` → posts to core via `postMessage`:
   "surface X, buffer Y ready, fence Z."
10. Core's next frame snapshot picks up the new buffer + fence. Core
    composites (phase 1: into swapchain) or hands buffer + fence to
    KMS (phase 2).
11. When the buffer is no longer in flight, core releases it back to
    the SDK pool. SDK rotates to the next slot (2–3 buffers per
    surface).

**Why we use `ReserveTexture`/`InjectTexture` rather than passing
`SharedTextureMemory` over the wire.** Dawn explicitly marks
`SharedTextureMemory` / `SharedFence` as not propagated over the wire
(see `src/dawn/wire/SupportedFeatures.cpp`). They're for server-side
embedder use only. Reserve/inject is Dawn's supported mechanism for
exposing a server-allocated texture to a wire client — Chrome's GPU
process uses this pattern for swap-chain textures.

### Validated against Dawn (spike findings)

The GPU-interop path was exercised against a real Dawn build (the wire-enabled
fork, Vulkan backend) on NVIDIA RTX 5060 / proprietary driver 595.71.05.
Verified facts and the constraints they impose:

- **GBM dmabuf → `SharedTextureMemory` import works on NVIDIA proprietary.**
  Single-process round trip (GBM alloc → import → render → read back) produced
  correct pixels for RGBA8/BGRA8. The dmabuf interop premise holds on the
  hard-case driver, not just Mesa.
- **Modifier negotiation is mandatory.** Naive GBM allocation yields an
  NVIDIA block-linear modifier Dawn rejects on import. The startup probe MUST
  query `wgpu::Adapter::GetFormatCapabilities` chained with
  `DawnDrmFormatCapabilities` to get the importable modifier list, then call
  `gbm_bo_create_with_modifiers` constrained to that list. Implicit allocation
  is not viable.
- **`DawnDrmFormatCapabilities` is NOT exposed over the wire** (it is in the
  wire's feature deny list). Consequence: the modifier probe runs only on a
  **native server-side adapter** in the GPU process — the wire client/device
  cannot perform it. This is consistent with the design (GBM allocation and
  STM import already live server-side); the client never needs it.
- **`SharedTextureMemoryDmaBuf` and `SharedFenceSyncFD` ARE exposed over the
  wire** (`Adapter::HasFeature` true), so a wire client can request a device
  capable of using injected dmabuf-backed textures.
- **Vulkan requires image-layout state chained into BeginAccess/EndAccess.**
  `SharedTextureMemoryVkImageLayoutBeginState` (oldLayout/newLayout) must be
  chained into the BeginAccess descriptor and `...EndState` into the EndAccess
  state, or access validation fails. The side-channel BeginAccess/EndAccess
  messages must therefore carry Vulkan image-layout state, not just the fence.
- **`SharedFenceSyncFD` fences are produced** on EndAccess (fenceCount=1),
  confirming the cross-process fence mechanism the frame loop depends on.

Wire-topology facts (cross-process spike, partially validated):

- **There is no `InjectDevice`/`ReserveDevice`.** The plugin/core device is
  created by the wire client over the wire via `RequestAdapter` →
  `RequestDevice` through an injected instance (`InjectInstance`); the GPU
  process fetches the resulting native device via `WireServer::GetDevice(id,
  generation)` to build the shared texture on it. `RequestAdapter` and
  `RequestDevice` over the wire are confirmed working cross-process.
- **`WireServerDescriptor.useSpontaneousCallbacks = true` is required** or
  request-device (and similar) callbacks never fire over the wire.
- **Inject/reserve handles must agree on generation.** The server must
  `InjectInstance` at exactly the handle the client's `ReserveInstance`
  produced (learned via the side channel), including generation — not a
  guessed value.
- **Wire-client callbacks fire only during `wgpuInstanceProcessEvents`** on
  the client's wire instance (with `CallbackMode::AllowProcessEvents`); the
  client event loop must pump it.

Phase-1 presentation facts (cross-process spike, validated end-to-end on
NVIDIA RTX 5060 / proprietary driver 595.71.05 / Vulkan backend, host Wayland
session):

- **The Wayland-backed swapchain works over the wire.** A wire *client* can
  drive a `wgpu::Surface` whose `Surface` and `Device` live in the wire
  *server*: `Surface::Configure`, `GetCurrentTexture`, render-pass submit, and
  `Present` all propagate over the wire and produce visible frames in the host
  window. 240/240 frames presented over the wire.
- **`ReserveSurface`/`InjectSurface` exist and mirror the texture
  reserve/inject pattern.** The client calls
  `WireClient::ReserveSurface(instance, capabilities)` → `ReservedSurface
  { surface, instanceHandle, handle }`; the server creates the native
  `wgpu::Surface` and calls `WireServer::InjectSurface(surface, handle,
  instanceHandle)` at that handle. Generation must match, as with instances.
- **The host output window's Wayland connection must live in the GPU
  process.** `SurfaceSourceWaylandSurface` takes raw `wl_display` + `wl_surface`
  pointers; a `wl_surface` is a client-side proxy bound to one connection and
  is not shareable across processes. Because the surface/device are GPU-side,
  the host Wayland *client* connection is GPU-side too (phase 1 only). This
  refines the original "core is the Wayland client of the host" framing; see
  "GPU process" and "Core process".
- **`SurfaceCapabilities` for `ReserveSurface` come from the server.** The
  native side queries `Surface::GetCapabilities` against the underlying adapter
  and ships format/present-mode/alpha-mode + size to the client over the side
  channel; the client uses them to `Configure`. (In the spike the reservation
  itself accepted an empty caps struct since it only allocates a handle.)

The reserve-texture / inject-texture handshake (server injecting the
dmabuf-backed texture at the client's reserved handle, producer rendering into
it) — flagged as "not yet validated" in the original spike — is now implemented
and pixel-verified end to end, both for real client dmabufs and for the plugin
overlay producer (status.md "Client buffers" → "dmabuf", "GPU SDK").

### Real Wayland client buffers

Standard `linux-dmabuf-v1` flow: client passes dmabuf fd via SCM_RIGHTS;
core (in C++) holds the fd; protocol handler (in JS) calls a core API
to import via the GPU process (`SharedTextureMemory` on the core's
device); resulting wire handle is associated with the `wl_buffer`.
Compositing samples from this texture.

### Compositing

- One render pass per output per frame. Phase 1 renders into the
  swapchain texture obtained via `Surface::GetCurrentTexture` on the
  Wayland surface source; phase 2 renders into a GBM-backed texture
  imported as `SharedTextureMemory`, then hands it to KMS.
- Color space in v1: sRGB throughout, premultiplied alpha for all
  surfaces.
- Compositing pipeline: textured-quad-per-surface with optional opacity,
  applied transform (rotation/scale/translation), and per-surface
  fractional-scale handling.
- No effects in v1 (no blur, no shadows). The pipeline is structured to
  permit them later by allowing intermediate render targets between
  surface sampling and final output.

### Frame loop

Per output:

```
on frame trigger
    (phase 1: host wl_surface.frame callback)
    (phase 2: KMS page-flip event):
  snapshot committed state for all surfaces visible on this output
  for each surface:
    if a new buffer + fence arrived: queue wait on fence
  build render pass: draw surfaces back-to-front
  submit to GPU (via wire)
  on submit completion (or via OUT_FENCE in phase 2):
    phase 1: nothing more — Vulkan swapchain present handled by Dawn
    phase 2: KMS atomic commit with IN_FENCE_FD = our submit fence
  request next frame trigger
  send wl_surface.frame callbacks to clients that requested them
```

Plugin surfaces participate in this loop exactly the same way real
Wayland surfaces do — the compositing layer sees both as overdraw
`Surface` objects with a current `wgpu::Texture` handle. The
origin (plugin vs. Wayland client) is invisible to compositing.

#### Frame clock: the trigger must originate at the display

The loop is **event-driven off a display-side completion signal, NOT a
timer.** The clock originates where the display lives (the GPU process — the
host `wl_surface` in phase 1, the KMS connector in phase 2) and is propagated
to the core; the core does not invent its own cadence. A core-side fixed timer
(e.g. a 16ms `uv_timer`) is wrong: it has no causal link to the display's
refresh, so it beats against the real vsync (render frames the display never
shows = waste/stutter; render late = jank; and under direct KMS it risks
tearing/stalls). See status.md for the current implementation's divergence from
this (it uses a timer today — a known shortcut, because Dawn's phase-1 WSI
swapchain hides the host frame callback).

- **Phase 2 (clean):** the GPU process owns KMS, so it directly receives the
  DRM page-flip event. On page-flip it emits a side-channel `FrameDone` event
  (vblank time, freed ring slot) to the core. The core's loop wakes on that
  event → snapshot → render into the next ring slot over the wire → send
  `Present { slot }` → GPU process commits. No timer. (`FrameDone`/`Present`
  are the commit/page-flip side-channel messages noted as "not in v1" above;
  they are the phase-2 frame clock.)
- **Phase 1 (entangled):** Dawn's WSI swapchain owns `Present` and hides the
  host `wl_surface.frame` callback, so the trigger above is not directly
  available. Options: present FIFO so `GetCurrentTexture` blocks on host vsync
  (rejected once — a blocking acquire on the GPU process's single command
  thread stalled all other wire work; would need the acquire off that thread),
  or present via our own `wl_surface` instead of Dawn's WSI so we can register
  the frame callback explicitly. Until resolved, phase 1 uses the timer
  shortcut (status.md).
- **Plugin pacing:** the core fans the frame trigger out to plugin workers as
  `surface.onFrame` postMessage ticks (the rAF analog). The core's own
  compositing loop gets the trigger directly over the side channel (no extra
  hop); plugins take one postMessage hop and may slip frames (reuse last
  buffer), which is acceptable per "Frame pacing and threading".

### Multi-output

- One compositing pass per output. Separate output textures, separate
  KMS commits in phase 2.
- A surface visible on N outputs is composited N times (once per pass,
  with per-output scale/transform). The GPU samples the same dmabuf-
  backed texture each time; no extra copy.
- Per-output frame triggers run independently. Different refresh rates,
  scales, and rotations are first-class.
- Plugin surfaces declare their target output(s) via the SDK; the
  compositor honors per-output frame timing for their `onFrame`
  callbacks.

### Damage tracking

Not implemented in v1. Full redraw every frame. The architecture leaves
room for damage:

- Wayland clients already send `wl_surface.damage_buffer`; the protocol
  handler stores it but the compositor ignores it.
- Plugin SDK accepts a damage region argument to `present()` (currently
  ignored).
- Adding damage later means: track per-surface damage region per output,
  intersect into a per-output damage region, use as scissor in
  compositing, hint to KMS via `wp_presentation_feedback` / damage
  properties.

### Compositor-side surface transforms (v2)

Per-surface transform state (translate, scale, opacity, fade timing)
applied by the core each frame without requiring a new commit from the
producer. Enables smooth window-open / workspace / dock animations
without the producer in the per-frame loop. Not in v1.

## Cursor

- v1: software cursor. Compositor draws the cursor as a textured quad on
  top of every output's render pass. Cursor position updated on
  pointer-motion events. Acceptable latency for nested mode.
- v2: hardware cursor. Allocate a dedicated GBM cursor buffer, assign to
  a KMS cursor plane, update plane position on pointer motion. Software
  fallback when the active cursor image isn't compatible with the
  cursor plane's constraints (size, format).

## Frame pacing and threading

- Core's Node main thread owns: libuv, `wl_resource`s, Wayland socket
  dispatch, core's wire client, core's protocol JS, WM/policy JS,
  side-channel handling. Single owner, no locks at this layer.
- Each plugin Worker has its own V8 isolate, event loop, and wire
  client. Per-Worker SDK state is owned by that Worker.
- Inter-Worker / Worker-to-core communication is `postMessage` only.
- Core's main thread runs at `SCHED_RR` in phase 2 (acquired via
  libseat). Plugin Workers run at normal priority — they may slip
  individual frames; their last buffer is reused.
- libuv ↔ `wl_event_loop` integration:
  - `wl_event_loop_get_fd()` registered with libuv as a poll handle on
    read.
  - On readable: `wl_event_loop_dispatch(loop, 0)`.
  - Before libuv blocks: `wl_display_flush_clients()` from a libuv
    `prepare` handle. Missing the pre-poll flush is the canonical way
    to get Wayland clients that mysteriously stall.
- Dawn callbacks fire on Dawn-internal threads in the GPU process; the
  wire delivers them to the wire client's owning thread. From there,
  marshal to the JS context via `napi_threadsafe_function` before
  touching JS / Wayland resources / shared state.
- C++ exceptions never escape into Dawn callbacks. `node-addon-api` is
  used only at the N-API boundary; calls into N-API from within a Dawn
  callback are wrapped to catch and log.

## Configuration

User config at `~/.config/overdraw/config.{js,toml,json}` (format TBD).
Declares:

- Output configuration (resolution, scale, position, refresh rate
  preferences).
- Plugins to load: module path / name, capabilities, restart policy,
  target outputs for tier 2.
- Input behavior: keyboard layout, repeat rate, pointer accel.
- Global key bindings (later; not v1).

No discovery, no drop-in directories. Single source of truth.

## Phased plan

### Phase 1 — nested compositor

- Core is a Wayland *client* of the host. v1 default: one `xdg_toplevel`
  window, one emulated output. The host window is resizable; the
  overdraw output's logical size follows via standard `wl_output` mode
  events. Scale fixed at 1; fractional scale and HiDPI handling
  deferred.
- Multi-output testing in phase 1 is opt-in via config (declare multiple
  outputs explicitly, one host window per output). Default is single.
- Core's compositing device presents via Dawn's Wayland surface source +
  Vulkan swapchain.
- Core is also a Wayland *server* for its own clients. Imports their
  `wl_buffer`s, composites into the swapchain texture.
- GPU process runs Dawn; holds compositing device, dmabuf allocator,
  plugin devices.
- No DRM/KMS, no libinput, no libseat, no supervisor. Core fork/execs
  the GPU process; either process dying = user restarts.

### Phase 2 — bare metal

The implementation work for phase 2 is in `drm-design.md` (8 slices, all
landed). What this section describes is the target shape; what actually
shipped is below it, with the still-deferred bullets called out.

- Session supervisor process owns the listening Wayland socket fd and
  libseat session. Spawns and restarts core and GPU process; crash-loop
  guards both.
- Core uses libinput for input, libseat for session/DRM management.
- Core is DRM master; GPU process gets DRM fd via SCM_RIGHTS at spawn.
- Outputs are host-driven: one overdraw output per KMS connector, with
  mode/scale derived from the connector's reported modes. Config may
  override per-connector (preferred mode, scale, position, rotation).
- GPU process drives KMS: import scanout-capable GBM buffer into Dawn
  as `SharedTextureMemory` with `RenderAttachment`, render composite,
  export `SharedFence` sync-fd, pass as `IN_FENCE_FD` to atomic commit,
  import `OUT_FENCE` back.
- Core's main thread `SCHED_RR`.

**Shipped (drm-design.md slices 1–7):**
- libseat + libinput (slice 1). Single seat opened per session, shared
  between the DRM card and evdev devices. Input backend paired with
  output backend: `--backend=kms` ⇒ libinput; `--backend=nested` ⇒ host-
  forwarded `WaylandInputBackend`.
- Output-backend seam in the GPU process (slice 2). `HostWindowOutputBackend`
  and `KmsOutputBackend` behind the same interface.
- Real `wl_output` (slice 3). EDID-derived geometry + active mode in KMS;
  host `wl_output` values in nested mode. `OutputDescriptor` ctrl message
  + on-change re-emission to bound `wl_output` and `xdg_output` resources.
- KMS scanout, page-flip-paced, with explicit sync (slice 4+5). `--backend=kms`
  drives `/dev/dri/card*` directly, allocates a 3-slot GBM scanout ring at
  LINEAR modifier, dual-imports each slot via `SharedTextureMemory`, runs
  the compositor render loop on atomic commits with `IN_FENCE_FD`.
- Interactive clients on KMS (slice 6). Real clients (kitty verified)
  render + accept keyboard + mouse input on the bare panel.
- VT switch (slice 7). `enable_seat` / `disable_seat` drive a full pause/
  resume lifecycle. `Ctrl+Alt+Fn` intercepted via xkbcommon's
  `XKB_KEY_XF86Switch_VT_N` keysyms; `sudo chvt N` from SSH works
  identically.

**Deferred:**
- **Session supervisor process.** Not built. Today the core fork/execs
  the GPU process directly and reaps it; if either crashes the user
  restarts. The supervisor is a future change, not currently planned.
- **Multi-output.** Single connector only. Multi-output requires
  `wl_output` registry pluralization, per-output frame clocks, per-output
  layout state.
- **Hardware cursor plane.** Software cursor only.
- **Hotplug.** Connector enumeration is read at startup; live hotplug
  not handled.
- **Mode changes.** `SetOutputMode` ctrl message family designed in
  `drm-design.md` but not wired. Connector's preferred mode is used at
  bring-up and not changed thereafter.
- **Non-Intel scanout.** Code is driver-agnostic (libdrm atomic + libgbm)
  but only verified on Intel i915. NVIDIA-driven scanout (some desktops /
  eGPU rigs) is not in the test matrix.
- **DRM lease, content protection, gamma/CTM, tearing/VRR, explicit-sync
  KMS API.** Not needed for v1.

See `status.md` "KMS scanout backend" and `drm-design.md` "Out (deferred)"
for the up-to-date list.

#### Phase-2 present: a self-managed scanout swapchain (no Dawn surface)

In phase 2 there is **no `wgpu::Surface` / Dawn swapchain** — that is a phase-1
nested artifact (it exists only because we present into a host `wl_surface`).
On bare KMS we render into GBM-backed `SharedTextureMemory` textures and KMS
does the present. It is a hand-rolled swapchain: Dawn is reduced to "render into
this texture"; acquire/present/sync are ours. Maps to classic Vulkan WSI as:
the N GBM bos = swapchain images; "acquire" = pick a free ring slot (driven by
page-flip + OUT_FENCE, not Dawn); "present" = `drmModeAtomicCommit`; the
acquire/present semaphores = the `SharedFence` sync-fds we manage via
`BeginAccess`/`EndAccess`.

A ring of **3 scanout buffers** (2 is the minimum that's correct; 3 to never
stall — one front/scanning-out, one pending-flip, one free to render; only one
flip may be pending at a time, so 2 buffers idle the GPU between commit and
page-flip). Each ring slot:

- a `gbm_bo` (`SCANOUT | RENDERING`, modifier from the intersection of the
  plane's `IN_FORMATS` ∩ Dawn-importable ∩ GBM-allocatable);
- registered as a KMS framebuffer (`drmModeAddFB2WithModifiers` → `fb_id`);
- imported as `SharedTextureMemory` → `wgpu::Texture(RenderAttachment)`,
  `InjectTexture`'d at a core-reserved wire handle (the core composites into it
  over the wire, exactly as it injects client dmabufs today).

Per-frame fence dance (both are already-proven primitives; see "Validated
against Dawn" and the implicit-sync acquire in status.md):

- **IN_FENCE (GPU → display):** after the core's composite submit, the GPU
  process `EndAccess`es the slot → `SharedFenceSyncFD` → exports a sync-fd;
  the atomic commit passes it as `IN_FENCE_FD`. The display waits on it before
  scanout, so the commit can be issued before the render completes.
- **OUT_FENCE (display → GPU):** request `OUT_FENCE_PTR`; it signals when the
  buffer this commit *replaced* is free to reuse. Import it back as a Dawn
  `SharedFence` and wait it in the next `BeginAccess` into that freed slot.

Loop (page-flip driven; replaces the core-side timer entirely): DRM page-flip →
GPU process emits `FrameDone { freedSlot, vblankTime }` → core renders the
composite into the next free slot over the wire → core sends `Present { slot }`
→ GPU process `EndAccess` + `drmModeAtomicCommit(fb_id, IN_FENCE_FD,
PAGE_FLIP_EVENT, OUT_FENCE_PTR)`. Tearing is not a concern: atomic page-flips
happen at vblank by construction; a missed deadline just repeats the front
buffer (a dropped frame, not a tear).

Division of labor is unchanged: the **core** still records the compositing pass
over the wire (it owns layout/stack/policy); the GPU process only adds GBM
scanout allocation, the KMS commit, the fence plumbing, and the
`FrameDone`/`Present` messages. `Compositor::renderFrame` barely changes — it
renders into the current ring slot instead of calling `surface_.Present()`. The
phase-1 headless path (render into an owned offscreen texture, no swapchain) is
structurally the same; phase 2 = "headless + the offscreen texture is a scanout
GBM buffer the GPU process flips."

### Phase 3 — XWayland

- Launch the `Xwayland` executable as a child. It connects to the
  compositor as a Wayland client and renders X11 windows into Wayland
  surfaces via `xwayland_shell_v1`.
- Compositor acts as the X11 window manager via `libxcb`: claims WM
  ownership, handles `MapRequest`/`ConfigureRequest`/`PropertyNotify`,
  implements ICCCM/EWMH, bridges X11 selection ↔ Wayland data device,
  bridges X11 DnD.
- Reference: wlroots' xwayland module.

## Module / file layout

```
overdraw/
  docs/
    architecture.md
  native/                       # C++ N-API addon (core process)
    src/
      wayland/
        display.cpp             # wl_display, socket, libwayland <-> libuv
        protocol_trampoline.cpp # generic interface registration, dispatch
        resource_bridge.cpp     # wl_resource <-> JS handle
        fd_table.cpp            # fd handle allocation, lifecycle
      gpu/
        wire_client.cpp         # core's Dawn wire client
        side_channel.cpp        # control protocol with GPU process
      input/                    # libinput  (phase 2)
      session/                  # libseat   (phase 2)
      kms/                      # DRM master, atomic-commit helpers (phase 2)
      napi/                     # N-API surface exposed to JS
    codegen/
      gen-protocol.{ts,py}      # Wayland XML -> JS interface module
  gpu-process/                  # native, no JS
    src/
      main.cpp                  # entry point; sets up wire server, side channel
      wire_server.cpp           # dawn::wire::Server + transport
      allocator.cpp             # GBM dmabuf allocator, format/modifier probe
      shared.cpp                # SharedTextureMemory / SharedFence wrappers
      kms.cpp                   # KMS atomic commit  (phase 2)
  src/                          # JS core layer
    protocols/                  # one *.js per implemented protocol
      wl_compositor.js
      wl_surface.js
      xdg_shell.js
      linux_dmabuf.js
      ...
    protocols-gen/              # generator output (interface signatures only)
    wm/                         # window management policy, layout, focus
    surfaces/                   # internal Surface objects (plugin + Wayland)
    outputs/                    # output bookkeeping, frame loops
    plugins/                    # plugin registry, capability grants, lifecycle, watchdog
    index.js
  plugin-sdk/                   # JS library + small native addon, loaded per Worker
    src/
      gpu.js                    # WebGPU via Dawn wire
      surface.js                # swapchain shape
      window.js                 # window/surface placement
      output.js                 # output takeover
      capture.js                # thumbnail / dmabuf capture
      input.js                  # structured input events
      protocol.js               # protocol-provider API
      onframe.js                # wl_surface.frame() wrapping
    native/
      wire_client.cpp           # per-Worker Dawn wire client
      bridge.cpp                # postMessage <-> core SDK service
  examples/
    panel/                      # tier 1 sample
    overview/                   # tier 3 sample
    custom-shell/               # tier 4 sample: plugin implements a protocol
  supervisor/                   # phase 2
    src/main.cpp
```

## Build / dependencies

- Node v24+, `node-addon-api`.
- `wayland-server` / `wayland-client` 1.24, `wayland-protocols` 1.47
  (XML inputs to our generator). `wayland-scanner` is *not* used; we
  parse XML ourselves and generate JS.
- `libdrm`, `gbm`, `libinput`, `libseat`, `xkbcommon`, `vulkan` 1.4.
- Dawn native (vendored), Vulkan backend, features
  `SharedTextureMemoryDmaBuf`, `SharedFenceSyncFD`,
  `SharedFenceVkSemaphoreOpaqueFD`.
- wlroots is not used: its main value is its C protocol implementations,
  which we deliberately reimplement in JS; its backend abstraction we
  provide ourselves.
- spdlog (FetchContent, compiled mode) — see Logging.

## Logging

Unified logging across the three execution contexts (Node host JS, core
native addon, GPU process). One library (spdlog), one configuration, one
set of sinks, owned by the host process.

### Levels

`trace`, `debug`, `info`, `warn`, `err`, `critical`, `off`. `SPDLOG_ACTIVE_LEVEL`
is set by build type: debug builds compile in `trace`; release builds compile
in `info` (trace/debug calls strip to zero cost). Runtime level is set per
area (see below).

### Areas

A fixed set of named loggers declared in one header. Adding one is a
single-line change there.

| area      | purpose                                                  |
|-----------|----------------------------------------------------------|
| `core`    | core compositor glue, lifecycle                          |
| `wayland` | `wl_*` protocol handlers, server, trampoline             |
| `xdg`     | `xdg_*` protocols (shell, decoration, popups)            |
| `ipc`     | core ↔ GPU process wire transport, side channels         |
| `seat`    | `wl_seat`, focus, capabilities                           |
| `input`   | libinput / pointer / keyboard / xkb                      |
| `gpu`     | GPU process internals (Dawn host, KMS, DRM, allocator)   |
| `dawn`    | messages routed from Dawn's internal logger              |
| `plugin`  | plugin runtime (host side); per-plugin lines are tagged  |
| `js`      | catch-all for `console.*` calls without an explicit area |

Free-form area strings are rejected; the C++ API takes a typed enum and
the JS `console.*` shim always uses `js`. JS code that wants a different
area uses a `log` module (`import { log } from "@overdraw/log"; log.info("core", "...")`)
that wraps the same napi binding.

### Sinks

Two sinks, both attached to every area, split by severity:

- **stdout sink**, level filter ≤ `info` (`trace`/`debug`/`info`).
- **stderr sink**, level filter ≥ `warn` (`warn`/`err`/`critical`).

This means `console.log` → stdout, `console.warn`/`console.error` → stderr,
and the same severity-based split applies uniformly to C++ `LOG_*` calls
regardless of which process they originated in.

A third **file sink** is attached only if `--log-file=PATH` is passed.
The file sink accepts all levels (subject to per-area runtime filtering)
and writes truncate-on-start (no rotation in v1; rotation is a future
addition if logs get big). Without `--log-file`, no file is written.

All sinks live in the host process. The GPU process forwards records
over IPC; it has no sinks of its own.

### CLI

Two flags on the host process (and forwarded conceptually — the GPU
process inherits the filter table over IPC, not the CLI):

- `--log-level=SPEC` where `SPEC` is a comma-separated list of `area=level`
  pairs. A bare level with no `=` applies as the default for all areas.
  Examples:
  - `--log-level=debug` — every area at debug.
  - `--log-level=core=debug,gpu=info,wayland=trace` — per-area, areas not
    listed stay at the built-in default (`info`).
  - `--log-level=warn,gpu=debug` — default warn, gpu at debug.
  Unknown areas are an error at startup.

- `--log-file=PATH` — enable the file sink at `PATH` (truncated on start).
  Omitted = no file written.

### JS integration

The native addon installs a shim onto `globalThis.console` during addon
init that replaces `log`, `info`, `warn`, `error`, `debug`, `trace` with
calls into `nativeLog(level, area, message)`. The original `console.*`
functions are not preserved; redirecting them is the whole point (future
contributors writing `console.log` is the expected path, not a fallback).

`console.log` maps to `info`, `console.warn` to `warn`, `console.error`
to `err`, `console.debug` to `debug`, `console.trace` to `trace`,
`console.info` to `info`. All `console.*` calls use area `js`.

Code that wants a specific area imports the `log` module:

```ts
import { log } from "@overdraw/log";
log.info("wayland", "client connected fd=%d", fd);
log.warn("ipc", "wire backpressure depth=%d", depth);
```

The `log` module is a thin wrapper over `nativeLog`. Format-string handling
matches `util.format` (lazy: only invoked if the level passes the runtime
filter).

### GPU process forwarding

The GPU process is a separate binary. It links spdlog the same way the
core addon does, but configures only an **IPC sink** that serializes each
log record into a wire frame on the existing side channel
(`packages/core/native/ipc/side_channel.h`). The host receives these
frames and replays them into its own spdlog (preserving level, area,
message, originating-process tag, and the record's monotonic timestamp).

**Pre-IPC bring-up.** Before the GPU process's wire connection is
established, log records cannot be sent. They are accumulated in a
fixed-capacity in-memory ring (e.g. 256 records) and flushed in order
once the IPC sink comes up. If the ring overflows before flush, oldest
records are dropped and a single `warn`-level "log buffer overflow:
N records dropped" record is enqueued in their place. The GPU process
makes **no** direct writes to its inherited stderr — the existing
`FD_CLOEXEC`-cleared inheritance from `gpu_process.cpp:62` is no longer
relied upon for logging (it remains for the crash handler, which writes
`/tmp/overdraw-gpu-crash.txt` per CLAUDE.md and is not part of normal
logging).

**Filter table.** When the host applies `--log-level`, the per-area
filter is sent to the GPU process over the same side channel so the
GPU process can drop records below threshold at the source rather than
spending wire bandwidth on them. Changes to the table after startup are
broadcast the same way (no JS API in v1, but the mechanism supports one).

This also subsumes the currently-advertised-but-unimplemented `Fault {
reason }` event listed at "GPU → core events": a fault becomes a normal
`err`-level log record on the `gpu` area. The `Fault` line in that
table is replaced by this.

### Implementation surface

- **`packages/core/native/log/Log.h`** — public API: `LOG_TRACE/DEBUG/
  INFO/WARN/ERR/CRIT(area, fmt, ...)` macros, area enum, init function
  (`log_init(const LogConfig&)`), CLI-spec parser
  (`parse_log_level_spec(string)` → table).
- **`packages/core/native/log/Log.cpp`** — sink construction, filter
  table application, area→logger map.
- **`packages/core/native/log/ipc_sink.{h,cpp}`** — spdlog sink subclass
  that writes records to the side channel; symmetric `ipc_source` on
  the host side that reads frames and replays.
- **`packages/core/native/log/console_shim.{h,cpp}`** + napi binding
  `nativeLog(level, area, msg)`.
- **`packages/core/src/log.ts`** — `log` module + `console.*` install
  (called from addon init).
- **`packages/core/gpu-process/src/log_ringbuf.{h,cpp}`** — pre-IPC ring
  buffer.
- CMake: spdlog via `FetchContent` in compiled mode, linked into
  `overdraw_wire` (so both the addon and the GPU process pick it up
  through their existing dependency on the wire lib).

### Non-goals (v1)

- Async logging sink. spdlog supports it; v1 stays synchronous for
  determinism in tests.
- File rotation. Single truncate-on-start file is enough; rotation
  added if/when needed.
- Structured/JSON output. Plain text only. A JSON sink is a future
  addition.
- Runtime level changes from JS. Mechanism exists (IPC broadcasts the
  filter table) but no JS API is exposed in v1.

## Open items

### Deferred features (not v1)

- **Hotkey / global keybinding capability.** Cross-output keyboard input
  is not part of tier 2. Separate capability + plugin SDK API needed.
- **Compositor-side surface transforms.** Per-surface transform state
  (translate, scale, opacity, fade) applied by the core each frame
  without requiring a producer commit. Enables smooth window-open /
  workspace / dock animations without the producer in the per-frame
  loop.
- **Damage tracking.** v1 redraws everything every frame. Architecture
  leaves room for damage (clients already send `wl_surface.damage_buffer`;
  SDK `surface.present()` accepts a damage region but ignores it).
- **HDR / color management.** Out of scope for v1. If addressed, affects
  blending space and KMS plane configuration.
- **Phase-2 KMS side-channel messages.** Page-flip events, atomic commit
  coordination. Designed in phase 2.
- **Scanout format probe (phase 2).** Separate from the plugin format
  probe; determines the core's output buffer format.
- **Renderer thread / C++ promotion.** Renderer runs on the Node main
  thread in v1. Promotion to a dedicated worker (with
  `SharedArrayBuffer` + `Atomics` shared surface graph) or to C++ is
  internal refactoring, decided when measurements demand it.

### Not yet designed (still needed before/during v1)

- **Configuration format.** JS / TOML / JSON not chosen.
- **Plugin naming.** Stable identifier for capability grants, logging,
  restart counting. Probably the config-supplied name.
- **Plugin SDK native addon shape.** Same `.node` as core's addon
  loaded per Worker (Worker-aware), or a separate `.node`. Either
  works; pick one when implementing.
- **Compositing pipeline initialization / startup sequence.** Order
  between spawning the GPU process, establishing wire connections,
  building the core's device and pipelines, and opening the Wayland
  listening socket. Sketch needed.
- **Input handling architecture (phase 1).** Translating host
  pointer/keyboard events into overdraw internal events and routing
  via focus policy. Standard work; not designed yet.
- **WM / outputs JS layer.** Window management policy, focus rules,
  layout strategy. Deliberately undesigned; grows from real plugin
  needs.
- **Testing.** Headless mode: run core without host compositor or KMS,
  drive frame ticks programmatically, snapshot composed output. Needed
  for development.
- **API surface review.** Once real plugins exist, review compositor
  extension APIs from sway, hyprland, niri, KWin scripting, GNOME Shell
  extensions, river. Refine the SDK protocol shape based on what real
  plugins need.
