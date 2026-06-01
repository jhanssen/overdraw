// Fixture: a decoration provider that actually DRAWS. On assignment it reserves a
// top inset, creates a surface at the granted outerRect, clears it to a solid
// color, and presents. The GPU test pixel-checks the decoration composites in the
// inset band above the window content.
export default async function init(sdk) {
  await sdk.decorations.register("^org\\.test\\.deco$");
  sdk.decorations.onAssigned(async (ev) => {
    try {
      // One call: reserve additive insets + create the decoration surface at the
      // outer rect, on the `below` layer (opaque content draws over it -- only the
      // inset border band shows). Its first present releases the gated content.
      const surf = await sdk.decorations.createDecoration(ev.surfaceId,
        { insets: { top: 24, right: 0, bottom: 0, left: 0 }, layer: "below" });
      const dev = sdk.gpu.device;
      const tex = surf.getCurrentTexture();
      const enc = dev.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: tex.createView(),
          loadOp: "clear", storeOp: "store",
          clearValue: { r: 0.0, g: 0.2, b: 0.9, a: 1.0 },  // solid blue titlebar
        }],
      });
      pass.end();
      dev.queue.submit([enc.finish()]);
      await surf.present();
      sdk.log("decorated " + JSON.stringify(surf.rect));
    } catch (e) {
      sdk.log("deco_err " + String(e && e.message ? e.message : e));
    }
  });
  sdk.log("registered");
}
