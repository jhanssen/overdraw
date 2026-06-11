// Worker-side fixture for Phase 10a intercept GPU testing. Same shape
// as intercept-invert.mjs but the plugin runs in its own Worker on its
// own GPU device. The SDK transparently handles the cross-device dmabuf
// rings; the plugin source is IDENTICAL to the in-thread fixture.
//
// Config:
//   appIdSource, appIdFlags: regex for the match.
//   failEvery: every N-th render throws (failure-fallback test).

export default async function init(sdk, config) {
  sdk.log(`intercept-invert-worker init mode=${config?.appIdSource}`);
  if (!sdk.intercept) {
    sdk.log("no sdk.intercept; bailing");
    return;
  }
  const spec = {
    name: "invert-worker",
    match: {
      appId: {
        source: config?.appIdSource ?? ".*",
        flags: config?.appIdFlags ?? "",
      },
    },
    setup: (ctx) => {
      const { device } = ctx;
      const module = device.createShaderModule({
        code: `
          struct VsOut { @builtin(position) pos : vec4f, @location(0) uv : vec2f }
          @vertex
          fn vs(@builtin(vertex_index) i : u32) -> VsOut {
            var positions = array<vec2f, 4>(
              vec2f(-1.0, -1.0), vec2f( 1.0, -1.0),
              vec2f(-1.0,  1.0), vec2f( 1.0,  1.0),
            );
            var uvs = array<vec2f, 4>(
              vec2f(0.0, 1.0), vec2f(1.0, 1.0),
              vec2f(0.0, 0.0), vec2f(1.0, 0.0),
            );
            var out : VsOut;
            out.pos = vec4f(positions[i], 0.0, 1.0);
            out.uv  = uvs[i];
            return out;
          }
          @group(0) @binding(0) var samp : sampler;
          @group(0) @binding(1) var tex  : texture_2d<f32>;
          @fragment
          fn fs(in : VsOut) -> @location(0) vec4f {
            let c = textureSample(tex, samp, in.uv);
            return vec4f(1.0 - c.rgb, c.a);
          }
        `,
      });
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        ],
      });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const pipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: "vs" },
        fragment: {
          module, entryPoint: "fs",
          targets: [{ format: "bgra8unorm" }],
        },
        primitive: { topology: "triangle-strip" },
      });
      const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

      let renderCount = 0;
      return {
        onSurfaceMatched: (info) => {
          sdk.log(`intercept-invert-worker: matched ${info.surfaceId} appId=${info.appId}`);
        },
        onSurfaceUnmatched: (info) => {
          sdk.log(`intercept-invert-worker: unmatched ${info.surfaceId}`);
        },
        render: (args) => {
          renderCount += 1;
          if (config?.failEvery && renderCount % config.failEvery === 0) {
            throw new Error(`worker fixture: scheduled fail at render ${renderCount}`);
          }
          const { input, output } = args;
          const inputView = input.texture.createView();
          const outputView = output.texture.createView();
          const bg = device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: sampler },
              { binding: 1, resource: inputView },
            ],
          });
          const enc = device.createCommandEncoder();
          const pass = enc.beginRenderPass({
            colorAttachments: [{
              view: outputView,
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            }],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bg);
          pass.draw(4);
          pass.end();
          device.queue.submit([enc.finish()]);
        },
        destroy: () => { sdk.log("intercept-invert-worker: destroyed"); },
      };
    },
  };

  await sdk.intercept.register(spec);
  sdk.log("intercept-invert-worker: registered");
}
