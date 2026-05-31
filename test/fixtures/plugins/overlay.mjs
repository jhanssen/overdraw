// Fixture plugin: creates an overlay and renders a solid color into it, then
// presents. Exercises the full C-M4 path (Worker device -> shared surface ->
// fence -> core composites the overlay). The color + geometry are fixed so the
// test can pixel-verify the composited frame.
export default async function init(sdk) {
  sdk.log("overlay plugin init");
  const surface = await sdk.gpu.createOverlay({
    layer: "overlay", anchor: "top-left", width: 64, height: 64,
  });
  const dev = sdk.gpu.device;
  const tex = surface.getCurrentTexture();
  const enc = dev.createCommandEncoder();
  enc.beginRenderPass({
    colorAttachments: [{
      view: tex.createView(), loadOp: "clear", storeOp: "store",
      // BGRA8 dmabuf; clearValue is RGBA -> a distinctive green.
      clearValue: { r: 0.0, g: 0.8, b: 0.2, a: 1.0 },
    }],
  }).end();
  dev.queue.submit([enc.finish()]);
  await surface.present();
  sdk.log("overlay plugin presented");
}
