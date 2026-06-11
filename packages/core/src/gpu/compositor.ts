// JS compositor: the per-output compositing pass, in core main-thread JS, over
// the Dawn wire (via a wire-retargeted dawn.node GPUDevice). architecture.md
// calls this "the core's per-output frame loop / compositing renderer."
//
// shm surfaces upload via queue.writeTexture from a zero-copy ArrayBuffer over
// the client shm mapping (addon.shmView); dmabuf surfaces import via the GPU
// process and arrive as wire texture handles wrapped on this device.
//
// Two render targets: an owned offscreen target (read back via readback())
// and the host swapchain's current texture (acquired + presented per frame).
// Constructor picks via JsCompositorOpts.nested.
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
  let sampleUV = mix(u.cropUV.xy, u.cropUV.zw, in.surfUV);
  var surf = textureSampleLevel(tex, samp, sampleUV, 0.0);
  let inside = step(0.0, in.surfUV.x) * step(in.surfUV.x, 1.0)
             * step(0.0, in.surfUV.y) * step(in.surfUV.y, 1.0);

  // Color transform on the sampled premultiplied rgba: matrix first, then
  // per-channel tint. Identity matrix + tint = (1,1,1,1) leaves surf
  // unchanged (the default).
  surf = u.colorMatrix * surf;
  surf = surf * u.tint;

  // Premultiplied: rgb and alpha both multiplied by inside * mAlpha * opacity.
  // Matches the pipeline's premultiplied blend.
  let k = inside * mAlpha * u.fx.x;
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
import type { TransitionKind } from "@overdraw/transition-types";
import type { WaylandFd } from "../types.js";

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
  writeEndAccess(importId: number): void;
  // Phase 5b: in-band producer Begin/End on the core wire for compose buffers
  // (AllocComposeBuf). The core IS the producer for compose buffers, so
  // producer Begin/End ride the core wire (inverted from sdk.gpu overlays
  // where they ride the plugin wire). Used by composeIntoView when its
  // target is a wire-wrapped dmabuf with a producerSurfaceBufId.
  writeProducerBegin(surfaceBufId: number): void;
  writeProducerEnd(surfaceBufId: number): void;
  // Nested present (slice 3): acquire the host swapchain's current texture handle
  // (null if none this frame) and present it after rendering.
  acquireOutputTexture(): bigint | null;
  presentOutput(): void;
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
  width: number;
  height: number;
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
}

// 6 vec4s (placement, transform, margin, fx, cropUV, tint) + 1 mat4x4f
// (colorMatrix, packed as 4 vec4 columns) = 10 vec4s = 40 floats = 160 bytes.
const UNIFORM_BYTES = 160;
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
  };
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
// running. setActiveTransition installs; clearActiveTransition (or the
// install-er calling clear themselves on completion) tears down. The
// compositor itself does not manage transition timing -- it reads
// progress from getProgress each frame and the broker / evaluator
// decide when to clear.
//
// resolveTextures is optional: when set, it's called each frame to
// re-pick which textures to sample (the Worker-live case, where the
// presented slot rotates). When unset, the install-time fromTex/toTex
// are used every frame (the stable case: in-thread snapshot/live,
// Worker snapshot).
interface ActiveTransition {
  fromTex: GPUTexture;
  toTex: GPUTexture;
  kind: TransitionKind;
  getProgress: () => number;
  resolveTextures?: () => {
    fromTex: GPUTexture;
    toTex: GPUTexture;
    beginRead?: () => void;
    endRead?: () => void;
  } | null;
  // Per-frame bind group cache. Invalidated when textures change
  // (resolveTextures returns different handles). Keyed on (fromTex,
  // toTex) identity.
  cachedFromTex: GPUTexture | null;
  cachedToTex: GPUTexture | null;
  cachedBindGroup: GPUBindGroup | null;
  // Per-frame endRead closure captured by encodeTransitionPass; the
  // renderFrame caller runs it after submit so the wire End fires
  // FIFO-after the sample commands. null when the resolver this frame
  // didn't request brackets.
  pendingEndRead: (() => void) | null;
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
  // Present to the host swapchain (slice 3) instead of an offscreen target.
  // Requires dawn + deviceHandle (for wrapTexture) and the addon acquire/present.
  nested?: boolean;
  // The render-target color format (must match the swapchain when nested).
  format?: GPUTextureFormat;
}

export class JsCompositor implements CompositorSink {
  private device: GPUDevice;
  private g: DawnGlobals;
  private addon: CompositorAddon;
  private width: number;
  private height: number;
  // Surfaces that gained presentable content since the last takeImportedSurfaces.
  private imported: Array<{ id: number; width: number; height: number }> = [];
  private warnedDmabuf = false;

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

  // Phase 8: active transition (core-plugin-api.md §8). When non-null,
  // renderFrame replaces the on-screen surface-list composite with a
  // single transition pass blending two textures via a kind-specific
  // shader. Live composers (above) + live producers continue to run --
  // their content keeps tracking, so a transition over live scenes
  // sees in-flight client buffer commits. Only one transition per
  // compositor at a time (single output today; multi-output is a
  // future per-output map).
  private transitionPipeline: GPURenderPipeline | null = null;
  private transitionLayout: GPUBindGroupLayout | null = null;
  private transitionUniformBuf: GPUBuffer | null = null;
  private activeTransition: ActiveTransition | null = null;

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

  // Nested present (slice 3): render into the host swapchain + present, instead
  // of an offscreen target.
  private nested: boolean;
  private format: GPUTextureFormat;
  private outputTex: GPUTexture | null = null;  // wrapped swapchain texture, held during a frame

  constructor(device: GPUDevice, globals: DawnGlobals, addon: CompositorAddon,
              output: { width: number; height: number },
              dawn: DawnWire | null = null, deviceHandle: bigint = 0n,
              opts: JsCompositorOpts = {}) {
    this.device = device;
    this.g = globals;
    this.addon = addon;
    this.width = output.width;
    this.height = output.height;
    this.dawn = dawn;
    this.deviceHandle = deviceHandle;
    this.nested = opts.nested ?? false;
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

    // Headless: an owned offscreen target (read back via readback()). Nested: the
    // target is the swapchain's current texture, acquired per frame.
    if (!this.nested) {
      this.target = device.createTexture({
        size: { width: this.width, height: this.height },
        format: this.format,
        usage: this.g.GPUTextureUsage.RENDER_ATTACHMENT | this.g.GPUTextureUsage.COPY_SRC,
      });
      this.targetView = this.target.createView();
    }
  }

  // --- CompositorSink ---

  setStack(ids: number[]): void { this.stack = ids.slice(); }

  setOutputStack(outputId: number, ids: number[] | null): void {
    if (ids === null) this.outputStacks.delete(outputId);
    else this.outputStacks.set(outputId, ids.slice());
  }

  setLayerSurfaces(layer: Layer, ids: number[]): void {
    if (layer === "content") { this.stack = ids.slice(); return; }
    this.layers.set(layer, ids.slice());
  }

  // The full back-to-front draw order: each layer in LAYER_ORDER, with the
  // content layer taken from either the per-output override (when set) or the
  // global `this.stack`. Single-output today: the per-output query is keyed
  // on OUTPUT_DEFAULT. Future multi-output: drawOrder takes outputId arg.
  private drawOrder(): number[] {
    const out: number[] = [];
    const content = this.outputStacks.get(OUTPUT_DEFAULT) ?? this.stack;
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
    if (s) { s.x = x; s.y = y; s.layoutW = w; s.layoutH = h; }
    else this.surfaces.set(id, blankSurface(x, y, w, h));
  }

  // Per-surface render-state setters (core-plugin-api.md §1). Cheap: they
  // mutate the per-surface SurfaceFx; the values flow into the WGSL Uniforms
  // each frame via updateUniforms. Auto-create the Surface so callers don't
  // race the protocol layer's setSurfaceLayout.
  setSurfaceOpacity(id: number, opacity: number): void {
    this.ensureSurface(id).fx.opacity = clamp(opacity, 0, 1);
  }

  setSurfaceTransform(id: number, t: SurfaceTransform): void {
    const fx = this.ensureSurface(id).fx;
    fx.translateX = t.translateX ?? 0;
    fx.translateY = t.translateY ?? 0;
    fx.scaleX = t.scaleX ?? 1;
    fx.scaleY = t.scaleY ?? 1;
  }

  setSurfaceOutputMargin(id: number, m: SurfaceMargin): void {
    const fx = this.ensureSurface(id).fx;
    fx.marginTop = m.top ?? 0;
    fx.marginRight = m.right ?? 0;
    fx.marginBottom = m.bottom ?? 0;
    fx.marginLeft = m.left ?? 0;
  }

  setSurfaceTint(id: number, t: SurfaceTint): void {
    const fx = this.ensureSurface(id).fx;
    fx.tintR = t.r ?? 1;
    fx.tintG = t.g ?? 1;
    fx.tintB = t.b ?? 1;
    fx.tintA = t.a ?? 1;
  }

  // Install a 4x4 color matrix applied to the sampled rgba each frame. The
  // caller passes 16 numbers in column-major order (WGSL mat4x4f layout).
  // null restores the identity matrix.
  setSurfaceColorMatrix(id: number, m: ColorMatrix | null): void {
    const fx = this.ensureSurface(id).fx;
    if (m === null) {
      fx.colorMatrix = identityColorMatrix();
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
    }
    this.surfaces.delete(id);
  }

  // Upload a committed shm buffer into the surface's sampled texture (zero-copy
  // from the client mapping via addon.shmView), and report it as presentable.
  commitSurfaceBuffer(id: number, poolId: number, offset: number,
                      width: number, height: number, stride: number): boolean {
    const ab = this.addon.shmView(poolId, offset, stride * height);
    if (!ab) return false;
    this.uploadPixels(id, { width, height, stride }, ab);
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
                      bufferId: number): boolean {
    if (!this.dawn || this.deviceHandle === 0n) {
      if (!this.warnedDmabuf) {
        console.warn("[js-compositor] dmabuf needs dawn.wrapTexture + deviceHandle");
        this.warnedDmabuf = true;
      }
      return false;
    }

    // Ensure the surface exists (the layout sweep may not have created it).
    if (!this.surfaces.has(id)) this.surfaces.set(id, blankSurface(0, 0, 0, 0));

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
    this.rebuildBindGroup(s, imp.view);
    s.present = true;
    this.imported.push({ id, width: imp.width, height: imp.height });
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
    const mask = s.maskView ?? this.defaultMaskView;
    s.bindGroup = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: view },
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
      case "sendWlRelease": this.freed.push(intent.bufferId); break;
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
      console.warn(`[js-compositor] importBuffer(${bufferId}) without pending descriptor (executor/state-machine drift)`);
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
  }

  takeImportedSurfaces(): Array<{ id: number; width: number; height: number }> {
    const out = this.imported;
    this.imported = [];
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
        try { e.cb(); } catch (err) { console.warn("[js-compositor] afterCurrentFrame cb threw", err); }
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
               data: ArrayBuffer | ArrayBufferView): void {
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }

    let tex = s.texture;
    if (!tex || s.width !== c.width || s.height !== c.height) {
      if (tex) tex.destroy();
      // Sampled client textures are always BGRA8 (shm ARGB8888 byte-for-byte;
      // dmabuf imported as BGRA8Unorm), independent of the output format.
      tex = this.device.createTexture({
        size: { width: c.width, height: c.height },
        format: "bgra8unorm",
        usage: this.g.GPUTextureUsage.TEXTURE_BINDING | this.g.GPUTextureUsage.COPY_DST,
      });
      s.texture = tex;
      const view = tex.createView();
      s.view = view;
      s.width = c.width;
      s.height = c.height;
      this.rebuildBindGroup(s, view);
    }

    // `data` begins at the buffer's first pixel row, so dataLayout offset is 0.
    this.device.queue.writeTexture(
      { texture: tex },
      data,
      { offset: 0, bytesPerRow: c.stride, rowsPerImage: c.height },
      { width: c.width, height: c.height },
    );
    s.present = true;
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
  ): void {
    if (!s.uniformBuf) return;
    const px = overrides?.placement?.x ?? s.x;
    const py = overrides?.placement?.y ?? s.y;
    const pw = overrides?.placement?.w ?? (s.layoutW || s.width);
    const ph = overrides?.placement?.h ?? (s.layoutH || s.height);
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
    // fx: opacity in x; rest reserved
    data[12] = fx.opacity;
    // cropUV: u0, v0, u1, v1 (defaults identity = full surface texture)
    const cu = overrides?.cropUV;
    data[16] = cu?.u0 ?? 0; data[17] = cu?.v0 ?? 0;
    data[18] = cu?.u1 ?? 1; data[19] = cu?.v1 ?? 1;
    // tint: r, g, b, a (defaults identity = (1,1,1,1))
    data[20] = fx.tintR; data[21] = fx.tintG;
    data[22] = fx.tintB; data[23] = fx.tintA;
    // colorMatrix: 4 column vectors of 4 components each (mat4x4f, column-major)
    data.set(fx.colorMatrix, 24);
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
      if (!this.addon.writeBeginAccess(imp.importId)) {
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
  }): void {
    const pass = args.encoder.beginRenderPass({
      colorAttachments: [{
        view: args.targetView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    for (const id of args.drawList) {
      const s = this.surfaces.get(id);
      if (s && s.present && s.bindGroup) {
        const placement = args.placements?.get(id);
        const cropUV = args.cropUV?.get(id);
        this.updateUniforms(s, args.outW, args.outH,
          placement || cropUV ? { placement, cropUV } : undefined);
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
    let targetView = this.targetView;
    let presenting = false;
    let frameOpen = false;
    if (this.nested) {
      const handle = this.addon.acquireOutputTexture();
      if (handle === null) return;  // no swapchain texture this frame; no frame opened
      if (!this.dawn) return;
      this.outputTex = this.dawn.wrapTexture(this.deviceHandle, handle);
      targetView = this.outputTex.createView();
      presenting = true;
    }
    if (!targetView) return;  // headless before the target exists (shouldn't happen)

    this.dispatch(this.lifecycle.step({ kind: "frameStart" }));
    frameOpen = true;

    const draw = this.drawOrder();
    const bracketed: Array<{ importId: number; bufferId: number }> = [];

    try {
      // Brackets must cover the UNION of imports sampled this frame --
      // on-screen draw order plus every live composer's window list.
      // openImportBrackets de-dupes on importId so any import shared
      // across these lists opens exactly one Begin (the GPU process
      // forbids two Begins without an End).
      //
      // Bracket opening lives INSIDE the try so a throw from writeBeginAccess
      // (the JS-gate vs core-handle desync at openImportBrackets) or from the
      // lifecycle's frameSampled dispatch (alternation violation) drops into
      // the catch below. Without that, the lifecycle's frameStart was
      // dispatched but never paired with frameAborted, and every subsequent
      // renderFrame throws "frame already in flight" forever.
      // When a transition is active the on-screen pass does NOT sample
      // any client surfaces (it samples the two compose-output textures
      // the transition was installed with). Skip the on-screen draw's
      // bracket open + frameSampled dispatch. The live composers still
      // sample real surfaces, so their bracket opens stay.
      if (!this.activeTransition) {
        this.openImportBrackets(draw, bracketed);
      }
      for (const ls of this.liveScenes) this.openImportBrackets(ls.windows, bracketed);
      for (const lw of this.liveWindowComps) {
        this.openImportBrackets(lw.windows.map((w) => w.id), bracketed);
      }

      const enc = this.device.createCommandEncoder();
      // On-screen pass: either a transition pass (Phase 8) or the
      // normal per-surface composite. The two are mutually exclusive
      // -- a transition replaces the on-screen output entirely while
      // active; the input textures it samples are not part of any
      // surface in the WM's draw list.
      if (this.activeTransition) {
        this.encodeTransitionPass(enc, targetView);
      } else {
        this.composite({
          encoder: enc, targetView, drawList: draw,
          outW: this.width, outH: this.height,
        });
      }
      // Live composers, in registration order. Each pass writes to its
      // own target texture; they don't blend against each other.
      for (const ls of this.liveScenes) {
        this.composite({
          encoder: enc, targetView: ls.view, drawList: ls.windows,
          outW: ls.outW, outH: ls.outH,
        });
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
          this.composite({
            encoder: enc, targetView: w.view, drawList: [w.id],
            outW: w.rect.w, outH: w.rect.h,
            placements, cropUV,
          });
        }
      }
      this.device.queue.submit([enc.finish()]);

      // Tag the submit; on GPU completion advance completedSerial and emit
      // gpuCompleted to the lifecycle (which fires deferred release intents).
      const serial = ++this.submitSerial;
      this.dispatch(this.lifecycle.step({ kind: "submitted", serial }));
      frameOpen = false;

      // Phase 8: close the per-frame transition read bracket on the
      // wire AFTER the submit. encodeTransitionPass stashed endRead in
      // pendingEndRead (only when this frame's transition resolver
      // returned bracket hooks -- Worker-live). One-shot per frame.
      if (this.activeTransition?.pendingEndRead) {
        const endRead = this.activeTransition.pendingEndRead;
        this.activeTransition.pendingEndRead = null;
        try { endRead(); }
        catch (e) { console.error("[js-compositor] transition endRead threw:", e); }
      }

      this.closeImportBrackets(bracketed);

      this.device.queue.onSubmittedWorkDone().then(() => {
        if (serial > this.completedSerial) this.completedSerial = serial;
        this.dispatch(this.lifecycle.step({ kind: "gpuCompleted", serial }));
        this.runAfterFrame();
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
        catch (e) { console.warn("[js-compositor] liveProducer threw:", e); }
      }

      if (presenting) {
        this.addon.presentOutput();
        this.outputTex = null;
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
      // Phase 8: same alternation invariant for the transition's
      // per-frame Begin/End. encodeTransitionPass sets pendingEndRead
      // before calling beginRead, so if either threw the End needs to
      // run here to close the bracket the Begin opened.
      if (this.activeTransition?.pendingEndRead) {
        const endRead = this.activeTransition.pendingEndRead;
        this.activeTransition.pendingEndRead = null;
        try { endRead(); }
        catch { /* secondary throw -- intentionally swallowed */ }
      }
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
    const outW = args.outW ?? this.width;
    const outH = args.outH ?? this.height;
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
    this.cursorVisible = visible;
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

  // Phase 8: install a transition (core-plugin-api.md §8). While set,
  // renderFrame replaces the on-screen surface-list composite with a
  // transition pass blending fromTex/toTex via the kind-specific
  // shader. getProgress is called once per frame to read the eased
  // progress in [0, 1]; the broker / evaluator owns that state.
  //
  // resolveTextures is for the Worker-live case: when the producer's
  // ring rotates between frames the textures change identity; passing
  // a resolver lets the compositor re-pick per frame and rebuild the
  // bind group only when identity changes. Omit for stable cases
  // (snapshot scenes, in-thread live scenes, where the texture handle
  // is stable across frames).
  //
  // Throws if a transition is already active -- the broker pre-rejects
  // concurrent installs, this is defense in depth.
  setActiveTransition(opts: {
    fromTex: GPUTexture;
    toTex: GPUTexture;
    kind: TransitionKind;
    getProgress: () => number;
    // Optional per-frame resolver. When set, called inside each
    // renderFrame to re-pick this frame's textures + optional bracket
    // hooks. The hooks (beginRead/endRead) ride the core wire FIFO-
    // ordered against the transition pass: beginRead writes a
    // producer Begin BEFORE the encode (so the GPU process opens the
    // STM access before HandleCommands reaches the sample); endRead
    // writes End AFTER the submit (so the access stays open through
    // the sample's wire commands). Used by Worker-live scenes whose
    // ring slot's STM-backed wgpu::Texture needs an active access on
    // the core side.
    resolveTextures?: () => {
      fromTex: GPUTexture;
      toTex: GPUTexture;
      beginRead?: () => void;
      endRead?: () => void;
    } | null;
  }): void {
    if (this.activeTransition !== null) {
      throw new Error("setActiveTransition: a transition is already active");
    }
    if (this.transitionPipeline === null || this.transitionLayout === null) {
      throw new Error("setActiveTransition: pipeline not initialized");
    }
    this.activeTransition = {
      fromTex: opts.fromTex,
      toTex: opts.toTex,
      kind: opts.kind,
      getProgress: opts.getProgress,
      resolveTextures: opts.resolveTextures,
      cachedFromTex: null,
      cachedToTex: null,
      cachedBindGroup: null,
      pendingEndRead: null,
    };
  }

  // Tear down the active transition. The broker calls this from inside
  // the evaluator's commit callback so the very next frame draws the
  // post-transition state through the normal composite path. Idempotent.
  clearActiveTransition(): void {
    this.activeTransition = null;
  }

  // For tests: true while a transition is installed.
  hasActiveTransition(): boolean { return this.activeTransition !== null; }

  // Encode the transition pass into targetView. Called from renderFrame
  // when activeTransition is non-null. The caller has already opened
  // any import brackets it needs (none for transitions today -- the
  // input textures are not client dmabufs, they're compose-output
  // textures or live-scene targets whose lifetimes the broker pins
  // for the transition's duration).
  private encodeTransitionPass(
    encoder: GPUCommandEncoder, targetView: GPUTextureView,
  ): void {
    const t = this.activeTransition;
    if (!t || !this.transitionPipeline || !this.transitionLayout
        || !this.transitionUniformBuf) return;

    // Re-pick textures if a resolver is installed; rebuild the bind
    // group on identity change. For the stable case the cached bind
    // group is reused every frame. For ring-backed scenes the
    // resolver also returns optional per-frame beginRead/endRead
    // wire-bracket closures: beginRead fires here (BEFORE the pass
    // is encoded, so the wire Begin is FIFO-ordered before the
    // sample's Dawn commands); endRead is stashed in pendingEndRead
    // and run by renderFrame after the submit (FIFO-after the sample).
    // Defensive: clear any stale endRead from a prior frame -- the
    // resolver may transition from bracketed (Worker-live) to stable
    // (the producer ring tore down mid-transition) or vice versa.
    t.pendingEndRead = null;
    let fromTex = t.fromTex;
    let toTex = t.toTex;
    if (t.resolveTextures) {
      const r = t.resolveTextures();
      if (r === null) {
        // No texture available this frame (e.g. ring has nothing
        // PRESENTED yet). Skip the transition pass; clear the target
        // to opaque black so the on-screen output isn't undefined.
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: targetView,
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          }],
        });
        pass.end();
        return;
      }
      fromTex = r.fromTex;
      toTex = r.toTex;
      // Open the wire bracket on the core side BEFORE encoding the
      // sample. Stash endRead FIRST so a throw between Begin and the
      // pass encode still leaves the cleanup reachable to the catch
      // path in renderFrame (which fires pendingEndRead before
      // rethrowing).
      t.pendingEndRead = r.endRead ?? null;
      if (r.beginRead) r.beginRead();
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
    // TUniforms padding).
    const u = new ArrayBuffer(16);
    new Uint32Array(u, 0, 1)[0] = TRANSITION_KIND_CODE[t.kind];
    new Float32Array(u, 4, 1)[0] = t.getProgress();
    this.device.queue.writeBuffer(this.transitionUniformBuf, 0, u);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.transitionPipeline);
    pass.setBindGroup(0, t.cachedBindGroup);
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
    const outW = args.outW ?? this.width;
    const outH = args.outH ?? this.height;
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
    if (this.nested || !this.target) {
      throw new Error("readback() is headless-only (nested presents to the swapchain)");
    }
    return this.readbackTexture(this.target, this.width, this.height);
  }
}

function blankSurface(x: number, y: number, w: number, h: number): Surface {
  return {
    texture: null, view: null, uniformBuf: null, bindGroup: null,
    width: 0, height: 0, x, y, layoutW: w, layoutH: h, present: false,
    currentBufferId: 0,
    fx: defaultFx(),
    maskView: null,
  };
}
