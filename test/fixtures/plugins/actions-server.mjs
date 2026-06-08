// Fixture: a plugin that registers a few actions and logs each invocation.
// The test calls them via the client fixture (which uses sdk.actions.invoke)
// or via the runtime's direct interface.
export default async function init(sdk) {
  await sdk.actions.register({
    name: "math.add",
    description: "Add two numbers",
    schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    handler: ({ a, b }) => {
      sdk.log(`math.add(${a},${b})`);
      return a + b;
    },
  });

  await sdk.actions.register({
    name: "math.mul",
    handler: ({ a, b }) => {
      sdk.log(`math.mul(${a},${b})`);
      return a * b;
    },
  });

  await sdk.actions.register({
    name: "throws",
    handler: () => {
      sdk.log(`throws-handler-invoked`);
      throw new Error("intentional");
    },
  });

  await sdk.actions.register({
    name: "async.action",
    handler: async ({ delay }) => {
      sdk.log(`async.action(${delay})`);
      await new Promise((r) => setTimeout(r, delay));
      return "done";
    },
  });

  sdk.log("ready");
}
