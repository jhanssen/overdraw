// Fixture: a plugin that subscribes via sdk.events.subscribe and echoes what it
// receives (as a log line). Also emits an event of its own on init so the test
// can verify the plugin->bus->core path. Exercises the cross-process plumbing
// for core-plugin-api.md §3.
export default async function init(sdk) {
  // Subscribe to two patterns: an exact name and a prefix glob.
  const sub1 = sdk.events.subscribe("foo.exact", (name, payload) => {
    sdk.log("EXACT " + name + " " + JSON.stringify(payload));
  });
  const sub2 = sdk.events.subscribe("bar.*", (name, payload) => {
    sdk.log("PREFIX " + name + " " + JSON.stringify(payload));
  });

  // Emit one event on init so the test can validate plugin->core direction.
  sdk.events.emit("plugin-said-hello", { from: sdk.name });

  // Provide a way for the test to drive an unsubscribe-then-rebind via a
  // window.map signal (re-using an existing core->plugin event without needing
  // any new wiring). The test can verify the unsubscribed pattern no longer
  // fires.
  sdk.window.onMap((ev) => {
    if (ev.surfaceId === 99) { sub1.off(); sdk.log("UNSUB1"); }
    if (ev.surfaceId === 98) { sub2.off(); sdk.log("UNSUB2"); }
  });

  sdk.log("ready");
}
