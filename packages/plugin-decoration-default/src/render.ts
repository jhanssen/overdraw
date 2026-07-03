// GPU rendering for the bundled decoration plugin.
//
// The plugin runs as an intercept (decoration-as-intercept.md). The output
// texture is sized to the surface's WM outer rect = content + 2*B on each
// axis. Two render passes per intercept frame:
//
//   Pass 1 (border): clear to a transparent black; fill the FULL output
//     with the gradient/solid border color. The compositor's setShape on
//     the output (applied once at match time via sdk.windows.setShape)
//     clips the outer perimeter with the user-configured shape (rounded
//     rect / per-corner / squircle).
//
//   Pass 2 (blit): sample the client input texture and write it into the
//     INSET region of the output, starting at (B, B) and extending
//     (inputW, inputH). The fragment evaluates the INNER shape SDF (= outer
//     shape radii inset by B) for antialiased coverage AND the border gradient
//     at the same output-space pixel, then emits, with REPLACE blend,
//     mix(gradient, client-over-rim-underlay, coverage). The rim underlay
//     composites the client source-over the gradient within one corner radius
//     of the inner edge, so a client that rounds its own corners (a CSD buffer
//     with transparent corner pixels) blends into the band instead of showing
//     the backdrop through the corner. Deeper than the rim the output is the
//     client sample with its own alpha intact -- a translucent window body
//     stays translucent and blends against the real backdrop in the final
//     composite, rather than being baked opaque over the gradient. Across the
//     rounded inner edge it blends to the opaque border band; corner cutouts
//     (coverage 0) are discarded, leaving pass 1's gradient. For an opaque
//     client all of this is identical to a premultiplied source-over of the
//     client onto the band.
//
// The blit shader contains all four shape kinds (rect, rounded-rect uniform,
// rounded-rect per-corner, squircle) selected by a uniform `kind` value.
// Kind 0 (sharp rect) early-outs coverage = 1.0 over the whole inset region,
// matching today's "no rounding" code path.

import type { ResolvedFill } from "./config.js";

// Maximum number of gradient stops we pack as uniforms. 8 is generous for a
// border decoration; users wanting more probably want a more complex shader
// anyway and can fork.
export const MAX_STOPS = 8;

// ----- Border pass (pass 1) -------------------------------------------------

// Fullscreen-triangle vertex; fragment evaluates an angular linear gradient
// across the surface and emits premultiplied rgba. Identical math to the
// pre-intercept render module so visual output for solid+gradient configs
// is unchanged.
const BORDER_WGSL = /* wgsl */ `
struct U {
  // size.xy = surface size (px); .zw unused.
  size     : vec4f,
  // gradient: .x = cos(angle), .y = sin(angle); .z = stop count [1..8]; .w
  // unused.
  gradient : vec4f,
  // 8 RGBA color stops (straight RGBA; the shader premultiplies before
  // emitting).
  colors   : array<vec4f, 8>,
  // 8 stop positions in [0,1], packed two-per-vec4.
  ats0     : vec4f,
  ats1     : vec4f,
};
@group(0) @binding(0) var<uniform> u : U;

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn fetchAt(i : u32) -> f32 {
  if (i < 4u) { return u.ats0[i]; }
  return u.ats1[i - 4u];
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let w = u.size.x;
  let h = u.size.y;
  let p = vec2f(frag.x, frag.y) - vec2f(w, h) * 0.5;

  // CSS-like linear gradient: angle measured clockwise from +Y (start->end).
  // pixel-space direction = (sin, cos).
  let dir = vec2f(u.gradient.y, u.gradient.x);
  let proj = dot(p, dir);
  let halfRange = abs(dir.x) * w * 0.5 + abs(dir.y) * h * 0.5;
  let t = clamp((proj + halfRange) / max(halfRange * 2.0, 1.0), 0.0, 1.0);

  let n = u32(u.gradient.z);
  if (n <= 1u) {
    let c = u.colors[0];
    return vec4f(c.rgb * c.a, c.a);
  }
  var k : u32 = 0u;
  for (var i : u32 = 0u; i + 1u < n; i = i + 1u) {
    if (t >= fetchAt(i)) { k = i; }
  }
  let a0 = fetchAt(k);
  let a1 = fetchAt(k + 1u);
  let span = max(a1 - a0, 1e-5);
  let lt = clamp((t - a0) / span, 0.0, 1.0);
  let col = mix(u.colors[k], u.colors[k + 1u], lt);
  return vec4f(col.rgb * col.a, col.a);
}
`;

// 1 vec4 (size) + 1 vec4 (gradient) + 8 vec4 (colors) + 2 vec4 (ats0/ats1) =
// 12 vec4s = 48 floats.
const BORDER_UNIFORM_FLOATS = 12 * 4;
const BORDER_UNIFORM_BYTES = BORDER_UNIFORM_FLOATS * 4;

// ----- Blit pass (pass 2) ---------------------------------------------------

// Vertex shader emits a quad covering the inset region [B, B, B+inW, B+inH]
// of an outputW x outputH surface, parameterized by the uniform block. The
// fragment samples the input texture (a non-tiled BGRA8) and multiplies by
// the inner-shape SDF coverage.
//
// Inner-shape SDF parameters live in the uniform block:
//   shape.x = kind  (0 = rect / 1 = rounded-rect uniform / 2 = per-corner /
//                    3 = squircle)
//   shape.y = inner.w (px, full extent)
//   shape.z = inner.h (px)
//   shape.w = radius / corner-extent (kind=1 or 3)
//   shapeExtra = (tl, tr, br, bl) for kind=2; (exponent, 0, 0, 0) for kind=3
const BLIT_WGSL = /* wgsl */ `
struct U {
  // size.xy = output texture size (px); .zw = inset origin (B, B).
  size      : vec4f,
  // inputSize.xy = content (window) size in px = the inset extent; .zw unused.
  inputSize : vec4f,
  // uvRect.xy = uv bias (contentOrigin / bufferSize); uvRect.zw = uv scale
  // (contentSize / bufferSize). Maps the inset-local position to the content
  // sub-region of the buffer texture, so a CSD client's shadow margin (buffer
  // beyond the window geometry) is never sampled.
  uvRect    : vec4f,
  // shape.x = kind (0/1/2/3); shape.yz = inner extent (px); shape.w = radius.
  shape     : vec4f,
  // For kind=2 (per-corner): (tl, tr, br, bl); for kind=3 (squircle):
  // (exponent, 0, 0, 0); otherwise unused.
  shapeExtra: vec4f,
  // gradient: .x = cos(angle), .y = sin(angle); .z = stop count [1..8]. Same
  // angular-gradient parameters the border pass uses, so the blit can evaluate
  // the border color at each output-space pixel and blend it under the client.
  gradient  : vec4f,
  // 8 straight-RGBA color stops (premultiplied before use).
  colors    : array<vec4f, 8>,
  // 8 stop positions in [0,1], packed two-per-vec4.
  ats0      : vec4f,
  ats1      : vec4f,
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var tex  : texture_2d<f32>;

fn fetchAt(i : u32) -> f32 {
  if (i < 4u) { return u.ats0[i]; }
  return u.ats1[i - 4u];
}

// Premultiplied border-gradient color at an OUTPUT-space pixel. Identical math
// to the border pass (BORDER_WGSL.fs), evaluated over the full output extent so
// the inset blends seamlessly into the band the border pass painted.
fn gradientAt(fragPx : vec2f) -> vec4f {
  let w = u.size.x;
  let h = u.size.y;
  let p = fragPx - vec2f(w, h) * 0.5;
  let dir = vec2f(u.gradient.y, u.gradient.x);
  let proj = dot(p, dir);
  let halfRange = abs(dir.x) * w * 0.5 + abs(dir.y) * h * 0.5;
  let t = clamp((proj + halfRange) / max(halfRange * 2.0, 1.0), 0.0, 1.0);
  let n = u32(u.gradient.z);
  if (n <= 1u) {
    let c = u.colors[0];
    return vec4f(c.rgb * c.a, c.a);
  }
  var k : u32 = 0u;
  for (var i : u32 = 0u; i + 1u < n; i = i + 1u) {
    if (t >= fetchAt(i)) { k = i; }
  }
  let a0 = fetchAt(k);
  let a1 = fetchAt(k + 1u);
  let span = max(a1 - a0, 1e-5);
  let lt = clamp((t - a0) / span, 0.0, 1.0);
  let col = mix(u.colors[k], u.colors[k + 1u], lt);
  return vec4f(col.rgb * col.a, col.a);
}

struct VsOut {
  @builtin(position) pos : vec4f,
  // Pixel coords inside the inset region (range [0, innerW] x [0, innerH]).
  @location(0)        ip : vec2f,
  // Texture sample uv (range [0,1] over the input).
  @location(1)        uv : vec2f,
};

@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  // Triangle-strip quad covering the inset region [insetX, insetY] -
  // [insetX + innerW, insetY + innerH] in pixel space, transformed to NDC.
  let ow = u.size.x;       let oh = u.size.y;
  let ix = u.size.z;       let iy = u.size.w;
  let iw = u.inputSize.x;  let ih = u.inputSize.y;
  // Corner offsets within the inset region: (0,0)/(iw,0)/(0,ih)/(iw,ih)
  // expressed as a (dx, dy) per vertex of the strip.
  let cx = array<f32, 4>(0.0, iw, 0.0, iw);
  let cy = array<f32, 4>(0.0, 0.0, ih, ih);
  let dx = cx[i]; let dy = cy[i];
  let px = ix + dx;
  let py = iy + dy;
  // Map pixel space -> NDC. y is flipped (NDC +y up; pixel +y down).
  let nx = (px / ow) * 2.0 - 1.0;
  let ny = 1.0 - (py / oh) * 2.0;
  var out : VsOut;
  out.pos = vec4f(nx, ny, 0.0, 1.0);
  out.ip  = vec2f(dx, dy);
  // Normalized position inside the inset [0,1], mapped to the content
  // sub-region of the buffer via uvRect (bias + scale).
  let nl  = vec2f(dx / max(iw, 1e-5), dy / max(ih, 1e-5));
  out.uv  = u.uvRect.xy + nl * u.uvRect.zw;
  return out;
}

// --- SDF helpers (mirrors the compositor's shape SDF) ---

fn sdfRoundedRect(p : vec2f, he : vec2f, r : f32) -> f32 {
  let q = abs(p) - he + vec2f(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}

fn sdfSquircleRect(p : vec2f, he : vec2f, r : f32, n : f32) -> f32 {
  let cr = min(r, min(he.x, he.y));
  let exp = max(n, 2.0);
  let q = abs(p) - he + vec2f(cr);
  let edge = min(max(q.x, q.y), 0.0);
  let qc = max(q, vec2f(0.0));
  let ax = qc.x / max(cr, 1e-5);
  let ay = qc.y / max(cr, 1e-5);
  let cornerR = pow(pow(ax, exp) + pow(ay, exp), 1.0 / exp);
  let corner = cornerR * cr - cr;
  return edge + corner;
}

fn sdfCoverage(d : f32) -> f32 {
  return 1.0 - smoothstep(-0.5, 0.5, d);
}

// Signed inner-shape distance (px, negative inside) in .x and the corner
// radius governing this pixel's nearest corner in .y (0 = square / no inner
// clip; the sentinel -1e6 distance means "deep inside, unclipped").
fn innerShape(ip : vec2f) -> vec2f {
  let kind = u32(u.shape.x);
  if (kind == 0u) { return vec2f(-1e6, 0.0); }   // rect: no inner clip
  let iw = u.shape.y;
  let ih = u.shape.z;
  let he = vec2f(iw, ih) * 0.5;
  let p  = ip - he;   // recenter on the inset region's midpoint
  if (kind == 1u) {
    return vec2f(sdfRoundedRect(p, he, u.shape.w), u.shape.w);
  }
  if (kind == 2u) {
    var r : f32 = 0.0;
    if (p.x < 0.0) { if (p.y < 0.0) { r = u.shapeExtra.x; } else { r = u.shapeExtra.w; } }
    else           { if (p.y < 0.0) { r = u.shapeExtra.y; } else { r = u.shapeExtra.z; } }
    return vec2f(sdfRoundedRect(p, he, r), r);
  }
  if (kind == 3u) {
    return vec2f(sdfSquircleRect(p, he, u.shape.w, u.shapeExtra.x), u.shape.w);
  }
  return vec2f(-1e6, 0.0);
}

@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  let s = innerShape(in.ip);
  let cov = sdfCoverage(s.x);
  if (cov <= 0.0) { discard; }   // corner cutouts keep the border pass's gradient
  let sample = textureSample(tex, samp, in.uv);   // premultiplied client
  let band = gradientAt(u.size.zw + in.ip);       // premultiplied border at this pixel
  // Band underlay: within one corner radius of the inner edge the client is
  // composited source-over the band, so a client that rounds its own corners
  // (a CSD buffer with transparent corner pixels) blends into the band rather
  // than punching a see-through hole to the backdrop. The underlay fades out
  // with depth; past it the client's own alpha is preserved, so a translucent
  // window body still blends against the real backdrop downstream instead of
  // being baked opaque over the gradient.
  let rim = smoothstep(-max(s.y, 1e-4), 0.0, s.x);
  let over = sample + band * ((1.0 - sample.a) * rim);
  // Replace blend: emit the final pixel directly, blending to the opaque
  // border across the antialiased inner edge (cov: 1 -> 0). For an opaque
  // client this is identical to a premultiplied source-over of (sample*cov)
  // onto the band.
  return mix(band, over, cov);
}
`;

// size + inputSize + uvRect + shape + shapeExtra + gradient + colors[8] + ats0
// + ats1 = 16 vec4s = 64 floats.
const BLIT_UNIFORM_FLOATS = 16 * 4;
const BLIT_UNIFORM_BYTES = BLIT_UNIFORM_FLOATS * 4;

// ----- Pipelines + per-window state -----------------------------------------

export interface DecorationPipeline {
  readonly device: GPUDevice;
  // Pass 1: border fill.
  readonly borderPipeline: GPURenderPipeline;
  readonly borderBindGroupLayout: GPUBindGroupLayout;
  // Pass 2: inner-clipped client blit.
  readonly blitPipeline: GPURenderPipeline;
  readonly blitBindGroupLayout: GPUBindGroupLayout;
  // Shared sampler for the blit (linear filtering for the antialiased
  // texture sample; the inner-SDF supplies the corner antialiasing).
  readonly sampler: GPUSampler;
}

export function createDecorationPipeline(device: GPUDevice): DecorationPipeline {
  const borderModule = device.createShaderModule({ code: BORDER_WGSL });
  const borderBindGroupLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0, visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" },
    }],
  });
  const borderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [borderBindGroupLayout] }),
    vertex: { module: borderModule, entryPoint: "vs" },
    fragment: {
      module: borderModule, entryPoint: "fs",
      targets: [{
        format: "bgra8unorm",
        blend: {
          color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });

  const blitModule = device.createShaderModule({ code: BLIT_WGSL });
  const blitBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  });
  const blitPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [blitBindGroupLayout] }),
    vertex: { module: blitModule, entryPoint: "vs" },
    fragment: {
      module: blitModule, entryPoint: "fs",
      // Replace blend (no blend state): the fragment already composes the
      // client over the border gradient via mix(), emitting the final
      // premultiplied pixel. This is what preserves a translucent client's
      // alpha -- a source-over blend here would force the result opaque against
      // the gradient. loadOp=load + discard on corner cutouts keeps the border
      // pass's gradient wherever we don't write.
      targets: [{ format: "bgra8unorm" }],
    },
    primitive: { topology: "triangle-strip" },
  });

  const sampler = device.createSampler({
    magFilter: "linear", minFilter: "linear",
  });

  return {
    device,
    borderPipeline, borderBindGroupLayout,
    blitPipeline, blitBindGroupLayout,
    sampler,
  };
}

// Per-window draw state. The blit bind group is rebuilt whenever the input
// texture identity changes (input dim change -> compositor releases the old
// view, the intercept SDK hands us a new one). The border uniform buffer is
// recreated when the output texture size changes.
export interface DecorationDraw {
  borderUniform: GPUBuffer;
  borderBindGroup: GPUBindGroup;
  blitUniform: GPUBuffer;
  // The blit bind group depends on the input texture VIEW which changes
  // every render call (the input ring rotates each frame on the compositor
  // side), so we rebuild it per-frame inside encodeFrame.
}

export function createDecorationDraw(p: DecorationPipeline): DecorationDraw {
  const borderUniform = p.device.createBuffer({
    size: BORDER_UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const borderBindGroup = p.device.createBindGroup({
    layout: p.borderBindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: borderUniform } }],
  });
  const blitUniform = p.device.createBuffer({
    size: BLIT_UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  return { borderUniform, borderBindGroup, blitUniform };
}

export function destroyDecorationDraw(d: DecorationDraw): void {
  d.borderUniform.destroy();
  d.blitUniform.destroy();
}

// Pack the border pass's uniform buffer + upload. Called when the output
// texture size or the fill changes.
export function writeBorderUniforms(
  device: GPUDevice, d: DecorationDraw,
  outputW: number, outputH: number,
  fill: ResolvedFill,
): void {
  const data = new Float32Array(BORDER_UNIFORM_FLOATS);
  data[0] = outputW;
  data[1] = outputH;
  data[4] = Math.cos(fill.angleRad);
  data[5] = Math.sin(fill.angleRad);
  data[6] = fill.stops.length;
  const colorsBase = 8;
  const N = Math.min(fill.stops.length, MAX_STOPS);
  for (let i = 0; i < N; i++) {
    const s = fill.stops[i];
    const base = colorsBase + i * 4;
    data[base] = s.color.r;
    data[base + 1] = s.color.g;
    data[base + 2] = s.color.b;
    data[base + 3] = s.color.a;
  }
  const atsBase = colorsBase + MAX_STOPS * 4;
  for (let i = 0; i < N; i++) data[atsBase + i] = fill.stops[i].at;
  device.queue.writeBuffer(d.borderUniform, 0, data);
}

// The inner-shape SDF kinds, mirroring the compositor's encoding.
export type InnerShapeKind = 0 | 1 | 2 | 3;

export interface InnerShapeParams {
  // 0 = rect (no clipping, full coverage in the inset region)
  // 1 = rounded-rect uniform (radius via `radius`)
  // 2 = rounded-rect per-corner (tl/tr/br/bl)
  // 3 = squircle (radius + exponent)
  kind: InnerShapeKind;
  radius: number;
  tl?: number; tr?: number; br?: number; bl?: number;
  exponent?: number;
}

// Pack the blit pass's uniform buffer + upload. Called once per render call
// (the inner shape parameters are stable across frames; the dimensions can
// change if the output ring is reallocated).
export function writeBlitUniforms(
  device: GPUDevice, d: DecorationDraw,
  outputW: number, outputH: number,
  inputW: number, inputH: number,
  bufferW: number, bufferH: number,
  contentX: number, contentY: number,
  borderWidth: number,
  inner: InnerShapeParams,
  fill: ResolvedFill,
): void {
  const data = new Float32Array(BLIT_UNIFORM_FLOATS);
  // size.xy = output dims; size.zw = inset origin (B, B)
  data[0] = outputW;
  data[1] = outputH;
  data[2] = borderWidth;
  data[3] = borderWidth;
  // inputSize.xy = content (window) dims = the inset extent
  data[4] = inputW;
  data[5] = inputH;
  // uvRect = (bias.xy, scale.xy): sample the [contentX,contentY]+(inputW x
  // inputH) sub-region of the bufferW x bufferH texture.
  const bw = Math.max(bufferW, 1);
  const bh = Math.max(bufferH, 1);
  data[8] = contentX / bw;
  data[9] = contentY / bh;
  data[10] = inputW / bw;
  data[11] = inputH / bh;
  // shape.x = kind; shape.yz = inner extent (= content dims); shape.w = radius
  data[12] = inner.kind;
  data[13] = inputW;
  data[14] = inputH;
  data[15] = inner.radius;
  // shapeExtra (offset 16)
  if (inner.kind === 2) {
    data[16] = inner.tl ?? 0;
    data[17] = inner.tr ?? 0;
    data[18] = inner.br ?? 0;
    data[19] = inner.bl ?? 0;
  } else if (inner.kind === 3) {
    data[16] = inner.exponent ?? 2;
  }
  // gradient (offset 20) + colors[8] (offset 24) + ats0/ats1 (offset 56): the
  // border-pass gradient parameters, so the blit can evaluate the band color
  // under the client. Mirrors writeBorderUniforms' packing.
  data[20] = Math.cos(fill.angleRad);
  data[21] = Math.sin(fill.angleRad);
  data[22] = fill.stops.length;
  const colorsBase = 24;
  const N = Math.min(fill.stops.length, MAX_STOPS);
  for (let i = 0; i < N; i++) {
    const s = fill.stops[i];
    const base = colorsBase + i * 4;
    data[base] = s.color.r;
    data[base + 1] = s.color.g;
    data[base + 2] = s.color.b;
    data[base + 3] = s.color.a;
  }
  const atsBase = colorsBase + MAX_STOPS * 4;
  for (let i = 0; i < N; i++) data[atsBase + i] = fill.stops[i].at;
  device.queue.writeBuffer(d.blitUniform, 0, data);
}

// Encode both passes and submit. The intercept SDK hands us the output
// texture (a slot of the output ring) and the input texture (the client's
// current sampled texture); both belong to core's device (same device the
// pipeline lives on). The plugin must submit before returning from render.
export function encodeFrame(
  p: DecorationPipeline, d: DecorationDraw,
  outputView: GPUTextureView,
  inputTexture: GPUTexture,
): void {
  const enc = p.device.createCommandEncoder();

  // Pass 1: border fill over the full output.
  {
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(p.borderPipeline);
    pass.setBindGroup(0, d.borderBindGroup);
    pass.draw(3);
    pass.end();
  }

  // Pass 2: blit the client into the inset region with inner-SDF coverage.
  // Build the bind group per-frame: the input texture view changes every
  // tick (the compositor's swap chain rotates), and the same applies to
  // the output view conceptually -- but we never rebind output here, only
  // input + our uniform/sampler.
  const inputView = inputTexture.createView();
  const blitBindGroup = p.device.createBindGroup({
    layout: p.blitBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: d.blitUniform } },
      { binding: 1, resource: p.sampler },
      { binding: 2, resource: inputView },
    ],
  });
  {
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        loadOp: "load",          // keep pass 1's border underneath
        storeOp: "store",
      }],
    });
    pass.setPipeline(p.blitPipeline);
    pass.setBindGroup(0, blitBindGroup);
    pass.draw(4);
    pass.end();
  }

  p.device.queue.submit([enc.finish()]);
}
