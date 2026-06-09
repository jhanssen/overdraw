// Fixture plugin (in-thread bundled): creates an overlay on core's GPUDevice
// via the in-thread sdk.gpu, renders a solid color into it, presents. The test
// verifies (a) sdk.gpu.device is the SAME GPUDevice object the test's
// JsCompositor uses, and (b) the composited frame shows the overlay pixels.
//
// Same plugin source shape as overlay.mjs (Worker path) -- the SDK contract
// (sdk.gpu.device, sdk.gpu.createOverlay, surface.getCurrentTexture/present)
// is identical across transports per customization.md "Two execution paths,
// one SDK". Only the underlying mechanism (no separate device, no wire,
// no cross-device fence) differs.
export default async function init(sdk) {
  sdk.log("inthread overlay plugin init");
  // Stash a marker on the device the test can read back. The test asserts
  // this property is also set on its own core-device handle, proving they
  // are the same JS object.
  Reflect.set(sdk.gpu.device, "__overdraw_test_marker", "inthread");
  const surface = await sdk.gpu.createOverlay({
    layer: "overlay", anchor: "top-left", width: 64, height: 64,
  });
  const dev = sdk.gpu.device;
  const tex = await surface.getCurrentTexture();
  const enc = dev.createCommandEncoder();
  enc.beginRenderPass({
    colorAttachments: [{
      view: tex.createView(), loadOp: "clear", storeOp: "store",
      // BGRA8 target; clearValue interpreted as RGBA -> distinctive green.
      clearValue: { r: 0.0, g: 0.8, b: 0.2, a: 1.0 },
    }],
  }).end();
  dev.queue.submit([enc.finish()]);
  await surface.present();
  sdk.log("inthread overlay plugin presented");
}
