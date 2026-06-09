// Fixture (in-thread bundled): exercises sdk.animations.run end-to-end.
// Runs a tween that fades window-opacity 1 -> 0 over a long duration so
// the test can deterministically tick the evaluator to a midpoint and
// read back the half-attenuated pixel.
//
// config.surfaceId picks which compositor surface to animate; the test
// uploads a red surface at that id and stacks it before loading the
// plugin.
export default async function init(sdk, config) {
  sdk.log("animation plugin init");
  // Fire-and-forget the animation; the test drives the evaluator tick
  // manually via state.beforeRender exposed through the harness.
  void sdk.animations.run({
    type: "tween",
    target: { kind: "window-opacity", windowId: config.surfaceId },
    from: 1.0,
    to: 0.0,
    duration: config.durationMs,
  }).then(() => sdk.log("animation done"));
  sdk.log("animation submitted");
}
