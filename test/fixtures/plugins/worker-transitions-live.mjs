// Fixture (Worker): exercises sdk.transitions.run on LIVE scenes. The
// plugin captures two live SceneHandles (each backed by a 3-slot dmabuf
// ring) and runs a transition between them. Used by
// test/worker-transitions-live.gpu.mjs to verify the per-frame producer
// Begin/End wire brackets fire on the right slot so Dawn's STM
// validation stays clean across the slot rotation.
//
// config: { windowId, outW, outH, kind, durationMs }
export default async function init(sdk, config) {
  sdk.log("worker-transitions-live init");

  // Wait for the client to commit before compose.scene; same as the
  // snapshot fixture.
  await new Promise((r) => setTimeout(r, 300));

  const fromScene = await sdk.compose.scene({
    outputId: 0, mode: "live",
    windows: [config.windowId], outW: config.outW, outH: config.outH,
  });
  sdk.log(`worker-transitions-live from-scene id=${fromScene.id}`);
  const toScene = await sdk.compose.scene({
    outputId: 0, mode: "live",
    windows: [config.windowId], outW: config.outW, outH: config.outH,
  });
  sdk.log(`worker-transitions-live to-scene id=${toScene.id}`);

  // Give the live producers a couple of frames to populate slots before
  // installing the transition. If we install too early the resolver
  // returns null (no PRESENTED slot) and the on-screen output is
  // opaque-black for the first frames; that's correct but the test
  // would have to wait for actual content frames anyway.
  await new Promise((r) => setTimeout(r, 100));

  void sdk.transitions.run({
    outputId: 0, kind: config.kind, duration: config.durationMs,
    from: fromScene, to: toScene,
  }).then(async () => {
    sdk.log("worker-transitions-live done");
    await fromScene.release();
    await toScene.release();
    sdk.log("worker-transitions-live released");
  }).catch((e) => {
    sdk.log(`worker-transitions-live ERROR: run rejected: ${e.message}`);
  });

  sdk.log("worker-transitions-live submitted");
}
