# overdraw — implementation status

Ground truth for what exists right now: current capabilities, known gaps,
and what remains. The design lives in `architecture.md`; per-phase narrative,
test counts, and historical rationale live in `status-detailed.md`. This
file is the short read; consult the detailed doc when investigating a
specific subsystem.

Last updated: 2026-07-12. Recent landings: commit-timing-v1 (per-surface
timed commits latched at their target presentation-clock time; see the
protocol list below). Prior: per-keyboard keymaps with
active-keyboard arbitration (virtual keyboards honor their own keymap +
modifiers); a protocol-wide audit pass that fixed event version-guard
client-aborts (data-control DnD actions, xdg-output name/description +
wl_output.done, foreign-toplevel parent) and a batch of completeness fixes
(wm_capabilities, eager presentation clock_id, fractional_scale_exists,
lax data-control reuse, layer-surface closed on output-destroy, high-res
scroll value120/relative_direction, buffer offset for DnD/popups,
set_fullscreen output targeting). Prior: open/retile window animations
(premap sizing + `window.opening` hook + map-ack hold gated on an active
animation), open-slide direction, and the decorated-window (intercept)
flicker fix via render-reports-rendered; see the deferred items in
"Read first" below. Prior: Xwayland Phase 4
(CLIPBOARD + PRIMARY selection bridge, both directions, with INCR for
>64 KiB payloads; xcb-xfixes integration; 6 new selection GPU tests
including two INCR end-to-end + TIMESTAMP-target reply; one
wl->X INCR continuation-race fix). Prior: M7 steps 4 + 5 (JS hotplug
handlers, workspace migration on `output.added`/`removed` with durable-
identifier reclaim, cross-fd race fix moving `ScanoutReserve`/
`ScanoutReady` to the wire socket -- hardware-verified two-monitor
unplug/replug).

## Read first: gaps in advertised protocols (silent-gap risks)

These are wired/advertised but incomplete. A client may use them and get
nothing, with no error. Worst-first.

- **NVIDIA proprietary clients work; both explicit-sync and a Dawn dmabuf-
  import fix were needed.** `wp_linux_drm_syncobj_v1` is implemented
  (manager + timeline + per-surface; per-commit acquire/release points
  captured in `wl_surface.commit`). On a dmabuf commit, the acquire point
  is exported as a sync_file and attached as SCM_RIGHTS to a `kind=5`
  `BeginAccessWithFence` wire frame; the GPU process uses it as the Dawn
  acquire fence. The release point is signaled at the same atomic moment
  `sendWlRelease` fires. Implicit-sync remains as the fallback.

  Dawn-side fix: `SharedTextureMemory::Create` for dmabuf descriptors now
  queries `VkMemoryDedicatedRequirements` and passes
  `VkMemoryDedicatedAllocateInfo` when required. Lives in the bundled Dawn
  at `src/dawn/native/vulkan/SharedTextureMemoryVk.cpp`. Without it,
  tiled-modifier dmabufs on NVIDIA sampled as transparent/garbage
  (vkAllocateMemory succeeded but VkDeviceMemory was not actually bound to
  the dmabuf-backed memory).

- **Nested-mode present uses implicit-sync; explicit-sync to the host not
  wired.** In nested mode we present by attaching our scanout dmabuf to
  the host `wl_surface` and committing. The producer EndAccess sync_file
  fd is NOT forwarded to the host as a `wp_linux_drm_syncobj_v1` acquire
  timeline point (we don't bind that protocol on the host connection).
  We rely on the kernel's dma-buf reservation fence, which Mesa attaches
  on queue submit. Correct on Mesa. NVIDIA proprietary does NOT attach
  implicit fences, so a nested overdraw running on NVIDIA against a host
  that requires explicit-sync will sample stale/torn frames. The fix is
  binding the host's `wp_linux_drm_syncobj_manager_v1`, holding a
  syncobj_surface for our wl_surface, and signaling an acquire-timeline
  point per commit from the captured sync_file.

- **`xdg_toplevel` window-management state is implemented; residual no-ops
  are narrow.** `set_maximized`/`unset`, `set_fullscreen`/`unset`,
  `set_minimized`, `set_min_size`/`set_max_size`, and interactive
  `move`/`resize` route through `wm.propose` and take effect. The next
  configure carries resolved state in its states array. `set_parent`
  drives stacking via the "raise-with" rule (a modal child always
  raises with its parent; a non-modal child raises with a managed
  parent but is independent of a floating parent). **Genuinely still
  no-op / limited:** `show_window_menu` (no compositor-side menu);
  `set_fullscreen` per-output target hint ignored (single output);
  reserved-zone exclusion applies to maximized/tiled but not floating.

- **Modality is a first-class concept (`WindowState.modal`), separate
  from `parent`.** A modal window (set via `xdg_dialog_v1.set_modal`,
  `_NET_WM_STATE_MODAL`, or `sdk.windows.propose({ modal: true })`)
  triggers two behaviors. (1) **Focus tethering**: if the modal's
  parent chain has keyboard focus at the moment the modal becomes
  modal, focus is transferred to the modal; if focus is somewhere
  else, the modal opens quietly without stealing. On modal close /
  `modal=false`, focus returns to the modal's live parent (if any).
  (2) **Strict input gating**: a hit on any window in a modal's
  ancestor chain redirects to the topmost visible modal descendant.
  Non-modal children do NOT gate -- a floating dialog of a floating
  parent stays independently interactive. Orphan modals (parent gone)
  become non-blocking floating windows; the WM does not auto-close
  transient children when their parent closes (toolkit-level
  concern).

- **`WindowState` splits the orthogonal axes and separates client
  requests from compositor decisions.** `WindowState` carries four
  decision fields the compositor owns -- `tiling` (`managed |
  floating`), `exclusive` (`none | maximized | fullscreen`), `visible`
  (boolean), `modal` (boolean) -- plus a `clientRequests` sub-object
  (`wantsMaximized`, `wantsFullscreen`, `wantsMinimized`, `wantsModal`)
  that records the client's stated wishes. The renderer + the
  configure-states encoder read the decision fields only; the policy
  seam reads `clientRequests`.

  - `xdg_toplevel.set_maximized` writes `clientRequests.wantsMaximized
    = true`; it does NOT directly touch `exclusive`. Same for
    set_fullscreen / set_minimized and their unset_ counterparts.
    Interactive move/resize and plugin-driven layout decisions write
    `tiling`/`exclusive`/`visible` directly.
  - `resolveDecisions(prev, candidate, phase)` is the default policy.
    Pre-content `wantsMaximized` is **suppressed by default** (the
    GTK/Qt startup boilerplate case); pre-content `wantsFullscreen` is
    honored (matches sway/hyprland for video apps); post-content
    requests are honored on both axes. A window-rules plugin overrides
    via `window.preconfigure` (for first-content) or `window.proposed`
    (for later changes).
  - The xdg_toplevel.configure encoder reads `tiling`/`exclusive`/
    `visible` only. A client whose `wantsMaximized` was declined sees
    a configure with no maximized state (spec-correct: "the compositor
    responds with a configure event without the maximized state").
  - The layout-driver reads `exclusive` and `visible` directly:
    when any window on an output has `exclusive !== "none"`, only that
    window is laid out (peers suppressed); invisible windows are
    omitted from `rects[]` entirely. `LayoutResult.hidden` is gone.
    `wm.applyLayout` already iterates only the ids in `rects[]`, so
    omitted windows keep their geometry; `pushStack` filters by
    `visible` and the per-output exclusive owner so invisible /
    peer-suppressed windows are not in the draw stack.

- **`wl_region` is implemented; only the opaque region is unconsumed.**
  `add`/`subtract` build a real disjoint rect list (`region.ts`) snapshotted
  at commit per copy-semantics. **Input** regions ARE consumed: hit-testing
  calls `Region.contains` (`surface-hit-test.ts` `inputRegionAccepts`, gated
  in both the subsurface walk and the root). The remaining gap is the
  **opaque** region (a render optimization hint) -- stored but not used to
  skip occluded draws. Low urgency.

- **`wl_surface.damage` / `damage_buffer` upload damage is implemented for
  shm; residual gaps are narrow.** Damage rects are accumulated (double-
  buffered, promoted on commit), reconciled to buffer coordinates, and
  `uploadPixels` issues one `queue.writeTexture` per damage rect into the
  surface's persistent texture. A 4K shm client changing a 200×50 status
  bar uploads ~40KB, not 32MB. Residuals: (a) surface-coordinate `damage`
  combined with non-normal `buffer_transform` or an active viewport falls
  back to full-surface upload -- `damage_buffer` (what GTK/Qt/SDL/terminals
  use) is always honored; the fallback only costs the optimization, never
  correctness. (b) dmabuf is imported wholesale.

- **Composite-scissor damage is implemented; residual gaps are narrow.**
  Per-scanout-slot damage tracked in output coords with buffer-age
  awareness. Damaged regions render with `loadOp:"load"` + black-fill;
  whole-output or first-sight slots take the full clear path. Residuals
  (optimization-only, never correctness): (a) scissor is the damage
  **bounding box**, not per-rect, so scattered damage over-draws; (b) only
  content commits, layout move/resize, cursor moves, and surface removal
  produce precise rects -- stack reorders and bounds-affecting fx
  (transform/margin/mask, animated opacity) conservatively damage the
  whole output; (c) a content commit damages the surface's full output
  rect, not Layer-1 buffer damage mapped to an output sub-region.

- **Large shm clients (e.g. fullscreen software-decoded video) may
  serialize against vsync.** Each `wl_surface.commit` with new shm content
  triggers a `queue.writeTexture` upload in the same vkQueueSubmit as the
  compose pass that samples it. Vulkan inserts a write-after-read barrier
  against the previous frame's sample. For large uploads (4K video at
  ~32MB/frame is the canonical concern) the combined CPU memcpy + GPU
  copy + barrier wait may push GPU completion past the vblank deadline.
  Real dmabuf-producing video clients (mpv `--hwdec=auto`, VLC vaapi)
  are unaffected. Mitigation: per-surface ring of textures (not built);
  damage helps for partial updates but not for full-frame video.

- **`wl_resource_post_error` is wired; request-time errors post, some
  commit-time ones still drop.** A native `addon.postError(resource, code,
  message)` (`trampoline.cpp` → `wl_resource_post_error`) disconnects the
  client with the spec'd error; handlers pass typed codes from the generated
  `<Iface>_Error` consts. **Now posted:** `wl_surface.invalid_scale` /
  `invalid_transform`, `wp_viewporter.viewport_exists`, `wp_viewport.bad_value`,
  `wp_cursor_shape_device_v1.invalid_shape`, `wl_pointer.role` (set_cursor on a
  roled surface), `zxdg_toplevel_decoration_v1.already_constructed`,
  `wp_linux_drm_syncobj_manager_v1.surface_exists`,
  `wp_fractional_scale_manager_v1.fractional_scale_exists`. End-to-end test:
  `test/post-error.test.js` + `wl-error-client`. **Still silent (deliberate,
  each commented why):** commit-time errors that would need ctx threaded into
  state-only apply functions (`zwlr_layer_surface_v1.invalid_size` /
  `invalid_exclusive_edge`, layer-shell pre-configure buffer, syncobj
  acquire/release point checks); cases that conflate a client violation with a
  driver/teardown fallback (`invalid_timeline`, syncobj `no_surface`);
  ambiguous ones (subsurface place_above/below bad sibling).
  `zwlr_output_manager_v1` correctly uses its own `cancelled`/`failed` events,
  not `post_error`.

- **Per-keyboard keymaps with active-keyboard arbitration are implemented;
  residuals are narrow.** Each keyboard owns its own keymap: the default seat
  keymap (system RMLVO, `native/wayland/keymap.{h,cpp}`) plus one per
  `zwp_virtual_keyboard_v1` that supplied a layout (`Keymap::initFromFd`
  compiles the client fd and re-serializes to a sealed memfd). The seat makes
  the keyboard that last typed active (`addon.setActiveKeymap`, driven off the
  per-key `keymapId`): `keyUpdate`/`keymapInfo` then read that keymap, so a
  virtual device's keys resolve and report modifiers under its own layout, and
  on a switch the new keymap is re-sent to every bound `wl_keyboard`. A real
  keystroke (keymapId 0) restores the default. This replaces the earlier
  single-global-keymap simplification (which silently interpreted virtual-
  keyboard keys under the seat's layout). overdraw needs only this arbitration
  (real vs. each virtual keyboard), not wlroots's keyboard-group machinery,
  since libinput already merges the physical keyboards into one stream — so
  two physical keyboards with different layouts still cannot coexist (one real
  keyboard, by construction). `zwp_virtual_keyboard_v1.modifiers` is honored:
  the explicit mask is applied to the device keymap's xkb state
  (`addon.setModifiers` → `xkb_state_update_mask`) so a subsequent key resolves
  under it, and the canonical masks are forwarded to the focused client.
  Verified by `test/keymap-arbitration.test.js` (native register/switch/
  keyUpdate/setModifiers/unregister round-trip) and
  `test/virtual-keyboard.test.js` (handler tagging + teardown); not yet
  hardware-verified end-to-end with a cross-layout remote sender.

- **`ext_workspace_v1`: capability-gated requests are no-ops by design.**
  The compositor advertises only the `activate` and `remove`
  per-workspace capabilities (no `deactivate`, no `assign`) and only the
  `create_workspace` group capability. The protocol spec requires the
  compositor to ignore unadvertised requests, which is what this
  implementation does: `deactivate` / `assign` arrive as no-ops. The
  model justification: every output always has exactly one shown
  workspace (so "deactivate to nothing" has no meaning), and the plugin
  moves windows between workspaces (not workspaces between groups).
  `manager.commit` IS batched per spec: requests buffer per-manager
  between commits and apply atomically on commit; the bound manager
  sees exactly one `done` covering the entire batch, regardless of how
  many state events the batch triggers.
- **Smaller advertised-incomplete items:** `wl_subsurface` `place_above`/
  `place_below` sibling reordering (no-op); DnD drag-icon compositing
  (implemented, not pixel-tested); dmabuf `create` (async server-minted
  `wl_buffer`) not wired (only `create_immed`); single-plane dmabuf only;
  `zwp_linux_dmabuf_feedback_v1` is functional for WSI clients but not
  automatically asserted.
- **Interfaces pinned below the version their XML declares.** Protocol XML is
  vendored under `packages/core/protocols/` (wayland 1.25.0, wayland-protocols
  1.49) and `VERSION_PINS` in `tools/gen-protocol/pin.js` caps these interfaces,
  dropping the newer messages from the generated interface. The cap is what the
  global advertises, so a client cannot bind or reach the feature — no silent
  no-op — but the feature is unimplemented:
  - `wl_surface` at 6 (`wl_compositor` at 6 with it): v7 adds `get_release`, a
    per-commit buffer-release callback. The buffer-release lifecycle releases
    per buffer, not per commit, so a client re-using one buffer across several
    surfaces/commits gets no per-commit signal. Implementing it means tracking
    release callbacks as double-buffered commit state.
  - `zwp_linux_dmabuf_v1`, `zwp_linux_buffer_params_v1`,
    `zwp_linux_dmabuf_feedback_v1` at 5: v6 adds
    `set_sampling_device` (client picks the import device for the next `create`/
    `create_immed`) and the feedback tranche flag advertising it. Multi-GPU
    clients cannot steer imports.
  - `wl_data_device_manager` at 3: v4 adds a `release` destructor.
- **Deliberately deferred (sway/Hyprland skip these too, or they're
  unreachable here):** `xdg_positioner` reactive popups (`set_reactive` /
  `set_parent_size` / `set_parent_configure` are no-ops — popups don't
  auto-reposition when the parent moves; sway only re-unconstrains on
  commit/reposition, Hyprland skips entirely); `zwp_linux_buffer_params`
  `flags` (y_invert / interlaced / bottom_first) ignored, and multi-plane
  (YUV) import unreachable given only ARGB/XRGB are advertised; the
  `wl_surface` buffer offset is applied to the DnD icon + popups but NOT
  toplevel/subsurface placement (matches Hyprland); `ext_image_copy_capture`
  `paint_cursors` is accepted but not honored (cursor compositing into the
  captured frame is part of the broader capture work, alongside the shm-only /
  dmabuf-stub limitations above); `wl_seat.get_touch` /
  `wp_cursor_shape.get_tablet_tool_v2` with no advertised capability return an
  inert object rather than posting an error (matches Hyprland; sway errors).
- **`sdk.compose` window-rendering flattens subsurfaces on every production
  path, at device scale, across both transports.** Screen capture
  (`composeOutput`/`composeRegion`), `sdk.compose.scene` (snapshot + live), and
  `sdk.compose.windows` (snapshot) all expand window subtrees (decoration +
  toplevel + subsurfaces, via `computeBaseStack`) and compose at device scale.
  The flatten + output-region resolution is one shared step (`sceneDrawParams`
  in `compose-sdk.ts`, backed by `makeComposeFlatteners`), used by BOTH the
  in-thread SDK (`composeRegion`/`registerLiveScene`) and the Worker GPU broker
  (`composeIntoView`), so subsurface expansion and device-scale mapping have one
  source of truth regardless of transport. The in-thread SDK returns null rather
  than a subsurface-dropping fallback if a host doesn't wire the flatteners; the
  Worker broker takes `sceneFlatten` (wired in `main.ts` + the harness) and falls
  back to the raw window list only for older test rigs that don't exercise
  subsurfaces. `sdk.compose.scene` LIVE re-flattens every frame
  (`registerLiveScene` takes a `getDrawList` callback re-evaluated per frame; the
  Worker live ring re-flattens in its per-frame `onFrame`), so subsurfaces
  committed after registration are picked up. The subsurface-dropping
  `composeScene`/`composeWindows` primitives were deleted. One narrow residual
  remains: `registerLiveWindows` (the in-thread `sdk.compose.windows` LIVE path)
  still composes a fixed per-window list at logical scale; it is unused by
  bundled plugins.

- **`sdk.compose.windows` is in-thread-only.** Worker variant throws "not
  yet implemented for Worker plugins" (loud failure, not silent).
  Deferred until a real use case forces it. `sdk.compose.scene` works
  for both transports.

- **Hotplug-replug does NOT restore the monitor's prior logical
  position.** The workspace plugin reclaims a returning monitor's
  workspaces by durable identifier (edidId, else connector name), so
  windows reappear there. But `logicalPosition` is recomputed by the
  fallback policy (right of rightmost, top-aligned) every time -- so a
  monitor that was on the LEFT before unplug reappears on the RIGHT
  after replug. Fix is a separate follow-up.

- **Advertised-incomplete protocols (clients warn and fall back):**
  text-input, xdg-activation, toplevel-icon, system-bell. See the
  protocol-coverage matrix below for what is implemented; see
  `docs/protocol-coverage.md` for the gap analysis vs. sway / hyprland
  and the suggested landing order for what isn't.

- **`ext_image_copy_capture_v1` advertises shm destinations only; dmabuf
  destinations and the cursor sub-session are stubbed.** Sessions
  send `shm_format(argb8888, xrgb8888)` + `buffer_size` + `done` and
  emit NO `dmabuf_format` / `dmabuf_device` events. Per-frame cost is
  a full GPU→CPU readback (`copyTextureToBuffer` + `mapAsync`) plus a
  memcpy into the client's writable shm mapping. Impact per client:
  - **Works fine:** `grim` (one-shot PNG screenshot, always shm),
    `xdg-desktop-portal-wlr` shm path (Firefox/Chrome WebRTC,
    portal-mediated screen-share), OBS's shm fallback, GNOME-style
    screenshot tools.
  - **Refuses to record:** `gpu-screen-recorder` and any client that
    hard-requires dmabuf (sees no `dmabuf_format` in the constraints
    burst, finds no acceptable choice, backs off cleanly).
  - **Works but CPU-bound at high res:** OBS native ext-image-copy-
    capture + wf-recorder + live-streaming setups at 4K@60 — the
    ~32 MB/frame readback at 60Hz (~1.9 GB/s) saturates a memory
    channel that dmabuf would have avoided. 1080p is fine.

  The gap is that importing a client dmabuf as a Dawn render/copy
  target on the core process's compositing device needs
  `SharedTextureMemory` machinery that lives in the GPU process today
  — the existing `createTextureFromDmabuf` import is sampler-only via
  the GPU process (`TextureBinding` usage, perpetual `BeginAccess`,
  no `EndAccess` until teardown). A render-target import path would
  need: (a) a new wire frame analogous to `ImportClientTex` but with
  `RenderAttachment | CopyDst` usage and proper per-frame
  `BeginAccess`/`EndAccess` brackets; (b) per-modifier usage probing
  against Dawn — most tiled modifiers (NVIDIA PCI_BAR1 etc.) reject
  `RenderAttachment`, so the compose path likely has to go through
  an intermediate texture + `copyTextureToTexture` for those; (c) a
  release-lifecycle tracker for the imported textures. Sized roughly
  3-5 days, with portability work likely on top (the bundled Dawn
  already needed a dedicated-alloc fix for sampler-only dmabuf on
  NVIDIA tiled modifiers — render-target imports likely surface a
  similar second round). Before sizing for real, spike: probe whether
  Dawn's `SharedTextureMemory::Create` accepts `RenderAttachment |
  CopyDst` for representative Mesa + NVIDIA client modifiers.

  The cursor sub-session
  (`ext_image_copy_capture_cursor_session_v1.get_capture_session`)
  is a similar stub: it constructs the inner session but advertises
  zero formats + done so clients gracefully read "cursor capture not
  available."

- **Intercept-worker teardown is handshake-gated** (was a ~24% flake in
  `test/intercept-worker.gpu.mjs` with a GPU-process abort). Two guards:
  the broker parks an unmatched Worker surface's rings until the worker
  acks its loop stopped (`intercept.unmatch-ack`, 1s timeout for a dead
  worker), and the GPU process drops -- rather than aborts on --
  plugin-wire brackets naming a released surfaceBuf (frames already in
  flight when the release lands; the two sockets have no cross-fd
  ordering). Residual: a worker wedged past the timeout can still race
  its own straggler frames, which the drop path absorbs.

- **Retile shrink animates the new (smaller) buffer upscaled.** When an
  existing window shrinks on a layout reshuffle (e.g. 1->2 windows,
  full->half), its open/retile animation scales the NEW half-width
  buffer up to look full and tweens down, so the reflowed content reads
  as "small content upscaled" rather than the old content shrinking. Root
  cause: the resize transaction (holds the OLD geometry until the client
  re-renders at the new size) and the `window.relayout` RETILED animation
  (presnaps a transform ASSUMING the new geometry is already applied)
  both own the same resize and fight. Not yet fixed; the open path (new
  window) is correct.

- **Intercept idle CPU not fully ~0%.** The decorated-window flicker is
  fixed (the intercept output is damaged + recomposited only when the
  plugin reports it rendered -- `render()` may return `false`, gated on
  `ctx.contentChanged` + a per-surface content epoch; the decoration
  returns `false` when content/focus/dims/placement are unchanged). The
  GPU composite is gated, but the frame loop still WAKES every frame
  while any intercept is registered (the broker stays active and ticks;
  the plugin early-returns). GPU idles; CPU does not reach ~0%. Fix
  (deferred): broker stops waking when all intercepts skip and re-wakes
  on content/focus. Also outstanding: a dedicated test for the
  render-returns-`false` / `contentChanged` behavior (covered indirectly
  by the decoration + intercept-inthread GPU tests, not in isolation).

## Verification environment

All "verified" claims were exercised on a single machine, single driver
-- nothing is proven portable:

- NVIDIA GeForce RTX 5060 (GB206, Blackwell), proprietary driver
  595.71.05, Vulkan backend.
- A live host Wayland session, overdraw running nested.
- Bare-metal KMS verified on a 16" 2560×1600 @165Hz Intel iGPU laptop
  with gdm stopped + seatd active.
- Dawn wire `jhanssen/dawn` `v20260531-linux-wayland-wire-alpha2`
  (`6cfd29c89b`); `dawn.node` `v20260531-linux-wayland-wire-alpha`
  (`f01cb22e5c`).

## Running from a bare TTY: session bus

When overdraw is launched from a bare TTY / getty / SSH session (no
existing graphical session), there is no `DBUS_SESSION_BUS_ADDRESS` in
the environment. GTK4 (and any other client that talks to portals /
accessibility / GSettings over dbus) will then block on a connect-with-
timeout to a nonexistent session bus for every service it probes,
adding ~20-30s of dead time before its first wayland call. The symptom
looks like "the compositor is slow to map the window" but the wayland
exchange itself is fast (~200ms once it starts); WAYLAND_DEBUG=client
shows a long silent gap before any request.

Workarounds (pick one):
- `dbus-run-session -- overdraw` -- starts a private session bus that
  dies when overdraw exits.
- `eval "$(dbus-launch --sh-syntax)" && export DBUS_SESSION_BUS_ADDRESS
  DBUS_SESSION_BUS_PID` in the launch shell, then run overdraw and
  client apps from the same shell.

No overdraw-side fix; documented here so the diagnosis is in one place.

Related but fixed in-tree: `XDG_SESSION_TYPE`. A bare-TTY login session
carries `XDG_SESSION_TYPE=tty`, and clients that pick their windowing
backend off the session identity (Chrome selects Ozone/Wayland only under
`XDG_SESSION_TYPE=wayland`; otherwise it silently runs through Xwayland,
where e.g. WebGPU is much slower) would go X11 even with `WAYLAND_DISPLAY`
set. `main.ts` exports `XDG_SESSION_TYPE=wayland` (and
`XDG_CURRENT_DESKTOP=overdraw` when unset) at startup so all spawned
children inherit the wayland identity.

Also fixed in-tree: user-bus services. xdg-desktop-portal (and its
backends, notification daemons, etc.) are per-USER, not per-session:
they bind whichever `WAYLAND_DISPLAY`/`DISPLAY` the systemd/D-Bus user
environment held when they were activated. A portal activated by another
session opens its dialogs on that session's display (symptom: Chrome's
portal file picker "never shows" -- it showed on the other compositor).
On the kms backend, `main.ts` publishes `WAYLAND_DISPLAY`, `DISPLAY`,
`XDG_CURRENT_DESKTOP`, `XDG_SESSION_TYPE` via
`dbus-update-activation-environment --systemd` (fallback `systemctl
--user set-environment`) at startup and unsets them on shutdown
(`session-env.ts`; same scheme as Hyprland's startCompositor).
Nested mode never publishes (it would steal the host session's
services); `OVERDRAW_NO_SD_VARS=1` opts out entirely. Two caveats:
(a) portal processes already running keep their old binding -- restart
them (`systemctl --user restart xdg-desktop-portal
xdg-desktop-portal-gtk`) after the first overdraw session, or log out;
(b) no installed portal backend matches the `overdraw` desktop name, so
FileChooser needs `~/.config/xdg-desktop-portal/overdraw-portals.conf`
with `[preferred]` / `default=gtk`. Running a second compositor session
concurrently under the same user inherently fights over these
singletons; that is an ecosystem limitation, not overdraw's.

## Architecture as built

Two processes: a core (Node + N-API addon, Dawn wire client, JS
compositor + Wayland server + plugin runtime) and a separate native
GPU process (Dawn native + wire server + KMS/Wayland output backend).
The core fork+execs the GPU process and reaps it on shutdown.

**Sockets:**
- **Dawn wire** (`SOCK_STREAM`, length-prefixed kind-tagged frames).
  `kind=0` is Dawn wire bytes; other kinds are overdraw control frames
  (Begin/End access, ImportClientTex, BeginAccessWithFence,
  ScanoutReserve/Ready, SwitchMode, ScanoutRebuild, AllocSurface/
  ComposeBuf + reply, ReleaseSurfaceBuf, ReleaseClientTex, OutputAdded/
  Removed).
- **Control side channel** (`SOCK_SEQPACKET`, fixed-size POD). Reserved
  for boot handshake, hard-kill, wire-fd-passing, plus a few tags with
  no wire dependency. See "Why wire, not ctrl" in `architecture.md`.
- **Input** (`SOCK_SEQPACKET`, dedicated so unsolicited input never
  interleaves with request/reply).

All fds non-blocking; writers buffer + drain on writable. Wire FIFO
between dependent messages is the load-bearing invariant. The
historical cross-fd race class (e.g. `ProducerBegin` overtaking
`AllocSurfaceBuf` on independent fds) is closed by moving those messages
onto the wire; a few legacy tags remain on ctrl for historical reasons
(do not add to that list).

**JS layer:** core C++ + Node. Compositor + WM + protocol handlers +
plugin runtime live in TypeScript. WebGPU exposed via a wire-retargeted
`dawn.node`. Server-side Wayland (`wl_event_loop`) integrated into the
libuv loop. Steady-state present loop is libuv-driven (`uv_poll` on the
wire fd; renders fire from `runFrameIfReady` on `wake()` or frame-
complete -- no `uv_timer`).

**GPU process threading:** single-threaded pump today (wire decode +
HandleCommands + DeviceTick + present). Thread-per-connection is
designed but not built.

### Compositing (JS over the Dawn wire)

Compositing lives entirely in core main-thread JS (`compositor.ts`,
`JsCompositor`). C++ `Compositor` is a wire / acquire-present /
dmabuf-interop service.

- **Layers:** `background < below < content < above < overlay`,
  composited back-to-front. `content` holds windows + subsurfaces +
  popups (single stack owner, `rebuildStackWithPopups`).
- **WM seam:** geometry consumed only via `CompositorSink`
  (`setSurfaceLayout`, `setStack`/`setOutputStack`).
  `packages/core/src/wm/index.ts` owns the window list; layout *policy*
  is a bundled plugin (`@overdraw/plugin-layout-default`, master-stack
  tiler, namespace `'layout'`, priority 0).
- **Geometry compositor-owned:** sized configure goes out at
  `get_toplevel`; clients render at the configured size.
- **Decoration insets subtractive** (outer-anchored): layout assigns
  the outer tile; content = outer shrunk by insets.
- **Multi-output (M1-M6 done):** N-connector enumeration, per-output
  scanout rings + CRTC + fence routing, per-output render slicing,
  independent per-output vblank pacing, per-output frame-callback
  dispatch, per-output content stacks, per-output composite-scissor
  damage, per-output dirty gate (an output's flip-complete does NOT
  re-render that output unless damage / a transition / a live producer
  marked it dirty since the last present -- an idle compositor with no
  clients consumes ~0% CPU), libinput full-layout cursor clamp.
  Per-window `outputId`;
  layout-driver loops per output; layer-shell honors the `output` arg;
  workspace plugin carries `preferredOutputs`. `wl_output` globals per
  entry in `state.outputs`. `wl_surface.enter`/`leave` via residency
  differ. `wp_fractional_scale_v1` tracks per-surface and emits per
  primary overlapping output.
- **M7 hotplug:** steps 1-5 landed (JS hotplug handlers, workspace
  migration recompute, cross-fd race fix). Steps 6-7 remain (verify
  wl_surface.leave / global_remove ordering with a real client;
  `ScanoutRebuild` plumbing for mode change). M8 (multi-GPU) remains.
- **Workspace plugin authoritative for per-output ordered visible
  windows** -- layout-driver, `windowAt`, `focusOrder` all read from
  `state.outputToplevelStacks`.

### KMS scanout backend (`--backend=kms`)

Bare-metal output via DRM/KMS: libseat-managed card fd, atomic-commit
modeset, 3-slot GBM scanout ring with per-slot Dawn `SharedTextureMemory`
import, page-flip-paced frames with `IN_FENCE_FD`. Card auto-detect
probes `/dev/dri/card*` for the first connected connector; adapter
selection `fstat`s the card fd's primary major:minor and matches
against `WGPUAdapterPropertiesDrm`; GBM render node derives from the
chosen adapter (no hardcoded `renderD128`).

Modifier selection: plane's `IN_FORMATS` candidates, tiled-first,
with LINEAR as last fallback. Multi-plane modifiers (CCS/AFBC) fall
through because Dawn requires single-FD.

Takeover modeset (boot and VT-switch resume) disables every plane
bound to our CRTC that isn't ours (`addForeignPlaneDisables`): a
previous DRM master's cursor/overlay plane otherwise stays latched
with its final image -- a hardware cursor frozen at its last
position, displayed on top of everything we scan out. overdraw's own
cursor is software-composited, so any latched plane on our CRTC is
foreign by construction.

Production defaults to `kms`; `--backend=nested` or `OVERDRAW_BACKEND=
nested` for dev under a host session.

**Limitations:** single-plane tiled modifiers only; no mode changes
(`SetOutputMode` not wired); no KMS coverage in the test suite (manual
verification only); NVIDIA / non-Intel scanout unverified end-to-end.

### Input

**Backend seam** paired with the output backend:
- `WaylandInputBackend` (nested): forwards host `wl_seat` events over
  the input socket; conversion + libuv drain in the core.
- `LibinputBackend` (KMS): opens `/dev/input/event*` via libseat,
  emits the same `InputEvent`s with raw evdev keycodes; output-space
  coords clamped to the live layout. libinput requires
  `OVERDRAW_KMS=ON` (default on Linux).

Seat acquisition wraps libseat (logind or seatd). Output size
propagated via `addon.updateOutputSize` (logical, post-scale).

**Routing:** `wl_seat`/`wl_pointer`/`wl_keyboard` advertised;
`handleInput` hit-tests the WM stack, tracks focus, emits enter/
leave/motion/button/axis/frame + key/modifiers with surface-local
coords. Keymap via xkbcommon (compiled keymap memfd sent via
`wl_keyboard.keymap`).

**Focus policy is a bundled plugin** (`@overdraw/plugin-focus-default`,
namespace `'focus'`, priority 0): pointer always follows pointer;
keyboard focus dispatched via the focus driver to the active plugin
on coarse events. Bundled plugin implements `follow-pointer` (default)
and `click-to-focus`, plus `focusOnMap`. Fire-and-forget; sequence-
tagged dispatches discard stale results.

Cursor compositing end-to-end: `wl_pointer.set_cursor` +
`wp_cursor_shape_v1` route through the compositor's software cursor
slot above all layers; see "Cursor system" via `status-detailed.md`.

**Limitations:** touch not forwarded; no key-repeat generation
(repeat_info sent, client repeats); libinput backend ignores
hotplug device add/remove.

## Client buffers

Selection receive fds are handler-owned and closed after the send
forward (libwayland does not close request fds after dispatch). The
receiver's pipe therefore sees EOF once the source finishes -- an
EOF-dependent paste reader (real wl-paste) completes instead of
hanging on a leaked write-end.

### shm (verified)

ARGB8888/XRGB8888 advertised; `wl_shm_pool` maps the fd;
`commitSurfaceBuffer` takes a zero-copy external `ArrayBuffer` and
uploads via `queue.writeTexture`. ARGB8888/XRGB8888 -> BGRA8Unorm
byte-for-byte on LE. `wl_buffer.release` after upload (bytes copied).

`wl_shm_pool.resize` is mirrored to the GPU process
(`FrameKind::ResizeShmPool` -> mremap), keeping the shm fast-path
mapping in sync with the core's. Without the mirror, an upload whose
region sits past the pool's CREATION size fails the GPU process's
bounds check and is silently dropped (ack still sent, so the buffer
releases and nothing retries). The canonical victim is a
libwayland-cursor theme pool -- created one-image-sized and grown per
loaded cursor -- which made GTK/emacs client-surface cursors render
as fully transparent (invisible pointer). End-to-end coverage:
`test/cursor-shm-resize.gpu.mjs` + `cursor-shm-resize-client`.

### dmabuf (verified)

ARGB8888/XRGB8888 + LINEAR/INVALID advertised. `create_immed` builds
a dmabuf-tagged buffer; on commit, the fd rides in-band on the wire
as `kind=3 ImportClientTex` (SCM_RIGHTS); GPU process imports as
`SharedTextureMemory`, opens `BeginAccess`, `InjectTexture`s at the
core's reserved handle, replies with `kind=4 ClientTexImported`. The
commit is non-blocking (reserve -> enqueue frame -> `PendingImport`).

**Buffer-release lifecycle (zero-copy):** a buffer is released only
once the compositor frame that sampled it completes on the GPU
(submit tagged with serial + `onSubmittedWorkDone`). The
`onSubmittedWorkDone` callback calls `addon.wake()` when its
dispatch grew the pending-release set -- without this, a client
that drained its dmabuf pool on its last commit could deadlock
waiting for releases that never get scheduled.

**Multi-GPU render-node selection:** GBM render node derives from
the chosen Dawn adapter (no hardcoded `renderD128`). Test clients
honor `OVERDRAW_RENDER_NODE` set by the harness; clients abort
loudly if it is unset.

**Limitations:** single plane only; `create` (async server-minted
`wl_buffer`) not wired; import `BeginAccess` is never ended until
teardown (fine single-device); no modifier negotiation beyond the
static advertised set.

## Real clients run end-to-end

- **`foot`** (1.25.0, shm) connects, renders, is interactive.
- **`kitty`** (hardware EGL) renders, focuses on map, types.
- **Vulkan-WSI clients** (Dawn/Vulkan WSI terminal) run interactively.
  Required real dmabuf default-feedback, alpha + opaque DRM fourcc
  per format, `wl_seat`/`wl_pointer`/`wl_keyboard` event version
  gating, the dmabuf buffer-release lifecycle, and (for NVIDIA
  proprietary) `wp_linux_drm_syncobj_v1` + the Dawn dedicated-alloc
  fix.

**Color:** scanout rings are allocated as BGRA8Unorm dmabufs (the
universal Mesa/KMS floor); the shader passes client bytes (already
sRGB) through. Correct for opaque content; alpha blending happens
in sRGB space (wrong for translucency -- linear compositing is
future work).

## Output reconfiguration

GPU process owns the display target (`OutputBackend`); core owns
client-facing protocol state. They coordinate via the
`ipc::Tag::OutputDescriptor` ctrl message. On host-driven resize,
the GPU process tears down the prior scanout ring, rebuilds it at
the new dimensions, sends `ScanoutRebuild` on the wire (the core's
matching `ScanoutReserve` reply triggers the new ring's slot inject
+ surfaceBufs replacement), re-emits the descriptor, and pokes the
JS render loop with a one-shot `FrameComplete` to break the
host-vblank deadlock. The core mutates `state.outputs`, the JS
compositor, the input backend rect, the WM, fires `output.changed`
on the plugin bus, and `wl_output` + `xdg_output` re-emit the full
event burst per spec.

Out of scope: multi-output enumeration past M7 step 5 (deferred
items above), KMS-side mode changes (`SetOutputMode` not wired),
subpixel hint (hardcoded UNKNOWN).

## HiDPI / output scaling

Two pixel spaces: **device** (scanout / render target) and **logical**
(WM layout, `xdg_toplevel.configure`, `xdg-output`, pointer coords).
Bridge is the output scale: `logical = round(device / scale)`. No
intermediate logical-resolution framebuffer; each surface samples
into its `logical_rect × scale` device rect (scale-aware clients are
pixel-perfect; non-cooperating clients are upscaled, correct size,
soft).

**Scale selection:** explicit `output.scale` config > EDID-DPI auto
(KMS only -- nested host window dims describe the host monitor, not
our render target) > 1. Fallback snaps DPI/96 to quarter steps,
clamped to [1,3].

**Client negotiation:** integer (`wl_surface.set_buffer_scale`) and
fractional (`wp_fractional_scale_v1` + `wp_viewporter`) both wired
and verified.

`wl_surface.set_buffer_transform` is implemented for all 8 orientations
(double-buffered, pixel-verified). Limitation: combining a buffer
transform with a `wp_viewport` source crop is not spec-exact (crop
composed after transform rather than in pre-transform surface
coords); transform-alone and crop-alone are correct.

**Known gaps:** software cursor correct-size but soft at scale>1
(internal cursor only passes scale 1); scale-aware-subsurface render
path covered at the protocol layer but not by a GPU test; nested
mode does not auto-derive scale (config only).

## Protocols

### Wayland server + generic trampoline

Real Wayland clients dispatched to JS, with interfaces built at
runtime from generator metadata (no per-protocol C). `wl_display` +
listening socket on libuv; `interface_registry.cpp` builds
`wl_interface`/`wl_message[]`/`types[]` from generated signatures;
`trampoline.cpp` decodes the `wl_argument` array into a typed tuple
and calls the named JS handler. `postEvent` encodes typed args incl.
server-minted new_ids and fds. Per-arg since-versioning is not
represented (message-level only). No live reload.

### Protocol generator (XML → JS/TS)

`tools/gen-protocol/` parses Wayland XML and emits per interface a
`.js` signature module + `.d.ts` typed contract. Output to
`packages/core/src/protocols-gen/` (gitignored). All `.d.ts`
type-check under `tsc --strict`.

### Protocol coverage matrix

(For what's NOT implemented, plus a planning order, see
`docs/protocol-coverage.md`.)

- **Tested end-to-end** (pixel or behavioral): `wl_compositor`,
  `wl_surface` (attach/commit/frame/damage/transform/buffer-scale),
  `xdg_wm_base`/`xdg_surface`/`xdg_toplevel` (configure + states,
  title/app_id, maximize/fullscreen/minimize/floating,
  move/resize grab), `wl_shm`/`wl_shm_pool`/`wl_buffer`,
  `zwp_linux_dmabuf_v1`, `wl_seat`/`wl_pointer`/`wl_keyboard`,
  `wl_output`, `wl_callback`, `wl_data_device*`/`wl_data_offer`,
  `zwp_primary_selection_*`, `wl_subsurface` (sync/desync),
  `xdg_popup`/`xdg_positioner`, `wl_data_device` DnD,
  `zwlr_layer_shell_v1`/`zwlr_layer_surface_v1` (anchor +
  exclusive zone + reflow + keyboard interactivity override +
  popup re-parenting),
  `zxdg_decoration_manager_v1`/`zxdg_toplevel_decoration_v1`
  (unconditional server-side reply; unit-tested),
  `zxdg_output_manager_v1`/`zxdg_output_v1`,
  `zwlr_foreign_toplevel_manager_v1`/`..._handle_v1` (unit-tested
  wire shape; no GPU test client today),
  `ext_workspace_v1` (manager + group + handle; unit-tested wire shape;
  Waybar `ext/workspaces` module consumes it),
  `wp_linux_drm_syncobj_v1` (NVIDIA proprietary clients),
  `wp_viewporter`/`wp_viewport`, `wp_fractional_scale_manager_v1`/
  `wp_fractional_scale_v1`, `wp_cursor_shape_v1`,
  `ext_data_control_manager_v1` + legacy `zwlr_data_control_manager_v1`
  (clipboard + primary selection control for unfocused clients; both
  families served by one handler with per-resource dispatch -- the zwlr
  name is what wl-clipboard <= 2.2.1 binds, and without it wl-copy maps
  an invisible toplevel for focus that a tiler reflows around; tested
  end-to-end via the `ext-data-control-client` and
  `zwlr-data-control-client` test clients),
  `wp_presentation` / `wp_presentation_feedback` (per-commit scanout
  timestamps for video apps; CLOCK_MONOTONIC; supersession on the
  next commit per spec; tested end-to-end),
  `wp_commit_timing_manager_v1` / `wp_commit_timer_v1` (per-surface
  timed commits: a commit carrying a set_timestamp target is held --
  the whole pending set, captured in a per-surface FIFO that later
  commits queue behind, preserving latch order -- and latched when the
  presentation clock reaches the target, so it presents at the next
  flip at-or-after it; no vblank prediction, so presentation lands
  within one refresh after the target rather than at the nearest
  vblank; unit-tested state machine + tested end-to-end via the
  `commit-timing-client` timed-presentation assertions),
  `ext_foreign_toplevel_list_v1` / `ext_foreign_toplevel_handle_v1`
  (read-only toplevel enumeration with identifier + app_id + title
  for status panels, window switchers, screen-share window pickers;
  tested end-to-end via the `ext-foreign-toplevel-client` test
  client),
  `ext_image_copy_capture_manager_v1` / `_session_v1` / `_frame_v1`
  + `ext_image_capture_source_v1` +
  `ext_output_image_capture_source_manager_v1` +
  `ext_foreign_toplevel_image_capture_source_manager_v1`
  (output and per-toplevel screenshot/screen-share capture into
  client shm buffers; tested end-to-end via the
  `ext-image-copy-capture-client` test client).
- **Implemented, input-region path exercised via hit-testing:** `wl_region`
  (opaque region stored but unconsumed -- see "Read first");
  `zwp_linux_dmabuf_feedback_v1` (exercised by real WSI clients).

## Plugins

A plugin module loads in either a `worker_threads` Worker (user
plugins) or in-thread on the main loop (bundled plugins). Both
transports expose the same SDK contract; the in-thread variant
shares core's `GPUDevice` directly.

**Runtime supervision:** state machine (`spawning`→`live`→`shutting-
down`/`failed`), watchdog (>K missed pongs → terminate), restart
policy (`on-failure` up to `maxRestarts` in `windowSeconds`).
Bundled plugins are core's own code and load first; user-config
plugins load after the server is up. Namespace registry sorts
registrations priority-descending with a priority chain (head is
active; failure demotes).

**Bundled plugins:**
- `@overdraw/plugin-layout-default` (namespace `'layout'`):
  master-stack tiler.
- `@overdraw/plugin-focus-default` (namespace `'focus'`):
  follow-pointer + click-to-focus + focusOnMap.
- `@overdraw/plugin-workspace-default` (namespace `'workspace'`):
  dynamic workspaces, two-id model (stable `WorkspaceHandle` vs.
  1-based `WorkspaceIndex`); action surface (create/destroy/show/
  show-at-index/move-window/set-name/set-urgent/list/current); event
  family (`workspace.created`/`destroyed`/`shown`/`hidden`/`renumbered`/
  `renamed`/`urgency-changed`/`window-moved`); workspace
  `preferredOutputs` for durable-identity reclaim. Urgency
  auto-clears when a workspace becomes shown on its output. All
  action params accept `output: string` (a connector name like
  `"DP-1"` or an EDID id), never numeric `outputId`; `workspace.show`
  takes `{ name }` with name lookup then a digit-string fallback to
  `WorkspaceHandle` (stable identity for `Mod+N` keybinds);
  positional access lives behind `workspace.show-at-index`. Default
  output for omitted-`output` is the focused output (tracked via
  `window.change.activated`).
- `@overdraw/plugin-hotkey-default` (namespace `'hotkey'`):
  binding chain (chord + mode) driven by `config.hotkeys`.
- `@overdraw/plugin-core-actions`: `compositor.quit`,
  `xwayland.restart` (respawn the Xwayland stack without restarting
  the compositor; `overdrawctl restart-xwayland`), plus `spawn`,
  `window.*`, `focus.*`, `layout.*`, `output.switch-mode`.
- `@overdraw/plugin-config-actions`: user-defined action handlers
  from `config.actions`.
- `@overdraw/plugin-cursor-actions`: `cursor.set-shape`,
  `cursor.hide`, etc.

**SDK surface (built):**
- `sdk.gpu.createOverlay` (cross-process wire + dmabuf rings for
  Worker; core-device textures for in-thread). Output-targetable
  (`output` opt, default primary; global-coordinate placement;
  anchored overlays reflow on output add/remove/change and are
  dropped when their output is removed) + `sdk.gpu.listOutputs`.
- `surface.onFrame` (rAF-shaped vblank tick per overlay surface,
  paced by the surface's output's flip-complete; idle outputs are
  force-presented via the wl_surface frame-callback gate so ticks
  never strand and never free-run).
- `sdk.window` observer (onMap/onUnmap/onChange).
- `sdk.windows.propose` + state bag + snapshots +
  `setOutputStack` + `focus(id)` + `requestFocusDecision` +
  per-surface render state (`setOpacity`/`setTransform`/`setMask`/
  `setOutputMargin`/`setTint`/`setColorMatrix`) +
  `destroyPhantom`.
- `sdk.decorations` (register + createDecoration with content
  gating + first-frame backstop).
- `sdk.actions` (register/invoke/list).
- `sdk.events` (typed bus + dynamic pattern subscribe + intercept
  with priority + per-handler timeout).
- `sdk.animations.run`/`cancel` (tween + spring + sequence +
  parallel; ticked from `state.beforeRender`).
- `@overdraw/sdk-anim` plugin-side spec builders.
- `sdk.compose.scene` (snapshot + live, both transports);
  `sdk.compose.windows` (in-thread only -- Worker throws).
- `sdk.transitions.run` (six built-in kinds: crossfade, slide-
  left/right/up/down, scale; snapshot + live scene inputs;
  declarative atomic commit; in-thread + Worker).
- `sdk.input.bind` + `defineMode` + `pushMode`/`popMode` (chord +
  mode trie; modes isolated).
- `sdk.cursor.setShape`/`setImage`/`hide`/`show`/`setDefault`/
  `clearOverride`/`defineRule` (XCursor theme resolver +
  kinematic state machine + rule engine; `setImage` is in-thread
  only).
- `sdk.intercept.register` (per-client app_id match; per-surface
  render every visible frame; in-thread + Worker via cross-device
  dmabuf rings).
- `sdk.registerPlugin` (`'window-closing'` namespace +
  `window.closing` event + 10s phantom backstop).

**IPC:** JSON-RPC 2.0 server on
`$XDG_RUNTIME_DIR/overdraw-<display>.sock` (mode 0700) with methods
`invoke`/`list-actions`/`subscribe`/`unsubscribe`. CLI:
`overdrawctl`. Authentication is filesystem permissions only.

**Deferred refs:** `{ $ref: "focusedWindow" }` etc. in action
params resolve at invoke time from core state (
`surfaceUnderPointer`/`focusedWindow`/`pointerX`/`pointerY`/
`activeOutput`/`currentWorkspace`).

## Testing

`npm test` runs both tiers: builds (js + native), then GPU-free
unit tests (`test/**/*.test.js`) AND GPU tests (`test/**/*.gpu.mjs`,
serialized). GPU tests self-skip without a Wayland session
(`canRunGpu()`) or without `dawn.node`. `test:unit` / `test:gpu`
are build-less sub-targets.

Pure-unit tests cover generator + protocols, popup positioner, WM,
layout policy, snapshot/query, config, overlays, decorations, event
bus, dynamic bus, namespace/action registries, plugin runtime, buffer
lifecycle, wire barrier, scm-rights, server smokes.

GPU tests bring up the GPU process + server + plugin runtime via
`test/harness.mjs` `setupCompositor`; clients spawn via `spawnClient`
(resolves on the "mapped" stdout line); `state.query()` /
`frameReadback()` are the assert surfaces. Synthetic input at two
depths: `addon.injectInput` (straight into `InputSink`) and
`addon.injectHostInput` (through the real backend normalization).

**Headless mode:** `addon.start(gpuBin, …, { width, height })` -- GPU
process spawned `--headless WxH`, no host window/surface, JS
compositor renders into an offscreen target read back via
`copyTextureToBuffer`.

**Known testing bugs / gaps:**
- `startServer`/`stopServer` not safely repeatable in one process
  (libuv `uv__finish_close` assertion on reuse). Worked around
  with one server lifecycle per file.
- No stdin command loop on the harness client for multi-step
  sequences within one client lifetime.
- On-screen (nested) pixel correctness not auto-asserted (inherited
  from headless tests, same render pass).
- KMS path verified manually only (no automated coverage); virtual
  DRM (vkms) test harness would close this.

## Config

`packages/core/src/config/` loads from `--config <path>` (hard error
if missing) else `$XDG_CONFIG_HOME/overdraw/config.*` then
`~/.config/overdraw/config.*`, probing `.ts/.cts/.mts/.js/.cjs/.mjs`
(Node 24 native type-stripping). Default export may be an object or
a (sync/async) function. Validates `focus`/`output` (`width`/
`height`/`card`/`scale`); `plugins` and `hotkeys` parsed +
validated + resolved + consumed by the runtime + hotkey plugin.

## Not yet built (design only)

- **Canvas (shared world, monitors as cameras).** Design in
  `canvas-design.md`. Core mechanisms LANDED with identity defaults
  (zero behavior change until a plugin drives them): per-output content
  camera with pan + zoom (`setOutputCamera(outputId, x, y, zoom?)` +
  `sdk.windows.setOutputCamera`; applied consistently at render,
  hit-test (`SeatViewTransform`), damage partitioning,
  residency/enter-leave, popup constraints, pointer-constraint regions;
  GPU tests `output-camera.gpu.mjs`), per-island layout invocation
  (`LayoutIsland` with `contextOutputId` = derived view context, not
  ownership; the WM derives one implicit island per output;
  `LayoutInputs.island`), explicit islands (`sdk.windows.setIslands` ->
  `wm.setIslands`), and `@overdraw/plugin-canvas` in workspace-parity
  mode (shares the workspace registry; publishes shown workspaces as
  explicit islands; opt-in via a `canvas: {}` config slice,
  `selectBundledPlugins`). ONE landed behavior change: residency is
  stack-gated (`surfaceVisibleOutputs`; "hidden means hidden") -- windows
  on hidden workspaces now get `wl_surface.leave` and reside nowhere;
  frame pacing stays geometric so hidden clients keep receiving
  `wl_callback.done` (GPU test `residency-visibility.gpu.mjs`).
  NOT built: world positions + camera policy (roaming, docking,
  bookmarks, gutters/shove, hotplug camera persistence), the X11
  glass-space fiction, ext-workspace per-group duplicate projection,
  camera-following compose/live scenes, camera animation as an in-core
  evaluator target.
- **Logging.** TS surface migrated (spdlog 1.17.0; fixed area set;
  severity-based stdout/stderr split; `--log-file=PATH`; per-area
  `--log-level=SPEC`; `installConsoleShim` routes `console.*`
  through `addon.nativeLog` on area `"js"`; cross-process flow
  via a fourth socket with fragmented `LogPacket`s). **Not yet
  migrated:** ~140 native `fprintf(stderr, …)` / `printf` sites
  across `packages/core/native/**` and `gpu-process/src/**` --
  they still write directly to inherited stderr, bypassing the
  log-file sink and runtime level filter. Known soundness gap
  (low impact): `overdraw::log::logger(Area)` returns a reference
  to a `shared_ptr`-held logger with the lock dropped on return;
  `IpcSource` works around via `spdlog::get(name)`.
- **WM behavioral residuals:** `show_window_menu`, `set_parent`
  driving stacking/modality, per-output fullscreen target,
  floating windows ignoring reserved zones.
- **Multi-output:** M7 steps 6-7 (verify wl_surface.leave /
  global_remove ordering with a real client; `ScanoutRebuild`
  for mode change). M8 (multi-GPU). Hotplug-replug logical-
  position restore. Plugin-visible output observation (multi-
  output / mode changes / DPI / refresh changes -- SDK does not
  expose `wl_output` today).
- **User-facing diagnostic surfacing.** Plugin errors (init throws,
  per-call exceptions, bad config) currently only log.
- **Plugin SDK gaps:** animated cursor frames (static frame 0);
  HiDPI cursor scaling (resolver takes scale arg but core only
  passes 1); continuous cursor transforms (tilt/rotate/stretch);
  intercept chains + per-stage caching + hold-last-output + A1
  input optimization + popups/subsurfaces (Phase 10b); protocol
  SDK surface; interactive-region hit-testing; `sdk.onFrame`.
- **Capability enforcement.** No capability gate on SDK APIs
  (every plugin gets them); no native-import restriction; no
  sub-grant schema/enforcement.
- **Plugin teardown wiring.** `unregisterPlugin` exists but
  `main.ts` does not call it on plugin exit; a crashed
  provider's registration lingers.
- **Strict typing of the plugin GPU broker.** Unknown request
  bag cast field-by-field with `as ConcreteType`.
- **Cross-thread N-API marshaling.** `napi_threadsafe_function`
  for Dawn-thread callbacks not exercised.
- **Crash recovery.** GPU-process respawn + state replay not
  implemented. Crash handlers dump backtraces (GPU process to
  `/tmp/overdraw-gpu-crash.txt`, core to
  `/tmp/overdraw-core-crash.txt`).
- **Linear compositing.** Alpha blending happens in sRGB space.
- **XWayland.** Phases 1-4 landed (server lifecycle; `xwayland_shell_v1`
  + serial-association XWM; ICCCM/EWMH properties → title/app_id/
  constraints/parent/presentation + close path via `WM_DELETE_WINDOW`/
  `KillClient`; configure round-trip with compositor authority +
  `holdUntilBufferDims` resize-tx variant + synthetic ConfigureNotify;
  override-redirect overlays with content-layer splicing; keyboard
  focus mirroring with the ICCCM truth table + bookkeeper window +
  `_NET_ACTIVE_WINDOW`/`_NET_WM_STATE_FOCUSED` + serial-validated
  FocusIn handling for cross-app focus-stealing denial; CLIPBOARD +
  PRIMARY selection bridge between X clients and wayland clients,
  both directions, with INCR for >64 KiB payloads).   Global Xwayland HiDPI scale wired
  (`config.xwayland.scale`, default 0 = auto: `ceil(max(output.scale))`
  at start, clamped to `[1,3]`; frozen for the session). X clients see
  an oversized world by the scale factor; the X surface is treated as
  `bufferScale=N` so the existing composite path renders it at the
  right logical size. EWMH polish landed: `_NET_SUPPORTING_WM_CHECK`
  (root + bookkeeper child + `_NET_WM_NAME="overdraw"`),
  `_NET_SUPPORTED` lists every EWMH atom the WM acts on, ICCCM
  `WM_STATE = NormalState` on managed windows (deleted on unmap),
  `_NET_WM_STATE_FOCUSED` is now read-modify-write against the cached
  atom list so client-set bits survive a focus change,
  `_NET_STARTUP_ID` and `_NET_WM_ICON` are parsed and exposed via
  `XwmStateView.{startupIdOf,iconsOf}`. Production wiring:
  `config.xwayland.enabled` (default false) opts in;
  `config.xwayland.displayNumber` (default 50) selects the X display.
  Autopick rejected upstream (would otherwise steal `:0` from a live
  host session). 23 GPU tests + 80 GPU-free unit tests cover the
  surface. DnD and `xwayland-keyboard-grab` are the remaining Phase 5
  work. See `docs/xwayland-design.md`.
  Known limitations:
  - Same-PID focus-stealing exception requires both windows to
    advertise `_NET_WM_PID`; older / non-EWMH X clients fall back to
    cross-PID denial.
  - OR overlays appear on every output's stack regardless of which
    toplevel they belong to (X has no workspace concept; per-toplevel
    rooting would need `WM_TRANSIENT_FOR` chain following).
  - Selection bridge refuses outgoing targets for X requestors that
    ask for atoms we never advertised (would require async
    `xwmGetAtomName` which violates SelectionRequest's bounded-time
    reply expectation); `MULTIPLE` target refused; `CLIPBOARD_MANAGER`
    short-circuited with a success notify.
  Session supervisor untouched.
- **Live reload.** Not built.

## Spikes

Throwaway de-risking experiments live in `spikes/` (git-ignored);
findings fold into `architecture.md`, code is not part of the build.
