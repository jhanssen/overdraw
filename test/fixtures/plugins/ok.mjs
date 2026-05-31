// Fixture: a well-behaved plugin. init resolves; stays live (event loop keeps
// turning so the watchdog is satisfied); records onShutdown.
export default async function init(sdk) {
  sdk.log("ok plugin init", sdk.name);
  sdk.onShutdown(() => { sdk.log("ok plugin shutdown"); });
}
