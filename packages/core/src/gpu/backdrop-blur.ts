// Dual-Kawase backdrop-blur renderer: the built-in implementation behind
// the "blur" backdrop-effect kind (registered at startup; see
// BackdropEffectRenderer in compositor.ts for the contract). Down passes
// walk a chain of half/quarter/... resolution textures (keyed by target
// device size -- see CHAIN_CAP), up passes walk back to the
// half-resolution level, which the compositor's effect quad samples
// bilinearly. Blur strength = chain depth x tap offset, both derived from
// params.radius (logical px, default 20).
//
// Runs on the core thread + core device, mid-composite, encoding into the
// frame's command encoder between two segments of the on-screen pass.
// Per-surface uniform buffers (not per-chain) keep two surfaces with
// different radii on one output from clobbering each other: writeBuffer
// payloads land at submit time, so any buffer written twice in one frame
// would apply its LAST value to every pass that binds it.

import type {
  BackdropEffectArgs, BackdropEffectRenderer, BackdropEffectResult,
  DawnGlobals,
} from "./compositor.js";

const BLUR_WGSL = `
struct BlurUniforms { params : vec4f };
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var src : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u : BlurUniforms;
struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};
@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  var q = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 0.0));
  let uv = q[i];
  var o : VsOut;
  o.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  o.uv = uv;
  return o;
}
// params.xy = SOURCE texel size, params.z = tap offset in source texels.
// The kernels are the standard dual-filter pair: 4 corner taps around a
// weighted center on the way down, 8 taps on the way up.
@fragment fn fsDown(in : VsOut) -> @location(0) vec4f {
  let h = u.params.xy * u.params.z;
  var sum = textureSampleLevel(src, samp, in.uv, 0.0) * 4.0;
  sum += textureSampleLevel(src, samp, in.uv - h, 0.0);
  sum += textureSampleLevel(src, samp, in.uv + h, 0.0);
  sum += textureSampleLevel(src, samp, in.uv + vec2f(h.x, -h.y), 0.0);
  sum += textureSampleLevel(src, samp, in.uv - vec2f(h.x, -h.y), 0.0);
  return sum / 8.0;
}
@fragment fn fsUp(in : VsOut) -> @location(0) vec4f {
  let h = u.params.xy * u.params.z;
  var sum = textureSampleLevel(src, samp, in.uv + vec2f(-h.x * 2.0, 0.0), 0.0);
  sum += textureSampleLevel(src, samp, in.uv + vec2f(-h.x, h.y), 0.0) * 2.0;
  sum += textureSampleLevel(src, samp, in.uv + vec2f(0.0, h.y * 2.0), 0.0);
  sum += textureSampleLevel(src, samp, in.uv + vec2f(h.x, h.y), 0.0) * 2.0;
  sum += textureSampleLevel(src, samp, in.uv + vec2f(h.x * 2.0, 0.0), 0.0);
  sum += textureSampleLevel(src, samp, in.uv + vec2f(h.x, -h.y), 0.0) * 2.0;
  sum += textureSampleLevel(src, samp, in.uv + vec2f(0.0, -h.y * 2.0), 0.0);
  sum += textureSampleLevel(src, samp, in.uv + vec2f(-h.x, -h.y), 0.0) * 2.0;
  return sum / 12.0;
}
`;

export const BLUR_RADIUS_DEFAULT = 20;
const BLUR_RADIUS_MAX = 128;
const BLUR_MAX_LEVELS = 4;

function clampRadius(params: Readonly<Record<string, number>>): number {
  const r = params.radius ?? BLUR_RADIUS_DEFAULT;
  return Math.min(BLUR_RADIUS_MAX, Math.max(1, r));
}

// Map a radius to a chain depth + per-tap offset. Depth roughly doubles the
// effective reach per level; the offset fine-tunes within a level.
// Monotonic in radius, which is the contract that matters.
function blurParamsFor(radius: number): { levels: number; offset: number } {
  const levels = radius <= 4 ? 1 : radius <= 12 ? 2 : radius <= 32 ? 3
    : BLUR_MAX_LEVELS;
  const offset = Math.min(2.5, Math.max(0.6, radius / (1 << levels)));
  return { levels, offset };
}

interface ChainLevel {
  tex: GPUTexture;
  view: GPUTextureView;
  w: number;
  h: number;
}

// Per-surface uniform buffers + bind groups within one chain. downBinds[0]
// is unused (the level-0 down pass samples the per-frame scanout view and
// binds transiently); the deepest level's upBuf is unused. offset tracks
// what the buffers currently hold so an unchanged radius writes nothing.
interface SurfaceBlurState {
  offset: number;
  downBufs: GPUBuffer[];
  upBufs: GPUBuffer[];
  downBinds: Array<GPUBindGroup | null>;
  upBinds: Array<GPUBindGroup | null>;
}

interface Chain {
  devW: number;
  devH: number;
  levels: ChainLevel[];
  surfaces: Map<number, SurfaceBlurState>;
}

// Cap on per-chain surface-state entries; a sweep this size covers any
// plausible number of simultaneously-blurred surfaces, and the reset cost
// (a handful of 16-byte buffers) is trivial.
const SURFACE_STATE_CAP = 32;

// Chains are keyed by target device size, not target identity: the same
// renderer serves every scene composite (outputs, capture, compose scenes,
// transition sources), and sizes are the only stable notion across them.
// The LRU cap bounds memory when many distinct compose sizes churn; an
// output's chain just stays hot. Each chain is ~2/3 of one full-res target
// (1/4 + 1/16 + ...), so 6 chains is comfortably small.
const CHAIN_CAP = 6;

export interface BackdropBlurRenderer extends BackdropEffectRenderer {
  destroy(): void;
}

export function createBackdropBlurRenderer(
  device: GPUDevice, g: DawnGlobals, format: GPUTextureFormat,
): BackdropBlurRenderer {
  const module = device.createShaderModule({ code: BLUR_WGSL });
  const mkPipeline = (entryPoint: string): GPURenderPipeline =>
    device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      primitive: { topology: "triangle-strip" },
      fragment: { module, entryPoint, targets: [{ format }] },
    });
  const downPipeline = mkPipeline("fsDown");
  const upPipeline = mkPipeline("fsUp");
  // "auto" layouts are per-pipeline objects; bind groups must be built
  // against the layout of the pipeline that draws them.
  const downLayout = downPipeline.getBindGroupLayout(0);
  const upLayout = upPipeline.getBindGroupLayout(0);
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

  const chains = new Map<string, Chain>();

  function destroySurfaceStates(c: Chain): void {
    for (const st of c.surfaces.values()) {
      for (const b of st.downBufs) b.destroy();
      for (const b of st.upBufs) b.destroy();
    }
    c.surfaces.clear();
  }

  function destroyChain(c: Chain): void {
    destroySurfaceStates(c);
    for (const l of c.levels) l.tex.destroy();
  }

  function ensureChain(devW: number, devH: number): Chain {
    const key = `${devW}x${devH}`;
    let c = chains.get(key);
    if (c) {
      // Refresh recency (Map iteration order is insertion order).
      chains.delete(key);
      chains.set(key, c);
      return c;
    }
    if (chains.size >= CHAIN_CAP) {
      const oldest = chains.keys().next();
      if (!oldest.done) {
        const evicted = chains.get(oldest.value);
        chains.delete(oldest.value);
        if (evicted) destroyChain(evicted);
      }
    }
    const levels: ChainLevel[] = [];
    for (let i = 0; i < BLUR_MAX_LEVELS; i++) {
      const w = Math.max(1, devW >> (i + 1));
      const h = Math.max(1, devH >> (i + 1));
      const tex = device.createTexture({
        size: { width: w, height: h },
        format,
        usage: g.GPUTextureUsage.RENDER_ATTACHMENT
             | g.GPUTextureUsage.TEXTURE_BINDING,
      });
      levels.push({ tex, view: tex.createView(), w, h });
    }
    c = { devW, devH, levels, surfaces: new Map() };
    chains.set(key, c);
    return c;
  }

  function ensureSurfaceState(c: Chain, surfaceId: number): SurfaceBlurState {
    let st = c.surfaces.get(surfaceId);
    if (st) return st;
    if (c.surfaces.size >= SURFACE_STATE_CAP) destroySurfaceStates(c);
    const mkBuf = (): GPUBuffer => device.createBuffer({
      size: 16,
      usage: g.GPUBufferUsage.UNIFORM | g.GPUBufferUsage.COPY_DST,
    });
    st = {
      offset: -1,
      downBufs: c.levels.map(mkBuf),
      upBufs: c.levels.map(mkBuf),
      downBinds: c.levels.map(() => null),
      upBinds: c.levels.map(() => null),
    };
    c.surfaces.set(surfaceId, st);
    return st;
  }

  function writeUniforms(c: Chain, st: SurfaceBlurState, offset: number): void {
    const params = (tw: number, th: number): Float32Array => {
      const d = new Float32Array(4);
      d[0] = tw; d[1] = th; d[2] = offset;
      return d;
    };
    for (let i = 0; i < c.levels.length; i++) {
      const src = i === 0 ? { w: c.devW, h: c.devH } : c.levels[i - 1];
      device.queue.writeBuffer(st.downBufs[i], 0, params(1 / src.w, 1 / src.h));
      if (i + 1 < c.levels.length) {
        const up = c.levels[i + 1];
        device.queue.writeBuffer(st.upBufs[i], 0, params(1 / up.w, 1 / up.h));
      }
    }
    st.offset = offset;
  }

  return {
    reach(params): number {
      return clampRadius(params);
    },

    render(args: BackdropEffectArgs): BackdropEffectResult {
      const radius = clampRadius(args.params);
      const { levels, offset } = blurParamsFor(radius);
      const c = ensureChain(args.deviceWidth, args.deviceHeight);
      const st = ensureSurfaceState(c, args.surfaceId);
      if (st.offset !== offset) writeUniforms(c, st, offset);
      const n = Math.min(levels, c.levels.length);
      const encodePass = (
        view: GPUTextureView, pipeline: GPURenderPipeline, bind: GPUBindGroup,
      ): void => {
        const pass = args.encoder.beginRenderPass({
          colorAttachments: [{
            view, loadOp: "clear", storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(4);
        pass.end();
      };
      const mkBind = (
        layout: GPUBindGroupLayout, src: GPUTextureView, buf: GPUBuffer,
      ): GPUBindGroup => device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: src },
          { binding: 2, resource: { buffer: buf } },
        ],
      });
      for (let i = 0; i < n; i++) {
        const lvl = c.levels[i];
        let bind: GPUBindGroup;
        if (i === 0) {
          // The scanout view is a fresh wrap each frame; not cacheable.
          bind = mkBind(downLayout, args.source, st.downBufs[0]);
        } else {
          let db = st.downBinds[i];
          if (!db) {
            db = mkBind(downLayout, c.levels[i - 1].view, st.downBufs[i]);
            st.downBinds[i] = db;
          }
          bind = db;
        }
        encodePass(lvl.view, downPipeline, bind);
      }
      for (let i = n - 2; i >= 0; i--) {
        let ub = st.upBinds[i];
        if (!ub) {
          ub = mkBind(upLayout, c.levels[i + 1].view, st.upBufs[i]);
          st.upBinds[i] = ub;
        }
        encodePass(c.levels[i].view, upPipeline, ub);
      }
      // Level 0 spans the full source, so the surface's source-UV rect maps
      // through unchanged.
      return { view: c.levels[0].view, uv: args.rect };
    },

    destroy(): void {
      for (const c of chains.values()) destroyChain(c);
      chains.clear();
    },
  };
}
