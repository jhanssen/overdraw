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

**Border becomes an intercept.** The bundled
`plugin-decoration-default` no longer owns a decoration surface. It
registers an intercept that matches `.*` (or the user-configured
appId pattern) at priority 10. Its `render(args)` callback:

- Draws the border band (gradient / shape / focus-state fill) into
  `args.output.texture` using a render pass the plugin set up in
  `setup`.
- Samples `args.input.texture` (the client's content) and writes
  it into the inset (B px) region of `args.output.texture`.
- Returns `{ outputRect: { x: surfaceRect.x - B, y: surfaceRect.y - B,
  w: surfaceRect.w + 2B, h: surfaceRect.h + 2B } }` so the
  compositor places the larger output texture at the expanded rect.

The output texture is the client's logical rect plus a B-pixel ring
on every side, holding the border band's pixels. ~1% texture
overhead (2-pixel band on the perimeter of a typical window),
versus the previous full-window-sized texture for ~0 pixels of
information.

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
- `intercept/worker-state.ts WorkerStateDeps.{width, height}` is
  split into `inputWidth/inputHeight` and `outputWidth/outputHeight`.
  The broker calls `outputDimensions` once at allocate time and
  on every input-dimension change.
- `intercept-sdk.ts` (Worker side) accepts the broker-supplied
  output dimensions when reserving consumer/producer textures.

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

          // Tell compositor to place the larger output at the
          // expanded rect. The compositor's existing surface
          // placement code applies setSurfaceLayout at the WM's
          // outer rect; outputRect overrides for this frame.
          return { outputRect: {
            x: -B, y: -B,
            w: input.rect.w + 2 * B, h: input.rect.h + 2 * B,
          } };
          // NOTE: outputRect's x/y are the OFFSET from the WM's
          // assigned position. (-B, -B) shifts the output up-left
          // by B px so its inset center aligns with the WM rect.
          // Confirm this matches the existing intercept outputRect
          // semantics; if outputRect is absolute output-space, the
          // plugin needs the surface's rect from sdk.windows.get(id)
          // at render time.
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
- **The intercept's output texture is what the compositor was
  sampling for the closing window's content.** When taking the
  snapshot, the closing-driver should sample from the intercept
  output (with the border baked in) rather than the raw client
  texture. Otherwise the closing animation shows a borderless
  window briefly.

  Implementation detail: `createClosingPhantom` already samples
  from the per-surface "current displayed texture" (which is the
  intercept output if an intercept is installed; the raw client
  buffer otherwise). Confirm; if not, route through the same
  texture resolution the per-frame composite uses.

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

## Open questions / decisions to revisit

1. **`outputRect` coordinate space.** Confirm whether
   `outputRect.x/y` is absolute compositor coords or an offset
   from the surface's WM placement. Need either docs read or a
   test of the existing intercept-invert with a non-default
   outputRect.

2. **`ctx.surfaceRect`.** Adding it to the render context is
   slightly extra plumbing but cleaner than `sdk.windows.get`
   every frame. Verify the WM rect is stable through the frame
   (it is; layout is applied synchronously before draw).

3. **First-frame ordering.** With decoration intercepted, there
   is no "decoration first frame" event. The window's
   first-content-commit triggers the intercept's `render`,
   which produces the first output texture with border baked
   in. The opening-driver's content gate (engaged by the
   `window-opening` plugin) still applies. Sequence:
   - Client commits first buffer.
   - `wm.windowHasContent` runs, opening-driver engages the
     content gate via `engageContentGate(id, "opening")`.
   - Animation plugin sets initial transform/opacity, calls
     `releaseOpeningGate`.
   - The intercept's render() fires (it always fires when the
     client commits). Output texture is produced.
   - Compositor samples the output texture (with border) on
     the next frame.

   The decoration-broker's old content gate (for waiting on
   decoration's first frame) GOES AWAY. Decoration is now
   baked into the same output texture as the first content;
   there's no separate "decoration first frame" to wait for.
   Removing that gate is one of the cleanups in step 3.

4. **Configuration migration.** Users with existing
   `decoration: { ... }` config in their `config.layout.layout`
   slice: the bundled plugin's config schema doesn't change
   (still `DecorationPluginConfig` with appIdPattern, border,
   focused, unfocused). Existing user configs keep working.

5. **Removed `sdk.decorations` API impact.** The SDK surface
   shrinks: `sdk.decorations.register` / `createDecoration` /
   `onAssigned` / `onResized` / `onDeregistered` are gone.
   Third-party plugins that USED these APIs (titlebar plugins,
   etc.) would break. The codebase's only consumer is the
   bundled decoration plugin which we're rewriting. Out-of-
   tree consumers don't exist yet (early days). Safe to delete.
