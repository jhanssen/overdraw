// Fixture plugin: an ANIMATED overlay. Renders a sequence of distinct colors on
// its OWN clock, presenting each -- deliberately timer-paced, so the ring is
// exercised under a producer that ignores compositor pacing (the tick-driven
// producer is overlay-onframe.mjs). The plugin knows nothing about slots/
// fences/brackets -- just getCurrentTexture + submit + present (swapchain-
// shaped). The test OBSERVES the composited output changing across frames (it
// does not gate the plugin); the delay between presents lets the observer
// sample each color.
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
  // its own clock on purpose; the surface.onFrame variant is overlay-onframe.mjs.
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
