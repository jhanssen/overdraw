# Multi-output design + sequencing

Scoping/implementation plan for driving more than one output. **No code yet** —
this is the plan. Target: **KMS first** (real monitors), **independent outputs**
(each output owns its own layout/workspace/window stack, positioned in a shared
global logical coordinate space).

Design rationale lives here; ground-truth status stays in `docs/status.md`. When
work lands, fold the residual gaps into status.md's "Read first" section and trim
this doc to what is still future.

## 1. What "independent outputs" means here

- Each `OutputRecord` has a `logicalPosition` in a **global logical coordinate
  space** (already a field: `ctx.ts` `OutputRecord.logicalPosition`). Outputs are
  laid out side-by-side / stacked by an arrangement policy (config first; hotplug
  later). A window's rect is in global logical coords; each output renders the
  sub-rectangle of that space it covers.
- Each output runs its **own layout pass** over its own subset of windows. The WM
  window list gains a per-window output assignment; moving a window across the
  arrangement boundary reassigns it.
- Each output has its **own vblank clock** and presents independently. A commit
  to a window on output A must not force output B to repaint.
- `wl_surface.enter`/`leave` reflect which output(s) a surface overlaps;
  `wp_fractional_scale` preferred scale follows the surface's primary output.

**Multi-GPU (monitors on different DRM cards) is in scope, as a required later
milestone — not v1, not optional.** Hybrid laptops (iGPU drives the built-in
panel, dGPU drives the external ports) and discrete multi-GPU boxes put monitors
on *different* cards. Sections 3-10 below assume all connectors hang off one card;
that gets every monitor working only when they share a card. Section 11 covers the
multi-card architecture (render on a primary card, blit to secondary cards for
scanout) and it is the last milestone. **Multi-output is not considered complete
until a monitor on a non-primary card displays** (same standing as hotplug,
Section 10).

Out of scope for v1 (call out explicitly, do not silently drop):
- **Mirrored/cloned** outputs (same content, two CRTCs) — different model, defer.
- **Spanning** a single surface across outputs with per-output scale is handled by
  the global-space render (each output samples its sub-rect); no extra work, but
  not separately tested in v1.
- **Mixed-backend** (one KMS card + one nested host window) — not a real use case;
  nested multi-output is a separate, lower-priority track. (Multiple KMS *cards* is
  in scope — Section 11.)

## 2. Where single-output is baked in today

Two depths. The JS layer has the seams **cut but defaulted**; the native/IPC layer
has single-output **in the contract**.

### JS/TS — refactor (thread an `outputId` through marked seams)

- `state.outputs: Map<number, OutputRecord>` already exists (`ctx.ts:510`), holds
  exactly one entry seeded at `protocols/index.ts:163` with `id = OUTPUT_DEFAULT`.
- `OUTPUT_DEFAULT = 0` (`ctx.ts:137`) is hardcoded at every output-keyed call:
  - `protocols/wl_output.ts` — one global, one resource → `OUTPUT_DEFAULT`.
  - `protocols/zxdg_output_manager_v1.ts` — `outputFor()` returns the default.
  - `protocols/zwlr_layer_shell_v1.ts` — reserved zones + layer-surface output all
    `OUTPUT_DEFAULT`; the `output` arg to `get_layer_surface` is ignored.
  - `wm/layout-driver.ts:116,172` — one `outputRect` from `snap.output`, reserved
    zones keyed `OUTPUT_DEFAULT`, layout plugin sees `output.id = OUTPUT_DEFAULT`.
  - `gpu/compositor.ts` — `outputStacks` is a `Map` but `drawOrder` reads only
    `OUTPUT_DEFAULT` (`compositor.ts:941`); `renderFrame` acquires/presents one
    target; `activeTransition` is one (comment at `:740`).
  - `plugins/compose-sdk.ts`, `plugins/transitions-broker.ts`,
    `plugins/windows-sdk.ts` — actively **reject** any non-zero `outputId` with a
    thrown error (`compose-sdk.ts:120`, `transitions-broker.ts:127`).
  - `main.ts:296` — `setOnOutputDescriptor` callback mutates `OUTPUT_DEFAULT` only.

### Native / IPC — contract change (no `outputId` exists on the wire)

- `gpu-process/src/output_backend.h` — `OutputBackend` owns exactly one target:
  `size()`, `describeOutput()`, one `FrameDoneListener`, one `eventFd`, one
  `armFrameCallback()`.
- `gpu-process/src/kms_output.{h,cpp}` — picks **the first connected connector**
  (`drm_utils.cpp` `pickConnector`) and ignores the rest; one `DrmTopology topo_`,
  one `KmsScanoutRing ring_` (`kms_output.h:133-134`).
- `gpu-process/src/kms_scanout_ring.{h,cpp}` — 3-slot ring, one per backend.
- `native/ipc/side_channel.h` — `OutputDescriptor`, `ScanoutReserve`,
  `ScanoutReady`, `ScanoutPresent`, `ScanoutFlipComplete` carry **no output id**.
  `ScanoutPresent`/`FlipComplete` carry only a slot index 0..2.
- `native/core/compositor.{h,cpp}` — `acquireOutputTextureHandle()` /
  `presentOutput()` take no args; `scanoutSlots_[0..2]` is global; `flipPending()`
  is global.
- `native/napi/addon.cpp` — `AcquireOutputTexture` / `PresentOutput` /
  `updateOutputSize` / `setOutputSize` take no output id.
- `gpu-process/src/main.cpp` — one `OutputBackend`, one `output->pump()` per loop
  iteration, one epoll registration on one `eventFd`.

## 3. Output identity model

Pick **one stable small-int `outputId`** assigned by the GPU process at
enumeration time and carried on every output-scoped IPC message. The KMS
connector id is the natural source but is large/sparse; map it to a dense index
(0, 1, 2…) in a GPU-process-side table and send the dense id. The core's
`state.outputs` is keyed by this dense id. `OUTPUT_DEFAULT = 0` remains the id of
the first output, so single-output behavior is unchanged when N=1.

`OutputRecord` already carries `name` (e.g. "DP-1") for client-facing keying; the
dense `id` is the internal routing key. Do **not** expose the connector id to
clients.

**Two kinds of identity — keep them separate.** The dense `outputId` is a
**runtime routing key**: assigned at enumeration order, reused, and *not* stable
across unplug/replug (the same physical monitor can come back as a different dense
id). Anything that must remember an output *across its disappearance* — the
window-migration preference in Section 10 — must key on a **durable string
identifier**, never the dense id. Two durable keys, checked in order:

- **EDID identifier** (make + model + serial) — survives the monitor moving to a
  different port.
- **Connector name** (e.g. "DP-1") — fallback for EDID-less / identical monitors
  swapped on the same port.

`OutputRecord` carries `name` today; add a stable `edidId` field (empty when the
connector has no usable EDID) so the migration layer can match on either. The
"current output of a workspace" is then *derived* (resolve the durable key to
whatever live `outputId` currently matches), not stored as a field.

**The dividing rule (decided): the dense `outputId` is transient; durable
identifiers are the source of truth for anything that survives an output
disappearing.** Concretely:

- The dense `outputId` appears **only at runtime routing boundaries** —
  `state.outputs` key, the IPC messages, the compositor's
  `acquireOutputTexture`/`presentOutput`, and `setOutputStack(outputId, …)`. It is
  fine to keep (the existing code is already `Map<number>`, so this is the
  low-churn choice) precisely because nothing *persists* it.
- **No persistence-bearing structure keys on the dense id.** The workspace
  registry's per-workspace home is `preferredOutputs` (durable identifiers,
  Section 8); the live "which workspace is on which dense `outputId`" mapping is
  **derived** from that on each output change, never the stored truth. This is what
  removes any "re-key the maps when a monitor's dense id changes" step — there is
  no stored dense key to re-key.

## 4. IPC contract changes (foundational — do first)

Add `uint32_t outputId` to, in `native/ipc/side_channel.h`:

- `OutputDescriptor` — sent once per output at bring-up, and again per output on
  change. The core's `fireOutputDescriptors` / `setOnOutputDescriptor` path passes
  it through to JS (Section 7).
- `ScanoutReserve` — the core reserves a 3-slot ring **per output**: 3 wire
  handles + 3 bufIds + width/height **+ outputId**.
- `ScanoutReady` — per output (ok/fail for that output's ring).
- `ScanoutPresent` — `{ outputId, surfaceBufId }`.
- `ScanoutFlipComplete` — `{ outputId, surfaceBufId }`.
- Add `OutputAdded` / `OutputRemoved` for hotplug (Section 10) — deferrable to a
  later milestone, but reserve the tags now so the enum is stable.

This is a wire-format change between core and GPU process; both sides ship
together (no version negotiation across the private socket). Land it as a
mechanical "add the field, plumb it, still N=1" change **before** any behavior
changes, so each later milestone is a smaller diff.

## 5. GPU process: OutputBackend → N targets

Two viable shapes; **recommend (a)**:

**(a) `OutputBackend` owns N outputs internally.** The interface gains an
`outputId` parameter on the per-output methods (`size(id)`, `describeOutput(id,…)`,
`acquireScanout(id)`/`presentScanout(id)`), plus an enumeration method returning
the list of output ids. `eventFd()` stays a single shared fd (the DRM fd carries
all CRTCs' page-flip events). `KmsOutputBackend` holds `Map<outputId, PerOutput>`
where `PerOutput = { DrmTopology, KmsScanoutRing }`. The page-flip handler routes
each event to the right ring by CRTC id (the `drmEventContext` page-flip callback
receives user_data — stash the `PerOutput*` there).

**(b) one `OutputBackend` instance per output.** Cleaner per-instance state but
duplicates the GBM device / instance ownership and complicates the shared DRM fd
and shared epoll registration. Rejected for KMS (one DRM fd, one GBM device, N
CRTCs is the natural grouping).

`main.cpp` changes: enumerate all outputs at `open()`, send one `OutputDescriptor`
per output, run `initScanout` per output (each reserves its own 3 handles from the
core — see the reserve handshake in `status.md` "KMS scanout backend → Bring-up
flow"), and in the present loop dispatch flips per output. The `output->pump()`
call stays single (one fd) but now advances N rings.

`drm_utils.cpp`: `pickConnector` becomes `enumerateConnectors` returning all
connected connectors with modes. CRTC assignment must avoid collisions — walk each
connector's `possible_crtcs` mask and assign distinct CRTCs greedily; a connector
with no free compatible CRTC is dropped with a logged warning (do not silently
skip — Section 13).

## 6. Core compositor: per-output scanout state

`native/core/compositor.{h,cpp}`:

- `scanoutSlots_[0..2]` → `Map<outputId, ScanoutSlot[3]>` (or a small vector
  indexed by dense id).
- `acquireOutputTextureHandle(outputId)` / `presentOutput(outputId)` take the id;
  `currentSlot_` becomes per-output (the acquire→present pair must not interleave
  across outputs within one render, or track `{outputId, slot}` on acquire).
- `ScanoutReserve`/`Ready` issued per output during bring-up; `drainCtrl` parses
  the `outputId` on `ScanoutFlipComplete` and advances that output's slot machine.
- `flipPending()` → `flipPending(outputId)`.

`native/napi/addon.cpp`: `AcquireOutputTexture(outputId)`,
`PresentOutput(outputId)`, `updateOutputSize(outputId, w, h)`,
`setOutputSize(outputId, w, h, scale)`.

## 7. JS compositor + frame loop (the hard part)

This is where independent-outputs is more than plumbing.

### Render

`JsCompositor.renderFrame` today: acquire one output texture → composite the
global stack → present. Multi-output: **for each output that needs a frame**,
acquire that output's texture, set the render-pass viewport/scissor to that
output's rect in the global logical space (scaled to device), composite the
surfaces that intersect that output's region, present that output.

- `outputStacks` is keyed by outputId; `drawOrder(outputId)` reads that output's
  override and falls back to the global stack.
- The **composite-scissor damage ring** is multiplexed by `OutputDamageMap`: one
  `OutputDamageRing` per output, keyed by that output's scanout-slot handles and
  bounded by its own logical size. Damage rects in global space are clipped into
  each output's local space and translated back on take().
- **`activeTransition` is per-output** (`Map<outputId, ActiveTransition>`). A
  transition runs on one output; two simultaneous transitions on different
  outputs are allowed, and the compositor dedups producer Begin/End brackets
  across outputs by sceneId so two transitions sharing a Worker-live scene fire
  exactly one Begin and one End per frame for that scene.
- **`liveScenes` and `phantoms` stay global**: each `liveScene` writes into its
  own offscreen target texture (unrelated to any on-screen output), and a
  phantom's global-space rect plus the renderer's per-output viewport+scissor
  confines it to where it belongs without per-output bookkeeping. Section-12
  M4's earlier note "`activeTransition`, `liveScenes`, phantoms become per-
  output maps" was wrong for the last two.

### Pacing

`wantNext` stays a single global flag. Per-output independence comes from two
mechanisms below it:

- `acquireOutputTextureHandle(outputId)` returns null when that output's ring
  has any slot in `PENDING_FLIP`, so a busy output is skipped this frame and
  re-triggered by its own flip-complete.
- `dispatchFrameCallbacksForOutput(timeMs, outputId)` fires `wl_callback.done`
  only for surfaces resident on the flipped output (surface→output residency is
  computed from the surface's global rect vs each output's rect).

A "per-output `wantNext`" was explored but adds no behavior the acquire-time
gate doesn't already give; busy outputs are skipped, free ones render. The cost
is one cheap empty composite-scissored pass per idle vblank, which is what the
per-output damage map's "nothing changed → tiny scissor" path produces today.

## 8. WM / layout: per-output

- `wm/index.ts`: each window gains an `outputId` (which output it is laid out on).
  Insertion assigns it (initially the focused/primary output); a move across the
  arrangement boundary reassigns and triggers relayout on both outputs.
- `wm/layout-driver.ts:runOnce`: loop over outputs. For each output build its
  `outputRect` from that output's `OutputRecord.logicalPosition + logicalSize`,
  subtract that output's reserved zones, partition windows by `outputId`, run the
  layout plugin once per output (`output.id` = real id, `output.rect` =
  global-space rect). Plugin contract is already per-output-shaped
  (`LayoutInputs.output`), so the plugin needs no change for independent layouts.
- Concrete single-output caps to lift for the existing workspace plumbing:
  `main.ts:603` caches "only the default-output workspace"; `outputToplevelStacks`
  (`ctx.ts:491`) and the per-output stack overrides need to be exercised for
  `outputId != 0` (the `setOutputStack(outputId, …)` seam already accepts any id).

### The relocation unit is the workspace (already built)

Workspaces already exist and were built per-output-aware (status.md "Workspaces
(Phase 6)"): the bundled `@overdraw/plugin-workspace-default` owns a registry
keyed by output — `positionsByOutput`, `shownByOutput`, `surfaceToHandle` — and
every action/event carries an `outputId`. The plugin owns the registry; core sees
only `sdk.windows.setOutputStack(outputId, ids[])`. The WM has **no** concept of
workspaces — it lays out all windows; the workspace plugin filters what each output
draws. The system is single-output only because enumeration caps `outputId` to 0
(status.md caveat: "only output 0 is meaningful until multi-output enumeration
lands"), not because the model is single-output.

So the unit that moves between outputs on a hotplug (Section 10) is the
**workspace**, and the migration state attaches to **workspace records in the
plugin's registry** — there is no separate "layout group" abstraction to invent.
This also locates the policy: the workspace plugin already owns `positionsByOutput`,
so the migration logic most naturally lives **in the plugin**, driven by
`output.added` / `output.removed` bus events (the multi-output extension of the
existing `output.changed` event), with core/WM supplying only those signals plus
the virtual fallback output (Section 10).

A workspace's home is **not** a stored live `outputId`. It is a **durable
preferred-output list** (Section 3 identity), most-preferred first, resolved on
demand to whatever live output currently matches:

- **`preferredOutputs: string[]`** per workspace record — durable identifiers (EDID
  id or connector name), never the runtime dense id. This is a new field on the
  registry's `byHandle` record.
- The workspace's *current* output is **derived**: the first entry in
  `preferredOutputs` that resolves to a connected output. `positionsByOutput` /
  `shownByOutput` are then indexed by that derived live id. There is no separate
  durable "current output" to keep in sync.
- The list **only grows or reorders, never shrinks** — a workspace accumulates the
  history of every output it has lived on, so a returning monitor can reclaim it.

Mutations (the only three):
1. **Config seed** at workspace creation: a user rule (`workspace → output order`)
   pre-populates `preferredOutputs` (the existing `workspace.create({outputId?})`
   gains a durable-identifier seed path).
2. **Append on placement**: when a workspace is forced onto an output not already
   in its list (a fallback during evacuation), that output is appended at *lowest*
   priority — remembered, but not preferred.
3. **Promote on explicit move**: `workspace.move-window` / a future "move workspace
   to output X" raises X to just above the workspace's previous output in the list.
   Manual moves teach the order; they do not reset it.

## 9. Protocol layer: per-output resources

- `wl_output.ts`: create **one `wl_global` per output** (not one global mapped to
  the default). On bind, associate the resource with its output's id; emit that
  output's geometry/mode/scale/name/done. `state.wlOutputResources` is already
  keyed by outputId (`ctx.ts:359`), so the tracking-set + re-emit machinery
  generalizes; the missing piece is creating/destroying the global per output on
  add/remove.
- `zxdg_output_manager_v1.ts`: `outputFor(resource)` resolves the bound output id
  instead of always returning default; `logical_position` now reports the output's
  real `logicalPosition` (today always 0,0).
- `zwlr_layer_shell_v1.ts`: honor the `output` arg to `get_layer_surface`
  (NULL = compositor picks primary); reserved zones keyed by that output.
- `wl_surface.enter`/`leave`: emit when a surface's global rect starts/stops
  overlapping an output (not wired today — single output meant always-entered).

## 10. Output arrangement + hotplug

- **Arrangement is user-declared, not inferred.** There is **no compositor policy
  for physical placement** — nothing in EDID or the connection tells us where
  monitors physically sit relative to each other, so the user must declare it. Core
  resolves the user's declaration into each output's `logicalPosition`; it applies
  no heuristic. The config model must express **full 2D placement, including
  vertical stacking** — a 1D left-to-right ordering cannot represent e.g. one
  monitor on the left with two monitors stacked above/below each other on the
  right. With mismatched resolutions/scales the covered global space is
  **non-rectangular** (overhangs and gaps between outputs); pointer edge-traversal
  (Section: pointer mapping) must handle non-contiguous coverage — moving the
  pointer toward a gap has no destination output.

  **v1: absolute logical position** per output — `output."DP-1".position = {x, y}`.
  Unambiguous, full 2D, and the durable ground-truth form: a future GUI canvas
  (drag monitors to replicate the physical layout) emits exactly these coordinates,
  so absolute is what any higher-level tool resolves *to*. Two accepted v1 sharp
  edges, fixable later: (a) the coordinates are **logical**, so under HiDPI they are
  not the monitor's pixel resolution — `x` of a right-hand output equals the
  left output's *logical* width (device width / scale); (b) the user must **know
  that width** to butt a second monitor against the first's right edge. Relative
  placement (`right-of DP-1` / `below DP-2`, topologically resolved to absolute,
  with edge-alignment rules) removes (b) and is the natural later sugar; a GUI
  canvas removes both. Neither is v1.
  Undeclared outputs need a **deterministic fallback** (e.g. placed to the right of
  the last, top-aligned, enumeration order) so multi-output works before the user
  configures — this is a fallback to keep the system usable, **not** a placement
  policy; user config is authoritative.
- **Hotplug detection**: monitor connect/disconnect does **not** arrive on the DRM
  fd (that fd carries only page-flip / vblank). It comes on a separate **udev
  netlink monitor** fd, filtered to the `drm` subsystem, added to the GPU process's
  epoll loop (`event_loop.h`). The uevent is a generic "card changed" with a
  `HOTPLUG=1` property (and optional `CONNECTOR=<id>` hint); the robust response is
  to re-probe — `drmModeGetResources` → `drmModeGetConnector` per connector — and
  diff each connector's `connection` status against the prior snapshot to find what
  added/removed. This is a genuinely new dependency: the GPU process uses libseat
  for the card today but has no udev monitor.

  **Hotplug is required, not optional.** A multi-output compositor that only
  enumerates at startup is not a complete system — dock/undock and external-monitor
  plug/unplug are the common case, not an edge case. It is the **last** milestone
  only because it builds on the per-output workspace model (milestone 5), not
  because it can be dropped. Milestones 1-6 are intermediate states of one
  in-progress feature, not a shippable endpoint that omits hotplug; "multi-output"
  is not done until live plug/unplug works.
- **Hotplug propagation**: `OutputAdded`/`OutputRemoved` IPC (Section 4) → core
  adds/removes the `state.outputs` entry, creates/destroys that output's `wl_output`
  global (clients see `wl_registry.global` / `global_remove` and re-bind),
  re-arranges, relayouts, and emits `output.added`/`output.removed` on the plugin
  bus so the workspace plugin runs the migration (below). Its own milestone.

### Workspace migration on output change

The "where do windows go when a monitor disappears, and do they come back" policy.
The unit is the **workspace** (Section 8 — already built, per-output-keyed). The
policy lives in the **workspace plugin** (it owns `positionsByOutput` /
`shownByOutput`), reacting to `output.added`/`output.removed`. It relies on the
durable preferred-output list, the derive-current-from-list rule, and one piece
core must provide:

- **A persistent virtual fallback output, stored OUTSIDE `state.outputs`.**
  Always keep one never-scanned-out output handle alive — but as a separate
  field (`state.fallbackOutput`), not as an entry in `state.outputs`. When the
  **last real monitor disappears**, workspaces park on it: their windows stay
  fully alive in the WM tree, clients keep running, nothing is presented.
  Keeping it parallel to `state.outputs` (rather than inside it) means every
  iteration over `state.outputs` (render passes, wl_output globals, xdg-output,
  layout-driver, IPC enumeration, output-management v1) is automatically free
  of the fallback — no per-layer "skip the sentinel" branches. Only the
  workspace migration code (and a tiny amount of WM/layout logic that asks
  "where does an orphaned workspace live") references `state.fallbackOutput`
  directly. The fallback output has a stable durable identifier reserved for
  it (a sentinel `name` and empty `edidId`) so `preferredOutputs` resolution
  treats it like any other output identifier without special casing.

The whole policy is one operation: **on any output add/remove, recompute every
workspace's current live output as the highest-ranked entry in its
`preferredOutputs` that resolves to a connected output, then push `setOutputStack`
for the resulting per-output draw lists.** Because the current output is derived,
not stored, there is no map to re-key — removal and return below are just the two
interesting cases of that recompute.

**On output removal** — each workspace whose derived output was the dying one
recomputes its home:
1. The highest-ranked `preferredOutputs` entry that still resolves to a connected
   *real* output.
2. If none of its remembered outputs survive → the first remaining real output
   (and append it to `preferredOutputs` at lowest priority — now remembered).
3. If there is no real output at all → `state.fallbackOutput` (parked, alive,
   invisible; not in `state.outputs`).
4. Re-push `setOutputStack` for the affected outputs and relayout. Windows sized
   against the zero-area fallback are re-sized/re-centered when they next land on a
   real output.

**On output return** (a monitor reappears, or any output is enabled): the recompute
naturally produces two effects.
1. **Reclaim by preference.** Any workspace whose highest-ranked resolvable
   preferred output is now the *returning* output derives back onto it — it leaves
   wherever it had fallen back. A workspace that fell onto another monitor when its
   preferred one unplugged migrates **back** the instant that monitor returns — the
   durable preference outranks "it's fine where it is." (This is why the preferred
   list holds durable identifiers, not the dense id, and why entries are never
   removed.)
2. **Restore parked workspaces.** Everything that had derived onto the virtual
   fallback output now derives onto the returning monitor; re-size zero-area
   floaters.

Because the preferred list holds durable identifiers, a monitor unplugged and
replugged on a different port (new dense `outputId`, same EDID id) still reclaims
its workspaces. Preserve the existing per-output invariant (≥1 workspace per
touched output) across all of this.

## 11. Multi-GPU (multiple DRM cards)

Required, not optional (Section 1). Monitors split across cards — hybrid
iGPU+dGPU laptops (built-in panel on the integrated GPU, external ports on the
discrete GPU) and discrete multi-GPU boxes — cannot all be driven by the
single-card path Sections 3-10 build. This is its own milestone on top, and
multi-output is not complete until a monitor on a non-primary card displays.

### Model: one primary renderer, secondary cards scan out a copy

- **Enumerate every DRM card**, not just the first. Today the GPU process opens one
  card (`Seat::openFirstConnectedCard`); multi-GPU opens every connected card via
  libseat and constructs one Dawn device per card.
- **One primary card renders.** The compositor's WebGPU passes run on the primary
  card's Dawn device exactly as today; the primary's own connectors scan out
  directly (the per-output ring from M4).
- **Secondary cards are scanout-only** — connectors but no compositing. Each frame
  bound for a secondary card's output is copied from the primary to that card and
  scanned out there.
- **The bridge is a cross-GPU blit, never zero-copy.** The primary's rendered buffer
  is exported as a dmabuf, imported on the secondary card's device, and blitted (a
  Dawn pass on the secondary device) into that card's scanout-ring buffer, then
  page-flipped. The copy is unavoidable — two cards cannot share a scanout buffer.
- **Cross-card sync rides explicit fences:** the secondary's blit waits on the
  primary's render-complete fence; the page-flip's `IN_FENCE_FD` waits on the blit.
  Same explicit-sync machinery the single-card scanout path uses, extended across
  the device boundary.
- **Shared buffers use linear (or a vendor-neutral) modifier** — tiled modifiers are
  not portable across vendors. The per-card tiled-scanout win is given up on the
  secondary path only.

### Primary card selection is user-controlled

The user picks the primary renderer — config `output.primaryCard` (or
`--primary-card=/dev/dri/cardN`). Default when unset: the card with a built-in
panel / `boot_vga` (the integrated GPU), else the first enumerated card. The
integrated GPU is usually the right renderer (lower power, drives the internal
panel directly), but a user may want the discrete GPU as primary for performance —
only they know their intent, so beyond the default we do not guess.

### overdraw specifics + landmines

- Adapter↔card matching already exists (each card's render node matched to a Dawn
  adapter via `WGPUAdapterPropertiesDrm`); multi-GPU generalizes it from one card to
  a device-per-card map.
- The cross-card blit is a Dawn pass between two independent `wgpu::Device`s — the
  hard new primitive. Needs dmabuf export on the primary + import on the secondary,
  device-to-device (client-dmabuf import already exists, but to one device).
- Dawn's single-FD dmabuf import limit (status.md) constrains the shared buffer to a
  single-plane format — fine for a linear RGBA blit target.
- A non-Intel secondary is the hardest case: that vendor's scanout is unverified
  end-to-end (status.md) and its linear-buffer / cursor-plane scanout path is a known
  trouble spot. The integrated-primary + discrete-secondary hybrid laptop is exactly
  this case.
- M4 already takes the scanout ring / page-flip routing / `OutputBackend` per-output;
  multi-GPU adds a per-card dimension above that (each card owns a subset of outputs
  plus its own device / allocator / blit).

### Testing

Cannot be exercised on a single-GPU box. A discrete multi-GPU box, or any machine
where two monitors sit on two cards, is required; verified manually (Section 13)
like the rest of the KMS path. Note a hybrid laptop with only one external connector
cannot produce the single-card two-monitor case at all (its two monitors are always
on two cards), so the single-card path (M3-M7) and the multi-card path (this
section) need different test hardware.

## 12. Sequencing (milestones)

Each milestone is independently landable and leaves the tree working at N=1. The
ordering is a build sequence, not a scope boundary: the feature is complete only
after **both** hotplug (M7) and multi-GPU (M8). Milestones 1-7 are intermediate
states of one feature, not a shippable endpoint.

**Status: M1-M5 done.** M1-M4 surface-verified on a single-card two-monitor
setup (HDMI 60Hz + DP 240Hz both lit). M5 unit-tested GPU-free (1186 unit green
+ GPU green); structural multi-output is now end-to-end through every JS layer
except the wire-protocol globals (M6). 4h-a, 4h-b, and 4h-c all done in M4;
the M4 follow-ups originally listed as "done" but not actually implemented
(`drawOrder(outputId)`, per-output `activeTransition` with cross-output bracket
dedup) also landed. M6-M8 remain. A multi-GPU render-node robustness fix landed
en route (the GBM allocator + dmabuf clients follow the chosen adapter's GPU,
not a hardcoded `renderD128`).

**Deviation from this doc, taken in M5:** the virtual fallback output lives at
`state.fallbackOutput` — a separate field — and NOT as an entry in
`state.outputs`. The doc originally proposed putting it inside `state.outputs`
("`OUTPUT_DEFAULT = 0` is the natural identity for it"); keeping it parallel
instead means every iteration over the live output map (renderer, wl_output
globals, xdg-output, layout-driver, IPC enumeration, wl_output bind paths) is
automatically free of the fallback with no per-layer "skip the sentinel"
branches. Only the workspace migration code (M7) references
`state.fallbackOutput` directly. The fallback's sentinel id is `OUTPUT_FALLBACK
= -1` (negative so it cannot collide with a dense connector id) and its
durable identifier is the reserved name `"__fallback__"` (no real DRM
connector name starts with double-underscore). Sections 3, 10, and 14 carry
the resolved decision.

1. **IPC outputId plumbing (no behavior change).** Add `outputId` to the messages
   (Section 4), thread through compositor/addon/main.cpp, still drive one output.
   Tree behaves identically. Smallest foundational diff.
2. **JS outputId threading (no behavior change).** Thread the descriptor entry
   point: `onOutputDescriptor` routes by `d.outputId` (record lookup + bus emit)
   instead of hardcoded `OUTPUT_DEFAULT`. This is the seam where real per-output ids
   first arrive from M3; everything still resolves to output 0 today. The remaining
   `OUTPUT_DEFAULT` seams in Section 2 are NOT threaded here — they fold into the
   later milestone that builds their per-output machinery: `wl_output` globals +
   xdg-output → M6; layout-driver + reserved zones → M5; compositor `drawOrder` /
   render → M4. The **plugin-SDK validation** (compose/transitions reject
   `outputId != OUTPUT_DEFAULT`) also moves later: relaxing it *correctly* means
   "reject unknown output," which needs the live `state.outputs` registry plumbed
   into those SDKs as a dependency (it is not today) — done in M3/M5 when >1 output
   first exists. Relaxing to "accept any id" now would route to a nonexistent
   output and silently fail, so it is deliberately deferred, not done half-way.
3. **Native connector enumeration + N output descriptors.** `KmsOutputBackend`
   enumerates all connected connectors (`enumerateConnectors`); the GPU process
   sends an `OutputDescriptor` per connector (primary = outputId 0, the
   scanout-driven one; extras = 1..N). The core's `onOutputDescriptor` creates a
   `state.outputs` record on first sight of a new id (deterministic right-of
   placement via `output/arrangement.ts` until real arrangement lands) and applies
   the render/WM/input globals only for the primary. **Result: core knows the full
   topology; extra monitors are detected and reported but not yet lit.** The ring /
   CRTC-assignment / modeset / per-CRTC flip-routing machinery deliberately moves to
   M4 (below) — building idle scanout rings for monitors nothing renders to is
   wasteful and would mean refactoring the working single-output scanout path with
   no way to render the result. KMS-only parts verified manually (Section 13); the
   JS record-creation + arrangement fallback are unit-tested. Plumbing the
   live-output registry into the compose/transitions SDKs (validation
   `== OUTPUT_DEFAULT` → `state.outputs.has(id)`) lands here or in M5 once a second
   output is renderable.
4. **Per-output render + pacing. [DONE — surface-verified]** Per-output scanout
   rings + distinct-CRTC assignment + modeset, per-output bring-up handshake +
   fence routing, and `renderFrame` rendering each output's slice of the global
   space (Sections 5-7). **Verified lit on real hardware: a single-card two-monitor
   setup (HDMI 60Hz + DP 240Hz) both display.** Single-output byte-identical; 1083
   unit + 136 GPU green. Hardware testing found four real bugs that build + headless
   could not (a fence-routing `close(0)` that closed the DRM card fd — fd 0 holds
   the card in the GPU child; the per-output flip gate; per-output frame-callback
   dispatch; a shared-uniform-buffer overwrite across per-output passes), all fixed.
   - **(4h-a) Independent per-output pacing. [DONE]** Each output is clocked by its
     OWN vblank, not the union of all outputs' flips. Mechanism: a **per-output flip
     gate** (`acquireOutputTextureHandle(outputId)` returns null when that output
     has a slot in PENDING_FLIP, so the render skips it until its own flip-complete)
     plus **per-output frame-callback dispatch** (a queue of flipped outputIds drives
     `dispatchFrameCallbacksForOutput`, so a client on the 60Hz panel gets `done` at
     60Hz, not the 240Hz peer's rate, keyed by surface→output residency). The §14
     resolved decision, satisfied. (An earlier per-output *dirty-set* short-circuit
     was removed: it skipped frame-callback dispatch for "clean" outputs — stalling
     their clients — and its mark heuristics were fragile. Idle-output cost is now
     one cheap empty composite-scissored pass per vblank, not a skipped render.)
   - **(4h-b) Per-output composite-damage bounds. [DONE]** Each output owns an
     `OutputDamageRing` (multiplexed by `OutputDamageMap`) keyed by its scanout-
     slot handles, bounded by its own logical size. The map dispatches a global-
     space damage rect into the rings of every output it overlaps, clipping into
     each output's local space and translating back to global on take(). The
     prior "single output at the global origin" gate on partial scissor is gone —
     every output now gets a damage-optimal partial scissor when nothing else on
     it changed.
   - **(4h-c) Pointer crosses freely between outputs. [DONE]** The libinput
     backend's `setOutputSize(w, h)` was replaced with `setOutputLayout(rects)`:
     it stores the full set of per-output rects and clamps accumulated relative
     motion against their union by closest-point projection (each rect's
     projection keeps the result strictly inside its half-open right/bottom edge
     by `EDGE_EPSILON = 1/256`, eliminating event-to-event jitter at the wall).
     `main.ts` pushes the full layout to the input backend on every descriptor
     change, dropping the prior isPrimary gate. The algorithm is mirrored in
     `src/output/pointer-clamp.ts` (canonical TypeScript with unit tests) and
     ported byte-for-byte into `input_libinput.cpp`.
   - **(M4 polish, not originally listed)** Two items Section 12's M4 listed as
     done but weren't, fixed in this round: `drawOrder(outputId)` so per-output
     content stacks (set via `setOutputStack`) actually render on their target
     output, and per-output `activeTransition` (`Map<outputId, ActiveTransition>`
     with cross-output Worker-live producer-bracket dedup keyed by sceneId) so
     two simultaneous workspace transitions on two monitors work without
     tripping the GPU process's Begin/End alternation rule when they share a
     scene texture.
5. **Per-output WM + layout + workspaces. [DONE — GPU-free unit + GPU green.]**
   Per-output layout pass: each window carries an `outputId`; the WM holds a
   `Map<outputId, WmOutput>` set wholesale via `setOutputs`; the layout-driver
   loops per output, partitions windows by `outputId`, and computes each output's
   own tile region (its rect minus its own reserved zones). Boundary-crossing
   reassignment: `setFloatingRect` picks the output the rect's center lands on.
   Layer-shell honors the `output` arg to `get_layer_surface` (resolves a bound
   wl_output → outputId), and reserved zones key on the resolved outputId so a
   status bar on output 1 doesn't shrink output 0. Workspace registry gains
   `preferredOutputs: string[]` (durable identifiers, never the dense id) with
   three mutations: config seed at create, append-on-forced-placement,
   promote-on-explicit-move; plus `currentLiveOutput` resolver and unit coverage
   for replug-on-different-port reclaim. Virtual fallback output landed at
   `state.fallbackOutput` (NOT inside `state.outputs` — see "Deviation" note in
   §12). `sdk.compose` validates outputId against the live output set via a
   plumbed `hasOutput`; Worker plugins get a spawn-time snapshot of live ids in
   `workerData`. `setOnOutputDescriptor` feeds every output (not just the
   primary) into `wm.setOutputs`. The per-output `wantNext` cache became a
   `Map<outputId, number>` keyed for activeOutput resolution off pointer
   position. M6 (per-output protocol resources) is the wire-side counterpart;
   the WM/workspace structure is now complete and ready for hotplug (M7) to
   drive `setOutputs` and `preferredOutputs` recompute on connector
   add/remove events.
6. **Per-output protocol resources.** N `wl_output` globals, real xdg-output
   positions, `wl_surface.enter/leave`, layer-shell output targeting (Section 9).
7. **Hotplug (required for completeness).** udev-monitor detection +
   `OutputAdded`/`Removed` end-to-end, and the workspace-migration policy in the
   workspace plugin — removal evacuation, return-reclaim by preference,
   restore-from-fallback (Section 10). The per-output workspace model +
   `preferredOutputs` from milestone 5 is the prerequisite; this milestone makes it
   react to live plug/unplug. Not optional — multi-output is incomplete without it
   (Section 10).
8. **Multi-GPU (required for completeness).** Enumerate all cards, one Dawn device
   per card, user-selectable primary renderer, cross-card dmabuf blit + explicit-sync
   for secondary-card scanout (Section 11). The per-output machinery from M4-M7 is
   the prerequisite; this adds the per-card dimension. Not optional — a monitor on a
   non-primary card (the hybrid-laptop case) does not work until this lands.

## 13. Testing — and a real gap to settle first

Per the project testing policy, every new protocol/behavior gets a test at the
cheapest tier that proves it. Most of this plan is testable GPU-free or via the
nested harness:

- **GPU-free / unit**: outputId threading, `state.outputs` multi-entry, arrangement
  policy (`resolveScale` sibling), per-output layout-driver partitioning,
  `wl_output` per-output bind/re-emit/scrub, xdg-output positions, window→output
  assignment + reassignment, surface→output overlap → enter/leave. The whole
  **workspace-migration policy** (Section 10) is pure logic over the workspace
  registry + `state.outputs`, so it extends the existing
  `test/plugin-workspace-default/registry.test.js` without any GPU: preferred-list
  resolution (highest-ranked live output), the three mutation rules, removal
  evacuation, return-reclaim by durable identifier, fallback parking + restore,
  replug-on-different-port (same EDID id, new dense id) reclaim, and the ≥1
  workspace-per-output invariant holding across migrations.
- **Nested harness** (`*.gpu.mjs`): a **fabricated second output** in the nested
  backend (a second host window, or a synthetic second `OutputRecord` + second
  scanout target) exercises per-output render, per-output `wantNext` pacing,
  per-output damage, and frame-callback routing without bare metal.

**The gap (flagging, not deciding silently):** the milestone-3/4 work that is
*genuinely KMS-only* — N-connector enumeration, distinct-CRTC assignment, and
per-CRTC page-flip routing — **has no automated coverage today and cannot get it
under the current harness.** `status.md` records "No KMS coverage in the test
suite (per user direction, option A)" for the existing single-output KMS path; the
honest extension is that the per-CRTC routing logic inherits that gap and is the
most fragile new native code. Two options, neither chosen yet:

- **Accept the same gap**: verify N-connector KMS by manual run on real
  multi-monitor hardware only, mirroring the current single-output KMS decision.
- **Build a vkms (virtual DRM) harness**: lets CI drive 2+ virtual connectors and
  automate the enumeration/routing logic. This is real new infrastructure (its own
  piece of work) but is the only way milestones 3/4's KMS-specific code gets
  regression coverage.

**Decision (taken): accept the gap — manual verification for now.** N-connector
enumeration, distinct-CRTC assignment, and per-CRTC page-flip routing are verified
by manual run on real multi-monitor hardware, mirroring the existing single-output
KMS decision in `status.md`. This is a *flagged* gap, not a silent one: the
KMS-specific native code in milestones 3/4 ships without automated coverage, and
that must be stated in `status.md` when it lands. A vkms harness remains the
future path to close it if the manual-only risk proves too high.

## 14. Open questions for the user

None outstanding — all decisions below are resolved. Reopen if a constraint
changes.

Resolved:
- Arrangement ownership — **user-declared, core-resolved; no placement policy.**
  Physical placement cannot be inferred, so the user declares it; core resolves the
  declaration into `logicalPosition` with no heuristic. Must support full 2D incl.
  vertical stacking. A deterministic fallback covers undeclared outputs (usability,
  not policy). Not a plugin seam in v1 (Section 10).
- Arrangement config form — **absolute logical `{x,y}` per output** for v1
  (ground-truth form a future GUI canvas resolves to). Accepted v1 awkwardness: the
  user must know an output's logical width to butt another against its edge.
  Relative placement / GUI canvas are later sugar, not v1 (Section 10).
- KMS test coverage — manual verification (Section 13).
- Migration unit — the **workspace** (already built, per-output-keyed); no new
  "layout group" abstraction. Single-output only because enumeration caps
  `outputId` to 0 (Section 8).
- Output identity — **keep the dense `outputId`** as the transient runtime routing
  handle (low-churn, existing `Map<number>`); it is never persisted. The durable
  preferred-output list (EDID id / connector name) is the source of truth for
  persistence; the live workspace→output mapping is derived from it (Section 3).
- Migration policy owner — the **workspace plugin** holds `preferredOutputs` and
  runs the recompute on `output.added`/`output.removed`; core supplies only those
  bus signals and the virtual fallback output (Sections 8, 10).
- Virtual fallback output location — **stored as `state.fallbackOutput`, NOT as
  an entry in `state.outputs`.** Keeping it out of the live-outputs map means
  every iteration over `state.outputs` (renderer, wl_output globals, xdg-output,
  layout-driver, IPC enumeration) is automatically free of it without any
  per-layer "skip the sentinel" branches; only the workspace migration code
  references it directly. Its durable identifier is a reserved sentinel name
  (no real connector ever produces it) so `preferredOutputs` resolution treats
  it uniformly (Section 10).
- Per-output pacing — **independent per-output clocks**, DONE. Each output is
  clocked by its own vblank via a per-output flip gate + per-output frame-callback
  dispatch (not the removed dirty-set short-circuit). See M4 / 4h-a in Section 12.
- Hotplug — **required, not deferrable.** Sequenced as milestone 7 because it
  builds on the per-output workspace model, but multi-output is not complete
  without live plug/unplug (Sections 10, 12).
- Multi-GPU (multiple DRM cards) — **required, not deferrable; its own milestone
  (M8) on top.** Render on a user-selected primary card, blit to secondary cards for
  scanout. The feature is not complete until a monitor on a non-primary card (the
  hybrid-laptop case) displays. Primary card is **user-selectable** (`output.
  primaryCard` / `--primary-card`), defaulting to the integrated/built-in-panel GPU
  (Section 11).
