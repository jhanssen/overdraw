// Fixture (in-thread bundled): exercises @overdraw/sdk-anim end-to-end.
// The plugin imports the builder API and submits a tween built via
// `tween(target.windowOpacity(...), {...})`; the spec flows through
// the SDK -> broker -> evaluator -> compositor exactly the same as
// a hand-built spec, demonstrating the builders are zero-runtime over
// the plain object form.
//
// config.surfaceId picks which compositor surface to animate.

import { tween, target, easings } from "@overdraw/sdk-anim";

export default async function init(sdk, config) {
  sdk.log("sdk-anim plugin init");
  const spec = tween(target.windowOpacity(config.surfaceId), {
    from: 1.0,
    to: 0.0,
    duration: config.durationMs,
    easing: easings.linear,
  });
  void sdk.animations.run(spec).then(() => sdk.log("animation done"));
  sdk.log("animation submitted");
}
