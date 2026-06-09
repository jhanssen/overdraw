// Fixture plugin (Worker): exercises sdk.compose.scene cross-device
// (phase 5b snapshot). Waits for the first window to map, calls
// sdk.compose.scene({mode:'snapshot'}) -- which allocates a dmabuf shared
// between core (producer) and plugin (consumer), has core render the
// window into it, and returns a GPUTexture on the plugin device. Reads
// back the center pixel via copyTextureToBuffer + mapAsync and logs the
// result; the test parses + verifies.

const W = 256, H = 256;
const CENTER_X = 128, CENTER_Y = 128;

export default async function init(sdk) {
  sdk.log("compose-worker init");

  // Find the first mapped window. Check existing first (list); if empty,
  // wait for an onMap. The test ensures the client maps BEFORE loading
  // this plugin so the window exists.
  let targetWindowId = -1;
  const existing = await sdk.windows.list();
  if (existing.length > 0) {
    targetWindowId = existing[0].surfaceId;
    sdk.log(`compose-worker found existing window ${targetWindowId}`);
  } else {
    await new Promise((resolve) => {
      sdk.windows.onMap((w) => {
        if (targetWindowId !== -1) return;
        targetWindowId = w.surfaceId;
        sdk.log(`compose-worker matched window ${targetWindowId}`);
        resolve();
      });
    });
  }

  // Give the client a moment to commit its first frame (the compositor's
  // surface state needs to be present for compose to sample anything).
  await new Promise((r) => setTimeout(r, 300));

  // Snapshot the scene with that window.
  sdk.log(`compose-worker calling compose.scene snapshot for ${targetWindowId}`);
  const snap = await sdk.compose.scene({
    outputId: 0, mode: "snapshot",
    windows: [targetWindowId], outW: W, outH: H,
  });
  sdk.log(`compose-worker got snapshot: outW=${snap.outW} outH=${snap.outH}`);

  // Read back the center pixel. copyTextureToBuffer requires bytesPerRow
  // a multiple of 256.
  const dev = sdk.gpu.device;
  const unpadded = W * 4;
  const padded = Math.ceil(unpadded / 256) * 256;
  const buf = dev.createBuffer({
    size: padded * H,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc = dev.createCommandEncoder();
  enc.copyTextureToBuffer(
    { texture: snap.texture },
    { buffer: buf, bytesPerRow: padded, rowsPerImage: H },
    { width: W, height: H },
  );
  dev.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(buf.getMappedRange());
  const off = CENTER_Y * padded + CENTER_X * 4;
  const b = mapped[off], g = mapped[off + 1], r = mapped[off + 2], a = mapped[off + 3];
  sdk.log(`compose-worker center pixel BGRA=${b},${g},${r},${a}`);
  buf.unmap();
  buf.destroy();

  // Release the snapshot.
  await snap.release();
  sdk.log("compose-worker released");
}
