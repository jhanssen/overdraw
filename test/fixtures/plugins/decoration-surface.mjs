// Fixture: a decoration provider that actually DRAWS and REDRAWS on resize.
// On assignment it reserves a top inset, creates a surface at the granted
// outerRect, clears it to solid blue, and presents. On onResized it destroys
// the old surface and recreates at the new outer rect (the ring is fixed-size
// at alloc, so resize means destroy-old + create-new).
//
// The two-window decoration GPU test pixel-checks both windows show their own
// content (red) after retiling -- which only holds if the redraw-on-resize
// works (the old decoration's outer rect would otherwise overdraw the neighbor).

export default async function init(sdk) {
  await sdk.decorations.register("^org\\.test\\.deco$");
  // Per-window surface handle so we can destroy + recreate on resize.
  const perWindow = new Map();  // windowId -> { surf, insets }

  async function drawDecoration(windowId, insets) {
    // Destroy any previous ring for this window FIRST so its consumer bracket
    // closes + the GPU process frees the dmabuf/STM before we allocate the new
    // ring at the new size.
    const prev = perWindow.get(windowId);
    if (prev) {
      try { await prev.surf.destroy(); } catch (e) {
        sdk.log("destroy_err " + String(e && e.message ? e.message : e));
      }
      perWindow.delete(windowId);
    }
    const surf = await sdk.decorations.createDecoration(windowId,
      { insets, layer: "below" });
    const dev = sdk.gpu.device;
    const tex = await surf.getCurrentTexture();
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
    perWindow.set(windowId, { surf, insets });
    sdk.log("decorated " + JSON.stringify(surf.rect));
  }

  sdk.decorations.onAssigned(async (ev) => {
    try { await drawDecoration(ev.surfaceId, { top: 24, right: 0, bottom: 0, left: 0 }); }
    catch (e) { sdk.log("deco_err " + String(e && e.message ? e.message : e)); }
  });
  sdk.decorations.onResized(async (ev) => {
    try {
      // Redraw at the new outer rect; reuse the previous insets (the broker
      // also passes them, but we keep policy in the plugin).
      const prev = perWindow.get(ev.windowId);
      const insets = prev?.insets ?? ev.insets;
      await drawDecoration(ev.windowId, insets);
    } catch (e) {
      sdk.log("resize_err " + String(e && e.message ? e.message : e));
    }
  });
  sdk.log("registered");
}
