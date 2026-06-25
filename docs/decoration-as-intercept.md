# Decoration as intercept (design)

Status: design only; not implemented. Replaces the current
plugin-owned decoration-surface model with an intercept-driven
model. Resolves the bugs noted in the bottom of this doc.

## Motivation

The current decoration architecture has the bundled plugin allocate
its own `wl_surface`-equivalent (a "decoration surface") sized to the
window's outer rect, render the border band into that surface's
texture, and let the compositor composite it as a sibling surface
below the window's content. Three structural problems:

1. **Wasted texture.** A 2px border around a 1691×1396 window
   allocates a full 1691×1396 BGRA8 texture (~9 MB VRAM per window)
   to store ~2-pixel-wide pixels of border. The interior of the
   decoration texture is unused.

2. **Blending against translucent clients is wrong.** The decoration
   sits BELOW the content in z. A translucent client composites OVER
   the decoration's interior pixels — but the decoration interior
   was supposed to be invisible (only the border band is meaningful).
   Result: translucent clients show decoration content through them.

3. **Animation lifecycle race.** On every retile (e.g. a peer
   maps/unmaps), the WM pushes a new outer rect to the decoration
   surface, then the decoration plugin asynchronously tears down
   the surface and re-allocates at the new size. During the
   teardown, the OLD texture is sampled across the NEW (larger)
   placement and visually stretches. If a `setTransform` animation
   is in flight on the window, the new decoration surface starts
   at identity transform (never received the in-flight `setTransform`
   call that applied to the old decoration surface), so the
   decoration "pops" to its destination rect while the content
   animates. Surface re-allocation on resize is a fundamental
   lifecycle race against any per-window animation.

The right model is what compositors like Hyprland use: borders are
not a separate surface, they are a **render pass parameterized by
the window's geometry** that draws directly into the framebuffer
each frame. No texture allocation. No surface lifecycle. No
race with animations.

Overdraw already has the right primitive: the **buffer intercept
system** (`docs/intercept-design.md`). A plugin matches a window's
toplevel surface, receives the client's texture per frame as INPUT,
writes pixels to an OUTPUT texture the compositor then samples
instead of the client buffer. With two small extensions (described
below), the decoration plugin uses intercept to bake the border
into the output texture — the same texture that carries the client
content — so all three problems above resolve.

## Approach

**Border becomes an intercept; the WM's outer rect IS the
decoration-inclusive rect.** Reusing how today's decoration model
treats insets: the WM tracks per-window insets, the layout assigns
each window an outer rect (decoration-inclusive), and the content
rect is the outer rect shrunk by the insets. The client receives
configures sized to the CONTENT rect and commits buffers at that
size. The intercept output is the FULL OUTER rect (= input
dimensions + 2B on each axis). Critically, the intercept does NOT
move the surface placement — the output replaces the client texture
in-place at the WM's outer rect. Subsurfaces anchor to the
toplevel's outer rect (unchanged behavior).

The bundled `plugin-decoration-default` no longer owns a decoration
surface. It registers an intercept that matches `.*` (or the
user-configured appId pattern) at priority 10. On match it calls
`sdk.windows.setInsets(surfaceId, { top: B, right: B, bottom: B,
left: B })` so the WM tells the layout to shrink the content rect.
Its `render(args)` callback:

- Draws the border band (gradient / shape / focus-state fill) into
  the perimeter of `args.output.texture`.
- Samples `args.input.texture` and writes it into the inset (B px)
  region of `args.output.texture`.
- **Does NOT return an outputRect.** The output texture replaces
  the client at the WM-assigned outer rect. The compositor's
  `setSurfaceLayout` for the toplevel is the OUTER rect; the
  intercept output is sized to match.

The output texture is the WM outer rect's full size = client
texture (content rect) + a B-pixel ring on every side. ~1% texture
overhead (2-pixel band on the perimeter of a typical window),
versus the previous full-window-sized texture for ~0 pixels of
information.

**Why this model avoids the subsurface placement bug.** A
`render`-returned `outputRect` overrides the surface's draw
placement. Subsurfaces anchor to the toplevel's WM-assigned
`s.x/s.y` (subsurfaces.ts emitSubtree); they do NOT follow
`outputRect`. So shifting the toplevel via `outputRect: { x: -B,
y: -B, ... }` would visually break a decorated GTK app with
embedded scrollbar subsurfaces. The insets-based model puts the
border band INSIDE the outer rect (the area the WM was already
reserving), no placement shift needed, subsurfaces compose
correctly.

The `outputRect` mechanism stays in the SDK for plugins that
genuinely want to override placement (e.g. a slide-out animation
effect operating on the whole window). Decoration doesn't use it.

## SDK extensions (new in 10a)

Two small additions to `@overdraw/intercept-types` and the broker:

### 1. `outputDimensions` callback on `InterceptHandlers`

```ts
interface InterceptHandlers {
  // ... existing handlers ...

  // OPTIONAL. Called when the SDK is about to allocate (or
  // reallocate) the output ring. Returns the dimensions to use.
  // Default: { w: inputW, h: inputH } (matches current behavior).
  //
  // Reallocation triggers when input dimensions change (client
  // commits a buffer at a new size). The output ring follows by
  // recomputing through this callback.
  outputDimensions?(inputW: number, inputH: number): { w: number; h: number };
}
```

Border plugins return `{ w: inputW + 2*B, h: inputH + 2*B }`.

Implementation:

- `intercept/inthread-state.ts ensureRing(w, h)` becomes
  `ensureRing(inputW, inputH)`, calls `handlers.outputDimensions?.(inputW, inputH)
  ?? { w: inputW, h: inputH }`, and allocates 3 slots of the
  returned dimensions.
- `intercept/worker-state.ts` currently treats `width`/`height` as
  readonly at allocation time (worker-state.ts:92-93) and has no
  resize path. Implementing this for Worker is a meaningful piece
  of work: a new round-trip protocol where the SDK signals the
  broker that input dimensions changed, the broker reallocates
  both rings with the plugin-declared output dimensions, ships
  the new SAB + surfaceBufIds back to the Worker. The in-thread
  path already re-runs `ensureRing` per tick, so the in-thread
  decoration plugin works out of the box.

  **For step 1 of the migration (intercept SDK extension), the
  decoration plugin is in-thread, so we can land `outputDimensions`
  for the in-thread path only and explicitly leave Worker as a
  follow-up TODO.** Worker decoration is a non-goal in this
  migration; Worker effects (blur, etc.) don't change dimensions
  so the current "fixed at allocate time" behavior is acceptable
  for them.

### 2. `priority?: number` on `InterceptSpec`

```ts
interface InterceptSpec {
  // ... existing fields ...

  // OPTIONAL. Lower numbers match first. Two registrations with the
  // same priority fall back to registration order. Default 0.
  //
  // Lets the bundled decoration plugin claim priority 10 (matches
  // everything as a fallback) while user-installed effect plugins
  // claim priority 0 (firefox blur, etc.) -- the effect plugin's
  // narrower pattern matches firefox first; decoration matches the
  // rest.
  priority?: number;
}
```

Implementation:

- `intercept/match-engine.ts firstMatching(top)` sorts registrations
  by `(priority, registrationOrder)` ascending before scanning. Today
  it just scans `registrations[]` in registration order; new sort is
  one comparator on the registration list.
- `RegistrationData` gains `priority: number`.
- `broker.ts registerInThread` / `registerWorker` extract
  `spec.priority ?? 0`.

That's the entire SDK delta. Both extensions are additive (default
behavior matches 10a today).

## Content gate (decoration first-frame)

Today the decoration broker engages a content gate on
`onAssigned` and releases on the decoration plugin's first
present (or backstop). The gate exists because:

- Client maps with no insets known; layout assigns it full outer.
- Decoration plugin matches, calls `createDecoration({ insets })`,
  which calls `wm.setInsets`, which schedules a relayout shrinking
  the content rect.
- The client receives a new configure with the smaller content
  size and re-commits at that size.
- Without the gate, between (a) the client's first commit at the
  full size and (b) the re-commit at the inset size, the window
  would briefly draw at the wrong size.

With intercept-as-decoration the same race exists. The intercept's
`onSurfaceMatched` fires synchronously from `window.map` (which
fires BEFORE `windowHasContent` in `dispatchFrameCallbacks`), so
the plugin's `sdk.windows.setInsets` call lands before content
becomes drawable. But the WM has already given the client a
configure at the full outer size (during `addWindow` / first
layout pass); the client commits at that size; only after the
post-setInsets relayout does it get reconfigured to the smaller
content size.

The decoration intercept must engage the content gate so the
window doesn't draw until the inset relayout completes AND the
client has re-committed at the new size AND the intercept's first
render with the new dimensions has produced an output texture.
This is the same lifecycle the existing decoration broker
implements; the migration moves it into the intercept SDK or the
plugin itself.

Recommended: extend the intercept SDK so a registration can
declare `gates: true` in its spec. When the SDK matches a
surface with `gates: true`, it engages the content gate under
owner `"intercept-decoration"` at `onSurfaceMatched` time and
releases on the first successful `render` whose input dimensions
match the post-insets content rect (i.e. the client has
re-committed at the smaller size). This keeps the gating
mechanism mechanical and reusable: any intercept that needs to
hold content until its first render can opt in.

The opening-driver content gate (engaged by a separate
`window-opening` plugin) is independent; both gates can coexist
under the multi-owner gate system already implemented.

## Bundled decoration plugin (rewrite)

`packages/plugin-decoration-default/src/index.ts` becomes:

```ts
import { tween, ... } from "@overdraw/sdk-anim";
// (or no anim import; decoration doesn't animate itself)

export default async function init(sdk, rawConfig) {
  const config = validateConfig(rawConfig);
  if (!sdk.intercept || !sdk.gpu) {
    throw new Error("decoration-default requires sdk.intercept + sdk.gpu");
  }
  const B = config.borderWidth;

  await sdk.intercept.register({
    name: "decoration-default",
    match: { appId: { source: config.appIdPattern, flags: config.appIdFlags } },
    priority: 10,  // last-resort fallback; user effects at priority 0 win
    gates: true,   // engage WM content gate until first render at post-insets size
    setup: ({ device }) => {
      const borderPipeline = createBorderPipeline(device);
      const blitPipeline = createBlitPipeline(device);
      // Per-window focus state, indexed by surfaceId.
      const focusState = new Map<number, boolean>();
      // Subscribe to window.change to track focus changes; redraw
      // happens implicitly on the next intercept render() call.
      sdk.windows.onChange((ev) => {
        focusState.set(ev.surfaceId, ev.activated);
      });
      return {
        outputDimensions: (w, h) => ({ w: w + 2 * B, h: h + 2 * B }),
        onSurfaceMatched: (info) => {
          // Tell the WM about the inset so the layout shrinks the
          // content rect by B on each side.
          void sdk.windows.setInsets(info.surfaceId,
            { top: B, right: B, bottom: B, left: B });
        },
        onSurfaceUnmatched: (info) => {
          focusState.delete(info.surfaceId);
        },
        render: ({ input, output, ctx }) => {
          const focused = focusState.get(ctx.surfaceId) ?? false;
          const fill = focused ? config.focused : config.unfocused;
          const enc = device.createCommandEncoder();

          // Pass 1: fill the entire output with the border gradient.
          // (Cheap; we overdraw the center, then pass 2 covers it.)
          const passBorder = enc.beginRenderPass({
            colorAttachments: [{
              view: output.texture.createView(),
              loadOp: "clear",
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              storeOp: "store",
            }],
          });
          // ... bind border pipeline + fill uniforms + draw fullscreen ...
          passBorder.end();

          // Pass 2: blit client texture into the inset region. The
          // scissor restricts writes to [B, B, B+inputW, B+inputH].
          const passBlit = enc.beginRenderPass({
            colorAttachments: [{
              view: output.texture.createView(),
              loadOp: "load",
              storeOp: "store",
            }],
          });
          passBlit.setScissorRect(B, B, input.rect.w, input.rect.h);
          // ... bind blit pipeline (samples input.texture) + draw ...
          passBlit.end();
          device.queue.submit([enc.finish()]);

          // No outputRect. The output texture is sized to the
          // WM outer rect; the compositor's setSurfaceLayout for
          // this toplevel already targets the outer rect; the
          // intercept output replaces the client texture at that
          // placement. Subsurfaces anchor to the WM rect (correct)
          // and compose at their offsets relative to it.
          return undefined;
        },
        destroy: () => {
          // Tear down pipelines, etc.
        },
      };
    },
  });
}
```

Two open questions on the plugin side:

1. **`outputRect` semantics.** The intercept design says
   `outputRect` is an output-space placement. The plugin needs to
   know where the WM placed the surface to compute the expanded
   rect (`x - B, y - B, w + 2B, h + 2B`). The cleanest API would
   be for the SDK to thread the surface's current rect into the
   `render` ctx so the plugin doesn't need a separate
   `sdk.windows.get(id)` call per frame. Add `ctx.surfaceRect:
   Rect` to the intercept's render context.

2. **Focus redraw frequency.** Today the bundled plugin redraws
   once per focus flip. Under intercept, render() runs every
   visible frame regardless of focus — the work is constant.
   Acceptable: the border pass is cheap (a fullscreen quad +
   gradient eval). If profile shows it's a problem, the SDK could
   add "skip render this frame if the plugin returns
   `{ noChange: true }` AND the prior output slot is still bindable"
   as a 10b optimization.

## Code to delete

The following machinery exists solely to support the old separate-
decoration-surface model. With the intercept-based decoration, it
goes away:

- `packages/core/src/wm/index.ts`:
  - `Window.decorationSurfaceId` field
  - `Wm.setDecorationSurface` method
  - `decorationResize` hook + the `decorationResize` option on `WmOptions`
  - Calls to `compositor.setSurfaceLayout(decorationSurfaceId, ...)`
    inside `pushGeometry` and `applyLayout`
  - `decorationResize(...)` callback fires inside `pushGeometry`
    and `applyLayout`
  - The decoration-surface splice in `pushStack` (~line 1042-1045
    in current code): `if (w.decorationSurfaceId !== undefined)
    ids.push(w.decorationSurfaceId)` before pushing the window id.
- `packages/core/src/plugins/decoration-broker.ts` — delete entirely.
- `packages/core/src/decorations.ts` — delete entirely (the
  decoration registry).
- `packages/core/src/main.ts`:
  - The `decorationBroker` instantiation
  - The `decorationResize` wire-through into `createWm`
- `packages/decoration-types/src/index.ts`:
  - `DecorationAssignedEvent`, `DecorationDeregisteredEvent`,
    `DecorationResizedEvent` — delete (the decoration namespace's
    bus events)
  - Keep `DecorationPluginConfig`, `DecorationShape`, `DecorationFill`
    (the bundled plugin still uses these for its own config schema)
- `packages/core/src/plugins/sdk.ts`:
  - `sdk.decorations.register`, `sdk.decorations.createDecoration`,
    `sdk.decorations.onAssigned`, `sdk.decorations.onResized`,
    `sdk.decorations.onDeregistered` — all gone. (Future titlebar /
    custom widget plugins use intercept with `outputDimensions`
    extending the top edge.)
- `packages/core/src/protocols/closing-driver.ts`:
  - The decoration-id enumeration in `beforeUnmap` —
    `wmWin?.decorationSurfaceId` lookup goes away. The closing
    driver still snapshots the window's full surface set (content
    + subsurfaces) into a phantom texture; decoration is gone, so
    one fewer surface to enumerate.
- `packages/core/src/subsurfaces.ts`:
  - `WmWindowLike.decorationSurfaceId` field
  - The decoration interleaving in `computeBaseStack` (lines
    ~163-168)
- `test/decoration-zbind.test.js` — delete (no separate
  decoration surface = no z-binding to test).
- `test/example-decoration.gpu.mjs` — rewrite or delete; the
  test specifically tests the surface-allocation lifecycle that
  no longer exists.
- `test/fixtures/plugins/decoration-*.mjs` — delete or rewrite
  fixtures.

The closing-driver simplifies: today its `beforeUnmap` enumerates
decoration + content + subsurfaces. After the change, it
enumerates content + subsurfaces. The phantom snapshot still
needs to be an explicit GPU snapshot (the user explicitly
called this out): even though the intercept's output texture
contains content + border, **subsurfaces are independent
surfaces** at their own placements that the intercept does NOT
touch. The snapshot has to composite them into the phantom
texture. So `createClosingPhantom` keeps the same shape; it just
gets a shorter id list.

## Insets

The WM tracks per-window insets so the layout shrinks the content
rect for the border. Today `decoration.createDecoration({ insets })`
calls `wm.setInsets`. After the change, the bundled plugin calls
`sdk.windows.setInsets(surfaceId, insets)` directly from its
`onSurfaceMatched` handler.

Two SDK details:

1. **`sdk.windows.setInsets` already exists** (via the broker).
   Confirm the existing path works for a plugin caller. If not,
   add a broker method.
2. **Inset timing.** Today the inset eats from the WM-assigned
   outer rect to derive the content rect (`win.rect`). The
   client renders at `win.rect` dimensions. With the new model,
   the client texture is `(outer.w - 2B) × (outer.h - 2B)` and
   the intercept's output is `outer.w × outer.h` — bigger than
   the client texture by 2B on each axis. The intercept SDK's
   `outputDimensions` callback receives the client texture's
   dimensions (= content rect) and returns the expanded outer.
   So the plugin's `outputDimensions` does NOT need to know
   about insets directly — it just declares `+2B` on each side
   of the client texture.

   Effective sizes:
   - WM outer (the tile): 1691 × 1396
   - WM content rect (with insets B=2): 1687 × 1392
   - Client commits a buffer at: 1687 × 1392
   - Intercept input.w/h: 1687, 1392
   - Intercept output.w/h: 1691, 1396 (= input + 2*B)
   - outputRect placement: shifted (-B, -B) from the surface's
     placement so the output overlaps the WM's outer rect exactly.

## Closing animation interaction

The closing-driver currently snapshots the window's surface set
into a phantom. With the changes:

- **The decoration is GONE from the surface set** (no separate
  decoration surface). The closing-driver enumerates only the
  content surface + subsurfaces.
- **The snapshot still happens** (explicit GPU composite into a
  phantom texture) because subsurfaces are still independent
  surfaces and need to be combined for the phantom.
- **The phantom's content surface entry automatically samples
  the intercept's output texture.** Confirmed: `composeSnapshot`
  iterates the draw list and uses each surface's `s.bindGroup`
  (compositor.ts:2614 `pass.setBindGroup(0, s.bindGroup)`). When
  an intercept is installed, `installInterceptOutput` swaps the
  surface's bind group to point at the intercept output texture.
  At snapshot time, `s.bindGroup` reflects whatever was most
  recently installed — which is the intercept output for any
  surface with an active intercept. So the phantom snapshot
  composites the bordered output, not the raw client buffer.
  No code change needed here; just preserve the invariant.

  One subtlety: if the closing-driver's `beforeUnmap` fires
  AFTER the intercept's output ring has been recycled or
  destroyed (because the surface unmapped, the intercept torn
  down, the ring freed), the bind group could point at a
  destroyed view. The intercept teardown order needs to be:
  closing-driver snapshot first → THEN tear down the intercept
  output ring. The closing-driver currently runs `beforeUnmap`
  before `wm.unmapWindow`; the intercept teardown is wired via
  `onSurfaceUnmatched` which fires from `window.unmap` (after
  `beforeUnmap`). So today's order is correct: snapshot first,
  unmatch second. Preserve.

## Limitations (10a, with explicit deferrals)

- **One intercept per surface.** A user-installed blur intercept
  on Firefox + the bundled decoration intercept will NOT both
  apply: the user's blur (priority 0) takes Firefox, decoration
  (priority 10) takes everything else. Firefox renders blurred
  but with no decoration. For Firefox to have both: 10b chain.
  Stated and accepted.
- **No per-frame skip.** Decoration renders every visible frame
  regardless of whether content or focus changed. Cheap but not
  free. 10b's per-stage caching could skip when both input AND
  focus are unchanged.
- **Translucent clients.** The intercept output composes the
  client texture's premultiplied alpha onto a solid decoration
  band, so the result has the right alpha behavior at the band
  (decoration solid, content as-is). Translucent client interior
  composites against whatever's behind the WINDOW — correct,
  not against the decoration interior — fixing today's
  blending-against-decoration bug.

## Test plan

- **Unit**: extend `test/intercept-match.test.js` to assert the
  priority ordering (lower priority matches first, same priority
  falls back to registration order).
- **Unit**: extend `test/intercept-broker.test.js` to assert
  `outputDimensions` is honored; allocates output rings at the
  declared size.
- **Unit**: bundled decoration plugin config tests
  (`test/plugin-decoration-default/config.test.js`) — keep the
  existing config-validation tests; the config schema does not
  change.
- **GPU integration**: rewrite `test/example-decoration.gpu.mjs`
  to assert the intercepted output texture contains a border
  band of the expected fill in the expected pixels, and the
  inset region samples the client's texture pixels. Mid-window
  pixel matches client; near-corner pixel matches border fill.
- **Animation**: extend `test/window-animations` (or similar) to
  verify that during a retile animation, the border moves in
  lockstep with the content (single setTransform on the
  windowId target moves the intercepted output texture as a
  unit — same as today's broker group expansion, but now there's
  only one surface to apply transform to).
- **Closing**: verify `test/closing-animation.gpu.mjs` still
  passes — the closing-driver enumerates one fewer surface
  (decoration is gone), but the snapshot composite still
  produces a correct phantom (because the intercept output had
  the border baked in).
- **Multi-output**: verify decoration works on a window mapped
  on a non-primary output (the intercept output texture should
  be placed via outputRect honoring the output's origin).
- **Delete**: `test/decoration-zbind.test.js`,
  `test/fixtures/plugins/decoration-*.mjs` (if applicable).

## Migration order

Step 1 (additive, no behavior change):

1. Add `outputDimensions` to `InterceptHandlers` (in
   `@overdraw/intercept-types`).
2. Wire it through `inthread-state.ts` and `worker-state.ts` /
   `intercept-sdk.ts` Worker leg. Default = identity (output =
   input).
3. Add `priority` to `InterceptSpec`; sort registrations by
   `(priority, registrationOrder)` in `firstMatching`.
4. Add `surfaceRect` (or equivalent) to the render context so
   plugins can compute output rect placement without a separate
   `sdk.windows.get` call.
5. Tests for both, passing on the existing intercept-invert
   fixture.

Commit. Existing decoration still works (uses the old surface model).

Step 2 (rewrite bundled plugin):

1. Rewrite `plugin-decoration-default/src/index.ts` as an
   intercept registration. Keep config compat.
2. Tests pass against the new plugin.

At this point, both code paths exist in parallel: the old
decoration-broker is still loaded (just not used by anything in
the bundled config). User configs that depended on the old API
keep working until step 3.

Commit.

Step 3 (delete the old machinery):

1. Delete decoration-broker, decoration registry, the bundled
   plugin's references to the old API, etc.
2. Remove `decorationSurfaceId` from Window, from
   `WmWindowLike`, from snapshot, etc.
3. Remove decoration's hooks in computeBaseStack, closing-driver,
   subsurfaces.ts.
4. Update / delete tests.
5. Update `docs/intercept-design.md` to record `outputDimensions`
   and `priority` as 10a (not deferred).
6. Update `docs/protocol-coverage.md` if needed.

Commit.

## Effort estimate

- Step 1: ~half day.
- Step 2: ~half day to a day (mostly plumbing + the WGSL pipeline
  for the new render path; the border shader exists, the blit
  pipeline is new).
- Step 3: ~half day (mechanical deletion + test updates).

Total: ~1.5 to 2 days.

## What stays the same

- `DecorationPluginConfig` / `DecorationShape` / `DecorationFill`
  types remain. The bundled plugin still validates against them.
- `setShape` API on `sdk.windows`. The intercept output texture
  can be clipped by an SDF shape via the compositor's existing
  shape system. Decoration plugin sets a per-window shape (e.g.
  squircle) that clips the output. **But**: today's plugin sets
  TWO shapes — outer (on the decoration surface) and inner (on
  the content surface). With one combined texture, only ONE
  shape applies — the outer. The "inner shape clips client
  content" effect is gone; the client's content sits in a
  rectangular inset region inside the rounded outer. Acceptable
  for most uses; if a user wants the client texture itself
  rounded, that's a separate setShape call from the intercept
  plugin against the original surfaceId... but the compositor
  no longer samples the original surface (it samples the
  intercept output). So `setShape(windowId, ...)` applies to
  the OUTPUT, which is what we want.
- `setOpacity`, `setTint`, `setColorMatrix` group-aware paths:
  with no separate decoration surface, the "group" for a
  windowId is just the content surface (and any subsurfaces).
  The setTransform/setOpacity broker group expansion stays the
  same but the deco isn't in the group anymore.
- Insets / `setInsets`. Still used. Just called from the new
  decoration intercept's `onSurfaceMatched` rather than from
  the old `createDecoration`.

## Open questions / decisions resolved

These were open in an earlier draft; resolved here:

1. **`outputRect` coordinate space.** Verified by reading the
   code: `outputRect.x/y` is ABSOLUTE compositor coords, not an
   offset. (intercept-sdk.ts wraps the value as a placement
   override consumed by `installInterceptOutput` →
   compositor.ts:2298-2411 + test/intercept-inthread.gpu.mjs
   uses literal absolute coords.) The decoration plugin doesn't
   use `outputRect` (per the "Approach" section above), so this
   doesn't affect it. Other intercept users should know.

2. **`ctx.surfaceRect`.** Not needed by the decoration plugin
   (no outputRect override). Worth adding to the render context
   for OTHER intercept use cases (e.g. an intercept that wants
   to position itself relative to the window). Optional; defer.

3. **First-frame ordering.** Resolved via the content-gate
   section above. The intercept SDK gains a `gates: true`
   declaration; the SDK engages the content gate on
   onSurfaceMatched and releases on first successful render at
   the post-insets dimensions. Coexists with opening-driver's
   gate via the existing multi-owner gate system.

4. **Configuration migration.** Users with existing
   `decoration: { ... }` config in their config slice: the
   bundled plugin's config schema doesn't change (still
   `DecorationPluginConfig` with appIdPattern, border, focused,
   unfocused). Existing user configs keep working.

5. **Removed `sdk.decorations` API impact.** The SDK surface
   shrinks: `sdk.decorations.register` / `createDecoration` /
   `onAssigned` / `onResized` / `onDeregistered` are gone.
   Third-party plugins that USED these APIs (titlebar plugins,
   etc.) would break. The codebase's only consumer is the
   bundled decoration plugin which we're rewriting. Out-of-
   tree consumers don't exist yet (early days). Safe to delete.

## Known limitations / acknowledged gaps

These are NOT showstoppers but should be documented:

- **Worker intercepts can't change output dimensions today.**
  worker-state.ts treats input/output dimensions as readonly at
  allocate time. The decoration plugin runs in-thread so this
  doesn't matter for the migration. A future Worker-located
  decoration plugin would need a new SDK round-trip protocol to
  renegotiate ring dimensions. Left as TODO; `outputDimensions`
  is implemented for in-thread in step 1, throws or no-ops in
  the Worker path. Document this in the SDK comment.

- **Worker intercepts' `outputRect` is silently dropped today.**
  worker-state.ts:317 hardcodes `null` for placement; the
  plugin's returned `outputRect` is thrown away. Existing 10a
  gap, not caused by this migration. Worth fixing eventually
  but not required for decoration (which doesn't use outputRect).

- **Match engine title-change re-evaluation is wired but not
  consumed.** match-engine.ts tracks title and fires for changes
  but `matches()` only consults appId + role. Today's decoration
  matches on appId only so functionally fine. A future
  decoration-by-title use case ("Firefox - Private Browsing"
  gets red border) would hit a dead-code path. Defer.

- **xdg_decoration / kde_decoration protocols remain unchanged.**
  Both always reply `server_side` regardless of whether an
  intercept actually decorates. This is correct behavior: the
  client suppresses its CSD whether or not we draw a border;
  matching is per-window via the intercept's appId filter,
  independent of the protocol negotiation.

## Implementation gotchas (do not skip)

These are findings from a careful review pass; not noted earlier:

1. **Subsurface placement does NOT follow outputRect.**
   subsurfaces.ts emitSubtree computes child placement as
   `parent.x + sub.x, parent.y + sub.y` using the toplevel's
   stored `s.x/s.y` — the WM rect, NOT the outputRect override.
   If decoration used `outputRect` to shift the toplevel, the
   subsurfaces would render at the un-shifted toplevel position,
   visually breaking GTK/Qt apps with embedded subsurfaces. The
   insets-based model in this doc avoids the issue by not
   shifting placement; the band is INSIDE the outer rect the WM
   already assigned. If a future intercept (not decoration) DOES
   need to shift placement, subsurfaces.ts would need an update
   to consult the intercept's placement override — separate work.

2. **Insets timing relative to first commit.** The intercept's
   `onSurfaceMatched` fires from `window.map` which fires BEFORE
   `windowHasContent` in `dispatchFrameCallbacks`. Synchronous
   `setInsets` calls in the handler land before the window
   becomes drawable. But: by `window.map` time, the client has
   already received its initial configure (sent at
   `addWindow`/first layout pass) at the full outer size; the
   client has committed at that size. The post-`setInsets`
   relayout sends a NEW configure with the inset content size;
   the client re-commits. Without a content gate, the window
   draws once at the full-outer size (no border, wrong content
   size) before the re-commit lands. The `gates: true` mechanism
   in the SDK extension is what closes this race.

3. **Closing-driver phantom samples correct texture.** Verified:
   `composeSnapshot` uses `s.bindGroup` which reflects the
   currently-installed intercept output. Teardown order
   (snapshot first, then onSurfaceUnmatched) preserves the
   bind group's validity during snapshot.

4. **`pushStack` decoration splice.** Two paths exist
   (wm/index.ts:1042-1045 in the WM's local pushStack, and
   subsurfaces.ts computeBaseStack via the SDK). Both must
   be updated to drop the decoration insertion.
