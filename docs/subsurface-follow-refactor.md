# Refactor: centralize "subsurface follows parent" in the compositor

## Background

A `wl_subsurface` can never move independently. Its position is defined purely
as `parentPosition + offset`, and the entire subsurface subtree moves with the
parent as one unit. So "subsurface position" is not really its own concept — it
is a derived value.

Today the codebase leaks that derivation across many callers, which is what made
the "content-in-subsurface client renders on top of its neighbour" bug
(Firefox) a game of whack-a-mole. Baseline commit `17d97ce` fixed the bug with
four stacked patches, but the underlying architecture still spreads subsurface
knowledge around:

- **Position:** `emitSubtree` (`packages/core/src/subsurfaces.ts`) bakes each
  child into an absolute `setSurfaceLayout`, but only when something calls the
  WM's `rebuild` hook — so the WM had to learn to re-emit on a move.
- **Transform / opacity:** each surface has its own independent `fx`. To move a
  window as a unit, callers must expand it to its surface group
  (`resolveWindowGroup`) and apply to each member. The plugin-facing broker does
  this; the animation evaluator's per-tick path originally did **not** — that was
  the direct cause of the Firefox bug (the content subsurface got the animation's
  start transform but none of the decay ticks).

## Goal

The public operation should be **"move / transform this surface,"** and the
subtree should follow *inside the compositor*, with no caller — WM, animation
evaluator, or windows-broker — ever enumerating subsurfaces.

## What this refactor should delete

- The group-aware evaluator sink wrapper in `packages/core/src/main.ts` (around
  the `createEvaluator` call).
- The `resolveWindowGroup` enumeration in
  `packages/core/src/plugins/windows-broker.ts` (`handleSetTransform` /
  `handleSetOpacity`).
- The WM rebuild-on-move hooks in `packages/core/src/wm/index.ts`
  (`applyLayout`'s `immediateMoved`, `pushGeometry`'s `rebuild?.()`).
- The emit-on-every-change pattern (`emitSubtree` in
  `packages/core/src/subsurfaces.ts`), folded into the compositor.

## Open question to settle first

How should a parent's **scale** compose onto a child at an offset?

Today the broker applies the same `(tx, ty, sx, sy)` to every group member,
each around that surface's *own* placement origin — exact for translate,
approximate for scale (accepted at animation timescales). A compositor-owned
cascade must decide whether to keep that approximation or apply the parent
transform around the *parent's* origin (geometrically correct, but a larger
shader / uniform change: the child's placement and size both have to scale
relative to the parent anchor, not just the child scale around its own origin).

## Baseline

Commit `17d97ce` (main) is the known-good starting point. It also carries the
three regression tests the refactor must keep green:

- `test/viewport-crop.gpu.mjs` — `surfaceReadyAt` keys on logical size, not
  buffer pixels.
- `test/wm-subsurface-follow.test.js` — child follows the parent on both the
  immediate reflow and the resize-transaction apply.
- `test/subsurface-move-damage.gpu.mjs` — a `0x0`-layout (size-from-intrinsic)
  surface move damages its buffer footprint.
