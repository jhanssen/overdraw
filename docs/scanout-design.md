# overdraw — direct scanout design

Zero-copy presentation for a solitary fullscreen client: the client's
dmabuf goes onto the primary KMS plane directly, skipping the composite
pass entirely. The compositor's GPU does no per-frame work; presentation
latency drops by one sample-and-blit; fullscreen video playback stops
waking the render pipeline. KMS-only; nested mode always composites.

Related docs: `drm-design.md` (scanout ring, flip pacing, the
buffer-release open point this design resolves), `cursor-design.md`
"Hardware cursor" (the per-CRTC commit serialization this extends).

## Decision chain (per output, per frame)

Eligibility is re-evaluated every `renderFrame` pass in the core; there
is no mode switch, only a per-frame choice between two present paths.
An output presents by direct scanout when ALL of:

1. `directScanout` config is true (default) and the output is KMS with
   a live ring.
2. The output's draw list is exactly one surface (this alone excludes
   software cursor, popups, subsurfaces, phantoms, overlays, layer
   shell, decorations — they are all separate draw-list entries), and
   no transition/live-composer is active on the output.
3. That surface's window is `exclusive === "fullscreen"` on this
   output and its layout rect equals the output's logical rect.
4. The committed buffer is an imported dmabuf whose pixel dims equal
   the output's mode, `buffer_transform` is normal, no viewport crop,
   and the fourcc is alpha-less (XRGB8888-class; an alpha fourcc could
   blend with what's under it, which scanout cannot do). Buffer scale
   is free — a scale-2-aware client's mode-sized buffer qualifies.
5. The output's camera is identity (canvas world-mode zoom/pan renders
   a transformed view; the plane cannot).
6. The cursor is on the hardware cursor plane or hidden (a software
   cursor is a second draw-list entry, so this falls out of rule 2).
7. The GPU process has not vetoed this buffer/output (an AddFB2 or
   atomic TEST rejection reports back and the core composites; see
   "Rejection + retry").

When eligible, the core skips acquire/render for the output and sends
`ScanoutClientPresent` instead; the frame's damage for that output is
consumed as usual. When not eligible (including the frame an overlay
appears), the ordinary composite path runs — the ring is kept alive
while scanout is active precisely so this fallback is a plain present,
not a bring-up.

## Wire protocol

The GPU process already retains every imported client dmabuf's fd
(`ClientTex.fd`, kept for implicit-sync fence export) plus its
dims/fourcc/modifier/stride from `ImportClientTexPayload`, so scanout
introduces NO new fd passing. New `FrameKind`s (wire, per the IPC
policy; all reference state introduced by wire-FIFO predecessors):

- `ScanoutClientPresent` (core -> gpu): outputId + the buffer's wire
  texture handle (id + generation) + bufferId. Optionally ONE
  SCM_RIGHTS fd: the explicit-sync acquire sync_file (consumed from
  the same stash wire-Begin would have used). FIFO-after the buffer's
  `ImportClientTex` by construction. The GPU process lazily builds and
  caches a KMS FB for the handle (`drmModeAddFB2WithModifiers` on the
  retained fd) and issues the atomic commit.
- `ScanoutClientFlip` (gpu -> core): outputId + latched bufferId +
  retired bufferId (0 = none) + kernel flip timestamp/seq. Drives the
  game's frame pacing (`wl_callback.done`, presentation feedback) and
  the retired buffer's release (below). Also emitted with latched=0
  when a COMPOSITE flip retires a client buffer (the scanout-leave
  transition): any flip that latches something other than the
  currently-latched client FB reports that buffer retired.
- `ScanoutClientReject` (gpu -> core): outputId + bufferId. AddFB2 or
  atomic TEST refused the buffer; the core repaints the output through
  the composite path and stops trying this buffer (see below).

## GPU process (kms_output)

Per-output client-scanout state parallels the cursor plane's:

- FB cache: `ClientTex` gains `fbId` (0 until first present needs it)
  plus the source dims/fourcc/modifier/stride retained from import.
  `RmFB` is DEFERRED: removing a latched FB force-disables the plane,
  so FBs are condemned on `ReleaseClientTex` / teardown and destroyed
  only once a different FB has latched (or after an ALLOW_MODESET).
- Present: same TEST-then-commit and PAGE_FLIP_EVENT | NONBLOCK
  discipline as ring presents, same request shape (primary plane props
  with the client FB, cursor plane state folded in). `IN_FENCE_FD`
  from the explicit-sync fd when present, else from
  `exportDmabufAcquireFence(ct.fd)` (same helper the Dawn access path
  uses); no fence at all still works — the kernel honors the dmabuf's
  implicit reservation fences on atomic commits.
- Serialization: ONE commit in flight per CRTC, shared across ring
  presents, cursor-only commits, and client presents. The
  stashed-present mechanism generalizes: a present (either kind)
  arriving while a cursor-only flip is pending is stashed and issued
  from that flip's event. The core's frame clock already prevents two
  presents racing (a present only follows a flip-complete).
- Flip routing: the trampoline tracks `latchedClientBufferId` per
  output. A flip that latches a client FB emits `ScanoutClientFlip`
  (latched + retired). A flip that latches anything else while a
  client FB was latched emits `ScanoutClientFlip` with latched=0 and
  the retired id. Client-present flips do NOT feed the ring slot state
  machine (no slot flipped) but DO carry the kernel timestamp for
  pacing.
- VT pause: client-scanout shadow state resets with the rest;
  post-resume the initial modeset commits a ring FB, and the core
  re-enters scanout on the next eligible frame.

## Buffer release: the scanout hold

Composited buffers release when the GPU finished SAMPLING them
(`onSubmittedWorkDone` -> `gpuCompleted` -> lifecycle `maybeFlush`).
A scanned-out buffer is never sampled — with no inflight serials the
lifecycle would release it at supersede time while the display engine
is still reading it. Resolution (the deferral `drm-design.md` "Open
points" §1 anticipated):

- `BufferRec.scanoutHeld`: set by the executor when a
  `ScanoutClientPresent` is sent for the buffer; blocks `maybeFlush`
  exactly like an inflight serial.
- Cleared by a `scanoutRetired` lifecycle event when `ScanoutClientFlip`
  reports the buffer retired (a successor client FB or a composite
  frame latched). `maybeFlush` then runs the normal owed logic —
  `sendWlRelease` fires the wl_buffer.release AND signals the
  explicit-sync release point through the existing single intent, so
  syncobj clients are correct with no extra plumbing.
- A buffer that is committed but superseded before ever being
  presented takes the ordinary path (hold is only set at present).
- `bufferDestroyed` mid-scanout: the lifecycle already suppresses
  release-after-destroy; the kernel keeps the FB's memory alive while
  latched, the core repaints (surface gone -> not eligible), the
  composite flip retires the FB, and the GPU process's condemned-FB
  sweep RmFBs it.

## Rejection + retry

AddFB2 or TEST failure emits `ScanoutClientReject`; the core marks the
(outputId, bufferId) pair vetoed, damages the output, and composites.
The veto is per-BUFFER: the next buffer the client commits retries
(after the scanout feedback tranche lands, well-behaved clients
re-allocate with scannable modifiers, which is exactly the retry that
should succeed). A veto set bounded per output (last N bufferIds)
avoids unbounded growth; buffer destruction prunes it.

## Scanout dmabuf-feedback tranche

The feedback format table is Dawn-render ∩ GBM formats; the primary
plane's IN_FORMATS list currently never leaves the GPU process. To
steer fullscreen clients toward scannable allocations:

- GPU process: at ring init, intersect the allocator's format table
  with the primary plane's `readPlaneFormats` list; ship the matching
  table INDICES per output on a new `ScanoutFormats` wire frame
  (gpu -> core). Same memfd table — the scanout tranche is an index
  subset, no second table.
- Core: store per-output index arrays beside the existing feedback
  data; expose via the napi feedback bridge.
- Protocol: `get_surface_feedback` tracks feedback resources per
  surface (the `wp_fractional_scale` stored-resource pattern). While a
  surface is fullscreen on an output with a non-empty scanout index
  set, its feedback re-sends as: format_table, main_device, tranche 1
  (target_device, flags = SCANOUT, the output's scanout indices,
  done), tranche 2 (the render tranche), done. On unfullscreen it
  re-sends the render-only form. Trigger: the WM's window.committed
  bus events on `exclusive` changes.

## Pacing during scanout

The game's frame loop is unchanged from its point of view: commit ->
(damage marks the output dirty -> renderFrame chooses scanout ->
present) -> flip -> `ScanoutClientFlip` -> `wl_callback.done` +
presentation feedback with the kernel scanout timestamp. The core's
wake/flip-complete machinery drives renderFrame exactly as for
composite frames; only the present leg differs. wp_presentation
reports zero-copy flags... (deferred: the feedback `kind` bits; v1
reports the same as composite frames).

## Explicitly out of scope (v1)

- Plane-scaled scanout (buffer != mode via SRC/CRTC scaling) — needs
  per-driver TEST probing; the exact-match rule is the portable core.
- Alpha-fourcc fullscreen surfaces (would need an opaque-region
  check or an undercoat guarantee).
- Overlay planes for non-fullscreen surfaces.
- Tearing (`wp_tearing_control_v1`) — next feature; slots into the
  client-present commit flags.
- Multi-GPU blit path (cross-card buffers fail AddFB2 and fall back
  to compositing, which is correct, just not zero-copy).
