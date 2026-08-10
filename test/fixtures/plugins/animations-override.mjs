// Displacement fixture: claims 'window-animations' at user priority (100),
// displacing the bundled animations plugin's geometry seams. Its handler
// re-emits an observable test event instead of animating.
export default async function init(sdk) {
  await sdk.registerPlugin("window-animations", () => {
    sdk.events.subscribe("layer.resize-announce", (_name, ev) => {
      sdk.events.emit("test.override-saw-announce", { surfaceId: ev.surfaceId });
    });
    return {};
  }, { priority: 100 });
}
