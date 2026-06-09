// Fixture: a plugin that registers interceptors via sdk.events.intercept and
// logs / modifies / defers per the test's needs. Exercises the cross-process
// intercept-handle request path between core and the worker.

export default async function init(sdk) {
  // Modify path: bump the 'n' field.
  const sub1 = sdk.events.intercept("bump", (name, payload) => {
    sdk.log("BUMP " + JSON.stringify(payload));
    return { n: payload.n + 1 };
  });

  // Observe-only: log but do not modify.
  const sub2 = sdk.events.intercept("observe", (name, payload) => {
    sdk.log("OBSERVE " + JSON.stringify(payload));
    // implicit undefined return
  });

  // Defer path: async handler does work, then returns the new payload.
  const sub3 = sdk.events.intercept("defer", async (name, payload) => {
    await new Promise((r) => setTimeout(r, 10));
    sdk.log("DEFER " + JSON.stringify(payload));
    return { ...payload, deferred: true };
  });

  // Priority: this one runs second despite registering before its peer below.
  const sub4 = sdk.events.intercept("priority", (name, payload) => {
    sdk.log("P-HI " + JSON.stringify(payload));
    return { ...payload, order: [...(payload.order ?? []), "hi"] };
  }, { priority: 10 });
  const sub5 = sdk.events.intercept("priority", (name, payload) => {
    sdk.log("P-LO " + JSON.stringify(payload));
    return { ...payload, order: [...(payload.order ?? []), "lo"] };
  }, { priority: 0 });

  // Off-ramp: a window.map with surfaceId 50 triggers unregister of sub1.
  sdk.windows.onMap((ev) => {
    if (ev.surfaceId === 50) { sub1.off(); sdk.log("UNREG-BUMP"); }
    void sub2; void sub3; void sub4; void sub5;
  });

  sdk.log("ready");
}
