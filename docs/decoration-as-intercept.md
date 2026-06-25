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

**Border becomes an intercept; the plugin returns an outputRect
sized to the WM outer rect.** The WM tracks per-window insets: the
layout assigns an outer rect (decoration-inclusive), and the
content rect is outer minus insets. The client receives configures
sized to the CONTENT rect and commits buffers at that size — that's
also what `compositor.setSurfaceLayout` passes for the toplevel
surface (`wm/index.ts` `pushGeometry` and `applyLayout`).

The intercept output is sized to the FULL OUTER rect (= input
dimensions + 2B on each axis). To make the compositor place the
larger output texture at the outer rect instead of stretching it to
fit the content-rect placement, the plugin returns an outputRect
shifted to cover the outer:

```
outputRect = { x: surfaceRect.x - B, y: surfaceRect.y - B,
               w: surfaceRect.w + 2*B, h: surfaceRect.h + 2*B }
```

`ctx.surfaceRect` is the surface's WM placement (the content rect);
the plugin grows it by B on each axis to the outer rect.

The bundled `plugin-decoration-default` no longer owns a decoration
surface. It registers an intercept that matches `.*` (or the
user-configured appId pattern) at priority 10. On match it calls
`sdk.windows.setInsets(surfaceId, { top: B, right: B, bottom: B,
left: B })` so the WM tells the layout to shrink the content rect.
Its `render(args)` callback:

- Draws the border band (gradient / shape / focus-state fill) into
  the perimeter of `args.output.texture`.
- Samples `args.input.texture` and writes it into the inset (B px)
  region of `args.output.texture` with antialiased inner-shape
  coverage.
- Returns `outputRect` shifted/expanded to the outer rect (above).

The output texture is the WM outer rect's full size = client
texture (content rect) + a B-pixel ring on every side. ~1% texture
overhead (2-pixel band on the perimeter of a typical window),
versus the previous full-window-sized texture for ~0 pixels of
information.

**Subsurface placement is correct under this model.** A
`render`-returned `outputRect` overrides the TOPLEVEL surface's
compositor draw placement (the compositor's `s.x/s.y/s.layoutW/
s.layoutH` for the toplevel surface). It does NOT change the
toplevel's WM `win.rect` (the content rect on the WM side).
Subsurfaces are positioned in `subsurfaces.ts:emitSubtree` using
`win.rect.x, win.rect.y` — the content rect — NOT the toplevel
surface's compositor placement. So shifting the toplevel's draw to
the outer rect leaves subsurfaces at the correct content-relative
screen positions automatically.

(An earlier draft of this design rejected the outputRect approach
on the assumption that subsurfaces followed the toplevel surface's
draw placement. They don't; they follow the WM's content rect via
emitSubtree. The outputRect path is correct.)

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
  decoration plugin is in-thread, so we land `outputDimensions`
  for the in-thread path only.** The Worker SDK throws if a
  registration declares `outputDimensions` returning non-identity
  dims (caught at register time, surfaced as a SDK error to the
  plugin). This keeps the contract honest: a Worker plugin that
  wants to resize the output is rejected at registration, not
  silently mis-sized at runtime. A future Worker decoration
  plugin (or any Worker effect that wants to grow the output —
  drop-shadow, glow, anything outside the input rect) needs the
  resize-renegotiation protocol described above; that is a
  separate piece of work and not blocked by this migration.

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

## Match timing + the first-sized-configure problem

The intercept match engine today fires `onSurfaceMatched` from
`WINDOW_EVENT.map` (broker.ts:122-126). `window.map` fires AT
first content commit. By that point the client has:

1. Received its initial (throwaway 0x0) configure from
   `sendInitialConfigure`.
2. Received its REAL sized configure from the first layout pass
   (in `markInitialCommitComplete` → `driver.schedule` →
   `applyLayout` → `configure.configure(...)`).
3. Committed a buffer at the size from step 2.

If the intercept plugin only learns of the window at step 3 and
calls `setInsets` then, the client has already committed at the
WRONG size. A second relayout fires (content rect shrunk by
insets), the client gets re-configured at the smaller size, and
re-commits. Between the two commits, if the window is drawing,
the user sees one wrong-size frame.

The existing decoration broker handles this with a content gate:
gate engaged at `onAssigned`, released on the decoration's first
present. With intercept-as-decoration, the right fix is **move
the match check earlier** -- to `window.preconfigure`, the seam
where the WM fires an interceptable event AFTER the client has
declared its app_id but BEFORE the real sized configure goes out
(wm/index.ts:1860). The event already exists and is awaited
through the standard interceptor chain; no consumer subscribes to
it today, so the intercept broker becomes the first production
consumer.

Sequence with preconfigure-time match:

1. `get_toplevel` -> `addWindow` with `deferInitialCommit: true`
   (the production xdg_surface handler already opts in).
2. Client sets app_id, sends initial commit (no buffer).
3. `sendInitialConfigure` -> throwaway 0x0 first configure (no
   size; client picks its own for now).
4. `markInitialCommitComplete` fires `window.preconfigure`
   synchronously (interceptable, awaitable).
5. **The intercept match engine evaluates HERE**: appId is set,
   role is `xdg_toplevel`, match runs, if a registration matches
   the SDK fires `onSurfaceMatched(info)`.
6. Plugin's `onSurfaceMatched` calls `sdk.windows.setInsets`
   synchronously inside the preconfigure interceptor chain.
7. `markInitialCommitComplete` returns -> layout pass runs ->
   REAL configure with the (post-insets) content size goes out.
8. Client commits at the right content size first time.
9. `windowHasContent` -> intercept's first `render` fires with
   the right input dimensions.

This eliminates the wrong-size flash without needing a content
gate. The gate becomes a backstop only (for cases where match
happens late, e.g. when an intercept is registered AFTER the
window mapped; the catch-up pass for already-mapped windows
runs through `window.map`-time match-and-gate).

### `gates` field on InterceptSpec

The SDK extends `InterceptSpec` with `gates?: boolean`. When
true, the SDK engages a content gate (under owner
`"intercept-${spec.name}"`) at `onSurfaceMatched` time. Release
mechanism:

**The plugin owns release policy.** The SDK injects a
`releaseGate` callback into the render context:

```ts
render({ input, output, ctx, releaseGate }) {
  // ... do work ...
  releaseGate?.();   // when the plugin is satisfied
}
```

The default policy a plugin author would use for "release on
first render at expected dimensions": the plugin knows the
content rect it expects (it set the insets, it knows `B`, it
can compute expected = outer - 2B). The plugin needs the outer
rect to do that math. Either:

**Strict release policy is the bundled plugin's default.** The
plugin receives `ctx.surfaceRect` (the WM outer rect) in the
render context; it computes `expected = surfaceRect.w - 2*B`
and compares against `input.rect.w`. If they match, the plugin
calls `releaseGate()`. If they don't, the plugin renders the
frame (intercept output replaces the still-out-of-stack client
texture) but does NOT release the gate. The window stays out of
the draw stack until the client has re-committed at the
post-insets size and the intercept renders that frame.

This is mandatory, not optional. The late-match catch-up case
(intercept registers after a window has already mapped and
committed at the full-outer size) is a first-class supported
scenario:

- Plugin hot-reload during development (every save triggers
  unregister + re-register; catch-up enumeration over every
  mapped window).
- User toggle of a decoration plugin via slash command or
  hotkey.
- `priority`-driven re-evaluation when a higher-priority
  intercept unregisters and the freed surface re-evaluates
  against remaining registrations (`broker.removeRegistration`
  → re-match → `onSurfaceMatched` fires on the catch-up plugin).

Permissive "release on first render" would show a wrong-size
frame on every window in every one of those scenarios. Races
that cause rendering artifacts are not acceptable; the strict
policy is small (five lines of plugin code) and eliminates the
artifact entirely.

Backstop: 10 seconds; if neither the plugin nor any first render
fires within that, force-release so a stuck plugin can't keep
the window invisible. Per-spec timeout override is supported via
`gates: { timeoutMs: N }` (object form of the flag).

### Late-match wrong-size sequence (the race)

Without the strict policy, late-match produces this sequence:

1. Window already mapped; configure was at full outer size;
   client committed at full outer; window drawing on screen.
2. Plugin registers. Catch-up enumeration fires
   `onSurfaceMatched` synchronously.
3. Plugin calls `setInsets`. WM queues a relayout shrinking
   the content rect by 2B per side. Gate engages (window out
   of draw stack from now until release).
4. Intercept's first `render` fires. The client has not yet
   acked the new configure or committed at the new size; the
   committed buffer is still at the OLD (full-outer) size. So
   `input.rect.w == outer.w`, NOT `outer.w - 2*B`.
5. With permissive release: gate releases on this render. The
   output texture is `(outer.w + 2B) × (outer.h + 2B)` (from
   `outputDimensions(input.w, input.h)`) being placed at the
   `outer.w × outer.h` WM rect. The client content inside the
   inset region is sampled from a buffer that's already at the
   full outer size, blitted into an inset area 2B smaller, then
   scaled up by the compositor — visible stretched content for
   1+ frame until the client re-commits.
6. With strict release: gate stays engaged. Frames continue
   rendering off-stack. When the client finally re-commits at
   `(outer.w - 2B) × (outer.h - 2B)`, the next render sees
   `input.rect.w == surfaceRect.w - 2*B`, plugin calls
   `releaseGate`, window enters draw stack with the correct
   first frame. No stretched content ever visible.

### Multi-owner gate composition

The opening-driver's content gate (engaged by a separate
`window-opening` plugin) is independent. Multiple gate owners
coexist under the multi-owner gate system already implemented.
A decorated window with an opening-animation plugin has both
gates engaged at map time; the window enters the draw stack
only when both release.

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
          // We overdraw the center; pass 2 covers it.
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
   visible frame regardless of focus. Expected cost: a fullscreen
   quad with a gradient eval + a second pass that samples the
   input texture with an SDF coverage. Plausibly small per
   window but UNMEASURED. Verification required before declaring
   step 2 done: measure GPU frame time with 10 and 20 decorated
   windows at 60Hz on both a discrete GPU and integrated graphics;
   compare to the same scene with the current plugin. If the
   delta is >5% of frame budget on integrated graphics, add a
   per-frame skip mechanism (`{ noChange: true }` return from
   render + cache the prior output slot) in 10b before deleting
   the old machinery in step 3.

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
  regardless of whether content or focus changed. Per-window cost
  is UNMEASURED (see "Focus redraw frequency" above for the
  measurement gate before this lands). 10b's per-stage caching
  could skip when both input AND focus are unchanged; whether
  that's needed depends on the measurement.
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

1. Add `priority` to `InterceptSpec`; sort registrations by
   `(priority, registrationOrder)` in `firstMatching`.
2. Add `outputDimensions` to `InterceptHandlers` (in
   `@overdraw/intercept-types`). Wire through `inthread-state.ts`
   `ensureRing`. Worker path throws on non-identity declaration
   (documented limitation; decoration is in-thread).
   **Failure handling**: if `outputDimensions` returns invalid
   values (zero, negative, exceeding `maxTextureDimension2D`),
   `createTexture` throws. Wrap the texture allocation in
   `ensureRing` with a try/catch that increments the per-surface
   consecutive-failure counter (existing `K=30` threshold path,
   `inthread-state.ts:58`) and auto-unregisters on threshold.
   Bad dims is a programming error; auto-unregister surfaces it
   loudly. This also closes a pre-existing latent crash where a
   `createTexture` throw inside `ensureRing` escapes `tick()`.
3. Add `surfaceRect: Rect` to `InterceptRenderCtx`. Required for
   strict gate-release policy in the bundled decoration plugin
   (see "Match timing + the first-sized-configure problem"
   section).
   Threaded from the compositor's surface record (`s.x/s.y/
   s.layoutW/s.layoutH`) into the render ctx each tick.
4. Add `gates?: boolean | { timeoutMs?: number }` to
   `InterceptSpec`. When truthy, the SDK engages a WM content
   gate under owner `"intercept-${spec.name}"` at
   `onSurfaceMatched` time. Inject `releaseGate: () => void`
   into the render ctx. Backstop timeout (default 10s; per-spec
   override via object form) force-releases on expiry. On
   `onSurfaceUnmatched`, release the gate. On render throw,
   release the gate (intercept falls back to raw client; window
   shows un-bordered, matches today's "broken provider →
   undecorated" semantics).
5. Wire preconfigure-time match in `intercept/broker.ts`. The
   match engine evaluates registrations on `window.preconfigure`
   (in addition to `window.map` for catch-up). On the preconfigure
   path, `onSurfaceMatched` fires synchronously so the plugin's
   `setInsets` lands BEFORE the first SIZED configure goes out
   (a throwaway 0x0 configure has already been sent from
   `sendInitialConfigure`; the SIZED configure is what the
   client actually maps to a window size).
   Verify: `markInitialCommitComplete` fires `window.preconfigure`
   synchronously before the layout pass; `setInsets` in an
   interceptor must affect that layout pass's configure.
6. Add `sdk.windows.setInsets(surfaceId, insets)` to the plugin
   SDK. **Authorization**: the broker rejects the call unless
   the caller's plugin owns an intercept that is currently
   assigned to the target surface (consult the intercept match
   engine's `assignmentOf(surfaceId)` and compare to the
   caller's `pluginName`). This mirrors today's
   `decoration.createDecoration` authorization (only the
   assigned decoration provider can setInsets a given window),
   transplanted onto the intercept model. A plugin with no
   intercept matching the surface cannot move its insets.
7. Tests:
   - `priority` ordering (lower wins; same priority falls back
     to registration order); promoted/demoted re-evaluation when
     a higher-priority intercept unregisters.
   - `outputDimensions` honored at allocate; reallocate when
     input dims change.
   - `ctx.surfaceRect` reflects the current WM rect including
     post-`setInsets` shrink.
   - `gates: true` engages content gate at match; `releaseGate`
     callback releases it; 10s backstop fires on stuck plugin;
     render throw releases gate; unmatch releases gate.
   - Preconfigure-time match: client receives first SIZED
     configure at post-insets size (not pre-insets). Throwaway
     0x0 ack is unaffected.
   - Late-match catch-up with strict policy: gate stays engaged
     until client re-commits at post-insets size; no wrong-size
     frame visible.

Commit. Existing decoration still works (uses the old surface model).

Step 2 (rewrite bundled plugin):

1. Rewrite `plugin-decoration-default/src/index.ts` as an
   intercept registration. Keep config compat. Implement strict
   gate-release (compare `input.rect.w/h` against
   `ctx.surfaceRect.w/h` — the WM's content-rect placement —
   only call `releaseGate` when they match).
2. Implement the inner-clip SDF in the blit WGSL with
   antialiased coverage (see "What stays the same" §
   setShape).
3. Return outputRect from render: `{x: surfaceRect.x - B,
   y: surfaceRect.y - B, w: surfaceRect.w + 2*B,
   h: surfaceRect.h + 2*B}`. This shifts the toplevel surface's
   compositor draw placement from the content rect to the outer
   rect, so the larger output texture composites without
   distortion. Subsurfaces continue to position via the WM's
   win.rect (the content rect), so they remain correctly placed.
4. Measure GPU frame time with 10 and 20 decorated windows at
   60Hz (see "Focus redraw frequency" §). If delta exceeds
   threshold, defer step 3 until per-frame skip lands.
5. Tests pass against the new plugin (existing config tests,
   pixel tests for border + inset + rounded corners, late-match
   catch-up gate test, multi-output decoration test).

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

- Step 1: ~1.5 days. Seven substeps (priority, outputDimensions
  in-thread, ctx.surfaceRect, gates + releaseGate + 10s backstop,
  preconfigure-time match wiring, sdk.windows.setInsets plugin
  path, tests for each).
- Step 2: ~1 to 1.5 days. Includes the inner-clip SDF in the
  blit WGSL with antialiased coverage (NOT hard discard); the
  border shader exists, the blit pipeline + SDF are new; plus
  the measurement gate ("Focus redraw frequency" §) before step
  3 lands.
- Step 3: ~half day (mechanical deletion + test updates).

Total: ~3 to 3.5 days, plus measurement time.

## What stays the same

- `DecorationPluginConfig` / `DecorationShape` / `DecorationFill`
  types remain. The bundled plugin still validates against them.
- `setShape` API on `sdk.windows`. The intercept output texture
  can be clipped by an SDF shape via the compositor's existing
  shape system. Decoration plugin sets a per-window shape (e.g.
  squircle) that clips the OUTER edge of the output.

  Inner clipping (rounding the client content's edge against the
  border band) is the plugin's job, NOT the compositor's. Today
  the bundled plugin uses two setShape calls -- outer on the
  decoration surface (radius R), inner on the content surface
  (radius max(0, R-B)) -- so the border band is uniformly thick
  around the curved corners. With one combined output texture,
  only ONE setShape applies (the outer); the compositor cannot
  apply a separate inner shape to the client texture region.

  The plugin gets the same uniform-band visual by doing the
  inner SDF mask itself in its WGSL blit pass. When blitting
  `args.input.texture` into the inset region of
  `args.output.texture`, the plugin evaluates an inner SDF
  (radius max(0, R-B), inset by B on each side) and computes
  ANTIALIASED COVERAGE (not hard discard) so the rounded edge
  matches today's compositor SDF system:

  ```wgsl
  let d = sdRoundedBox(inset_uv - innerHalfSize,
                       innerHalfSize, innerRadii);
  let coverage = clamp(0.5 - d, 0.0, 1.0);
  let sample = textureSample(inputTex, sampler, blit_uv);
  // Premultiplied alpha: scale color by coverage so corner
  // cutouts show through to the border band underneath.
  return sample * coverage;
  ```

  Pass 1 clears to the border band fill; pass 2's blit writes
  `sample * coverage` with `loadOp: "load"`, so the corner
  cutouts (coverage near 0) keep the band's color underneath.
  This produces:
    - Rounded outer perimeter via compositor setShape(outer).
    - Rounded inner boundary between client content and border
      band via the plugin's own SDF.
    - Uniformly thick border band around the corner (the
      distance from inner edge to outer edge is constant).
    - Antialiased inner curve (no jagged corner pixels).

  The plugin needs the outer shape parameters (radius, kind,
  per-corner radii, superellipse exponent) to compute the
  inset inner SDF. The same `DecorationShape` config the
  bundled plugin already supports, plus the existing `insetShape`
  helper, gives the plugin everything it needs. No additional
  SDK surface required.
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

2. **`ctx.surfaceRect`.** Required for the bundled decoration
   plugin's strict gate-release policy (compare `input.rect.w`
   against `surfaceRect.w - 2*B` to detect post-insets
   re-commit). Lands in step 1.

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

1. **Subsurface placement follows the WM content rect, NOT the
   toplevel's compositor placement.** subsurfaces.ts emitSubtree
   computes child placement as `parent.x + sub.x, parent.y +
   sub.y` where `parent.x, parent.y` is `win.rect.x, win.rect.y`
   from the WM (the content rect). It does NOT consult the
   toplevel surface's compositor `s.x/s.y`. So the decoration
   plugin's `outputRect` (which shifts the TOPLEVEL'S compositor
   draw placement to the outer rect) leaves subsurfaces drawing
   at their correct content-relative screen positions
   automatically. Verified with `test/subsurface.gpu.mjs`
   continuing to pass after the rewrite.

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
