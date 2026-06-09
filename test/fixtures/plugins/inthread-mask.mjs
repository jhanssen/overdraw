// Fixture (in-thread bundled): exercises sdk.windows.setMask end-to-end. The
// plugin creates an alpha mask texture on core's GPUDevice (sdk.gpu.device),
// then calls sdk.windows.setMask(SURFACE_ID, mask).
//
// SURFACE_ID is fixed by the harness (the test code uploads pixels to that
// id directly and pushes it onto the compositor stack). The plugin learns
// it via its config (init's second arg).
export default async function init(sdk, config) {
  const SURFACE_ID = config.surfaceId;
  const MASK_W = config.maskWidth;
  const MASK_H = config.maskHeight;

  // Build the mask pixels: bottom-right half opaque, top-left transparent
  // (matches the existing setSurfaceMask compositor test pattern).
  const stride = MASK_W * 4;
  const pixels = new Uint8Array(stride * MASK_H);
  for (let y = 0; y < MASK_H; y++) {
    for (let x = 0; x < MASK_W; x++) {
      const i = (y * MASK_W + x) * 4;
      pixels[i] = 0xff; pixels[i + 1] = 0xff; pixels[i + 2] = 0xff;
      pixels[i + 3] = (x + y) > MASK_W ? 0xff : 0x00;
    }
  }

  const tex = sdk.gpu.device.createTexture({
    size: { width: MASK_W, height: MASK_H },
    format: "bgra8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  sdk.gpu.device.queue.writeTexture(
    { texture: tex },
    pixels,
    { bytesPerRow: stride, rowsPerImage: MASK_H },
    { width: MASK_W, height: MASK_H },
  );

  await sdk.windows.setMask(SURFACE_ID, tex);
  sdk.log("mask installed");
}
