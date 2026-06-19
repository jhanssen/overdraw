// JS compositor: the per-output compositing pass, in core main-thread JS, over
// the Dawn wire (via a wire-retargeted dawn.node GPUDevice). architecture.md
// calls this "the core's per-output frame loop / compositing renderer."
//
// shm surfaces upload via queue.writeTexture from a zero-copy ArrayBuffer over
// the client shm mapping (addon.shmView); dmabuf surfaces import via the GPU
// process and arrive as wire texture handles wrapped on this device.
//
// Two render targets: an owned offscreen target (read back via readback())
// and per-output addon-acquired textures (KMS scanout slots OR a nested-host
// swapchain texture, acquired + presented per frame via addon.acquireOutput
// Texture / presentOutput). Constructor picks via JsCompositorOpts.headless.
// "Headless" here is a JS-compositor concern: own + render into an offscreen
// target with readback. It is independent of the addon's backend choice
// (`kms` vs `nested`), both of which drive the addon-acquired path.
//
// WebGPU objects come from dawn.node and conform to the standard JS API; the
// types are @webgpu/types (GPUDevice/GPUTexture/...).

// The per-surface compositing shader. A unit quad is placed into the surface's
// normalized output rect, optionally translated/scaled, optionally extended
// outward by outputMargin, then textured and modulated by an alpha mask.
//
// Uniform layout (one vec4 per slot, std140-aligned):
//   placement   (vec4):     x, y, w, h          -- normalized [0,1] output space
//   transform   (vec4):     tx, ty, sx, sy      -- translate (normalized), scale (unitless)
//   margin      (vec4):     top, right, bottom, left  -- normalized output px
//   fx          (vec4):     opacity, _, _, _
//   cropUV      (vec4):     u0, v0, u1, v1      -- surface-texture UV range to sample
//   tint        (vec4):     r, g, b, a          -- per-channel multiplier; identity = (1,1,1,1)
//   colorMatrix (mat4x4f):  4 column vectors    -- applied to sampled rgba; identity by default
//
// transform.scale anchors at the placement's top-left; an animation wanting
// center-anchored scale composes that as translate + scale + counter-translate
// in the plugin-side spec builder.
//
// cropUV selects a sub-rect of the surface texture to sample as the surface's
// pixels. Identity is (0,0,1,1) -- sample the full texture (the on-screen
// default). compose.windows uses non-identity cropUV when its caller passes
// a source-crop rect: the crop's surface-local pixel coords are normalized
// into UV and packed here, so the (cropped) region fills the rendered surface.
//
// tint + colorMatrix operate on the SAMPLED premultiplied RGBA -- the bytes
// the client commits are already premultiplied, and the existing
// coverage/alpha modulation (inside * mAlpha * opacity) is a scalar applied
// after. Identity is tint = (1,1,1,1) and colorMatrix = identity (no change).
// Order: surf = textureSample(...); surf = colorMatrix * surf; surf = surf * tint;
// then multiply by inside * mAlpha * opacity. Common cases:
//   - Saturation / brightness / contrast / hue rotation -> colorMatrix.
//   - Per-channel scale (dim red channel, etc.) -> tint.
//   - Workspace inactive dim: tint = (0.5, 0.5, 0.5, 1).
// Effects that need to read neighbor pixels (blur, distortion) are not
// expressible here -- they're for the buffer-intercept path (Phase 10).
//
// outputMargin reserves canvas around the surface's nominal rect. The mask
// is sampled across the FULL expanded region (margin included) and its alpha
// modulates the surface's alpha (and premultiplied rgb). The surface texture
// itself is only sampled inside [0,1] surface-UV; outside it contributes
// transparent black. Common cases:
//   - No mask, no margin: surface renders unchanged (default mask is 1x1 white).
//   - Rounded corners: mask = corner-alpha texture in [0,1] UV; margin = 0.
//   - Soft-edged rounded corners: same, but with a small margin so the soft
//     edge fades into the reserved region.
//   - Colored shadows / glows: NOT served by mask alone (mask is alpha-only);
//     use a decoration surface for the color and mask it on its own.
const WGSL = `
struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) surfUV : vec2f,
  @location(1) maskUV : vec2f,
};
struct Uniforms {
  placement   : vec4f,
  transform   : vec4f,
  margin      : vec4f,
  fx          : vec4f,
  cropUV      : vec4f,
  tint        : vec4f,
  colorMatrix : mat4x4f,
  // Per-surface shape. .x = kind (0=rect / 1=rounded-rect uniform /
  // 2=rounded-rect per-corner / 3=superellipse); .y = surface logical width
  // (px) the SDF eval works against; .z = surface logical height (px);
  // .w = uniform corner radius (px) when kind=1, superellipse outer radius
  // (px) when kind=3, unused when kind=0/2.
  shape       : vec4f,
  // kind=2 (per-corner): tl, tr, br, bl radii in px.
  // kind=3 (superellipse): .x = exponent (>= 2), .yzw unused.
  // kind=0/1: unused.
  shapeExtra  : vec4f,
};
@group(0) @binding(2) var<uniform> u : Uniforms;
@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  // qExt corners in surface-local UV space, EXPANDED by per-edge margins.
  // With zero margins this is exactly [0,1]x[0,1]. Triangle-strip order:
  // (0,1) (1,1) (0,0) (1,0).
  let mL = u.margin.w; let mR = u.margin.y;
  let mT = u.margin.x; let mB = u.margin.z;
  var qExt = array<vec2f, 4>(
    vec2f(-mL, 1.0 + mB),
    vec2f(1.0 + mR, 1.0 + mB),
    vec2f(-mL, -mT),
    vec2f(1.0 + mR, -mT));

  let surfUV = qExt[i];
  // Mask UV: remap qExt [-mL, 1+mR] x [-mT, 1+mB] to [0,1] x [0,1].
  let wTotal = 1.0 + mL + mR;
  let hTotal = 1.0 + mT + mB;
  let maskUV = vec2f((surfUV.x + mL) / wTotal, (surfUV.y + mT) / hTotal);

  // Place the (possibly margin-expanded) UV into the surface's output rect,
  // then apply transform: scale around the placement origin, then translate.
  let scaled = qExt[i] * vec2f(u.transform.z, u.transform.w);
  let placed = u.placement.xy + u.transform.xy + scaled * u.placement.zw;
  let ndc = vec2f(placed.x * 2.0 - 1.0, 1.0 - placed.y * 2.0);

  var o : VsOut;
  o.pos = vec4f(ndc, 0.0, 1.0);
  o.surfUV = surfUV;
  o.maskUV = maskUV;
  return o;
}
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(3) var maskSamp : sampler;
@group(0) @binding(4) var maskTex : texture_2d<f32>;
// Signed distance to an axis-aligned rounded rectangle centered at the origin
// with half-extents \`he\` and corner radius \`r\`. Negative inside, positive
// outside; |grad| = 1 wherever the field is smooth. Standard rounded-rect SDF.
fn sdfRoundedRect(p : vec2f, he : vec2f, r : f32) -> f32 {
  let q = abs(p) - he + vec2f(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}

// Per-corner rounded rect: pick the radius for the quadrant \`p\` falls into,
// then evaluate the same SDF in that quadrant only. Radii order is
// (tl, tr, br, bl). p.x<0 is left half; p.y<0 is top half.
fn sdfRoundedRectPerCorner(p : vec2f, he : vec2f,
                           tl : f32, tr : f32, br : f32, bl : f32) -> f32 {
  var r : f32 = 0.0;
  if (p.x < 0.0) { if (p.y < 0.0) { r = tl; } else { r = bl; } }
  else           { if (p.y < 0.0) { r = tr; } else { r = br; } }
  return sdfRoundedRect(p, he, r);
}

// Signed distance to a superellipse |x/a|^n + |y/b|^n = 1, approximated as
// (R(p) - 1) * min(a, b), where R(p) = (|x/a|^n + |y/b|^n)^(1/n). The factor
// makes the field roughly unit-scaled near the boundary, so the smoothstep
// AA width below has the same look as for the other shapes. Negative inside,
// positive outside. \`he\` are the half-extents (a, b); \`n\` is the exponent
// (n=2 -> ellipse; n=4..6 -> macOS-like squircle; n -> inf approaches rect).
// Guards against n < 2 by clamping (n < 2 gives concave shapes that are not
// the intended use).
fn sdfSuperellipse(p : vec2f, he : vec2f, n : f32) -> f32 {
  let exp = max(n, 2.0);
  let ax = abs(p.x) / max(he.x, 1e-5);
  let ay = abs(p.y) / max(he.y, 1e-5);
  let r = pow(pow(ax, exp) + pow(ay, exp), 1.0 / exp);
  let scale = min(he.x, he.y);
  return (r - 1.0) * scale;
}

// Convert a signed-distance value into [0,1] coverage with ~1px wide
// smoothstep anti-aliasing (the SDFs above have |grad| ~ 1 so the smoothstep
// width is in the same units the SDF returns -- logical pixels).
fn sdfCoverage(d : f32) -> f32 {
  return 1.0 - smoothstep(-0.5, 0.5, d);
}

// Evaluate the per-surface shape SDF and return [0,1] coverage. \`uv\` is the
// surfUV inside [0,1]; positions outside that range are caller-handled (the
// margin band gets coverage from the existing \`inside\` step). Kind 0 returns
// 1.0 (rect; the early-out keeps the common case cheap).
fn shapeCoverage(uv : vec2f, kind : u32,
                 sizePx : vec2f, r : f32, extra : vec4f) -> f32 {
  if (kind == 0u) { return 1.0; }
  let p  = (uv - vec2f(0.5)) * sizePx;
  let he = sizePx * 0.5;
  if (kind == 1u) {
    return sdfCoverage(sdfRoundedRect(p, he, r));
  }
  if (kind == 2u) {
    return sdfCoverage(
      sdfRoundedRectPerCorner(p, he, extra.x, extra.y, extra.z, extra.w));
  }
  if (kind == 3u) {
    return sdfCoverage(sdfSuperellipse(p, he, extra.x));
  }
  return 1.0;
}

// Undo a wl_surface buffer transform: map a surface-space [0,1] coordinate to
// the buffer-space coordinate to sample. Codes are the wl_output.transform
// enum (0 normal, 1 90, 2 180, 3 270, 4 flipped, 5..7 flipped+rotated). Axis-
// aligned, so this is swap/negate only (no resampling).
fn applyBufferTransform(uv : vec2f, t : f32) -> vec2f {
  let u = uv.x; let v = uv.y;
  if (t < 0.5)      { return vec2f(u, v); }              // normal
  else if (t < 1.5) { return vec2f(v, 1.0 - u); }        // 90
  else if (t < 2.5) { return vec2f(1.0 - u, 1.0 - v); }  // 180
  else if (t < 3.5) { return vec2f(1.0 - v, u); }        // 270
  else if (t < 4.5) { return vec2f(1.0 - u, v); }        // flipped
  else if (t < 5.5) { return vec2f(v, u); }              // flipped_90
  else if (t < 6.5) { return vec2f(u, 1.0 - v); }        // flipped_180
  else              { return vec2f(1.0 - v, 1.0 - u); }  // flipped_270
}
@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  // Mask is always sampled (the default mask is 1x1 white, so this is a no-op
  // when the plugin hasn't installed one). The alpha channel is the mask
  // value; opaque-white = 1.0, transparent = 0.0.
  let mAlpha = textureSample(maskTex, maskSamp, in.maskUV).a;

  // The surface texture is only meaningful in [0,1] UV; outside (the margin
  // region) it must contribute nothing. WGSL requires uniform control flow
  // around textureSample, so we sample unconditionally with explicit LOD
  // (textureSampleLevel) and multiply by an inside-rect mask computed from
  // the interpolated UV. The sampled value at clamp-edges is harmless
  // because we zero it via the inside multiplier below.
  //
  // surfUV addresses the surface's nominal [0,1] region; cropUV remaps that
  // into the actual texture coords to sample (compose.windows uses this to
  // render a sub-region of a surface). Default cropUV = (0,0,1,1) =
  // identity (sample the full texture).
  // Reorient the surface coordinate into buffer space (set_buffer_transform),
  // then crop. transform-alone (identity crop) and crop-alone (identity
  // transform = normal) each reduce to the obvious case.
  let tuv = applyBufferTransform(in.surfUV, u.fx.y);
  let sampleUV = mix(u.cropUV.xy, u.cropUV.zw, tuv);
  var surf = textureSampleLevel(tex, samp, sampleUV, 0.0);
  let inside = step(0.0, in.surfUV.x) * step(in.surfUV.x, 1.0)
             * step(0.0, in.surfUV.y) * step(in.surfUV.y, 1.0);

  // Color transform on the sampled premultiplied rgba: matrix first, then
  // per-channel tint. Identity matrix + tint = (1,1,1,1) leaves surf
  // unchanged (the default).
  surf = u.colorMatrix * surf;
  surf = surf * u.tint;

  // Per-surface shape coverage: SDF-based rounded-rect / per-corner / super-
  // ellipse. Evaluated only inside the surface's nominal [0,1] region (the
  // margin band's contribution to surf is already 0 via the \`inside\` factor;
  // evaluating shape there would just multiply 0 by another value -- still 0,
  // so the clamp here is just a micro-optimization). Composes multiplicatively
  // with the existing mask alpha so a plugin can use BOTH (mask for arbitrary
  // shapes, shape for rounded corners; the intersection is rendered).
  let shapeCov = shapeCoverage(
    clamp(in.surfUV, vec2f(0.0), vec2f(1.0)),
    u32(u.shape.x), u.shape.yz, u.shape.w, u.shapeExtra);

  // Premultiplied: rgb and alpha both multiplied by inside * shapeCov *
  // mAlpha * opacity. Matches the pipeline's premultiplied blend.
  let k = inside * shapeCov * mAlpha * u.fx.x;
  return vec4f(surf.rgb * k, surf.a * k);
}
`;

// Transition pipeline shader (core-plugin-api.md §8). Renders a single
// full-screen quad blending two input textures (`from` / `to`) via a
// kind-uniform branch. Output replaces the on-screen target (no blend);
// the input textures carry premultiplied alpha, and each kind's logic
// preserves premultiplication so the direct write is correct.
//
// kind encoding (in TUniforms.kind):
//   0 = crossfade
//   1 = slide-left  (FROM slides off left;  TO enters from right)
//   2 = slide-right (FROM slides off right; TO enters from left)
//   3 = slide-up    (FROM slides off top;   TO enters from bottom)
//   4 = slide-down  (FROM slides off bottom; TO enters from top)
//   5 = scale       (FROM scales down + fades; TO scales up from center)
//
// progress is the eased value in [0, 1] the transition evaluator
// computes once per frame. The fragment shader treats progress as
// authoritative -- no per-pixel time math.
const TRANSITION_WGSL = `
struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};
struct TUniforms {
  kind     : u32,
  progress : f32,
  _pad0    : f32,
  _pad1    : f32,
};
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var texFrom : texture_2d<f32>;
@group(0) @binding(2) var texTo : texture_2d<f32>;
@group(0) @binding(3) var<uniform> u : TUniforms;

@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  // Full-screen quad in NDC; triangle-strip order matches the surface
  // pipeline. uv runs (0,0) top-left to (1,1) bottom-right.
  var pos = array<vec2f, 4>(
    vec2f(-1.0,  1.0),
    vec2f( 1.0,  1.0),
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
  );
  var uv = array<vec2f, 4>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 1.0),
  );
  var o : VsOut;
  o.pos = vec4f(pos[i], 0.0, 1.0);
  o.uv = uv[i];
  return o;
}

// Sample a 2D texture at uv; if uv is outside [0,1] in either axis,
// return (0,0,0,0) so out-of-range samples (e.g. the slide's offscreen
// half, or scale's outside-the-shrinking-rect) contribute nothing.
fn sampleClamped(t : texture_2d<f32>, uv : vec2f) -> vec4f {
  let inside = step(0.0, uv.x) * step(uv.x, 1.0)
             * step(0.0, uv.y) * step(uv.y, 1.0);
  let s = textureSampleLevel(t, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
  return s * inside;
}

@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let uv = in.uv;

  // Crossfade: linear blend of the two premultiplied samples.
  // Result remains premultiplied: (1-p)*A + p*B, where A and B are
  // both already premultiplied.
  if (u.kind == 0u) {
    let a = textureSampleLevel(texFrom, samp, uv, 0.0);
    let b = textureSampleLevel(texTo,   samp, uv, 0.0);
    return mix(a, b, p);
  }

  // Slide variants: FROM and TO are shifted by p (or -p) along one
  // axis. Each pixel reads exactly one of the two scenes via the
  // sampleClamped helper (the other returns 0 due to out-of-range uv).
  if (u.kind == 1u) {
    // slide-left: FROM shifts left by p; TO comes in from the right.
    let fromUV = vec2f(uv.x + p,         uv.y);
    let toUV   = vec2f(uv.x - (1.0 - p), uv.y);
    return sampleClamped(texFrom, fromUV) + sampleClamped(texTo, toUV);
  }
  if (u.kind == 2u) {
    // slide-right: FROM shifts right by p; TO comes in from the left.
    let fromUV = vec2f(uv.x - p,         uv.y);
    let toUV   = vec2f(uv.x + (1.0 - p), uv.y);
    return sampleClamped(texFrom, fromUV) + sampleClamped(texTo, toUV);
  }
  if (u.kind == 3u) {
    // slide-up: FROM shifts up by p; TO comes in from the bottom.
    let fromUV = vec2f(uv.x, uv.y + p);
    let toUV   = vec2f(uv.x, uv.y - (1.0 - p));
    return sampleClamped(texFrom, fromUV) + sampleClamped(texTo, toUV);
  }
  if (u.kind == 4u) {
    // slide-down: FROM shifts down by p; TO comes in from the top.
    let fromUV = vec2f(uv.x, uv.y - p);
    let toUV   = vec2f(uv.x, uv.y + (1.0 - p));
    return sampleClamped(texFrom, fromUV) + sampleClamped(texTo, toUV);
  }
  if (u.kind == 5u) {
    // scale: FROM shrinks to center while fading (factor 1-p);
    // TO grows from center while fading in (factor p). Each is
    // sampled in its own center-anchored coordinate frame; the
    // alpha-fade multiplier preserves premultiplication.
    //
    // Guard against division by 0 at the endpoints by skipping the
    // sample when the scale factor is below a small epsilon -- the
    // corresponding alpha multiplier is 0 there anyway.
    let eps = 1.0 / 1024.0;
    let sFrom = 1.0 - p;
    let sTo   = p;
    var a = vec4f(0.0);
    var b = vec4f(0.0);
    if (sFrom > eps) {
      let fromUV = (uv - vec2f(0.5)) / sFrom + vec2f(0.5);
      a = sampleClamped(texFrom, fromUV) * sFrom;
    }
    if (sTo > eps) {
      let toUV = (uv - vec2f(0.5)) / sTo + vec2f(0.5);
      b = sampleClamped(texTo, toUV) * sTo;
    }
    return a + b;
  }
  // Unknown kind (broker is supposed to reject these before install).
  // Fail visibly: bright magenta so a test catches it.
  return vec4f(1.0, 0.0, 1.0, 1.0);
}
`;

import type { CompositorSink, Layer } from "../protocols/ctx.js";
import { LAYER_ORDER, OUTPUT_DEFAULT } from "../protocols/ctx.js";
import { OutputDamageMap } from "./output-damage-map.js";
import type { TransitionKind } from "@overdraw/transition-types";
import type { WaylandFd } from "../types.js";
import { log } from "../log.js";

// Map a TransitionKind name to its WGSL u32 encoding (must match the
// kind switch in TRANSITION_WGSL.fs above).
const TRANSITION_KIND_CODE: Record<TransitionKind, number> = {
  "crossfade":   0,
  "slide-left":  1,
  "slide-right": 2,
  "slide-up":    3,
  "slide-down":  4,
  "scale":       5,
};
import {
  ClientBufferLifecycle,
  type LifecycleIntent,
} from "./client-buffer-lifecycle.js";

// Minimal slice of the native addon this module needs.
export interface CompositorAddon {
  shmView(poolId: number, offset: number, length: number): ArrayBuffer | null;
  // Async dmabuf import (server-side reserve/inject). Returns a monotonic
  // importId (0 = could not start); cb(handle|null) fires on completion. `fd` is
  // a WaylandFd (the native side peeks it without consuming).
  createTextureFromDmabuf(
    fd: WaylandFd, w: number, h: number, fourcc: number, modHi: number, modLo: number,
    offset: number, stride: number, cb: (handle: bigint | null) => void): number;
  // Release a dmabuf import (drops the server STM + fd). Called once the buffer
  // is freed (GPU-completion-gated) or the surface is removed.
  releaseDmabufImport(importId: number): void;
  // In-band per-frame BeginAccess/EndAccess on a cached client dmabuf import
  // (Layer C of docs/client-buffer-lifecycle.md): write a kind=1/kind=2 control
  // frame on the core WIRE socket (not ctrl). The frame is FIFO-ordered against
  // the Dawn sample commands around it -- a Begin written before the sample's
  // wire batch is processed first (bracket open before HandleCommands reaches
  // the sample); an End written after the submit's wire batch is processed
  // after it. No ctrl round-trip (Node thread does not block), no wireSerial,
  // no WireBarrier. The addon flushes staged Dawn bytes before each frame, so
  // JS does NOT flush explicitly. writeBeginAccess returns false iff the import
  // is unknown (JS-gate bug; the GPU process hard-fails on its side too).
  writeBeginAccess(importId: number): boolean;
  // Same as writeBeginAccess plus an attached sync_file fd (SCM_RIGHTS) for
  // wp_linux_drm_syncobj_v1. The GPU process uses the fence as the Dawn
  // acquire fence INSTEAD of running EXPORT_SYNC_FILE on the dmabuf.
  // Consumes the WaylandFd. Same false-on-import-miss contract.
  writeBeginAccessWithFence(importId: number, acquireFenceFd: WaylandFd): boolean;
  writeEndAccess(importId: number): void;
  // wp_linux_drm_syncobj_v1: signal a release timeline point. Called from
  // queue.onSubmittedWorkDone for each pending release point queued via
  // queueSurfaceReleasePoint on the JsCompositor.
  syncobjTimelineSignal(handle: number, pointHi: number, pointLo: number): boolean;
  // Phase 5b: in-band producer Begin/End on the core wire for compose buffers
  // (AllocComposeBuf). The core IS the producer for compose buffers, so
  // producer Begin/End ride the core wire (inverted from sdk.gpu overlays
  // where they ride the plugin wire). Used by composeIntoView when its
  // target is a wire-wrapped dmabuf with a producerSurfaceBufId.
  writeProducerBegin(surfaceBufId: number): void;
  writeProducerEnd(surfaceBufId: number): void;
  // Acquire the render target handle for the given output (null if none this
  // frame) and present it after rendering. outputId selects the output (KMS
  // scanout ring; nested has the single output 0).
  acquireOutputTexture(outputId: number): bigint | null;
  presentOutput(outputId: number): void;
  // Schedule a frame. Drives the wake/render state machine (see addon's
  // wake()). Idempotent; cheap when called repeatedly with no work pending.
  wake(): void;
}

// The dawn.node wire binding bits the compositor needs for dmabuf surfaces.
export interface DawnWire {
  wrapTexture(deviceHandle: bigint, textureHandle: bigint): GPUTexture;
}

// The bitflag constant objects dawn.node exposes (dawn.globals); shaped like the
// ambient WebGPU globals.
export interface DawnGlobals {
  GPUTextureUsage: typeof GPUTextureUsage;
  GPUBufferUsage: typeof GPUBufferUsage;
  GPUMapMode: typeof GPUMapMode;
}

// Per-surface analytic shape used to mask the on-screen coverage. Composed
// MULTIPLICATIVELY with the optional alpha-mask texture (so a plugin can use
// either or both -- a rounded rect for the corners + a custom alpha texture
// for, say, a non-rectangular shadow). Evaluated by an SDF in the fragment
// shader; the rectangular case (`null`) is an early-out and pays no extra
// cost. Radii / extents are in surface logical pixels.
export type SurfaceShape =
  | null                                    // rectangle (default)
  | { kind: "rounded-rect"; radius: number }
  | { kind: "rounded-rect-per-corner";
      tl: number; tr: number; br: number; bl: number }
  | { kind: "superellipse"; exponent: number; radius: number };

// Per-surface render state mutated by setSurfaceOpacity/Transform/OutputMargin
// (core-plugin-api.md §1) and consumed by the WGSL Uniforms struct each frame.
// Defaults: opacity=1, identity transform, zero margin -- equivalent to the
// pre-primitive shader behavior.
interface SurfaceFx {
  opacity: number;
  // Translate in output pixels; scale unitless. Rotation is deferred (v1 has
  // no shader path for it; spec builders compose center-anchor scale via
  // translate before/after).
  translateX: number; translateY: number;
  scaleX: number; scaleY: number;
  // Output-pixel margin reserved around the surface's nominal rect. The
  // surface texture is only sampled inside [0,1] surface-UV; the mask is
  // sampled across the FULL expanded region (surface + margin) so it can
  // shape pixels in the reserved area (soft rounded-corner falloff,
  // decoration-bound shadow alpha, etc.).
  marginTop: number; marginRight: number; marginBottom: number; marginLeft: number;
  // Per-channel tint multiplier on the sampled rgba (after colorMatrix).
  // Identity = (1,1,1,1).
  tintR: number; tintG: number; tintB: number; tintA: number;
  // 4x4 color matrix applied to the sampled rgba (column-major: 16 floats
  // = 4 columns of 4 components). Identity by default. WGSL mat4x4f is
  // column-major; we pack the same way.
  colorMatrix: Float32Array;
  // Analytic shape mask (rounded rect / superellipse / ...). null = full
  // rectangular coverage; the shader's kind=0 branch is an early-out.
  shape: SurfaceShape;
}

interface Surface {
  texture: GPUTexture | null;       // bgra8unorm, sampled
  view: GPUTextureView | null;
  // 160-byte uniform buffer holding the WGSL Uniforms struct (6 vec4s:
  // placement, transform, margin, fx, cropUV, tint; plus a mat4x4f
  // colorMatrix = 4 more vec4s). Rebuilt on size change like the bind
  // group; updated each frame via writeBuffer.
  uniformBuf: GPUBuffer | null;
  bindGroup: GPUBindGroup | null;
  // Buffer pixel dimensions (device pixels).
  width: number;
  height: number;
  // Device pixels per logical pixel in the buffer (wl_surface.set_buffer_scale).
  // Intrinsic logical size = width/height divided by this. Default 1.
  bufferScale: number;
  // wl_surface.set_buffer_transform: wl_output.transform enum 0..7. The shader
  // undoes this when sampling; 90/270 (and flipped variants) swap the surface's
  // logical width/height. Default 0 (normal).
  bufferTransform: number;
  // wp_viewport: dst overrides the surface's logical size; src crops the
  // sampled buffer region (surface coords). null/undefined = unset.
  viewportDst?: { width: number; height: number } | null;
  viewportSrc?: { x: number; y: number; width: number; height: number } | null;
  x: number;
  y: number;
  layoutW: number;
  layoutH: number;
  present: boolean;
  // For dmabuf surfaces, the buffer the lifecycle machine has assigned as
  // current (0 = shm/none/not-yet-imported). Used to pair frameSampled events
  // with the right buffer id, and to know what to (re)bind into the bind group
  // when an import completes.
  currentBufferId: number;
  fx: SurfaceFx;
  // Alpha mask sampled across the full expanded (surface + outputMargin)
  // region. null = use the compositor's shared 1x1-white default (no
  // visible effect). The bind group references the chosen mask's view;
  // setSurfaceMask rebuilds the bind group.
  maskView: GPUTextureView | null;
  // Phase 10a buffer intercept: when set, the compositor's per-surface
  // render pass samples from this view instead of `view`. The intercept
  // broker drives this via installInterceptOutput / clearInterceptOutput:
  // each frame the broker invokes the plugin's render callback, then
  // points the surface's bind group at the plugin's just-rendered
  // output slot. Cleared when no intercept is active for this surface.
  interceptOutputView: GPUTextureView | null;
  // Optional per-frame placement override for the intercept's
  // outputRect return. When set, the surface composites at this rect
  // instead of its WM-assigned (x, y, layoutW, layoutH). Updated by the
  // broker each frame; reset when the intercept clears or the plugin
  // returns no outputRect.
  interceptPlacement: { x: number; y: number; w: number; h: number } | null;
  // The captured snapshot. While set, the surface samples this compositor-owned
  // texture (its frozen frame) instead of its client buffer and draws at its
  // held layout rect -- so a held resize never shows a half-resized buffer. The
  // client's buffers keep flowing through their normal lifecycle meanwhile.
  // Cleared by thawSurface, which returns the texture to the pool.
  frozen?: FrozenSnapshot | null;
}

// A frozen surface snapshot: the surface's appearance rendered into a
// compositor-owned (pooled) texture at its on-screen device resolution.
interface FrozenSnapshot { tex: GPUTexture; view: GPUTextureView; w: number; h: number; }

// 6 vec4s (placement, transform, margin, fx, cropUV, tint) + 1 mat4x4f
// (colorMatrix, packed as 4 vec4 columns) + 2 vec4s (shape, shapeExtra) =
// 12 vec4s = 48 floats = 192 bytes.
const UNIFORM_BYTES = 192;
const UNIFORM_FLOATS = UNIFORM_BYTES / 4;

function identityColorMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

function defaultFx(): SurfaceFx {
  return {
    opacity: 1,
    translateX: 0, translateY: 0,
    scaleX: 1, scaleY: 1,
    marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
    tintR: 1, tintG: 1, tintB: 1, tintA: 1,
    colorMatrix: identityColorMatrix(),
    shape: null,
  };
}

// Pack a SurfaceShape into the per-surface uniform buffer at the shape /
// shapeExtra vec4 slots (float indices 40..47). `sizeXPx`/`sizeYPx` are the
// surface's logical pixel size used by the SDF eval; radii / per-corner /
// superellipse params are clamped to non-negative finite numbers (a bad
// value would propagate as NaN through the smoothstep and zero coverage --
// "weird invisible window" failure mode, easier to reason about with a
// clamp than with NaN propagation).
function packShape(data: Float32Array, shape: SurfaceShape,
                   sizeXPx: number, sizeYPx: number): void {
  // shape (vec4 #10, floats 40..43): kind, sizeXpx, sizeYpx, radius
  // shapeExtra (vec4 #11, floats 44..47): kind-specific
  data[41] = sizeXPx;
  data[42] = sizeYPx;
  if (shape === null) { data[40] = 0; return; }
  switch (shape.kind) {
    case "rounded-rect":
      data[40] = 1;
      data[43] = sanitizeNonNeg(shape.radius);
      return;
    case "rounded-rect-per-corner":
      data[40] = 2;
      data[44] = sanitizeNonNeg(shape.tl);
      data[45] = sanitizeNonNeg(shape.tr);
      data[46] = sanitizeNonNeg(shape.br);
      data[47] = sanitizeNonNeg(shape.bl);
      return;
    case "superellipse":
      data[40] = 3;
      data[43] = sanitizeNonNeg(shape.radius);
      // The shader clamps n>=2 inline; pass through here.
      data[44] = Number.isFinite(shape.exponent) ? shape.exponent : 2;
      return;
  }
}

function sanitizeNonNeg(v: number): number {
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

// The executor's per-bufferId record. Holds the GPU side of a cached client
// dmabuf import (wrapped texture + view + the native importId for release).
// Created lazily when the lifecycle's importBuffer intent completes (async via
// the addon callback); torn down by the releaseImport intent.
interface DmabufImport {
  tex: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  importId: number;
}

// Pending importBuffer intent: the descriptor we need to call the addon. Kept
// here (not in the state machine) so the lifecycle stays Dawn-free.
interface DmabufDescriptor {
  fd: WaylandFd;
  width: number;
  height: number;
  fourcc: number;
  modHi: number;
  modLo: number;
  offset: number;
  stride: number;
  // Surfaces waiting on this import to complete (so we can install the texture
  // on each once the wrap arrives). One bufferId can be the current of many
  // surfaces over its lifetime, but per per-surface invariant 4 only one at a
  // time, so this is normally singleton; defensive list.
  pendingInstalls: number[];
}

const DEFAULT_FORMAT = "bgra8unorm";

// Public payloads for the per-surface render-state setters
// (setSurfaceTransform, setSurfaceOutputMargin, setSurfaceTint). Each field
// is optional so callers may partially update; missing fields reset to the
// identity / zero.
export interface SurfaceTransform {
  translateX?: number;
  translateY?: number;
  scaleX?: number;
  scaleY?: number;
}
export interface SurfaceMargin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}
// Per-channel tint multiplier on the sampled rgba (after colorMatrix).
// Missing fields default to 1 (identity, no change to that channel).
export interface SurfaceTint {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}
// 4x4 color matrix applied to the sampled rgba. Caller passes 16 numbers in
// column-major order (matching WGSL mat4x4f layout). Identity has 1s on the
// diagonal and 0s elsewhere; that is the default if a surface has never had
// setSurfaceColorMatrix called.
export type ColorMatrix = readonly number[] | Float32Array;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// A live compose target re-rendered every on-screen renderFrame(). The
// texture handle is stable across frames; only its contents update.
interface LiveScene {
  texture: GPUTexture;
  view: GPUTextureView;
  outputId: number;
  windows: number[];
  outW: number;
  outH: number;
}

// A live per-window compose target. Each window in the list has its own
// texture sized to its crop rect; the compositor re-renders all of them
// per frame from the same draw-state.
interface LiveWindowComp {
  outputId: number;
  windows: Array<{
    id: number;
    rect: { x: number; y: number; w: number; h: number };
    texture: GPUTexture;
    view: GPUTextureView;
    // surface dims at registration time (used to compute cropUV); on
    // resize, the registration is invalidated. Phase 5a does not handle
    // mid-life surface resize for live window-comps; the holder releases
    // and re-registers if it needs to track resizes.
    surfW: number;
    surfH: number;
  }>;
}

export interface LiveSceneHandle {
  texture: GPUTexture;
  outW: number;
  outH: number;
  release(): void;
}

// Active-transition state held by the compositor while a transition is
// running on one output. setActiveTransition installs; clearActiveTransition
// (or the install-er calling clear themselves on completion) tears down.
// The compositor itself does not manage transition timing -- it reads
// progress from getProgress each frame and the broker / evaluator decide
// when to clear.
//
// resolveTextures is optional: when set, it's called each frame to re-pick
// which textures to sample (the Worker-live case, where the presented slot
// rotates). When unset, the install-time fromTex/toTex are used every frame
// (the stable case: in-thread snapshot/live, Worker snapshot).
//
// Per-side fromBracket / toBracket carry the producer Begin/End hooks for
// ring-backed scenes, identified by sceneId so the compositor can dedup
// across multiple per-output transitions that share a scene in the same
// frame (b->a on output 0 + c->b on output 1 must Begin scene b once, not
// twice -- the GPU process enforces Begin/End alternation per surfaceBufId).
interface ActiveTransition {
  fromTex: GPUTexture;
  toTex: GPUTexture;
  kind: TransitionKind;
  getProgress: () => number;
  resolveTextures?: () => {
    fromTex: GPUTexture;
    toTex: GPUTexture;
    fromBracket?: TransitionBracket;
    toBracket?: TransitionBracket;
  } | null;
  // Per-frame bind group cache. Invalidated when textures change
  // (resolveTextures returns different handles). Keyed on (fromTex,
  // toTex) identity.
  cachedFromTex: GPUTexture | null;
  cachedToTex: GPUTexture | null;
  cachedBindGroup: GPUBindGroup | null;
}

// A producer Begin/End pair for one scene's sample, identified by sceneId
// so the compositor can ensure exactly one Begin per scene per frame even
// when multiple outputs sample it concurrently.
interface TransitionBracket {
  sceneId: number;
  beginRead: () => void;
  endRead: () => void;
}

export interface LiveWindowCompHandle {
  windows: ReadonlyArray<{
    id: number;
    texture: GPUTexture;
    rect: { x: number; y: number; w: number; h: number };
  }>;
  release(): void;
}

export interface JsCompositorOpts {
  // Render into an owned offscreen target read back via readback() (tests /
  // pixel verification), instead of acquiring + presenting per output via
  // addon.acquireOutputTexture / presentOutput. Default true: a bare
  // JsCompositor with no opts is self-contained for unit-ish GPU tests.
  // Production (main.ts) passes false to drive the addon path; the addon's
  // backend choice (kms vs nested-host) is the layer that picks where the
  // acquired texture comes from. The addon-driven path requires dawn +
  // deviceHandle (for wrapTexture).
  headless?: boolean;
  // The render-target color format (must match the swapchain when not headless).
  format?: GPUTextureFormat;
}

// One scanout/host output's geometry. deviceWidth/Height are the render
// target's pixel size; logicalX/Y are the output's top-left in the GLOBAL
// logical coordinate space; scale bridges the two (logical = device / scale).
// A surface at global-logical (lx, ly) draws on this output at device
// ((lx - logicalX) * scale, (ly - logicalY) * scale).
export interface OutputGeom {
  id: number;
  deviceWidth: number;
  deviceHeight: number;
  logicalX: number;
  logicalY: number;
  scale: number;
}

// Derived per-output context used by the on-screen composite: the logical
// origin to subtract before placement, the output's scale, and its target
// dims (device px) + logical extent (device / scale, for normalization).
interface OutputCtx {
  id: number;
  originX: number;
  originY: number;
  scale: number;
  deviceWidth: number;
  deviceHeight: number;
  logicalWidth: number;
  logicalHeight: number;
}

export class JsCompositor implements CompositorSink {
  private device: GPUDevice;
  private g: DawnGlobals;
  private addon: CompositorAddon;
  // Render-target size in device pixels (the scanout / offscreen texture).
  private width: number;
  private height: number;
  // Output scale. Surface placement rects are in logical pixels and are
  // normalized to [0,1] by the logical output size (device / scale) so a
  // logical rect maps onto the full device target. 1 unless HiDPI is active.
  private scale = 1;
  private logicalWidth: number;
  private logicalHeight: number;
  // Per-output geometry, keyed by outputId. Output 0 is the primary, kept in
  // sync with setOutputSize (width/height/scale; logicalX/Y stay 0). setOutputs
  // replaces the whole map for true multi-output. renderFrame iterates this
  // (sorted by id), rendering each output's slice of the global logical space
  // into its own scanout target. Before setOutputs is ever called this holds a
  // single entry {id:0, x:0, y:0} so nested/headless/single-KMS are unchanged.
  private outputsGeom = new Map<number, OutputGeom>();
  // Surfaces that gained presentable content since the last takeImportedSurfaces.
  private imported: Array<{ id: number; width: number; height: number }> = [];
  private warnedDmabuf = false;

  // Pool of compositor-owned textures reused for frozen-surface snapshots,
  // keyed by "WxH" device size. Bounded per size so a one-off large resize
  // doesn't pin memory.
  private snapPool = new Map<string, GPUTexture[]>();
  // Fired when a frozen surface's new buffer becomes drawable (the WM gates the
  // thaw on this + the new size). Set by setFrozenReadyHandler.
  private frozenReadyCb: ((id: number) => void) | null = null;

  private sampler: GPUSampler;
  // Mask sampler: linear filtering so soft mask edges (rounded corners with
  // anti-aliasing) interpolate nicely. The surface sampler stays nearest
  // (clients render their own crisp pixels and we don't want bilinear blur).
  private maskSampler: GPUSampler;
  // Shared 1x1 BGRA8 opaque-white texture; the default mask for every surface.
  // Sampling it returns alpha=1 unconditionally, so a surface with no mask
  // renders identically to a surface whose mask is solid white. One texture
  // serves every surface (texture views are cheap to create per bind group).
  private defaultMaskView: GPUTextureView;
  private pipeline: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private target?: GPUTexture;          // offscreen render target (headless)
  private targetView?: GPUTextureView;

  private surfaces = new Map<number, Surface>();
  // The DEFAULT content-layer draw list (windows+subsurfaces+popups). The WM
  // owns this via setStack. An output may override it via setOutputStack.
  private stack: number[] = [];
  // Per-output content-stack overrides (core-plugin-api.md §1). When an entry
  // exists for an outputId, that output's content layer renders the override
  // list instead of `this.stack`. Single-output today: only OUTPUT_DEFAULT is
  // ever keyed. Cleared by setOutputStack(outputId, null).
  private outputStacks = new Map<number, number[]>();
  // Non-content layers (background/below/above/overlay). Composited around the
  // content stack per LAYER_ORDER. Plugin overlays/decorations populate these.
  private layers = new Map<Layer, number[]>();

  // Live compose targets. Each entry is re-rendered inside every renderFrame()
  // alongside the on-screen composite, sharing the frame's open import
  // brackets and command encoder. A live composer's texture is owned by the
  // compositor between register/release; the holder polls it whenever they
  // need current pixels.
  //
  // LiveScene is the unified "composed result" variant (compose.scene); the
  // listed windows are drawn back-to-front into a single target texture at
  // their natural layout rects, normalized to (outW,outH).
  //
  // LiveWindowComp is the per-window-textures variant (compose.windows);
  // each listed window gets its own target texture sized to its crop rect,
  // with the cropped region filling the target.
  private liveScenes: LiveScene[] = [];
  private liveWindowComps: LiveWindowComp[] = [];
  // Phase 5b-live: per-frame callbacks the broker registers for cross-device
  // dmabuf compose-live. Each callback owns its own ring + producer; the
  // compositor doesn't know the target. Invoked after the on-screen frame
  // composite (and the existing liveScenes/liveWindowComps passes), so the
  // producer's compose pass shares the frame's encoder + submit.
  private liveProducers: Array<() => void> = [];

  // Phase 9a: closing-animation phantoms. When a mapped toplevel
  // unmaps, the compositor composites its surface set (toplevel +
  // decoration + subsurfaces) into a fresh core-owned texture, mints
  // a new surfaceId for the phantom, and tracks it here. Phantoms
  // are drawn above the content stack (between content and the
  // 'above' layer) so they sit on top of the survivors reflowing
  // into the closing window's vacated tile. The plugin owns lifetime
  // via destroyPhantom; the broker also enforces a backstop timeout.
  // Insertion order = z order within the phantom group.
  private phantoms: number[] = [];
  // Texture handles for each phantom, keyed by phantom surfaceId.
  // Destroyed when destroyPhantom runs. The phantom's compositor
  // surface entry in this.surfaces sees the texture via the regular
  // bindGroup wiring (setSurfaceTexture installs it).
  private phantomTextures = new Map<number, GPUTexture>();

  // Active transition state. Each entry in activeTransitions is keyed by
  // the outputId it runs on; on every renderFrame the per-output composite
  // pass is replaced (for that output only) with a transition pass blending
  // fromTex/toTex via the kind-specific shader. Live composers + live
  // producers continue to run -- their content keeps tracking, so a
  // transition over live scenes sees in-flight client buffer commits.
  // Simultaneous transitions on different outputs are allowed (one slot per
  // output); the broker rejects two installs on the same output.
  private transitionPipeline: GPURenderPipeline | null = null;
  private transitionLayout: GPUBindGroupLayout | null = null;
  private transitionUniformBuf: GPUBuffer | null = null;
  private activeTransitions = new Map<number, ActiveTransition>();

  // dmabuf buffer-release lifecycle. The pure state machine (no GPU, no Dawn)
  // is the source of truth; the executor here translates events <-> intents.
  // See src/gpu/client-buffer-lifecycle.ts for the rules; the design is in
  // docs/client-buffer-lifecycle.md.
  private lifecycle = new ClientBufferLifecycle();
  // Per-bufferId cached GPU import. Populated when an importBuffer intent's
  // async addon callback resolves; cleared by releaseImport. Cache lifetime is
  // the wl_buffer lifetime (rule A): cycling clients hit cache on re-attach.
  private dmabufImports = new Map<number, DmabufImport>();
  // bufferId -> descriptor for importBuffer intents whose async callback has
  // not yet fired. Also lists surfaces waiting to bind once the wrap arrives.
  private dmabufPending = new Map<number, DmabufDescriptor>();
  // Buffers freed by the lifecycle (sendWlRelease intents). Drained per-frame
  // by src/protocols/index.ts via takeFreedBuffers() (the wire layer).
  private freed: number[] = [];

  // wp_linux_drm_syncobj_v1 release-point bookkeeping: bufferId -> the latest
  // syncobj release point promoted at commit time. Signaled exactly when the
  // lifecycle emits sendWlRelease for that bufferId (i.e. the buffer is
  // superseded on its surface AND its last GPU sample completed) -- same
  // semantic as wl_buffer.release, which is what the protocol demands.
  // Signaling on every onSubmittedWorkDone would tell the client it can reuse
  // a buffer while the compositor is still presenting it; that is the bug
  // that produced the "every-other-cursor-blink frame is decoration-only"
  // observation. Map (not queue) because the spec says repeated set_release_point
  // calls on the same commit cycle replace the prior point.
  private bufferIdToSyncobjRelease = new Map<
    number, { handle: number; pointHi: number; pointLo: number }>();

  // wp_linux_drm_syncobj_v1 acquire-fence handoff: bufferId -> the sync_file
  // exported from the most recent commit's acquire timeline point. Consumed by
  // openImportBrackets the FIRST time we sample that bufferId; on subsequent
  // samples of the same buffer (kitty re-renders the same buffer across blink
  // toggles) the implicit-sync fallback engages, which is correct -- the
  // client signaled their writes when the FIRST acquire point fired; nothing
  // else is pending on that dmabuf until the buffer is re-committed.
  //
  // Keyed by bufferId (not surfaceId) because the fence is paired with the
  // specific buffer it accompanies. A surface that's still presenting an OLD
  // buffer while the NEW buffer's import is in flight must NOT consume the
  // new buffer's fence on its sample of the old one -- that's the
  // every-third-present bug.
  private bufferIdToAcquireFenceFd = new Map<
    number, import("../types.js").WaylandFd>();

  // Submit-serial bookkeeping. completedSerial is what onSubmittedWorkDone
  // turns into gpuCompleted(serial) events; both also drive afterCurrentFrame.
  private submitSerial = 0;
  private completedSerial = 0;
  // Callbacks deferred until the compositing submit in flight at registration time
  // completes on the GPU. Used to recycle a plugin/overlay consumer slot only after
  // the frame that last sampled it is done (else EndAccess races the GPU read).
  private afterFrame: Array<{ serial: number; cb: () => void }> = [];

  // dmabuf support (optional; only needed when dmabuf clients run under the JS
  // compositor). `dawn` provides wrapTexture; `deviceHandle` is the wire device.
  private dawn: DawnWire | null;
  private deviceHandle: bigint;

  // When false, render through the addon's per-output acquire/present API
  // (KMS scanout slots OR a nested-host swapchain texture, picked by the
  // addon's backend). When true, render into an owned offscreen target read
  // back via readback(). The headless path is exercised by tests; production
  // and dev both run !headless.
  private headless: boolean;
  private format: GPUTextureFormat;
  private outputTex: GPUTexture | null = null;  // wrapped output texture, held during a frame

  // Composite-scissor damage in GLOBAL logical coords, partitioned per
  // output (one OutputDamageRing per output, each keyed by the stable
  // acquireOutputTexture handle of its slots). The map clips global damage
  // rects into each output's local space and back, so callers operate
  // entirely in global space.
  private readonly outputDamage = new OutputDamageMap();
  private static readonly HEADLESS_DAMAGE_KEY = 0n;
  // 1x1 opaque-black quad reused to clear the damaged region to black before
  // the scissored composite (loadOp:"load" preserves pixels OUTSIDE the
  // scissor; inside it, the bottom of the surface stack must blend against
  // black, not stale pixels). Lazily built on first partial frame.
  private blackFill: Surface | null = null;

  constructor(device: GPUDevice, globals: DawnGlobals, addon: CompositorAddon,
              output: { width: number; height: number },
              dawn: DawnWire | null = null, deviceHandle: bigint = 0n,
              opts: JsCompositorOpts = {}) {
    this.device = device;
    this.g = globals;
    this.addon = addon;
    this.width = output.width;
    this.height = output.height;
    this.logicalWidth = output.width;
    this.logicalHeight = output.height;
    this.outputsGeom.set(OUTPUT_DEFAULT, {
      id: OUTPUT_DEFAULT,
      deviceWidth: output.width, deviceHeight: output.height,
      logicalX: 0, logicalY: 0, scale: 1,
    });
    this.dawn = dawn;
    this.deviceHandle = deviceHandle;
    this.headless = opts.headless ?? true;
    this.format = opts.format ?? DEFAULT_FORMAT;

    this.sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
    this.maskSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

    // Allocate the shared default mask. 1x1 opaque white; uploaded once at
    // construction. Every surface defaults to a view of this texture, so the
    // shader path is always "sample mask" regardless of whether the plugin
    // installed one.
    const defaultMask = device.createTexture({
      size: { width: 1, height: 1 },
      format: "bgra8unorm",
      usage: this.g.GPUTextureUsage.TEXTURE_BINDING | this.g.GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: defaultMask },
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      { width: 1, height: 1 },
    );
    this.defaultMaskView = defaultMask.createView();

    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      primitive: { topology: "triangle-strip" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
    });
    this.layout = this.pipeline.getBindGroupLayout(0);

    // Phase 8: transition pipeline. A separate pipeline because the
    // bind-group shape and the shader (full-screen quad, two input
    // textures) differ from the per-surface composite pass. Built
    // eagerly so the per-frame fast path in renderFrame can encode
    // without any allocation when a transition is active.
    const transitionModule = device.createShaderModule({ code: TRANSITION_WGSL });
    this.transitionPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: transitionModule, entryPoint: "vs" },
      primitive: { topology: "triangle-strip" },
      fragment: {
        module: transitionModule,
        entryPoint: "fs",
        // No blend: the transition pass overwrites the on-screen
        // target. The shader outputs the final premultiplied pixel
        // (kind-specific blend is done in WGSL, not by fixed-function).
        targets: [{ format: this.format }],
      },
    });
    this.transitionLayout = this.transitionPipeline.getBindGroupLayout(0);
    // Uniform buffer: kind (u32) + progress (f32) + 8 bytes of padding
    // to 16-byte alignment. Reused every frame.
    this.transitionUniformBuf = device.createBuffer({
      size: 16,
      usage: this.g.GPUBufferUsage.UNIFORM | this.g.GPUBufferUsage.COPY_DST,
    });

    // Headless: allocate an owned offscreen target (read back via readback()).
    // Otherwise the render target is acquired per output per frame from the
    // addon (KMS scanout slot or nested-host swapchain).
    if (this.headless) {
      this.target = device.createTexture({
        size: { width: this.width, height: this.height },
        format: this.format,
        usage: this.g.GPUTextureUsage.RENDER_ATTACHMENT | this.g.GPUTextureUsage.COPY_SRC,
      });
      this.targetView = this.target.createView();
    }
    // Seed the damage map with the constructor's initial output. Subsequent
    // setOutputSize / setOutputs replace this; in-between calls to
    // addOutputDamage have a bounded ring to land in.
    this.pushDamageBounds();
  }

  // --- CompositorSink ---

  // Called when the output reconfigures. Updates the size used for render
  // passes (output-space rects, cursor placement, layout sentinels).
  //
  // For nested mode this is just bookkeeping -- the swapchain is
  // reconfigured by the GPU process synchronously when the host fires its
  // xdg_toplevel.configure, so the next acquireOutputTexture already
  // returns a correctly-sized texture and no GPU resources need re-creating
  // here.
  //
  // For headless mode the offscreen target is sized at construction. If
  // setOutputSize is ever called with a different size in headless mode,
  // subsequent renders would write to the wrong-sized target -- so this
  // method REQUIRES that headless callers either avoid calling it or
  // recreate the target alongside. Today no path triggers it in headless
  // (the GPU process only emits OutputDescriptor in nested mode), so this
  // is a precondition, not a missed reconfiguration; if a future path
  // wants headless resize, this method has to grow the target-recreate
  // logic at that point.
  // width/height are device pixels (the render target). scale derives the
  // logical output size used to normalize surface placement.
  setOutputSize(width: number, height: number, scale = 1): void {
    this.width = width;
    this.height = height;
    this.scale = scale > 0 ? scale : 1;
    this.logicalWidth = Math.max(1, Math.round(width / this.scale));
    this.logicalHeight = Math.max(1, Math.round(height / this.scale));
    // Keep the primary output's geometry (output 0) in sync. Its logical
    // origin stays (0,0); only its device dims + scale track this call.
    const prev = this.outputsGeom.get(OUTPUT_DEFAULT);
    this.outputsGeom.set(OUTPUT_DEFAULT, {
      id: OUTPUT_DEFAULT,
      deviceWidth: width, deviceHeight: height,
      logicalX: prev?.logicalX ?? 0, logicalY: prev?.logicalY ?? 0,
      scale: this.scale,
    });
    this.pushDamageBounds();
    this.damageFull();  // slot textures are recreated; everything is stale
  }

  // Replace the full set of output geometries (multi-output). Each entry is a
  // monitor's slice of the global logical space + its scanout target dims.
  // renderFrame renders every entry per frame into its own target. Empty input
  // is ignored (keeps the existing single primary rather than blanking output).
  setOutputs(outputs: ReadonlyArray<OutputGeom>): void {
    if (outputs.length === 0) return;
    this.outputsGeom.clear();
    for (const o of outputs) {
      const scale = o.scale > 0 ? o.scale : 1;
      this.outputsGeom.set(o.id, {
        id: o.id,
        deviceWidth: o.deviceWidth, deviceHeight: o.deviceHeight,
        logicalX: o.logicalX, logicalY: o.logicalY, scale,
      });
    }
    // Mirror output 0's device dims/scale into the primary fields so paths that
    // still read this.width/height/scale (readback, freeze snapshots) match it.
    const primary = this.outputsGeom.get(OUTPUT_DEFAULT);
    if (primary) {
      this.width = primary.deviceWidth;
      this.height = primary.deviceHeight;
      this.scale = primary.scale;
      this.logicalWidth = Math.max(1, Math.round(primary.deviceWidth / primary.scale));
      this.logicalHeight = Math.max(1, Math.round(primary.deviceHeight / primary.scale));
    }
    this.pushDamageBounds();
    this.damageFull();
  }

  // Translate the current outputsGeom into the damage map's per-output
  // bounds (logical position + logical size). Called whenever the output
  // set changes (setOutputSize, setOutputs). The map's setOutputs preserves
  // damage state for outputs whose logical size is unchanged; resized
  // outputs get their ring rebuilt (their slot textures will be recreated
  // anyway, so the prior damage is moot).
  private pushDamageBounds(): void {
    const bounds: Array<{
      outputId: number;
      logicalX: number; logicalY: number;
      logicalWidth: number; logicalHeight: number;
    }> = [];
    for (const o of this.outputsGeom.values()) {
      const scale = o.scale > 0 ? o.scale : 1;
      bounds.push({
        outputId: o.id,
        logicalX: o.logicalX, logicalY: o.logicalY,
        logicalWidth: Math.max(1, Math.round(o.deviceWidth / scale)),
        logicalHeight: Math.max(1, Math.round(o.deviceHeight / scale)),
      });
    }
    this.outputDamage.setOutputs(bounds);
  }

  // Derive the per-output render context from its geometry: scale, target
  // device dims, and the logical extent (device / scale) used to normalize
  // placement. originX/Y is the output's logical top-left, subtracted from a
  // surface's global-logical position before the ×scale placement.
  private outputCtx(o: OutputGeom): OutputCtx {
    const scale = o.scale > 0 ? o.scale : 1;
    return {
      id: o.id,
      originX: o.logicalX, originY: o.logicalY, scale,
      deviceWidth: o.deviceWidth, deviceHeight: o.deviceHeight,
      logicalWidth: Math.max(1, Math.round(o.deviceWidth / scale)),
      logicalHeight: Math.max(1, Math.round(o.deviceHeight / scale)),
    };
  }

  // Consume this output's accumulated damage for the frame, keyed by the
  // stable per-slot key (the scanout-ring handle, or the headless sentinel).
  // Returns the scissor box in GLOBAL logical coords (composite() shifts it
  // by the output's origin) for a partial repaint, or undefined for a full
  // repaint. A transition animates the whole output, so it forces full
  // while one is active on this output.
  private takeScissor(
    o: OutputGeom, key: bigint,
  ): { x: number; y: number; w: number; h: number } | undefined {
    if (this.activeTransitions.has(o.id)) return undefined;
    const repaint = this.outputDamage.take(o.id, key);
    return repaint.mode === "partial" ? repaint.box : undefined;
  }

  // Stack/layer reorders change occlusion at arbitrary places; repaint full.
  setStack(ids: number[]): void { this.stack = ids.slice(); this.damageFull(); }

  setOutputStack(outputId: number, ids: number[] | null): void {
    if (ids === null) this.outputStacks.delete(outputId);
    else this.outputStacks.set(outputId, ids.slice());
    this.damageFull();
  }

  setLayerSurfaces(layer: Layer, ids: number[]): void {
    if (layer === "content") { this.stack = ids.slice(); this.damageFull(); return; }
    this.layers.set(layer, ids.slice());
    this.damageFull();
  }

  // The full back-to-front draw order for one output: each layer in
  // LAYER_ORDER, with the content layer taken from that output's override
  // (setOutputStack) when set, else the global `this.stack`. Phantoms, layers,
  // and cursor are global (drawn into every output's viewport; the renderer's
  // per-output viewport + scissor confines them to where they belong in global
  // logical space).
  private drawOrder(outputId: number): number[] {
    const out: number[] = [];
    const content = this.outputStacks.get(outputId) ?? this.stack;
    for (const layer of LAYER_ORDER) {
      if (layer === "content") {
        out.push(...content);
        // Phase 9a: phantoms (closing-animation snapshots) draw on top
        // of the content layer but below the 'above' layer. Insertion
        // order = z order; the most recently closed window's phantom
        // is on top of older phantoms. This is the v1 z model;
        // future phases may splice phantoms into the exact z position
        // their original surface had if the simple "on top of content"
        // placement turns out wrong for some real use case.
        if (this.phantoms.length > 0) out.push(...this.phantoms);
      }
      else { const ids = this.layers.get(layer); if (ids) out.push(...ids); }
    }
    // Phase 9c: the cursor is always on top -- above every layer,
    // above phantoms, above any plugin overlay. The target surfaceId
    // can be the internal cursor surface (CPU-uploaded image) or any
    // existing surface (e.g. a wl_pointer.set_cursor client surface).
    // Visibility flag + target-set + target-has-texture gate inclusion.
    if (this.cursorVisible && this.cursorTargetSurfaceId !== null) {
      const s = this.surfaces.get(this.cursorTargetSurfaceId);
      if (s && s.texture) {
        // When the target is a regular WM surface that's ALSO in the
        // content stack (a client cursor surface should not be — those
        // are never in the WM stack — but defensively), avoid pushing
        // it twice. drawOrder dedup is the caller's responsibility for
        // ordinary stacks, but we own this insertion.
        out.push(this.cursorTargetSurfaceId);
      }
    }
    return out;
  }

  setSurfaceLayout(id: number, x: number, y: number, w: number, h: number): void {
    const s = this.surfaces.get(id);
    if (s) {
      // Damage both the vacated and the new rect (move/resize).
      this.addOutputDamage(s.x, s.y, s.layoutW, s.layoutH);
      s.x = x; s.y = y; s.layoutW = w; s.layoutH = h;
      this.addOutputDamage(x, y, w, h);
    } else {
      this.surfaces.set(id, blankSurface(x, y, w, h));
      this.addOutputDamage(x, y, w, h);
    }
  }

  // Resize transaction: snapshot this surface's CURRENT appearance right now,
  // synchronously, into a pooled texture, and draw that snapshot at its held
  // layout rect until thawed. Capturing synchronously (rather than on the next
  // frame) is essential -- it happens before the client has processed the
  // configure and re-rendered, so the snapshot is the pre-resize frame, not a
  // half-resized one. Idempotent; no-op for a surface with no live content.
  freezeSurface(id: number): void {
    const s = this.surfaces.get(id);
    if (!s || s.frozen || !s.present || !s.bindGroup || s.currentBufferId === 0) return;
    const imp = this.dmabufImports.get(s.currentBufferId);
    if (!imp) return;
    const w = Math.max(1, Math.round(s.layoutW * this.scale));
    const h = Math.max(1, Math.round(s.layoutH * this.scale));
    const snap = this.acquireSnapTex(w, h);
    // Standalone bracketed submit: open the client import's access bracket,
    // render the surface filling the snapshot (its crop/transform apply), close
    // the bracket. FIFO-ordered on the wire like any other sample.
    if (!this.addon.writeBeginAccess(imp.importId)) { this.releaseSnapTex(snap); return; }
    const enc = this.device.createCommandEncoder();
    this.composite({
      encoder: enc, targetView: snap.view, drawList: [id],
      outW: s.layoutW, outH: s.layoutH,
      placements: new Map([[id, { x: 0, y: 0, w: s.layoutW, h: s.layoutH }]]),
    });
    this.device.queue.submit([enc.finish()]);
    this.addon.writeEndAccess(imp.importId);
    s.frozen = snap;
    if (s.view) this.rebuildBindGroup(s, s.view);
  }

  // Drop the frozen snapshot: return its texture to the pool and resume drawing
  // the live client buffer. Called when the WM applies the held geometry (in the
  // same batch as setSurfaceLayout, so content + size land together) or cancels
  // the hold. Idempotent.
  thawSurface(id: number): void {
    const s = this.surfaces.get(id);
    if (!s || !s.frozen) return;
    this.releaseSnapTex(s.frozen);
    s.frozen = null;
    // Resume sampling the live buffer. If there is none (shouldn't happen --
    // the WM only thaws once surfaceReadyAt confirms a drawable buffer), drop
    // the bind group so the surface isn't drawn from the recycled snapshot view.
    if (s.view) this.rebuildBindGroup(s, s.view);
    else { s.bindGroup = null; s.present = false; }
  }

  // The WM registers a handler invoked when a frozen surface's new buffer
  // becomes drawable, so it can re-check whether a held resize is ready.
  setFrozenReadyHandler(cb: (id: number) => void): void { this.frozenReadyCb = cb; }

  // True if the surface has a drawable buffer at logical size (w, h). The WM
  // gates a held resize's apply on this so it never thaws onto a not-yet-
  // imported (or stale-size) buffer.
  surfaceReadyAt(id: number, w: number, h: number): boolean {
    const s = this.surfaces.get(id);
    if (!s || !s.present || !s.view || s.currentBufferId === 0) return false;
    const bs = s.bufferScale || 1;
    const lw = s.viewportDst?.width ?? s.viewportSrc?.width ?? (s.width / bs);
    const lh = s.viewportDst?.height ?? s.viewportSrc?.height ?? (s.height / bs);
    return Math.round(lw) === w && Math.round(lh) === h;
  }

  private acquireSnapTex(w: number, h: number): FrozenSnapshot {
    const free = this.snapPool.get(`${w}x${h}`);
    const pooled = free && free.length > 0 ? free.pop() : undefined;
    const tex = pooled ?? this.device.createTexture({
      size: { width: w, height: h },
      format: this.format,
      usage: this.g.GPUTextureUsage.RENDER_ATTACHMENT | this.g.GPUTextureUsage.TEXTURE_BINDING,
    });
    return { tex, view: tex.createView(), w, h };
  }

  private releaseSnapTex(snap: FrozenSnapshot): void {
    const key = `${snap.w}x${snap.h}`;
    let free = this.snapPool.get(key);
    if (!free) { free = []; this.snapPool.set(key, free); }
    if (free.length < 4) free.push(snap.tex);
    else snap.tex.destroy();
  }

  setSurfaceBufferScale(id: number, scale: number): void {
    const s = this.surfaces.get(id) ?? this.ensureSurface(id);
    s.bufferScale = scale > 0 ? scale : 1;
    this.damageSurface(id);
  }

  setSurfaceBufferTransform(id: number, transform: number): void {
    const s = this.surfaces.get(id) ?? this.ensureSurface(id);
    s.bufferTransform = (transform >= 0 && transform <= 7) ? transform : 0;
    this.damageSurface(id);
  }

  setSurfaceViewport(
    id: number,
    dst: { width: number; height: number } | null,
    src: { x: number; y: number; width: number; height: number } | null,
  ): void {
    const s = this.surfaces.get(id) ?? this.ensureSurface(id);
    s.viewportDst = dst;
    s.viewportSrc = src;
    this.damageSurface(id);
  }

  // Per-surface render-state setters (core-plugin-api.md §1). Cheap: they
  // mutate the per-surface SurfaceFx; the values flow into the WGSL Uniforms
  // each frame via updateUniforms. Auto-create the Surface so callers don't
  // race the protocol layer's setSurfaceLayout.
  setSurfaceOpacity(id: number, opacity: number): void {
    this.ensureSurface(id).fx.opacity = clamp(opacity, 0, 1);
    this.damageSurface(id);  // alpha change stays within the surface rect
  }

  setSurfaceTransform(id: number, t: SurfaceTransform): void {
    const fx = this.ensureSurface(id).fx;
    fx.translateX = t.translateX ?? 0;
    fx.translateY = t.translateY ?? 0;
    fx.scaleX = t.scaleX ?? 1;
    fx.scaleY = t.scaleY ?? 1;
    this.damageFull();  // translate/scale can draw outside the layout rect
  }

  setSurfaceOutputMargin(id: number, m: SurfaceMargin): void {
    const fx = this.ensureSurface(id).fx;
    fx.marginTop = m.top ?? 0;
    fx.marginRight = m.right ?? 0;
    fx.marginBottom = m.bottom ?? 0;
    fx.marginLeft = m.left ?? 0;
    this.damageFull();  // margin expands the drawn region beyond the rect
  }

  setSurfaceTint(id: number, t: SurfaceTint): void {
    const fx = this.ensureSurface(id).fx;
    fx.tintR = t.r ?? 1;
    fx.tintG = t.g ?? 1;
    fx.tintB = t.b ?? 1;
    fx.tintA = t.a ?? 1;
    this.damageSurface(id);
  }

  // Install a 4x4 color matrix applied to the sampled rgba each frame. The
  // caller passes 16 numbers in column-major order (WGSL mat4x4f layout).
  // null restores the identity matrix.
  setSurfaceColorMatrix(id: number, m: ColorMatrix | null): void {
    const fx = this.ensureSurface(id).fx;
    if (m === null) {
      fx.colorMatrix = identityColorMatrix();
      this.damageSurface(id);
      return;
    }
    if (m.length !== 16) {
      throw new Error(`setSurfaceColorMatrix: expected 16 numbers, got ${m.length}`);
    }
    // Defensive copy: the caller's array is theirs to mutate without
    // affecting subsequent frames.
    const dst = new Float32Array(16);
    for (let i = 0; i < 16; i++) dst[i] = m[i] ?? 0;
    fx.colorMatrix = dst;
    this.damageSurface(id);
  }

  // Install an analytic shape on a surface: a rounded rect (uniform radius or
  // per-corner), a superellipse (squircle), or null to restore a plain
  // rectangle. The compositor evaluates an SDF in the fragment shader and
  // multiplies its [0,1] coverage into the surface's premultiplied output --
  // composes with the (optional) alpha mask, so a plugin may use both. Radii
  // / extents are in surface LOGICAL pixels.
  //
  // Cheap: uniform-write only (no bind-group rebuild, no GPU resources). A
  // null shape is the default and an early-out in the shader.
  setSurfaceShape(id: number, shape: SurfaceShape): void {
    const s = this.ensureSurface(id);
    s.fx.shape = shape;
    this.damageFull();  // shape changes the entire visible footprint
  }

  // Install (or clear) an alpha mask on a surface. The mask is sampled across
  // the full expanded (surface + outputMargin) region; its .a channel modulates
  // the surface's alpha (and premultiplied rgb). null restores the default
  // white mask (no visible effect).
  //
  // Bind groups embed view references, so we must rebuild the surface's bind
  // group on every mask change. Cheap (per-frame state changes are not
  // expected; mask installation is a state event, not a hot path).
  //
  // Caller owns the GPUTexture's lifetime: the compositor doesn't take
  // ownership, never .destroy()s it. The caller MUST keep the texture alive
  // for as long as it is installed, and replace or clear it before destroy.
  setSurfaceMask(id: number, mask: GPUTexture | null): void {
    const s = this.ensureSurface(id);
    s.maskView = mask ? mask.createView() : null;
    // Rebuild the bind group if a surface view already exists. If no surface
    // texture is committed yet, the mask installs into the Surface struct;
    // the next rebuildBindGroup (on first content) will pick it up.
    if (s.view) this.rebuildBindGroup(s, s.view);
    this.damageFull();  // mask spans the expanded (surface + margin) region
  }

  private ensureSurface(id: number): Surface {
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }
    return s;
  }

  removeSurface(id: number): void {
    // Feed surfaceRemoved to the lifecycle BEFORE dropping the Surface record.
    // The state machine emits the (gated-on-completion) sendWlRelease +
    // releaseImport for the surface's then-current buffer; the executor
    // handles them in dispatch(). Other (previously-superseded but still
    // cached) buffers stay cached until bufferDestroyed fires for them per
    // rule A; the disconnect sweep in src/protocols/index.ts is what
    // guarantees no client-disconnect leak.
    this.dispatch(this.lifecycle.step({ kind: "surfaceRemoved", surfaceId: id }));

    const s = this.surfaces.get(id);
    if (s) {
      // The per-surface uniform buffer is a wire GPUBuffer the executor
      // owns; destroy it now. The sampled texture is the dmabuf import
      // owned by dmabufImports/lifecycle; the lifecycle path released it
      // via the surfaceRemoved drain (or deferred until inflight frames
      // complete). Explicitly .destroy()-ing the wrapped client texture
      // here caused intermittent fatal dawn.node throws during teardown.
      s.uniformBuf?.destroy();
      // Return any frozen snapshot to the pool.
      if (s.frozen) { this.releaseSnapTex(s.frozen); s.frozen = null; }
      // Repaint the rect the surface vacated.
      this.addOutputDamage(s.x, s.y, s.layoutW, s.layoutH);
    }
    this.surfaces.delete(id);
  }

  // Upload a committed shm buffer into the surface's sampled texture (zero-copy
  // from the client mapping via addon.shmView), and report it as presentable.
  commitSurfaceBuffer(id: number, poolId: number, offset: number,
                      width: number, height: number, stride: number,
                      damage?: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): boolean {
    const ab = this.addon.shmView(poolId, offset, stride * height);
    if (!ab) return false;
    this.uploadPixels(id, { width, height, stride }, ab, damage);
    this.imported.push({ id, width, height });
    return true;
  }

  // Commit a client dmabuf wl_buffer to a surface. Feeds the lifecycle machine
  // a `commit` event; the resulting intents drive the import (if first-sight
  // of this bufferId) or simply re-bind the existing cached import to the
  // surface.
  //
  // Returns false only when this compositor was constructed without a Dawn
  // wire (the headless protocol-only mode used by some tests); true otherwise.
  // (It used to return the addon's importId-truthy value, but the
  // intent-driven path makes the import strictly async, so we return true and
  // let the lifecycle drive the rest.)
  commitSurfaceDmabuf(id: number, fd: WaylandFd, w: number, h: number, fourcc: number,
                      modHi: number, modLo: number, offset: number, stride: number,
                      bufferId: number,
                      acquireFenceFd?: WaylandFd): boolean {
    if (!this.dawn || this.deviceHandle === 0n) {
      if (!this.warnedDmabuf) {
        log.warn("core", "js-compositor: dmabuf needs dawn.wrapTexture + deviceHandle");
        this.warnedDmabuf = true;
      }
      // Caller owns the WaylandFd on a false return; close the explicit-sync
      // fence (if any) so it doesn't leak.
      if (acquireFenceFd && !acquireFenceFd.closed) {
        try { acquireFenceFd.close(); } catch { /* already closed */ }
      }
      return false;
    }

    // Ensure the surface exists (the layout sweep may not have created it).
    if (!this.surfaces.has(id)) this.surfaces.set(id, blankSurface(0, 0, 0, 0));

    // wp_linux_drm_syncobj_v1: stash the explicit-sync acquire fence keyed by
    // BUFFER (not surface). openImportBrackets consumes the fence the first
    // time it samples this bufferId; on re-samples of the same buffer the
    // implicit fallback engages (which is correct: the client signaled their
    // writes on the first acquire point; subsequent samples are read-only on
    // an unchanged dmabuf). Replacing a stale fence for the same bufferId is
    // the legitimate case where a client commits the same buffer twice with
    // two acquire points -- the newer one wins; close the older one.
    if (acquireFenceFd) {
      const prev = this.bufferIdToAcquireFenceFd.get(bufferId);
      if (prev && !prev.closed) { try { prev.close(); } catch { /* */ } }
      this.bufferIdToAcquireFenceFd.set(bufferId, acquireFenceFd);
    }

    // Stash the descriptor BEFORE the commit event: if the lifecycle emits an
    // importBuffer intent, the intent handler reads dmabufPending to find the
    // descriptor. (The lifecycle keeps the rules; the executor keeps the GPU
    // concerns. Crossing the boundary with raw fds would defeat that.)
    if (!this.dmabufPending.has(bufferId) && !this.dmabufImports.has(bufferId)) {
      this.dmabufPending.set(bufferId, {
        fd, width: w, height: h, fourcc, modHi, modLo, offset, stride,
        pendingInstalls: [],
      });
    }
    // Track that this surface wants the texture installed when the import
    // completes (cache miss path) -- or immediately (cache hit path, handled
    // below after stepping the lifecycle).
    const pending = this.dmabufPending.get(bufferId);
    if (pending && !pending.pendingInstalls.includes(id)) {
      pending.pendingInstalls.push(id);
    }

    // Feed the lifecycle. It emits importBuffer (cache miss) or nothing (cache
    // hit / same-buffer re-commit). The acquireFenceAvailable event is a stub
    // in Layer B: `kind: "none"` until Layer C re-exports the dmabuf sync_file
    // per commit. (Today the GPU process exports the sync_file at import time
    // and feeds it into the single BeginAccess at import, which is the bug
    // Layer C fixes; Layer B leaves the existing behavior untouched.)
    this.dispatch(this.lifecycle.step({
      kind: "commit", surfaceId: id, bufferId, dims: { w, h },
    }));
    this.dispatch(this.lifecycle.step({
      kind: "acquireFenceAvailable", bufferId, fence: { kind: "none" },
    }));

    // Cache hit: the lifecycle did NOT emit importBuffer, and we already have
    // a cached GPUTexture for this bufferId. Bind it on the surface now.
    const cached = this.dmabufImports.get(bufferId);
    if (cached) {
      this.bindImportToSurface(id, bufferId, cached);
      // No longer pending an install.
      this.dmabufPending.delete(bufferId);
    }

    return true;
  }

  // wp_linux_drm_syncobj_v1: record the release point for `bufferId`. Signaled
  // when the client-buffer-lifecycle emits sendWlRelease for the same bufferId
  // (mirroring wl_buffer.release semantics: buffer is superseded AND its last
  // GPU sample is done). Replaces any prior release point for this bufferId
  // (the spec says a repeated set_release_point on the same commit cycle
  // replaces the prior; we extend that to "the latest commit using this
  // bufferId wins" which is what kitty actually does -- it cycles a pool of
  // buffers, each commit's release_point is fresh).
  setBufferReleasePoint(bufferId: number, handle: number,
                        pointHi: number, pointLo: number): void {
    this.bufferIdToSyncobjRelease.set(bufferId, { handle, pointHi, pointLo });
  }

  // Wire a (possibly-just-imported) cached GPU import into the given surface:
  // (re)build the view + bind group, mark present, and announce the surface as
  // having new content this frame.
  private bindImportToSurface(id: number, bufferId: number, imp: DmabufImport): void {
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }
    s.currentBufferId = bufferId;
    s.texture = imp.tex;
    s.view = imp.view;
    s.width = imp.width;
    s.height = imp.height;
    // rebuildBindGroup keeps sampling the snapshot while frozen; the live view
    // is stored for thaw. A new drawable buffer on a frozen surface is the
    // re-render the WM's held resize is waiting for -- poke it to re-check.
    this.rebuildBindGroup(s, imp.view);
    s.present = true;
    this.imported.push({ id, width: imp.width, height: imp.height });
    this.damageSurface(id);  // new dmabuf content -> repaint this surface's rect
    if (s.frozen) this.frozenReadyCb?.(id);
  }

  // Allocate (lazily) the per-surface uniform buffer + rebuild the bind group
  // bound to `view` plus the surface's current mask (or the default-white
  // mask). Called whenever the sampled view or the mask view changes.
  private rebuildBindGroup(s: Surface, view: GPUTextureView): void {
    if (!s.uniformBuf) {
      s.uniformBuf = this.device.createBuffer({
        size: UNIFORM_BYTES,
        usage: this.g.GPUBufferUsage.UNIFORM | this.g.GPUBufferUsage.COPY_DST,
      });
    }
    // Phase 10a: when an intercept is active for this surface, sample
    // the plugin's output instead of the client texture. Callers that
    // update the client view still call rebuildBindGroup with that
    // view; this chokepoint substitutes the intercept view when
    // present. installInterceptOutput passes the intercept view
    // directly (the substitution here is a no-op for that path).
    // A frozen surface samples its captured snapshot; an intercept samples the
    // plugin output; otherwise the client view.
    const sampledView = s.frozen?.view ?? s.interceptOutputView ?? view;
    const mask = s.maskView ?? this.defaultMaskView;
    s.bindGroup = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: sampledView },
        { binding: 2, resource: { buffer: s.uniformBuf } },
        { binding: 3, resource: this.maskSampler },
        { binding: 4, resource: mask },
      ],
    });
  }

  // Run the intents the lifecycle just emitted. The executor is intentionally
  // dumb: it has no policy of its own. Layer B implements importBuffer +
  // releaseImport + sendWlRelease; beginAccess + endAccess are stubs filled in
  // by Layer C (the cross-process per-frame Begin/End bracket).
  private dispatch(intents: LifecycleIntent[]): void {
    for (const i of intents) this.runIntent(i);
  }

  private runIntent(intent: LifecycleIntent): void {
    switch (intent.kind) {
      case "importBuffer": this.runImportBuffer(intent.bufferId); break;
      case "releaseImport": this.runReleaseImport(intent.bufferId); break;
      case "sendWlRelease": {
        this.freed.push(intent.bufferId);
        // wp_linux_drm_syncobj_v1: signal the recorded release point in the
        // SAME atomic step the wire layer sends wl_buffer.release. Same
        // semantic ("buffer free for reuse"), driven by the same lifecycle
        // event. If this bufferId has no explicit-sync release point
        // (implicit-sync client), the map miss is the no-op fallback.
        const rp = this.bufferIdToSyncobjRelease.get(intent.bufferId);
        if (rp) {
          this.bufferIdToSyncobjRelease.delete(intent.bufferId);
          this.addon.syncobjTimelineSignal(rp.handle, rp.pointHi, rp.pointLo);
        }
        break;
      }
      case "beginAccess":
      case "endAccess":
        // The actual GPU-process BeginAccess/EndAccess are written in-band in
        // renderFrame() (writeBeginAccess before the sample, writeEndAccess
        // after the submit). They are not driven from here: renderFrame writes
        // the Begin frame and only THEN feeds frameSampled, so the lifecycle
        // intents are informational. They record the LOGICAL contract the unit
        // tests verify (alternation, chain-fence threading), while the wire
        // frames enforce the actual GPU-side bracket ordering.
        break;
    }
  }

  // Async addon call to import the client dmabuf. On completion the wrapped
  // wire texture is cached and any pending surface installs are bound.
  private runImportBuffer(bufferId: number): void {
    if (this.dmabufImports.has(bufferId)) return;  // defensive: never re-import
    const pending = this.dmabufPending.get(bufferId);
    if (!pending) {
      log.warn("core", `js-compositor: importBuffer(${bufferId}) without pending descriptor (executor/state-machine drift)`);
      return;
    }
    const dawn = this.dawn;
    if (!dawn || this.deviceHandle === 0n) {
      this.dispatch(this.lifecycle.step({
        kind: "accessFailed", bufferId, reason: "no dawn wire / deviceHandle",
      }));
      return;
    }
    const importId = this.addon.createTextureFromDmabuf(
      pending.fd, pending.width, pending.height, pending.fourcc,
      pending.modHi, pending.modLo, pending.offset, pending.stride,
      (handle) => {
        const p = this.dmabufPending.get(bufferId);
        if (handle === null) {
          // The native import failed (modifier mismatch, bad dmabuf, etc).
          // Release the importId reservation; poison the buffer in the
          // state machine; subsequent samples are skipped (surface stays
          // last-good).
          if (importId) this.addon.releaseDmabufImport(importId);
          if (p) this.dmabufPending.delete(bufferId);
          this.dispatch(this.lifecycle.step({
            kind: "accessFailed", bufferId, reason: "createTextureFromDmabuf returned null",
          }));
          return;
        }
        const tex = dawn.wrapTexture(this.deviceHandle, handle);
        const view = tex.createView();
        const imp: DmabufImport = {
          tex, view, width: pending.width, height: pending.height, importId,
        };
        this.dmabufImports.set(bufferId, imp);
        // Tell the lifecycle the buffer transitioned Importing -> Imported.
        // A bufferDestroyed (or surfaceRemoved-drain) that arrived while
        // Importing left importOwed=true; the lifecycle's maybeFlush fires
        // the deferred releaseImport now via this dispatch, and the
        // executor's releaseImport (below) releases the just-cached import.
        // Without this event the late callback would silently stash an
        // unreachable import (leaking its native importId for the lifetime
        // of the run).
        this.dispatch(this.lifecycle.step({ kind: "importCompleted", bufferId }));
        // Bind to every surface that was waiting for this import.
        if (p) {
          for (const sid of p.pendingInstalls) this.bindImportToSurface(sid, bufferId, imp);
          this.dmabufPending.delete(bufferId);
        }
      });
    if (importId === 0) {
      // Synchronous failure to start the import (addon refused). Treat the
      // same as the async-null callback.
      this.dmabufPending.delete(bufferId);
      this.dispatch(this.lifecycle.step({
        kind: "accessFailed", bufferId, reason: "createTextureFromDmabuf returned 0",
      }));
    }
  }

  private runReleaseImport(bufferId: number): void {
    const imp = this.dmabufImports.get(bufferId);
    if (!imp) {
      // releaseImport fired for a buffer whose async import never resolved
      // (accessFailed path also clears dmabufPending; nothing to do).
      this.dmabufPending.delete(bufferId);
      return;
    }
    this.dmabufImports.delete(bufferId);
    // Detach from any surfaces still pointing at this import. Without this, a
    // surface whose bufferDestroyed fired (or whose buffer was the destroyed
    // wl_buffer at the moment its own surfaceRemoved drained) keeps a stale
    // GPUTexture reference; the next frame would try to sample a freed import.
    for (const s of this.surfaces.values()) {
      if (s.currentBufferId === bufferId) {
        s.currentBufferId = 0;
        s.texture = null;
        s.view = null;
        s.bindGroup = null;
        s.present = false;
      }
    }
    // wp_linux_drm_syncobj_v1: the buffer is going away without a normal
    // release path (bufferDestroyed or surfaceRemoved teardown). Per spec
    // "release point delivery is undefined" once the surface is gone or
    // wl_buffer is destroyed without release; drop the recorded point.
    // (We do NOT signal it -- the client tore down the buffer; nothing is
    // waiting on the point.) Without this, the map leaks one entry per
    // destroyed buffer over the run.
    this.bufferIdToSyncobjRelease.delete(bufferId);
    // Same for any pending acquire fence stashed for a buffer that never got
    // sampled (e.g. the surface tore down before the import resolved). Close
    // the fence fd so we do not leak it.
    const stale = this.bufferIdToAcquireFenceFd.get(bufferId);
    if (stale) {
      if (!stale.closed) { try { stale.close(); } catch { /* */ } }
      this.bufferIdToAcquireFenceFd.delete(bufferId);
    }
    // Native release: drops the server-side STM + texture + dmabuf fd.
    if (imp.importId !== 0) this.addon.releaseDmabufImport(imp.importId);
  }

  // The wire layer (src/protocols/wl_buffer.ts) calls this from the wl_buffer
  // destroy handler and from the disconnect sweep. It's the cache-invalidation
  // trigger -- the ONLY (along with surfaceRemoved) path that releases a
  // cached GPU import per rule A.
  notifyBufferDestroyed(bufferId: number): void {
    this.dispatch(this.lifecycle.step({ kind: "bufferDestroyed", bufferId }));
  }

  // Install a pre-wrapped wire texture (e.g. a plugin overlay's consumer texture,
  // dual-imported dmabuf on the core device) as surface `id`'s sampled texture.
  // Unlike commitSurfaceDmabuf this does no import (the GPU process already did
  // it + the core wrapped the injected handle); it just (re)builds the bind group.
  // The plugin/overlay layer placement is set separately (setSurfaceLayout +
  // setLayerSurfaces). Idempotent per frame (same texture handle reused).
  setSurfaceTexture(id: number, tex: GPUTexture, w: number, h: number): void {
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }
    if (s.texture === tex && s.bindGroup) { s.present = true; return; }
    s.texture = tex;
    s.width = w; s.height = h;
    const view = tex.createView();
    s.view = view;
    this.rebuildBindGroup(s, view);
    s.present = true;
    this.damageSurface(id);  // new overlay/cursor content -> repaint its rect
  }

  takeImportedSurfaces(): Array<{ id: number; width: number; height: number }> {
    const out = this.imported;
    this.imported = [];
    return out;
  }

  // Which output ids does the surface currently overlap? Used by the per-output
  // frame-callback dispatch: a surface on a 60Hz output gets wl_callback.done
  // at 60Hz; a surface spanning two outputs gets `done` from EITHER output's
  // flip-complete (the spec allows either, but in practice the faster one
  // dominates -- per spec, returning the slowest would be ideal but adds
  // bookkeeping). Returns empty if the surface has no layout rect yet or
  // overlaps no output (unmapped / off-screen). The placement uses the same
  // (s.x, s.y, s.layoutW, s.layoutH) the composite reads, so a surface that
  // would draw on output N is counted as resident on output N.
  surfaceOutputs(surfaceId: number): number[] {
    const s = this.surfaces.get(surfaceId);
    if (!s) return [];
    const w = s.layoutW > 0 ? s.layoutW : s.width;
    const h = s.layoutH > 0 ? s.layoutH : s.height;
    // Surface has no extent yet (no commit, no layout): pre-buffer-frame
    // request, an unplaced subsurface, or similar. Return every output so
    // wl_callback.done fires on the next flip-complete regardless of where
    // the surface eventually lands; otherwise a client driving its render
    // loop off `frame` would never see its first `done` and stall before
    // committing a buffer.
    if (w <= 0 || h <= 0) {
      return [...this.outputsGeom.keys()];
    }
    const sx0 = s.x;
    const sy0 = s.y;
    const sx1 = sx0 + w;
    const sy1 = sy0 + h;
    const out: number[] = [];
    for (const o of this.outputsGeom.values()) {
      const scale = o.scale > 0 ? o.scale : 1;
      const ox0 = o.logicalX;
      const oy0 = o.logicalY;
      const ox1 = o.logicalX + o.deviceWidth / scale;
      const oy1 = o.logicalY + o.deviceHeight / scale;
      if (sx0 < ox1 && sx1 > ox0 && sy0 < oy1 && sy1 > oy0) out.push(o.id);
    }
    // Mapped but placed off-screen / outside every output's region: fall back
    // to every output so the client doesn't hang. Real off-screen surfaces are
    // rare; correctness > optimal pacing for the degenerate case.
    if (out.length === 0) return [...this.outputsGeom.keys()];
    return out;
  }

  // dmabuf buffers freed since the last call (their last sampling frame completed
  // on the GPU). shm buffers are copied at upload, so they never appear here.
  takeFreedBuffers(): number[] {
    const out = this.freed;
    this.freed = [];
    return out;
  }

  // Run `cb` once the compositing submit currently in flight (the latest issued)
  // has completed on the GPU -- i.e. after any frame that may have sampled a
  // surface's now-superseded consumer slot is done reading it. If no submit is
  // outstanding, runs on the next completion (a frame is always coming). Used by
  // the plugin/overlay ring to recycle a consumer slot without racing the GPU read.
  afterCurrentFrame(cb: () => void): void {
    this.afterFrame.push({ serial: this.submitSerial, cb });
  }

  private runAfterFrame(): void {
    if (this.afterFrame.length === 0) return;
    const keep: Array<{ serial: number; cb: () => void }> = [];
    for (const e of this.afterFrame) {
      if (e.serial <= this.completedSerial) {
        try { e.cb(); } catch (err) { log.warn("core", "js-compositor: afterCurrentFrame cb threw %o", err); }
      } else {
        keep.push(e);
      }
    }
    this.afterFrame = keep;
  }

  // Upload raw BGRA8 pixels (tightly `stride`-rowed) into the surface's sampled
  // texture, creating/recreating it on size change. Used by uploadShm and by
  // tests / future producers that supply pixels directly.
  uploadPixels(id: number, c: { width: number; height: number; stride: number },
               data: ArrayBuffer | ArrayBufferView,
               damage?: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): void {
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }

    let tex = s.texture;
    let recreated = false;
    if (!tex || s.width !== c.width || s.height !== c.height) {
      recreated = true;
      if (tex) tex.destroy();
      // Sampled client textures are always BGRA8 (shm ARGB8888 byte-for-byte;
      // dmabuf imported as BGRA8Unorm), independent of the output format.
      tex = this.device.createTexture({
        size: { width: c.width, height: c.height },
        format: "bgra8unorm",
        // COPY_SRC is required by the Phase 10a Worker intercept's
        // input-leg copy (core copies the client texture into a dmabuf
        // the plugin samples). Keeping it always-on is cheap; the
        // alternative (re-create texture with COPY_SRC when an
        // intercept matches) means a one-frame flash + texture
        // churn.
        usage: this.g.GPUTextureUsage.TEXTURE_BINDING
             | this.g.GPUTextureUsage.COPY_DST
             | this.g.GPUTextureUsage.COPY_SRC,
      });
      s.texture = tex;
      const view = tex.createView();
      s.view = view;
      s.width = c.width;
      s.height = c.height;
      this.rebuildBindGroup(s, view);
    }

    // A freshly (re)created texture has no prior contents, so a damage-only
    // upload would leave the undamaged region undefined: force a full upload.
    if (recreated || !damage || damage.length === 0) {
      // `data` begins at the buffer's first pixel row, so dataLayout offset is 0.
      this.device.queue.writeTexture(
        { texture: tex },
        data,
        { offset: 0, bytesPerRow: c.stride, rowsPerImage: c.height },
        { width: c.width, height: c.height },
      );
    } else {
      // Partial upload: one writeTexture per damage rect. The undamaged region
      // retains the previous frame's pixels (the texture is persistent). Each
      // rect's source slice starts at its top-left pixel; bytesPerRow stays the
      // full buffer stride so successive rows are found correctly (BGRA8, 4 B/px).
      for (const r of damage) {
        this.device.queue.writeTexture(
          { texture: tex, origin: { x: r.x, y: r.y } },
          data,
          { offset: r.y * c.stride + r.x * 4, bytesPerRow: c.stride, rowsPerImage: r.height },
          { width: r.width, height: r.height },
        );
      }
    }
    s.present = true;
    this.damageSurface(id);
    if (s.frozen) this.frozenReadyCb?.(id);
  }

  // --- Composite-scissor damage -------------------------------------------

  // Mark every output's tracked slots stale: the next frame on any slot of
  // any output repaints fully. Used for changes that can affect arbitrary
  // screen regions (stack reorders, per-surface fx, output resize).
  private damageFull(): void {
    this.outputDamage.full();
  }

  // Accumulate a GLOBAL-logical-space rect into the damage rings of every
  // output it overlaps (the map clips into each output's local space).
  // Rects entirely outside the union are silent no-ops.
  private addOutputDamage(x: number, y: number, w: number, h: number): void {
    this.outputDamage.damageRect(x, y, w, h);
  }

  // Damage a surface's current on-screen rect (placement). Content commits and
  // buffer scale/transform changes route here. If the surface's fx can draw
  // outside its nominal rect (transform / margin / mask), repaint the whole
  // output instead -- the rect would undercount the affected region.
  private damageSurface(id: number): void {
    const s = this.surfaces.get(id);
    if (!s) return;
    const fx = s.fx;
    if (fx.translateX !== 0 || fx.translateY !== 0 || fx.scaleX !== 1 || fx.scaleY !== 1
      || fx.marginTop !== 0 || fx.marginRight !== 0 || fx.marginBottom !== 0 || fx.marginLeft !== 0
      || s.maskView !== null) {
      this.damageFull();
      return;
    }
    this.addOutputDamage(s.x, s.y, s.layoutW, s.layoutH);
  }

  // The 1x1 opaque-black quad used to clear a scissored region to black.
  private ensureBlackFill(): Surface {
    if (this.blackFill && this.blackFill.bindGroup) return this.blackFill;
    const tex = this.device.createTexture({
      size: { width: 1, height: 1 },
      format: "bgra8unorm",
      usage: this.g.GPUTextureUsage.TEXTURE_BINDING | this.g.GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: tex }, new Uint8Array([0, 0, 0, 255]),
      { offset: 0, bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1 },
    );
    const s = blankSurface(0, 0, 0, 0);
    s.texture = tex;
    s.view = tex.createView();
    s.width = 1; s.height = 1; s.present = true;
    this.rebuildBindGroup(s, s.view);
    this.blackFill = s;
    return s;
  }

  // Pack the per-surface render state (placement + transform + margin + fx +
  // cropUV) into the WGSL Uniforms struct and upload. Normalizes all output-
  // pixel quantities to [0,1] target space; the shader needs no target dims.
  //
  // ow/oh are the dimensions of the render target this surface will be drawn
  // into -- the on-screen output for renderFrame, an arbitrary compose
  // texture for compose calls.
  //
  // overrides (optional, compose-only): when present, the surface's nominal
  // placement (xywh) and/or sampled crop region (UV) are replaced by the
  // caller-supplied values for this draw only. compose.windows uses both:
  // placement = {0,0,outW,outH} so the cropped region fills the per-window
  // texture; cropUV = normalized source-crop pixel coords. compose.scene
  // passes neither, falling through to the on-screen behavior.
  private updateUniforms(
    s: Surface, ow: number, oh: number,
    overrides?: {
      placement?: { x: number; y: number; w: number; h: number };
      cropUV?: { u0: number; v0: number; u1: number; v1: number };
    },
    // When set, placement is in the GLOBAL logical space and is shifted by the
    // output's logical origin so it lands at the correct device position within
    // this output's target. Absent for origin-anchored offscreen targets.
    output?: OutputCtx,
  ): void {
    if (!s.uniformBuf) return;
    // A surface fills its WM-assigned tile (layoutW/layoutH), falling back to
    // its intrinsic logical size when it has no layout (subsurface, overlay,
    // cursor). Intrinsic logical size precedence (wp_viewport): destination
    // size wins; else the source crop's size (the crop rect is in surface
    // coords, so its dimensions are already logical -- a non-integer src here
    // is bad_size, silent-dropped); else buffer dims / buffer scale (so a HiDPI
    // buffer is placed at its logical extent, not its device extent).
    const bs = s.bufferScale || 1;
    // 90/270 (and their flipped variants) swap the buffer's axes relative to
    // the surface, so the buffer-derived logical size uses swapped dims. A
    // viewport dst/src is already in (post-transform) surface coords.
    const swapAxes = s.bufferTransform === 1 || s.bufferTransform === 3
      || s.bufferTransform === 5 || s.bufferTransform === 7;
    const bw = swapAxes ? s.height : s.width;
    const bh = swapAxes ? s.width : s.height;
    const intrinsicW = s.viewportDst?.width ?? s.viewportSrc?.width ?? bw / bs;
    const intrinsicH = s.viewportDst?.height ?? s.viewportSrc?.height ?? bh / bs;
    const ox = output ? output.originX : 0;
    const oy = output ? output.originY : 0;
    const px = (overrides?.placement?.x ?? s.x) - ox;
    const py = (overrides?.placement?.y ?? s.y) - oy;
    const pw = overrides?.placement?.w ?? (s.layoutW || intrinsicW);
    const ph = overrides?.placement?.h ?? (s.layoutH || intrinsicH);
    const fx = s.fx;
    const data = new Float32Array(UNIFORM_FLOATS);
    // placement
    data[0] = px / ow; data[1] = py / oh;
    data[2] = pw / ow; data[3] = ph / oh;
    // transform: translate (normalized output coords); scale (unitless)
    data[4] = fx.translateX / ow; data[5] = fx.translateY / oh;
    data[6] = fx.scaleX;          data[7] = fx.scaleY;
    // margin: top/right/bottom/left (normalized output coords)
    data[8]  = fx.marginTop    / oh;
    data[9]  = fx.marginRight  / ow;
    data[10] = fx.marginBottom / oh;
    data[11] = fx.marginLeft   / ow;
    // A frozen surface draws its snapshot, which already baked in the buffer
    // transform + crop, so it samples full with no transform. Otherwise the
    // client buffer's transform applies.
    const frozenDraw = !!s.frozen && !overrides;
    // fx: opacity in x; buffer-transform code (0..7) in y; rest reserved
    data[12] = fx.opacity;
    data[13] = frozenDraw ? 0 : (s.bufferTransform || 0);
    // cropUV: u0, v0, u1, v1 (defaults identity = full surface texture). A
    // wp_viewport source rect (surface coords) crops the sampled buffer;
    // computed from current buffer dims so it survives a buffer resize.
    let cu = overrides?.cropUV;
    if (!frozenDraw && !cu && s.viewportSrc && s.width > 0 && s.height > 0) {
      const W = s.width, H = s.height;
      cu = {
        u0: (s.viewportSrc.x * bs) / W, v0: (s.viewportSrc.y * bs) / H,
        u1: ((s.viewportSrc.x + s.viewportSrc.width) * bs) / W,
        v1: ((s.viewportSrc.y + s.viewportSrc.height) * bs) / H,
      };
    }
    data[16] = cu?.u0 ?? 0; data[17] = cu?.v0 ?? 0;
    data[18] = cu?.u1 ?? 1; data[19] = cu?.v1 ?? 1;
    // tint: r, g, b, a (defaults identity = (1,1,1,1))
    data[20] = fx.tintR; data[21] = fx.tintG;
    data[22] = fx.tintB; data[23] = fx.tintA;
    // colorMatrix: 4 column vectors of 4 components each (mat4x4f, column-major)
    data.set(fx.colorMatrix, 24);
    // shape: (kind, sizeXpx, sizeYpx, radius) + shapeExtra (4 params per kind).
    // The SDF evaluates in surface-LOGICAL pixel space; pw/ph are already in
    // logical pixels (the placement is in logical output coords, not device).
    // Frozen surfaces sample the snapshot at the same on-screen rect; the
    // shape applies the same way.
    packShape(data, fx.shape, pw, ph);
    this.device.queue.writeBuffer(s.uniformBuf, 0, data);
  }

  // Open per-frame dmabuf import brackets for every surface in `drawList`
  // that has a live dmabuf import. Appends to `bracketed`; de-dupes on
  // importId so an import shared across multiple draw lists (on-screen +
  // live composers) opens exactly one Begin. Dispatches frameSampled to
  // the lifecycle exactly once per import for the same reason.
  //
  // Wire ordering: each writeBeginAccess flushes staged Dawn bytes first,
  // so the on-wire layout is [begin...][sample submit batch][end...] --
  // every bracket is open by the time the GPU process's HandleCommands
  // decodes the samples.
  private openImportBrackets(
    drawList: number[],
    bracketed: Array<{ importId: number; bufferId: number }>,
  ): void {
    for (const id of drawList) {
      const s = this.surfaces.get(id);
      if (!s || !s.present || !s.bindGroup) continue;
      // A frozen surface samples its snapshot, not the client buffer -- no
      // bracket (and no frameSampled) for its import this frame.
      if (s.frozen) continue;
      if (s.currentBufferId === 0) continue;  // shm or plugin overlay; no lifecycle
      const imp = this.dmabufImports.get(s.currentBufferId);
      if (!imp) continue;  // import not yet resolved (async); will draw next frame
      // De-dupe: an import already opened for an earlier draw list (or earlier
      // surface in this list) gets one Begin per frame. The GPU process's
      // ClientTex.accessOpen invariant forbids two Begins without an End.
      if (bracketed.some((b) => b.importId === imp.importId)) continue;
      // The dmabufImports gate above already proved the import is live (its
      // handle was installed only after the GPU process applied the inject).
      // writeBeginAccess therefore must succeed; a false return means the
      // JS-side import gate and the core's jsImportHandles_ map have desynced
      // -- a contract violation, not a recoverable per-frame condition.
      //
      // wp_linux_drm_syncobj_v1: if the surface has an explicit-sync acquire
      // fence stashed from the most recent commit, hand it to the GPU process
      // via writeBeginAccessWithFence. The GPU process then waits on THAT
      // sync_file as the acquire fence instead of running EXPORT_SYNC_FILE on
      // the dmabuf (the implicit-sync path) -- this is the fix for clients
      // like the NVIDIA proprietary driver that don't attach implicit fences.
      // Consumed one-shot per commit; an explicit fence covers one Begin.
      let beginOk: boolean;
      // Consume a per-buffer acquire fence if one is pending for THIS bufferId.
      // The fence is one-shot per commit: kitty signals the acquire timeline
      // point when its GPU writes complete; once Dawn waits on it for our
      // first sample of the buffer, no later sample of the same buffer needs
      // a fence (the dmabuf isn't being written until the client re-commits).
      const fenceFd = this.bufferIdToAcquireFenceFd.get(s.currentBufferId);
      if (fenceFd && !fenceFd.closed) {
        this.bufferIdToAcquireFenceFd.delete(s.currentBufferId);
        beginOk = this.addon.writeBeginAccessWithFence(imp.importId, fenceFd);
      } else {
        beginOk = this.addon.writeBeginAccess(imp.importId);
      }
      if (!beginOk) {
        throw new Error(
          `writeBeginAccess returned false for live import ` +
          `(bufferId=${s.currentBufferId}, importId=${imp.importId}): ` +
          `dmabufImports gate / core handle map desync`,
        );
      }
      this.dispatch(this.lifecycle.step({ kind: "frameSampled", surfaceId: id }));
      bracketed.push({ importId: imp.importId, bufferId: s.currentBufferId });
    }
  }

  // Close every bracket opened by openImportBrackets for this frame. Writes
  // EndAccess in the same order Begins were written; the wire FIFO closes
  // each bracket only after the GPU process has decoded the intervening
  // sample commands. The endAccessFenceExported sentinel satisfies the
  // state machine's chain-fence invariant (real fence lives in the GPU
  // process and is chained intra-process).
  private closeImportBrackets(
    bracketed: ReadonlyArray<{ importId: number; bufferId: number }>,
  ): void {
    for (const { importId, bufferId } of bracketed) {
      this.addon.writeEndAccess(importId);
      this.dispatch(this.lifecycle.step({
        kind: "endAccessFenceExported", bufferId,
        fence: { kind: "syncFile", fd: -1 },
      }));
    }
  }

  // Encode one render pass: clear black, draw each surface in `drawList`
  // back-to-front into `targetView` with placement normalized to (outW,outH).
  // Pure pass-encoder -- no submit, no lifecycle calls, no bracket management.
  // Multiple calls within one frame share a single command encoder + submit
  // and share one set of import brackets opened around them.
  //
  // placements / cropUV are per-call overrides (compose-only); when absent
  // the surface's stored placement and identity cropUV are used. compose.
  // windows passes both to render a sub-region of a surface into a
  // crop-sized texture; compose.scene passes neither.
  private composite(args: {
    encoder: GPUCommandEncoder;
    targetView: GPUTextureView;
    drawList: number[];
    outW: number;
    outH: number;
    placements?: Map<number, { x: number; y: number; w: number; h: number }>;
    cropUV?: Map<number, { u0: number; v0: number; u1: number; v1: number }>;
    // Composite-scissor: when `scissor` is set, the pass loads (preserves) the
    // target outside the box and redraws only inside it; a black-fill quad
    // clears the box first so the stack blends against black. The box is in
    // output LOGICAL coords. Absent = full-frame clear (the default).
    scissor?: { x: number; y: number; w: number; h: number };
    // On-screen output context. When set, surface placement subtracts this
    // output's logical origin and the scissor uses this output's scale +
    // device dims. Absent for offscreen/compose targets (live scenes, window
    // crops, freeze snapshots), which sit at the origin with no per-output map.
    output?: OutputCtx;
  }): void {
    const out = args.output;
    const scale = out ? out.scale : this.scale;
    const devW = out ? out.deviceWidth : this.width;
    const devH = out ? out.deviceHeight : this.height;
    const partial = !!args.scissor;
    const pass = args.encoder.beginRenderPass({
      colorAttachments: [{
        view: args.targetView,
        loadOp: partial ? "load" : "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    if (args.scissor) {
      // The scissor box is in this output's LOGICAL coords; shift to the
      // output-local logical origin, then to device px (the attachment's space).
      const lx = args.scissor.x - (out ? out.originX : 0);
      const ly = args.scissor.y - (out ? out.originY : 0);
      const sx = Math.max(0, Math.floor(lx * scale));
      const sy = Math.max(0, Math.floor(ly * scale));
      const sw = Math.min(devW - sx, Math.ceil(args.scissor.w * scale));
      const sh = Math.min(devH - sy, Math.ceil(args.scissor.h * scale));
      pass.setScissorRect(sx, sy, Math.max(0, sw), Math.max(0, sh));
      // Clear the scissored box to black (loadOp:load preserved old pixels).
      const black = this.ensureBlackFill();
      if (black.bindGroup) {
        this.updateUniforms(black, args.outW, args.outH,
          { placement: args.scissor }, out);
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, black.bindGroup);
        pass.draw(4);
      }
    }
    pass.setPipeline(this.pipeline);
    for (const id of args.drawList) {
      const s = this.surfaces.get(id);
      if (s && s.present && s.bindGroup) {
        // Placement override priority: caller-supplied `placements` map
        // (compose paths use this for crop) > per-surface intercept
        // placement (Phase 10a outputRect) > surface's natural rect.
        const placement = args.placements?.get(id)
          ?? s.interceptPlacement ?? undefined;
        const cropUV = args.cropUV?.get(id);
        this.updateUniforms(s, args.outW, args.outH,
          placement || cropUV ? { placement, cropUV } : undefined, out);
        pass.setBindGroup(0, s.bindGroup);
        pass.draw(4);
      }
    }
    pass.end();
  }

  // Composite one on-screen frame: open import brackets, encode the pass,
  // submit, close brackets. Nested (slice 3) renders into the host
  // swapchain's current texture and presents; headless renders into the
  // offscreen target (read via readback()).
  //
  // Lifecycle wiring: frameStart at top; frameSampled per drawn dmabuf
  // surface (drives Layer C's per-frame BeginAccess); submitted after
  // queue.submit (drives EndAccess); gpuCompleted on onSubmittedWorkDone
  // (drives release intents). The early-return paths emit frameAborted so
  // the lifecycle's open begin is rolled back without leaving a dangling
  // access bracket.
  renderFrame(): void {
    let frameOpen = false;

    // One render target per output. Nested/KMS: acquire each output's scanout
    // texture (skip the ones whose ring has no free slot this frame). Headless:
    // a single offscreen target at output 0. Each entry carries the per-output
    // transform (origin + scale + dims) so a surface at global-logical (lx, ly)
    // lands at device ((lx - originX) * scale, (ly - originY) * scale).
    //
    // Pacing: each output renders + presents on its OWN vblank. Every output
    // with a free scanout slot is rendered this pass; a busy output (ring full
    // mid-flip) is skipped and serviced when its own flip-complete frees a
    // slot. Per-output composite-scissor damage (see OutputDamageRing) keeps
    // the per-pixel cost cheap when nothing changed on a given output.
    const targets: Array<{
      ctx: OutputCtx;
      view: GPUTextureView;
      tex: GPUTexture | null;  // wrapped scanout texture to drop after present
      present: boolean;
      scissor?: { x: number; y: number; w: number; h: number };
    }> = [];

    if (this.headless) {
      if (!this.targetView) return;  // headless before the target exists
      const o = this.outputsGeom.get(OUTPUT_DEFAULT);
      if (!o) return;
      targets.push({
        ctx: this.outputCtx(o),
        view: this.targetView,
        tex: null,
        present: false,
        scissor: this.takeScissor(o, JsCompositor.HEADLESS_DAMAGE_KEY),
      });
    } else {
      if (!this.dawn) return;
      const outs = [...this.outputsGeom.values()].sort((a, b) => a.id - b.id);
      for (const o of outs) {
        const handle = this.addon.acquireOutputTexture(o.id);
        // The native addon returns nullptr from N-API on "no slot available"
        // (no FREE scanout in KMS mode; no swapchain texture in nested-host
        // mode); that arrives in JS as undefined, not null. Both mean "skip
        // this output this frame" -- its ring slot is busy. Its own flip-
        // complete will re-trigger the frame loop.
        if (handle === null || handle === undefined) continue;
        const tex = this.dawn.wrapTexture(this.deviceHandle, handle);
        targets.push({
          ctx: this.outputCtx(o),
          view: tex.createView(),
          tex,
          present: true,
          // Composite-scissor: keyed by the stable per-slot output handle so
          // each output gets its own damage accounting.
          scissor: this.takeScissor(o, handle),
        });
      }
      // Every output's ring was busy this frame -- nothing to present, and the
      // lifecycle/bracket machinery would otherwise open a frame with no draw.
      if (targets.length === 0) return;
    }

    this.dispatch(this.lifecycle.step({ kind: "frameStart" }));
    frameOpen = true;

    // Per-output draw lists (per-output content stacks via setOutputStack).
    // Outputs with an active transition contribute NO surfaces to the import-
    // bracket union -- their transition pass samples compose-output textures,
    // not client dmabufs. Outputs without a transition contribute their full
    // draw list; the union is de-duplicated so each importId opens exactly
    // one Begin (openImportBrackets also de-dupes; this dedup keeps the
    // union itself cheap).
    const drawByOutput = new Map<number, number[]>();
    const bracketUnion: number[] = [];
    {
      const seen = new Set<number>();
      for (const t of targets) {
        const d = this.drawOrder(t.ctx.id);
        drawByOutput.set(t.ctx.id, d);
        if (this.activeTransitions.has(t.ctx.id)) continue;
        for (const id of d) if (!seen.has(id)) { seen.add(id); bracketUnion.push(id); }
      }
    }
    const bracketed: Array<{ importId: number; bufferId: number }> = [];

    // Per-frame transition bracket dedup. Scene producer Begin/End fires once
    // per unique sceneId across all per-output transitions this frame
    // (b->a on output 0 + c->b on output 1 share b -- one Begin, one End).
    const openedScenes = new Set<number>();
    const pendingEnds = new Map<number, () => void>();

    try {
      // Brackets cover the UNION of imports sampled on the on-screen passes
      // of NON-TRANSITIONING outputs plus every live composer's window list.
      // openImportBrackets de-dupes on importId so any import shared across
      // these lists opens exactly one Begin (the GPU process forbids two
      // Begins without an End).
      //
      // Bracket opening lives INSIDE the try so a throw from writeBeginAccess
      // (the JS-gate vs core-handle desync at openImportBrackets) or from the
      // lifecycle's frameSampled dispatch (alternation violation) drops into
      // the catch below. Without that, the lifecycle's frameStart was
      // dispatched but never paired with frameAborted, and every subsequent
      // renderFrame throws "frame already in flight" forever.
      if (bracketUnion.length > 0) {
        this.openImportBrackets(bracketUnion, bracketed);
      }
      for (const ls of this.liveScenes) this.openImportBrackets(ls.windows, bracketed);
      for (const lw of this.liveWindowComps) {
        this.openImportBrackets(lw.windows.map((w) => w.id), bracketed);
      }

      // On-screen pass: each output is either a transition pass or a normal
      // per-surface composite, decided per output. Each output is its OWN
      // encoder+submit because updateUniforms() writes per-surface uniform
      // buffers via queue.writeBuffer, and all writes within a single submit
      // land at the SAME GPU-timeline point. With one encoder for all
      // outputs, the cursor's uniform for output 0 was being overwritten by
      // output 1's value before either pass ran, so both passes drew with
      // output 1's transform. Per-output submit serializes the writes:
      // writeBuffer(o0) ; submit(pass0) ; writeBuffer(o1) ; submit(pass1) --
      // each pass sees its own values. GPU queue submits execute serially,
      // so the at-most-one-pending-flip and bracket invariants are unchanged.
      for (const t of targets) {
        const enc = this.device.createCommandEncoder();
        if (this.activeTransitions.has(t.ctx.id)) {
          const bindGroup = this.resolveTransitionFrame(
            t.ctx.id, openedScenes, pendingEnds);
          this.encodeTransitionInto(enc, t.view, bindGroup);
        } else {
          const d = drawByOutput.get(t.ctx.id);
          if (d === undefined) {
            throw new Error(
              `renderFrame: missing draw list for outputId=${t.ctx.id}`);
          }
          this.composite({
            encoder: enc, targetView: t.view, drawList: d,
            outW: t.ctx.logicalWidth, outH: t.ctx.logicalHeight,
            scissor: t.scissor, output: t.ctx,
          });
        }
        this.device.queue.submit([enc.finish()]);
      }
      // Live composers, in registration order. Each pass writes to its own
      // target texture and may sample any surface; for the same reason as
      // above, each gets its own submit so its uniform writes are isolated
      // from the previous pass's.
      for (const ls of this.liveScenes) {
        const enc = this.device.createCommandEncoder();
        this.composite({
          encoder: enc, targetView: ls.view, drawList: ls.windows,
          outW: ls.outW, outH: ls.outH,
        });
        this.device.queue.submit([enc.finish()]);
      }
      for (const lw of this.liveWindowComps) {
        for (const w of lw.windows) {
          // Same per-window crop / placement-override pattern as
          // composeWindows: render the surface filling the target,
          // sampling only the crop region.
          const placements = new Map([[w.id, { x: 0, y: 0, w: w.rect.w, h: w.rect.h }]]);
          const cropUV = w.surfW > 0 && w.surfH > 0
            ? new Map([[w.id, {
                u0: w.rect.x / w.surfW, v0: w.rect.y / w.surfH,
                u1: (w.rect.x + w.rect.w) / w.surfW,
                v1: (w.rect.y + w.rect.h) / w.surfH,
              }]])
            : undefined;
          const enc = this.device.createCommandEncoder();
          this.composite({
            encoder: enc, targetView: w.view, drawList: [w.id],
            outW: w.rect.w, outH: w.rect.h,
            placements, cropUV,
          });
          this.device.queue.submit([enc.finish()]);
        }
      }

      // Tag the submit; on GPU completion advance completedSerial and emit
      // gpuCompleted to the lifecycle (which fires deferred release intents).
      const serial = ++this.submitSerial;
      this.dispatch(this.lifecycle.step({ kind: "submitted", serial }));
      frameOpen = false;

      // Close the per-frame transition read brackets on the wire AFTER all
      // submits, one End per unique sceneId opened this frame (dedup
      // mirrors the per-frame Begin in resolveTransitionFrame). Order
      // within the map is irrelevant -- each End targets a distinct
      // surfaceBufId; the GPU process FIFO-orders per buf.
      if (pendingEnds.size > 0) {
        for (const endRead of pendingEnds.values()) {
          try { endRead(); }
          catch (e) { log.err("core", "js-compositor: transition endRead threw: %o", e); }
        }
        pendingEnds.clear();
      }

      this.closeImportBrackets(bracketed);

      this.device.queue.onSubmittedWorkDone().then(() => {
        if (serial > this.completedSerial) this.completedSerial = serial;
        const freedBefore = this.freed.length;
        this.dispatch(this.lifecycle.step({ kind: "gpuCompleted", serial }));
        this.runAfterFrame();
        // The gpuCompleted lifecycle step can emit sendWlRelease intents
        // (their bufferIds land in this.freed). Those are picked up only by
        // dispatchFrameCallbacks, which is driven from notifyFrame, which
        // is gated on wantNext. If the client has stopped committing because
        // it is waiting for THIS release (e.g. a 3-buffer pool with all in
        // our hands), nothing else will wake the loop -- a missed-release
        // deadlock. Force a wake so the next runFrameIfReady drains
        // freed[] via dispatchFrameCallbacks.
        if (this.freed.length > freedBefore) this.addon.wake();
      });

      // Phase 5b-live: invoke each registered live-producer callback. They
      // own their own SurfaceProducer + ring slot; each runs its own
      // writeProducerBegin / composeIntoView / writeProducerEnd as a
      // separate submit (since the per-buf brackets are FIFO-ordered with
      // their compose pass on the core wire; they can't share the
      // on-screen submit's encoder because their producer Begin would
      // sit before the on-screen samples and that's wrong ordering for
      // the GPU process's bracket-decode invariants).
      for (const cb of this.liveProducers) {
        try { cb(); }
        catch (e) { log.warn("core", "js-compositor: liveProducer threw: %o", e); }
      }

      // Present each acquired output and drop its wrapped scanout texture.
      for (const t of targets) {
        if (t.present) this.addon.presentOutput(t.ctx.id);
      }
      this.outputTex = null;
    } catch (e) {
      // If anything threw between frameStart and submitted, close any begin
      // brackets that DID open (the GPU process's wire-side Begin/End
      // alternation must stay paired even when JS bails mid-frame; partial
      // brackets leak the per-import accessOpen flag on the GPU side, which
      // refuses the next Begin) and roll back the lifecycle's open begin so
      // its invariant 2 (alternation) is preserved here too. closeImportBrackets
      // is a no-op on an empty list; the secondary try/catch swallows a
      // secondary throw so the original `e` propagates.
      try { this.closeImportBrackets(bracketed); }
      catch { /* secondary throw -- intentionally swallowed */ }
      // Same alternation invariant for transition Begin/End. resolveTransition-
      // Frame opens producer Begins keyed by sceneId and stashes their Ends in
      // pendingEnds before encoding; if anything between the first Begin and
      // the closeImportBrackets above threw, the Ends need to fire here to
      // close every bracket whose Begin opened.
      for (const endRead of pendingEnds.values()) {
        try { endRead(); }
        catch { /* secondary throw -- intentionally swallowed */ }
      }
      pendingEnds.clear();
      if (frameOpen) {
        try { this.dispatch(this.lifecycle.step({ kind: "frameAborted" })); }
        catch { /* secondary throw -- intentionally swallowed */ }
      }
      throw e;
    }
  }

  // Allocate a texture suitable as a compose target: same format as the
  // output, sampleable downstream by the plugin / for readback, plus
  // COPY_SRC so readbackTexture can read it.
  private allocComposeTexture(w: number, h: number): GPUTexture {
    return this.device.createTexture({
      size: { width: w, height: h },
      format: this.format,
      usage: this.g.GPUTextureUsage.RENDER_ATTACHMENT
           | this.g.GPUTextureUsage.TEXTURE_BINDING
           | this.g.GPUTextureUsage.COPY_SRC,
    });
  }

  // Snapshot compose primitive shared by composeScene and composeWindows.
  // Runs one composite pass into `targetView` with its own dmabuf bracket
  // open/close pair. Synchronous wrt the on-screen frame loop: the JS
  // event loop is single-threaded, so a snapshot returns before the next
  // tick. The lifecycle state machine is NOT driven by snapshots -- the
  // wire-level brackets are independent of the per-frame frameStart /
  // frameSampled / submitted / gpuCompleted cycle, which exists to track
  // client buffer release (an on-screen-only concern; what compose samples
  // doesn't affect what gets shown to the client).
  private composeSnapshot(args: {
    targetView: GPUTextureView;
    drawList: number[];
    outW: number;
    outH: number;
    placements?: Map<number, { x: number; y: number; w: number; h: number }>;
    cropUV?: Map<number, { u0: number; v0: number; u1: number; v1: number }>;
  }): void {
    const bracketed: Array<{ importId: number; bufferId: number }> = [];
    this.openImportBrackets(args.drawList, bracketed);
    try {
      const enc = this.device.createCommandEncoder();
      this.composite({
        encoder: enc,
        targetView: args.targetView,
        drawList: args.drawList,
        outW: args.outW, outH: args.outH,
        placements: args.placements,
        cropUV: args.cropUV,
      });
      this.device.queue.submit([enc.finish()]);
    } finally {
      this.closeImportBrackets(bracketed);
    }
  }

  // Render the listed windows into a fresh texture sized to (outW, outH).
  // Snapshot mode: one-shot, the texture is not refreshed after this call.
  // Windows are drawn in list order (back to front) using their current
  // per-surface state (placement, transform, mask, opacity); no crop.
  //
  // Caller owns the returned texture and must .destroy() it when done.
  composeScene(args: {
    outputId: number;
    windows: ReadonlyArray<number>;
    outW?: number;
    outH?: number;
  }): { texture: GPUTexture; outW: number; outH: number } {
    const outW = args.outW ?? this.logicalWidth;
    const outH = args.outH ?? this.logicalHeight;
    const texture = this.allocComposeTexture(outW, outH);
    this.composeSnapshot({
      targetView: texture.createView(),
      drawList: [...args.windows],
      outW, outH,
    });
    return { texture, outW, outH };
  }

  // Phase 9a: snapshot the closing window's surfaces into a fresh
  // texture and mint a phantom surface entry to display it. The
  // phantom is a regular compositor surface (the plugin can
  // manipulate it via the standard windows broker -- setOpacity,
  // setTransform, etc.); it's added to the phantoms array so
  // drawOrder includes it above the content stack.
  //
  // `surfaceIds` is the surfaces to composite (typically: toplevel,
  // decoration, subsurfaces). They must still be sampleable -- callers
  // run this BEFORE compositor.removeSurface on any of them.
  //
  // `outerRect` is the closing window's outer screen rect; each
  // surface's screen position is translated into the phantom's local
  // coordinate space relative to that origin. The phantom is then
  // placed at the same screen rect so it appears exactly where the
  // closing window was.
  //
  // `phantomSurfaceId` is provided by the caller (typically a fresh
  // id from state.serial()). Returns the same id for convenience.
  createClosingPhantom(args: {
    phantomSurfaceId: number;
    surfaceIds: ReadonlyArray<number>;
    outerRect: { x: number; y: number; w: number; h: number };
  }): number {
    const { phantomSurfaceId, surfaceIds, outerRect } = args;
    const outW = Math.max(1, outerRect.w);
    const outH = Math.max(1, outerRect.h);

    // Build a placement override: each surface goes at (s.x - outerRect.x,
    // s.y - outerRect.y) with its current layoutW/layoutH. This maps
    // every member's absolute screen position to the phantom-local
    // coordinate space.
    const placements = new Map<number, { x: number; y: number; w: number; h: number }>();
    for (const id of surfaceIds) {
      const s = this.surfaces.get(id);
      if (!s) continue;
      placements.set(id, {
        x: s.x - outerRect.x,
        y: s.y - outerRect.y,
        w: s.layoutW,
        h: s.layoutH,
      });
    }

    // Allocate a fresh phantom texture sized to the outer rect.
    const phantomTex = this.allocComposeTexture(outW, outH);
    const view = phantomTex.createView();

    // Compose the surface set into the phantom texture using the
    // placement override. The phantom-local coordinates above mean
    // the result matches what the on-screen composite would have
    // drawn for those surfaces (up to clipping at the outer rect).
    this.composeSnapshot({
      targetView: view,
      drawList: [...surfaceIds],
      outW, outH,
      placements,
    });

    // Mint the phantom surface entry. setSurfaceLayout creates the
    // Surface record if absent; setSurfaceTexture installs the
    // sampled texture + bind group. Layout = outer rect (so the
    // phantom draws at the same position as the closing window).
    this.setSurfaceLayout(phantomSurfaceId,
      outerRect.x, outerRect.y, outW, outH);
    this.setSurfaceTexture(phantomSurfaceId, phantomTex, outW, outH);

    // Track for lifetime + draw-order inclusion.
    this.phantomTextures.set(phantomSurfaceId, phantomTex);
    this.phantoms.push(phantomSurfaceId);
    return phantomSurfaceId;
  }

  // Phase 9a: tear down a phantom. Removes it from the draw order,
  // drops the surface entry, destroys the snapshot texture. Idempotent
  // (no-op if the id isn't a known phantom).
  destroyClosingPhantom(phantomSurfaceId: number): void {
    const tex = this.phantomTextures.get(phantomSurfaceId);
    if (!tex) return;
    this.phantomTextures.delete(phantomSurfaceId);
    const i = this.phantoms.indexOf(phantomSurfaceId);
    if (i >= 0) this.phantoms.splice(i, 1);
    // Drop the surface entry. removeSurface dispatches the
    // lifecycle's surfaceRemoved step; safe for a phantom since
    // its currentBufferId is 0 (no client buffer) so the lifecycle
    // emits nothing.
    this.removeSurface(phantomSurfaceId);
    // Destroy the texture last -- removeSurface may have its own
    // teardown that references it (e.g. the bind group) but those
    // are released before the texture itself goes.
    tex.destroy();
  }

  // For tests: enumerate active phantom surfaceIds in draw order.
  activePhantomIds(): number[] { return this.phantoms.slice(); }

  // ----- Buffer intercept (Phase 10a) ---------------------------------------
  //
  // Displaces a surface's sampled texture with a plugin-supplied one.
  // The intercept broker runs in the beforeRender hook: for each
  // intercepted surface it (a) calls the plugin's render callback into
  // an output ring slot, then (b) calls installInterceptOutput to
  // point the surface's bind group at that slot. The next on-screen
  // composite pass samples the plugin's pixels in place of the client
  // buffer for that surface.
  //
  // The plugin output texture is provided by the broker as a
  // GPUTextureView; the compositor doesn't manage its lifetime.
  // In-thread plugins share core's device so the view is direct;
  // Worker plugins go through the cross-device dmabuf machinery (10b).
  //
  // outputRect (optional): a per-frame placement override that
  // replaces the WM-assigned (x, y, layoutW, layoutH) for compose
  // purposes only. Hit-testing still uses the WM rect (10a
  // limitation documented in intercept-design.md).

  installInterceptOutput(surfaceId: number,
                         view: GPUTextureView,
                         placement: { x: number; y: number; w: number; h: number } | null): void {
    const s = this.surfaces.get(surfaceId);
    if (!s) return;     // surface unknown (race with unmap); silent no-op
    s.interceptOutputView = view;
    s.interceptPlacement = placement;
    // Rebuild the bind group around the intercept view. If the surface
    // had no underlying client texture yet (a brand-new toplevel that
    // mapped but committed no buffer), this is the first time
    // rebuildBindGroup is called on it.
    this.rebuildBindGroup(s, view);
    s.present = true;   // matched + textured -> drawable
  }

  clearInterceptOutput(surfaceId: number): void {
    const s = this.surfaces.get(surfaceId);
    if (!s) return;
    s.interceptOutputView = null;
    s.interceptPlacement = null;
    // Restore the client texture's view (if any) into the bind group.
    if (s.view) this.rebuildBindGroup(s, s.view);
    // If there's no client view (the surface never had a buffer), the
    // bind group can't be rebuilt without a view; mark as not present
    // so the compose pass skips it.
    else { s.bindGroup = null; s.present = false; }
  }

  // For tests: enumerate the surfaceIds currently routed through an
  // intercept (the broker installed an output view for them).
  activeInterceptIds(): number[] {
    const out: number[] = [];
    for (const [id, s] of this.surfaces.entries()) {
      if (s.interceptOutputView !== null) out.push(id);
    }
    return out;
  }

  // Phase 10a: hand the intercept broker the current client texture
  // for a surface. The broker passes this as `input.texture` to the
  // plugin's render callback in the in-thread path. Returns null when
  // the surface is unknown or has no committed buffer yet (the broker
  // skips render for that frame and falls back to raw, which for a
  // surface with no buffer is just "not drawn").
  surfaceClientTexture(surfaceId: number): { texture: GPUTexture; w: number; h: number } | null {
    const s = this.surfaces.get(surfaceId);
    if (!s || !s.texture) return null;
    return { texture: s.texture, w: s.width, h: s.height };
  }

  // Phase 10a: whether the surface is in the on-screen draw list this
  // frame. The broker uses this to skip render dispatch for surfaces
  // that aren't being composited (off-screen / hidden by a workspace).
  // Returns the surface's presentable flag; the broker treats "not
  // present" as "no render needed."
  surfaceIsPresentable(surfaceId: number): boolean {
    const s = this.surfaces.get(surfaceId);
    return !!s && s.present;
  }

  // ----- Cursor slot (Phase 9c) ---------------------------------------------
  //
  // A singleton overlay drawn ABOVE every other layer. The cursor "slot"
  // is a reference to a surfaceId + hotspot + visibility; drawOrder()
  // appends it last whenever (visible && a target surfaceId is set &&
  // that surface has a texture).
  //
  // Two ways to install a cursor:
  //   setCursorPixels(bytes, w, h, hotX, hotY): CPU-side BGRA8 bytes are
  //     uploaded into a compositor-owned internal surface; that surface's
  //     surfaceId becomes the slot's target. Used by the theme resolver
  //     output and (later) by plugin setImage in-thread.
  //   setCursorFromSurface(surfaceId, hotX, hotY): point the slot at an
  //     EXISTING surface (one with its own buffer pipeline running, e.g.
  //     a wl_pointer.set_cursor surface). The slot picks up texture
  //     changes automatically as that surface commits new buffers.
  //
  // The hotspot is the offset within the cursor image that aligns with the
  // pointer's hot point. setCursorPosition() takes the pointer position;
  // the cursor draws at (pointerX - hotX, pointerY - hotY).
  //
  // The compositor's internal cursor surface lives at a reserved high
  // surfaceId outside any WM range; it is never fed through the client-
  // buffer lifecycle and never appears in any layer or stack list.

  private readonly internalCursorSurfaceId = 0x7FFF_FFF0;   // reserved
  private cursorTargetSurfaceId: number | null = null;
  private cursorVisible = false;
  private cursorOwnedTexture: GPUTexture | null = null;     // for internal surface
  private cursorHotspotX = 0;
  private cursorHotspotY = 0;
  private cursorPointerX = 0;
  private cursorPointerY = 0;

  // Place the cursor target surface at (pointer - hotspot). Called on
  // every position update, and after install.
  private updateCursorLayout(): void {
    if (this.cursorTargetSurfaceId === null) return;
    const s = this.surfaces.get(this.cursorTargetSurfaceId);
    if (!s) return;
    // Damage the cursor's old rect, move it, damage the new rect: a cursor
    // move repaints just the two small regions, not the whole output.
    if (this.cursorVisible) this.addOutputDamage(s.x, s.y, s.layoutW, s.layoutH);
    const x = this.cursorPointerX - this.cursorHotspotX;
    const y = this.cursorPointerY - this.cursorHotspotY;
    s.x = x; s.y = y;
    // For the internal surface, layoutW/H match the sampled texture
    // dims; for a client surface, the client owns layoutW/H via the
    // normal protocol path and we don't override it.
    if (this.cursorTargetSurfaceId === this.internalCursorSurfaceId) {
      s.layoutW = s.width;
      s.layoutH = s.height;
    }
    if (this.cursorVisible) this.addOutputDamage(s.x, s.y, s.layoutW, s.layoutH);
  }

  // Install a CPU-side BGRA8 cursor image into the internal cursor surface
  // and point the cursor slot at it. Allocates / reuses a core-device
  // texture; uploads via queue.writeTexture.
  setCursorPixels(bytes: Uint8Array,
                  width: number, height: number,
                  hotspotX: number, hotspotY: number): void {
    if (width <= 0 || height <= 0 || bytes.length !== width * height * 4) {
      throw new Error(`setCursorPixels: invalid dims/bytes (${width}x${height}, ${bytes.length} bytes)`);
    }
    const owned = this.cursorOwnedTexture;
    let tex = owned;
    if (!tex || tex.width !== width || tex.height !== height) {
      if (owned) owned.destroy();
      tex = this.device.createTexture({
        size: { width, height, depthOrArrayLayers: 1 },
        format: "bgra8unorm",
        // TEXTURE_BINDING for sampling, COPY_DST for queue.writeTexture.
        // RENDER_ATTACHMENT isn't strictly required for sampling but
        // keeps the texture compatible with any render-into-cursor
        // future path (e.g. a scale/transform pass).
        usage: this.g.GPUTextureUsage.TEXTURE_BINDING
             | this.g.GPUTextureUsage.COPY_DST
             | this.g.GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.cursorOwnedTexture = tex;
    }
    this.device.queue.writeTexture(
      { texture: tex, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      bytes,
      { offset: 0, bytesPerRow: width * 4, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
    // Install into the internal cursor surface (mint on first use).
    if (!this.surfaces.has(this.internalCursorSurfaceId)) {
      this.surfaces.set(this.internalCursorSurfaceId, blankSurface(0, 0, width, height));
    }
    this.setSurfaceTexture(this.internalCursorSurfaceId, tex, width, height);
    this.cursorTargetSurfaceId = this.internalCursorSurfaceId;
    this.cursorHotspotX = hotspotX;
    this.cursorHotspotY = hotspotY;
    this.updateCursorLayout();
  }

  // Point the cursor slot at an existing surface (e.g. a client cursor
  // surface for wl_pointer.set_cursor). The surface's normal buffer
  // pipeline drives its texture; the slot just observes. The slot reads
  // the surface's width/height per frame to compute the layout rect.
  // If `surfaceId === null`, clears the target (cursor hidden).
  // If the surface doesn't exist yet (set_cursor with NULL), the slot
  // is cleared.
  setCursorFromSurface(surfaceId: number | null,
                       hotspotX: number, hotspotY: number): void {
    // If switching away from the internal surface, free the owned
    // texture -- the slot won't be using it anymore.
    if (surfaceId !== this.internalCursorSurfaceId && this.cursorOwnedTexture) {
      this.cursorOwnedTexture.destroy();
      this.cursorOwnedTexture = null;
      // Drop the internal surface entry too (it's no longer needed).
      const intern = this.surfaces.get(this.internalCursorSurfaceId);
      if (intern && surfaceId !== this.internalCursorSurfaceId) {
        if (intern.uniformBuf) intern.uniformBuf.destroy();
        this.surfaces.delete(this.internalCursorSurfaceId);
      }
    }
    this.cursorTargetSurfaceId = surfaceId;
    this.cursorHotspotX = hotspotX;
    this.cursorHotspotY = hotspotY;
    this.updateCursorLayout();
  }

  // Deprecated direct-texture install (kept for tests that hand-craft a
  // GPUTexture). New callers should use setCursorPixels (CPU bytes) or
  // setCursorFromSurface (existing surface).
  setCursorTexture(tex: GPUTexture, width: number, height: number,
                   hotspotX: number, hotspotY: number): void {
    if (this.cursorOwnedTexture) {
      this.cursorOwnedTexture.destroy();
      this.cursorOwnedTexture = null;
    }
    if (!this.surfaces.has(this.internalCursorSurfaceId)) {
      this.surfaces.set(this.internalCursorSurfaceId, blankSurface(0, 0, width, height));
    }
    this.setSurfaceTexture(this.internalCursorSurfaceId, tex, width, height);
    this.cursorTargetSurfaceId = this.internalCursorSurfaceId;
    this.cursorHotspotX = hotspotX;
    this.cursorHotspotY = hotspotY;
    this.updateCursorLayout();
  }

  // Update pointer position. Called on every host pointer motion event.
  // No-op when no cursor texture is installed yet.
  setCursorPosition(x: number, y: number): void {
    this.cursorPointerX = x;
    this.cursorPointerY = y;
    this.updateCursorLayout();
  }

  setCursorVisible(visible: boolean): void {
    if (visible === this.cursorVisible) return;
    this.cursorVisible = visible;
    // Repaint the cursor's rect so it appears / is erased.
    if (this.cursorTargetSurfaceId !== null) {
      const s = this.surfaces.get(this.cursorTargetSurfaceId);
      if (s) this.addOutputDamage(s.x, s.y, s.layoutW, s.layoutH);
    }
  }

  // Tear down the cursor entirely. Called on compositor shutdown; tests use
  // this between cases.
  clearCursor(): void {
    this.cursorVisible = false;
    this.cursorTargetSurfaceId = null;
    const intern = this.surfaces.get(this.internalCursorSurfaceId);
    if (intern) {
      if (intern.uniformBuf) intern.uniformBuf.destroy();
      this.surfaces.delete(this.internalCursorSurfaceId);
    }
    if (this.cursorOwnedTexture) {
      this.cursorOwnedTexture.destroy();
      this.cursorOwnedTexture = null;
    }
  }

  // Test/introspection accessors.
  cursorState(): {
    visible: boolean; targetSurfaceId: number | null;
    x: number; y: number;
    width: number; height: number;
    hotspotX: number; hotspotY: number;
  } {
    const sid = this.cursorTargetSurfaceId;
    const s = sid !== null ? this.surfaces.get(sid) : undefined;
    return {
      visible: this.cursorVisible && sid !== null && !!s && !!s.texture,
      targetSurfaceId: sid,
      x: s?.x ?? 0,
      y: s?.y ?? 0,
      width: s?.width ?? 0,
      height: s?.height ?? 0,
      hotspotX: this.cursorHotspotX,
      hotspotY: this.cursorHotspotY,
    };
  }

  // Render the listed windows into a PRE-ALLOCATED target view, with optional
  // producer Begin/End wrapping for cross-device dmabuf targets (phase 5b
  // Worker compose). Used when the target texture is a wire-wrapped dmabuf
  // that the core produces and a Worker plugin consumes; the producer bracket
  // is required for the GPU process to chain the cross-device fence to the
  // plugin's subsequent consumer Begin.
  composeIntoView(args: {
    outputId: number;
    targetView: GPUTextureView;
    windows: ReadonlyArray<number>;
    outW: number;
    outH: number;
    // When set, the compose pass is wrapped in producer Begin/End frames on
    // the core wire keyed on this surfaceBufId. Required for dmabuf compose
    // targets allocated via AllocComposeBuf (the plugin's consumer Begin
    // chains on the fence the producer End exports). Omit for in-thread
    // targets (no cross-device handoff).
    producerSurfaceBufId?: number;
  }): void {
    if (args.producerSurfaceBufId !== undefined) {
      this.addon.writeProducerBegin(args.producerSurfaceBufId);
    }
    this.composeSnapshot({
      targetView: args.targetView,
      drawList: [...args.windows],
      outW: args.outW, outH: args.outH,
    });
    if (args.producerSurfaceBufId !== undefined) {
      this.addon.writeProducerEnd(args.producerSurfaceBufId);
    }
  }

  // Phase 10a Worker intercept: copy a client surface's currently-
  // committed texture into a dmabuf the Worker plugin samples. Both
  // textures live on the core device (the dmabuf was allocated via
  // AllocComposeBuf; the core has the producer-side wgpu::Texture).
  // The copy is wrapped in producer Begin/End on the core wire so
  // the plugin's consumer Begin can chain on the produced fence.
  //
  // The SurfaceProducer's tryAcquire already wrote the producer Begin
  // before this call; we just need to encode the copy + submit. The
  // matching producer End is written by SurfaceProducer.presentSync()
  // after this returns.
  copyClientToInterceptInputSlot(args: {
    surfaceId: number;
    dstTex: GPUTexture;
  }): boolean {
    const s = this.surfaces.get(args.surfaceId);
    if (!s || !s.texture) return false;
    // The client texture's import bracket must be open during the
    // copy (its dmabuf has a SharedTextureMemory access bracket the
    // GPU process needs to know about). Use the same import-bracket
    // mechanism the on-screen frame uses: openImportBrackets ->
    // copy -> closeImportBrackets.
    const bracketed: Array<{ importId: number; bufferId: number }> = [];
    this.openImportBrackets([args.surfaceId], bracketed);
    try {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToTexture(
        { texture: s.texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { texture: args.dstTex, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { width: s.width, height: s.height, depthOrArrayLayers: 1 },
      );
      this.device.queue.submit([enc.finish()]);
    } finally {
      this.closeImportBrackets(bracketed);
    }
    return true;
  }

  // Phase 5b-live: register a per-frame produce callback. The compositor
  // invokes it after the on-screen frame submits. The caller owns its
  // SurfaceProducer + ring; each callback typically calls producer.
  // tryAcquire() -> composeIntoView -> producer.presentSync(). Returns an
  // unregister handle.
  registerLiveProducer(onFrame: () => void): { unregister: () => void } {
    this.liveProducers.push(onFrame);
    let off = false;
    return {
      unregister: () => {
        if (off) return;
        off = true;
        const i = this.liveProducers.indexOf(onFrame);
        if (i >= 0) this.liveProducers.splice(i, 1);
      },
    };
  }

  // Install a transition on `outputId`. While set, renderFrame replaces
  // that output's surface-list composite with a transition pass blending
  // fromTex/toTex via the kind-specific shader. Other outputs continue to
  // composite normally; simultaneous transitions on different outputs are
  // allowed. getProgress is called once per frame to read the eased
  // progress in [0, 1]; the broker / evaluator owns that state.
  //
  // resolveTextures is for the Worker-live case: when the producer's ring
  // rotates between frames the textures change identity; passing a resolver
  // lets the compositor re-pick per frame and rebuild the bind group only
  // when identity changes. Per-side fromBracket / toBracket identify the
  // producer Begin/End hooks by sceneId so the compositor can dedup across
  // outputs that sample the same scene in the same frame (b->a on output 0
  // + c->b on output 1 must Begin scene b once, not twice). Omit for stable
  // cases (snapshot scenes, in-thread live scenes -- the texture handle is
  // stable and no producer brackets are needed).
  //
  // Throws if `outputId` already has an active transition -- the broker
  // pre-rejects concurrent installs on the same output, this is defense in
  // depth.
  setActiveTransition(outputId: number, opts: {
    fromTex: GPUTexture;
    toTex: GPUTexture;
    kind: TransitionKind;
    getProgress: () => number;
    resolveTextures?: () => {
      fromTex: GPUTexture;
      toTex: GPUTexture;
      fromBracket?: TransitionBracket;
      toBracket?: TransitionBracket;
    } | null;
  }): void {
    if (this.activeTransitions.has(outputId)) {
      throw new Error(
        `setActiveTransition: a transition is already active on output ${outputId}`);
    }
    if (this.transitionPipeline === null || this.transitionLayout === null) {
      throw new Error("setActiveTransition: pipeline not initialized");
    }
    this.activeTransitions.set(outputId, {
      fromTex: opts.fromTex,
      toTex: opts.toTex,
      kind: opts.kind,
      getProgress: opts.getProgress,
      resolveTextures: opts.resolveTextures,
      cachedFromTex: null,
      cachedToTex: null,
      cachedBindGroup: null,
    });
  }

  // Tear down the active transition on `outputId`. The broker calls this
  // from inside the evaluator's commit callback so the very next frame
  // draws that output's post-transition state through the normal composite
  // path. Idempotent.
  clearActiveTransition(outputId: number): void {
    this.activeTransitions.delete(outputId);
  }

  // For tests: true while a transition is installed on `outputId`. Omit
  // outputId to ask "is any transition active anywhere?".
  hasActiveTransition(outputId?: number): boolean {
    if (outputId === undefined) return this.activeTransitions.size > 0;
    return this.activeTransitions.has(outputId);
  }

  // Resolve one output's active-transition inputs for this frame: re-pick
  // textures (resolver case), open producer Begin brackets exactly once per
  // unique scene this frame (across all outputs), refresh the bind group on
  // identity change, and write the kind+progress uniform. Returns the bind
  // group to draw, or null when a texture is unavailable this frame (the
  // caller clears that output target to black).
  //
  // Frame-scoped dedup state is passed in: `openedScenes` is a Set of scene
  // ids whose Begin has already fired this frame; `pendingEnds` collects End
  // closures keyed by sceneId for renderFrame to fire after all submits.
  // Two simultaneous per-output transitions that share a scene (e.g. b->a on
  // output 0 + c->b on output 1, sharing b) open scene b exactly once and
  // close it exactly once. The GPU process requires Begin/End alternation
  // per surfaceBufId; without dedup, two Begins on the same scene would
  // trip alternation and fail the next access.
  //
  // The caller has already opened any client-surface import brackets it
  // needs for the outputs WITHOUT an active transition. Transition inputs
  // are not client dmabufs (they're compose-output / live-scene targets
  // pinned by the broker for the transition's duration), so no on-screen
  // import brackets are needed on a transitioning output.
  private resolveTransitionFrame(
    outputId: number,
    openedScenes: Set<number>,
    pendingEnds: Map<number, () => void>,
  ): GPUBindGroup | null {
    const t = this.activeTransitions.get(outputId);
    if (!t || !this.transitionPipeline || !this.transitionLayout
        || !this.transitionUniformBuf) return null;

    let fromTex = t.fromTex;
    let toTex = t.toTex;
    if (t.resolveTextures) {
      const r = t.resolveTextures();
      // No texture available this frame (e.g. ring has nothing PRESENTED yet).
      if (r === null) return null;
      fromTex = r.fromTex;
      toTex = r.toTex;
      // Open each side's producer Begin exactly once per scene per frame.
      // pendingEnds captures the End closure (overwrites are fine: every
      // sceneId maps to the same End closure shape -- a producer End on
      // that scene's surfaceBufId -- so a second resolver returning the
      // same sceneId's bracket just re-asserts the same End).
      for (const b of [r.fromBracket, r.toBracket]) {
        if (!b) continue;
        if (!openedScenes.has(b.sceneId)) {
          openedScenes.add(b.sceneId);
          pendingEnds.set(b.sceneId, b.endRead);
          b.beginRead();
        }
      }
    }
    if (t.cachedBindGroup === null
        || t.cachedFromTex !== fromTex
        || t.cachedToTex !== toTex) {
      t.cachedBindGroup = this.device.createBindGroup({
        layout: this.transitionLayout,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: fromTex.createView() },
          { binding: 2, resource: toTex.createView() },
          { binding: 3, resource: { buffer: this.transitionUniformBuf } },
        ],
      });
      t.cachedFromTex = fromTex;
      t.cachedToTex = toTex;
    }

    // Update the kind + progress uniform. 16 bytes (matches WGSL
    // TUniforms padding). Each output writes its own value because every
    // output's transition pass is its own submit -- queue.writeBuffer is
    // per-submit, so successive outputs don't clobber each other.
    const u = new ArrayBuffer(16);
    new Uint32Array(u, 0, 1)[0] = TRANSITION_KIND_CODE[t.kind];
    new Float32Array(u, 4, 1)[0] = t.getProgress();
    this.device.queue.writeBuffer(this.transitionUniformBuf, 0, u);
    return t.cachedBindGroup;
  }

  // Encode the transition pass into one output's targetView using the bind
  // group resolved for this frame. A null bindGroup (no texture available)
  // clears the target to opaque black so the output isn't left undefined.
  // The transition is a full-output replacement: every output draws the same
  // blended result (no per-output transform applies to a full-screen quad).
  private encodeTransitionInto(
    encoder: GPUCommandEncoder, targetView: GPUTextureView,
    bindGroup: GPUBindGroup | null,
  ): void {
    if (!bindGroup || !this.transitionPipeline) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: targetView, loadOp: "clear", storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.end();
      return;
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: targetView, loadOp: "clear", storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.transitionPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
    pass.end();
  }

  // Render each listed window into its own texture sized to that window's
  // crop rect (or the window's full size if no crop). The cropped region of
  // the surface texture fills the target texture; per-surface state
  // (transform, mask, opacity, outputMargin) is currently NOT applied to
  // per-window compose textures -- those are render-state for on-screen
  // placement, and a per-window crop is a content extraction.
  // (The placement override sets the surface's draw rect to fill the target.)
  //
  // rect (if given) is source crop in surface-local pixels; the target
  // texture is sized to (rect.w, rect.h). Without rect, target sized to
  // the window's full layout/buffer dims.
  //
  // Caller owns each returned texture and must .destroy() them when done.
  composeWindows(args: {
    outputId: number;
    windows: ReadonlyArray<{ id: number;
                            rect?: { x: number; y: number; w: number; h: number } }>;
  }): Array<{ id: number; texture: GPUTexture;
              rect: { x: number; y: number; w: number; h: number } }> {
    // Compute per-window output rects and cropUV. The crop's UV range is
    // the crop pixel coords / surface dims (the surface texture is sampled
    // in [0,1] UV regardless of its actual pixel size; cropUV picks a
    // sub-rect of that).
    const out: Array<{ id: number; texture: GPUTexture;
                       rect: { x: number; y: number; w: number; h: number } }> = [];
    for (const w of args.windows) {
      const s = this.surfaces.get(w.id);
      if (!s) continue;  // unknown window: skip (caller bug; report empty)
      const surfW = s.width || s.layoutW || 0;
      const surfH = s.height || s.layoutH || 0;
      const rect = w.rect ?? { x: 0, y: 0, w: surfW, h: surfH };
      // Degenerate (zero-dim) windows produce no texture (would error on
      // createTexture). Skip and let the caller see a shorter result.
      if (rect.w <= 0 || rect.h <= 0) continue;

      const texture = this.allocComposeTexture(rect.w, rect.h);
      // Render this surface filling the target (placement = full target).
      // Sample only the crop region (cropUV in [0,1] UV).
      const placements = new Map([[w.id, { x: 0, y: 0, w: rect.w, h: rect.h }]]);
      const cropUV = surfW > 0 && surfH > 0
        ? new Map([[w.id, {
            u0: rect.x / surfW, v0: rect.y / surfH,
            u1: (rect.x + rect.w) / surfW, v1: (rect.y + rect.h) / surfH,
          }]])
        : undefined;
      this.composeSnapshot({
        targetView: texture.createView(),
        drawList: [w.id],
        outW: rect.w, outH: rect.h,
        placements, cropUV,
      });
      out.push({ id: w.id, texture, rect });
    }
    return out;
  }

  // Register a live compose-scene target. The texture is re-rendered on
  // every on-screen renderFrame() under the same import brackets and
  // command encoder, so its contents always reflect what the listed
  // windows would currently look like on-screen. Holder polls the
  // returned texture between frames. release() removes the registration
  // and destroys the texture.
  registerLiveScene(args: {
    outputId: number;
    windows: ReadonlyArray<number>;
    outW?: number;
    outH?: number;
  }): LiveSceneHandle {
    const outW = args.outW ?? this.logicalWidth;
    const outH = args.outH ?? this.logicalHeight;
    const texture = this.allocComposeTexture(outW, outH);
    const entry: LiveScene = {
      texture, view: texture.createView(),
      outputId: args.outputId, windows: [...args.windows],
      outW, outH,
    };
    this.liveScenes.push(entry);
    let released = false;
    return {
      texture, outW, outH,
      release: () => {
        if (released) return;
        released = true;
        const i = this.liveScenes.indexOf(entry);
        if (i >= 0) this.liveScenes.splice(i, 1);
        texture.destroy();
      },
    };
  }

  // Register a live compose-windows target. Each listed window gets its
  // own texture sized to its crop rect (or the full surface if no rect),
  // re-rendered on every on-screen renderFrame(). The set of windows
  // and their crop rects is fixed at registration; releasing and
  // re-registering is how the holder changes the list.
  registerLiveWindows(args: {
    outputId: number;
    windows: ReadonlyArray<{
      id: number;
      rect?: { x: number; y: number; w: number; h: number };
    }>;
  }): LiveWindowCompHandle {
    const windows: LiveWindowComp["windows"] = [];
    for (const w of args.windows) {
      const s = this.surfaces.get(w.id);
      if (!s) continue;  // unknown window: skip
      const surfW = s.width || s.layoutW || 0;
      const surfH = s.height || s.layoutH || 0;
      const rect = w.rect ?? { x: 0, y: 0, w: surfW, h: surfH };
      if (rect.w <= 0 || rect.h <= 0) continue;
      const texture = this.allocComposeTexture(rect.w, rect.h);
      windows.push({
        id: w.id, rect, texture, view: texture.createView(),
        surfW, surfH,
      });
    }
    const entry: LiveWindowComp = { outputId: args.outputId, windows };
    this.liveWindowComps.push(entry);
    let released = false;
    return {
      windows: windows.map((w) => ({ id: w.id, texture: w.texture, rect: w.rect })),
      release: () => {
        if (released) return;
        released = true;
        const i = this.liveWindowComps.indexOf(entry);
        if (i >= 0) this.liveWindowComps.splice(i, 1);
        for (const w of windows) w.texture.destroy();
      },
    };
  }

  // Async readback of an arbitrary GPUTexture. Returns tightly-packed BGRA
  // bytes (w*h*4). copyTextureToBuffer requires 256-aligned bytesPerRow, so
  // pad on the GPU side and unpad here. The texture must have COPY_SRC usage.
  async readbackTexture(tex: GPUTexture, w: number, h: number):
      Promise<{ width: number; height: number; data: Uint8Array }> {
    const unpadded = w * 4;
    const padded = Math.ceil(unpadded / 256) * 256;
    const buf = this.device.createBuffer({
      size: padded * h,
      usage: this.g.GPUBufferUsage.COPY_DST | this.g.GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: tex },
      { buffer: buf, bytesPerRow: padded, rowsPerImage: h },
      { width: w, height: h },
    );
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(this.g.GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(unpadded * h);
    for (let y = 0; y < h; y++) {
      out.set(mapped.subarray(y * padded, y * padded + unpadded), y * unpadded);
    }
    buf.unmap();
    buf.destroy();
    return { width: w, height: h, data: out };
  }

  // Async readback of the headless offscreen target. Convenience wrapper
  // around readbackTexture for the on-screen composite (used by tests).
  async readback(): Promise<{ width: number; height: number; data: Uint8Array }> {
    if (!this.headless || !this.target) {
      throw new Error("readback() is headless-only (non-headless renders into an addon-acquired texture)");
    }
    return this.readbackTexture(this.target, this.width, this.height);
  }
}

function blankSurface(x: number, y: number, w: number, h: number): Surface {
  return {
    texture: null, view: null, uniformBuf: null, bindGroup: null,
    width: 0, height: 0, bufferScale: 1, bufferTransform: 0, x, y, layoutW: w, layoutH: h, present: false,
    currentBufferId: 0,
    fx: defaultFx(),
    maskView: null,
    interceptOutputView: null,
    interceptPlacement: null,
  };
}
