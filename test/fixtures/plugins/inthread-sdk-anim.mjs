// Fixture (in-thread bundled): exercises @overdraw/sdk-anim end-to-end.
// The plugin imports the builder API and submits a tween built via
// `tween(target.windowOpacity(...), {...})` through sdk.animations.start;
// the spec flows through the SDK -> broker -> evaluator -> compositor
// exactly the same as a hand-built spec. start() resolving proves the
// registration ack: by the "animation submitted" log the evaluator has
// the leaf active and the `from` value applied.
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
  const started = await sdk.animations.start(spec);
  void started.settled.then(() => sdk.log("animation done"));
  sdk.log("animation submitted");
}
