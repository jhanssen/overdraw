// Fixture: a plugin that registers in the 'calc' namespace and exposes a few
// arithmetic methods. Logs every invocation so the test can verify the
// method actually ran in this worker.
//
// Plugin behavior is parameterized by the `name` so the same fixture can act
// as multiple competing registrations at different priorities (the test
// supplies the priority via PluginConfig.raw.priority -- bootstrap reads it
// from workerData if present).
export default async function init(sdk) {
  // The test can pass a priority via the workerData (we don't have a clean
  // SDK path to it yet); fall back to undefined to let the runtime apply its
  // default (100 for user plugins).
  const opts = process.env.NS_PRIORITY
    ? { priority: parseInt(process.env.NS_PRIORITY, 10) }
    : undefined;

  await sdk.registerPlugin("calc", async () => ({
    add: (a, b) => {
      sdk.log(`add(${a},${b}) on ${sdk.name}`);
      return a + b;
    },
    mul: (a, b) => {
      sdk.log(`mul(${a},${b}) on ${sdk.name}`);
      return a * b;
    },
    // A method that returns a Promise (the runtime should await it).
    async sleepAdd(a, b, ms) {
      sdk.log(`sleepAdd(${a},${b},${ms}) on ${sdk.name}`);
      await new Promise((r) => setTimeout(r, ms));
      return a + b;
    },
    // A method that throws; the invoke promise should reject with the message.
    boom() {
      sdk.log(`boom() on ${sdk.name}`);
      throw new Error("boom from " + sdk.name);
    },
  }), opts);

  sdk.log("ready");
}
