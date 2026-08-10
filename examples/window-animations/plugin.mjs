// Custom window-animation plugin example: how to REPLACE the bundled
// @overdraw/plugin-animations-default with your own animation policy.
//
// The bundled plugin claims three namespaces at the priority floor (0);
// a user plugin claiming the same namespaces (default priority 100)
// displaces it per namespace -- the displaced claim's activation never
// runs, so it registers no handlers and nothing double-animates. Claim
// only the seams you want to own; the bundled plugin keeps the rest:
//
//   window-opening    OPEN: window.opening fires at first content with
//                     the opening gate engaged (the window is held out
//                     of the draw stack until releaseOpeningGate).
//                     Claiming this namespace is what activates the
//                     opening driver at all.
//   window-closing    CLOSE: window.closing carries a phantom minted
//                     from the window's last visible state; animate it
//                     and destroyPhantom when done. Claiming activates
//                     the driver.
//   window-animations GEOMETRY: window.relayout (immediate retiles),
//                     stack.relayout-apply (transaction-held retiles
//                     landing), layer.resize-announce + layer.relayout
//                     (the two-phase layer-resize glide). Register
//                     these ONLY inside this claim's activation --
//                     bare subscriptions don't participate in
//                     displacement and would run alongside the bundled
//                     plugin's.
//
// For taste-only changes (durations, easings, disabling), skip this
// file entirely and set the `animations` config slice instead.
//
// sdk.animations.start(spec) resolves once core has registered the
// animation and applied its `from` value, so awaiting it is the ordering
// primitive: the start value is live before the gate releases / the
// emitting seam proceeds. compose:"relative" folds a tween's `from` onto
// the target's current value, so rapid retargets chase continuously.

import { tween, target, easings } from "@overdraw/sdk-anim";

const DURATION_MS = 200;
const EASING = easings.easeOut;
const IDENT = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 };

// Slide distance for a tiled window: one tile-width toward/away from the
// output edge NEAREST the tile.
function nearestEdgeSlideX(rect, outputRect) {
  const tileCenter = rect.x + rect.width / 2;
  const outCenter = outputRect.x + outputRect.width / 2;
  return tileCenter < outCenter ? -rect.width : rect.width;
}

export default async function init(sdk) {
  // OPEN: this example slides every window in from the nearest edge,
  // tiled or floating (the bundled default fades floating windows).
  await sdk.registerPlugin("window-opening", () => {
    sdk.events.intercept("window.opening", async (_name, ev) => {
      const id = ev.surfaceId;
      try {
        const slideX = nearestEdgeSlideX(ev.outerRect, ev.outputRect);
        await sdk.animations.start(tween(target.windowTransform(id), {
          from: { ...IDENT, translateX: slideX },
          to: IDENT,
          duration: DURATION_MS, easing: EASING,
        }));
      } finally {
        try { await sdk.windows.releaseOpeningGate(id); } catch (_) { /* */ }
      }
      return undefined;
    });
    return {};
  });

  // CLOSE: fade every phantom out.
  await sdk.registerPlugin("window-closing", () => {
    sdk.events.subscribe("window.closing", async (_name, ev) => {
      const phantomId = ev.phantomSurfaceId;
      try {
        await sdk.animations.run(tween(target.windowOpacity(phantomId), {
          from: 1, to: 0, duration: DURATION_MS, easing: EASING,
        }));
      } finally {
        try { await sdk.windows.destroyPhantom(phantomId); } catch (_) { /* */ }
      }
    });
    return {};
  });

  // GEOMETRY: presnap retiles; glide layer resizes. Registered inside
  // the claim's activation so a displaced (or displacing) plugin never
  // stacks handlers.
  await sdk.registerPlugin("window-animations", () => {
    async function presnap(surfaceId, oldOuter, newOuter) {
      if (oldOuter.x === newOuter.x && oldOuter.y === newOuter.y
          && oldOuter.width === newOuter.width && oldOuter.height === newOuter.height) {
        return;
      }
      await sdk.animations.start(tween(target.windowTransform(surfaceId), {
        from: {
          translateX: oldOuter.x - newOuter.x,
          translateY: oldOuter.y - newOuter.y,
          scaleX: oldOuter.width / newOuter.width,
          scaleY: oldOuter.height / newOuter.height,
        },
        to: IDENT,
        duration: DURATION_MS, easing: EASING,
        compose: "relative",
      }));
    }

    // Immediate retiles. Reorder / param-changed geometry is HELD by the
    // WM's resize transaction and animates from stack.relayout-apply
    // when it lands (a presnap at announce time would displace a surface
    // still showing its old rect).
    sdk.events.intercept("window.relayout", async (_name, ev) => {
      if (ev.oldOuter === null || ev.newOuter === null) return undefined;
      if (ev.reason === "reorder" || ev.reason === "param-changed") return undefined;
      await presnap(ev.surfaceId, ev.oldOuter, ev.newOuter);
      return undefined;
    });
    sdk.events.intercept("stack.relayout-apply", async (_name, ev) => {
      const wins = Array.isArray(ev?.windows) ? ev.windows : [];
      await Promise.all(wins.map((w) => presnap(w.surfaceId, w.oldOuter, w.newOuter)));
      return undefined;
    });

    // Layer glide, two phases: start toward the announced rect before
    // the client renders (keeps the frame in phase with the buffers, so
    // text draws near 1:1); re-base onto the new rect when the buffer
    // lands.
    sdk.events.subscribe("layer.resize-announce", async (_name, ev) => {
      const o = ev.fromRect, n = ev.toRect;
      if (!o || !n || o.width <= 0 || o.height <= 0) return;
      await sdk.animations.start(tween(target.windowTransform(ev.surfaceId), {
        from: IDENT,   // composes to the current value
        to: {
          translateX: n.x - o.x, translateY: n.y - o.y,
          scaleX: n.width / o.width, scaleY: n.height / o.height,
        },
        duration: 380, easing: { kind: "cubic-bezier", x1: 0.23, y1: 1, x2: 0.32, y2: 1 },
        compose: "relative",
      }));
    });
    sdk.events.intercept("layer.relayout", async (_name, ev) => {
      const o = ev.oldRect, n = ev.newRect;
      if (!o || !n || n.width <= 0 || n.height <= 0) return undefined;
      await sdk.animations.start(tween(target.windowTransform(ev.surfaceId), {
        from: {
          translateX: o.x - n.x, translateY: o.y - n.y,
          scaleX: o.width / n.width, scaleY: o.height / n.height,
        },
        to: IDENT,
        duration: 380, easing: { kind: "cubic-bezier", x1: 0.23, y1: 1, x2: 0.32, y2: 1 },
        compose: "relative",
      }));
      return undefined;
    });

    return {};
  });

  sdk.log("window-animations example: registered (displacing the bundled default)");
}
