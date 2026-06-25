// Window animation plugin example.
//
// Two animations, no flashing:
//
// 1. Map: the newly-appearing window slides in from the right edge of
//    its tile + fades from opacity 0. Implemented via the opening-driver
//    content gate: the plugin claims 'window-opening', receives the bus
//    event synchronously inside windowHasContent (BEFORE pushStack
//    would include the surface), sets the initial transform/opacity,
//    releases the gate, and starts the animation. The first composited
//    frame is already at translateX=width / opacity=0, so the user sees
//    no on-tile flash.
//
// 2. Retile: when an existing window's outer rect changes (because a
//    new window mapped, or one unmapped, or the layout's master
//    fraction changed), it animates from the OLD rect into the NEW
//    rect. Implemented via the existing window.relayout interceptor:
//    when the WM is about to push a new outer rect, the plugin
//    synchronously sets a compensating transform that visually keeps
//    the window at the OLD rect, then animates the transform toward
//    identity. The WM proceeds to push the new rect; the first
//    composite already has the transform applied, no flash.
//
// Both animations use sdk.animations.run with target.windowTransform /
// windowOpacity. The animation system handles cancel-on-replacement
// automatically (a second relayout during an in-flight animation
// preempts the first), so layout thrashing produces visually-smooth
// snap-to-latest behavior.

import { tween, target, easings } from "@overdraw/sdk-anim";

const MAP_DURATION_MS = 220;
const RETILE_DURATION_MS = 180;

export default async function init(sdk) {
  // Claim the 'window-opening' namespace. The runtime exposes this to
  // the opening-driver's hasPluginHandler() predicate; when true, the
  // driver engages the content gate at first-content commit and emits
  // window.opening on the plugin bus.
  await sdk.registerPlugin("window-opening", () => ({}));
  sdk.log("window-animations: opening + retile registered");

  // --- Map animation ----------------------------------------------------

  sdk.events.subscribe("window.opening", async (_name, ev) => {
    const id = ev.surfaceId;
    const w = ev.outerRect.width;
    try {
      // Set initial state synchronously: the surface is gated, so this
      // lands BEFORE the first composite that would include the
      // window. We slide in from translateX = +width (off the right
      // edge of the tile) and fade in from opacity 0.
      await sdk.windows.setTransform(id,
        { translateX: w, translateY: 0, scaleX: 1, scaleY: 1 });
      await sdk.windows.setOpacity(id, 0);

      // Release the gate. The next composite includes the surface at
      // the initial transform/opacity -- mid-animation from frame 0.
      await sdk.windows.releaseOpeningGate(id);

      // Animate to identity. Both run in parallel (separate target
      // kinds; the animations system runs them independently).
      void sdk.animations.run(tween(target.windowTransform(id), {
        from: { translateX: w, translateY: 0, scaleX: 1, scaleY: 1 },
        to:   { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
        duration: MAP_DURATION_MS,
        easing: easings.easeOut,
      }));
      void sdk.animations.run(tween(target.windowOpacity(id), {
        from: 0, to: 1,
        duration: MAP_DURATION_MS,
        easing: easings.easeOut,
      }));
    } catch (e) {
      // Plugin must not get stuck mid-gate or the backstop fires +
      // logs a warning. If our setup throws, release the gate so the
      // window appears (instantly, no animation).
      try { await sdk.windows.releaseOpeningGate(id); } catch (_) { /* nothing more we can do */ }
      sdk.log(`window-animations: map setup failed for ${id}: ${e && e.message ? e.message : e}`);
    }
  });

  // --- Retile animation -------------------------------------------------
  //
  // The window.relayout interceptor fires before the WM mutates a
  // mapped window's outer tile. oldOuter = current rect; newOuter =
  // the rect the WM is about to install. We can run side effects
  // (like setting a transform) inside the interceptor and the WM
  // awaits before proceeding. So:
  //
  //   1. Compute the pre-snap transform that visually keeps the
  //      window at oldOuter even though its placement is about to be
  //      newOuter:
  //         scaleX     = oldOuter.width  / newOuter.width
  //         scaleY     = oldOuter.height / newOuter.height
  //         translateX = oldOuter.x - newOuter.x   (px)
  //         translateY = oldOuter.y - newOuter.y   (px)
  //   2. setTransform(presnap) synchronously.
  //   3. Start the animation toward identity (fire-and-forget; the
  //      interceptor returns immediately).
  //   4. Return undefined (observe-only: keep newOuter as-is).

  sdk.events.intercept("window.relayout", async (_name, ev) => {
    const id = ev.surfaceId;
    // First-tile case: a window's oldOuter is the addWindow placeholder
    // (-1x-1) until its first layout. There's nothing to animate FROM
    // in that case, and the map animation handles first-appearance.
    // Skip the retile path for it.
    if (ev.oldOuter.width <= 0 || ev.oldOuter.height <= 0) return undefined;
    if (ev.newOuter.width <= 0 || ev.newOuter.height <= 0) return undefined;
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
      // Fire-and-forget animation toward identity. cancel-on-replacement
      // takes care of overlapping relayouts (a second one preempts).
      void sdk.animations.run(tween(target.windowTransform(id), {
        from: { translateX: tx, translateY: ty, scaleX: sx, scaleY: sy },
        to:   { translateX: 0,  translateY: 0,  scaleX: 1,  scaleY: 1 },
        duration: RETILE_DURATION_MS,
        easing: easings.easeOut,
      }));
    } catch (e) {
      sdk.log(`window-animations: retile setup failed for ${id}: ${e && e.message ? e.message : e}`);
    }
    return undefined;  // observe-only; don't redirect newOuter
  });
}
