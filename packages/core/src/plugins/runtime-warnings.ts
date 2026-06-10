// Loud-not-silent warnings for runtime-misconfiguration cases (plugin SDK
// call hits a missing bus / broker / etc.). Bypasses any user-provided log
// hook so test harnesses that silence routine logs still see the warning.
// Tests that deliberately exercise no-bus paths can stub console.error.

export function warnRuntimeMisconfig(
  pluginName: string, method: string, effect: string,
): void {
  console.error(
    `[overdraw] plugin '${pluginName}' called ${method} but runtime has no bus; ` +
    `${effect}. This usually means the test harness / launcher did not wire ` +
    `PluginRuntime({ bus }). See packages/core/src/main.ts for the production ` +
    `wiring.`);
}
