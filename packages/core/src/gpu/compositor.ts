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
// expressible here -- they're for the buffer-intercept path.
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
  // Shape clipping the surface to its WINDOW's rounded footprint. .x = kind
  // (0=rect / 1=rounded-rect uniform / 2=rounded-rect per-corner /
  // 3=squircle-cornered rect); .y = window logical width (px) the SDF eval
  // works against; .z = window logical height (px); .w = corner extent (px)
  // when kind=1 (rounded-rect uniform radius) or kind=3 (squircle corner
  // extent), unused when kind=0/2. For a plain rounded window .y/.z are the
  // surface's own size; for a subsurface they are the enclosing window's size.
  shape       : vec4f,
  // kind=2 (per-corner): tl, tr, br, bl radii in px.
  // kind=3 (squircle): .x = exponent (>= 2), .yzw unused.
  // kind=0/1: unused.
  shapeExtra  : vec4f,
  // Maps this surface's [0,1] surfUV into the window's [0,1] shape space:
  // windowUV = shapeMap.xy + surfUV * shapeMap.zw. Identity (0,0,1,1) when the
  // surface IS the shaped window; for a subsurface it locates the surface's
  // rect within the enclosing window footprint, so the window's rounded corners
  // clip the subsurface at the correct place.
  shapeMap    : vec4f,
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

// Signed distance to a rectangle whose CORNERS are replaced by a localized
// superelliptic curve of size \`r\` (the macOS-style squircle corner). \`he\`
// are the half-extents of the full rectangle; \`r\` is the corner extent
// (clamped to <= min(he.x, he.y)); \`n\` is the superellipse exponent.
// n=2 gives a circular corner identical to the rounded-rect SDF; n=4..6
// gives the macOS look (continuous-curvature corner; smoother eye-tracking
// than a circular arc); large n approaches a sharp rectangle.
//
// Approach: in the corner quadrant (q.x > 0 AND q.y > 0 where q = |p| - he
// + r), evaluate the superelliptic SDF in the local (r, r) box; elsewhere
// (on an edge or in the interior) use the rounded-rect edge formula. This
// matches the standard rounded-rect SDF's structure -- the corner radius
// is the same edge inset across both formulas.
fn sdfSquircleRect(p : vec2f, he : vec2f, r : f32, n : f32) -> f32 {
  let cr = min(r, min(he.x, he.y));
  let exp = max(n, 2.0);
  let q = abs(p) - he + vec2f(cr);
  let edge = min(max(q.x, q.y), 0.0);  // negative interior + edge bands
  // In the corner box (q > 0 on both axes) evaluate the squircle SDF
  // against a local (cr, cr) box; outside, the corner contribution is 0.
  let qc = max(q, vec2f(0.0));
  let ax = qc.x / max(cr, 1e-5);
  let ay = qc.y / max(cr, 1e-5);
  // (|x|^n + |y|^n)^(1/n) is 1 on the squircle boundary; scale back to px
  // by multiplying by cr. Subtract cr so the SDF is 0 on the curve.
  let cornerR = pow(pow(ax, exp) + pow(ay, exp), 1.0 / exp);
  let corner = cornerR * cr - cr;
  return edge + corner;
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
                 sizePx : vec2f, r : f32, extra : vec4f, map : vec4f) -> f32 {
  if (kind == 0u) { return 1.0; }
  // Map the surface-local uv into the enclosing window's [0,1] shape space, so
  // the SDF is evaluated over the WINDOW rect (sizePx) even for a subsurface
  // that only covers part of it.
  let wuv = map.xy + uv * map.zw;
  let p  = (wuv - vec2f(0.5)) * sizePx;
  let he = sizePx * 0.5;
  if (kind == 1u) {
    return sdfCoverage(sdfRoundedRect(p, he, r));
  }
  if (kind == 2u) {
    return sdfCoverage(
      sdfRoundedRectPerCorner(p, he, extra.x, extra.y, extra.z, extra.w));
  }
  if (kind == 3u) {
    return sdfCoverage(sdfSquircleRect(p, he, r, extra.x));
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
  // Opaque-format (XRGB/XBGR, XR24, ...): the buffer has no alpha channel; its
  // sampled 4th byte is a don't-care value. Force alpha to 1 so it cannot blend
  // as translucency. u.fx.z = 1 for opaque formats, 0 otherwise.
  surf.a = mix(surf.a, 1.0, u.fx.z);
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
    u32(u.shape.x), u.shape.yz, u.shape.w, u.shapeExtra, u.shapeMap);

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
import { logicalContentSize } from "../surface-geometry.js";
import type { TransitionKind } from "@overdraw/transition-types";
import type { Addon, WaylandFd } from "../types.js";
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

// The slice of the native addon (`Addon`, ../types.ts) this module needs.
// JsCompositor only touches these addon methods; narrowing keeps interface
// segregation with a single source of truth for the signatures.
export type CompositorAddon = Pick<
  Addon,
  | "shmView"
  | "createTextureFromDmabuf"
  | "releaseDmabufImport"
  | "reserveShmTexture"
  | "commitShmUpload"
  | "takeShmUploadAcks"
  | "writeBeginAccess"
  | "writeBeginAccessWithFence"
  | "writeEndAccess"
  | "syncobjTimelineSignal"
  | "writeProducerBegin"
  | "writeProducerEnd"
  | "acquireOutputTexture"
  | "presentOutput"
  | "wake"
  | "sendCursorImage"
  | "sendCursorImageShm"
  | "sendCursorState"
  | "sendScanoutClientPresent"
>;

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

// The content-gate release decision (surfaceContentReady's core), pulled out
// pure for testing. The gate releases once the client has a drawable buffer
// AND has acked our latest configure (ackSerial >= cfgSerial). The committed
// buffer SIZE is intentionally not part of the decision: a client may settle
// at a slightly different size than configured (CSD shadow margins, terminal
// cell rounding, fixed-size dialogs) and an exact-size gate would strand it on
// the backstop. The ack is a serial, so the check is scale-correct with no
// pixel math. Xwayland has no ack_configure (cfgSerial undefined) -> ready on a
// drawable buffer alone.
export function contentGateReleased(s: {
  hasBuffer: boolean;
  layoutW: number;
  layoutH: number;
  cfgSerial?: number;
  ackSerial?: number;
}): boolean {
  if (!s.hasBuffer || s.layoutW <= 0 || s.layoutH <= 0) return false;
  if (s.cfgSerial !== undefined && (s.ackSerial ?? -1) < s.cfgSerial) return false;
  return true;
}

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
  // Bind groups keyed by the sampled view they bind. A client cycling a fixed
  // set of buffers re-presents the same view objects (imports are cached per
  // bufferId), so the bind group can be reused instead of recreated each
  // commit -- avoiding per-frame WebGPU-object churn (and its N-API finalizer
  // cost). Baked with the surface's current mask; reset in setSurfaceMask when
  // the mask changes. WeakMap so a released import's view (and its cached bind
  // group) collect without manual eviction.
  bindGroupCache: WeakMap<GPUTextureView, GPUBindGroup>;
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
  // The committed buffer's format has no alpha channel (XRGB8888 / XBGR8888 /
  // XR24 etc.): its 4th byte is a don't-care value, so the shader must treat
  // the surface as fully opaque rather than sample that byte as alpha (which
  // an X11/Xwayland client may leave non-0xFF on a partial repaint, producing
  // spurious translucency). Default false (ARGB carries real alpha).
  opaque: boolean;
  // wp_viewport: dst overrides the surface's logical size; src crops the
  // sampled buffer region (surface coords). null/undefined = unset.
  viewportDst?: { width: number; height: number } | null;
  viewportSrc?: { x: number; y: number; width: number; height: number } | null;
  // xdg_surface.set_window_geometry: surface-local sub-rect the
  // client considers its "window" (excluding shadow / pop-out
  // chrome). When set, the buffer renders anchored so this rect's
  // (x, y) lands at the WM-assigned position; the surrounding
  // surface area overflows naturally. null/undefined = unset
  // (buffer top-left lines up with WM-assigned position, pre-CSD
  // behavior).
  geometry?: { x: number; y: number; width: number; height: number } | null;
  x: number;
  y: number;
  layoutW: number;
  layoutH: number;
  // Output-anchored surfaces (layer-shell popups, the scissor black-fill)
  // are positioned relative to the output's glass, not the world: the
  // per-output content camera does not shift them. Content surfaces
  // (toplevels, decorations, their subsurfaces/popups, phantoms) live in
  // world coordinates and pan with the camera. Non-content layer surfaces
  // and the cursor are exempted structurally (layer membership / cursor
  // target id) without needing this flag.
  outputAnchored: boolean;
  // Latest xdg_surface.configure serial sent for this surface, and the latest
  // serial the client acked. Drive the decoration content-gate release
  // (surfaceContentReady): the client is ready when ackSerial >= cfgSerial.
  // Both undefined for xwayland (no ack_configure).
  cfgSerial?: number;
  ackSerial?: number;
  present: boolean;
  // For dmabuf surfaces, the buffer the lifecycle machine has assigned as
  // current (0 = shm/none/not-yet-imported). Used to pair frameSampled events
  // with the right buffer id, and to know what to (re)bind into the bind group
  // when an import completes.
  currentBufferId: number;
  // Client damage (wl_surface.damage / damage_buffer) for the in-flight dmabuf
  // commit, in BUFFER pixels, reconciled by the protocol layer. Consumed when
  // the import binds (bindImportToSurface) to scope the OUTPUT repaint to the
  // changed region instead of the whole surface. null = no client damage (=>
  // repaint the full surface); undefined = none pending.
  pendingContentDamage?: ReadonlyArray<{ x: number; y: number; width: number; height: number }> | null;
  // Monotonic counter bumped every time the client commits NEW content to this
  // surface (a fresh dmabuf import bound, or an shm upload). The intercept
  // broker reads it (surfaceContentEpoch) to tell a plugin's render whether the
  // client content changed since its last render (ctx.contentChanged), so a
  // static effect can skip re-rendering when nothing changed.
  contentEpoch: number;
  // Shm fast-path texture handle (wire-allocated by Compositor::reserveShmTexture).
  // When set, this surface's `texture` is sampled but never written by the JS
  // device queue (the GPU process does queue.WriteTexture from its own mmap of
  // the pool, driven by ShmUpload frames). Reset when the surface switches
  // back to a dmabuf import or its dims change.
  shmTextureHandle?: bigint;
  fx: SurfaceFx;
  // Alpha mask sampled across the full expanded (surface + outputMargin)
  // region. null = use the compositor's shared 1x1-white default (no
  // visible effect). The bind group references the chosen mask's view;
  // setSurfaceMask rebuilds the bind group.
  maskView: GPUTextureView | null;
  // Buffer intercept: when set, the compositor's per-surface
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
// (colorMatrix, packed as 4 vec4 columns) + 3 vec4s (shape, shapeExtra,
// shapeMap) = 13 vec4s = 52 floats = 208 bytes.
const UNIFORM_BYTES = 208;
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
// shapeExtra / shapeMap vec4 slots (float indices 40..51). `winXPx`/`winYPx`
// are the WINDOW's logical pixel size the SDF eval works against, and `map`
// = (offsetU, offsetV, spanU, spanV) locates this surface's [0,1] within that
// window (identity 0,0,1,1 when the surface IS the window). Radii / per-corner /
// superellipse params are clamped to non-negative finite numbers (a bad value
// would propagate as NaN through the smoothstep and zero coverage -- "weird
// invisible window" failure mode, easier to reason about than NaN propagation).
function packShape(data: Float32Array, shape: SurfaceShape,
                   winXPx: number, winYPx: number,
                   map: { ox: number; oy: number; sx: number; sy: number },
                   radiusScale = 1): void {
  // shape (vec4 #10, floats 40..43): kind, winXpx, winYpx, radius
  // shapeExtra (vec4 #11, floats 44..47): kind-specific
  // shapeMap (vec4 #12, floats 48..51): offsetU, offsetV, spanU, spanV
  //
  // `radiusScale` converts radii from the shape's logical units into the
  // frame winXPx/winYPx are expressed in (the camera zoom when the window
  // frame is glass-space); exponents are dimensionless and pass through.
  data[41] = winXPx;
  data[42] = winYPx;
  data[48] = map.ox; data[49] = map.oy; data[50] = map.sx; data[51] = map.sy;
  if (shape === null) { data[40] = 0; return; }
  switch (shape.kind) {
    case "rounded-rect":
      data[40] = 1;
      data[43] = sanitizeNonNeg(shape.radius * radiusScale);
      return;
    case "rounded-rect-per-corner":
      data[40] = 2;
      data[44] = sanitizeNonNeg(shape.tl * radiusScale);
      data[45] = sanitizeNonNeg(shape.tr * radiusScale);
      data[46] = sanitizeNonNeg(shape.br * radiusScale);
      data[47] = sanitizeNonNeg(shape.bl * radiusScale);
      return;
    case "superellipse":
      data[40] = 3;
      data[43] = sanitizeNonNeg(shape.radius * radiusScale);
      // The shader clamps n>=2 inline; pass through here.
      data[44] = Number.isFinite(shape.exponent) ? shape.exponent : 2;
      return;
  }
}

function sanitizeNonNeg(v: number): number {
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

// surfUV->windowUV map for a surface that IS its own shape window (the shape's
// rect equals the surface's rect): no offset, full span.
const IDENTITY_SHAPE_MAP = { ox: 0, oy: 0, sx: 1, sy: 1 } as const;

// A window's rounded footprint (absolute logical coords) + the shape to clip
// its subtree with. Rebuilt each frame in shapeClipMap.
interface ShapeClip { x: number; y: number; w: number; h: number; shape: SurfaceShape; }

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
  // DRM fourcc, kept for the direct-scanout opacity check (alpha-less
  // formats only; a translucent buffer cannot skip compositing).
  fourcc: number;
}

// Alpha-less DRM fourccs eligible for direct scanout: nothing shows
// through them, so putting the buffer on the plane is visually identical
// to compositing it. Alpha-carrying variants (AR24 etc.) would need an
// opaque-region check to qualify.
const SCANOUT_OPAQUE_FOURCCS = new Set<number>([
  0x34325258, // XRGB8888 'XR24'
  0x34324258, // XBGR8888 'XB24'
  0x34325852, // RGBX8888 'RX24'
  0x34325842, // BGRX8888 'BX24'
  0x30335258, // XRGB2101010 'XR30'
  0x30334258, // XBGR2101010 'XB30'
]);

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
// getDrawList is re-evaluated each frame so subsurfaces committed after
// registration are picked up; ctx carries the region origin/scale so the
// pass renders at device resolution, the same mapping an on-screen output
// uses.
interface LiveScene {
  texture: GPUTexture;
  view: GPUTextureView;
  outputId: number;
  getDrawList: () => number[];
  ctx: OutputCtx;
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
    // resize, the registration is invalidated. Mid-life surface resize for
    // live window-comps is not handled here; the holder releases and
    // re-registers if it needs to track resizes.
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
const EMPTY_STACK: ReadonlyArray<number> = [];

interface OutputCtx {
  id: number;
  originX: number;
  originY: number;
  // Content-camera for this output: the output views the world starting
  // at (originX + cameraX, originY + cameraY), scaled by cameraZoom (a
  // world unit covers zoom logical output units; zoom < 1 shows more
  // world). Applies only to world-space surfaces (see
  // Surface.outputAnchored); layer-shell, the cursor, and output-anchored
  // surfaces use the plain origin unscaled. (0, 0, 1) = identity (the
  // output shows the slice at its arrangement position, the pre-camera
  // behavior).
  cameraX: number;
  cameraY: number;
  cameraZoom: number;
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
  // Per-output content camera (docs/canvas-design.md §4). Keyed by outputId;
  // absent = identity (0, 0, zoom 1). (x, y) shifts and zoom scales where
  // world-space surfaces land on the output (render + geometric cull +
  // damage partitioning): world w maps to output-local logical
  // (w - origin - camera) * zoom, so the view covers logical/zoom world
  // units. Output-anchored surfaces, non-content layers, and the cursor
  // ignore it.
  private cameras = new Map<number, { x: number; y: number; zoom: number }>();
  // Surfaces that gained presentable content since the last takeImportedSurfaces.
  private imported: Array<{ id: number; width: number; height: number }> = [];
  private warnedDmabuf = false;

  // Pool of compositor-owned textures reused for frozen-surface snapshots,
  // keyed by "WxH" device size. Bounded per size AND globally: each release
  // bumps its bucket to the map's tail (insertion order = recency), and
  // exceeding the global cap evicts from the least-recently-released size,
  // so a resize session that visits many distinct sizes doesn't pin one
  // pool of textures per size for the process lifetime.
  private snapPool = new Map<string, GPUTexture[]>();
  private snapPoolCount = 0;
  private static readonly SNAP_POOL_PER_SIZE = 4;
  private static readonly SNAP_POOL_MAX = 16;
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
  // Union of every non-content layer list, rebuilt on setLayerSurfaces.
  // Membership = the surface is glass-anchored for camera purposes
  // (cameraExempt) without any per-surface tagging.
  private layerIdSet = new Set<number>();

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
  // Per-frame callbacks the broker registers for cross-device
  // dmabuf compose-live. Each callback owns its own ring + producer; the
  // compositor doesn't know the target. Invoked after the on-screen frame
  // composite (and the existing liveScenes/liveWindowComps passes), so the
  // producer's compose pass shares the frame's encoder + submit.
  private liveProducers: Array<() => void> = [];

  // Closing-animation phantoms. When a mapped toplevel
  // unmaps, the compositor composites its surface set (toplevel +
  // decoration + subsurfaces) into a fresh core-owned texture, mints
  // a new surfaceId for the phantom, and tracks it here. Phantoms
  // are drawn above the content stack (between content and the
  // 'above' layer) so they sit on top of the survivors reflowing
  // into the closing window's vacated tile. The plugin owns lifetime
  // via destroyPhantom; the broker also enforces a backstop timeout.
  // Insertion order = z order within the phantom group.
  private phantoms: number[] = [];

  // Subsurface tree accessor (set by main.ts / the test harness). The only
  // channel by which the compositor learns the subsurface tree: setSurfaceLayout
  // derives each child's absolute placement from it, and the fx setters cascade
  // over it. Null in pure structural tests -> cascade is inert.
  private subsurfaceAccessor: import("../subsurfaces.js").SubsurfaceAccessor | null = null;
  // Non-subsurface fx-followers per window: a decorated window's decoration
  // surface receives the window's transform/opacity/tint/color-matrix but keeps
  // its own layout rect. Keyed by the window (content) surface id.
  private fxFollowers = new Map<number, number[]>();
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
  // Output damage for an shm fast-path commit, deferred until its async upload
  // acks (keyed by uploadSeq). Damaging at commit time would repaint -- and
  // sample -- the texture before the GPU process has written it. Drained in
  // takeShmUploadAcks alongside the deferred wl_buffer.release.
  private shmUploadDamage = new Map<number, { id: number;
    damage: ReadonlyArray<{ x: number; y: number; width: number; height: number }> | null }>();

  // Outputs presented since the last takePresentedOutputs() drain. A present
  // means a page-flip is in flight whose flip-complete will deliver that
  // output's frame callbacks; the dispatch layer consults this so it doesn't
  // also deliver them off the idle tick (which would race ahead of the flip).
  private presentedOutputs = new Set<number>();

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

    // Linear, not nearest: at a fractional output scale (or an integer-scale
    // client on any output) surface content is resampled at composite, and
    // nearest turns that into dropped/duplicated pixel rows -- visibly
    // pixelated text. At true 1:1 (texel-aligned quads) linear sampling at
    // texel centers is exact, so the crisp paths lose nothing.
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
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

    // Transition pipeline. A separate pipeline because the
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
    // Cameras for outputs that no longer exist are dropped (a returning
    // output starts at identity; core re-applies its persisted camera).
    for (const id of [...this.cameras.keys()]) {
      if (!this.outputsGeom.has(id)) {
        this.cameras.delete(id);
        this.outputDamage.setCamera(id, 0, 0, 1);
      }
    }
    // Hardware-cursor state for vanished outputs goes with them (the GPU
    // process tore the plane down with the connector). A surviving output
    // whose scale changed needs its cursor image re-shipped at the new
    // device size.
    for (const id of [...this.hwCursorCaps.keys()]) {
      if (!this.outputsGeom.has(id)) {
        this.hwCursorCaps.delete(id);
        this.hwCursorActive.delete(id);
        this.hwCursorLastSent.delete(id);
        this.hwCursorHotspotDev.delete(id);
      }
    }
    // A theme-shape cursor re-resolves against the (possibly changed)
    // output scales -- both the software image (highest scale) and each
    // plane's exact-scale copy. Fixed-bitmap / client cursors just re-ship.
    const shp = this.cursorShapeResolver;
    if (shp && this.cursorTargetSurfaceId === this.internalCursorSurfaceId) {
      this.setCursorShape(shp.resolve, shp.logicalSizePx);
    } else {
      this.refreshHwCursorImage();
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
    const cam = this.cameras.get(o.id);
    return {
      id: o.id,
      originX: o.logicalX, originY: o.logicalY,
      cameraX: cam ? cam.x : 0, cameraY: cam ? cam.y : 0,
      cameraZoom: cam ? cam.zoom : 1,
      scale,
      deviceWidth: o.deviceWidth, deviceHeight: o.deviceHeight,
      logicalWidth: Math.max(1, Math.round(o.deviceWidth / scale)),
      logicalHeight: Math.max(1, Math.round(o.deviceHeight / scale)),
    };
  }

  // Set (or clear, with (0, 0, 1)) the content camera for one output. A
  // camera change moves every world-space surface on that output at once,
  // so the whole output repaints. Unknown outputIds are stored anyway --
  // the camera applies when the output appears (setOutputs prunes stale
  // entries). Non-finite or non-positive zoom is coerced to 1.
  setOutputCamera(outputId: number, x: number, y: number, zoom = 1): void {
    const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const cur = this.cameras.get(outputId);
    const cx = cur ? cur.x : 0;
    const cy = cur ? cur.y : 0;
    const cz = cur ? cur.zoom : 1;
    if (cx === x && cy === y && cz === z) return;
    if (x === 0 && y === 0 && z === 1) this.cameras.delete(outputId);
    else this.cameras.set(outputId, { x, y, zoom: z });
    this.outputDamage.setCamera(outputId, x, y, z);
    this.outputDamage.fullOutput(outputId);
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
    // Debug/mitigation knob: force full repaints (disable the composite
    // scissor). Rules out -- or works around -- damage-accounting bugs at the
    // cost of full-frame composites.
    if (process.env.OVERDRAW_FULL_REPAINT === "1") return undefined;
    return repaint.mode === "partial" ? repaint.box : undefined;
  }

  // Stack/layer reorders change occlusion at arbitrary places; repaint full.
  setStack(ids: number[]): void {
    // Only repaint when the stack actually changed. applySubsurfaces re-runs
    // this on every content-surface commit (including a client's no-op frame-
    // callback-only commit); damaging unconditionally would force a full repaint
    // per commit, and a client that keeps a frame callback pending (Firefox)
    // would then loop: empty commit -> repaint -> flip -> wl_callback.done ->
    // empty commit. Identical stack -> nothing to draw.
    if (this.stack.length === ids.length && this.stack.every((v, i) => v === ids[i])) return;
    this.stack = ids.slice();
    this.damageFull();
  }

  setOutputStack(outputId: number, ids: number[] | null): void {
    // Only repaint when this output's stack actually changed. Re-run on every
    // content-surface commit (applySubsurfaces), so an unconditional damageFull
    // repaints per commit and loops a frame-callback-driven client (see setStack).
    const cur = this.outputStacks.get(outputId);
    if (ids === null) {
      if (cur === undefined) return;
      this.outputStacks.delete(outputId);
    } else {
      if (cur && cur.length === ids.length && cur.every((v, i) => v === ids[i])) return;
      this.outputStacks.set(outputId, ids.slice());
    }
    this.damageFull();
  }

  setLayerSurfaces(layer: Layer, ids: number[]): void {
    if (layer === "content") { this.stack = ids.slice(); this.damageFull(); return; }
    this.layers.set(layer, ids.slice());
    this.layerIdSet.clear();
    for (const list of this.layers.values()) {
      for (const id of list) this.layerIdSet.add(id);
    }
    this.damageFull();
  }

  // Mark a surface as positioned relative to its output's glass rather than
  // the world (see Surface.outputAnchored). Used for surfaces that ride the
  // content stack but must not pan with the camera: popups whose parent is a
  // layer-shell surface.
  setSurfaceOutputAnchored(id: number, anchored: boolean): void {
    const s = this.ensureSurface(id);
    if (s.outputAnchored === anchored) return;
    s.outputAnchored = anchored;
    // The flag changes where the surface renders only under a non-identity
    // camera; repaint everything for that rare transition.
    if (this.cameras.size > 0) this.damageFull();
  }

  // True when the per-output content camera does NOT move this surface:
  // output-anchored surfaces, non-content layer surfaces (bars, wallpaper),
  // and the cursor sprite are glass-positioned. A subsurface inherits its
  // ancestors' anchoring (a bar's subsurface must not pan away from the bar),
  // so walk the parent chain when the surface itself isn't exempt.
  private cameraExempt(id: number, s: Surface): boolean {
    if (s.outputAnchored || this.layerIdSet.has(id)
      || id === this.cursorTargetSurfaceId) return true;
    const parentOf = this.subsurfaceAccessor?.parent;
    if (!parentOf) return false;
    for (let p = parentOf(id); p !== null; p = parentOf(p)) {
      const ps = this.surfaces.get(p);
      if ((ps && ps.outputAnchored) || this.layerIdSet.has(p)) return true;
    }
    return false;
  }

  // The full back-to-front draw order for one output: each layer in
  // LAYER_ORDER, with the content layer taken from that output's override
  // (setOutputStack) when set, else the global `this.stack`. Phantoms, layers,
  // and cursor are global (drawn into every output's viewport; the renderer's
  // per-output viewport + scissor confines them to where they belong in global
  // logical space).
  // Island backdrops: world-space translucent quads drawn at the bottom of
  // the content segment (above wallpaper / bottom layers, below every
  // window). Each is a compositor-private Surface with a 1x1 colored
  // texture stretched to its rect; world-space (not outputAnchored), so
  // the camera pans/zooms them with the islands they mark. Ids come from
  // a private negative range -- they never collide with protocol surface
  // ids and are invisible to residency/hit-testing (not in the WM).
  private static readonly BACKDROP_ID_BASE = -0x40000000;
  private backdropIds: number[] = [];
  // Packed rgba currently uploaded to each backdrop's texel.
  private backdropColors: number[] = [];

  setIslandBackdrops(list: ReadonlyArray<{
    x: number; y: number; width: number; height: number;
    // 0-255 straight-alpha color.
    color: { r: number; g: number; b: number; a: number };
  }>): void {
    // Any count change repaints -- computed BEFORE the shrink loop below
    // equalizes the lengths, so a removal-only update still damages the
    // vacated regions.
    let changed = this.backdropIds.length !== list.length;
    // Shrink: drop surplus backdrop surfaces.
    while (this.backdropIds.length > list.length) {
      const id = this.backdropIds.pop();
      this.backdropColors.pop();
      if (id === undefined) break;
      const s = this.surfaces.get(id);
      s?.texture?.destroy();
      s?.uniformBuf?.destroy();
      this.surfaces.delete(id);
    }
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      let id = this.backdropIds[i];
      if (id === undefined) {
        id = JsCompositor.BACKDROP_ID_BASE - i;
        this.backdropIds[i] = id;
        const s = blankSurface(b.x, b.y, b.width, b.height);
        const tex = this.device.createTexture({
          size: { width: 1, height: 1 },
          format: "bgra8unorm",
          usage: this.g.GPUTextureUsage.TEXTURE_BINDING | this.g.GPUTextureUsage.COPY_DST,
        });
        s.texture = tex;
        s.view = tex.createView();
        s.width = 1; s.height = 1; s.present = true;
        this.rebuildBindGroup(s, s.view);
        this.surfaces.set(id, s);
        changed = true;
      }
      const s = this.surfaces.get(id);
      if (!s) continue;
      if (s.x !== b.x || s.y !== b.y || s.layoutW !== b.width || s.layoutH !== b.height) {
        s.x = b.x; s.y = b.y; s.layoutW = b.width; s.layoutH = b.height;
        changed = true;
      }
      // The 1x1 texel carries the color; straight alpha, and the draw
      // path blends (opaque=false). Premultiply for the blend the
      // pipeline uses on sampled textures (client buffers arrive
      // premultiplied; ours must match or translucency over-brightens).
      const key = (b.color.r << 24 | b.color.g << 16 | b.color.b << 8 | b.color.a) >>> 0;
      if (this.backdropColors[i] !== key) {
        this.backdropColors[i] = key;
        const a = Math.max(0, Math.min(255, b.color.a));
        const pm = (v: number): number =>
          Math.round(Math.max(0, Math.min(255, v)) * a / 255);
        this.device.queue.writeTexture(
          { texture: s.texture as GPUTexture },
          new Uint8Array([pm(b.color.b), pm(b.color.g), pm(b.color.r), a]),
          { offset: 0, bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1 },
        );
        changed = true;
      }
    }
    if (changed) this.damageFull();
  }

  private drawOrder(outputId: number, includeCursor = true): number[] {
    const out: number[] = [];
    // Per-output content stack via setOutputStack when set. The fallback
    // to the global setStack list is for callers that don't push per-
    // output stacks (single-output tests, pre-workspace bring-up); once
    // ANY output has a per-output stack, missing entries are treated as
    // empty rather than mirroring the global stack -- otherwise an
    // output with no workspace shown ends up drawing every toplevel
    // (wrong position, wrong scale, wrong everything).
    const useGlobal = this.outputStacks.size === 0;
    const content = this.outputStacks.get(outputId)
                 ?? (useGlobal ? this.stack : EMPTY_STACK);
    for (const layer of LAYER_ORDER) {
      if (layer === "content") {
        // Island backdrops sit at the bottom of the content segment:
        // above wallpaper/bottom layers, below every window.
        if (this.backdropIds.length > 0) out.push(...this.backdropIds);
        out.push(...content);
        // Phantoms (closing-animation snapshots) draw on top of the content
        // layer but below the 'above' layer. Insertion order = z order; the
        // most recently closed window's phantom is on top of older phantoms.
        if (this.phantoms.length > 0) out.push(...this.phantoms);
      }
      else { const ids = this.layers.get(layer); if (ids) out.push(...ids); }
    }
    // The cursor is always on top -- above every layer,
    // above phantoms, above any plugin overlay. The target surfaceId
    // can be the internal cursor surface (CPU-uploaded image) or any
    // existing surface (e.g. a wl_pointer.set_cursor client surface).
    // Visibility flag + target-set + target-has-texture gate inclusion.
    // Outputs whose KMS cursor plane carries the cursor skip it here.
    if (includeCursor && !this.hwCursorActive.has(outputId)
        && this.cursorVisible && this.cursorTargetSurfaceId !== null) {
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
      // Unchanged placement is a no-op: applySubsurfaces re-emits every
      // subsurface's layout on each commit, so damaging here unconditionally
      // would repaint the whole rect per commit (and loop a client that keeps
      // a frame callback pending -- see setStack).
      if (s.x === x && s.y === y && s.layoutW === w && s.layoutH === h) return;
      // Damage both the vacated and the new rect (move/resize). A subsurface is
      // placed size-from-intrinsic (layoutW/H = 0); its on-screen footprint is
      // the buffer's logical size (or the viewport destination). Damage that
      // effective size, not the 0x0 layout -- a zero-area rect is dropped by the
      // damage ring (and never sets the dirty bit), so a moved subsurface would
      // otherwise leave stale pixels at its old position and never paint the new
      // one until some other damage forces a full recomposite.
      const bs = s.bufferScale || 1;
      const effW = (lw: number): number =>
        lw > 0 ? lw : (s.viewportDst?.width ?? s.viewportSrc?.width ?? s.width / bs);
      const effH = (lh: number): number =>
        lh > 0 ? lh : (s.viewportDst?.height ?? s.viewportSrc?.height ?? s.height / bs);
      if (this.fxDrawsOutsideLayout(s)) {
        // An active fx transform/mask draws beyond the layout rect at BOTH the
        // old and new placement; a plain old+new rect damage would miss the
        // transformed footprint and leave residue in some scanout slot. Force a
        // whole-output repaint across every ring slot.
        s.x = x; s.y = y; s.layoutW = w; s.layoutH = h;
        this.damageFull();
      } else {
        const anchored = this.cameraExempt(id, s);
        this.addOutputDamage(s.x, s.y, effW(s.layoutW), effH(s.layoutH), anchored);
        s.x = x; s.y = y; s.layoutW = w; s.layoutH = h;
        this.addOutputDamage(x, y, effW(w), effH(h), anchored);
      }
    } else {
      this.surfaces.set(id, blankSurface(x, y, w, h));
      this.addOutputDamage(x, y, w, h);
    }
    // Cascade: a subsurface's absolute placement is its parent's rect + offset,
    // so moving/resizing a parent re-lays its whole subtree. The recursion
    // reuses the per-surface move-damage above, so each child damages its
    // old+new footprint.
    this.cascadeSubsurfaceLayout(id, x, y);
  }

  // Re-place `parentId`'s direct subsurface children from (px, py) = the
  // parent's absolute top-left; each child recurses through setSurfaceLayout,
  // so nested subsurfaces follow too. Children are content-sized (w/h 0).
  private cascadeSubsurfaceLayout(parentId: number, px: number, py: number): void {
    const acc = this.subsurfaceAccessor;
    if (!acc) return;
    for (const c of acc.children(parentId)) {
      this.setSurfaceLayout(c.id, px + c.offX, py + c.offY, 0, 0);
    }
  }

  // Re-derive `parentId`'s subsurface subtree from the parent's CURRENT stored
  // rect. Used when the tree changed but the parent's own rect did not (a child
  // gained content, set_position applied on parent commit, a sibling reorder).
  reflowSubsurfaces(parentId: number): void {
    const s = this.surfaces.get(parentId);
    if (!s) return;
    this.cascadeSubsurfaceLayout(parentId, s.x, s.y);
  }

  setSubsurfaceAccessor(accessor: import("../subsurfaces.js").SubsurfaceAccessor): void {
    this.subsurfaceAccessor = accessor;
  }

  // Bind (or clear) a window's decoration as an fx-follower. The decoration
  // then receives the window's transform/opacity/tint/color-matrix via the fx
  // cascade, keeping a decorated window visually unified during animations,
  // while retaining its own layout rect (set separately by the WM).
  setDecorationFx(windowId: number, decorationId: number | null): void {
    if (decorationId === null) this.fxFollowers.delete(windowId);
    else this.fxFollowers.set(windowId, [decorationId]);
  }

  // Every surface id the fx cascade should touch for `id`: the surface itself,
  // its subsurface subtree (position-children also follow fx), and any
  // non-subsurface fx-followers (the decoration). Depth-first; deduped by the
  // tree structure (a surface has one parent).
  private fxCascadeTargets(id: number): number[] {
    const out: number[] = [id];
    const acc = this.subsurfaceAccessor;
    if (acc) {
      const walk = (pid: number): void => {
        for (const c of acc.children(pid)) { out.push(c.id); walk(c.id); }
      };
      walk(id);
    }
    const followers = this.fxFollowers.get(id);
    if (followers) out.push(...followers);
    return out;
  }

  // Per-surface shape-clip footprint, rebuilt each frame by refreshShapeClips.
  // A surface present here is clipped to the mapped window's rounded shape (the
  // surface itself for a shaped window; the enclosing window for its
  // subsurfaces). Absent -> the surface's own fx.shape (or none) applies.
  private shapeClipMap = new Map<number, ShapeClip>();

  // Rebuild shapeClipMap: for every surface carrying a shape, stamp a clip
  // footprint onto itself and cascade one down its subsurface subtree, so a
  // window's rounded corners clip its content subsurfaces (Firefox renders its
  // content as one full-window subsurface; without this its square corners
  // escape the decoration's rounded shape). A subsurface carrying its OWN shape
  // starts a fresh footprint for its subtree.
  //
  // The shaped surface itself clips to the rect its shape is drawn over -- the
  // intercept output's outer (border) rect when decorated, else its layout
  // rect -- rounding the window's OUTER boundary. Its subsurfaces clip to the
  // CONTENT rect (the layout rect, inside the border) so the content rounds
  // within the border ring rather than over it. When the shaped surface is a
  // 0x0 container (a client whose content lives entirely in a subsurface), the
  // content footprint is degenerate and updateUniforms falls back to the
  // subsurface's own rect -- which IS the content, so it clips correctly.
  private refreshShapeClips(): void {
    this.shapeClipMap.clear();
    const acc = this.subsurfaceAccessor;
    for (const [id, s] of this.surfaces) {
      if (s.fx.shape === null) continue;
      const p = s.interceptPlacement;
      const own: ShapeClip = p
        ? { x: p.x, y: p.y, w: p.w, h: p.h, shape: s.fx.shape }
        : { x: s.x, y: s.y, w: s.layoutW, h: s.layoutH, shape: s.fx.shape };
      this.shapeClipMap.set(id, own);
      if (!acc) continue;
      const content: ShapeClip = {
        x: s.x, y: s.y, w: s.layoutW, h: s.layoutH, shape: s.fx.shape,
      };
      const walk = (pid: number): void => {
        for (const c of acc.children(pid)) {
          const cs = this.surfaces.get(c.id);
          // A nested shaped surface owns its subtree's clip; the outer loop
          // stamps it from its own footprint, so skip it and its descendants.
          if (cs && cs.fx.shape !== null) continue;
          this.shapeClipMap.set(c.id, content);
          walk(c.id);
        }
      };
      walk(id);
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
    if (!this.beginClientAccess(s.currentBufferId, imp.importId)) {
      this.releaseSnapTex(snap);
      return;
    }
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

  // Whether the client has produced content in response to our latest
  // configure -- the signal ctx.contentReady exposes to drive an intercept's
  // gate release. See contentGateReleased: a drawable buffer plus (for xdg)
  // an ack of the latest configure serial. Size is deliberately NOT compared.
  surfaceContentReady(id: number): boolean {
    const s = this.surfaces.get(id);
    if (!s) return false;
    return contentGateReleased({
      hasBuffer: !!s.texture, layoutW: s.layoutW, layoutH: s.layoutH,
      cfgSerial: s.cfgSerial, ackSerial: s.ackSerial,
    });
  }

  // Stamp the latest xdg_surface.configure serial sent for this surface, and
  // the latest serial the client acked. surfaceContentReady gates the
  // decoration content-gate on (ackSerial >= cfgSerial).
  notifyConfigureSerial(id: number, serial: number): void {
    const s = this.surfaces.get(id) ?? this.ensureSurface(id);
    s.cfgSerial = serial;
  }
  notifyAckSerial(id: number, serial: number): void {
    const s = this.surfaces.get(id);
    if (s) s.ackSerial = Math.max(s.ackSerial ?? -1, serial);
  }


  // True if the surface has a drawable buffer presenting at logical size (w, h)
  // -- the WM gates a held resize's apply on this so it never thaws onto a
  // not-yet-imported (or stale-size) buffer. Readiness is judged in LOGICAL
  // space only: a wp_viewport destination (or source crop) defines the logical
  // size directly, and a buffer's pixel dims are the client's own business -- a
  // fractional-scale or viewporter client (e.g. Firefox) picks a buffer
  // resolution unrelated to logical*scale, so any buffer-pixel equality gate
  // here would never pass and would stall the held transaction indefinitely.
  surfaceReadyAt(id: number, w: number, h: number): boolean {
    const s = this.surfaces.get(id);
    if (!s || !s.present || !s.view || s.currentBufferId === 0) return false;
    const bs = s.bufferScale || 1;
    const lw = s.viewportDst?.width ?? s.viewportSrc?.width ?? (s.width / bs);
    const lh = s.viewportDst?.height ?? s.viewportSrc?.height ?? (s.height / bs);
    return Math.round(lw) === w && Math.round(lh) === h;
  }

  private acquireSnapTex(w: number, h: number): FrozenSnapshot {
    const key = `${w}x${h}`;
    const free = this.snapPool.get(key);
    let pooled: GPUTexture | undefined;
    if (free && free.length > 0) {
      pooled = free.pop();
      this.snapPoolCount--;
      if (free.length === 0) this.snapPool.delete(key);
    }
    const tex = pooled ?? this.device.createTexture({
      size: { width: w, height: h },
      format: this.format,
      usage: this.g.GPUTextureUsage.RENDER_ATTACHMENT | this.g.GPUTextureUsage.TEXTURE_BINDING,
    });
    return { tex, view: tex.createView(), w, h };
  }

  private releaseSnapTex(snap: FrozenSnapshot): void {
    const key = `${snap.w}x${snap.h}`;
    // Delete + re-set so the bucket moves to the map's tail (most recent).
    const existing = this.snapPool.get(key);
    const free = existing ?? [];
    if (existing) this.snapPool.delete(key);
    this.snapPool.set(key, free);
    if (free.length < JsCompositor.SNAP_POOL_PER_SIZE) {
      free.push(snap.tex);
      this.snapPoolCount++;
    } else {
      snap.tex.destroy();
    }
    // Global bound: evict from the least-recently-released size bucket.
    // The current bucket was just bumped to the tail, so the head is
    // always a different (older) size once the cap is exceeded.
    while (this.snapPoolCount > JsCompositor.SNAP_POOL_MAX) {
      const oldest = this.snapPool.entries().next().value;
      if (!oldest) break;
      const [oldKey, texes] = oldest;
      const tex = texes.shift();
      if (tex) { tex.destroy(); this.snapPoolCount--; }
      if (texes.length === 0) this.snapPool.delete(oldKey);
    }
  }

  // These three are re-pushed on EVERY wl_surface.commit (applySurfaceState),
  // so they must damage only on an actual change -- otherwise a client's no-op
  // commit repaints the surface every frame (a frame-callback-driven client
  // like Firefox then loops; see setStack).
  setSurfaceBufferScale(id: number, scale: number): void {
    const s = this.surfaces.get(id) ?? this.ensureSurface(id);
    const v = scale > 0 ? scale : 1;
    if (s.bufferScale === v) return;
    s.bufferScale = v;
    this.damageSurface(id);
  }

  setSurfaceBufferTransform(id: number, transform: number): void {
    const s = this.surfaces.get(id) ?? this.ensureSurface(id);
    const v = (transform >= 0 && transform <= 7) ? transform : 0;
    if (s.bufferTransform === v) return;
    s.bufferTransform = v;
    this.damageSurface(id);
  }

  setSurfaceViewport(
    id: number,
    dst: { width: number; height: number } | null,
    src: { x: number; y: number; width: number; height: number } | null,
  ): void {
    const s = this.surfaces.get(id) ?? this.ensureSurface(id);
    const dstSame = (s.viewportDst == null && dst == null)
      || (!!s.viewportDst && !!dst && s.viewportDst.width === dst.width && s.viewportDst.height === dst.height);
    const srcSame = (s.viewportSrc == null && src == null)
      || (!!s.viewportSrc && !!src && s.viewportSrc.x === src.x && s.viewportSrc.y === src.y
          && s.viewportSrc.width === src.width && s.viewportSrc.height === src.height);
    if (dstSame && srcSame) return;
    s.viewportDst = dst;
    s.viewportSrc = src;
    this.damageSurface(id);
  }

  setSurfaceGeometry(
    id: number,
    geom: { x: number; y: number; width: number; height: number } | null,
  ): void {
    const s = this.surfaces.get(id) ?? this.ensureSurface(id);
    const cur = s.geometry;
    const same = (cur == null && geom == null)
      || (!!cur && !!geom && cur.x === geom.x && cur.y === geom.y
          && cur.width === geom.width && cur.height === geom.height);
    if (same) return;
    s.geometry = geom;
    this.damageSurface(id);
  }

  // Per-surface render-state setters (core-plugin-api.md §1). Cheap: they
  // mutate the per-surface SurfaceFx; the values flow into the WGSL Uniforms
  // each frame via updateUniforms. Auto-create the Surface so callers don't
  // race the protocol layer's setSurfaceLayout.
  // The fx setters cascade over the surface's fx group (itself + subsurface
  // subtree + decoration follower), so a caller moves/fades a whole window with
  // one call. Each member gets the SAME value (scale is anchored per-surface --
  // exact for translate, approximate for scale at animation timescales).
  setSurfaceOpacity(id: number, opacity: number): void {
    const v = clamp(opacity, 0, 1);
    for (const t of this.fxCascadeTargets(id)) {
      this.ensureSurface(t).fx.opacity = v;
      this.damageSurface(t);  // alpha change stays within the surface rect
    }
  }

  setSurfaceTransform(id: number, t: SurfaceTransform): void {
    const tx = t.translateX ?? 0, ty = t.translateY ?? 0;
    const sx = t.scaleX ?? 1, sy = t.scaleY ?? 1;
    for (const tid of this.fxCascadeTargets(id)) {
      const fx = this.ensureSurface(tid).fx;
      fx.translateX = tx; fx.translateY = ty; fx.scaleX = sx; fx.scaleY = sy;
    }
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
    const r = t.r ?? 1, g = t.g ?? 1, b = t.b ?? 1, a = t.a ?? 1;
    for (const tid of this.fxCascadeTargets(id)) {
      const fx = this.ensureSurface(tid).fx;
      fx.tintR = r; fx.tintG = g; fx.tintB = b; fx.tintA = a;
      this.damageSurface(tid);
    }
  }

  // Install a 4x4 color matrix applied to the sampled rgba each frame. The
  // caller passes 16 numbers in column-major order (WGSL mat4x4f layout).
  // null restores the identity matrix.
  setSurfaceColorMatrix(id: number, m: ColorMatrix | null): void {
    const targets = this.fxCascadeTargets(id);
    if (m === null) {
      for (const tid of targets) {
        this.ensureSurface(tid).fx.colorMatrix = identityColorMatrix();
        this.damageSurface(tid);
      }
      return;
    }
    if (m.length !== 16) {
      throw new Error(`setSurfaceColorMatrix: expected 16 numbers, got ${m.length}`);
    }
    for (const tid of targets) {
      // Fresh array per surface: the caller's array is theirs to mutate, and
      // members must not share a mutable buffer.
      const dst = new Float32Array(16);
      for (let i = 0; i < 16; i++) dst[i] = m[i] ?? 0;
      this.ensureSurface(tid).fx.colorMatrix = dst;
      this.damageSurface(tid);
    }
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
    // The cached bind groups bake in the old mask; drop them so the mask change
    // takes effect on every view they covered.
    s.bindGroupCache = new WeakMap();
    // Rebuild the bind group if a surface view already exists. If no surface
    // texture is committed yet, the mask installs into the Surface struct;
    // the next rebuildBindGroup (on first content) will pick it up.
    if (s.view) this.rebuildBindGroup(s, s.view);
    this.damageFull();  // mask spans the expanded (surface + margin) region
  }

  // Mark whether the surface's committed buffer format carries a real alpha
  // channel. Called from the protocol commit path with the buffer format; an
  // opaque (X-alpha) format makes the shader force alpha=1 (see the fragment
  // shader). Cheap flag flip; the draw-time uniform picks it up.
  setSurfaceOpaque(id: number, opaque: boolean): void {
    this.ensureSurface(id).opaque = opaque;
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
    this.fxFollowers.delete(id);
    this.lastShmSource.delete(id);

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
      // Repaint the region the surface vacated. A surface with an active fx
      // transform/mask (notably a closing-window phantom mid-animation) drew
      // OUTSIDE its layout rect, and its last-presented footprint may sit in a
      // scanout slot that only accumulates small unrelated damage afterward --
      // so a plain layout-rect damage would leave that transformed residue in
      // the slot. Force a full-output repaint so every ring slot is cleared.
      if (this.fxDrawsOutsideLayout(s)) {
        this.damageFull();
      } else {
        this.addOutputDamage(s.x, s.y, s.layoutW, s.layoutH,
          this.cameraExempt(id, s));
      }
    }
    this.surfaces.delete(id);
  }

  // Upload a committed shm buffer into the surface's sampled texture.
  // FAST PATH: when the addon exposes reserveShmTexture/commitShmUpload AND
  // the wire is up, route the upload through the GPU process: it mmaps the
  // shm pool itself and does queue.WriteTexture in-process, so we pay only
  // the cost of a small wire frame on the JS thread (microseconds) instead
  // of the per-frame 47 MiB writeTexture marshaling that pegs libuv for
  // tens of ms with Qt-style raster clients. Returns the uploadSeq the
  // caller waits on for the wl_buffer.release (0 means fall back to the
  // local upload). The slow fallback uses addon.shmView + queue.writeTexture
  // directly (in-process Dawn wire); used by tests with no GPU process or
  // when the addon predates the shm fast-path API.
  commitSurfaceBuffer(id: number, poolId: number, offset: number,
                      width: number, height: number, stride: number,
                      damage?: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): boolean {
    if (this.tryCommitShmFast(id, poolId, offset, width, height, stride, damage) > 0) {
      return true;
    }
    const ab = this.addon.shmView(poolId, offset, stride * height);
    if (!ab) return false;
    this.uploadPixels(id, { width, height, stride }, ab, damage);
    this.imported.push({ id, width, height });
    this.bumpContentEpoch(id);
    return true;
  }

  // Per-surface shm-fast-path uploadSeq. Non-zero on success. The protocol
  // layer (wl_surface.ts) calls commitSurfaceBufferShm to drive the path
  // and defer the wl_buffer.release until takeShmUploadAcks reports the
  // matching seq.
  commitSurfaceBufferShm(id: number, poolId: number, offset: number,
                         width: number, height: number, stride: number,
                         damage?: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): number {
    return this.tryCommitShmFast(id, poolId, offset, width, height, stride, damage);
  }

  // Drain GPU-process ShmUploaded reply seqs. The wl_surface layer drains
  // this each tick (in dispatchFrameCallbacks) and fires deferred releases.
  // No-op when the addon predates the fast-path API.
  takeShmUploadAcks(): number[] {
    const acks = this.addon.takeShmUploadAcks?.() ?? [];
    // Apply each commit's deferred output damage now that its upload landed.
    for (const seq of acks) {
      const d = this.shmUploadDamage.get(seq);
      if (d) { this.shmUploadDamage.delete(seq); this.damageSurfaceRegion(d.id, d.damage); }
    }
    return acks;
  }

  // Drain the set of outputs presented since the last call.
  takePresentedOutputs(): number[] {
    if (this.presentedOutputs.size === 0) return [];
    const out = [...this.presentedOutputs];
    this.presentedOutputs.clear();
    return out;
  }

  // True while a committed buffer for this surface is still being applied: an
  // shm upload not yet acked, or a dmabuf import not yet bound. Both defer the
  // surface's output damage until completion, so such a surface has a present
  // coming -- its frame callbacks wait for that present's flip-complete rather
  // than being delivered off the idle tick (which would let it free-run).
  surfaceHasContentInFlight(id: number): boolean {
    for (const d of this.shmUploadDamage.values()) if (d.id === id) return true;
    for (const p of this.dmabufPending.values()) {
      if (p.pendingInstalls.includes(id)) return true;
    }
    return false;
  }

  // Whether an output still has damage queued (a present is pending for it).
  isOutputDirty(id: number): boolean {
    return this.outputDamage.isDirty(id);
  }

  // Wire up a wgpu::Texture (already InjectTexture'd at the GPU process by
  // a prior AllocShmTex frame) as the surface's sampleable texture. Builds
  // the view + bind group, sets dims, pushes to `imported` so the first-
  // content map flow runs. Idempotent under matching (id, width, height,
  // texture handle).
  private installShmTexture(id: number, width: number, height: number,
                            wireTexHandle: bigint): boolean {
    if (!this.dawn || this.deviceHandle === 0n) return false;
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }
    // If the surface already has a wire-shm texture at these dims, keep it.
    if (s.shmTextureHandle === wireTexHandle
        && s.texture && s.width === width && s.height === height) {
      return true;
    }
    // Destroy any prior client-owned texture (e.g. a writeTexture-path one,
    // or a stale shm wire texture at different dims).
    if (s.texture) { try { s.texture.destroy(); } catch { /* */ } }
    const tex = this.dawn.wrapTexture(this.deviceHandle, wireTexHandle);
    s.texture = tex;
    const view = tex.createView();
    s.view = view;
    s.width = width;
    s.height = height;
    s.shmTextureHandle = wireTexHandle;
    this.rebuildBindGroup(s, view);
    return true;
  }

  // Implementation of the shm fast path. Allocates a per-surface wire
  // texture lazily (or on dim change), sends the ShmUpload frame, and
  // returns the uploadSeq. Returns 0 if the addon doesn't support the
  // fast path or the wire is down -- the caller falls back to writeTexture.
  private tryCommitShmFast(id: number, poolId: number, offset: number,
                           width: number, height: number, stride: number,
                           damage?: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): number {
    const reserve = this.addon.reserveShmTexture;
    const upload = this.addon.commitShmUpload;
    if (!reserve || !upload || !this.dawn || this.deviceHandle === 0n) return 0;
    // (Re)allocate the wire-side texture on first commit or on size change.
    const s = this.surfaces.get(id);
    const needNewTex = !s || !s.texture || s.shmTextureHandle === undefined
        || s.width !== width || s.height !== height;
    if (needNewTex) {
      const handle = reserve(id, width, height);
      if (handle === null) return 0;
      if (!this.installShmTexture(id, width, height, handle)) return 0;
    }
    // Freshly allocated wire textures have undefined VkImage contents
    // (VK_IMAGE_LAYOUT_UNDEFINED at creation). A partial-damage upload
    // would only initialize the damaged rows; the rest of the texture
    // would sample as garbage. Mirror the local uploadPixels rule:
    // first upload after (re)allocate is always full-buffer. Empty
    // damage in ShmUpload means "full buffer" on the GPU process.
    const sendDamage = needNewTex ? undefined : damage;
    // Send the upload frame. The GPU process resolves surfaceId to the
    // injected texture and runs queue.WriteTexture from its own mmap of
    // the pool; the bytes never cross the Dawn wire.
    const seq = upload(id, poolId, offset, width, height, stride, sendDamage);
    if (seq === 0) return 0;
    // Remember where this surface's pixels live so a cursor-role surface
    // can be shipped to a KMS cursor plane by pool reference (the GPU
    // process copies out of its own mmap on receipt).
    this.lastShmSource.set(id, { poolId, offset, stride, width, height });
    const sFinal = this.surfaces.get(id);
    if (sFinal) sFinal.present = true;
    this.imported.push({ id, width, height });
    this.bumpContentEpoch(id);
    // Defer the output repaint to the upload ack (takeShmUploadAcks): the GPU
    // process writes the texture asynchronously, so damaging now would render +
    // sample it before it is initialized. Full surface on a texture (re)allocate.
    this.shmUploadDamage.set(seq, { id, damage: needNewTex ? null : (damage ?? null) });
    return seq;
  }

  // Commit a client dmabuf wl_buffer to a surface. Feeds the lifecycle machine
  // a `commit` event; the resulting intents drive the import (if first-sight
  // of this bufferId) or simply re-bind the existing cached import to the
  // surface.
  //
  // Returns false only when this compositor was constructed without a Dawn
  // wire (the headless protocol-only mode used by some tests); true otherwise.
  // The import is strictly async (the lifecycle drives it), so a true return
  // signals "accepted", not "import complete".
  commitSurfaceDmabuf(id: number, fd: WaylandFd, w: number, h: number, fourcc: number,
                      modHi: number, modLo: number, offset: number, stride: number,
                      bufferId: number,
                      acquireFenceFd?: WaylandFd,
                      damage?: ReadonlyArray<{ x: number; y: number; width: number; height: number }> | null): boolean {
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
    // The surface's pixels no longer live in an shm pool.
    this.lastShmSource.delete(id);

    // Ensure the surface exists (the layout sweep may not have created it).
    let surf = this.surfaces.get(id);
    if (!surf) { surf = blankSurface(0, 0, 0, 0); this.surfaces.set(id, surf); }
    // Stash the client damage for this commit; bindImportToSurface consumes it
    // when the async import binds to scope the output repaint. null = full.
    // A prior commit's damage may still be unconsumed (its import hasn't
    // bound yet -- pipelined commits during import latency): UNION with it,
    // don't replace. The bind that eventually consumes this shows the newest
    // buffer, whose delta against what's on screen is the union of every
    // interim commit's region. null (= full) absorbs everything.
    if (surf.pendingContentDamage === undefined) {
      surf.pendingContentDamage = damage ?? null;
    } else if (surf.pendingContentDamage !== null && damage) {
      surf.pendingContentDamage = [...surf.pendingContentDamage, ...damage];
    } else {
      surf.pendingContentDamage = null;
    }

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
    s.contentEpoch++;
    this.imported.push({ id, width: imp.width, height: imp.height });
    // Repaint only the client's damaged region (set at commit time), or the
    // whole surface when no damage was provided.
    const dmg = s.pendingContentDamage;
    s.pendingContentDamage = undefined;
    this.damageSurfaceRegion(id, dmg);
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
    // When an intercept is active for this surface, sample
    // the plugin's output instead of the client texture. Callers that
    // update the client view still call rebuildBindGroup with that
    // view; this chokepoint substitutes the intercept view when
    // present. installInterceptOutput passes the intercept view
    // directly (the substitution here is a no-op for that path).
    // A frozen surface samples its captured snapshot; an intercept samples the
    // plugin output; otherwise the client view.
    const sampledView = s.frozen?.view ?? s.interceptOutputView ?? view;
    const cached = s.bindGroupCache.get(sampledView);
    if (cached) { s.bindGroup = cached; return; }
    const mask = s.maskView ?? this.defaultMaskView;
    const bindGroup = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: sampledView },
        { binding: 2, resource: { buffer: s.uniformBuf } },
        { binding: 3, resource: this.maskSampler },
        { binding: 4, resource: mask },
      ],
    });
    s.bindGroupCache.set(sampledView, bindGroup);
    s.bindGroup = bindGroup;
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
          fourcc: pending.fourcc,
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
    // A destroyed buffer's scanout veto entries are moot; drop them.
    for (const set of this.scanoutVeto.values()) set.delete(bufferId);
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

  // Re-announce an already-imported surface so the next takeImportedSurfaces
  // pass re-runs the map step. Used by the XWM when a window becomes managed
  // AFTER its first buffer already imported (the property-read race): the
  // import was left unconsumed (s.mapped stayed false), so re-delivering it
  // now -- with the window managed -- lets the map complete. No-op when the
  // surface has no committed buffer yet (the eventual first import maps it).
  redeliverImported(id: number): void {
    const s = this.surfaces.get(id);
    if (!s || !s.texture) return;
    this.imported.push({ id, width: s.width, height: s.height });
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
    // World-space surfaces are resident where a CAMERA view overlaps them;
    // glass-anchored surfaces use the plain arrangement rect (same gating
    // as the render pass, so residency matches what actually draws).
    const exempt = this.cameraExempt(surfaceId, s);
    const out: number[] = [];
    for (const o of this.outputsGeom.values()) {
      const scale = o.scale > 0 ? o.scale : 1;
      const cam = exempt ? undefined : this.cameras.get(o.id);
      const camZ = cam ? cam.zoom : 1;
      const ox0 = o.logicalX + (cam ? cam.x : 0);
      const oy0 = o.logicalY + (cam ? cam.y : 0);
      const ox1 = ox0 + o.deviceWidth / (scale * camZ);
      const oy1 = oy0 + o.deviceHeight / (scale * camZ);
      if (sx0 < ox1 && sx1 > ox0 && sy0 < oy1 && sy1 > oy0) out.push(o.id);
    }
    // Mapped but placed off-screen / outside every output's region: fall back
    // to every output so the client doesn't hang. Real off-screen surfaces are
    // rare; correctness > optimal pacing for the degenerate case.
    if (out.length === 0) return [...this.outputsGeom.keys()];
    return out;
  }

  // Which outputs SHOW the surface: geometric overlap (as surfaceOutputs)
  // additionally gated by draw-stack membership per output. Visibility is
  // explicit state (canvas-design.md: hidden means hidden regardless of
  // camera position): a surface absent from an output's content stack is
  // shown nowhere on it even if its world rect falls inside the camera
  // view. Glass-anchored chrome (layer shell, cursor) is in every output's
  // draw order, so it stays purely geometric. No all-outputs fallbacks:
  // this drives wl_surface.enter/leave + preferred scale, where "shown
  // nowhere" is a truthful answer; frame pacing keeps surfaceOutputs so
  // hidden clients still receive wl_callback.done.
  surfaceVisibleOutputs(surfaceId: number): number[] {
    const s = this.surfaces.get(surfaceId);
    if (!s) return [];
    const chrome = this.layerIdSet.has(surfaceId)
      || surfaceId === this.cursorTargetSurfaceId;
    const w = s.layoutW > 0 ? s.layoutW : s.width;
    const h = s.layoutH > 0 ? s.layoutH : s.height;
    if (w <= 0 || h <= 0) return [];
    const sx0 = s.x;
    const sy0 = s.y;
    const sx1 = sx0 + w;
    const sy1 = sy0 + h;
    const exempt = this.cameraExempt(surfaceId, s);
    const out: number[] = [];
    for (const o of this.outputsGeom.values()) {
      if (!chrome && !this.stackMemberOn(o.id, surfaceId)) continue;
      const scale = o.scale > 0 ? o.scale : 1;
      const cam = exempt ? undefined : this.cameras.get(o.id);
      const camZ = cam ? cam.zoom : 1;
      const ox0 = o.logicalX + (cam ? cam.x : 0);
      const oy0 = o.logicalY + (cam ? cam.y : 0);
      const ox1 = ox0 + o.deviceWidth / (scale * camZ);
      const oy1 = oy0 + o.deviceHeight / (scale * camZ);
      if (sx0 < ox1 && sx1 > ox0 && sy0 < oy1 && sy1 > oy0) out.push(o.id);
    }
    return out;
  }

  // True when `id` is in the content draw order for `outputId` (the
  // per-output override, or the global stack while no output has one).
  private stackMemberOn(outputId: number, id: number): boolean {
    const useGlobal = this.outputStacks.size === 0;
    const content = this.outputStacks.get(outputId)
      ?? (useGlobal ? this.stack : EMPTY_STACK);
    return content.includes(id);
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
        // COPY_SRC is required by the Worker intercept's
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
    // A texture recreate (size change) repaints the whole surface; otherwise
    // scope the output repaint to the client's damaged region.
    this.damageSurfaceRegion(id, recreated ? null : damage);
    if (s.frozen) this.frozenReadyCb?.(id);
  }

  // The surface's intrinsic on-screen logical size: the viewport destination
  // if set, else the committed buffer dims divided by buffer_scale (90/270
  // transforms swap axes). This is the authoritative "how big is this surface"
  // answer for surfaces with no WM-assigned layout rect -- a subsurface's
  // layoutW/H is 0 (the "content-sized" sentinel from setSurfaceLayout), so
  // readers must resolve the real size through here rather than trusting
  // layoutW/H.
  private logicalSizeOf(s: Surface): { w: number; h: number } {
    return logicalContentSize(s.width, s.height, s.bufferScale || 1,
      s.bufferTransform ?? 0, s.viewportDst);
  }

  // Public by-id variant for the intercept broker: the plugin tick maps the
  // xdg window geometry (surface-local coordinates) into buffer pixels via
  // clientTextureSize / logicalSize, which needs this as the denominator.
  // Null when the surface is unknown.
  surfaceLogicalSize(surfaceId: number): { w: number; h: number } | null {
    const s = this.surfaces.get(surfaceId);
    return s ? this.logicalSizeOf(s) : null;
  }

  // --- Composite-scissor damage -------------------------------------------

  // Mark every output's tracked slots stale: the next frame on any slot of
  // any output repaints fully. Used for changes that can affect arbitrary
  // screen regions (stack reorders, per-surface fx, output resize).
  private damageFull(): void {
    this.outputDamage.full();
  }

  // Fire the per-output render gate without geometry so the next frame
  // presents (and emits a flip-complete). See CompositorHooks.requestOutputPresent
  // for why screen capture needs this. markDirty leaves each slot's own damage
  // ring untouched, so the presented scanout slot still composites the correct
  // pixels; this only flips the "render this output at all this vblank" bit.
  requestOutputPresent(outputId: number | null): void {
    if (outputId === null) {
      for (const o of this.outputsGeom.values()) this.outputDamage.markDirty(o.id);
    } else {
      this.outputDamage.markDirty(outputId);
    }
  }

  // Accumulate a GLOBAL-logical-space rect into the damage rings of every
  // output it overlaps (the map clips into each output's local space).
  // Rects entirely outside the union are silent no-ops. `anchored` mirrors
  // cameraExempt for the damaged surface: world rects are partitioned
  // against each output's camera view rect, anchored rects against the
  // plain arrangement rect.
  private addOutputDamage(
    x: number, y: number, w: number, h: number, anchored = false,
  ): void {
    this.outputDamage.damageRect(x, y, w, h, anchored);
  }

  // Damage a surface's current on-screen rect (placement). Content commits and
  // buffer scale/transform changes route here. If the surface's fx can draw
  // outside its nominal rect (transform / margin / mask), repaint the whole
  // output instead -- the rect would undercount the affected region.
  // Force a present of `id`'s current (unchanged) content so the next
  // flip-complete delivers its pending frame callback. Its buffer is still
  // resident (released only on supersede), so re-presenting is safe. Used to
  // break the idle deadlock: a client waiting on wl_callback.done that produces
  // no damage of its own would otherwise never get a present -> never a flip ->
  // never `done`. No-op if the surface isn't drawable.
  requestPresentForCallback(id: number): void {
    if (!this.surfaces.has(id)) return;
    this.damageSurface(id);
    // A world surface outside every camera view damages nothing above --
    // but its pending callback rides any flip-complete, so force one
    // output to present (dirty bit only; its ring repaints its usual
    // region). Without this, an off-view client blocking on `done` before
    // its next commit stalls forever on an otherwise idle compositor.
    if (this.surfaceOutputs(id).length === 0) {
      const first = this.outputsGeom.keys().next();
      if (!first.done) this.outputDamage.markDirty(first.value);
    }
  }

  // True when the surface's fx transform/margin or mask can draw pixels OUTSIDE
  // its plain layout rect. Damaging only that rect would then leave stale pixels
  // (in some scanout slot) where the surface drew beyond it, so such a surface
  // must force a whole-output repaint across every ring slot instead.
  private fxDrawsOutsideLayout(s: Surface): boolean {
    const fx = s.fx;
    return fx.translateX !== 0 || fx.translateY !== 0 || fx.scaleX !== 1 || fx.scaleY !== 1
      || fx.marginTop !== 0 || fx.marginRight !== 0 || fx.marginBottom !== 0 || fx.marginLeft !== 0
      || s.maskView !== null;
  }

  private damageSurface(id: number): void {
    const s = this.surfaces.get(id);
    if (!s) return;
    if (this.fxDrawsOutsideLayout(s)) {
      this.damageFull();
      return;
    }
    // layoutW/H is 0 for subsurfaces (the "content-sized" sentinel); resolve
    // the real size so a subsurface content commit damages its actual rect
    // rather than a zero-area one.
    let w = s.layoutW, h = s.layoutH;
    if (w <= 0 || h <= 0) ({ w, h } = this.logicalSizeOf(s));
    this.addOutputDamage(s.x, s.y, w, h, this.cameraExempt(id, s));
  }

  // Damage only the client's changed region for a content commit. `rects` are
  // in BUFFER pixels (the protocol layer's reconciled damage); null/empty means
  // "no damage info" -> repaint the whole surface. The protocol layer returns
  // null whenever a buffer_transform or viewport is active, so here the only
  // buffer->output mapping is the buffer scale (+ the surface's output
  // position). An fx that can draw outside the layout rect forces a full
  // repaint, same as damageSurface.
  private damageSurfaceRegion(
    id: number,
    rects: ReadonlyArray<{ x: number; y: number; width: number; height: number }> | null | undefined,
  ): void {
    if (!rects || rects.length === 0) { this.damageSurface(id); return; }
    const s = this.surfaces.get(id);
    if (!s) return;
    if (this.fxDrawsOutsideLayout(s)) {
      this.damageFull();
      return;
    }
    const bs = s.bufferScale || 1;
    const anchored = this.cameraExempt(id, s);
    for (const r of rects) {
      this.addOutputDamage(s.x + r.x / bs, s.y + r.y / bs,
        r.width / bs, r.height / bs, anchored);
    }
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
    // The fill's placement override is a scissor box in output-rect
    // coordinates; the content camera must not shift it.
    s.outputAnchored = true;
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
    s: Surface, surfaceId: number, ow: number, oh: number,
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
    // World-space surfaces subtract the camera-shifted view origin and
    // scale by the camera zoom; glass-anchored surfaces (layer-shell,
    // cursor, outputAnchored) subtract the plain arrangement origin
    // unscaled. Identity cameras make the two identical.
    const cam = output && !this.cameraExempt(surfaceId, s);
    const camZ = cam ? output.cameraZoom : 1;
    const ox = output ? output.originX + (cam ? output.cameraX : 0) : 0;
    const oy = output ? output.originY + (cam ? output.cameraY : 0) : 0;
    // xdg_surface.set_window_geometry: when set (CSD clients like GTK
    // draw shadow / overflow chrome around their content; the
    // geometry rect declares the sub-region of the surface that is
    // "the window" -- the rest is outside-the-window pixels we
    // discard). Render the geometry rect at the WM position, sampling
    // only that sub-region of the buffer via UV crop. The shadow
    // band stays inside the buffer but is never painted -- it would
    // otherwise overflow onto the decoration ring around the window.
    // An explicit override (intercept / compose placement) bypasses
    // geometry entirely (the override IS the placement).
    const overrideP = overrides?.placement;
    const geom = s.geometry ?? null;
    const px = ((overrideP?.x ?? s.x) - ox) * camZ;
    const py = ((overrideP?.y ?? s.y) - oy) * camZ;
    // When the WM has assigned a layout rect (any decorated window),
    // use it: it's the rect we configured the client to render into
    // AND the rect we hit-test against, so visual extent and input
    // extent stay aligned. When no layout (subsurface, popup) and
    // window-geometry is set (CSD client), fall back to the geometry
    // size. Otherwise the surface's intrinsic logical size.
    // Camera zoom scales the drawn extent along with the position (fx
    // translate/margins stay glass-space: they are output-anchored effects
    // and zoom is a transient optical state).
    const pw = (overrideP?.w
      ?? (s.layoutW || (geom ? geom.width : intrinsicW))) * camZ;
    const ph = (overrideP?.h
      ?? (s.layoutH || (geom ? geom.height : intrinsicH))) * camZ;
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
    // fx: opacity in x; buffer-transform code (0..7) in y; opaque-format flag
    // in z (1 => buffer has no alpha channel, shader forces alpha=1); w reserved.
    // The opaque force applies ONLY when drawing the raw client texture: an
    // intercept output (plugin RGBA, e.g. a decoration ring's transparent
    // corners) or a frozen snapshot carry their own alpha and must keep it.
    data[12] = fx.opacity;
    data[13] = frozenDraw ? 0 : (s.bufferTransform || 0);
    data[14] = (s.opaque && !s.interceptOutputView && !frozenDraw) ? 1 : 0;
    // cropUV: u0, v0, u1, v1 (defaults identity = full surface texture). A
    // wp_viewport source rect (surface coords) crops the sampled buffer;
    // computed from current buffer dims so it survives a buffer resize.
    // When window-geometry is set without an explicit override or
    // viewportSrc, crop to the geometry sub-rect (normalized over the
    // surface's intrinsic logical extent) so the shadow / overflow
    // around the geometry is not sampled.
    let cu = overrides?.cropUV;
    if (!frozenDraw && !cu && s.viewportSrc && s.width > 0 && s.height > 0) {
      const W = s.width, H = s.height;
      cu = {
        u0: (s.viewportSrc.x * bs) / W, v0: (s.viewportSrc.y * bs) / H,
        u1: ((s.viewportSrc.x + s.viewportSrc.width) * bs) / W,
        v1: ((s.viewportSrc.y + s.viewportSrc.height) * bs) / H,
      };
    }
    // Skip the geometry crop when an explicit placement override is in play
    // (intercept output / compose placement): the override's texture is the
    // final content, already geometry-correct -- a decoration intercept sizes
    // its output to the window geometry and samples only that sub-region of the
    // client buffer, so cropping it AGAIN by geometry would double-crop (drop
    // the decoration band and keep only the window interior).
    if (!frozenDraw && !cu && !overrideP && geom && intrinsicW > 0 && intrinsicH > 0) {
      cu = {
        u0: geom.x / intrinsicW,
        v0: geom.y / intrinsicH,
        u1: (geom.x + geom.width) / intrinsicW,
        v1: (geom.y + geom.height) / intrinsicH,
      };
    }
    data[16] = cu?.u0 ?? 0; data[17] = cu?.v0 ?? 0;
    data[18] = cu?.u1 ?? 1; data[19] = cu?.v1 ?? 1;
    // tint: r, g, b, a (defaults identity = (1,1,1,1))
    data[20] = fx.tintR; data[21] = fx.tintG;
    data[22] = fx.tintB; data[23] = fx.tintA;
    // colorMatrix: 4 column vectors of 4 components each (mat4x4f, column-major)
    data.set(fx.colorMatrix, 24);
    // shape: clip the surface to its WINDOW's rounded footprint. A shaped
    // window (or any surface carrying its own shape) clips against its own rect
    // -- identity map, reproducing a plain rounded window. A subsurface of a
    // shaped window inherits that window's shape (via shapeClipMap) and clips
    // against the window footprint, positioned by the surfUV->windowUV map, so
    // the window's rounded corners cut the subsurface at the right place. The
    // SDF evaluates in logical pixels (placement is logical output coords); px/
    // py are already output-local (output origin subtracted), and the window
    // footprint is converted the same way so the two share a frame.
    const clip = this.shapeClipMap.get(surfaceId);
    const clipShape = clip ? clip.shape : fx.shape;
    if (clipShape === null) {
      packShape(data, null, pw, ph, IDENTITY_SHAPE_MAP);
    } else {
      // The clip footprint is world coords while px/py/pw/ph are glass
      // (camera view origin subtracted, zoom-scaled), so the footprint
      // maps through the same camera -- and the radii scale to glass
      // units with it. Without the zoom term a zoomed-out view clips
      // every shaped window against its unscaled world rect.
      const wx = clip ? (clip.x - ox) * camZ : px;
      const wy = clip ? (clip.y - oy) * camZ : py;
      const ww = clip && clip.w > 0 ? clip.w * camZ : pw;
      const wh = clip && clip.h > 0 ? clip.h * camZ : ph;
      const map = (ww > 0 && wh > 0)
        ? { ox: (px - wx) / ww, oy: (py - wy) / wh, sx: pw / ww, sy: ph / wh }
        : IDENTITY_SHAPE_MAP;
      packShape(data, clipShape, ww, wh, map, camZ);
    }
    this.device.queue.writeBuffer(s.uniformBuf, 0, data);
  }

  // Open the import's access bracket, consuming the buffer's pending
  // explicit-sync acquire fence if one is stashed.
  //
  // wp_linux_drm_syncobj_v1: when the most recent commit carried an acquire
  // fence, hand it to the GPU process via writeBeginAccessWithFence -- it
  // waits on THAT sync_file instead of running EXPORT_SYNC_FILE on the
  // dmabuf (the implicit-sync path). Clients on drivers that don't attach
  // implicit fences (NVIDIA proprietary, incl. Xwayland/glamor) are
  // unsynchronized without this wait: sampling races the client's GPU
  // writes and reads stale or never-written (transparent) content.
  //
  // The fence is one-shot per commit: once one Begin waits on it, later
  // samples of the same buffer chain on the GPU process's access-fence
  // sequence; nothing writes the dmabuf again until the client re-commits.
  // EVERY path that samples a client dmabuf must Begin through here so the
  // wait happens on whichever sample runs first after the commit.
  private beginClientAccess(bufferId: number, importId: number): boolean {
    const fenceFd = this.bufferIdToAcquireFenceFd.get(bufferId);
    if (fenceFd && !fenceFd.closed) {
      this.bufferIdToAcquireFenceFd.delete(bufferId);
      return this.addon.writeBeginAccessWithFence(importId, fenceFd);
    }
    return this.addon.writeBeginAccess(importId);
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
  // `tickleLifecycle` (default true) drives the per-buffer lifecycle's
  // frameSampled event. The on-screen renderFrame wraps these calls in a
  // matching frameStart/submitted pair, so the lifecycle's begin/end
  // alternation is intact. Snapshot callers (composeSnapshot via
  // composeScene/composeWindows, capture frames) do NOT run inside a
  // lifecycle frame; the comment above composeSnapshot explicitly says
  // the lifecycle state machine is not driven by snapshots, so they pass
  // false to skip the lifecycle dispatch. The WIRE-level Begin/End is
  // still written (snapshot dmabuf samples still need bracketing on the
  // GPU process side; that's what the dedupe + writeBeginAccess/EndAccess
  // do), but the JS-side lifecycle bookkeeping is bypassed so a snapshot
  // taken outside a renderFrame doesn't trip "frameSampled without
  // frameStart". Without this gate a snapshot pre-existing renderFrame
  // wrote Begin to the wire, then threw inside lifecycle.step before the
  // bracketed[] entry was pushed, leaving a wire bracket open with no End
  // pairing -- which the GPU process detected on the next renderFrame's
  // Begin as "bracket already open" and aborted.
  private openImportBrackets(
    drawList: number[],
    bracketed: Array<{ importId: number; bufferId: number }>,
    tickleLifecycle = true,
  ): void {
    for (const id of drawList) {
      const s = this.surfaces.get(id);
      if (!s || !s.present || !s.bindGroup) continue;
      // A frozen surface samples its snapshot, not the client buffer -- no
      // bracket (and no frameSampled) for its import this frame.
      if (s.frozen) continue;
      // An intercept output is installed for this surface: the bind
      // group samples the intercept's output texture, NOT the client
      // dmabuf. No bracket on the client import for this surface's
      // on-screen draw. The intercept broker has already opened its
      // own bracket around the plugin's render submit (which DID
      // sample the client texture), then closed it.
      if (s.interceptOutputView !== null) continue;
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
      const beginOk = this.beginClientAccess(s.currentBufferId, imp.importId);
      if (!beginOk) {
        throw new Error(
          `writeBeginAccess returned false for live import ` +
          `(bufferId=${s.currentBufferId}, importId=${imp.importId}): ` +
          `dmabufImports gate / core handle map desync`,
        );
      }
      if (tickleLifecycle) {
        this.dispatch(this.lifecycle.step({ kind: "frameSampled", surfaceId: id }));
      }
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
    tickleLifecycle = true,
  ): void {
    for (const { importId, bufferId } of bracketed) {
      this.addon.writeEndAccess(importId);
      if (tickleLifecycle) {
        this.dispatch(this.lifecycle.step({
          kind: "endAccessFenceExported", bufferId,
          fence: { kind: "syncFile", fd: -1 },
        }));
      }
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
      // Device box: floor the origin, ceil the END coordinates. Ceiling the
      // WIDTH instead (floor(x*s) + ceil(w*s)) ends up to a pixel short of
      // ceil((x+w)*s) when the origin's device coordinate is fractional,
      // which leaves a stale 1px column/row at the box's right/bottom edge
      // at fractional scales.
      const sx = Math.min(devW, Math.max(0, Math.floor(lx * scale)));
      const sy = Math.min(devH, Math.max(0, Math.floor(ly * scale)));
      const sx1 = Math.min(devW, Math.max(sx, Math.ceil((lx + args.scissor.w) * scale)));
      const sy1 = Math.min(devH, Math.max(sy, Math.ceil((ly + args.scissor.h) * scale)));
      pass.setScissorRect(sx, sy, sx1 - sx, sy1 - sy);
      // Clear the scissored box to black (loadOp:load preserved old pixels).
      const black = this.ensureBlackFill();
      if (black.bindGroup) {
        // The fill's placement is the device box mapped back to logical, NOT
        // the logical damage box: a quad at the damage box's fractional
        // device edges rasterizes short of the scissor's last column/row,
        // and translucent content then blends over stale pixels there
        // instead of over black. Snapping to the device box makes the fill's
        // coverage exactly the scissor rect.
        // (The black scissor-fill is not a tracked surface -- id -1 never
        // matches shapeClipMap; it clears a rect, unshaped.)
        const originX = out ? out.originX : 0;
        const originY = out ? out.originY : 0;
        this.updateUniforms(black, -1, args.outW, args.outH,
          { placement: { x: sx / scale + originX, y: sy / scale + originY,
                         w: (sx1 - sx) / scale, h: (sy1 - sy) / scale } }, out);
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, black.bindGroup);
        pass.draw(4);
      }
    }
    pass.setPipeline(this.pipeline);
    for (const id of args.drawList) {
      const s = this.surfaces.get(id);
      if (!s || !s.present || !s.bindGroup) continue;
      const placement = args.placements?.get(id)
        ?? s.interceptPlacement ?? undefined;
      const cropUV = args.cropUV?.get(id);
      // Geometric filter: a per-output drawList is the content POLICY
      // (which surfaces are eligible to draw on this output via
      // setOutputStack); the actual visibility filter is geometric
      // overlap. Skip when the surface's rect doesn't overlap the
      // output -- handles the brief window during a cross-output move
      // when the new output's stack already includes the surface but
      // the WM resize-tx hasn't applied the new geometry yet, so the
      // surface would otherwise draw at the OLD position inside the
      // NEW output's pass (straddling the boundary, wrong scale).
      // Compose-path callers (explicit placements or intercept) bypass
      // -- they place the surface explicitly.
      if (out && !placement && !s.interceptPlacement) {
        const sw = s.layoutW > 0 ? s.layoutW : s.width / (s.bufferScale || 1);
        const sh = s.layoutH > 0 ? s.layoutH : s.height / (s.bufferScale || 1);
        if (sw > 0 && sh > 0) {
          const sx0 = s.x, sy0 = s.y;
          const sx1 = sx0 + sw, sy1 = sy0 + sh;
          const oscale = out.scale > 0 ? out.scale : 1;
          // World-space surfaces are visible where the CAMERA view rect is,
          // not the arrangement rect (matches updateUniforms' mapping); a
          // zoomed-out view covers logical/zoom world units.
          const cam = !this.cameraExempt(id, s);
          const camZ = cam ? out.cameraZoom : 1;
          const ox0 = out.originX + (cam ? out.cameraX : 0);
          const oy0 = out.originY + (cam ? out.cameraY : 0);
          const ox1 = ox0 + out.deviceWidth / (oscale * camZ);
          const oy1 = oy0 + out.deviceHeight / (oscale * camZ);
          if (sx1 <= ox0 || sx0 >= ox1 || sy1 <= oy0 || sy0 >= oy1) continue;
        }
      }
      this.updateUniforms(s, id, args.outW, args.outH,
        placement || cropUV ? { placement, cropUV } : undefined, out);
      pass.setBindGroup(0, s.bindGroup);
      pass.draw(4);
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

    // Derive each surface's shape-clip footprint from the current surface tree
    // + placements before any uniforms are written this frame.
    this.refreshShapeClips();

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
      this.flushHwCursorStates(new Set([OUTPUT_DEFAULT]));
    } else {
      if (!this.dawn) return;
      // Any live composer is "every-frame" by contract: its caller produces
      // a fresh sample each tick whether or not anything else changed.
      // While at least one is registered, all outputs are treated as dirty
      // so the on-screen pass keeps running alongside the live producer.
      // Empty in steady state, so the common idle path falls through to the
      // per-output dirty gate below.
      const liveActive = this.liveProducers.length > 0
        || this.liveScenes.length > 0
        || this.liveWindowComps.length > 0;
      const outs = [...this.outputsGeom.values()].sort((a, b) => a.id - b.id);
      for (const o of outs) {
        // Per-output render gate. Skip this output if nothing changed on it
        // since its last present (no damage accumulated, no active
        // transition, no live composer in flight). Without this gate every
        // flip-complete on every output would trigger a full re-render at
        // that panel's refresh rate -- two outputs at 60Hz + 240Hz burn
        // 300 idle composites per second on an empty desk.
        const dirty = liveActive
          || this.outputDamage.isDirty(o.id)
          || this.activeTransitions.has(o.id);
        if (!dirty) continue;
        // Direct scanout: a solitary mode-sized opaque client dmabuf goes
        // straight onto the primary plane -- no acquire, no render, no
        // composite. Damage is consumed (the plane shows the new buffer);
        // frame pacing rides the client flip's completion.
        const wasScanout = this.scanoutActive.has(o.id);
        const cand = this.activeTransitions.has(o.id)
          ? null : this.scanoutCandidate(o, this.drawOrder(o.id));
        if (cand) {
          const fence = this.takeScanoutAcquireFence(cand.bufferId);
          if (this.addon.sendScanoutClientPresent?.(o.id, cand.importId,
                                                    cand.bufferId, fence)) {
            this.dispatch(this.lifecycle.step({
              kind: "scanoutPresented", bufferId: cand.bufferId,
            }));
            this.scanoutActive.set(o.id, cand.bufferId);
            this.outputDamage.clearDirty(o.id);
            continue;
          }
          // The sink refused the present (unknown import); composite.
        }
        if (wasScanout) {
          // Leaving scanout: the ring slots hold stale pre-scanout
          // content, so the returning composite frame repaints fully.
          this.scanoutActive.delete(o.id);
          this.outputDamage.fullOutput(o.id);
        }
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
      // Cursor plane positions flush here, after the render set is known:
      // an output about to present carries the state in that commit; a
      // clean output gets a GPU-process cursor-only commit instead. Must
      // run before the empty-target early-return -- a cursor-only wake IS
      // the empty-target case.
      this.flushHwCursorStates(new Set(targets.map((t) => t.ctx.id)));
      // No output needs rendering this pass (every output's ring was busy,
      // or no output is dirty). The lifecycle/bracket machinery would
      // otherwise open a frame with no draw.
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
      const liveSceneLists = this.liveScenes.map((ls) => ls.getDrawList());
      for (const list of liveSceneLists) this.openImportBrackets(list, bracketed);
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
      for (let i = 0; i < this.liveScenes.length; i++) {
        const ls = this.liveScenes[i];
        const enc = this.device.createCommandEncoder();
        this.composite({
          encoder: enc, targetView: ls.view, drawList: liveSceneLists[i],
          outW: ls.ctx.logicalWidth, outH: ls.ctx.logicalHeight,
          output: ls.ctx,
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

      // Invoke each registered live-producer callback. They
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
      // Clearing the per-output dirty bit happens here, AFTER the present
      // call returns, so an exception thrown between gate-check and present
      // does not silently drop the dirty signal. A subsequent damageRect or
      // markDirty between this clear and the next vblank re-sets the bit
      // and the gate fires again on the next pass.
      for (const t of targets) {
        if (t.present) { this.addon.presentOutput(t.ctx.id); this.presentedOutputs.add(t.ctx.id); }
        this.outputDamage.clearDirty(t.ctx.id);
      }
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
    // Per-output context: surfaces are placed in GLOBAL logical coords, so the
    // composite subtracts this output's logical origin and scales by its scale
    // into the (device-resolution) target. Absent = origin-relative, no scale.
    output?: OutputCtx;
  }): void {
    // tickleLifecycle=false: a snapshot is not on the on-screen lifecycle
    // frame's submit serial chain; driving frameSampled/endAccessFenceExported
    // outside a frameStart/submitted pair would throw and leave the wire
    // brackets unpaired. The WIRE-level Begin/End still fires so the GPU
    // process's per-texture bracket stays balanced.
    const bracketed: Array<{ importId: number; bufferId: number }> = [];
    this.openImportBrackets(args.drawList, bracketed, /*tickleLifecycle*/ false);
    try {
      const enc = this.device.createCommandEncoder();
      this.composite({
        encoder: enc,
        targetView: args.targetView,
        drawList: args.drawList,
        outW: args.outW, outH: args.outH,
        placements: args.placements,
        cropUV: args.cropUV,
        output: args.output,
      });
      this.device.queue.submit([enc.finish()]);
    } finally {
      this.closeImportBrackets(bracketed, /*tickleLifecycle*/ false);
    }
  }

  // Snapshot an output's full on-screen content into a fresh device-resolution
  // texture -- exactly what renderFrame draws for it: the per-output draw list
  // (toplevels + their decorations + subsurfaces + shell layers + phantoms),
  // composed at the output's logical extent and scaled to its device pixels.
  // The cursor is excluded (screen capture omits it by default). For the
  // ext_image_copy_capture output source. Caller owns the returned texture.
  // Returns null if the output is unknown.
  composeOutput(outputId: number): { texture: GPUTexture; outW: number; outH: number } | null {
    const geom = this.outputsGeom.get(outputId);
    if (!geom) return null;
    const out = this.outputCtx(geom);
    const texture = this.allocComposeTexture(out.deviceWidth, out.deviceHeight);
    this.composeSnapshot({
      targetView: texture.createView(),
      drawList: this.drawOrder(outputId, /*includeCursor*/ false),
      outW: out.logicalWidth, outH: out.logicalHeight,
      output: out,
    });
    return { texture, outW: out.deviceWidth, outH: out.deviceHeight };
  }

  // Compose an explicit, already-flattened draw list (toplevel + decoration +
  // subsurfaces, as the caller assembled via computeBaseStack) covering a
  // GLOBAL-logical region into a fresh device-resolution texture. Surfaces draw
  // at their current global layout, offset by the region origin and scaled --
  // the same mapping an on-screen output uses, via a region-local synthetic
  // output context. For single-window screen capture. Caller owns the texture.
  composeRegion(args: {
    drawList: ReadonlyArray<number>;
    region: { x: number; y: number; w: number; h: number };
    scale: number;
  }): { texture: GPUTexture; outW: number; outH: number } {
    const scale = args.scale > 0 ? args.scale : 1;
    const devW = Math.max(1, Math.round(args.region.w * scale));
    const devH = Math.max(1, Math.round(args.region.h * scale));
    const texture = this.allocComposeTexture(devW, devH);
    const synth: OutputCtx = {
      id: -1,
      originX: args.region.x, originY: args.region.y, cameraX: 0, cameraY: 0, cameraZoom: 1, scale,
      deviceWidth: devW, deviceHeight: devH,
      logicalWidth: args.region.w, logicalHeight: args.region.h,
    };
    this.composeSnapshot({
      targetView: texture.createView(),
      drawList: [...args.drawList],
      outW: args.region.w, outH: args.region.h,
      output: synth,
    });
    return { texture, outW: devW, outH: devH };
  }

  // Snapshot the closing window's surfaces into a fresh
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

  // Tear down a phantom. Removes it from the draw order,
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

  // ----- Buffer intercept -----------------------------------------------------
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
    // The intercept output just changed (the broker re-rendered the plugin's
    // pixels). This is the ONLY thing that marks the surface's region damaged
    // for an intercepted window -- the broker only calls install when the
    // plugin actually produced new output (render didn't return false) -- so
    // renderFrame's per-output dirty gate recomposites every scanout slot's
    // copy of this region (the new-then-old flicker was a stale scanout slot).
    // Damage just the placement rect, not the whole output. A surface with an
    // active transform (e.g. the open-slide animation) needs a full repaint
    // because the rect moves under the transform, so fall back to damageFull
    // there.
    if (placement && !this.fxDrawsOutsideLayout(s)) {
      this.addOutputDamage(placement.x, placement.y, placement.w, placement.h,
        this.cameraExempt(surfaceId, s));
    } else {
      this.damageFull();
    }
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

  // Hand the intercept broker the current client texture
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

  private bumpContentEpoch(id: number): void {
    const s = this.surfaces.get(id);
    if (s) s.contentEpoch++;
  }

  // Whether the surface's current buffer is an opaque (X-alpha) format whose
  // alpha byte must be ignored. The intercept broker forwards this to plugin
  // renders so they can force alpha=1 when sampling the client texture --
  // the shader-level force in the compositor's own draw applies only to the
  // raw (non-intercepted) path.
  surfaceIsOpaque(surfaceId: number): boolean {
    return this.surfaces.get(surfaceId)?.opaque ?? false;
  }

  // Monotonic per-surface content version (bumped on each new client commit).
  // The intercept broker compares it across ticks to set ctx.contentChanged.
  surfaceContentEpoch(surfaceId: number): number {
    return this.surfaces.get(surfaceId)?.contentEpoch ?? 0;
  }

  // Whether the surface is in the on-screen draw list this
  // frame. The broker uses this to skip render dispatch for surfaces
  // that aren't being composited (off-screen / hidden by a workspace).
  // Returns the surface's presentable flag; the broker treats "not
  // present" as "no render needed."
  surfaceIsPresentable(surfaceId: number): boolean {
    const s = this.surfaces.get(surfaceId);
    return !!s && s.present;
  }

  // The surface's WM-assigned placement (the outer rect the layout
  // wrote via setSurfaceLayout). The intercept broker threads this
  // into the render context as ctx.surfaceRect so plugins can compute
  // expected post-inset content dimensions (e.g. compare input.w
  // against surfaceRect.w - 2*B for a border plugin's gate-release
  // policy). Returns null if the surface is unknown.
  surfaceWmRect(surfaceId: number):
    { x: number; y: number; w: number; h: number } | null {
    const s = this.surfaces.get(surfaceId);
    if (!s) return null;
    return { x: s.x, y: s.y, w: s.layoutW, h: s.layoutH };
  }

  // In-thread intercept: open a Begin/End bracket on the
  // surface's client dmabuf import around the plugin's render submit.
  // SHM-backed surfaces have no dmabuf import; the bracket is a no-op
  // but fn still runs. The bracket is per-import (one Begin per
  // open); the main renderFrame opens its OWN bracket later in the
  // same frame and that's fine -- Begin/End pairs are sequential,
  // not nested, so two pairs within one frame on the same buffer
  // are allowed.
  //
  // Returns true if fn ran (the bracket either wasn't needed -- SHM
  // -- or opened successfully). Returns false if the bracket open
  // failed; fn does NOT run in that case (the broker treats it as a
  // skipped frame so the plugin doesn't sample an unauthorized
  // texture).
  withClientTextureAccess(surfaceId: number, fn: () => void): boolean {
    const s = this.surfaces.get(surfaceId);
    if (!s) return false;
    if (s.currentBufferId === 0) {
      // SHM-backed (or no buffer): no dmabuf bracket needed.
      fn();
      return true;
    }
    const imp = this.dmabufImports.get(s.currentBufferId);
    if (!imp) {
      // Import not yet resolved (async). Skip this frame; next tick
      // the import will be live.
      return false;
    }
    if (!this.beginClientAccess(s.currentBufferId, imp.importId)) return false;
    try {
      fn();
    } finally {
      this.addon.writeEndAccess(imp.importId);
    }
    return true;
  }

  // ----- Cursor slot ----------------------------------------------------------
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

  // ----- Hardware cursor (KMS cursor plane) -----
  //
  // Outputs the GPU process reports a usable cursor plane for
  // (CursorPlaneStatus) scan the cursor out of that plane instead of the
  // composite pass: the image is shipped once per change
  // (sendCursorImage / sendCursorImageShm), and pointer motion sends a
  // tiny plane-position update (sendCursorState) with NO output damage --
  // an otherwise-idle output repositions the cursor without a single
  // drawcall. Per-output fallback to the software slot covers every case
  // the plane can't: no plane, image too large for the plane FB, a
  // GPU-texture cursor (no CPU bytes to ship), or a runtime commit
  // rejection (the GPU process demotes and reports ok=false).
  private hwCursorEnabled = true;                    // config gate (cursor.hardware)
  private hwCursorCaps = new Map<number, { maxW: number; maxH: number }>();
  private hwCursorActive = new Set<number>();        // plane carries the cursor now
  private hwCursorHotspotDev = new Map<number, { x: number; y: number }>();
  private hwCursorLastSent = new Map<number, { x: number; y: number; visible: boolean }>();
  private hwCursorStateStale = false;                // position/visibility to flush
  // CPU bytes behind the internal cursor surface (theme cursors); null when
  // the internal surface holds a GPU texture we have no bytes for.
  private cursorPixelBytes: { bytes: Uint8Array; width: number; height: number } | null = null;
  // Theme-shape source able to re-resolve the current shape at any device
  // pixel size, so each output gets a native-resolution image (software
  // slot: highest output scale; cursor planes: exact per-output scale).
  // Null when the cursor is a fixed bitmap / texture / client surface.
  private cursorShapeResolver: {
    resolve: (deviceSizePx: number) => {
      width: number; height: number; hotspotX: number; hotspotY: number;
      rgba: Uint8Array;
    } | null;
    logicalSizePx: number;
  } | null = null;
  // Latest shm buffer source per surface, recorded on every shm commit so a
  // client cursor surface's pixels can be referenced by pool without a
  // readback (the GPU process has the pool mapped). Dmabuf commits clear
  // the entry.
  private lastShmSource = new Map<number, {
    poolId: number; offset: number; stride: number; width: number; height: number;
  }>();

  setHwCursorEnabled(on: boolean): void {
    this.hwCursorEnabled = on;
    if (!on) {
      for (const id of [...this.hwCursorActive]) {
        this.deactivateHwCursor(id, { dropCaps: true, sendDisable: true });
      }
      this.hwCursorCaps.clear();
    }
  }

  // CursorPlaneStatus from the GPU process (via main.ts).
  setCursorPlaneStatus(outputId: number, ok: boolean,
                       maxW: number, maxH: number): void {
    if (!this.hwCursorEnabled) return;
    if (ok) {
      this.hwCursorCaps.set(outputId, { maxW, maxH });
      this.refreshHwCursorImage(outputId);
    } else {
      // Plane gone (or demoted GPU-side, which already turned it off).
      this.deactivateHwCursor(outputId, { dropCaps: true, sendDisable: false });
    }
  }

  // Stop using the plane on one output and repaint the software cursor
  // there. `sendDisable` turns the plane off (skip when the GPU process
  // already did); `dropCaps` forgets the plane entirely (status ok=false)
  // vs. keeping it for a retry when the next image install fits.
  private deactivateHwCursor(outputId: number,
                             opts: { dropCaps: boolean; sendDisable: boolean }): void {
    if (this.hwCursorActive.delete(outputId)) {
      if (opts.sendDisable) this.addon.sendCursorState?.(outputId, 0, 0, false, true);
      this.hwCursorLastSent.delete(outputId);
      this.hwCursorHotspotDev.delete(outputId);
      // The composite pass owns the cursor again on this output; repaint
      // its rect (the exclude set no longer contains this output).
      this.damageCursorNow();
    }
    if (opts.dropCaps) this.hwCursorCaps.delete(outputId);
  }

  // Damage the cursor's current rect on software-cursor outputs.
  private damageCursorNow(): void {
    const sid = this.cursorTargetSurfaceId;
    const s = sid !== null ? this.surfaces.get(sid) : undefined;
    if (s) this.damageCursorRect(s.x, s.y, s.layoutW, s.layoutH);
  }

  // Cursor-rect damage that skips hardware-cursor outputs (their plane is
  // repositioned instead of repainted).
  private damageCursorRect(x: number, y: number, w: number, h: number): void {
    this.outputDamage.damageRect(x, y, w, h, /*anchored*/ true, this.hwCursorActive);
  }

  // Ship the current cursor image to `only` (or every) cursor-plane output,
  // activating the plane there; outputs the image can't serve fall back to
  // the software slot. Called on every image install and on plane arrival.
  private refreshHwCursorImage(only?: number): void {
    if (!this.hwCursorEnabled || this.hwCursorCaps.size === 0) return;
    const sendPixels = this.addon.sendCursorImage;
    const sendShm = this.addon.sendCursorImageShm;
    const sid = this.cursorTargetSurfaceId;
    const s = sid !== null ? this.surfaces.get(sid) : undefined;
    for (const [outputId, caps] of this.hwCursorCaps) {
      if (only !== undefined && outputId !== only) continue;
      const o = this.outputsGeom.get(outputId);
      if (!o || !s || sid === null) {
        this.deactivateHwCursor(outputId, { dropCaps: false, sendDisable: true });
        continue;
      }
      let sent = false;
      let hotDev: { x: number; y: number } | null = null;
      const shp = this.cursorShapeResolver;
      if (sid === this.internalCursorSurfaceId && shp && sendPixels) {
        // Theme shape: re-resolve at THIS output's exact device size so
        // the plane shows a native-resolution image (no upscale). The
        // theme may return a different stored size; the GPU-side copy
        // scales it to the requested dst, and the hotspot rides the same
        // ratio so it stays anchored to the same image feature.
        const D = Math.max(1, Math.round(shp.logicalSizePx * o.scale));
        if (D <= caps.maxW) {
          const r = shp.resolve(D);
          if (r) {
            const dstW = D;
            const dstH = Math.max(1, Math.round((D * r.height) / r.width));
            if (dstH <= caps.maxH) {
              sendPixels(outputId, r.rgba, r.width, r.height, dstW, dstH);
              hotDev = {
                x: Math.round((r.hotspotX * dstW) / r.width),
                y: Math.round((r.hotspotY * dstH) / r.height),
              };
              sent = true;
            }
          }
        }
      } else if (sid === this.internalCursorSurfaceId && !shp
                 && this.cursorPixelBytes && sendPixels) {
        // Fixed 1x bitmap (plugin set-image bytes): logical dims scale up
        // to device dims.
        const p = this.cursorPixelBytes;
        const dstW = Math.round(p.width * o.scale);
        const dstH = Math.round(p.height * o.scale);
        if (dstW >= 1 && dstH >= 1 && dstW <= caps.maxW && dstH <= caps.maxH) {
          sendPixels(outputId, p.bytes, p.width, p.height, dstW, dstH);
          hotDev = {
            x: Math.round(this.cursorHotspotX * o.scale),
            y: Math.round(this.cursorHotspotY * o.scale),
          };
          sent = true;
        }
      } else if (sid !== this.internalCursorSurfaceId && sendShm) {
        // Client cursor surface: reference its shm bytes by pool. A dmabuf
        // or texture-backed cursor has no entry -> software fallback.
        const shm = this.lastShmSource.get(sid);
        if (shm) {
          const bs = s.bufferScale || 1;
          const dstW = Math.round((shm.width / bs) * o.scale);
          const dstH = Math.round((shm.height / bs) * o.scale);
          if (dstW >= 1 && dstH >= 1 && dstW <= caps.maxW && dstH <= caps.maxH) {
            sendShm(outputId, shm.poolId, shm.offset, shm.stride,
                    shm.width, shm.height, dstW, dstH);
            hotDev = {
              x: Math.round(this.cursorHotspotX * o.scale),
              y: Math.round(this.cursorHotspotY * o.scale),
            };
            sent = true;
          }
        }
      }
      if (!sent || !hotDev) {
        this.deactivateHwCursor(outputId, { dropCaps: false, sendDisable: true });
        continue;
      }
      // Plane positions are sent already hotspot-adjusted; this is the
      // per-output device-pixel hotspot that adjustment uses.
      this.hwCursorHotspotDev.set(outputId, hotDev);
      if (!this.hwCursorActive.has(outputId)) {
        // Erase the software-drawn cursor from this output's next frame
        // BEFORE marking it hardware (the damage helper skips hw outputs).
        this.damageCursorNow();
        this.hwCursorActive.add(outputId);
      }
      this.hwCursorLastSent.delete(outputId);  // force a position (re)send
      this.hwCursorStateStale = true;
    }
  }

  // Send pending plane positions. Runs once per renderFrame, after the
  // per-output render set is known: an output about to present folds the
  // cursor state into that commit (commitNow=false); an output with no
  // render coming needs the GPU process to issue a cursor-only commit
  // (commitNow=true). Wire FIFO puts these before the frame's presents.
  private flushHwCursorStates(rendering: ReadonlySet<number>): void {
    if (!this.hwCursorStateStale || this.hwCursorActive.size === 0) {
      this.hwCursorStateStale = false;
      return;
    }
    const send = this.addon.sendCursorState;
    if (!send) return;
    const sid = this.cursorTargetSurfaceId;
    const s = sid !== null ? this.surfaces.get(sid) : undefined;
    for (const outputId of this.hwCursorActive) {
      const o = this.outputsGeom.get(outputId);
      if (!o) continue;
      const hot = this.hwCursorHotspotDev.get(outputId) ?? { x: 0, y: 0 };
      const lw = Math.round(o.deviceWidth / o.scale);
      const lh = Math.round(o.deviceHeight / o.scale);
      // Visible on this output iff the cursor rect (logical) overlaps it.
      // Fully-offscreen plane positions are avoided rather than trusted to
      // driver clipping.
      const cx = this.cursorPointerX - this.cursorHotspotX;
      const cy = this.cursorPointerY - this.cursorHotspotY;
      const overlaps = !!s && this.cursorVisible
        && cx < o.logicalX + lw && cx + s.layoutW > o.logicalX
        && cy < o.logicalY + lh && cy + s.layoutH > o.logicalY;
      const x = Math.round((this.cursorPointerX - o.logicalX) * o.scale) - hot.x;
      const y = Math.round((this.cursorPointerY - o.logicalY) * o.scale) - hot.y;
      const last = this.hwCursorLastSent.get(outputId);
      if (last && last.x === x && last.y === y && last.visible === overlaps) continue;
      send(outputId, x, y, overlaps, !rendering.has(outputId));
      this.hwCursorLastSent.set(outputId, { x, y, visible: overlaps });
    }
    this.hwCursorStateStale = false;
  }

  // Test/introspection accessor for the hardware-cursor state.
  hwCursorState(): { enabled: boolean; capOutputs: number[]; activeOutputs: number[] } {
    return {
      enabled: this.hwCursorEnabled,
      capOutputs: [...this.hwCursorCaps.keys()].sort((a, b) => a - b),
      activeOutputs: [...this.hwCursorActive].sort((a, b) => a - b),
    };
  }

  // ----- Direct scanout (KMS primary plane; scanout-design.md) -----
  //
  // Per frame, per output: when the entire visible scene is one solitary
  // mode-sized opaque client dmabuf, the composite pass is skipped and the
  // buffer is presented directly on the primary plane. Eligibility is
  // re-evaluated every renderFrame; any overlay/cursor/transition simply
  // makes the output composite again that frame. OFF until main.ts
  // enables it for the KMS backend -- nested/test compositors must never
  // attempt plane presents.
  private directScanoutEnabled = false;
  private scanoutActive = new Map<number, number>();     // outputId -> bufferId
  private scanoutVeto = new Map<number, Set<number>>();  // GPU-process-refused pairs

  setDirectScanoutEnabled(on: boolean): void {
    this.directScanoutEnabled = on;
    if (!on && this.scanoutActive.size > 0) {
      for (const id of this.scanoutActive.keys()) this.outputDamage.fullOutput(id);
      this.addon.wake();
    }
  }

  // The solitary-fullscreen-dmabuf test. `draw` is the output's draw list
  // for this frame; every overlay (software cursor, popup, subsurface,
  // phantom, layer shell, decoration) is its own entry, so length !== 1
  // covers the whole "something else is visible" family.
  private scanoutCandidate(o: OutputGeom, draw: readonly number[]):
      { bufferId: number; importId: number } | null {
    if (!this.directScanoutEnabled || this.headless) return null;
    if (!this.addon.sendScanoutClientPresent) return null;
    if (draw.length !== 1) return null;
    const id = draw[0];
    if (id === this.internalCursorSurfaceId) return null;
    const s = this.surfaces.get(id);
    if (!s || !s.present || s.frozen) return null;
    const bufferId = s.currentBufferId ?? 0;
    if (!bufferId) return null;
    const imp = this.dmabufImports.get(bufferId);
    if (!imp) return null;  // shm / plugin-texture surface: no dmabuf to scan out
    // Buffer must exactly match the mode; the plane does not scale or
    // blend. Alpha-carrying fourccs would need an opaque-region check.
    if (imp.width !== o.deviceWidth || imp.height !== o.deviceHeight) return null;
    if (!SCANOUT_OPAQUE_FOURCCS.has(imp.fourcc)) return null;
    if (s.bufferTransform !== 0) return null;
    if (s.viewportSrc) return null;
    // Placement must exactly cover the output's logical rect, unwarped:
    // identity camera, no fx transform/margin/mask/shape, full opacity.
    const lw = Math.round(o.deviceWidth / o.scale);
    const lh = Math.round(o.deviceHeight / o.scale);
    if (s.x !== o.logicalX || s.y !== o.logicalY) return null;
    if (Math.round(s.layoutW) !== lw || Math.round(s.layoutH) !== lh) return null;
    if (s.fx.opacity !== 1 || this.fxDrawsOutsideLayout(s)) return null;
    if (s.fx.shape !== null) return null;
    if (this.cameras.has(o.id)) return null;
    if (this.scanoutVeto.get(o.id)?.has(bufferId)) return null;
    return { bufferId, importId: imp.importId };
  }

  // Consume the buffer's stashed explicit-sync acquire fence for a scanout
  // present (the role wire-BeginAccess plays on the composite path).
  private takeScanoutAcquireFence(bufferId: number): WaylandFd | null {
    const f = this.bufferIdToAcquireFenceFd.get(bufferId);
    if (!f) return null;
    this.bufferIdToAcquireFenceFd.delete(bufferId);
    return f.closed ? null : f;
  }

  // ScanoutClientFlip from the GPU process: latch bookkeeping + the
  // retired buffer's release (the display engine no longer reads it).
  handleScanoutClientFlip(outputId: number, latchedBufferId: number,
                          retiredBufferId: number): void {
    if (latchedBufferId !== 0) {
      this.scanoutActive.set(outputId, latchedBufferId);
    } else if (this.scanoutActive.get(outputId) === retiredBufferId) {
      // Only a retire of the LATCHED buffer ends the session; a dropped
      // never-latched present (mailbox supersede) retires its buffer
      // while the plane still shows the previous one.
      this.scanoutActive.delete(outputId);
    }
    if (retiredBufferId !== 0) {
      this.dispatch(this.lifecycle.step({
        kind: "scanoutRetired", bufferId: retiredBufferId,
      }));
    }
  }

  // ScanoutClientReject: the kernel refused the buffer (AddFB2 or atomic
  // TEST). Veto the pair, drop the never-latched hold, and repaint through
  // the composite path.
  handleScanoutClientReject(outputId: number, bufferId: number): void {
    let set = this.scanoutVeto.get(outputId);
    if (!set) { set = new Set(); this.scanoutVeto.set(outputId, set); }
    set.add(bufferId);
    while (set.size > 32) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
    this.scanoutActive.delete(outputId);
    this.dispatch(this.lifecycle.step({ kind: "scanoutRetired", bufferId }));
    this.outputDamage.fullOutput(outputId);
    this.addon.wake();
  }

  // Test/introspection accessor.
  scanoutState(): { enabled: boolean; activeOutputs: number[] } {
    return {
      enabled: this.directScanoutEnabled,
      activeOutputs: [...this.scanoutActive.keys()].sort((a, b) => a - b),
    };
  }

  // Place the cursor target surface at (pointer - hotspot). Called on
  // every position update, and after install.
  private updateCursorLayout(): void {
    if (this.cursorTargetSurfaceId === null) return;
    const s = this.surfaces.get(this.cursorTargetSurfaceId);
    if (!s) return;
    // Hardware-cursor outputs reposition their plane instead of repainting;
    // the flush happens in renderFrame once the render set is known.
    if (this.hwCursorActive.size > 0) this.hwCursorStateStale = true;
    // Damage the cursor's old rect, move it, damage the new rect: a cursor
    // move repaints just the two small regions, not the whole output.
    if (this.cursorVisible) this.damageCursorRect(s.x, s.y, s.layoutW, s.layoutH);
    const x = this.cursorPointerX - this.cursorHotspotX;
    const y = this.cursorPointerY - this.cursorHotspotY;
    s.x = x; s.y = y;
    // A cursor surface is never in the WM layout, so its layoutW/H -- which
    // size the drawn quad AND the move damage rects -- are not set by the
    // layout sweep. Derive them from the surface's own buffer: logical size =
    // buffer pixels / buffer_scale. This covers both the internal cursor image
    // and a wl_pointer.set_cursor client surface (e.g. Xwayland's pointer
    // cursor). Without it a client cursor would draw 1px and damage a 0x0 rect,
    // so it never repaints as the pointer moves.
    const bs = s.bufferScale || 1;
    s.layoutW = s.width / bs;
    s.layoutH = s.height / bs;
    if (this.cursorVisible) this.damageCursorRect(s.x, s.y, s.layoutW, s.layoutH);
  }

  // Shared install: upload BGRA8 bytes to the compositor-owned texture,
  // point the slot at the internal cursor surface, and stamp its
  // bufferScale (image px per logical unit -- fractional is fine, the
  // layout just divides) and the LOGICAL hotspot.
  private installCursorPixels(bytes: Uint8Array,
                              width: number, height: number,
                              hotspotX: number, hotspotY: number,
                              bufferScale: number): void {
    if (width <= 0 || height <= 0 || bytes.length !== width * height * 4) {
      throw new Error(`installCursorPixels: invalid dims/bytes (${width}x${height}, ${bytes.length} bytes)`);
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
    const s = this.surfaces.get(this.internalCursorSurfaceId);
    if (s) s.bufferScale = bufferScale;
    this.cursorTargetSurfaceId = this.internalCursorSurfaceId;
    this.cursorHotspotX = hotspotX;
    this.cursorHotspotY = hotspotY;
    this.cursorPixelBytes = { bytes, width, height };
    this.updateCursorLayout();
  }

  // Install a CPU-side BGRA8 cursor image into the internal cursor surface
  // and point the cursor slot at it. Allocates / reuses a core-device
  // texture; uploads via queue.writeTexture. Dims and hotspot are logical
  // (a 1x image).
  setCursorPixels(bytes: Uint8Array,
                  width: number, height: number,
                  hotspotX: number, hotspotY: number): void {
    this.cursorShapeResolver = null;
    this.installCursorPixels(bytes, width, height, hotspotX, hotspotY, 1);
    this.refreshHwCursorImage();
  }

  // Install a theme shape by RESOLVER rather than fixed bitmap: `resolve`
  // produces the shape at any requested device-pixel size (themes store
  // discrete sizes, so the returned image may differ from the request --
  // consumers scale to fit). The software slot uploads the image resolved
  // for the highest output scale (bufferScale keeps its logical size at
  // logicalSizePx); each cursor-plane output ships its own exact-scale
  // resolve, so the cursor is native-sharp everywhere. Returns false --
  // leaving the current cursor untouched -- when the shape doesn't resolve.
  setCursorShape(resolve: (deviceSizePx: number) => {
                   width: number; height: number;
                   hotspotX: number; hotspotY: number;
                   rgba: Uint8Array;
                 } | null,
                 logicalSizePx: number): boolean {
    const L = Math.max(1, Math.round(logicalSizePx));
    let maxScale = 1;
    for (const o of this.outputsGeom.values()) if (o.scale > maxScale) maxScale = o.scale;
    const r = resolve(Math.max(1, Math.round(L * maxScale)));
    if (!r) return false;
    // One bufferScale for both axes (width-derived; theme images are
    // square in practice) -- the hotspot converts to logical by the same
    // divisor so it stays anchored to the same pixel of the image.
    const bs = r.width / L;
    this.installCursorPixels(r.rgba, r.width, r.height,
      r.hotspotX / bs, r.hotspotY / bs, bs);
    this.cursorShapeResolver = { resolve, logicalSizePx: L };
    this.refreshHwCursorImage();
    return true;
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
    // The internal cursor surface (set up by setCursorPixels at boot
    // from the XCursor theme) is the FALLBACK target whenever no client
    // owns the cursor. Switching the slot to a client cursor surface
    // does NOT free it: pointer leaving that client immediately reverts
    // to the internal surface, and a destroyed internal surface would
    // mean the next revert finds nothing to draw and the cursor
    // disappears. Keeping it alive across slot switches is the right
    // trade -- the owned texture is small (one mouse-sized BGRA image).
    this.cursorTargetSurfaceId = surfaceId;
    this.cursorHotspotX = hotspotX;
    this.cursorHotspotY = hotspotY;
    this.updateCursorLayout();
    this.refreshHwCursorImage();
  }

  // Install an already-on-device GPUTexture as the cursor image. The live
  // path for cursor.set-image and plugin-supplied cursor textures: the
  // cursor-broker's installTexture / handleSetImage route an in-thread
  // plugin's GPUTexture here. setCursorPixels (CPU bytes) and
  // setCursorFromSurface (existing surface) are the other two install paths.
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
    const s = this.surfaces.get(this.internalCursorSurfaceId);
    if (s) s.bufferScale = 1;
    this.cursorTargetSurfaceId = this.internalCursorSurfaceId;
    this.cursorHotspotX = hotspotX;
    this.cursorHotspotY = hotspotY;
    // A device-texture cursor has no CPU bytes to ship to a cursor plane.
    this.cursorPixelBytes = null;
    this.cursorShapeResolver = null;
    this.updateCursorLayout();
    this.refreshHwCursorImage();
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
    if (this.hwCursorActive.size > 0) this.hwCursorStateStale = true;
    // Repaint the cursor's rect so it appears / is erased.
    if (this.cursorTargetSurfaceId !== null) {
      const s = this.surfaces.get(this.cursorTargetSurfaceId);
      if (s) this.damageCursorRect(s.x, s.y, s.layoutW, s.layoutH);
    }
  }

  // Tear down the cursor entirely. Called on compositor shutdown; tests use
  // this between cases.
  clearCursor(): void {
    for (const id of [...this.hwCursorActive]) {
      this.deactivateHwCursor(id, { dropCaps: false, sendDisable: true });
    }
    this.cursorPixelBytes = null;
    this.cursorShapeResolver = null;
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
  // producer Begin/End wrapping for cross-device dmabuf targets (Worker
  // compose). Used when the target texture is a wire-wrapped dmabuf
  // that the core produces and a Worker plugin consumes; the producer bracket
  // is required for the GPU process to chain the cross-device fence to the
  // plugin's subsequent consumer Begin.
  composeIntoView(args: {
    outputId: number;
    targetView: GPUTextureView;
    // Already-flattened draw list (decoration + toplevel + subsurfaces); the
    // caller expands the window set, since the subsurface tree lives outside
    // the compositor.
    drawList: ReadonlyArray<number>;
    outW: number;
    outH: number;
    // Global-logical region the target texture represents. When set, surfaces
    // draw at their global layout shifted by the region origin and scaled to
    // the target's device size (outW x outH) -- the same device-resolution
    // mapping composeRegion uses. Omit for an origin-anchored logical pass.
    region?: { x: number; y: number; w: number; h: number };
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
    const r = args.region;
    if (r) {
      const synth: OutputCtx = {
        id: -1,
        originX: r.x, originY: r.y, cameraX: 0, cameraY: 0, cameraZoom: 1, scale: args.outW / r.w,
        deviceWidth: args.outW, deviceHeight: args.outH,
        logicalWidth: r.w, logicalHeight: r.h,
      };
      this.composeSnapshot({
        targetView: args.targetView, drawList: [...args.drawList],
        outW: r.w, outH: r.h, output: synth,
      });
    } else {
      this.composeSnapshot({
        targetView: args.targetView, drawList: [...args.drawList],
        outW: args.outW, outH: args.outH,
      });
    }
    if (args.producerSurfaceBufId !== undefined) {
      this.addon.writeProducerEnd(args.producerSurfaceBufId);
    }
  }

  // Worker intercept: copy a client surface's currently-
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
    const clientTex = s.texture;
    // The client texture's import bracket must be open during the copy (its
    // dmabuf has a SharedTextureMemory access bracket the GPU process needs
    // to know about), and the bracket must consume any pending explicit-sync
    // acquire fence -- this copy is the FIRST sample of the client's commit
    // for an intercepted surface (the on-screen draw samples the intercept
    // output, never the client dmabuf, so no other path waits on the fence).
    // withClientTextureAccess does both. openImportBrackets would do
    // neither: its intercept-output gate skips this surface entirely,
    // leaving the copy unbracketed and unsynchronized against the client's
    // GPU writes.
    return this.withClientTextureAccess(args.surfaceId, () => {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToTexture(
        { texture: clientTex, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { texture: args.dstTex, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        { width: s.width, height: s.height, depthOrArrayLayers: 1 },
      );
      this.device.queue.submit([enc.finish()]);
    });
  }

  // Register a per-frame produce callback. The compositor
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
  //
  // Marks the output dirty: the broker's commit may not include a
  // setOutputStack (which would have damaged-full), in which case
  // nothing else has signaled the per-output render gate that the
  // post-transition state needs to be drawn. Without this, the gate
  // would skip the next frame and the screen would freeze on the last
  // mid-transition image.
  clearActiveTransition(outputId: number): void {
    this.activeTransitions.delete(outputId);
    this.outputDamage.markDirty(outputId);
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

  // Register a live compose-scene target. The texture is re-rendered on
  // every on-screen renderFrame() under the same import brackets, so its
  // contents always reflect what the windows would currently look like on
  // screen. getDrawList is re-evaluated each frame -- subsurfaces committed
  // after registration are picked up. region/scale give the global-logical
  // rect + scale to compose at device resolution (default: the full primary
  // output at its scale). Holder polls the returned texture between frames;
  // release() removes the registration and destroys the texture.
  registerLiveScene(args: {
    outputId: number;
    getDrawList: () => number[];
    region?: { x: number; y: number; w: number; h: number };
    scale?: number;
  }): LiveSceneHandle {
    const region = args.region
      ?? { x: 0, y: 0, w: this.logicalWidth, h: this.logicalHeight };
    const scale = (args.scale ?? this.scale) > 0 ? (args.scale ?? this.scale) : 1;
    const devW = Math.max(1, Math.round(region.w * scale));
    const devH = Math.max(1, Math.round(region.h * scale));
    const texture = this.allocComposeTexture(devW, devH);
    const ctx: OutputCtx = {
      id: -1,
      originX: region.x, originY: region.y, cameraX: 0, cameraY: 0, cameraZoom: 1, scale,
      deviceWidth: devW, deviceHeight: devH,
      logicalWidth: region.w, logicalHeight: region.h,
    };
    const entry: LiveScene = {
      texture, view: texture.createView(),
      outputId: args.outputId, getDrawList: args.getDrawList, ctx,
    };
    this.liveScenes.push(entry);
    let released = false;
    return {
      texture, outW: devW, outH: devH,
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
    bindGroupCache: new WeakMap(),
    width: 0, height: 0, bufferScale: 1, bufferTransform: 0, opaque: false, x, y, layoutW: w, layoutH: h, present: false,
    outputAnchored: false,
    currentBufferId: 0,
    contentEpoch: 0,
    fx: defaultFx(),
    maskView: null,
    interceptOutputView: null,
    interceptPlacement: null,
  };
}
