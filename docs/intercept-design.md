# overdraw — buffer intercept design (Phase 10a)

Per-pixel intercept. A plugin registers against a client; for each matched
content surface, the plugin's `render` callback writes a new texture every
visible frame, and core composites that texture in place of the client's
buffer. Use cases: blur, color grading via custom shaders, distortion,
CRT-style effects, any user-written WGSL window effect.

Effects that fit the per-surface uniform path (`setOpacity` / `setMask` /
`setTint` / `setColorMatrix` / `setTransform`) belong there, not here.
Intercept is for shader passes that need the client texture as **input**
(neighbor reads, multi-tap sampling, arbitrary user WGSL).

This document covers **Phase 10a**: the v1 cut that ships in-thread +
Worker plugins, one intercept per surface, no chains. See "Deferred to
10b" at the end.

## Scope

In:

- **Match registry** (per-client, app_id regex + role filter).
- **Per-surface lifecycle**: `setup` (once on first match), `onSurfaceMatched` /
  `onSurfaceUnmatched` (each matched surface), `destroy` (on unregister).
- **`render` callback** invoked every visible frame on matched surfaces.
  Receives `{input: {texture, rect}, output: {texture, rect}, ctx}` and
  returns `{outputRect?}`.
- **Output texture replacement**: the plugin's output texture is what the
  compositor samples for that surface; the client buffer is dropped from
  the per-frame compose for matched surfaces.
- **`outputRect` return for geometry control**: per-frame plugin-driven
  rect override (CRT-off, slide, scale animations driven by plugin
  state).
- **In-thread + Worker transports**, same SDK shape. In-thread shares
  core's `GPUDevice`. Worker uses the existing cross-device dmabuf
  machinery (Phase 5b inverse), with **A2** (copy ring) on the input
  leg.
- **Fall-back-to-raw** on render failure (logged); the client's buffer
  draws unmodified for that frame.

Deferred to 10b (Worker-supported but not in 10a):

- **Chain orchestration** + categorized ordering (`pixels` → `geometry` →
  `composition`).
- **Per-stage caching** (commit-since-last-render invalidation).
- **Hold-last-output** fallback on render failure (texture lifetime per
  surface; the v1 fall-back-to-raw is the conscious trade-off).
- **Padding propagation** across chain stages.
- **Failed-stage skip-with-fallback** within a chain.
- **A1 optimization** for Worker input: re-export the client's dmabuf
  directly to the plugin device instead of copying into a per-surface
  ring (steady-state win; introduces a per-client-buffer cross-device
  import lifecycle).

## SDK shape

```ts
interface InterceptAPI {
  register(spec: InterceptSpec): Promise<{ unregister(): Promise<void> }>;
}

interface InterceptSpec {
  name: string;
  match: {
    // RegExp serialized as { source, flags } for clone-safety.
    appId?: { source: string; flags: string };
    // Filter surfaces by role. Default: all content roles
    // (toplevel, popup, subsurface). Cursor and decoration surfaces
    // are NEVER eligible regardless of filter.
    roles?: ReadonlyArray<"toplevel" | "popup" | "subsurface">;
  };
  // Forward-compatibility field. Recorded but not used for ordering in
  // 10a (single intercept per surface; no chain). 10b will use this
  // to dispatch the chain in category order.
  contributes?: ReadonlyArray<"pixels" | "geometry" | "composition">;

  setup(device: GPUDevice): Promise<InterceptHandlers> | InterceptHandlers;
}

interface InterceptHandlers {
  onSurfaceMatched?(surface: SurfaceInfo): void;
  onSurfaceUnmatched?(surface: SurfaceInfo): void;

  // Called every visible frame for each matched surface. The plugin
  // encodes commands + submits before returning. The SDK signals
  // completion (in-thread: queue.onSubmittedWorkDone; Worker: producer
  // end-access fence) after render returns.
  render(args: {
    input: { texture: GPUTexture; rect: Rect };
    output: { texture: GPUTexture; rect: Rect };
    ctx: { surfaceId: number; frameNumber: number; time: number };
  }): { outputRect?: Rect } | void;

  destroy?(): void;
}

interface SurfaceInfo {
  surfaceId: number;
  role: "toplevel" | "popup" | "subsurface";
  appId?: string;
  title?: string;
}

interface Rect { x: number; y: number; w: number; h: number; }
```

**API stability across transports.** The signature is identical for
in-thread and Worker plugins. Only the texture lifetime guarantees
differ (transparent to the plugin):

- In-thread: `input.texture` is a long-lived core-device `GPUTexture`
  the SDK reuses across frames (recycled only when the client commits
  a buffer of different dimensions). `output.texture` is a 3-slot
  core-device ring rotated by the SDK.
- Worker: `input.texture` is the current slot of a 3-slot dmabuf ring
  on the plugin device, populated by core via a per-frame copy
  (A2 -- see "Input leg, Worker" below). `output.texture` is a 3-slot
  dmabuf ring on the plugin device that core imports as the consumer.

In both cases the plugin renders synchronously inside `render`, encodes
+ submits, and returns. The plugin must NOT retain the texture handles
past the function return; the SDK will recycle them.

## Match semantics

**10a: toplevels only.** Match runs against toplevels (the surface
role that drives `window.map` / `window.change`). Popups and
subsurfaces of a matched client draw RAW for 10a. Reason: the
window-event bus emits for toplevels but not popups/subsurfaces;
extending coverage to non-toplevels needs a `surfaceCreated` /
`surfaceDestroyed` event and a parent-walking match, deferred to 10b.

User-visible consequence: a blur intercept on a browser applies to
the main window but not to its menu popups or scrollbar subsurfaces.
For most demos (invert, blur, color grading, decoration shape) this
is the expected behavior. Honest limitation; if a real use case
needs subsurface coverage before 10b, raise the priority of 10b's
parent-walking match.

The match check runs:

- On `window.map` (toplevel acquires content): evaluate against
  every registered intercept; the first match (by registration
  order) wins, fires `onSurfaceMatched`.
- On `window.change` with `"appId"` in the changed list: re-evaluate.
  If a previously-matched window stops matching, fire
  `onSurfaceUnmatched`; if a previously-unmatched window starts
  matching, fire `onSurfaceMatched`.
- On `window.unmap`: fire `onSurfaceUnmatched` for any matched window.
- On intercept register: enumerate every currently-mapped toplevel and
  evaluate.
- On intercept unregister: fire `onSurfaceUnmatched` for every matched
  window of this registration.

If multiple intercept registrations match the same client, **v1 uses
the first-registered match** (deterministic; stable across plugin
restarts). 10b's chain will replace this with a chain of all matching
registrations in category order.

Cursor surfaces are excluded unconditionally (`role === "cursor"`).
Decoration surfaces (Phase 9 decoration provider) are excluded too.
These exclusions are not user-configurable in 10a or 10b -- those
surfaces aren't client content.

`role` filter in the spec is accepted but only `"toplevel"` does
anything in 10a (the other values are recorded for forward
compatibility). 10b extends the match to honor popup/subsurface
membership.

## Lifecycle

1. **register**. Plugin calls `sdk.intercept.register(spec)`. The broker
   stores the registration, runs `setup(device)` once, gets back
   `InterceptHandlers`. The broker scans every existing matched surface
   and fires `onSurfaceMatched` for each.

2. **onSurfaceMatched**. Surface becomes intercepted. The SDK allocates
   the per-surface texture rings (input + output) sized to the surface's
   current dimensions. For in-thread, both rings are core-device textures.
   For Worker, both rings are dmabufs imported on both devices (see
   "Worker transport" below).

3. **render** (per frame). Compositor's `renderFrame` is about to draw
   the matched surface. The SDK:
   - **In-thread**: looks up the surface's current client texture (the
     existing `Surface.texture` field). Sets `input.texture = client
     texture`; rotates output ring; calls `render`. Plugin encodes a
     pass + submits.  SDK installs the just-rendered output slot as
     the surface's "displaced" texture for this frame.
   - **Worker**: copies the client texture into the next input-ring slot
     on the core device, exports the producer fence, signals the plugin
     that input slot N is ready (via the existing surface-slot SAB +
     CAS dance). The plugin's SDK calls `render` with `input.texture` =
     plugin-device view of that slot; the plugin encodes + submits;
     the SDK end-access exports the consumer fence on input + producer
     fence on output. Core consumes output slot N via the existing
     cross-device fence chain.
   - In both cases the plugin's `render` runs SYNCHRONOUSLY and
     encodes + submits before returning. The SDK signals completion
     (in-thread: `queue.onSubmittedWorkDone`; Worker: end-access
     brackets) after render returns.

4. **outputRect**. If `render` returns `{outputRect}`, that rect is
   what the compositor places the surface at this frame (overriding
   the WM's layout). Coordinates are output-space pixels.

5. **Buffer-dimension change**. On client commit of a buffer at new
   dimensions, the SDK reallocates both rings. The next frame's
   `render` sees the new size.

6. **onSurfaceUnmatched**. Fired when the surface unmaps, the surface's
   role changes (rare), or the client's `app_id` changes such that the
   match no longer holds. The SDK frees the rings. The client buffer
   draws raw on the next compose.

7. **destroy**. Plugin calls `unregister` (or the SDK auto-runs it on
   plugin shutdown). `destroy()` fires once. Every still-matched surface
   gets `onSurfaceUnmatched` first.

## Compositor displacement

When a surface is intercepted, the compositor must sample the plugin's
output texture instead of the client texture. The cleanest seam:

- Existing `Surface.texture` field is the client texture (set by
  `commitSurfaceBuffer` / `commitSurfaceDmabuf`).
- Add a sibling field `Surface.interceptOutputView`: when set, the
  compositor's per-surface render pass samples from it instead of
  `Surface.view`. Cleared when no intercept is active for the surface.
- The intercept broker, in a per-frame hook running BEFORE
  `renderFrame`'s draw, walks every intercepted surface, drives its
  render callback, and updates `interceptOutputView` to point at the
  ring slot the plugin just rendered into. The bind-group is rebuilt
  if the view changed (same path `setSurfaceMask` already uses for
  swapping the mask texture).

The per-frame hook fires from `state.beforeRender(timeMs)` -- the same
clock the animation evaluator + cursor rule engine already use.

## In-thread transport

Plugin and core share `GPUDevice`. The SDK is a thin wrapper:

```ts
function createInThreadInterceptSdk(deps: InThreadInterceptDeps) {
  return {
    register(spec) {
      const handlers = await spec.setup(deps.coreDevice);
      deps.broker.registerInThread({ spec, handlers });
      ...
    },
  };
}
```

Per-surface state:

```ts
interface InThreadInterceptState {
  surfaceId: number;
  outputRing: GPUTexture[];   // 3 slots, RENDER_ATTACHMENT|TEXTURE_BINDING|COPY_SRC
  outputIdx: number;          // next slot to render into
  inputTextureRef: () => GPUTexture | null;  // returns the surface's current client tex
}
```

Per-frame `render` dispatch:

```ts
function tickInThread(state, time, frameNumber) {
  const inputTex = state.inputTextureRef();
  if (!inputTex) return;  // no client buffer committed yet; draw raw
  state.outputIdx = (state.outputIdx + 1) % 3;
  const outputTex = state.outputRing[state.outputIdx];
  try {
    const r = state.handlers.render({
      input: { texture: inputTex, rect: { x: 0, y: 0, w: inputTex.width, h: inputTex.height } },
      output: { texture: outputTex, rect: { x: 0, y: 0, w: outputTex.width, h: outputTex.height } },
      ctx: { surfaceId: state.surfaceId, frameNumber, time },
    });
    deps.compositor.installInterceptOutput(state.surfaceId, outputTex, r?.outputRect);
  } catch (e) {
    deps.log(`intercept[${spec.name}].render threw: ${e.message}; falling back to raw`);
    deps.compositor.clearInterceptOutput(state.surfaceId);
  }
}
```

Output ring sized to the input texture's dimensions. Reallocated on
dimension change (next frame after commit).

Slot recycling: same `afterCurrentFrame` mechanism the existing
`setSurfaceTexture` uses. After core's render pass completes on the
GPU, the next slot becomes available. With 3 slots and per-frame
single producer, contention is impossible.

## Worker transport

Plugin runs in its own thread on its own `wgpu::Device`. Cross-device
dmabuf in both directions. Reuses the Phase 5b machinery (`SurfaceProducer`,
`SurfaceConsumer`, the SAB-CAS slot state machine).

### Input leg (core -> plugin) — A2 copy ring

**Open optimization deferred to 10b**: instead of copying, re-export the
client's dmabuf directly to the plugin device. A2 (copy) is what 10a
ships; it's simpler (no per-client-buffer cross-device import lifecycle)
and matches the existing 5b primitives exactly.

For each matched surface:

- Core allocates a 3-slot dmabuf ring (`AllocComposeBuf`-style; same
  GBM allocator the existing rings use). Same as scene compose-live.
  Producer on the core wire, consumer on the plugin wire.
- Each frame, the broker:
  1. Acquires the next free input slot (`tryAcquire`).
  2. Encodes a copy of the client texture into the slot's core-device view
     (`copyTextureToTexture`).
  3. Wraps the copy in producer Begin/End on the core wire (in-band
     access brackets, same as compose-live).
  4. `present`s the slot (slot state PRESENTED).
  5. Plugin-side SDK is signaled (one-way notification over the
     plugin's Endpoint) that input slot N is ready for this surface.

The plugin's SDK looks up the slot's plugin-device `GPUTexture`
(reservation handed off at allocation time, same as overlay path) and
passes it as `input.texture`.

After `render` returns, the plugin's SDK consumer-End-Accesses on the
plugin wire. Core's next frame's compose sees the slot's PRESENTED
state and proceeds (the consumer fence chain serializes the plugin's
reads against core's writes).

### Output leg (plugin -> core) — overlay-style inverse

Symmetric to the existing plugin overlay path:

- The SDK allocates a 3-slot dmabuf ring for output. Producer on the
  plugin wire, consumer on the core wire.
- Plugin renders into the next free output slot in `render`. SDK
  encodes the End-Access on the plugin wire after render returns.
- Core's per-frame intercept hook samples the LATEST presented output
  slot and binds it as `Surface.interceptOutputView`.

Same SAB-CAS slot states, same consumer/producer abstractions. The
plugin code is identical to in-thread: it just writes to
`output.texture`. The SDK handles the cross-device fence chain.

### Performance baseline

A2 (copy) costs roughly one full-surface `copyTextureToTexture` per
intercepted surface per frame, on the core device. For typical
desktop surfaces (1080p × 24bpp = ~8MB), at 60Hz this is bounded but
noticeable in the steady state. Documented as the 10a v1 cost; A1
(re-export) gets it back if/when a real consumer needs it.

## Failure modes

Render throws:
- Log + fall back to drawing the client buffer raw for that frame.
- Subsequent frames still call `render` (transient failure assumed).
- After K consecutive failures (default: 30 = ~half a second at 60Hz),
  the broker treats the registration as dead and fires
  `onSurfaceUnmatched` for every surface; the plugin can re-register
  fresh.

Plugin Worker crashes:
- Existing watchdog / restart-policy machinery (Phase 3) applies.
- During the down window, every matched surface draws raw.
- On restart, the SDK's intercept registrations DON'T survive --
  plugins re-register from their init function. The broker observes
  the gap and falls back to raw cleanly.

Plugin permanently failed (restart budget exhausted):
- Existing behavior: namespace registry demotes; the priority chain
  promotes the next-lower registration if any. For intercept, there's
  no priority chain in 10a -- there's no chain at all. A permanently
  failed plugin's intercepts just stop applying; clients draw raw.

Buffer dimension changes mid-frame:
- The SDK reallocates rings on the NEXT commit, not in-place.
- During the one-frame gap, the surface draws raw.

## Test plan

- **Pure-unit** (`test/intercept-match.test.js`): the match engine
  in isolation. app_id regex matching; role filter; cursor/decoration
  exclusion; re-evaluation on app_id change; surface enumeration on
  registration.
- **Pure-unit** (`test/intercept-broker.test.js`): broker routes
  (intercept.register / unregister); lifecycle callbacks fire in the
  right order; render-throw -> log + skip; K-failures -> unmatched.
- **GPU** (`test/intercept-inthread.gpu.mjs`):
  - **Invert demo**: in-thread bundled fixture plugin that samples
    input.texture and writes `1 - color` to output. Pixel readback:
    a known-color client (red 255,0,0,255) becomes its inverse
    (cyan 0,255,255,255) when the intercept is active.
  - **outputRect**: plugin returns `{outputRect: {x:32, y:32, w:64, h:64}}`
    each frame; pixel readback verifies the surface composites at
    that rect, NOT at its WM-assigned tile.
  - **Match scope**: two clients, one matches (intercepted), one
    doesn't (raw). Verify the right one's pixels are inverted.
  - **Unmatched on close**: client unmaps, the intercept's
    onSurfaceUnmatched fires (observed via plugin log).
- **GPU** (`test/intercept-worker.gpu.mjs`):
  - Same invert demo as a Worker plugin. Verifies the full cross-
    device dmabuf chain (core copies in, plugin samples + writes,
    core composites out) produces the same pixel result as in-thread.
  - Render-throw fallback: a Worker render that throws causes the
    surface to draw raw for that frame, intercept resumes on the
    next.

## File layout (planned)

```
packages/intercept-types/                            (new, type-only)
  src/index.ts                                       InterceptSpec / handlers / API

packages/core/src/intercept/                         (new)
  match-engine.ts                                    app_id + role + per-client
  broker.ts                                          register / lifecycle / per-frame tick
  inthread-state.ts                                  per-surface output ring (core device)
  worker-state.ts                                    per-surface input+output dmabuf rings

packages/core/src/plugins/intercept-sdk.ts           (new)
packages/core/src/plugins/intercept-broker.ts        (new) plugin-facing route

packages/core/src/gpu/compositor.ts                  + Surface.interceptOutputView
                                                     + installInterceptOutput
                                                     + clearInterceptOutput

packages/core/src/protocols/ctx.ts                   CompositorSink additions

packages/core/src/main.ts                            broker construction + beforeRender hook

test/intercept-match.test.js
test/intercept-broker.test.js
test/intercept-inthread.gpu.mjs
test/intercept-worker.gpu.mjs
test/fixtures/plugins/intercept-invert.mjs           (in-thread)
test/fixtures/plugins/intercept-invert-worker.mjs    (Worker)
```

Estimate: ~700 lines of core + tests for in-thread; +~300 for the Worker
cross-device wiring (most of which is dispatcher-parameterization that
already exists from Phase 5b, plus the input-copy-ring direction which
is new). Total ~1000 lines, vs. the original ~1150 for the full chain
version.

## Caveats baked in (to add to status.md when 10a ships)

- **No chain**: only ONE intercept can apply per surface. The
  first-registered match wins for clients matching multiple
  registrations.
- **No per-stage cache**: render is called every visible frame even
  if neither inputs nor effect state changed. Plugin caches its own
  work if needed.
- **No hold-last-output on failure**: render throw -> draw raw for
  that frame (visible flicker). Trade-off vs. texture-lifetime
  complexity; hold-last-output is 10b.
- **Worker input is A2 (copy)**: per-frame `copyTextureToTexture`
  cost per intercepted surface on core device. A1 (direct dmabuf
  re-export) is the 10b optimization.
- **`contributes` field recorded but unused**: 10b's chain dispatch
  will consume it.
- **HiDPI**: ring textures sized to the client buffer's pixel
  dimensions. Scale factor is 1 today (status.md "Read first") --
  awaits `wl_output` reconfiguration.
- **Decoration + cursor surfaces always excluded**: not user-
  selectable in 10a or 10b.
- **Popups + subsurfaces of matched clients draw raw**: 10a matches
  toplevels only. 10b extends to all content surfaces via parent-
  walking + a surfaceCreated/Destroyed event.
- **`outputRect` interacts oddly with the WM**: the WM still owns
  the surface's "logical" rect (for hit-testing + layout). The
  compositor uses `outputRect` for placement, but input events
  hit-test against the WM's rect. Plugins that animate `outputRect`
  far from the WM rect will get hit-tests that don't match the
  visual position. v1 limitation; resolving it cleanly needs the
  WM to consult the intercept for hit-tests too.

## Future direction (10b sketch, not for implementation now)

- Categorized chain (`pixels` → `geometry` → `composition`).
- Per-stage caching keyed on `(commit-since, window-state-since,
  effect-state-since)`.
- Hold-last-output on render failure.
- A1 input optimization (re-export client dmabuf to plugin device).
- Failed-stage skip with fallback to upstream cached output.
- Per-frame budget enforcement (skip stages exceeding K ms).
- Capture / takeover interaction: `compose.windows` / `compose.scene`
  apply the intercept chain to each listed surface; core-plugin-api.md
  §6 forward reference becomes live.
