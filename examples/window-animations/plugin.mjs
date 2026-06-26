// Window animation plugin example.
//
// One subscription handles all window-set transitions through the
// extended window.relayout event:
//
//   CREATED (oldOuter === null, newOuter populated): a window joined
//     the layout this pass. For tiled windows we slide in from the
//     output's right edge; for floating windows we fade in.
//   RETILED (both rects populated): a window's rect changed. The
//     compensating "presnap" transform makes the surface visually
//     stay at oldOuter even though the WM has installed newOuter;
//     the animation moves it from presnap to identity.
//   DESTROYED (newOuter === null): a window unmapped. The closing-
//     driver minted a phantom for its last visible state; we animate
//     the phantom out (slide off for tiled, fade for floating) and
//     destroy it on completion.
//
// Cross-output moves (oldOutputId !== newOutputId) are first-class:
// the retile presnap math operates in compositor coords, so a window
// sliding from output A to output B produces a single coordinated
// animation from oldOuter to newOuter regardless of which outputs
// each belongs to.
//
// All animations share DURATION_MS + EASING so the seam between
// shrinking peers and the sliding-in newcomer stays continuous.
//
// We also claim 'window-opening' + 'window-closing' so the
// corresponding drivers engage their gates: the window-opening
// gate holds a new window out of the draw stack until our relayout
// interceptor has set the presnap transform; the window-closing
// driver mints the phantom that our DESTROYED branch animates.
// Without the namespace claims, the drivers no-op and we'd see
// pop-in / pop-out.

import { tween, target, easings } from "@overdraw/sdk-anim";

const DURATION_MS = 200;
const EASING = easings.easeOut;

export default async function init(sdk) {
  // Claiming these namespaces makes the opening / closing drivers
  // active. opening-driver engages a content gate at first-content
  // so the window doesn't draw until we've set the presnap
  // transform (via window.relayout CREATED, which fires before the
  // opening-driver's window.opening). closing-driver mints a
  // phantom for the unmapping window's last visible state -- the
  // surface we animate from DESTROYED.
  await sdk.registerPlugin("window-opening", () => ({}));
  await sdk.registerPlugin("window-closing", () => ({}));
  sdk.log("window-animations: registered");

  // Cache the output rect for each output so the CREATED slide-in
  // math can compute "the output's right edge" without an async
  // sdk.windows.get(id) inside the interceptor. The window.relayout
  // event carries newOuter (in compositor coords) but not the output
  // dimensions; we look them up from this cache, keyed by newOutputId.
  // Populated synchronously on output add (sdk.windows exposes output
  // metadata via outer rects when the workspace plugin reports them,
  // but for now we use a simple primary-output assumption -- a
  // multi-output config should call sdk.windows.get(id) and pull
  // outer from there, or extend the event to include the output rect).
  //
  // For step 1 of this example we use the surface's own outerRect to
  // derive "off-screen to the right" as outer.x + outer.width * 2:
  // start the window one-tile-width past its destination. Good
  // visual for typical master-stack tile sizes and avoids the
  // output-rect lookup entirely.

  // Strict gate-release pattern: when we receive a CREATED event,
  // set the presnap transform synchronously inside the interceptor
  // (so the first composite is at presnap, not identity), then
  // release the opening gate. The WM awaits the interceptor before
  // running pushStack; the opening-driver's gate is released as soon
  // as we call releaseOpeningGate -- by then the transform has
  // landed.
  sdk.events.intercept("window.relayout", async (_name, ev) => {
    const id = ev.surfaceId;
    const tiling = ev.tiling;

    // CREATED: set the initial transform/opacity so the window
    // appears mid-animation when it first composites.
    if (ev.oldOuter === null && ev.newOuter !== null) {
      try {
        if (tiling === "managed") {
          // Tiled: slide in from one tile-width to the right of the
          // destination. The slide distance is the window's own
          // width -- for a master-stack tile this is half the
          // output; for a single-window-full-output it's the full
          // output width.
          const slideX = ev.newOuter.width;
          await sdk.windows.setTransform(id,
            { translateX: slideX, translateY: 0, scaleX: 1, scaleY: 1 });
          await sdk.windows.releaseOpeningGate(id);
          void sdk.animations.run(tween(target.windowTransform(id), {
            from: { translateX: slideX, translateY: 0, scaleX: 1, scaleY: 1 },
            to:   { translateX: 0,      translateY: 0, scaleX: 1, scaleY: 1 },
            duration: DURATION_MS, easing: EASING,
          }));
        } else {
          // Floating: fade + scale-up from 90% so the window
          // appears in place rather than sliding from off-screen.
          // (A dialog at the center of the screen sliding from the
          // right would feel out of place.)
          await sdk.windows.setOpacity(id, 0);
          await sdk.windows.setTransform(id,
            { translateX: 0, translateY: 0, scaleX: 0.9, scaleY: 0.9 });
          await sdk.windows.releaseOpeningGate(id);
          void sdk.animations.run(tween(target.windowOpacity(id), {
            from: 0, to: 1,
            duration: DURATION_MS, easing: EASING,
          }));
          void sdk.animations.run(tween(target.windowTransform(id), {
            from: { translateX: 0, translateY: 0, scaleX: 0.9, scaleY: 0.9 },
            to:   { translateX: 0, translateY: 0, scaleX: 1.0, scaleY: 1.0 },
            duration: DURATION_MS, easing: EASING,
          }));
        }
      } catch (e) {
        try { await sdk.windows.releaseOpeningGate(id); } catch (_) { /* */ }
        sdk.log(`window-animations: CREATED setup failed for ${id}: ${e && e.message ? e.message : e}`);
      }
      return undefined;
    }

    // DESTROYED: animate the phantom (the closing-driver's snapshot
    // of the last visible state) out. The phantom is a separate
    // compositor surface with its own ID, distinct from the
    // already-gone original. After the animation completes we call
    // destroyPhantom to free the resources. sdk.animations.run
    // resolves when the tween settles, so awaiting in a fire-and-
    // forget chain gives us the completion callback.
    if (ev.newOuter === null && ev.oldOuter !== null && ev.phantomSurfaceId !== undefined) {
      const phantomId = ev.phantomSurfaceId;
      // Fire-and-forget the run-then-destroy chain so the interceptor
      // doesn't block the layout pass on the animation duration.
      void (async () => {
        try {
          if (tiling === "managed") {
            const slideX = ev.oldOuter.width;
            await sdk.animations.run(tween(target.windowTransform(phantomId), {
              from: { translateX: 0,      translateY: 0, scaleX: 1, scaleY: 1 },
              to:   { translateX: slideX, translateY: 0, scaleX: 1, scaleY: 1 },
              duration: DURATION_MS, easing: EASING,
            }));
          } else {
            await Promise.all([
              sdk.animations.run(tween(target.windowOpacity(phantomId), {
                from: 1, to: 0,
                duration: DURATION_MS, easing: EASING,
              })),
              sdk.animations.run(tween(target.windowTransform(phantomId), {
                from: { translateX: 0, translateY: 0, scaleX: 1.0, scaleY: 1.0 },
                to:   { translateX: 0, translateY: 0, scaleX: 0.9, scaleY: 0.9 },
                duration: DURATION_MS, easing: EASING,
              })),
            ]);
          }
        } catch (e) {
          sdk.log(`window-animations: DESTROYED anim threw for ${phantomId}: ${e && e.message ? e.message : e}`);
        } finally {
          // Always destroy the phantom so it doesn't leak. If the
          // closing-driver's 10s backstop fires before us that's a
          // no-op via the runtime's already-destroyed guard.
          try { await sdk.windows.destroyPhantom(phantomId); } catch (_) { /* */ }
        }
      })();
      return undefined;
    }

    // RETILED: rect changed (including cross-output moves -- the
    // rects are in compositor coords so a window moving from output
    // A to B animates the same as a window moving within one
    // output). Compensate visually with a presnap transform that
    // makes the surface look like it's still at oldOuter even
    // though its placement is now newOuter, then tween to identity.
    if (ev.oldOuter !== null && ev.newOuter !== null) {
      // Degenerate / no-change: skip.
      if (ev.oldOuter.x === ev.newOuter.x
          && ev.oldOuter.y === ev.newOuter.y
          && ev.oldOuter.width === ev.newOuter.width
          && ev.oldOuter.height === ev.newOuter.height) {
        return undefined;
      }
      const sx = ev.oldOuter.width / ev.newOuter.width;
      const sy = ev.oldOuter.height / ev.newOuter.height;
      const tx = ev.oldOuter.x - ev.newOuter.x;
      const ty = ev.oldOuter.y - ev.newOuter.y;
      try {
        await sdk.windows.setTransform(id,
          { translateX: tx, translateY: ty, scaleX: sx, scaleY: sy });
        void sdk.animations.run(tween(target.windowTransform(id), {
          from: { translateX: tx, translateY: ty, scaleX: sx, scaleY: sy },
          to:   { translateX: 0,  translateY: 0,  scaleX: 1,  scaleY: 1 },
          duration: DURATION_MS, easing: EASING,
        }));
      } catch (e) {
        sdk.log(`window-animations: RETILED setup failed for ${id}: ${e && e.message ? e.message : e}`);
      }
      return undefined;
    }

    // Anything else: observe-only (no animation we know how to
    // handle).
    return undefined;
  });
}
