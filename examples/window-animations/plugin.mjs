// Window animation plugin example.
//
// Two animations, run in lockstep so the seam between shrinking
// existing windows and the sliding-in new window stays continuous:
//
// 1. Map: the newly-appearing window slides in from outside the
//    output's right edge. Specifically translateX_start is chosen so
//    AT t=0 the window's LEFT edge sits at the output's right edge;
//    as the animation runs, the window's left edge tracks the
//    existing tiles' shrinking right edge. Implemented via the
//    opening-driver content gate: the plugin claims 'window-opening',
//    receives the window.opening bus event synchronously inside
//    windowHasContent (BEFORE pushStack would include the surface),
//    sets the initial transform, releases the gate, and starts the
//    animation. The first composited frame is already at
//    translateX=slideX -- no on-tile flash.
//
// 2. Retile: when an existing window's outer rect changes, it
//    animates from oldOuter to newOuter. Implemented via the existing
//    window.relayout interceptor: the WM awaits the interceptor
//    before pushing the new rect, so the plugin's synchronous
//    setTransform with a compensating (oldOuter - newOuter)
//    transform lands first; the very first composite at the new
//    placement shows the window visually still at oldOuter, and the
//    animation moves it to newOuter.
//
// Both use the same DURATION_MS and EASING so the seam is
// continuous. Both surfaces of a decorated window (content +
// decoration) move together because the broker's setTransform is
// group-aware (windows-broker resolves the window group and applies
// the same transform to every member surface).
//
// No opacity fade -- a window's content + decoration surfaces
// composite independently, so an alpha tween on each produces
// incorrect mid-animation math. The slide is sufficient visually and
// composes correctly.

import { tween, target, easings } from "@overdraw/sdk-anim";

// Both animations MUST share duration + easing. The retile animation
// shrinks an existing window's visible rect from oldOuter -> newOuter
// while the new window slides in from outside the output. The two
// animations meet at the seam between tiles; if they run at different
// speeds, the user briefly sees a gap (or worse, an overlap of one
// window's content over another's). Same duration + same easing keeps
// the seam continuous throughout the animation.
const DURATION_MS = 200;
const EASING = easings.easeOut;

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
    // Slide the new window in so that AT t=0 its LEFT edge sits
    // exactly at the output's right edge. As the existing windows
    // shrink (retile path) and free up the new window's tile, the
    // new window's left edge tracks the existing windows' right
    // edge -- there's no gap (the seam between tiles stays
    // continuous) and no overlap (the new window never reaches into
    // a tile that's still owned by another window).
    //
    // translateX_start = outputRect.right - outerRect.x
    //                  = (outputRect.x + outputRect.width) - outerRect.x
    const slideX = (ev.outputRect.x + ev.outputRect.width) - ev.outerRect.x;
    try {
      // Set initial transform synchronously. The surface is gated, so
      // this lands BEFORE the first composite would include the
      // window. No opacity fade -- decoration + content are two
      // independently-composited surfaces; an alpha tween on each
      // produces incorrect mid-animation alpha math (see the design
      // discussion). The slide alone gives a clean appearance and
      // composes correctly with the decoration surface tracking the
      // content via the broker's group-aware setTransform.
      await sdk.windows.setTransform(id,
        { translateX: slideX, translateY: 0, scaleX: 1, scaleY: 1 });

      // Release the gate. The next composite includes the surface at
      // the initial transform -- mid-slide from frame 0.
      await sdk.windows.releaseOpeningGate(id);

      // Animate to identity. Fire-and-forget; the animation runs on
      // the compositor's frame tick.
      void sdk.animations.run(tween(target.windowTransform(id), {
        from: { translateX: slideX, translateY: 0, scaleX: 1, scaleY: 1 },
        to:   { translateX: 0,      translateY: 0, scaleX: 1, scaleY: 1 },
        duration: DURATION_MS,
        easing: EASING,
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
      // Fire-and-forget animation toward identity. Same duration +
      // easing as the map animation so the seam between the
      // shrinking-existing and sliding-in-new windows stays
      // continuous throughout the transition. cancel-on-replacement
      // takes care of overlapping relayouts (a second one preempts).
      void sdk.animations.run(tween(target.windowTransform(id), {
        from: { translateX: tx, translateY: ty, scaleX: sx, scaleY: sy },
        to:   { translateX: 0,  translateY: 0,  scaleX: 1,  scaleY: 1 },
        duration: DURATION_MS,
        easing: EASING,
      }));
    } catch (e) {
      sdk.log(`window-animations: retile setup failed for ${id}: ${e && e.message ? e.message : e}`);
    }
    return undefined;  // observe-only; don't redirect newOuter
  });
}
