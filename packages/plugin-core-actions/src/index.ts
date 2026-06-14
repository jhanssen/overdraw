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

  // Launch a process, detached, connected to this compositor. The actual
  // spawn runs in the launcher (it has child_process + the WAYLAND_DISPLAY
  // name); plugin context has neither, so this emits a bus event.
  sdk.actions.register({
    name: "spawn",
    description: "Launch a process detached, with WAYLAND_DISPLAY pointing at " +
      "this compositor. Params: { command: string, args?: string[] }.",
    handler: async (params: unknown): Promise<null> => {
      const p = (params ?? {}) as { command?: unknown; args?: unknown };
      if (typeof p.command !== "string" || p.command.length === 0) {
        sdk.log("spawn: params.command must be a non-empty string");
        return null;
      }
      const args = Array.isArray(p.args)
        ? p.args.filter((a): a is string => typeof a === "string") : [];
      sdk.events.emit("process.spawn-requested", { command: p.command, args });
      return null;
    },
  });

  // Interactive move/resize/end-grab. These emit bus events; the launcher
  // subscribes and calls into state.seat.beginGrab / endGrab. (The action
  // handler runs in plugin context which doesn't have direct access to the
  // seat; the bus is the integration seam.)
  sdk.actions.register({
    name: "window.begin-move",
    description: "Start an interactive move grab for the given surface. " +
      "Params: { surfaceId: number }. Typically bound on the press half " +
      "of a hotkey with releaseAction: 'window.end-grab'.",
    handler: async (params: unknown): Promise<null> => {
      const surfaceId = readSurfaceId(params, "window.begin-move");
      sdk.events.emit("window.grab-requested",
        { kind: "move", surfaceId });
      return null;
    },
  });

  sdk.actions.register({
    name: "window.begin-resize",
    description: "Start an interactive resize grab for the given surface. " +
      "Params: { surfaceId: number, edges?: ResizeEdges }. `edges` " +
      "defaults to 'bottom-right'.",
    handler: async (params: unknown): Promise<null> => {
      const surfaceId = readSurfaceId(params, "window.begin-resize");
      const edges = readEdges(params);
      sdk.events.emit("window.grab-requested",
        { kind: "resize", surfaceId, edges });
      return null;
    },
  });

  sdk.actions.register({
    name: "window.end-grab",
    description: "End any active interactive move/resize grab. Idempotent.",
    handler: async (): Promise<null> => {
      sdk.events.emit("window.grab-end-requested", {});
      return null;
    },
  });

  // Ask the keyboard-focused toplevel to close (xdg_toplevel.close -- the
  // client decides what to do). The launcher resolves focus + sends the
  // event; plugin context has neither the seat nor the event senders.
  sdk.actions.register({
    name: "window.close",
    description: "Request the keyboard-focused toplevel to close " +
      "(sends xdg_toplevel.close; the client decides). No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("window.close-requested", {});
      return null;
    },
  });

  sdk.log("core-actions registered");
}

const EDGES = [
  "top", "bottom", "left", "right",
  "top-left", "top-right", "bottom-left", "bottom-right",
] as const;
type Edges = (typeof EDGES)[number];

function readSurfaceId(params: unknown, ctx: string): number {
  if (typeof params !== "object" || params === null) {
    throw new TypeError(`${ctx}: params must be an object`);
  }
  const id = (params as { surfaceId?: unknown }).surfaceId;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new TypeError(`${ctx}: params.surfaceId must be a positive integer`);
  }
  return id;
}

function readEdges(params: unknown): Edges {
  if (typeof params !== "object" || params === null) return "bottom-right";
  const e = (params as { edges?: unknown }).edges;
  if (e === undefined) return "bottom-right";
  if (typeof e !== "string" || !(EDGES as readonly string[]).includes(e)) {
    throw new TypeError(
      `window.begin-resize: edges must be one of ${EDGES.join("|")}`);
  }
  return e as Edges;
}
