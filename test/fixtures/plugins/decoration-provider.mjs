// Fixture: a decoration-provider plugin. Registers an app_id pattern and logs each
// decoration.assigned event as JSON, so the test (which sees logs via onEvent) can
// assert the register -> match -> assigned wire-through.
export default async function init(sdk) {
  await sdk.decorations.register("^org\\.test\\.deco$");
  sdk.decorations.onAssigned(async (ev) => {
    sdk.log("ASSIGNED " + JSON.stringify(ev));
    // Reserve a titlebar inset (additive) and report the granted geometry.
    try {
      const grant = await sdk.decorations.requestInsets(ev.surfaceId,
        { top: 24, right: 0, bottom: 0, left: 0 });
      sdk.log("INSETS " + JSON.stringify(grant));
    } catch (e) {
      sdk.log("INSETS_ERR " + String(e && e.message ? e.message : e));
    }
  });
  sdk.log("registered");
}
