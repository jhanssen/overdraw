// Fixture: an in-thread bundled plugin that registers in the 'test-config'
// namespace and exposes its received config via getConfig(). Used by the
// in-thread bootstrap test to verify:
//   (a) bundled plugins load in-thread without spawning a Worker;
//   (b) per-bundled-plugin config (init's second arg) is plumbed verbatim;
//   (c) namespace registration + invocation work over the paired channel.
export default async function init(sdk, config) {
  sdk.log(`init received config: ${JSON.stringify(config)}`);
  await sdk.registerPlugin("test-config", async () => ({
    getConfig: () => config ?? null,
    getName:   () => sdk.name,
  }));
}
