// Fixture: a plugin that observes window-state events. On each onMap/onUnmap it
// logs the payload as JSON so the test (which sees logs via onEvent) can assert
// the core -> plugin window event channel delivered the right data.
export default async function init(sdk) {
  sdk.log("ready");
  sdk.windows.onMap((ev) => { sdk.log("MAP " + JSON.stringify(ev)); });
  sdk.windows.onUnmap((ev) => { sdk.log("UNMAP " + JSON.stringify(ev)); });
  sdk.windows.onChange((ev) => { sdk.log("CHANGE " + JSON.stringify(ev)); });
}
