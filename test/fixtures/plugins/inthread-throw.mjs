// Fixture: an in-thread bundled plugin that throws from init. Used to verify
// the in-thread transport's fatal-init-failure handling: the plugin enters
// 'failed' state, log line surfaces, no respawn happens.
export default async function init(sdk, config) {
  void sdk; void config;
  throw new Error("inthread-throw: deliberate init failure");
}
