// Fixture plugin: an overlay animated PURELY by surface.onFrame ticks -- no
// timers. Each tick draws the next color in the cycle, presents, and re-arms.
// The test drives the tick source (flip-complete dispatch) and observes the
// composited output advancing one color per tick.
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
  let cycle = 0;
  const renderOnce = async () => {
    const f = frames[cycle++ % frames.length];
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
  };
  const tick = () => {
    surface.onFrame(tick);        // re-arm BEFORE rendering (rAF idiom)
    void renderOnce();
  };
  surface.onFrame(tick);
  // First frame immediately so the surface has content; every subsequent
  // frame is tick-driven.
  await renderOnce();
}
