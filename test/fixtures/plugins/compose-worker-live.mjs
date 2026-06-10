// Fixture plugin (Worker): exercises sdk.compose.scene LIVE mode
// cross-device (phase 5b-live, ring-based). Loads after a client maps,
// registers a live compose, samples the texture twice with a delay between,
// logs the center pixel each time. The test mutates compositor state
// between the two samples; the second log line should differ from the first.

const W = 256, H = 256;
const CENTER_X = 128, CENTER_Y = 128;
const FIRST_SAMPLE_MS = 150;
const SECOND_SAMPLE_MS = 1500;  // generous delay so test has plenty of time
                                // to mutate state + drive renderFrames

export default async function init(sdk) {
  sdk.log("compose-worker-live init");

  // Find the first mapped window.
  let targetWindowId = -1;
  const existing = await sdk.windows.list();
  if (existing.length > 0) {
    targetWindowId = existing[0].surfaceId;
  } else {
    await new Promise((resolve) => {
      sdk.windows.onMap((w) => {
        if (targetWindowId !== -1) return;
        targetWindowId = w.surfaceId;
        resolve();
      });
    });
  }
  sdk.log(`compose-worker-live target ${targetWindowId}`);

  // Wait for first frame to commit so the dmabuf has client pixels to compose.
  await new Promise((r) => setTimeout(r, 300));

  // Register a live compose. The texture handle is stable; sample(cb) is
  // the only valid way to read it.
  const live = await sdk.compose.scene({
    outputId: 0, mode: "live",
    windows: [targetWindowId], outW: W, outH: H,
  });
  sdk.log(`compose-worker-live registered`);

  const dev = sdk.gpu.device;
  const unpadded = W * 4;
  const padded = Math.ceil(unpadded / 256) * 256;
  const buf = dev.createBuffer({
    size: padded * H,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  async function readCenterPixel(label) {
    return live.sample(async (tex) => {
      const enc = dev.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: tex },
        { buffer: buf, bytesPerRow: padded, rowsPerImage: H },
        { width: W, height: H },
      );
      dev.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buf.getMappedRange());
      const off = CENTER_Y * padded + CENTER_X * 4;
      const b = mapped[off], g = mapped[off + 1], r = mapped[off + 2], a = mapped[off + 3];
      sdk.log(`compose-worker-live ${label} pixel BGRA=${b},${g},${r},${a}`);
      buf.unmap();
    });
  }

  await new Promise((r) => setTimeout(r, FIRST_SAMPLE_MS));
  await readCenterPixel("sample1");

  await new Promise((r) => setTimeout(r, SECOND_SAMPLE_MS - FIRST_SAMPLE_MS));
  await readCenterPixel("sample2");

  buf.destroy();
  await live.release();
  sdk.log("compose-worker-live released");
}
