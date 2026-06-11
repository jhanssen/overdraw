// Fixture (in-thread bundled): exercises sdk.transitions.run end to end.
// Creates two SceneHandles from two windows (one per scene), runs a
// crossfade between them, logs progress + completion. The test reads
// the on-screen framebuffer at controlled timestamps to verify the
// transition pass is replacing the on-screen composite while active.
//
// config:
//   fromWindowId, toWindowId  -- surface ids of the two pre-staged windows
//   kind                       -- transition kind name
//   durationMs                 -- transition duration
export default async function init(sdk, config) {
  sdk.log("transitions plugin init");

  // Build two snapshot scenes, one window each. The test stacks each
  // window full-screen before calling compose.scene to capture them.
  const fromScene = await sdk.compose.scene({
    outputId: 0,
    windows: [config.fromWindowId],
    mode: "snapshot",
    outW: config.outW,
    outH: config.outH,
  });
  sdk.log(`from-scene built id=${fromScene.id}`);
  const toScene = await sdk.compose.scene({
    outputId: 0,
    windows: [config.toWindowId],
    mode: "snapshot",
    outW: config.outW,
    outH: config.outH,
  });
  sdk.log(`to-scene built id=${toScene.id}`);

  // Run the transition. commit is declarative: the broker interprets
  // it synchronously inside the completion tick (before the run()
  // Promise resolves) so the very next renderFrame sees the post-
  // transition state. The test uses setOutputStack with [] to verify
  // the data flows through; pixel checks confirm the final state.
  void sdk.transitions.run({
    outputId: 0,
    kind: config.kind,
    duration: config.durationMs,
    from: fromScene,
    to: toScene,
    commit: { setOutputStack: [{ outputId: 0, ids: [] }] },
  }).then(async () => {
    sdk.log("transition done");
    await fromScene.release();
    await toScene.release();
    sdk.log("scenes released");
  });

  sdk.log("transition submitted");
}
