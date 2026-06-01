// Fixture: a decoration-provider plugin. Registers an app_id pattern and logs each
// decoration.assigned event as JSON, so the test (which sees logs via onEvent) can
// assert the register -> match -> assigned wire-through.
export default async function init(sdk) {
  await sdk.decorations.register("^org\\.test\\.deco$");
  sdk.decorations.onAssigned((ev) => { sdk.log("ASSIGNED " + JSON.stringify(ev)); });
  sdk.log("registered");
}
