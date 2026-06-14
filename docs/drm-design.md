# overdraw — DRM/KMS + libinput + libseat design

Bare-metal output and input: the compositor opens `/dev/dri/card*` and
`/dev/input/event*` directly through a logind session (no host Wayland
server underneath), drives KMS atomic modeset on a real connector, takes
page-flip-driven frame timing, and reads input from libinput. This is what
`architecture.md` calls "phase 2."

Read first: `architecture.md` "Process topology" (the core/GPU-process
split is preserved), `status.md` "Read first: gaps in advertised
protocols" (`wl_output` is fabricated; the frame clock is a timer; both
become real here), and the comment block at the top of
`packages/core/native/core/input.h` (the existing `InputBackend` seam this
plan slots into).

This document is design only. It does not move any code.

## Scope

In:

- **Session/seat acquisition via libseat (logind backend).** Core obtains
  DRM device fd(s) and `/dev/input/event*` fds without running as root.
  VT-switch handling (revoke/restore + master drop/take).
- **Output-backend seam** in the GPU process, symmetric with the existing
  `InputBackend` seam in the core. Two implementations:
  `HostWindowOutputBackend` (today's phase-1 nested behavior, lifted
  behind the seam) and `KmsOutputBackend` (new). Selected at runtime.
- **`KmsOutputBackend` v1.** Atomic-only modeset (legacy DRM never used).
  One CRTC, one connector, one primary plane on one card. Single output.
  GBM-allocated scanout buffers, dual-imported as `wgpu::Texture` via
  `SharedTextureMemory` so the existing JS compositor renders into them
  unchanged. Page-flip events drive a real frame clock.
- **`LibinputBackend`** in the core, parallel to `WaylandInputBackend`,
  emitting the SAME normalized `InputEvent`s the existing seat code
  consumes. Pointer mapped to OUTPUT space; keyboard codes raw evdev.
- **`wl_output` made real for the active output.** EDID-derived
  geometry/mode/scale, replacing the fabricated values. Single output only.
- **Display-driven frame clock.** Render submits on KMS page-flip;
  `uv_timer` paced loop is replaced for the KMS backend.
- **Runtime backend selection.** One binary; chosen at startup
  (env var / arg / autodetect). The phase-1 nested path keeps working.

Out (deferred):

- **Multi-output.** Single connector only in v1. Multi-output requires
  `wl_output` registry pluralization, per-output frame clocks, per-output
  layout state in WM — each of which is its own work. Hotplug enumeration
  is read at startup; live hotplug deferred.
- **Hardware cursor plane.** Software cursor only (the Phase 9b/9c
  compositing slot). The KMS cursor plane is a later optimization.
- **DRM lease, leases for VR/games, content-protection, gamma/CTM.** Not
  needed for v1.
- **Format/modifier negotiation beyond a fixed allowlist.** Pick one
  (XRGB8888 or ARGB8888) at startup; reject if unsupported. Match the
  existing client-buffer policy.
- **Tearing / immediate flips, adaptive sync (VRR), explicit-sync
  KMS API.** v1 uses standard atomic + page-flip events.
- **Driving the panel from a GPU other than the laptop's iGPU.** On the
  test laptop (and most hybrid laptops), the built-in display is wired by
  hardware to the Intel iGPU; the NVIDIA dGPU has no display path to it.
  Slice 4 targets the iGPU's display engine because that is the only path
  to the panel on this machine — not a deliberate "no NVIDIA" choice but
  the topology. NVIDIA participates here only via PRIME render offload
  (a per-client opt-in render resource whose output is dmabuf-shared back
  to Intel for scanout), which is orthogonal to KMS slice 4 and works the
  same way it does today for nested-mode clients. Configurations where
  the scanout GPU IS NVIDIA (some desktops, some external-GPU rigs) are
  not part of v1's test matrix; the KMS code is written driver-agnostic
  (libdrm atomic, libgbm) so they aren't precluded, just unverified.
- **TTY ownership without logind** (direct VT_SETMODE, seatd-launch).
  v1 requires logind. If we ever ship without systemd, libseat can
  switch to a seatd backend with no code change — but seatd isn't being
  set up in v1.
- **Session-supervisor process.** `architecture.md` mentions one for
  phase-2 process lifecycle; v1 does not add it. The core continues to
  fork/exec/reap the GPU process directly.

## Decision summary

These are the load-bearing choices. Each has a "Why" attached because
they each have a defensible alternative.

1. **One invocation, two backends, selected at runtime.** The
   compositor is `node packages/core/dist/main.js` (the Node core)
   which fork+execs `overdraw-gpu-process` (the native GPU helper).
   Both keep their existing identities. The backend choice is a
   top-level flag threaded down: the Node core decides whether to
   build a libseat + libinput stack on its side, and passes
   `--output=kms|nested` to the GPU process when it execs it. The
   GPU process loads either `HostWindowOutputBackend` (phase-1
   nested, today's path) or `KmsOutputBackend` (phase-2 KMS) behind
   the new output-backend seam.
   - Why: `status.md` explicitly frames phase-1 and phase-2 as "swap
     underneath" behind a seam. A separate `overdraw-gpu-process-kms`
     would mean two GPU-process codebases and forked WSI bring-up.
     Bigger maintenance hit than a single dispatch at startup.
   - Alternative considered: separate `overdraw-gpu-process-kms`
     binary. Cleaner dependency boundary (DRM/libinput/libseat pulled
     only into the KMS build). Rejected because the GPU process
     already pulls GBM (via `allocator.cpp`) and Dawn pulls all of
     Vulkan; adding libdrm and friends is in the noise.

2. **libseat in the CORE process, not the GPU process.**
   - Why: input devices belong to the core's input backend (which is
     already core-side). libseat is the seat-management library, not a
     GPU thing. Putting the seat in the core also means the core owns
     VT-switch handling, which is where the policy lives (when we lose
     master, stop submitting; when we regain it, re-modeset).
   - The GPU process needs the DRM fd. The core opens the card via
     libseat, then sends the fd to the GPU process over the existing
     side channel (SCM_RIGHTS), just like the existing
     `ImportClientTex` pattern. The GPU process never talks to libseat.
   - VT-switch: libseat raises an event on its fd; the core forwards a
     side-channel "pause" message; GPU process stops `drmModeAtomicCommit`
     and `wl_buffer` consumption; libseat hands the device back; core
     forwards "resume"; GPU process re-runs modeset (state is in core's
     `wl_output` registry already).

3. **Atomic-only KMS.** No legacy mode-set path.
   - Why: wlroots' decade-long experience: legacy is its own state model,
     not a subset. Maintaining both doubles the surface. Atomic has been
     the right answer on every driver we care about for years.
   - Risk: some older drivers don't support atomic. The Intel i915 in
     the test box does. If a target driver doesn't, we'll know at
     `DRM_CLIENT_CAP_ATOMIC` enable time and refuse to start.

4. **GBM scanout buffers dual-imported as `wgpu::Texture` (no copy).**
   The KMS backend allocates `gbm_bo`s, exports their dmabuf fds,
   imports each as `SharedTextureMemory` on the GPU process's Dawn
   device, and creates a `wgpu::Texture` from it. The core's existing
   JS compositor (`packages/core/src/gpu/compositor.ts`) renders into
   the `wgpu::Texture` exactly as it does into the host-swapchain
   texture today.
   - Why: this is what `architecture.md` "Rendering and buffer
     interop" already builds for — `SharedTextureMemory` over dmabuf
     is the existing primitive. The compositor doesn't change.
   - 3-slot ring (triple-buffer), one slot in scanout, one queued
     flip, one being drawn. Same ring shape as the plugin
     producer/consumer rings; different lifecycle (the KMS commit
     promotes a slot to scanout; page-flip event releases the prior).

5. **Output-backend seam in the GPU process, mirroring `InputBackend`
   in the core.** New abstraction (sketch):

   ```cpp
   class OutputBackend {
     public:
       virtual ~OutputBackend() = default;
       virtual bool open() = 0;                    // bring up display
       virtual void close() = 0;
       virtual int  eventFd() const = 0;           // fd for the event loop
       virtual void pump() = 0;                    // drain on readable
       virtual void getOutputInfo(OutputInfo& out) const = 0;
       virtual wgpu::Texture acquireScanoutTexture() = 0;
       virtual void presentScanoutTexture(wgpu::Texture, OutputCommitArgs) = 0;
       virtual bool shouldClose() const = 0;
   };
   ```
   - `HostWindowOutputBackend` wraps today's `HostWindow` + Dawn
     surface + swapchain unchanged.
   - `KmsOutputBackend` owns the libdrm fd, GBM device, atomic state,
     page-flip event reader, and the scanout ring.
   - The GPU process's pump loop polls `eventFd()` (host wl_display fd
     today, drmFd in KMS) and calls `pump()` on readable.
   - `acquire`/`present` replaces the direct `wgpu::Surface` calls in
     `main.cpp`. Internally KMS does `drmModeAtomicCommit` with
     `PAGE_FLIP_EVENT`; the next `acquire` returns the next free slot
     (waits if all in-flight).

6. **`InputEvent`s for `LibinputBackend` are produced ENTIRELY in the
   core.** No marshaling across the side channel. libinput is opened
   in the core, the libinput fd is on the core's libuv loop, drained
   via the existing `InputBackend::drain()` contract.
   - Why: the existing `WaylandInputBackend` is the special case (input
     came from the GPU process because the GPU process owns the host
     `wl_seat`). For KMS, the input source IS the core's own
     evdev/libinput. Routing it through the GPU process would add a
     hop for no reason.

7. **A new compile-time dependency set.** libdrm, libgbm-dev (already
   present GPU-side), libinput, libseat, libudev. Confirmed installed
   on the test box (status note). Build system change: gate the KMS
   bits behind a CMake option that's on by default on Linux; the
   `HostWindowOutputBackend` remains the fallback on systems where
   the libs aren't found.

## Backend selection

The Node core (`packages/core/dist/main.js` entry, the compositor) picks
the backend in this order, first match wins:

1. **Explicit `--backend=kms|nested` flag** on the compositor invocation.
2. **`OVERDRAW_BACKEND` env var**, same values.
3. **Autodetect.** If `$WAYLAND_DISPLAY` is set AND a host server is
   reachable on it → `nested`. Else if logind reports an active seat
   for this user AND the user has access to `/dev/dri/card*` →
   `kms`. Else fail with a clear message.

The choice is threaded into both processes:

- Core-side (Node + addon): if `kms`, the addon brings up libseat +
  libinput before spawning the GPU process. If `nested`, the addon
  builds the existing `WaylandInputBackend` and the GPU process gets
  the host's `WAYLAND_DISPLAY` from its environment as today.
- GPU-process-side: the addon's existing `spawnGpuProcess` exec path
  gains an `--output=kms|nested` argv flag, parallel to the existing
  `--headless`. The GPU process's `main.cpp` constructs the matching
  `OutputBackend` implementation.

For the KMS backend, the core also passes:

- `--seat=<name>` (default `seat0`)
- `--card=<path>` (override). Default: auto-detect — the core probes
  `/dev/dri/card*` and opens the first with a connected connector (the
  card driving a display). Config `output.card` is an override between
  the CLI flag and auto-detect. On a hybrid box this auto-selects the
  GPU whose connector is live (e.g. the Intel card driving the internal
  panel) rather than a fixed node. The GPU process then pins its Dawn
  adapter and GBM render node to that same card (see "GPU selection").

## Seat / VT lifecycle

The core's libseat client is built once at startup and lives until
shutdown. Devices are opened via `libseat_open_device` (returns an fd
+ a device id; close with `libseat_close_device`).

Events:

- **`enable_seat`** (libseat tells us the seat is active, e.g. on
  VT-switch back): re-acquire DRM master if dropped; the GPU process
  re-runs modeset on the current `OutputInfo`; input devices are
  already open (libseat re-enables them).
- **`disable_seat`** (VT-switch away): immediately send the GPU process
  a side-channel "pause output" message. The GPU process stops issuing
  atomic commits and stops calling `getCurrentTexture()` on the scanout
  ring. The core also stops the input backend (libseat will revoke the
  evdev fds, but we should stop draining them first to avoid spurious
  errors). When `libseat_dispatch` reports the disable is acknowledged,
  call `libseat_disable_seat` back to libseat.

Pause/resume is a new side-channel message pair. Phase-1 nested
doesn't use it.

The core also installs SIGUSR1/SIGUSR2 handlers as a fallback for
direct VT switching (when not running under logind — not the v1 path,
but cheap to add and removes a footgun if someone tries it).

## DRM/KMS bring-up

In the GPU process, on `KmsOutputBackend::open()`:

1. Receive the DRM fd from the core over the side channel (the core
   opened it via libseat).
2. `drmSetClientCap(DRM_CLIENT_CAP_ATOMIC, 1)` — fail if rejected.
3. `drmSetClientCap(DRM_CLIENT_CAP_UNIVERSAL_PLANES, 1)`.
4. `drmModeGetResources` → enumerate connectors. Pick the first
   connected one (status `CONNECTED` and a non-empty mode list). If
   the env var `OVERDRAW_CONNECTOR=<name>` is set, prefer that one.
5. Pick the first mode (preferred mode if marked, else mode 0).
6. Find a CRTC for the connector (`drmModeGetEncoder` chain, or the
   encoder's `possible_crtcs`).
7. Find a primary plane for that CRTC.
8. Create GBM device on the DRM fd (`gbm_create_device`).
9. Allocate the scanout ring: 3 × `gbm_bo_create_with_modifiers` with
   the format we picked (XRGB8888) and the modifier set Dawn reports
   for `RenderAttachment | TextureBinding` on the GPU process's native
   adapter (intersected with what GBM supports, mirroring the existing
   `ProbeFormats` path).
10. For each `gbm_bo`: `gbm_bo_get_fd_for_plane`, import as
    `SharedTextureMemory` on the Dawn device, create a
    `wgpu::Texture` view with `RenderAttachment | TextureBinding`.
11. For each `gbm_bo`: `drmModeAddFB2WithModifiers` → `fb_id`. Cache
    the `fb_id` next to the texture; that's what `drmModeAtomicCommit`
    actually scans out.
12. Build the initial atomic commit: connector→CRTC, CRTC mode +
    active, primary plane: FB = slot 0's fb_id, src/crtc rects = full
    mode size. `DRM_MODE_ATOMIC_ALLOW_MODESET` set.
13. Hand the first slot's `wgpu::Texture` to the compositor via
    `acquireScanoutTexture()`.

Steady state:

- `acquireScanoutTexture()` returns the next FREE slot's
  `wgpu::Texture`. If all 3 are busy, waits on the page-flip event.
- `presentScanoutTexture(tex, args)`:
  - Mark the slot's contents valid (the JS compositor's `submit` has
    been called).
  - `drmModeAtomicCommit(fd, req, DRM_MODE_PAGE_FLIP_EVENT | DRM_MODE_ATOMIC_NONBLOCK, userdata=slot_idx)`.
  - The PRIOR scanout slot transitions FREE on the next
    `DRM_EVENT_FLIP_COMPLETE`.
- DRM event fd (`eventFd()`) is on the GPU process's event loop. Page-
  flip events drive the frame clock: on flip-complete, signal the
  compositor that the next frame can begin (`wl_surface.frame`
  callbacks fire, render runs, scanout slot acquired, atomic commit
  submitted). One frame in flight at a time (the same pacing today's
  `Mailbox` swapchain gives us, but now causally tied to vsync).

The slot ring lifecycle is the same shape as the existing
`SurfaceProducer` ring in `surface-ring.ts`, but on the GPU side. Worth
considering reusing the abstraction (with `compose-live`'s producer/
consumer split flipped one more time: scanout *is* the consumer; the
core's compositor *is* the producer; the page-flip event is the
"consumer done" signal). v1 will write a dedicated `KmsScanoutRing`
class to keep the GPU process self-contained, but the shape should be
familiar to anyone who's read `surface-ring.ts`.

## Output configuration: messages across the side channel

KMS state lives in the GPU process; everything else (clients,
`wl_output`, WM layout, the user's intent) lives in the core. A
configuration change therefore moves through TWO directions on the
side channel: the core asks for a change; the GPU process reports
what actually happened.

Why split the direction: `drmModeAtomicCommit` with
`DRM_MODE_ATOMIC_ALLOW_MODESET` can only be issued by the side
holding the DRM master fd (the GPU process). Mode validation
(`drmModeAtomicCommit` with `DRM_MODE_ATOMIC_TEST_ONLY`) is the same
fd. So the core never directly mutates output state; it requests,
and acts on the resulting descriptor.

### Core → GPU process: `SetOutputMode`

```
SetOutputMode {
  outputId    // matches the id in the OutputDescriptor
  width       // pixel dimensions of the target mode
  height
  refreshMhz  // 0 = "any mode at this width/height" (GPU picks)
  scale       // logical scale (1 in v1; placeholder for HiDPI)
  transform   // normal in v1; placeholder for 90/180/270/flipped
}
→ result:
  SetOutputModeResult {
    status: ok | mode-not-supported | test-commit-failed | not-master | unknown-output
    descriptor?: OutputDescriptor   // present on `ok`
  }
```

GPU process handling:

1. Look up the requested mode in the connector's mode list. If
   `refreshMhz == 0`, pick the first mode matching width × height.
   No match → `mode-not-supported`.
2. Build an atomic commit reflecting the new mode + a fresh scanout
   FB (one of the to-be-reallocated slots; see step 4) and run it
   with `DRM_MODE_ATOMIC_TEST_ONLY`. Failure → `test-commit-failed`,
   reply with prior descriptor unchanged. Atomic test exists exactly
   so the kernel can reject incompatible plane/CRTC combinations
   before we tear down the working state.
3. Retire the existing scanout ring (texture handles release on the
   wire when their GPU work completes — same pool-generation logic
   the SDK already uses for surface resize).
4. Allocate a fresh scanout ring at the new dimensions
   (`gbm_bo_create_with_modifiers` × 3, dual-import as
   `SharedTextureMemory`, `drmModeAddFB2WithModifiers` → new
   `fb_id`s).
5. Real `drmModeAtomicCommit` with `DRM_MODE_ATOMIC_ALLOW_MODESET`,
   primary plane pointed at slot 0's new fb_id.
6. Reply `{status: ok, descriptor: ...}` carrying the new
   `OutputDescriptor`.

Core handling on `ok`:

- Update `state.outputs` with the new descriptor.
- Re-emit `wl_output` events to bound resources (existing path used
  for the initial descriptor).
- The compositor's existing resize handling picks up the new output
  size; WM re-lays-out; clients receive `xdg_toplevel.configure`
  with their new tile size.
- Plugins observing `output.*` events on the bus see the change.
- The next `acquireOutputTexture` over the wire returns a texture
  from the new (larger/smaller) ring; no JS-side change needed.

### GPU process → core: `OutputDescriptor` (unsolicited)

Already in the design as a startup message; also sent unsolicited
on any state change the GPU process detects on its own. v1 reasons
this fires unsolicited:

- After a successful `SetOutputMode` (paired with the result above).
- After a VT-switch resume re-runs modeset (the mode is unchanged
  but the descriptor is re-emitted so the core can re-confirm
  state consistency).

v1 does NOT do hotplug — connector add/remove + connector mode-list
change are deferred. The message shape is designed to admit them
later (`OutputAdded` / `OutputRemoved` / `OutputDescriptor` for an
existing output covers the mode-list-changed case).

### Atomic test-then-commit

Every modeset goes through `TEST_ONLY` first. This is not an
optimization — it is correctness. Without it, an incompatible
configuration leaves the kernel with a partial state and the next
real commit may fail in ways that are hard to recover from. With
it, a rejection costs one ioctl and leaves the prior working
configuration intact.

### Scanout-ring reallocation

The scanout ring is wholly GPU-process-internal: the core never
sees slot textures directly, only the wire handle returned by
`acquireOutputTexture`. Reallocating the ring on a mode change is
the same shape as the SDK's pool-generation retire for plugin
surfaces: in-flight GPU work on the old ring drains, the old
slots' textures release on the wire, the next acquire returns a
texture at the new dimensions. The wire handle returned by
`acquireOutputTexture` continues to refer to "the current scanout
slot" — its concrete identity changes generation, the API does
not.

### Open: when does the new descriptor become authoritative?

Two reasonable points: (a) when the GPU process replies `ok`
(client `wl_output` events fire first, then the next render lands
on the new ring), or (b) after the first successful page-flip on
the new mode (events fire only after the panel is actually showing
the new mode). v1 chooses (a) — simpler, and the "between request
and first flip" window is a single vblank in practice. Worth
flagging for revisit if a real consumer (e.g. a settings UI)
exposes flicker during the transition.

## `wl_output` reconfiguration

Today `wl_output` reports fabricated values; the status doc lists this
as a silent-gap risk. Phase-2 makes it real for the single active
output:

- The GPU process reads the connector's EDID (`drmModeGetConnector` →
  EDID blob → parse make/model/serial/physical size) and the active
  mode (width, height, refresh, scale=1 in v1) and sends the result
  to the core in a new "OutputDescriptor" side-channel message.
- The core's `state.outputs` registry (already added for `xdg-output`
  per status.md) receives the descriptor and re-emits `wl_output`
  events to bound clients.
- For the nested backend, `HostWindowOutputBackend` produces the SAME
  descriptor from the host `wl_output` (today's fabricated values
  become real for the host's output). This is the long-standing
  `wl_output` fix and lands as part of this work because the seam
  forces it. **This intentionally widens the scope** — the
  alternative is to do KMS first and `wl_output` second, but that
  means baking the fabricated `wl_output` into the new backend too.

Window-size end-to-end (output → swapchain → WM → input mapping) is
the same path `status.md` "Read first" describes as needed. We do
that path here.

## Frame clock

KMS path: page-flip events. The compositor's render loop is gated on
page-flip-complete (`one in flight` rule). The existing `uv_timer`
pacing is removed for the KMS backend.

Nested path: this design does NOT replace the timer with the host
`wl_surface.frame` callback (the status.md gap). Doing that is a
prerequisite for the nested backend to behave correctly under VRR /
fast-forward / minimized hosts, but it's orthogonal to KMS and stays
on the existing TODO list. (We could do it as a follow-on; it would
also slot into the `OutputBackend::pump()` shape — the host frame
callback becomes the nested backend's "flip-complete" equivalent.)

## libinput

Backend: `LibinputBackend : InputBackend` in
`packages/core/native/core/input_libinput.{h,cpp}`. Mirrors
`input_wayland.cpp` shape.

- Construct with the libseat handle (so it can open devices through
  the seat). libudev for device enumeration.
- libinput exposes one fd (`libinput_get_fd`) registered on the addon's
  libuv loop, same as `WaylandInputBackend`.
- `drain()` calls `libinput_dispatch` then loops on
  `libinput_get_event` / `libinput_event_get_type`:
  - Pointer motion (relative): accumulate into the cursor position
    (in output space); emit `PointerMotion`.
  - Pointer motion-absolute (touchpads in absolute mode, tablets):
    map device-coords to output space via `libinput_event_pointer_get_absolute_x_transformed`.
  - Pointer button: `libinput_event_pointer_get_button` → `InputEvent`
    with the evdev button code. (BTN_LEFT, BTN_RIGHT, etc. are
    already raw evdev — no remapping.)
  - Pointer axis: scroll (continuous + discrete).
  - Keyboard key: `libinput_event_keyboard_get_key` is the raw evdev
    keycode; emit as-is. Keysym resolution stays in the seat layer
    (existing `Keymap` / xkbcommon).
- Cursor accumulation: libinput delivers relative motion; the cursor
  position is the integral. v1 clamps to output bounds (single output).
- Output-size for clamping comes from the same `OutputInfo` the
  output backend produces.

Calibration / quirks / configuration (tap-to-click, natural scroll,
acceleration) is plumbed through `libinput_device_config_*`. v1
exposes a minimal `config.input.libinput` block (tap, natural scroll,
accel speed); not a full pass-through.

A new dependency: `libudev`. Already present on the test box.

## Module map

New files:

- **Native (core)**:
  - `packages/core/native/core/seat.{h,cpp}` — libseat wrapper, owns
    the seat handle, dispatches enable/disable events to two
    callbacks (output, input). Opens DRM card on request; opens evdev
    devices on libinput's behalf.
  - `packages/core/native/core/input_libinput.{h,cpp}` — the
    `LibinputBackend` implementation.
- **Native (GPU process)**:
  - `packages/core/gpu-process/src/output_backend.h` — the abstract
    seam (interface defined above).
  - `packages/core/gpu-process/src/output_host_window.{h,cpp}` — the
    existing `HostWindow`-driven output lifted behind the seam (file
    renamed; behavior unchanged).
  - `packages/core/gpu-process/src/output_kms.{h,cpp}` — the
    `KmsOutputBackend`.
  - `packages/core/gpu-process/src/kms_scanout_ring.{h,cpp}` — the
    3-slot scanout ring (GBM allocation + dmabuf import + fb_id +
    slot-state machine).
  - `packages/core/gpu-process/src/drm_utils.{h,cpp}` — connector/CRTC/
    plane enumeration, atomic-commit helpers, EDID parsing.

Modified files:

- `packages/core/gpu-process/src/main.cpp` — argv parsing for
  `--output=kms|nested`, backend instantiation, pump-loop switch.
- `packages/core/native/napi/addon.cpp` — `start()` gains a
  `backend` option; on KMS path, build seat + libinput in the core
  before spawning the GPU process; SCM_RIGHTS the DRM fd over the
  ctrl channel after spawn.
- `packages/core/native/core/gpu_process.cpp` — new argv arg for
  output backend.
- `packages/core/native/ipc/side_channel.h` — new message kinds:
  `SetDrmFd` (mentioned in `architecture.md` already), `OutputPause`,
  `OutputResume`, `OutputDescriptor`.
- `packages/core/src/main.ts` — backend selection + wiring the new
  output-descriptor channel into `state.outputs`.

CMake / build glue: pull libdrm, libgbm, libinput, libseat, libudev
via `pkg-config`. Gate behind `OVERDRAW_KMS=ON` (default ON on Linux).

## Slice order

To validate the design with the smallest end-to-end paths first, in
dependency order. Each slice is committable, leaves the existing
nested path working, and produces something demonstrable before the
next slice starts.

### Slice 1 — libseat + libinput (no display changes) ✅ landed

The smallest end-to-end. The existing nested compositor keeps working
on the host Wayland session for display; input is the only thing
that swaps.

- New `Seat` class (libseat wrapper) in the core.
- New `LibinputBackend` in the core, parallel to
  `WaylandInputBackend`. Paired with the output backend (no separate
  env var): `--backend=kms` uses libinput, `--backend=nested` uses
  `WaylandInputBackend`.
- Add to CMake; minimal config-driven enable.

Validation: run the existing nested compositor on the remote box from
SSH, GDM stopped. Cursor moves the right way, clicks land on real
clients (`foot` / `kitty`), keyboard input arrives via libinput. The
existing GPU-tests for input continue to pass on the test box.

This slice is mostly additive — it doesn't replace the existing
`WaylandInputBackend`; it adds a sibling. Easy to back out if libseat
or libinput integration hits an unknown.

### Slice 2 — output-backend seam (refactor only, no new backend) ✅ landed

Lift `HostWindow` behind an `OutputBackend` interface. The GPU
process's `main.cpp` builds a `HostWindowOutputBackend` and drives it
through the new abstract interface. No behavior change.

Validation: every existing test continues to pass (nested mode is
unchanged). Refactor commit.

### Slice 3 — `wl_output` real (for the nested backend) ✅ landed

The host backend reports its real output descriptor (host
`wl_output`'s actual mode, scale, geometry) via the new
`OutputDescriptor` side-channel message; the core's `state.outputs`
emits real `wl_output` events to clients. Still no KMS.

Validation: a client (`foot`) sees the real refresh rate / size /
make / model instead of fabricated values. `wl_output_get_make` /
`wl_output_get_model` return the host's values.

This is the long-standing `wl_output` gap (`status.md` "Read first")
landed without depending on KMS.

### Slice 4 — KMS minimal: scan out a solid color, page-flip-paced ✅ landed

**Slices 4 and 5 in the original plan are merged.** The original split (slice
4 = "scan out a solid color, timer-driven"; slice 5 = "real frame clock +
page-flip pacing") would have meant slice 4 ships a `uv_timer`-driven KMS
render loop that slice 5 then immediately rips out and replaces with
page-flip-driven scheduling. The slice-4 timer code would be throwaway.
Avoiding throwaway code is project policy, so the two are landed together.
`IN_FENCE_FD` (originally a slice-5 follow-on) is also included from day
one: at vsync rate there IS in-flight GPU work at commit time and the
fence matters; the original "defer to slice 5" was tied to "defer because
timer-paced slice 4 has no in-flight work," which goes away with the
merge.

The `KmsOutputBackend` brings up DRM/atomic on `eDP-1`, allocates the
GBM scanout ring (3 slots, LINEAR modifier), dual-imports as
`wgpu::Texture`, drives an initial atomic modeset, and from then on
runs the compositor's render loop on page-flip events: on
`DRM_EVENT_FLIP_COMPLETE`, the prior scanout slot moves to FREE and
the next render fires. The `uv_timer` is bypassed for KMS from day one.
`IN_FENCE_FD` rides each atomic commit so the kernel doesn't latch a
scanout buffer before the GPU finishes rendering into it.

No clients, no input routing yet — just "the laptop panel displays the
compositor's clear color, vsync-locked." The compositor's clear color
will be set to hot pink for slice-4 verification (revert to black
when slice 4 lands).

Validation: SSH to the remote box, `sudo systemctl stop gdm`, run
`overdraw --backend=kms`, the panel shows hot pink. `dmesg` / DRM
debugfs confirms our process is master on card1. Frame times
measured against the panel's vblank cadence. Kill the process; the
panel goes black (gdm not restarted yet). Restart gdm, desktop
returns.

This is the first time the project drives hardware. Everything from
here on is layering existing functionality on top.

`wl_buffer.release` continues to be gated on `onSubmittedWorkDone`.
Earlier drafts called this out as an "acknowledged deferral" with the
reasoning that a client buffer could be released while still being
scanned out. That reasoning was wrong given today's pipeline: the
compositor samples each client dmabuf into the scanout-ring slot's
texture (`acquireOutputTexture()` returns the slot texture; the render
pass writes into it). The client buffer is read-only-input, not the
scanout buffer itself. Once `onSubmittedWorkDone` resolves, the
client's pixels have been consumed; what continues to be scanned out
is the scanout slot, not the client buffer. If a future revision
introduces zero-copy direct-scanout (a client dmabuf assigned to the
plane), the concern returns and the gate must move to flip-complete;
until then no change is needed.

### Slice 5 — (merged into slice 4) ✅ landed

See slice 4.

### Slice 6 — libinput routed into real clients ✅ landed

Connect libinput input to the running KMS compositor. Real clients
(`foot`, `kitty`) become interactive on the bare-metal panel. The
input backend is paired with the output backend (`--backend=kms`
implies libinput; `--backend=nested` implies the WaylandInputBackend
host-forwarding path); there is no separate selector. The libseat
handle is shared: KMS bring-up opens the DRM card via libseat, and
libinput opens evdev devices through the same `Seat` (one libseat
instance per session).

Three secondary fixes landed alongside the input coupling, all
surfaced by the first real-client run on KMS:

- `acquireOutputTexture()` returning "no FREE scanout slot" as
  `nullptr` from N-API arrives in JS as `undefined`, not `null`.
  The JS check was `=== null` only, so on the very first frame
  before any slot was FREE the JS compositor fell through to
  `dawn.wrapTexture(deviceHandle, undefined)`, which threw and
  killed the node process. Fix: check both `null` and `undefined`.
- The core (node) addon lacked a crash handler. A SIGSEGV in the
  addon path left no artifact. Slice 6 adds a `SIGSEGV/SIGABRT/
  SIGBUS/SIGILL/SIGFPE` handler that writes a backtrace to
  `/tmp/overdraw-core-crash.txt` (mirroring the GPU process's
  handler in `gpu-process/src/main.cpp`).
- The per-frame disconnect sweep purges seat state referencing
  destroyed surfaces (clearing `seat.kbFocus`/`seat.focus`) and
  removes destroyed `wl_keyboard`/`wl_pointer` resources from
  the per-client sets. Without this, the second client to connect
  after a disconnect was disconnected by libwayland with "compositor
  tried to use an object from one client in 'wl_keyboard.leave' for
  a different client": `clientId` is the `wl_client*` pointer
  value, libwayland recycles those across disconnects, and the
  new client at a recycled address inherited the dead client's
  keyboards via `keyboardsByClient[recycled_ptr]`. Bug existed in
  nested too; only surfaced once slice 6 made client reconnect a
  routine path. This is also why the "buffer-release-via-flip-
  complete" deferral that earlier drafts of this slice carried is
  irrelevant — the compositor samples each client dmabuf into the
  scanout-ring slot rather than scanning the client buffer out
  directly, so the client buffer is consumed by
  `onSubmittedWorkDone` and the slice 4+5 gate is correct. See
  the slice 4+5 note above for the full reasoning; slice 6 leaves
  the buffer-release gate as-is.

Validation: launched `kitty` against the running KMS overdraw on
the 2560×1600 @165Hz Intel iGPU laptop with gdm stopped. The kitty
window renders on the bare-metal panel; keyboard and mouse input
work. Five sequential kitty connect/disconnect cycles against the
same overdraw also pass (regression coverage for the seat sweep).

### Slice 7 — VT switch ✅ landed

Implements `enable_seat` / `disable_seat` handlers + the side-channel
pause/resume. The seat callbacks are attached after compositor +
libinput bring-up (open() runs earlier, when those subsystems don't
yet exist; `Seat::setCallbacks` installs them later).

On `disable_seat` the core sends `OutputPause` to the GPU process
(stops atomic commits, drops any pending flip wait, resets the scanout
ring to FREE, clears `didInitialCommit_` so the next post-resume
present runs the ALLOW_MODESET path), calls `libinput_suspend` (which
fires `close_restricted` through the seat for every device fd), stops
the libinput libuv poll, and acks the disable to libseat. While paused
`acquireOutputTextureHandle()` returns null so the JS compositor skips
its frames.

On `enable_seat` the core calls `libinput_resume` (re-opens every
device through the seat -- libseat hands us fresh fds), restarts the
libinput libuv poll, and sends `OutputResume`. The next render's
ScanoutPresent re-runs the initial modeset.

Ctrl+Alt+Fn is wired through xkbcommon's `XKB_KEY_XF86Switch_VT_1..12`
keysyms: the keyboardKey handler intercepts those before forwarding,
calls `addon.switchVT(n)` which calls `libseat_switch_session(seat, n)`,
and the disable/enable lifecycle does the rest. Press AND release are
consumed so the focused client never sees the keys. `sudo chvt N` from
a separate SSH session also works (libseat's session-switch signal
fires either way).

Validation: on the 2560×1600 @165Hz Intel iGPU laptop with gdm stopped,
`Ctrl+Alt+F2` leaves overdraw cleanly (panel shows the bare TTY),
`Ctrl+Alt+F1` returns to overdraw with the open kitty window still
visible and interactive. `sudo chvt 2 && sleep 2 && sudo chvt 1` from
SSH produces the same round trip. Overdraw stays alive across the
switch, DRM master is released + reacquired cleanly, no leftover fds.

### Slice 8 — Documentation cleanup ✅ landed

Reconciles `status.md` and `architecture.md` against what slices 1-7
shipped. The `wl_output`-is-fabricated claim in `status.md` (and a
handful of cross-references) was stale -- slice 3 made it real -- so
those references are corrected, framed as "real but single-output."
The frame-clock entry in `status.md` "Read first" stays because the JS
render trigger remains a `uv_timer` in both backends (only the KMS
scanout-slot state machine is page-flip-driven); the language is
sharpened to reflect that. `architecture.md` "Phase 2 — bare metal"
gains a "Shipped (slices 1-7)" + "Deferred" block at the top, pointing
back here and to `status.md`. The session-supervisor mention in
`architecture.md` Phase 2 is explicitly called out as deferred (it was
never built; the core fork/execs the GPU process directly).

### Slice 9 — Flip-driven frame loop + tiled scanout ✅ landed

Replaces the 60Hz `uv_timer` frame trigger with a wake/runFrameIfReady
state machine driven by `ScanoutFlipComplete` (KMS) and `FrameComplete`
(nested host `wl_surface.frame` chain). `wake()` raises `wantNext`;
`runFrameIfReady` calls `notifyFrame` (JS dispatchFrameCallbacks + JS
renderFrame + JS presentOutput) when `wantNext && !flipPending && !inFrame`.
Idle scenes draw zero frames; subsystems with continuous work
(animation, transition, intercept, client commits) raise hands via
`wakeIfActive`. On every `onFrameComplete` the core runs
`Server::drainEvents` (non-blocking `wl_event_loop_dispatch`) before the
render so a client commit that arrived between the last server-pump and
the page-flip event is visible to `dispatchFrameCallbacks` this vsync,
not next.

Scanout candidate modifiers now try the plane's `IN_FORMATS` advertised
modifiers in advertised order (typically tiled-first), with
`DRM_FORMAT_MOD_LINEAR` appended last as fallback. The prior LINEAR-only
choice — added in slice 4 to dodge multi-plane CCS modifiers Dawn can't
import — also dodged perfectly-fine single-plane tiled modifiers
(`I915_FORMAT_MOD_X_TILED` / `_Y_TILED` / `_4_TILED`), making the
scanout target slow enough that the frame fence missed the kernel's
vblank deadline. `tryAllocateSlot` validates each candidate via Dawn
`ImportSharedTextureMemory`; multi-plane CCS modifiers self-reject and
we fall through. The slot's chosen modifier is logged at bring-up
(`[kms] scanout ring: ... modifier=0x...`).

`Server::stop` synchronously drains its `uv_close` pending list with
`uv_run(loop, UV_RUN_NOWAIT)` until clear. Without this, adding the
non-trivial `PumpHook` `std::function` member to `Server` was tripping
libuv's pending-close assertion at teardown.

Verified by client-paced burst: `test/shm-burst-client.c` (a wl_shm
client that does `attach + damage + frame + commit` and waits for
`done` before the next commit, recording avg `commit → done` wait
time) at 256×256 ARGB8888. Before: 80 commits/sec, avg-wait 12.5ms
(=2 vsyncs on a 165Hz panel; kernel skipping every other flip).
After: 154 commits/sec, avg-wait 6.5ms (=panel rate).

Deferred: full panel-rate validation with dmabuf clients (mpv hwdec /
foot etc.); large-upload `wl_shm` clients (4K software-decoded video)
may still serialize against vsync because each frame's `writeTexture`
write barriers against the previous frame's sample of the SAME
`s.texture` VkImage. Mitigation when this matters is a per-surface
texture ring (rotate the write target each commit so the new write
doesn't barrier against the previous sample); not done because it
costs 3× VRAM per shm surface. See `status.md` "Read first".

## Open points (all resolved; kept for the rationale)

These were the pre-slice-4 design questions. All resolved through slices
4-7; left here so the reasoning is preserved.

1. **Buffer release ordering with KMS** — RESOLVED: no change needed.
   The original analysis claimed `onSubmittedWorkDone` was wrong for
   KMS because "a client buffer can be released while still being
   scanned out." That doesn't match the pipeline: the compositor
   samples each client dmabuf into a scanout-ring slot texture; the
   client buffer is read-only-input, never the scanout buffer itself.
   `onSubmittedWorkDone` is the moment the compositor has finished
   reading the client buffer, which is the right gate for release.
   A future zero-copy direct-scanout path (a client dmabuf assigned
   to the plane) would resurrect this and require a flip-complete
   gate then; today's pipeline does not.
2. **GPU-process pump fairness.** The GPU process's epoll loop today
   multiplexes wire/ctrl/host-display fds. KMS adds the DRM fd. The
   fd-arming policy (arm-on-need) extends naturally, but worth
   confirming: a stuck DRM fd shouldn't starve the wire pump.
3. **What happens to the wire / Dawn / WSI swapchain abstraction
   when there's no `wgpu::Surface` to configure?** Today
   `acquireOutputTexture` / `presentOutput` go through Dawn's WSI.
   In KMS we have no `wgpu::Surface`. The GPU process side gets
   replaced (Slice 4); but the CORE-side wrapper that JS calls
   (`compositor.acquireOutputTexture`, status.md "Native services
   kept") needs the same shape. Simplest: it stays the same on the
   JS side; the GPU process's response uses the KMS scanout ring
   instead of WSI. The wire-side handle is just a wire-wrapped
   `wgpu::Texture` either way. Should be a transparent backend swap;
   confirm during slice 4.
4. **Dawn explicit-sync over KMS** — RESOLVED: included in slice 4+5
   from day one. Today's `onSubmittedWorkDone` plus implicit-sync on
   client-buffer dmabufs is not enough on the scanout side: the kernel
   could latch a scanout buffer before the compositor's render into it
   completes. Mitigation: export Dawn's submit-completion fence (the
   same primitive `OnSubmittedWorkDone` builds on) as a sync_file fd
   and attach it to each atomic commit via the plane's `IN_FENCE_FD`
   property. The kernel waits on the fence before scanning out.
   Originally proposed as a slice-5 follow-on; merged forward to
   slice 4+5 because slice 4+5 now runs at vsync rate where in-flight
   GPU work is the steady state.
5. **GPU selection: Dawn adapter + render node follow the scanout card**
   — RESOLVED. Hybrid laptops have multiple Vulkan adapters; relying on
   `EnumerateAdapters()[0]` (and a hardcoded `renderD128` allocator)
   only worked because both happened to resolve to the same GPU. Now the
   GPU process matches explicitly: it `fstat`s the scanout card fd for
   the DRM primary major:minor and selects the adapter whose
   `WGPUAdapterPropertiesDrm.primary{Major,Minor}` equals it; the GBM
   allocator's render node is derived from that adapter's
   `render{Major,Minor}` (`/dev/dri/renderD<minor>`). Allocation and the
   wgpu device therefore always sit on the GPU that owns the connected
   card. No matching adapter is a hard error (cross-GPU scanout
   unsupported). `WGPUAdapterPropertiesDrm` was confirmed populated for
   both Intel Mesa and the NVIDIA proprietary driver on the test box; a
   driver that does not populate it fails the match rather than silently
   diverging.

## Verification target ✅

The architecture-doc claim "phase 2 bare metal (DRM/KMS)" is met for a
single-output, single-GPU, software-cursor configuration. From a user's
perspective:

- SSH to a Linux box with no graphical session running.
- `overdraw --backend=kms` on the local TTY.
- The panel lights up; kitty (and other Wayland clients) runs;
  keyboard and pointer work; `Ctrl+Alt+Fn` (or `sudo chvt N`) switches
  away cleanly and switches back without state loss.

Verified on the 2560×1600 @165Hz Intel iGPU laptop (`lenovo-ubuntu`,
`/dev/dri/card1`). Everything beyond (multi-output, hardware cursor,
NVIDIA-driven scanout, hotplug, mode changes, DRM lease) is
incremental on the same skeleton.
