# overdraw — HiDPI / fractional-scale design

End-to-end pixel-density handling: clients render at the right physical density
on high-DPI panels, the cursor scales, pointer coordinates and layout work in
logical pixels everywhere they should, and the compositing pass samples client
buffers at the correct ratio. Read `status.md` first for what's there today:
`wl_output.send_scale` is real per slice 3 (the descriptor channel carries
scale and the value advertised matches the host's; on KMS the connector's
default scale will be 1 until this work lands), but `wl_surface.set_buffer_scale`
is a silent no-op, `wl_surface.send_preferred_buffer_scale` is never sent,
`wp_fractional_scale_v1` and `wp_viewporter` are not advertised, the cursor
resolver takes a scale arg that is always 1 (`cursor-design.md`), and pointer
coordinates are not divided by scale before clamping (flagged at the end of
slice 3).

This document is the design. No code changes are made by this document.

## Silent gaps this design will close

Discovered while writing this doc; not yet in `status.md` "Read first"
because they're harmless at scale=1 / transform=normal (the defaults) but
become incorrect the moment HiDPI work or per-surface transforms land. The
sub-slices below take ownership of fixing them — listed here so the
ownership is unambiguous.

- **`wl_surface.set_buffer_scale` is a silent no-op**
  (`packages/core/src/protocols/wl_surface.ts:184`). The request is
  advertised via the `wl_surface` v6 generator output and the trampoline
  accepts it; the handler discards the argument. A client that calls it
  sees no behavior change. Owned by sub-slice C.
- **`wl_surface.set_buffer_transform` is a silent no-op**
  (`packages/core/src/protocols/wl_surface.ts:183`). Same shape: advertised,
  accepted, discarded. Owned by sub-slice G.

Treat both as "advertised-incomplete" gaps in the same family as
`xdg_toplevel` state requests (status.md "Read first") — clients think they
work; they don't. The sub-slices below replace the no-op bodies with the
double-buffered (pending + apply-on-commit) state machine those requests are
specified to use.

## Why now / why later

**Why HiDPI matters for phase 2.** The remote test box is 2560×1600 over a 16"
panel: 189 dpi. A scale-1 nested or KMS session renders text at half the
expected physical size; foot at default font size becomes uncomfortable. Phase
2's verification target ("the panel lights up; foot / kitty / WSI clients run;
you can chvt away and back") is technically met without HiDPI, but the result
is unpleasant to use.

**Why it's not in the phase-2 critical path.** HiDPI and KMS are orthogonal.
KMS slice 4 can come up at scale 1 and prove the modesetting / scanout chain.
HiDPI then closes the user-visibility gap on the same machine. The two work
streams can interleave or sequence either way; the recommendation is HiDPI
**after slice 7** (VT switching), so KMS is fully functional first and HiDPI
becomes the last user-visible piece of phase 2.

**What this document is not.** It is not a phase number. It is the shape of
the work whenever it is picked up.

## The four coordinate spaces

The single biggest source of bugs in HiDPI compositors is conflating spaces.
overdraw has FOUR:

1. **Buffer space** — the client's `wl_buffer` dimensions. Always physical
   pixels of that buffer's grid. Carries an integer `set_buffer_scale` and/or
   a fractional `wp_fractional_scale_v1` preferred scale. Unrelated to the
   output's scale; the client picks the buffer scale it wants to render at.
2. **Surface space** — `wl_surface`'s logical extent. Buffer space ÷
   buffer_scale (or, with viewporter, the surface size set by
   `wp_viewport.set_destination`). This is what clients use for input
   coordinates, input regions, popup positioner anchor rects, subsurface
   offsets, and configure size acks.
3. **Output space (logical)** — the output's logical-pixel rect. The WM lays
   out windows in this space. `wl_output.logical_size` (= xdg-output's
   `logical_size`). For a 2560×1600 panel at output scale 2, this is
   1280×800 logical pixels.
4. **Output space (physical)** — the scanout target's physical pixels. The
   compositor's render passes target this; KMS / WSI swapchain attachments
   are sized here. 2560×1600 in the example above.

Conversion factors (always positive integers or rationals):
- `buffer_to_surface = 1 / buffer_scale` (or the viewporter dst/src ratio).
- `surface_to_output_logical` is the WM's layout (identity rectangle).
- `output_logical_to_physical = output_scale` (integer for v1; fractional
  later).

Today the compositor effectively conflates surface space with output-physical
space (assumes scale 1 everywhere). Every change below is "convert at the
right boundary, don't assume identity."

## Scope

In scope:

- **Output scale propagation through the render pipeline.** The compositor's
  render passes target output-physical pixels; the swapchain (nested or KMS)
  is allocated at output-physical. The descriptor channel already carries
  `scale`; `JsCompositor` and the GPU process consume it.
- **`wl_surface.set_buffer_scale`** end-to-end: per-surface integer buffer
  scale recorded on `SurfaceRecord`, propagated through `wl_surface.commit`,
  applied at the compositor's sample step.
- **`wl_surface.send_preferred_buffer_scale`** to bound clients on bind +
  on focus / output-scale changes: tells the client what scale to render at.
- **`wp_fractional_scale_v1`** (staging): advertise the global, mint per-
  surface `wp_fractional_scale_v1` objects, send `preferred_scale` per
  surface, accept it as the canonical preferred scale when present
  (supersedes the integer `preferred_buffer_scale`).
- **`wp_viewporter`** (stable): advertise the global, implement
  `wp_viewport.set_source` (src crop on the buffer in fractional buffer
  coords) and `set_destination` (the logical surface size). Without
  viewporter, fractional scale is unusable.
- **`wl_surface.set_buffer_transform`** end-to-end (small): record per-
  surface, apply at sample step. Currently a no-op too. Belongs here
  because transform + scale + buffer dims interact in the same shader path.
- **Cursor scaling.** Pass `output_scale` to the XCursor resolver (the arg
  exists today, always 1). Recompose the cursor texture on scale change.
  Per `cursor-design.md`: "HiDPI cursor not scaled: resolver takes scale
  arg, hardcoded 1 today" — this is the resolution.
- **Pointer coordinate mapping.** `WaylandInputBackend` and
  `LibinputBackend` divide by `output_scale` so the accumulated cursor
  position is logical. Per-surface coordinates are derived from logical-
  surface space, not buffer pixels.
- **Layout / WM scale-awareness.** Layout-default already works in logical
  output coords (correct). What's needed: handling configure acks where
  the buffer dimensions don't equal the configured logical size × scale
  exactly (transient-mismatch states during resize). The WM accepts a
  buffer at any size as long as the surface-space size matches the last
  ack'd configure.
- **`xdg-output`'s logical position/size already comes from `state.outputs`**
  (slice 3 wired this). Multi-scale outputs work for free once outputs
  carry distinct scales.
- **Tests.** Each piece gets a pure-unit test where possible; HiDPI is a
  cross-cutting feature so an end-to-end GPU integration test on a
  synthetic scale-2 output is required — pixel readback of a known-color
  buffer should land at the right output-physical rect.

Out of scope (deferred, called out explicitly):

- **Per-output scale variation in multi-output configs.** Slice 3 wires
  one output. Multi-output (still phase-2 deferred per `drm-design.md`) is
  prerequisite to clients spanning two outputs of different scales. The
  per-surface preferred scale derivation (max of overlapping outputs'
  scales, per Wayland convention) lives here when multi-output lands; the
  primitives this design adds are ready for it.
- **Scale changes WHILE a client is rendering** (output reconfiguration
  mid-frame). The protocol handles this: send `preferred_buffer_scale`,
  send `wl_surface.enter` / `leave` if needed, let the client redraw at
  the new scale. We don't add special transition state; the existing
  resize path through the descriptor channel re-emits `wl_output`, and
  clients react.
- **Quality knobs** (mipmap generation for downscaled buffers, ansiotropic
  sampler for the compositor pass). v1 uses linear filtering through the
  existing sampler. If sampling quality is poor on real workloads, add a
  follow-on.
- **DPI-aware physical-size mapping.** xdg-output / wl_output carry
  physical millimeters but clients rarely use them; the compositor doesn't
  derive scale from physical-size + resolution (we receive scale, we don't
  compute it). KMS-side will use EDID physical dims to populate the
  descriptor field, but the SCALE itself is policy (default: integer
  ceiling of native_dpi / 96, clamp 1–3; configurable later).
- **HiDPI for plugin overlays / decoration surfaces.** Plugins declare
  sizes in logical pixels; the overlay broker allocates buffers at
  output-physical density. Most of this just falls out of the cursor /
  client-buffer path; flag separately if a plugin's render hits a buggy
  edge.
- **`wp_fractional_scale_v1` v2 features.** v1 advertises the preferred
  fractional scale as a 120ths integer (`preferred_scale` event). The
  protocol is staging; treat it as the only version. No backports.

## Sub-scope ordering

The pieces above don't all land at once. The recommended sequence inside
this design (each sub-slice independently committable):

### Sub-slice A — Output scale through the render pipeline

The smallest end-to-end change. Treats `output_scale` as a 1-or-2 integer
delivered via the descriptor channel; the GPU process allocates a swapchain
at `logical_size × scale`; the JsCompositor's render passes target the
physical-pixel rect.

- `OutputDescriptor` already carries `scale`. Currently the core stores it
  but only emits it on `wl_output.send_scale`; the compositor ignores it.
- Compositor change: `this.width` / `this.height` become `logicalWidth` /
  `logicalHeight`; new `physicalWidth = logicalWidth * scale` /
  `physicalHeight = logicalHeight * scale`. Render passes use physical;
  layout uses logical; sample stage maps surface-space rects → physical-px
  rects via the scale factor.
- GPU process change: `wgpu::Surface::Configure` width/height = physical
  dims (current code uses what the core supplies via `SurfaceReady`, which
  today is the host's nested-window size in logical pixels and works on
  scale-1 hosts). On a scale-2 host, this needs to be physical.
- Cursor compositing rect scales with physical, but the cursor texture is
  still rendered at logical scale-1 dims — sub-slice B addresses cursor
  size.

This single sub-slice resolves the latent "everything is half-size on
HiDPI" bug for clients that already render at scale > 1 (most modern apps).
Clients that DO NOT render at scale > 1 will still look tiny — that's
sub-slice B/C territory.

Estimated ~250 lines + GPU integration test.

### Sub-slice B — Cursor scaling

`cursor-design.md` already calls this out as a known gap. The XCursor
resolver accepts a scale arg today, always passed as 1.

- Plumb `outputScale` (from `state.outputs.get(OUTPUT_DEFAULT).scale`) into
  the cursor resolver call site in `main.ts` and into any plugin SDK
  cursor path (`sdk.cursor.setShape`).
- On output-scale change (`pluginBus.subscribe("output.changed")`),
  re-resolve the active cursor texture at the new scale and reinstall it
  via `compositor.setCursorPixels`.
- XCursor themes ship size-tagged variants (16, 24, 32, 48, 64). The
  resolver picks the closest. Passing scale 2 with a size-24 base
  requests size 48; if the theme has it, we get a crisp cursor.

Estimated ~80 lines + a GPU readback test (cursor pixel grid at scale 2).

### Sub-slice C — `set_buffer_scale` end-to-end

The per-surface integer buffer scale. Clients that already use it (foot,
GTK4) start working correctly.

- `SurfaceRecord` gains `bufferScale: number` (default 1) and
  `pendingBufferScale: number`. `wl_surface.set_buffer_scale` writes
  pending; `commit` promotes it. Double-buffered per spec.
- The compositor's sample step uses `bufferScale` to derive surface-space
  size from buffer pixel dims: `surfaceSize = bufferSize / bufferScale`.
  Today these are equal; with scale 2 they differ.
- `wl_surface.send_preferred_buffer_scale` is called on bind / on focus
  /on output-scale change, with `state.outputs.get(OUTPUT_DEFAULT).scale`.
  The client uses this to pick its render scale.
- Layout / WM: configure carries logical sizes (correct today); the
  client may produce a buffer at logical-size × bufferScale (correct
  per spec). The WM accepts.

Estimated ~150 lines + pure-unit tests for the pending/commit pair +
GPU readback for sample correctness.

### Sub-slice D — `wp_viewporter`

Pre-condition for fractional scale. Standalone-useful: clients can
declare a non-buffer-pixel-aligned source crop or destination size.

- Protocol generator: feed in `viewporter.xml`. Two new interfaces
  (`wp_viewporter` global, `wp_viewport` per-surface).
- Handler: `wp_viewporter.get_viewport(surface)` mints a `wp_viewport`,
  scoped to the surface; `set_source(x, y, w, h)` records the source crop
  (24.8 fixed-point in buffer-space); `set_destination(w, h)` sets the
  surface-space size; `destroy` clears them.
- `SurfaceRecord` gains `viewportSrc?: { x, y, w, h }` and
  `viewportDst?: { w, h }`. Double-buffered through `pending` like
  every other surface state.
- Compositor sample: if `viewportDst` present, surface size = `viewportDst`;
  else if `bufferScale` present, surface size = `buffer / bufferScale`;
  else surface size = buffer size. If `viewportSrc` present, the sample
  reads from the subrect; else from the whole buffer.

Estimated ~250 lines + pure-unit tests for the cascade + GPU readback.

### Sub-slice E — `wp_fractional_scale_v1`

The preferred scale for modern clients (GTK4 ≥ 4.10, KDE/Qt6).

- Protocol generator: feed in `fractional-scale-v1.xml`.
- Handler:
  `wp_fractional_scale_manager_v1.get_fractional_scale(surface)` mints
  a per-surface object; the compositor sends `preferred_scale` (120ths
  integer; e.g. 180 = 1.5×) on bind and on output-scale change.
- `OutputRecord` gains `preferredFractionalScale?: number` (120ths).
  Default = `scale × 120` (integer scale expressed as fractional). A
  future configuration knob lets the user override.
- The compositor's preferred-scale derivation when a surface overlaps
  multiple outputs: per Wayland convention, max of overlapping outputs'
  preferred scales. Single-output today, but the derivation lives at
  this seam ready for multi-output.

Estimated ~200 lines + pure-unit tests + GPU readback for a
fractional-rendered client.

### Sub-slice F — Pointer coordinate mapping

The bug I flagged in slice 3.

- `WaylandInputBackend` and `LibinputBackend`: the accumulated pointer
  position is logical; the source events are physical (libinput's
  motion deltas) or surface-local (forwarded host wl_pointer). The
  conversion happens at the backend boundary: incoming surface-local
  wl_fixed_t / motion deltas are converted to LOGICAL output space by
  dividing by the active output's scale.
- `addon.updateOutputSize(w, h)` already propagates the LOGICAL size to
  the backend (added in slice 3). A new addon method
  `updateOutputScale(scale)` propagates the scale separately so the
  backend can apply the divide.
- Routing layer (`wl_seat.handleInput`) consumes logical coords already;
  no change.

Estimated ~80 lines + GPU test (pointer-button hit-test on a scale-2
output should land at the same logical pos as scale 1).

### Sub-slice G — `set_buffer_transform`

Small. Belongs in this design because transform + scale are entangled
in the sampler matrix.

- `SurfaceRecord.bufferTransform` (default 0 = normal); double-buffered.
- Sample stage applies the transform matrix to the texture coords
  alongside the scale. The transform values match `wl_output.transform`
  (0=normal, 1=90, 2=180, 3=270, 4..7 = flipped). Currently a no-op.

Estimated ~50 lines + pure-unit test for the sampler matrix.

### Sub-slice H — Documentation + integration

- `status.md` "Read first" silent-gap list gets `wl_surface.set_buffer_scale`
  / `set_buffer_transform` no-op entries removed; `wp_fractional_scale_v1`
  / `wp_viewporter` move from "advertised-absent" to advertised + working.
- `cursor-design.md`'s "HiDPI cursor not scaled" entry is removed.
- A new "HiDPI" subsection in status.md describes the four coordinate
  spaces and where conversion happens (this design's headline diagram).

## Configuration

A new config field — for the user to pin scale or let it follow EDID.

```typescript
interface OverdrawConfig {
  // ...
  output?: {
    // EXPLICIT scale, integer or fractional. Wins over auto-detection.
    scale?: number;
    // ... existing fields
  };
}
```

Without an explicit scale, the compositor derives from EDID physical
dims + native resolution: `pixels_per_inch = native / (mm_diagonal /
25.4)`. Threshold: < 130 → 1; 130–200 → 2; > 200 → also 2 for now
(no 3× until a real consumer wants it). For fractional, the user opts
in via config (`scale: 1.5`); auto-detection produces integer only.

## Open points (resolve before sub-slice A)

1. **Where does `outputScale` come from for the GPU process's swapchain
   Configure?** In nested mode, slice 3's resize handler in `main.cpp`
   currently uses the cached `surfaceFormat`/`surfacePresentMode` and
   the dimensions from the host backend's `size()`. Those dimensions are
   logical pixels (the host window's logical size, which the host
   compositor reports as such). For the swapchain to be at output-
   physical dims, the GPU process needs to multiply by scale. The host
   wl_output's scale is on `HostWindow` already (`hostOutputScale`).
   Confirm during sub-slice A.
2. **Buffer scale derivation when a client doesn't use the protocol.**
   A client that never calls `set_buffer_scale` has `bufferScale = 1`,
   meaning its buffer dims equal its surface dims, regardless of output
   scale. Such a client renders at 1× density and looks tiny on a
   scale-2 output. That's the spec'd behavior — we don't auto-upscale
   client buffers. Acceptable; flag in user-facing docs.
3. **Cursor texture re-resolve on scale change.** Sub-slice B
   re-resolves the active cursor; what about queued cursor commands
   from clients (`wl_pointer.set_cursor` with their own surface)? The
   client owns its cursor surface; if the cursor surface doesn't use
   `set_buffer_scale`, it'll look tiny. Same answer as #2 — client's
   responsibility. We DO send `preferred_buffer_scale` to cursor
   surfaces too.
4. **xdg-output `logical_size` under fractional scale.** The protocol
   says logical_size carries logical pixels. For an output at scale
   1.5 over 2400×1600 physical: logical_size = 1600×1067 (integer
   division). Off-by-rounding ambiguity. Resolution: round down per
   the spec note ("the compositor's choice").
5. **Plugin overlays at non-integer scale.** A plugin requests a
   "100×50 logical" overlay. At scale 1.5, the broker allocates a
   150×75 physical buffer. The plugin renders to it. Do plugins know
   they're rendering at fractional density? The cleanest answer: yes,
   the overlay broker exposes `physicalWidth` / `physicalHeight` on
   the surface alongside `logicalWidth` / `logicalHeight`. Plugins
   that care (text rendering) use the physical dims; plugins that
   don't can ignore them and the texture sampler does linear filtering.

## Total estimate

| Sub-slice | Lines | GPU |
|---|---|---|
| A. Output scale through pipeline | 250 | yes |
| B. Cursor scaling | 80 | yes |
| C. `set_buffer_scale` | 150 | yes |
| D. `wp_viewporter` | 250 | yes |
| E. `wp_fractional_scale_v1` | 200 | yes |
| F. Pointer coordinate mapping | 80 | yes |
| G. `set_buffer_transform` | 50 | minimal |
| H. Docs cleanup | — | no |
| **Total** | **~1060** | |

Plus ~200 lines of tests across the sub-slices. So ~1250 lines all in,
comparable to phase 5b. Roughly 4–6 sessions of work at the rate of
phase-2 slices so far.

## Verification target

HiDPI sub-slice E done = on the dev/test box (16" 2560×1600, 189 dpi):

- `foot` renders at native density with native font sizes (legible).
- The cursor is crisp at scale 2.
- The pointer hit-tests correctly across a logical-pixel grid.
- A GTK4 client correctly receives a fractional preferred_scale and
  renders at 1.5× or 2× as configured.

The bar for declaring HiDPI work closed and rolling status.md updates.
