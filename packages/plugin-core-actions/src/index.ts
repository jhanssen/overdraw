// Bundled plugin that registers core-owned actions. Today: just
// compositor.quit, used by hotkey configs binding a quit shortcut and by
// overdrawctl for scripted shutdown.
//
// The action emits 'compositor.shutdown' on the event bus rather than
// calling process.exit directly. main.ts subscribes to that event and runs
// its existing shutdown(signal) path -- gracefully stopping the IPC
// server, the plugin runtime, the Wayland server, and the GPU process in
// the right order. Other launchers (tests, embedded uses) can subscribe to
// the same event and run their own teardown.

interface ActionRegisterSpec {
  name: string;
  description?: string;
  handler: (params: unknown) => unknown | Promise<unknown>;
}
interface PluginActionsLike {
  register(spec: ActionRegisterSpec): { unregister(): void };
}
interface PluginEventsLike {
  emit(name: string, payload: unknown): void;
}
interface SdkLike {
  readonly name: string;
  log(...args: unknown[]): void;
  actions: PluginActionsLike;
  events: PluginEventsLike;
}

export default async function init(sdk: SdkLike): Promise<void> {
  sdk.actions.register({
    name: "compositor.quit",
    description: "Initiate graceful compositor shutdown. " +
      "Emits 'compositor.shutdown' on the event bus; the launcher's handler " +
      "stops the IPC server, plugin runtime, Wayland server, and GPU process.",
    handler: async (): Promise<null> => {
      sdk.events.emit("compositor.shutdown", { reason: "compositor.quit" });
      return null;
    },
  });
  sdk.log("core-actions registered");
}
