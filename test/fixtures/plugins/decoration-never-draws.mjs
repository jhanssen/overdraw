// Fixture: a BROKEN decoration provider. It registers and is assigned windows but
// NEVER draws (no createDecoration). The core's first-frame timeout must fire:
// deregister the provider, release the gated content (window shown undecorated),
// and notify the plugin via onDeregistered. The test asserts that recovery.
export default async function init(sdk) {
  await sdk.decorations.register("^org\\.test\\.broken$");
  sdk.decorations.onAssigned((ev) => { sdk.log("assigned " + ev.surfaceId); /* never draw */ });
  sdk.decorations.onDeregistered((ev) => { sdk.log("deregistered " + JSON.stringify(ev)); });
  sdk.log("registered");
}
