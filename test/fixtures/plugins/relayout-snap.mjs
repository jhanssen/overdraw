// Fixture: intercepts window.relayout and snaps the surface's new outer to
// a fixed test rect so the integration test can confirm interception ran
// end-to-end through the live wire.

export default async function init(sdk, config) {
  const snapRect = config?.snapRect ?? { x: 100, y: 50, width: 200, height: 150 };
  const targetSurfaceId = config?.targetSurfaceId;

  sdk.events.intercept("window.relayout", (name, payload) => {
    if (targetSurfaceId !== undefined && payload.surfaceId !== targetSurfaceId) {
      return undefined;
    }
    sdk.log("INTERCEPT " + JSON.stringify({
      surfaceId: payload.surfaceId,
      oldOuter: payload.oldOuter,
      newOuter: payload.newOuter,
    }));
    return { ...payload, newOuter: snapRect };
  });
  sdk.log("ready");
}
