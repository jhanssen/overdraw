// Bundled decoration plugin: a rounded-corner border, paced by the
// intercept render callback (one render per visible frame of every
// decorated window).
//
// Architecture (decoration-as-intercept.md):
//   - Registers an INTERCEPT (priority 10 = fallback; user effects at
//     priority 0 outrank it for narrower patterns). On match, calls
//     sdk.windows.setInsets to reserve a B-pixel band around the
//     window's outer tile; the WM shrinks the content rect by B so the
//     client commits at the smaller content size on the first sized
//     configure.
//   - outputDimensions returns inputW + 2*B, inputH + 2*B. The output
//     texture replaces the client texture in-place at the WM outer
//     rect; no outputRect override (subsurfaces continue to anchor to
//     the toplevel's WM placement).
//   - Each render runs two passes into the output texture:
//       pass 1 fills the FULL output with the gradient/solid border;
//       pass 2 blits the client INPUT into the inset [B,B]+(inputW x
//         inputH) region, with antialiased inner-shape coverage (the
//         rounded-corner cutouts show through to the band underneath).
//   - The outer shape (rounded perimeter) is applied via the
//     compositor's setShape on the combined output texture.
//   - gates:true holds the window out of the draw stack until the plugin
//     calls releaseGate() (on ctx.contentReady -- the client committed at
//     the configured size), so it never appears undecorated or wrong-sized.
//   - Focus styling reads ctx.activated live each render (level-
//     triggered), so the focused vs. unfocused fill always reflects
//     current keyboard focus. The focus-causing input wakes the frame
//     the change lands on; reading current state (not a cached edge)
//     is what lets a static window -- one that never commits again --
//     reflect the change on that frame.

import type { PluginSdkShape } from "@overdraw/plugin-sdk-types";

import {
  validateConfig, encodeShape, insetShape, scaleShape,
  type ResolvedFill,
} from "./config.js";
import {
  createDecorationPipeline, createDecorationDraw, destroyDecorationDraw,
  writeBorderUniforms, writeBlitUniforms, encodeFrame,
  type DecorationDraw,
} from "./render.js";

interface PerWindow {
  draw: DecorationDraw;
  // Cached fill so writeBorderUniforms only runs when the surface size
  // or focus state changes (not on every frame). Focus is read live from
  // ctx.activated each render; a change flips fill, which diverges from
  // lastFill and drives the re-render.
  lastFill: ResolvedFill | null;
  lastOutputW: number;
  lastOutputH: number;
  // Cached inner-shape parameters so writeBlitUniforms only runs when
  // the input dims change.
  lastInputW: number;
  lastInputH: number;
  // Cached buffer dims + content offset (the blit's uv sub-rect inputs), so
  // writeBlitUniforms reruns when the client's buffer size or window-geometry
  // offset changes even if the content extent stayed the same.
  lastBufferW: number;
  lastBufferH: number;
  lastContentX: number;
  lastContentY: number;
  // The surfaceRect this window was last RENDERED at (placement). Used with
  // the caches above to skip re-rendering when nothing changed.
  lastSurfaceRect: { x: number; y: number; w: number; h: number } | null;
  // The client's buffer-px-per-logical-px factor this window last rendered
  // at, plus the shape parameters computed for it (band thickness and radii
  // live in ring pixels, so they scale with the client's buffer density).
  lastScale: number;
  innerParams: ReturnType<typeof encodeShape>;
  // True once the content gate has been released. We only skip rendering after
  // release; before that, every tick must render to drive the release.
  released: boolean;
}

export default async function init(sdk: PluginSdkShape, rawConfig?: unknown): Promise<void> {
  const config = validateConfig(rawConfig);
  if (!sdk.gpu || !sdk.intercept) {
    throw new Error(
      "decoration-default: requires sdk.gpu + sdk.intercept -- the GPU "
      + "subsystem and the intercept namespace must be wired in this "
      + "configuration",
    );
  }
  const gpu = sdk.gpu;
  const windowsSdk = sdk.windows;
  const interceptSdk = sdk.intercept;

  const pipeline = createDecorationPipeline(gpu.device);
  const perWindow = new Map<number, PerWindow>();

  const B = config.borderWidth;
  // The band is declared in LOGICAL pixels but drawn in ring (buffer)
  // pixels; a fractional-scale client's ring is denser than logical, so
  // the drawn thickness scales by the client's buffer-px-per-logical-px
  // factor (ctx.inputScale) to display at the intended logical size.
  const ringBorder = (s: number): number =>
    B === 0 ? 0 : Math.max(1, Math.round(B * s));
  // Inner shape parameters for one scale factor: the OUTER shape (logical)
  // expressed in ring pixels, shrunk by the ring-pixel band.
  const innerParamsFor = (s: number): ReturnType<typeof encodeShape> =>
    encodeShape(insetShape(scaleShape(config.outerShape, s), ringBorder(s)));

  await interceptSdk.register({
    name: "decoration-default",
    match: {
      appId: { source: config.appIdPattern, flags: config.appIdFlags ?? "" },
      roles: ["toplevel"],
    },
    // Lower priority than user effects (default 0). The bundled plugin
    // is a fallback: a Firefox-specific blur (priority 0, narrow pattern)
    // claims Firefox, decoration claims everything else.
    priority: 10,
    // Hold each matched window out of the draw stack until the plugin
    // calls releaseGate() inside a render whose input dims match the
    // expected post-insets content size. Closes the wrong-size-frame race
    // in the late-match catch-up case (plugin hot-reload, user toggle,
    // priority re-evaluation).
    gates: true,
    setup: () => {
      // Each matched window's output ring extends the client content by the
      // ring-pixel band on every axis, so the ring holds the band plus the
      // content at the client's buffer density.
      return {
        outputDimensions: (inputW, inputH, inputScale) => ({
          w: inputW + 2 * ringBorder(inputScale),
          h: inputH + 2 * ringBorder(inputScale),
        }),
        onSurfaceMatched: (info) => {
          // Reserve insets BEFORE the WM's first sized configure goes
          // out (when matched at window.preconfigure; see broker.ts).
          // For late-match catch-up, the configure already went out at
          // the wrong size; setInsets here triggers a relayout +
          // reconfigure and the gate holds the window out of the draw
          // stack until the client re-commits at the right size.
          void windowsSdk.setInsets(info.surfaceId, {
            top: B, right: B, bottom: B, left: B,
          }).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            sdk.log(`decoration-default: setInsets failed for ${info.surfaceId}: ${msg}`);
          });
          // Apply the OUTER shape to the combined output texture: the
          // compositor's setShape clips the perimeter after the intercept
          // output is sampled. Skip when null (sharp rectangle); the
          // compositor's default is rectangle.
          if (config.outerShape !== null) {
            void windowsSdk.setShape(info.surfaceId, config.outerShape)
              .catch((e: unknown) => {
                const msg = e instanceof Error ? e.message : String(e);
                sdk.log(`decoration-default: setShape failed for ${info.surfaceId}: ${msg}`);
              });
          }
          // Allocate per-window GPU state. The draw struct's uniform
          // buffers are populated on the first render (we don't know the
          // input dims yet at match time -- they arrive on the first
          // render call after the client commits).
          const w: PerWindow = {
            draw: createDecorationDraw(pipeline),
            lastFill: null,
            lastOutputW: 0,
            lastOutputH: 0,
            lastInputW: 0,
            lastInputH: 0,
            lastBufferW: 0,
            lastBufferH: 0,
            lastContentX: 0,
            lastContentY: 0,
            lastSurfaceRect: null,
            lastScale: 0,   // 0 never matches a real scale; first render computes
            innerParams: encodeShape(null),
            released: false,
          };
          perWindow.set(info.surfaceId, w);
        },
        onSurfaceUnmatched: (info) => {
          const w = perWindow.get(info.surfaceId);
          if (!w) return;
          destroyDecorationDraw(w.draw);
          perWindow.delete(info.surfaceId);
          // Reset the window's outer shape so a future intercept can
          // start from a known state. The setShape call may race a
          // teardown-in-progress; swallow the error.
          if (config.outerShape !== null) {
            void windowsSdk.setShape(info.surfaceId, null)
              .catch(() => { /* race; ignore */ });
          }
        },
        render: ({ input, output, ctx }) => {
          const w = perWindow.get(ctx.surfaceId);
          if (!w) return;   // defensive: matched dispatched before our handler installed
          const outputW = output.rect.w;
          const outputH = output.rect.h;
          // input.rect is the CONTENT sub-rect (window geometry) within the
          // buffer texture; the band wraps that, and the blit samples only that
          // sub-region -- so a CSD client's transparent shadow margin (buffer
          // beyond the window) is excluded.
          const inputW = input.rect.w;
          const inputH = input.rect.h;
          const bufferW = input.texture.width;
          const bufferH = input.texture.height;
          const contentX = input.rect.x;
          const contentY = input.rect.y;
          const scale = ctx.inputScale;
          const fill: ResolvedFill = ctx.activated ? config.focused : config.unfocused;
          const sr = ctx.surfaceRect;

          // Release the gate once the client has committed at the configured
          // size (ctx.contentReady), so the window enters the draw stack with a
          // correctly-sized decorated frame rather than a stretched late-match
          // one. Read it here -- before any render decision -- so a static
          // window doesn't have to keep rendering just to poll this flag.
          if (!w.released && ctx.contentReady) {
            ctx.releaseGate();
            w.released = true;
          }

          // Static effect: skip re-rendering when nothing this render depends on
          // has changed -- client content (ctx.contentChanged), focus (fill),
          // ring dims, or placement (surfaceRect). Returning false keeps the
          // previously-installed output and lets the compositor's dirty gate
          // skip recompositing, so an idle decorated window costs ~0 GPU. This
          // is independent of the gate: a window whose content never reaches the
          // configured size (contentReady stays false) but is otherwise idle
          // must still stop rendering -- re-blitting an identical frame every
          // vblank achieves nothing. The first tick always renders
          // (lastSurfaceRect === null), producing the initial decoration.
          const rectUnchanged = w.lastSurfaceRect !== null
            && w.lastSurfaceRect.x === sr.x && w.lastSurfaceRect.y === sr.y
            && w.lastSurfaceRect.w === sr.w && w.lastSurfaceRect.h === sr.h;
          const willSkip = !ctx.contentChanged && fill === w.lastFill && rectUnchanged
              && outputW === w.lastOutputW && outputH === w.lastOutputH
              && inputW === w.lastInputW && inputH === w.lastInputH
              && scale === w.lastScale;
          if (willSkip) {
            return false;
          }

          // The blit uniforms now carry the border gradient + output size too,
          // so they must be rewritten whenever the border inputs change, not
          // only on an input-dim change.
          const borderChanged = outputW !== w.lastOutputW || outputH !== w.lastOutputH
            || fill !== w.lastFill;
          const inputChanged = inputW !== w.lastInputW || inputH !== w.lastInputH
            || bufferW !== w.lastBufferW || bufferH !== w.lastBufferH
            || contentX !== w.lastContentX || contentY !== w.lastContentY
            || scale !== w.lastScale;
          if (scale !== w.lastScale) {
            w.innerParams = innerParamsFor(scale);
          }
          if (borderChanged) {
            writeBorderUniforms(pipeline.device, w.draw, outputW, outputH, fill);
          }
          if (borderChanged || inputChanged) {
            writeBlitUniforms(pipeline.device, w.draw,
              outputW, outputH, inputW, inputH, bufferW, bufferH,
              contentX, contentY, ringBorder(scale), w.innerParams, fill);
          }
          w.lastOutputW = outputW;
          w.lastOutputH = outputH;
          w.lastFill = fill;
          w.lastInputW = inputW;
          w.lastInputH = inputH;
          w.lastBufferW = bufferW;
          w.lastBufferH = bufferH;
          w.lastContentX = contentX;
          w.lastContentY = contentY;
          w.lastScale = scale;

          encodeFrame(pipeline, w.draw, output.texture.createView(), input.texture);

          // Record what we rendered at, so the next tick can skip if unchanged.
          w.lastSurfaceRect = { x: sr.x, y: sr.y, w: sr.w, h: sr.h };

          // The output texture is sized to the WM outer rect (=
          // content + 2*B on each side). The compositor's default
          // placement for this surface is the content rect; without
          // an outputRect override the output would scale into the
          // content rect (= distorted, no visible band). Returning an
          // outputRect that EXPANDS the placement to the outer rect
          // is correct here: subsurfaces position via win.rect (the
          // content rect) in the WM, not via the toplevel's
          // compositor placement, so shifting the toplevel's draw
          // to the outer rect does not affect subsurface placement.
          return {
            outputRect: {
              x: ctx.surfaceRect.x - B,
              y: ctx.surfaceRect.y - B,
              w: ctx.surfaceRect.w + 2 * B,
              h: ctx.surfaceRect.h + 2 * B,
            },
          };
        },
        destroy: () => {
          for (const [, w] of perWindow) destroyDecorationDraw(w.draw);
          perWindow.clear();
        },
      };
    },
  });
  sdk.log(`decoration-default: intercept registered (pattern=${JSON.stringify(config.appIdPattern)}`
    + `, border=${B}, shape=${JSON.stringify(config.outerShape)})`);
}
