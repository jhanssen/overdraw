// GPU rendering for the bundled decoration plugin. Builds one render pipeline
// up-front; per-window we keep a small uniform buffer + bind group + the
// decoration Surface (ring) the broker handed us.
//
// The compositor handles the rounded-corner shape (setSurfaceShape) on both
// the decoration's own surface AND the window's content surface, so the
// plugin's fragment shader only paints the gradient -- the compositor takes
// care of clipping the outer corners (decoration's shape) and the content's
// inner corners (the content surface's shape; the gap between the two
// rounded rects is exactly the visible band).

import type { ResolvedFill } from "./config.js";

// Maximum number of gradient stops we pack as uniforms. 8 is generous for a
// border decoration; users wanting more probably want a more complex shader
// anyway and can fork.
export const MAX_STOPS = 8;

// WGSL: a fullscreen triangle whose @builtin(position) frag.xy is in pixel
// coordinates. The fragment evaluates the (multi-stop) linear gradient at
// that pixel and emits a premultiplied rgba. The compositor's shape clip
// trims the outer corners.
const WGSL = /* wgsl */ `
struct U {
  // size.xy = surface size (px); .zw unused.
  size     : vec4f,
  // gradient: .x = cos(angle), .y = sin(angle); .z = stop count [1..8]; .w
  // unused.
  gradient : vec4f,
  // 8 RGBA color stops (straight RGBA; the shader premultiplies before
  // emitting).
  colors   : array<vec4f, 8>,
  // 8 stop positions in [0,1], packed two-per-vec4: ats0.xyzw = at[0..3],
  // ats1.xyzw = at[4..7].
  ats0     : vec4f,
  ats1     : vec4f,
};
@group(0) @binding(0) var<uniform> u : U;

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  // A single triangle that covers the entire viewport (NDC).
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
  // Pixel position centered on the surface midpoint; +x right, +y down.
  let p = vec2f(frag.x, frag.y) - vec2f(w, h) * 0.5;

  // CSS-like linear gradient: angle measured clockwise from +Y, naming the
  // direction the gradient PROCEEDS (start -> end). In pixel space (y down):
  // angle=0   -> direction +y (top -> bottom);
  // angle=90  -> direction +x (left -> right);
  // The CPU side packs (cos, sin); the pixel-space direction is (sin, cos).
  let dir = vec2f(u.gradient.y, u.gradient.x);
  // Project p onto dir; t spans -halfRange..+halfRange where halfRange is the
  // projection of the box's half-extents onto |dir|.
  let proj = dot(p, dir);
  let halfRange = abs(dir.x) * w * 0.5 + abs(dir.y) * h * 0.5;
  let t = clamp((proj + halfRange) / max(halfRange * 2.0, 1.0), 0.0, 1.0);

  let n = u32(u.gradient.z);
  if (n <= 1u) {
    // Solid fill.
    let c = u.colors[0];
    return vec4f(c.rgb * c.a, c.a);
  }
  // Find the stop interval [k, k+1] containing t.
  var k : u32 = 0u;
  for (var i : u32 = 0u; i + 1u < n; i = i + 1u) {
    if (t >= fetchAt(i)) { k = i; }
  }
  let a0 = fetchAt(k);
  let a1 = fetchAt(k + 1u);
  let span = max(a1 - a0, 1e-5);
  let lt = clamp((t - a0) / span, 0.0, 1.0);
  let col = mix(u.colors[k], u.colors[k + 1u], lt);

  // Premultiply: the compositor expects premultiplied rgba; the surface's
  // pipeline blends with one / one-minus-src-alpha.
  return vec4f(col.rgb * col.a, col.a);
}
`;

// 1 vec4 (size) + 1 vec4 (gradient) + 8 vec4 (colors) + 2 vec4 (ats0/ats1) =
// 12 vec4s = 48 floats.
const UNIFORM_FLOATS = 12 * 4;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;

export interface DecorationPipeline {
  readonly pipeline: GPURenderPipeline;
  readonly bindGroupLayout: GPUBindGroupLayout;
  // Core's GPUDevice. Stable across windows and across the plugin's lifetime.
  readonly device: GPUDevice;
}

// Build the shared pipeline once. Format matches the compositor's surface
// format (bgra8unorm; the ring textures use the same format).
export function createDecorationPipeline(device: GPUDevice): DecorationPipeline {
  const module = device.createShaderModule({ code: WGSL });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0, visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" },
    }],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module, entryPoint: "vs" },
    fragment: {
      module, entryPoint: "fs",
      targets: [{
        format: "bgra8unorm",
        // The decoration surface composites under the window's content with
        // the compositor's standard premultiplied blend. We're drawing into
        // the surface's own ring slot here, not directly onto the
        // framebuffer; the slot starts cleared to (0,0,0,0) so a one /
        // one-minus-src-alpha blend with a freshly-cleared target yields
        // exactly the shader's output.
        blend: {
          color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });
  return { pipeline, bindGroupLayout, device };
}

// Per-window draw state. Held by the plugin in a Map<windowId, DecorationDraw>;
// the ResolvedFill (focused / unfocused) is passed per draw call so a focus
// flip doesn't need a new bind group, just a new uniform write.
export interface DecorationDraw {
  uniformBuf: GPUBuffer;
  bindGroup: GPUBindGroup;
}

export function createDecorationDraw(p: DecorationPipeline): DecorationDraw {
  const uniformBuf = p.device.createBuffer({
    size: UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = p.device.createBindGroup({
    layout: p.bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  });
  return { uniformBuf, bindGroup };
}

export function destroyDecorationDraw(d: DecorationDraw): void {
  d.uniformBuf.destroy();
}

// Pack the uniform buffer for one draw + upload.
export function writeUniforms(
  device: GPUDevice, d: DecorationDraw,
  surfaceW: number, surfaceH: number,
  fill: ResolvedFill,
): void {
  const data = new Float32Array(UNIFORM_FLOATS);
  // size
  data[0] = surfaceW;
  data[1] = surfaceH;
  // gradient meta: (cos(angle), sin(angle), stopCount, _)
  data[4] = Math.cos(fill.angleRad);
  data[5] = Math.sin(fill.angleRad);
  data[6] = fill.stops.length;
  // 8 color stops (any unused trail with zeros; the shader respects the count).
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
  // ats0 (4) then ats1 (4); unused entries stay 0.
  const atsBase = colorsBase + MAX_STOPS * 4;
  for (let i = 0; i < N; i++) data[atsBase + i] = fill.stops[i].at;
  device.queue.writeBuffer(d.uniformBuf, 0, data);
}

// Encode + submit one draw of the decoration into `view`. Caller has already
// obtained the texture via surface.getCurrentTexture() and will call
// surface.present() after.
export function recordDraw(
  p: DecorationPipeline, d: DecorationDraw, view: GPUTextureView,
): void {
  const enc = p.device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [{
      view, loadOp: "clear", storeOp: "store",
      // Clear to transparent black. The shader emits a fully-opaque gradient
      // (premultiplied); the compositor's shape clip handles the outer
      // corners after the fact.
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    }],
  });
  pass.setPipeline(p.pipeline);
  pass.setBindGroup(0, d.bindGroup);
  pass.draw(3);
  pass.end();
  p.device.queue.submit([enc.finish()]);
}
