// Fixture plugin: an ANIMATED overlay. Renders a sequence of distinct colors on
// its OWN clock, presenting each. The plugin knows nothing about slots/fences/
// brackets -- just getCurrentTexture + submit + present (swapchain-shaped). The
// test OBSERVES the composited output changing across frames (it does not gate
// the plugin). A small delay between presents paces it so the observer can sample
// each color; a proper sdk.onFrame tick replaces this loop later.
export default async function init(sdk) {
  const surface = await sdk.gpu.createOverlay({
    layer: "overlay", anchor: "top-left", width: 64, height: 64,
  });
  const dev = sdk.gpu.device;
  const frames = [
    { r: 0.0, g: 0.8, b: 0.2 },   // green
    { r: 0.8, g: 0.2, b: 0.0 },   // red
    { r: 0.2, g: 0.2, b: 0.8 },   // blue
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Animate in the BACKGROUND so init resolves immediately (the plugin is "live"
  // and the test observes the changing output concurrently). The plugin drives
  // its own clock; a real plugin would use sdk.onFrame (a later milestone).
  void (async () => {
    for (let cycle = 0; cycle < 30; cycle++) {
      const f = frames[cycle % frames.length];
      const tex = await surface.getCurrentTexture();
      const enc = dev.createCommandEncoder();
      enc.beginRenderPass({
        colorAttachments: [{
          view: tex.createView(), loadOp: "clear", storeOp: "store",
          clearValue: { ...f, a: 1.0 },
        }],
      }).end();
      dev.queue.submit([enc.finish()]);
      await surface.present();
      await sleep(80);
    }
  })();
}
