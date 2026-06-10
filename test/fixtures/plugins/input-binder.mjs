// Fixture (Worker plugin): registers a key binding and a sub-mode via
// sdk.input.bind / sdk.input.defineMode, logs each binding fire. The
// test fixture proves the input SDK works across the Worker transport
// (not just in-thread bundled plugins), which is the whole point of
// not deferring Worker support.

export default async function init(sdk) {
  await sdk.input.defineMode("worker-mode");

  await sdk.input.bind({
    keys: "Mod+w",
    handler: () => {
      sdk.log("fired: Mod+w");
    },
  });

  await sdk.input.bind({
    keys: ["Mod+a", "Mod+b"],
    handler: () => {
      sdk.log("fired: Mod+a, Mod+b");
    },
  });

  await sdk.input.bind({
    keys: "Mod+r",
    handler: () => {
      sdk.input.pushMode("worker-mode");
      sdk.log("fired: Mod+r -> pushMode(worker-mode)");
    },
  });

  await sdk.input.bind({
    keys: "Return",
    mode: "worker-mode",
    handler: () => {
      sdk.input.popMode();
      sdk.log("fired: Return -> popMode");
    },
  });

  sdk.log("ready");
}
