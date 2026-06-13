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
- **NVIDIA proprietary as KMS target.** The architecture admits it, but
  the v1 development target is Intel i915 on the test box. NVIDIA is
  out of scope for v1 (kept as a known limitation, not a stub).
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
- `--card=<path>` (default: the first card libseat hands back; an
  override is useful on hybrid GPUs like the test box where you might
  want card1 specifically).

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

### Slice 1 — libseat + libinput (no display changes)

The smallest end-to-end. The existing nested compositor keeps working
on the host Wayland session for display; input is the only thing
that swaps.

- New `Seat` class (libseat wrapper) in the core.
- New `LibinputBackend` in the core, parallel to
  `WaylandInputBackend`. Selectable via env var
  (`OVERDRAW_INPUT_BACKEND=libinput|wayland`).
- Add to CMake; minimal config-driven enable.

Validation: run the existing nested compositor on the remote box from
SSH, GDM stopped. Cursor moves the right way, clicks land on real
clients (`foot` / `kitty`), keyboard input arrives via libinput. The
existing GPU-tests for input continue to pass on the test box.

This slice is mostly additive — it doesn't replace the existing
`WaylandInputBackend`; it adds a sibling. Easy to back out if libseat
or libinput integration hits an unknown.

### Slice 2 — output-backend seam (refactor only, no new backend)

Lift `HostWindow` behind an `OutputBackend` interface. The GPU
process's `main.cpp` builds a `HostWindowOutputBackend` and drives it
through the new abstract interface. No behavior change.

Validation: every existing test continues to pass (nested mode is
unchanged). Refactor commit.

### Slice 3 — `wl_output` real (for the nested backend)

The host backend reports its real output descriptor (host
`wl_output`'s actual mode, scale, geometry) via the new
`OutputDescriptor` side-channel message; the core's `state.outputs`
emits real `wl_output` events to clients. Still no KMS.

Validation: a client (`foot`) sees the real refresh rate / size /
make / model instead of fabricated values. `wl_output_get_make` /
`wl_output_get_model` return the host's values.

This is the long-standing `wl_output` gap (`status.md` "Read first")
landed without depending on KMS.

### Slice 4 — KMS minimal: scan out a solid color

The `KmsOutputBackend` brings up DRM/atomic on `eDP-1`, allocates the
GBM scanout ring, dual-imports as `wgpu::Texture`, and the JS
compositor renders the (currently empty) compositor scene into it.
No clients, no input routing — just "the laptop panel displays the
compositor's clear color, driven by page-flips."

Validation: SSH to the remote box, `sudo systemctl stop gdm`, run
`overdraw --backend=kms`, the panel shows the clear color. `dmesg` /
DRM debugfs confirms our process is master on card1. Kill the
process; the panel goes black (gdm not restarted yet). Restart gdm,
desktop returns.

This is the first time the project drives hardware. Everything from
here on is layering existing functionality on top.

### Slice 5 — Real frame clock + page-flip pacing

Wire the KMS page-flip event into the compositor's render loop.
Render is gated on flip-complete; the `uv_timer` is bypassed for KMS.

Validation: a moving rectangle (or `foot` with a cursor blinking)
runs at the panel's native refresh, with no tearing. Frame times
measured at the panel's vblank cadence.

### Slice 6 — libinput routed into real clients

Connect Slice 1's libinput input to the running KMS compositor. Real
clients (`foot`, `kitty`) become interactive on the bare-metal panel.

Validation: launch `foot` over SSH against the running KMS overdraw,
type into it, click on it. Everything that worked nested now works
on KMS.

### Slice 7 — VT switch

Implement `enable_seat` / `disable_seat` handlers + the side-channel
pause/resume. Test: `chvt 2` while overdraw is running; the panel
goes blank cleanly (GDM/etc would take over if it were on vt2, in
practice it's empty); `chvt 1` returns to overdraw without crashing.

Validation: VT switching does not crash the GPU process or leak the
DRM master. The before/after pixel output is identical (render state
preserved across the pause).

### Slice 8 — Documentation cleanup

`status.md` "Read first" entries that are now done (`wl_output`
fabricated; frame clock is a timer for the KMS path) are removed or
moved. `architecture.md` "Phase 2" references are updated to reflect
what shipped vs what's still deferred (multi-output, hardware
cursor, NVIDIA).

## Open points (resolve before slice 4)

1. **Buffer release ordering with KMS.** Today the JS compositor's
   `buffer-release lifecycle` uses `onSubmittedWorkDone` to release a
   client buffer once the compositor's submit completes. With KMS, a
   client buffer is still being sampled until the scanout slot that
   sampled it FLIPS — and we need the flip event, not just submit
   completion, to release. This means an extra serial chain
   (compositor submit → flip-complete → buffer release). Where does
   the flip-complete fan-in live (GPU process side-channel message →
   core's `client-buffer-lifecycle.ts`)?
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
4. **Dawn explicit-sync over KMS.** Today, client-buffer dmabufs
   carry implicit-sync read fences exported via
   `DMA_BUF_IOCTL_EXPORT_SYNC_FILE`. For KMS scanout we should pass
   the compositor's submit-completion fence via the atomic commit's
   `IN_FENCE_FD` property so the kernel doesn't latch the buffer
   before our render is done. This is straightforward but easy to
   miss — flagging it now.
5. **NVIDIA scoping.** The test box has an NVIDIA GPU as a render-
   capable but display-disconnected card; v1 ignores it. If we ever
   target Optimus laptops with the dGPU as the active display, that's
   its own work. Worth saying loudly that v1 = i915-only as a known
   limitation.

## Verification target

Slice 6 done = the project meets the architecture-doc claim "phase 2
bare metal (DRM/KMS)" for a single-output, i915-only, software-cursor
configuration. From a user's perspective:

- SSH to a Linux box with no graphical session running.
- `overdraw --backend=kms` on the local TTY.
- The panel lights up; foot / kitty / WSI clients run; keyboard and
  pointer work; you can `chvt` away and back.

That's the bar for declaring this design closed. Everything beyond
(multi-output, hardware cursor, NVIDIA, hotplug) is incremental on
the same skeleton.
