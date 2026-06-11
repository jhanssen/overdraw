// Fixture (in-thread bundled): exercises sdk.windows.destroyPhantom +
// the window-closing namespace + the window.closing event.
//
// Claims the 'window-closing' namespace (priority 0). On
// window.closing, runs an opacity tween on the phantom from 1 -> 0
// over config.durationMs, then calls destroyPhantom. Logs each
// step so tests can verify ordering.
//
// config:
//   durationMs    -- how long the fade animation runs
//   skipDestroy   -- when true, don't call destroyPhantom (forces
//                    the backstop to fire). For the backstop test.
export default async function init(sdk, config) {
  sdk.log("closing-animation plugin init");

  // Claim the namespace so the closing driver's hasPluginHandler
  // returns true. No methods needed -- just the registration.
  await sdk.registerPlugin("window-closing", () => ({}));
  sdk.log("closing-animation registered namespace");

  // Subscribe to window.closing. Each phantom that arrives gets a
  // fade-out animation; on completion the plugin destroys it.
  sdk.events.subscribe("window.closing", async (_name, payload) => {
    const phantomId = payload.phantomSurfaceId;
    sdk.log(`closing-animation got phantom ${phantomId} for originalSurface=${payload.originalSurfaceId}`);

    // Fade from 1 to 0 over the configured duration.
    await sdk.animations.run({
      type: "tween",
      target: { kind: "window-opacity", windowId: phantomId },
      from: 1,
      to: 0,
      duration: config.durationMs,
    });
    sdk.log(`closing-animation tween done for phantom ${phantomId}`);

    if (config.skipDestroy) {
      sdk.log(`closing-animation skipDestroy: leaving phantom ${phantomId} for backstop`);
      return;
    }
    await sdk.windows.destroyPhantom(phantomId);
    sdk.log(`closing-animation destroyed phantom ${phantomId}`);
  });

  sdk.log("closing-animation ready");
}
