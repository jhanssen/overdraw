// Bundled plugin: registers the user's OverdrawConfig.actions map as
// core actions. Each entry's handler is a JS function the user wrote
// in their config (a module that runs in the main thread); the plugin
// (also in-thread) holds the function reference and forwards invokes
// through it.
//
// Handlers receive (sdk, params) -- sdk is the bundled plugin's SDK
// reference, so the user can call other actions / push modes / log /
// emit events from inside their custom handler. params is whatever
// the caller passed to sdk.actions.invoke (after deferred-ref
// resolution, so ref.surfaceUnderPointer in the hotkey config is
// already resolved to a number by the time the handler runs).

type UserHandler = (sdk: unknown, params?: unknown) => unknown | Promise<unknown>;

interface ActionRegisterSpec {
  name: string;
  description?: string;
  handler: (params: unknown) => unknown | Promise<unknown>;
}
interface PluginActionsLike {
  register(spec: ActionRegisterSpec): { unregister(): void };
}
interface SdkLike {
  readonly name: string;
  log(...args: unknown[]): void;
  actions: PluginActionsLike;
}

export default async function init(sdk: SdkLike, rawConfig?: unknown): Promise<void> {
  if (rawConfig === undefined || rawConfig === null) {
    // No actions in config; nothing to do.
    return;
  }
  if (typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new TypeError("config.actions must be an object (name -> function)");
  }
  const handlers = rawConfig as { [k: string]: unknown };
  let count = 0;
  for (const [name, value] of Object.entries(handlers)) {
    if (typeof value !== "function") {
      throw new TypeError(
        `config.actions.${name}: expected a function, got ${typeof value}`);
    }
    if (name.length === 0) {
      throw new TypeError("config.actions: action name must be non-empty");
    }
    const userHandler = value as UserHandler;
    sdk.actions.register({
      name,
      description: `user-defined action from config.actions`,
      handler: async (params: unknown) => {
        // Forward to the user's handler with the plugin's SDK as the
        // first arg, so the user can re-invoke other actions / log /
        // emit events from inside the handler.
        return await userHandler(sdk, params);
      },
    });
    count++;
  }
  sdk.log(`registered ${count} user action${count === 1 ? "" : "s"}`);
}
