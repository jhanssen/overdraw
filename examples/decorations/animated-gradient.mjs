// Example decoration plugin: an ANIMATED gradient titlebar drawn with a WGSL
// shader. Registers as a decoration provider for ALL windows (app_id /.*/), and on
// each assigned window draws a top titlebar whose gradient shifts over time, with a
// moving highlight sweep. The bar tints brighter when the window is focused and
// dims when it loses focus (driven by sdk.window.onChange's `activated` flag).
//
// This is a real, animatable, server-side decoration: the plugin runs its own
// frame loop and presents continuously. Decorations are NOT interactive yet (clicks
// on the bar do not route here), but they can animate freely. The window's content
// is held until this plugin's FIRST present, so window + titlebar appear together;
// if this plugin failed to draw within the deadline the core would deregister it
// and show the window undecorated.
//
// Load it via your overdraw config, e.g.:
//   export default { plugins: [{ module: "/abs/path/examples/decorations/animated-gradient.mjs" }] };

const TITLEBAR_HEIGHT = 28;        // px reserved at the top of each window
const BORDER = 2;                  // px reserved on the other three edges

// Fragment shader: an animated two-stop diagonal gradient + a moving specular
// sweep, modulated by focus. uniforms: time (s), active (0/1), size (px).
const WGSL = /* wgsl */ `
struct U { time : f32, focused : f32, w : f32, h : f32, };
@group(0) @binding(0) var<uniform> u : U;

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  // Fullscreen triangle (covers the whole surface).
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn hsv2rgb(h : f32, s : f32, v : f32) -> vec3f {
  let k = vec3f(5.0, 3.0, 1.0);
  let p = abs(fract(vec3f(h) + k / 6.0) * 6.0 - 3.0);
  return v * mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), s);
}

@fragment fn fs(@builtin(position) frag : vec4f) -> @location(0) vec4f {
  let uv = vec2f(frag.x / u.w, frag.y / u.h);     // 0..1 across the surface
  // Hue drifts along the diagonal and over time -> a slow flowing gradient.
  let hue = fract(uv.x * 0.35 + uv.y * 0.15 + u.time * 0.05);
  let sat = 0.55;
  let val = mix(0.30, 0.85, u.focused);            // dim when unfocused
  var col = hsv2rgb(hue, sat, val);
  // Specular sweep: a soft diagonal band that travels left->right over ~3s.
  let sweep = fract(u.time / 3.0);
  let d = abs(uv.x - sweep);
  let hi = smoothstep(0.12, 0.0, d) * (0.25 + 0.35 * u.focused);
  col += vec3f(hi);
  return vec4f(col, 1.0);                           // opaque bar (BGRA8 surface)
}
`;

export default async function init(sdk) {
  await sdk.decorations.register(".*");   // decorate every window
  sdk.log("animated-gradient decoration provider registered");

  const dev = sdk.gpu.device;

  // Build the render pipeline once (the surface format is bgra8unorm). The WebGPU
  // GPU* globals (GPUBufferUsage, GPUShaderStage, ...) are installed by the runtime,
  // so they're available exactly like browser WebGPU.
  const module = dev.createShaderModule({ code: WGSL });
  const uniformBuf = dev.createBuffer({
    size: 16,                                        // 4 x f32
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroupLayout = dev.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
  });
  const pipeline = dev.createRenderPipeline({
    layout: dev.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "bgra8unorm" }] },
    primitive: { topology: "triangle-list" },
  });
  const bindGroup = dev.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  });

  // Per-decorated-window animation state. windowId -> { surface, w, h, active }.
  const windows = new Map();

  async function drawFrame(w) {
    const tex = await w.surface.getCurrentTexture();
    const t = (performance.now() - w.t0) / 1000;
    // uniforms: [time, active, width, height]
    dev.queue.writeBuffer(uniformBuf, 0,
      new Float32Array([t, w.active ? 1 : 0, w.w, w.h]));
    const enc = dev.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: tex.createView(), loadOp: "clear", storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    dev.queue.submit([enc.finish()]);
    return w.surface.present();
  }

  sdk.decorations.onAssigned(async (ev) => {
    try {
      // Reserve a titlebar inset (additive) + create the decoration surface on the
      // `below` layer (the opaque content draws over it -- only the reserved border
      // band shows the gradient). One call.
      const surface = await sdk.decorations.createDecoration(ev.surfaceId, {
        insets: { top: TITLEBAR_HEIGHT, right: BORDER, bottom: BORDER, left: BORDER },
        layer: "below",
      });
      const w = {
        surface, w: surface.width, h: surface.height,
        active: true, t0: performance.now(), running: true,
      };
      windows.set(ev.surfaceId, w);

      // Frame loop: animate on our own clock. The first present releases the gated
      // content (window + titlebar appear together). ~60fps via rAF-ish setTimeout
      // (a core frame-tick SDK -- sdk.onFrame -- would replace this later).
      void (async () => {
        while (w.running) {
          await drawFrame(w);
          await new Promise((r) => setTimeout(r, 16));
        }
      })();
      sdk.log(`decorating window ${ev.surfaceId} (${surface.width}x${surface.height})`);
    } catch (e) {
      sdk.log(`decoration failed for ${ev.surfaceId}: ${e && e.message ? e.message : e}`);
    }
  });

  // Focus styling: window.change carries the `activated` flag. Re-tint the bar
  // (the frame loop reads w.active each frame, so just flip it).
  sdk.window.onChange((ev) => {
    const w = windows.get(ev.surfaceId);
    if (w) w.active = ev.activated;
  });

  // Stop animating a window when it unmaps. (No onUnmap on sdk.decorations; use the
  // window observer.) The core releases the surface on plugin teardown.
  sdk.window.onUnmap((ev) => {
    const w = windows.get(ev.surfaceId);
    if (w) { w.running = false; windows.delete(ev.surfaceId); }
  });

  // If the core deregisters us (e.g. we missed a first-frame deadline), stop.
  sdk.decorations.onDeregistered((ev) => {
    sdk.log(`deregistered (${ev.reason}); stopping animation`);
    for (const w of windows.values()) w.running = false;
    windows.clear();
  });
}
