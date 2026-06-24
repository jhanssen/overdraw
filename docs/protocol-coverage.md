# overdraw — Wayland protocol coverage (gaps + plan)

Where overdraw stands relative to two reference compositors (sway, on
top of wlroots; hyprland, on top of aquamarine + its own protocol
implementations), what's missing, and the suggested order to land
things. This is a planning document; ground truth for what is already
implemented lives in `docs/status.md` (the "Protocol coverage matrix"
section enumerates the currently-tested set).

The comparison was taken from the source trees of all four
compositors as of the time this document was written. Two points
to keep in mind:

- Protocols are added and renamed continuously; this list will
  drift. When a specific protocol becomes important, re-check the
  upstream `wayland-protocols` repo (and the wlroots / hyprland
  trees) for the current name and version.
- Hyprland implements every protocol itself; sway delegates to
  wlroots. Both compositors end up advertising a very similar set
  to clients.

## Current state

Overdraw advertises **27** registry-visible globals (one of which,
`wl_output`, is per-output). The full list, grouped:

- Core wayland: `wl_compositor` v6, `wl_subcompositor` v1,
  `wl_shm` v2, `wl_seat` v10, `wl_data_device_manager` v3,
  `wl_output` v4.
- Stable wayland-protocols: `xdg_wm_base` v7, `wp_viewporter` v1,
  `wp_presentation` v2.
- Staging: `wp_cursor_shape_manager_v1` v2,
  `wp_fractional_scale_manager_v1` v1,
  `wp_linux_drm_syncobj_manager_v1` v1, `ext_workspace_manager_v1` v1,
  `ext_data_control_manager_v1` v1,
  `ext_foreign_toplevel_list_v1` v1,
  `ext_image_copy_capture_manager_v1` v1,
  `ext_output_image_capture_source_manager_v1` v1,
  `ext_foreign_toplevel_image_capture_source_manager_v1` v1.
- Unstable: `zwp_linux_dmabuf_v1` v5,
  `zwp_primary_selection_device_manager_v1` v1,
  `zxdg_decoration_manager_v1` v1, `zxdg_output_manager_v1` v3.
- wlroots-extension: `zwlr_layer_shell_v1` v5,
  `zwlr_foreign_toplevel_manager_v1` v3,
  `zwlr_output_manager_v1` v4.
- KDE-extension: `org_kde_kwin_server_decoration_manager` v1.
- Xwayland: `xwayland_shell_v1` v1.

For comparison: sway / wlroots advertise around 54 distinct
globals; hyprland advertises around 63 (a chunk of which are
hyprland-private and not portable). The remaining gap is roughly
30 protocols.

## The gaps, by tier

Three tiers, ordered roughly by how often a normal Wayland desktop
user notices their absence. Effort estimates are rough person-days
for a developer already familiar with this codebase, including
tests, GPU tests, and doc updates.

### Tier 1 — daily-driver breakage

What a regular Wayland user (no games, no VMs, no IME) discovers
within the first hour of using the compositor.

- **`wp_presentation`** — landed. Per-commit feedback resources carry
  the actual scanout timestamp + refresh + vsync sequence + capability
  flags. Clock advertised is `CLOCK_MONOTONIC`. Timestamps come from
  the kernel `page_flip_handler2` on KMS (with the real vsync
  sequence) and from the host `wl_surface.frame` time on nested mode
  (sequence stays 0); the headless backend synthesizes a per-tick
  monotonic timestamp. Supersession is implemented: if a new commit
  arrives before the previous one scanned out, the old commit's
  feedback is `discarded` per spec. Surface unmap discards any queued
  feedbacks. The `sync_output` event names the wl_output the
  presentation actually went to, resolved from the surface's residency
  set.

- **`ext_idle_notifier_v1`** — emits idle / resumed signals on a
  configured timeout. `swayidle` and equivalents are the only way to
  trigger auto-lock / DPMS-off / suspend-on-idle. Effort: ~0.5 day.

- **`zwp_idle_inhibit_manager_v1`** — a wl_surface can request "do
  not consider me idle while I'm mapped." mpv and Firefox set it
  during video playback. Pair with the notifier above. Effort: ~0.5 day.

- **`ext_session_lock_manager_v1`** — the screen-lock protocol.
  swaylock / hyprlock / waylock all use it; without it there is no
  screen-lock at all. A session-lock client maps a lock surface that
  sits above every other layer and gates input. Effort: ~1.5 days
  (involves a new top-most layer above the existing layer-shell
  stack, and routing all input through the lock surface).

- **`ext_image_copy_capture_manager_v1`** plus
  **`ext_output_image_capture_source_manager_v1`** plus
  **`ext_foreign_toplevel_image_capture_source_manager_v1`** —
  landed. Output and per-toplevel capture into client shm buffers.
  Sessions advertise `buffer_size` + `shm_format(argb8888,xrgb8888)`
  + `done`; frames arm on `capture()` and fire `ready` on the next
  scanout flip-complete (the same edge that drives wp_presentation
  feedback, so `presentation_time` carries the actual page-flip
  timestamp). Per-output source composes the resident content stack
  via `composeScene` + `readbackTexture`; per-toplevel source
  composes the single window via `composeWindows`. Toplevel unmap
  fires `session.stopped`; output mode change re-advertises
  constraints. **Gaps:** dmabuf destination buffers not advertised
  (importing a client dmabuf as a render/copy target on coreDevice
  needs Dawn SharedTextureMemory wiring that does not exist in the
  core process today — the existing dmabuf import is sampler-only
  via the GPU process). Clients that bind the manager and find no
  `dmabuf_format` in a session fall back to shm; this is fine for
  `grim`, `xdg-desktop-portal-wlr`'s shm path, and OBS's shm
  fallback. The cursor sub-session
  (`ext_image_copy_capture_cursor_session_v1`) is stubbed:
  `get_capture_session` advertises zero formats so clients see "no
  cursor capture available" and back off.
  - Alternative: `zwlr_screencopy_manager_v1` is the older variant
    of the same thing; some existing tools still bind it. Not
    implemented; clients fall back to `ext_image_copy_capture`.

- **`ext_data_control_manager_v1`** — landed. The control device
  bypasses keyboard focus: a clipboard manager, `wl-copy`, or
  `wl-paste` can read or set both the clipboard and the primary
  selection without needing any surface to be mapped or focused.
  Backed by a new `selection.changed` event on the internal bus
  that the control protocol layer subscribes to; the same event is
  emitted from the standard `wl_data_device.set_selection` path and
  from the Xwayland selection bridge so X-owned and wl-owned
  selections fan out identically. Older `zwlr_data_control_manager_v1`
  is not implemented; tools fall back to the ext variant.

- **`xdg_activation_v1`** — focus-stealing protection. A launcher
  issues an activation token to the client it spawned; the client
  hands the token back when requesting focus; the compositor knows
  the focus request is legitimate. Without it, newly spawned
  applications either always steal focus or never do (the compositor
  has no way to tell). Effort: ~0.5 day; the protocol itself is a
  token issue + redeem pair.

**Tier 1 total: roughly a week of focused work.** After this, the
compositor handles screenshots, clipboard tools, screen lock, idle
hooks, modern video apps, and proper focus on launch — i.e. it
behaves like a Wayland desktop rather than a research project.

### Tier 2 — significant for specific user populations

Each of these matters a lot to a subset of users and not at all to
the rest.

- **Pointer constraints + relative pointer + Xwayland keyboard grab**
  — the gaming / VM / remote-desktop bundle. Without them, FPS games
  have no mouselook, VMs leak the cursor, fullscreen X games can't
  swallow Alt+Tab. Protocols: `zwp_pointer_constraints_v1`,
  `zwp_relative_pointer_manager_v1`,
  `zwp_xwayland_keyboard_grab_manager_v1`, and the wl-side
  `zwp_keyboard_shortcuts_inhibit_manager_v1`. The first two affect
  all clients; the latter two are Wayland-side counterparts of X-side
  grabs. Effort: ~3 days for the cluster. See the discussion in
  `docs/xwayland-design.md` for the Xwayland-specific framing.

- **`wp_tearing_control_manager_v1`** — a client can hint "tearing is
  OK here" so the compositor can skip vblank pacing for that surface.
  Used by competitive gamers. Effort: ~0.5 day; the protocol is a
  hint, no scheduling change required to land the global.

- **`zwp_pointer_gestures_v1`** — touchpad gesture events (swipe,
  pinch, hold) reach the focused client. Without it, browser pinch-
  zoom and image-viewer pan don't work on a trackpad. Effort: ~1 day;
  needs libinput gesture events plumbed through the seat.

- **`zwp_text_input_manager_v3`** plus **`zwp_input_method_manager_v2`**
  — input methods (fcitx, ibus, anthy, sogou). Hard requirement for
  CJK users. Together they form the compositor side of "client says
  what surface needs input, IME announces commits / pre-edits."
  Effort: ~3 days; the protocol is intricate (preedit + commit +
  reset + cursor-rect feedback) and the IME side has bugs in many
  clients.

- **`zwp_tablet_manager_v2`** — drawing tablets (Wacom, XP-Pen,
  Huion). Without it, tablet users have no pressure / tilt / tool
  switching. Effort: ~2 days; libinput tablet-tool events are
  straightforward but the protocol has many sub-resources.

- **`zwlr_virtual_pointer_manager_v1`** plus
  **`zwp_virtual_keyboard_manager_v1`** — synthetic input. Used by
  scripted automation (`wlrctl`, `wtype`, `ydotool` indirectly) and
  on-screen-keyboard accessibility (squeekboard, wvkbd). Effort: ~1
  day each; both are short protocols.

- **`zwlr_gamma_control_manager_v1`** — gammastep / wlsunset
  (blue-light filter / night-mode) bind this. Effort: ~0.5 day; needs
  per-CRTC gamma plumbing from the GPU process.

- **`zwlr_output_power_manager_v1`** — programmatic DPMS-off. The
  power-manager half of "lock + sleep the displays." Effort: ~0.5 day.

- **`xdg_toplevel_icon_manager_v1`** — a client tells the compositor
  which icon it wants in taskbars. Without it, panels guess via
  `appId` lookup against `.desktop` files. Effort: ~0.5 day.

- **`wp_content_type_manager_v1`** — surface hints "I'm a game" / "I'm
  a video." The compositor can use the hint to adjust scheduling (low-
  latency for games, frame-pacing for videos). Effort: ~0.5 day to
  add the protocol; consumers (your scheduler) are the real work.

- **`wp_security_context_manager_v1`** — Flatpak's sandbox machinery
  binds this. Lets a sandboxed client be given a restricted view of
  the global registry. Effort: ~1 day; the trickier work is auditing
  which existing globals should be hidden from a sandboxed peer.

- **`ext_foreign_toplevel_list_v1`** — landed. A read-only
  enumeration of mapped toplevels (identifier + app_id + title +
  done/closed lifecycle). The standardized successor to the older
  `zwlr_foreign_toplevel_manager_v1` (which we also still advertise
  for back-compat). Modern status panels, window switchers, and
  screen-share window pickers bind it; it also serves as the input
  source for the per-window half of `ext_image_copy_capture_v1`.

### Tier 3 — niche or cosmetic

These are present in the reference compositors but rarely make or
break a user's day.

- **`zxdg_exporter_v2`** plus **`zxdg_importer_v2`** — export a
  surface handle to another process; the other process can import it
  to set up a transient-parent relationship. File-chooser portals
  use it so the chooser opens "transient for" the calling app.
  Effort: ~0.5 day.

- **`wp_alpha_modifier_v1`** — per-surface alpha override. Mostly
  cosmetic. Effort: ~0.5 day.

- **`wp_single_pixel_buffer_manager_v1`** — produces a 1×1 solid-color
  buffer without allocating a real shm pool. UI optimization (placeholder
  fills, sub-surfaces used as colored rectangles). Effort: ~0.5 day.

- **`wp_pointer_warp_v1`** — programmatic cursor warp. Blender uses
  it for orbit-camera. Effort: ~0.5 day.

- **`xdg_system_bell_v1`** — terminal bells via the compositor.
  Effort: ~0.5 day.

- **`xdg_wm_dialog_v1`** — a hint that an `xdg_toplevel` is a dialog
  (compositor may pick different decoration / placement). Cosmetic.
  Effort: ~0.5 day.

- **`xdg_toplevel_tag_manager_v1`** — clients tag toplevels to help
  the compositor group related windows. Cosmetic. Effort: ~0.5 day.

- **`wp_color_manager_v1`** plus **`wp_color_representation_manager_v1`**
  — HDR / wide-gamut / color-space metadata. A big investment for a
  small audience today; revisit when HDR hardware and HDR-capable
  apps are mainstream. Effort: many days.

- **`wp_drm_lease_device_v1`** — hand a DRM connector to a VR app.
  VR headsets only. Skip unless overdraw runs on a machine with one.
  Effort: ~1-2 days.

- **`wl_drm`** — Mesa legacy DRM/EGL interface, superseded by
  `zwp_linux_dmabuf_v1`. Some old clients still bind it. Effort:
  ~0.5 day if a real client breaks; otherwise skip.

- **`wp_fifo_manager_v1`**, **`wp_commit_timing_manager_v1`** — newer
  pacing protocols (hyprland ships them; sway has them via wlroots).
  Wait for adoption. Effort: ~1 day each.

- **`ext_background_effect_manager_v1`** — staging blur / background
  effects; hyprland-only of the three. Wait for adoption.

- **`zwlr_screencopy_manager_v1`** + **`zwlr_export_dmabuf_manager_v1`**
  — older screen-capture protocols, subsumed by the now-landed
  `ext_image_copy_capture_*` set in Tier 1. Land if real users still
  bind these; otherwise let `ext_image_copy_capture` cover the surface.

## Suggested order

If overdraw stays your daily driver and is on a slow path toward a
public release:

1. `xdg_activation_v1` (half day; trivial; biggest "feels right"
   improvement per hour spent).
2. ~~`ext_data_control_manager_v1`~~ — landed.
3. ~~`wp_presentation`~~ — landed.
4. `ext_idle_notifier_v1` + `zwp_idle_inhibit_manager_v1` (~1 day
   together; idle infrastructure).
5. `ext_session_lock_manager_v1` (~1.5 days; screen lock).
6. ~~`ext_image_copy_capture_manager_v1` + companions~~ — landed
   (shm destinations; dmabuf destination + cursor sub-session are
   gaps).

That's roughly a week of work and brings overdraw to "a non-hostile
reviewer can use it for an afternoon without immediately hitting a
brick wall."

After that, drop in Tier 2 items as the audience grows: if testers
turn out to be tablet artists, do `zwp_tablet_manager_v2`; if they
play games, do the pointer-constraint / relative-pointer / keyboard-
grab cluster; if any of them speak Japanese, do
`zwp_text_input_manager_v3` + `zwp_input_method_manager_v2`. None
of these blocks the next; they're independent.

Tier 3 stays at the bottom of the list until a specific user need
surfaces.

## Cross-references

- `docs/status.md` — current implementation status; the "Protocol
  coverage matrix" section enumerates what is already in.
- `docs/architecture.md` — design rationale; protocols slot into the
  protocol-handler factory layer described there.
- `docs/xwayland-design.md` — the Xwayland-specific framing for the
  pointer-constraints / relative-pointer / keyboard-grab cluster.
