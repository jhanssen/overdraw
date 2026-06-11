// Fixture (Worker): exercises sdk.transitions.run end to end. Captures
// two SceneHandles via sdk.compose.scene snapshot (cross-device dmabuf
// from core), then calls sdk.transitions.run to blend them. Worker
// plugins can't pass a commit function (functions don't cross
// postMessage); we use a then() chain to log completion.
//
// config: { windowId: number, outW: number, outH: number, kind: string,
//           durationMs: number }
export default async function init(sdk, config) {
  sdk.log("worker-transitions init");

  // The test ensures the client maps before loading this plugin, but
  // the client might not have committed its first frame yet. Wait
  // briefly so compose.scene sees content (matches the
  // compose-worker.mjs fixture pattern).
  await new Promise((r) => setTimeout(r, 300));

  // Build two snapshots of the same window. They'll have identical
  // contents (no transition is visible), but that's fine -- the test
  // is verifying the Worker SDK / broker / compositor wiring, not
  // pixel-level kind behavior (covered by the compositor-direct
  // test in step 2).
  const fromScene = await sdk.compose.scene({
    outputId: 0, mode: "snapshot",
    windows: [config.windowId], outW: config.outW, outH: config.outH,
  });
  sdk.log(`worker-transitions from-scene id=${fromScene.id}`);
  const toScene = await sdk.compose.scene({
    outputId: 0, mode: "snapshot",
    windows: [config.windowId], outW: config.outW, outH: config.outH,
  });
  sdk.log(`worker-transitions to-scene id=${toScene.id}`);

  // Reject the commit field (Worker SDK explicitly rejects).
  try {
    await sdk.transitions.run({
      outputId: 0, kind: config.kind, duration: config.durationMs,
      from: fromScene, to: toScene,
      commit: () => {},
    });
    sdk.log("worker-transitions ERROR: commit-rejection did not throw");
  } catch (e) {
    if (e && String(e.message).includes("not supported for Worker plugins")) {
      sdk.log("worker-transitions commit-rejection ok");
    } else {
      sdk.log(`worker-transitions ERROR: unexpected throw: ${e.message}`);
    }
  }

  // Run the real transition (no commit).
  void sdk.transitions.run({
    outputId: 0, kind: config.kind, duration: config.durationMs,
    from: fromScene, to: toScene,
  }).then(async () => {
    sdk.log("worker-transitions done");
    await fromScene.release();
    await toScene.release();
    sdk.log("worker-transitions released");
  }).catch((e) => {
    sdk.log(`worker-transitions ERROR: run rejected: ${e.message}`);
  });

  sdk.log("worker-transitions submitted");
}
