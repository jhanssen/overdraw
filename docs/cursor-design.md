# overdraw — cursor + Phase 9b/9c design

Phase 9b (kinematic pointer state) and Phase 9c (software cursor + Wayland
client cursor protocols + plugin cursor SDK) — concrete shape before code.
Read `status.md` "Read first" silent-gap list first: today
`wl_pointer.set_cursor` is a silent no-op, there is no software cursor
compositing, and `wp_cursor_shape_v1` is not advertised. This phase fixes
all three together because they share the XCursor theme resolver as the
load-bearing primitive.

## Scope

In scope:

- Software cursor compositing (the prerequisite — no cursor of any kind is
  drawn today).
- XCursor theme resolver (theme discovery, file parsing, shape→texture+hotspot).
- `wl_pointer.set_cursor` end-to-end (client-supplied surface, serial
  validation, focus lifecycle).
- `wp_cursor_shape_v1` end-to-end (advertise + handle `set_shape` against
  the same resolver).
- Core kinematic state machine (windowed velocity samples, shake detector,
  idle timer), lazy-enabled by rule presence.
- `sdk.cursor` plugin SDK: `setShape` / `setImage` / `hide` / `show` /
  `setDefault`, plus the declarative rule system
  (`defineRule({when, shape | texture, enlarge?})`).
- Cursor priority resolution: plugin override > client cursor > rule match
  > compositor default.

Out of scope (deferred, each flagged below):

- Animated XCursor frames (`wait` spinner): static frame 0 in v1. **Silent
  gap to add to `status.md`.**
- Hardware cursor plane (KMS): software-only. Phase-2 (KMS present) concern.
- Continuous cursor transforms (tilt / rotate / stretch in
  hypr-dynamic-cursors style): future phase. Composes on top of the v1
  rule output; the rule output is the input texture, the transform mode
  modifies it per-frame.
- Per-surface cursor SDK (`sdk.cursor.setShapeFor(surfaceId, …)`): deferred
  per the open-questions discussion. A plugin can approximate it by
  subscribing to pointer hit changes and switching `setShape` calls.
- Cursor size scaling for HiDPI outputs: hardcoded scale 1 today. The
  resolver takes a scale arg from day one (no retrofit needed when
  `wl_output` reconfiguration lands).
- Cursor surface input-region intersection: cursor surfaces don't receive
  input (they have no role-equivalent for that). N/A.
- Pointer constraints / locked cursor (`zwp_pointer_constraints_v1`):
  separate protocol, not in this phase.
- 9b "full pointer.* bus events" (high-frequency pointer.motion fan-out
  to plugins): the rule system + the kinematic state machine give plugins
  declarative access without per-event dispatch. If a real consumer needs
  per-event delivery later, add it then.

## Priority resolution

Every frame, the cursor slot has exactly one of four states, evaluated
in priority order:

1. **Plugin override** (highest). A plugin has called `sdk.cursor.setShape`
   / `setImage` / `hide` and has not cleared it. Includes the case where a
   rule from `defineRule` matched and core resolved it to a texture.
2. **Client cursor**. The pointer is over a client surface, the client
   called `wl_pointer.set_cursor` or `wp_cursor_shape_v1.set_shape` with a
   valid serial, and the surface has content. `surface = NULL` from
   set_cursor → "hidden" (renders nothing while over this client).
3. **`sdk.cursor.setDefault`**. A plugin has set a default. Used when no
   override is active and the pointer is not over a client cursor-owning
   surface (compositor backgrounds, gaps between windows, etc.).
4. **Built-in default**. The XCursor theme's `default` (a.k.a. `left_ptr`)
   shape. Last-resort fallback if no plugin set one.

Per the agreed Q2=(a) answer: a plugin override beats the client's
`set_cursor`. The rationale: lets a plugin force a "I am dragging across
windows" cursor that survives crossing surfaces. The cost: a buggy plugin
can silently override a client's chosen cursor everywhere. Accepted.

A plugin that wants to defer to the client should not set the override
at all — set the default via `setDefault`, which the client cursor (when
present) overrides.

## XCursor theme resolver

Single shared primitive used by:

- `wl_pointer.set_cursor` — no, this is client-supplied surface. NOT used.
- `wp_cursor_shape_v1.set_shape` — converts a shape enum value to a
  texture+hotspot in the active theme.
- `sdk.cursor.setShape(name)` — same path.
- Built-in default cursor on boot.
- Future: shape rules in `sdk.cursor.defineRule({shape: name, …})`.

### Theme discovery

XDG-conventional, no config knob in v1 (Q5=defer):

1. `XCURSOR_THEME` env var → primary theme name. Default `"default"`.
2. `XCURSOR_SIZE` env var → preferred size in px (a hint; resolver picks
   the nearest available). Default 24.
3. Search path: `$XCURSOR_PATH` if set, else
   `$XDG_DATA_HOME/icons:$XDG_DATA_DIRS/icons:/usr/share/icons:/usr/share/pixmaps`.
4. For each path: look for `<path>/<theme>/cursors/<shape>`.
5. **Inheritance**: each theme's `index.theme` may declare
   `Inherits=other-theme` in `[Icon Theme]`. If the shape is not in the
   primary theme, walk the inheritance chain. Cycle-detection: cap depth
   at 16, log on cycle, fall through to next.
6. Last-resort fallback: a built-in hardcoded 16×16 arrow texture
   compiled into core. Used when no theme has the shape, or no theme
   loaded at all (env unset + no `default` theme on disk). Ensures every
   shape resolves to *something*. Keeps tests independent of the host's
   theme.

### File parsing

XCursor files are documented in `man Xcursor`. Binary format, file magic
`Xcur`, table of contents indexes a list of images. Each image is a
fixed-format header + RGBA8 pixels. Critical fields:

- `width`, `height` (in px).
- `xhot`, `yhot` (hotspot, in px, surface-local).
- `delay` (ms; for animated cursors).
- `subimage` (frame index within an animation).

Multiple sizes per file (the theme ships several resolutions). Resolver
picks the size ≥ requested `size_px` (or the largest available if all are
smaller). Files with subimages: in v1, **always pick frame 0** (subimage
index = 0). Punt animation per Q1.

### Resolver API

```ts
interface CursorThemeResolver {
  // Returns null on miss after full inheritance walk + built-in fallback.
  // (Built-in fallback resolves for 'default' only; other shapes can miss.)
  resolveShape(name: string, sizePx: number, scale: number): {
    width: number;
    height: number;
    hotspotX: number;
    hotspotY: number;
    rgba: Uint8Array;          // tightly packed, width*height*4
  } | null;

  // Invalidates the cache. Call on theme change (config reload).
  reload(): void;
}
```

Implementation: native side (C++ in the GPU process? or main process?).
**Decision: main process, JS-callable through the native addon.** Reasons:
the resolver does filesystem walks (slow paths cached), and the GPU
process is a tight render loop. Texture upload to the GPU device is one
`queue.writeTexture` from JS, same path the shm client buffer path uses.

The native addon exposes `addon.resolveCursorShape(name, sizePx, scale)`
returning the struct above as a typed `Buffer` view + dimensions. The JS
`CursorThemeResolver` wraps it and adds an LRU cache keyed on
`(name, sizePx, scale)`.

## Software cursor compositing primitive

A new compositor slot above `overlay` in `LAYER_ORDER`. Single slot
(only one cursor on screen at a time). The compositor's `drawOrder()`
appends the cursor slot last, after phantoms (Phase 9a) and `overlay`.

State on the compositor:

```ts
interface CursorState {
  visible: boolean;              // hide() / show()
  positionX: number;             // pointer position, updated per-frame from seat
  positionY: number;
  textureId: number | null;      // null = nothing to draw
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
}
```

Drawn at `(positionX - hotspotX, positionY - hotspotY)`, dimensions
`width × height`. Same per-surface render pass as everything else (one
sample, premultiplied blend). No transform / opacity / mask
modulation in v1 — the cursor is opaque.

`setCursorTexture(textureId | null, width, height, hotspotX, hotspotY)`
on the compositor sink; the compositor refcounts the texture. The
compositor never creates the texture; it is supplied by either the
client (`wl_pointer.set_cursor` → existing client-buffer import path) or
the resolver (uploaded via `queue.writeTexture` once and cached on the
core device).

`setCursorPosition(x, y)` per pointer motion event. Cheap (uniform
write only).

`setCursorVisible(bool)`.

**Compositor sink interface gains three methods.** GPU-free tests can
omit them; `CompositorSink` makes them optional.

### Cursor position vs. pointer position

The seat already tracks pointer position (`SeatState.pointerPosition()`,
added in Phase 7b). The cursor slot reads from the same source. On every
input motion event the seat updates pointerPosition AND
`compositor.setCursorPosition`. No separate path.

When the host pointer leaves the overdraw window (host wayland seat sends
leave to the GPU process), the cursor hides via `setCursorVisible(false)`.
On re-enter, restored to current state.

## Hardware cursor (KMS cursor plane)

On KMS, the software slot above is the *fallback*; the default path
scans the cursor out of each output's DRM cursor plane, so pointer
motion costs a plane-position update instead of a recomposite. Config
gate: `cursor.hardware` (default true).

Division of labor:

- **GPU process** (`kms_output.*`): picks a `DRM_PLANE_TYPE_CURSOR`
  plane per CRTC at connect (best-effort; exclusion-shared across
  outputs), allocates two cap-sized (`DRM_CAP_CURSOR_WIDTH/HEIGHT`)
  linear ARGB8888 dumb-buffer FBs per output (ping-ponged per image
  change so the latched FB is never written), and folds the desired
  cursor state into **every** frame commit. When the core flags a
  state update `commitNow` (no render coming), it issues a cursor-only
  atomic commit (`PAGE_FLIP_EVENT | NONBLOCK`), serialized against
  frame flips: while any flip is in flight the state just sits dirty
  (picked up by the next commit or that flip's completion event), and
  a present arriving while a cursor-only flip is pending is stashed
  and issued from that flip's event. Cursor-only flip events never
  feed the frame clock. On a commit TEST rejection attributable to the
  cursor plane, the frame retries without it and the output demotes to
  software (`CursorPlaneStatus` ok=0).
- **Core** (`compositor.ts`): receives per-output plane availability
  (`CursorPlaneStatus`), ships the image on every install
  (`CursorImage` with inline BGRA bytes for theme/CPU cursors;
  `CursorImageShm` referencing the already-GPU-mapped wl_shm pool for
  client cursor surfaces — the GPU process copies out on receipt, and
  wire FIFO orders the copy before any buffer release), and on cursor
  movement marks state stale instead of damaging hw-cursor outputs
  (the damage-map `exclude` set). `renderFrame` flushes plane
  positions once per pass after the render set is known: outputs about
  to present get `commitNow=false` (the present carries the state);
  clean outputs get `commitNow=true`. Positions are device pixels
  relative to the output with the hotspot pre-applied (aquamarine-
  style: no HOTSPOT props). Theme shapes install by resolver
  (`setCursorShape(resolve, logicalSizePx)`): each plane output gets
  its own resolve at `logicalSizePx * scale` device pixels and the
  software slot resolves at the highest output scale (the internal
  surface's bufferScale keeps the logical size constant), so theme
  cursors are native-sharp at every scale. Only fixed-bitmap installs
  (plugin `set-image` bytes) fall back to a GPU-process-side bilinear
  upscale when image scale != output scale.

Per-output fallback to the software slot whenever the plane can't
serve: no cursor plane on the CRTC, image larger than the cursor FB,
dmabuf or device-texture cursor images (no CPU/pool bytes to ship),
nested mode (no planes at all), or runtime demotion. Fallback flips
the output back into `drawOrder` and repaints the cursor rect; the
GPU process turns the plane off via the same commit machinery.

Takeover interaction: our cursor planes are excluded from the
foreign-plane disable sweep on the initial modeset, and the initial
commit programs (or disables) the plane explicitly, so a previous DRM
master's latched cursor image can never survive.

## `wl_pointer.set_cursor`

End-to-end: the existing pointer enter flow already mints serials
(`wl_seat.ts:117`). Extend `set_cursor`:

```
set_cursor(resource, serial, surface, hotspot_x, hotspot_y)
```

1. **Serial validation**: track the most-recent enter serial per pointer
   resource. Reject if `serial < lastEnterSerial[resource]` (stale —
   focus moved). Silent drop, log at debug level.
2. **Role lock**: the supplied `wl_surface` is locked to `"cursor"` role.
   Subsequent `get_toplevel` / `get_popup` / subsurface / layer-shell
   role-attach on the same surface throw a protocol error per the spec.
   The role-lock infrastructure already exists for `xdg_surface`; extend
   it.
3. **`surface = NULL`**: hide cursor while pointer is over this client's
   focused surface. Track per-client "client-requested hide" state.
4. **First-content + buffer-commit hook**: the cursor surface receives
   `wl_buffer.attach` + `commit` like any other surface. On commit, the
   existing client-buffer path uploads (shm) / imports (dmabuf) — no new
   GPU code needed. The cursor surface's resulting GPU texture is fed
   into the compositor cursor slot via `setCursorTexture(textureId, w, h,
   hotspotX, hotspotY)`.
5. **Pointer leave**: cursor slot reverts to the next-priority layer
   (plugin override → setDefault → built-in default).
6. **Hotspot**: from `set_cursor` args, NOT from the surface contents.

A cursor surface is not in the WM window stack, not in the layer stacks,
and not focusable. It is sampled by the cursor slot only. Lifecycle
mirrors any other client surface (`unmap` on destroy, surface-release
through the existing path).

**Subsurfaces on cursor surfaces**: the spec permits them. v1 punt: log
a warning, ignore subsurfaces. Status.md gap entry. Real clients rarely
do this.

## `wp_cursor_shape_v1`

Generate the protocol XML through the existing generator
(`tools/gen-protocol/`). Two interfaces:

- `wp_cursor_shape_manager_v1`: global. `get_pointer(pointer)` returns a
  `wp_cursor_shape_device_v1` bound to that `wl_pointer`. `destroy()`.
- `wp_cursor_shape_device_v1`: per-pointer. `set_shape(serial, shape)`
  where `shape` is an enum (36 values; `default`, `pointer`, `text`,
  `move`, `wait`, `*-resize`, etc.).

Handler:

1. Serial validation (same as `set_cursor`).
2. Resolve `shape` enum → string name (`SHAPE_NAMES[shape]`).
3. `resolver.resolveShape(name, XCURSOR_SIZE, 1)` → texture+hotspot.
4. Upload texture to core device (one-time, cached on the resolver's LRU).
5. Feed compositor cursor slot via `setCursorTexture(...)`.

Advertised at compositor bind time, alongside `wl_seat`.

**Interaction with `set_cursor` from the same client**: most-recent wins.
The two protocols share the same priority-2 slot ("client cursor"). The
client just picks one mechanism and uses it consistently in practice.

## Kinematic state machine (Phase 9b core)

Replaces the original "smoothed velocity in pointer events" sketch. Core
maintains a kinematic state computed from the same pointer position
stream that drives the cursor slot.

**Lazy enablement**: the state machine has overhead (ring buffer
allocations, per-event sample updates). It runs only when at least one
consumer is registered:

- A rule with a kinematic predicate (`speedRange`, `shake`, `idle`).
- A future SDK call (`sdk.cursor.kinematics()` poll — deferred).

If no consumer is registered, the machine is dormant.

### State

```ts
interface CursorKinematics {
  speedPxPerSec: number;          // |velocity|, smoothed via ring buffer
  velocityX: number;              // signed components
  velocityY: number;
  shake: boolean;                 // shake-to-find detector output
  shakeIntensity: number;         // trail / diagonal, 0 if not shaking
  idleMs: number;                 // milliseconds since last motion
}
```

### Sample window

Ring buffer of pointer positions, sized to `60 * window_ms / 1000`
samples (hardcoded 60Hz; status.md "Read first" already flags the
fabricated frame clock as a gap, so this is consistent with the rest of
the system). When the display-driven frame clock lands, the sample-count
math becomes correct without code change.

Window size is per-consumer-rule (each rule that uses `speedRange` can
specify its own `windowMs`, default 100ms). Core picks the **maximum**
window across active rules and uses one ring; rules with smaller windows
read a suffix.

### Shake detector

Direct port of the hypr-dynamic-cursors algorithm (lines 36-89 of
`Shake.cpp`):

1. Per pointer motion event: store position in ring, compute distance from
   previous sample, store in `samples_distance` ring.
2. `trail` = sum of distances in the ring.
3. `diagonal` = diagonal of the bounding box of samples in the ring.
4. `amount = (trail / diagonal) - threshold`.
5. `shake = (diagonal > 100 && amount > 0)`.

Threshold default 6.0 (hypr default). Ring is sized for 1s of history
(60 samples at 60Hz).

`shakeIntensity` exposed for plugins that want to drive magnification
amounts off the live ratio.

### Idle detection

Trivial: `idleMs` = `now() - lastMotionTime`. Updated every frame from
`beforeRender(timeMs)` (same hook the animation evaluator uses).

### Per-event vs. per-frame

Per pointer motion event: ring sample push, shake detector update,
`idleMs = 0`. Per render frame: idle update only (`idleMs += dt`).
Rules are evaluated per frame, not per motion event — at most one cursor
texture change per frame.

## Plugin SDK: `sdk.cursor`

```ts
interface PluginCursor {
  // Plugin override (priority 1).
  setShape(name: string): Promise<void>;
  setImage(texture: GPUTexture, hotspotX: number, hotspotY: number): Promise<void>;
  hide(): Promise<void>;
  show(): Promise<void>;
  clearOverride(): Promise<void>;          // explicit clear

  // Compositor default (priority 3).
  setDefault(shape: string | null): Promise<void>;
  // null clears (back to built-in 'default' at priority 4).

  // Declarative shape rules. Evaluated in registration order; first
  // match wins. Disabled by clearing the returned unregister.
  defineRule(spec: CursorRuleSpec): Promise<{ unregister(): Promise<void> }>;
}

interface CursorRuleSpec {
  // Predicate. Multiple conditions are AND'd. At least one required.
  when: {
    speedRange?: [number, number];         // px/s, inclusive
    speedWindowMs?: number;                // default 100
    idle?: { afterMs: number };            // matches when idleMs >= afterMs
    shake?: boolean;                       // matches when shake state == this
    // Reserved for future: direction, accelRange, overSurface.
  };
  // Outcome. Exactly one of shape | texture.
  shape?: string;                          // resolved via theme
  texture?: { texture: GPUTexture; hotspotX: number; hotspotY: number };
  enlarge?: number;                        // scale factor, default 1.0
}
```

### Rule semantics

- Rules registered earlier match first. To displace, unregister and
  re-register.
- Rules with `shake: true` enable the shake detector.
- Rules with `speedRange` enable velocity tracking, contribute to the
  maximum-window calculation.
- Rules with `idle: { afterMs }` enable idle tracking.
- Rule evaluation runs per frame (`beforeRender`). When the matching
  rule changes, core updates the cursor slot once. No churn from
  per-event re-evaluation.
- A rule's outcome enters priority 1 (the plugin-override slot) like a
  direct `setShape` call. If a rule matches AND the plugin has called
  `setShape` directly, **the direct call wins** (rules are "automatic
  overrides"; explicit overrides beat them).

### `enlarge`

Multiplies the cursor texture's render size (not the source texture's
sample size). Used for shake-to-find: rule `when: {shake: true}` with
`enlarge: 4.0` shows the same shape at 4× scale.

For animated enlarge (smooth zoom-in on shake start, zoom-out on shake
end), the plugin uses `sdk.animations.run` on its own state and passes
the current `enlarge` value into a rule that re-registers each frame —
or, more practically, **`enlarge` is read live from a JS value the
plugin updates**. Spec TBD; the v1 above ships the static field.
Improvement: a future `enlarge: () => number` that core polls per frame
(crosses postMessage for Worker plugins — main-thread/in-thread only
in v1).

## Transport: in-thread vs. Worker plugins

`sdk.cursor.setShape` / `hide` / `show` / `setDefault` / `defineRule` /
`clearOverride` are simple request/reply over the existing broker
infrastructure. Both transports work identically.

`setImage(texture, …)` requires the texture be on the core device:

- In-thread bundled plugins share core's device — pass the `GPUTexture`
  directly.
- Worker plugins render on their own device. v1: **`setImage` is in-thread
  only**, Worker plugins get a loud "not yet implemented" throw (matches
  the `compose.windows` Worker situation). The cross-device dmabuf
  primitive exists (Phase 5b, plugin-overlay path), but wiring a
  plugin-supplied cursor texture across the device boundary into the
  cursor slot is a chunk of work on its own. Defer until a use case
  forces it. Status.md gap entry.

Rule outcomes via `texture` similarly: in-thread only in v1.

`shape: string` rules work for both transports (resolver runs in core).

## Action surface

A few actions for IPC / hotkey access:

- `cursor.set-shape {shape}` → `sdk.cursor.setShape`. Useful for binding
  e.g. `Mod+x` to toggle a custom-mode cursor.
- `cursor.set-default {shape | null}`.
- `cursor.hide` / `cursor.show`.
- `cursor.clear-override`.

Registered by a small bundled `@overdraw/plugin-cursor-actions` plugin
(in-thread). Following the Phase 7a pattern of `plugin-core-actions`.

The rule system is plugin-only (no CLI form); declarative-shape configs
through `config.actions` work fine.

## Configuration

No `OverdrawConfig.cursor` schema in v1 (Q5=defer). Theme + size come
from env. If a config knob is wanted later, the schema is straightforward
(`{ theme?: string; size?: number }`).

## File layout

```
packages/cursor-types/                                    (new)
  src/index.ts                                            CursorRuleSpec, etc.

packages/plugin-cursor-actions/                           (new)
  src/index.ts                                            bundled actions plugin

packages/core/src/cursor/                                 (new)
  theme-resolver.ts                                       XCursor theme walk + LRU
  kinematics.ts                                           velocity ring + shake + idle
  rule-engine.ts                                          rule storage + per-frame eval

packages/core/src/plugins/cursor-sdk.ts                   (new)
packages/core/src/plugins/cursor-broker.ts                (new)

packages/core/src/protocols/wl_seat.ts                    set_cursor handler
packages/core/src/protocols/cursor-shape.ts               (new) wp_cursor_shape_v1
packages/core/src/protocols/index.ts                      wire it in

packages/core/src/gpu/compositor.ts                       cursor slot, setCursorTexture/
                                                          Position/Visible, drawOrder
                                                          appends cursor last

packages/core/src/protocols/ctx.ts                        CompositorSink cursor methods
packages/core/src/main.ts                                 resolver + kinematics + rule
                                                          engine + broker bringup

packages/core/native/cursor/                              (new — or inline in addon)
  xcursor.cpp                                             file parser
  theme.cpp                                               theme walk

packages/core/native/napi/addon.cpp                       resolveCursorShape binding
```

Estimated ~800 lines total:
- Theme resolver: ~200 (parser + theme walk + cache)
- Compositor cursor slot: ~80
- Kinematics + rule engine: ~150
- `wl_pointer.set_cursor`: ~70
- `wp_cursor_shape_v1`: ~80
- Cursor SDK + broker: ~120
- Bundled cursor-actions plugin: ~40
- Wiring + types: ~60

## Test plan

- **Pure-unit** (`test/cursor-theme.test.js`): XCursor file parsing from
  a fixture file (we ship a tiny test theme under `test/fixtures/theme/`,
  3 shapes, 2 sizes each); inheritance walk with mock filesystem;
  built-in fallback when nothing found; LRU eviction.
- **Pure-unit** (`test/cursor-kinematics.test.js`): velocity ring math
  (synthetic position sequence → expected speed); shake detector
  (synthetic shake-pattern → shake=true); idle timer; lazy enablement
  (no consumer → no ring allocated).
- **Pure-unit** (`test/cursor-rule-engine.test.js`): rule registration
  order = match precedence; predicate AND-ing; explicit `setShape`
  beats rule; window-max calculation across multiple rules.
- **Pure-unit** (`test/cursor-broker.test.js`): broker routes + payload
  validation; capability-by-shape for Worker `setImage` (rejects with a
  clear error).
- **GPU** (`test/cursor.gpu.mjs`):
  - cursor compositing — `setShape('default')` produces visible cursor
    pixels at pointer position; readback shows non-clear-color at the
    pointer.
  - `wl_pointer.set_cursor` — real client (a fixture wayland client
    that calls `set_cursor` with an shm cursor surface); after pointer
    enters the client window, readback shows the client's cursor pixels.
  - `wl_pointer.set_cursor` with NULL surface — readback shows nothing
    (cleared) at pointer position over the client window.
  - `wp_cursor_shape_v1` — real client calling `set_shape(pointer)`;
    readback matches `setShape('pointer')` from the SDK side.
  - Plugin override beats client — client sets a cursor; bundled fixture
    plugin calls `sdk.cursor.setShape('crosshair')`; cursor is the
    crosshair, not the client's.
  - Rule: `speedRange: [500, Infinity]` → custom shape. Inject motion at
    >500px/s via `addon.injectHostInput`; verify the rule-shape pixels
    are drawn.
  - Rule: `shake: true` → enlarge. Inject a shake pattern; verify the
    cursor texture is rendered at the enlarged size.
- **Conformance**: real-world client smoke. Run `foot` or `kitty`,
  verify their cursors actually appear when hovering them. Manual
  verification per the project's pattern (compositing.gpu.mjs
  uses fixture clients, not real ones; running real clients is a
  developer-side check).

## Caveats / known limitations (to add to status.md)

- **`wait` cursor static**: animated XCursor frames not supported; v1
  picks subimage 0. Real themes' `wait` / `progress` / `left_ptr_watch`
  display as a single static frame.
- **HiDPI cursor not scaled**: resolver takes a scale arg but cursor
  size is hardcoded to `XCURSOR_SIZE`. Awaits `wl_output` reconfiguration.
- **Subsurfaces on cursor surfaces ignored**: protocol-spec-permitted but
  not supported; warning logged.
- **Worker `setImage` not supported**: plugin must be in-thread to provide
  a custom texture cursor. Loud "not yet implemented" throw.
- **Cross-pointer scope of plugin override**: a single seat today; if
  multi-seat lands, the plugin override is per-cursor-slot, but the SDK
  surface assumes one slot. Reopen the design if/when multi-seat is real.

## Phase 9b API tuning

The kinematic state machine + rule engine is enough to support the
simple "shape-by-motion-regime" use case. As real plugins try to build
fancier behavior (continuous tilt/rotate/stretch, gesture detection,
flick-throw inertia), the API will need extension:

- `sdk.cursor.kinematics()` poll, exposing the raw values.
- Continuous transform mode (port hypr-dynamic-cursors' rotate/tilt/
  stretch as a separate plugin building on this primitive).
- More rule predicates: direction quadrant, acceleration range,
  per-output-region matching.
- Push events: a high-frequency motion bus event for plugins that
  genuinely need per-event delivery.

These are all extensions to the primitive shape established here, not
replacements. The doc above is v1; further phases tune.
