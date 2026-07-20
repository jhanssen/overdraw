// Fixture: claims a namespace (config.namespace, default 'role') at
// config.priority (undefined -> the runtime's default for the transport).
// The activation callback logs 'activating' then 'activated' and returns a
// probe API; config.throwOnActivate makes activation fail between the two
// logs. config.claimOnEvent defers the claim until the first window.map
// event arrives (exercises post-load dynamic claims).
export default async function init(sdk, config) {
  const ns = config?.namespace ?? "role";
  const opts = typeof config?.priority === "number"
    ? { priority: config.priority }
    : undefined;

  const claim = async () => {
    await sdk.registerPlugin(ns, () => {
      sdk.log("activating");
      if (config?.throwOnActivate) throw new Error("activation boom");
      sdk.log("activated");
      return { who: () => sdk.name };
    }, opts);
    sdk.log("claimed");
  };

  if (config?.claimOnEvent) {
    sdk.events.subscribe("window.map", () => { void claim(); });
  } else {
    await claim();
  }
  sdk.log("ready");
}
