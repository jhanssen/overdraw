// Fixture: onShutdown that never resolves, to exercise the graceful-shutdown
// timeout (the core terminates after shutdownTimeoutMs regardless).
export default async function init(sdk) {
  sdk.onShutdown(() => new Promise(() => { /* never resolves */ }));
}
