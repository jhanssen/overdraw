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

import type { PluginSdkShape } from "@overdraw/plugin-sdk-types";

export default async function init(sdk: PluginSdkShape): Promise<void> {
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

  // Move the focused window to a specific output. The launcher resolves the
  // focus + the target output's shown workspace and applies the move
  // (workspace plugin's moveWindow). The new window's rect comes from the
  // target output's tile region via relayout.
  sdk.actions.register({
    name: "window.move-to-output",
    description: "Move the keyboard-focused window to the workspace currently " +
      "shown on the given output. Params: { output: string } -- a connector " +
      "name ('DP-1') or EDID id. The launcher resolves it against the live " +
      "output set; an unknown name is a silent no-op.",
    handler: async (params: unknown): Promise<null> => {
      if (typeof params !== "object" || params === null
          || typeof (params as { output?: unknown }).output !== "string") {
        throw new TypeError("window.move-to-output: expected { output: string }");
      }
      sdk.events.emit("window.move-to-output-requested",
        { output: (params as { output: string }).output });
      return null;
    },
  });

  // Cycle the focused window to the next / previous output by ascending id
  // (wraps). Convenience for the common Mod+Shift+arrow-key hotkey bind;
  // resolves the target outputId from the live output set.
  sdk.actions.register({
    name: "window.move-to-next-output",
    description: "Move the keyboard-focused window to the next output by id " +
      "(wraps). No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("window.move-to-output-cycle-requested", { dir: "next" });
      return null;
    },
  });

  sdk.actions.register({
    name: "window.move-to-prev-output",
    description: "Move the keyboard-focused window to the previous output by id " +
      "(wraps). No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("window.move-to-output-cycle-requested", { dir: "prev" });
      return null;
    },
  });

  // Keyboard focus navigation. Cycles the keyboard focus through the WM's
  // toplevel stack (wrapping at the ends). The launcher resolves the current
  // focus + the stack order and applies the new focus; plugin context has
  // neither the seat nor the WM.
  sdk.actions.register({
    name: "focus.next",
    description: "Move keyboard focus to the next toplevel in the stack " +
      "(wraps). No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("focus.cycle-requested", { direction: "next" });
      return null;
    },
  });

  sdk.actions.register({
    name: "focus.prev",
    description: "Move keyboard focus to the previous toplevel in the stack " +
      "(wraps). No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("focus.cycle-requested", { direction: "prev" });
      return null;
    },
  });

  // Layout manipulation. Reorders the focused window within the WM's stack
  // (promote to master / swap with a neighbour) and relayouts. The launcher
  // resolves focus + performs the reorder.
  sdk.actions.register({
    name: "layout.promote",
    description: "Move the keyboard-focused window to the master slot " +
      "(front of the stack). No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("layout.reorder-requested", { op: "promote" });
      return null;
    },
  });

  sdk.actions.register({
    name: "layout.swap-next",
    description: "Swap the keyboard-focused window with the next toplevel in " +
      "the stack. No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("layout.reorder-requested", { op: "swap-next" });
      return null;
    },
  });

  sdk.actions.register({
    name: "layout.swap-prev",
    description: "Swap the keyboard-focused window with the previous toplevel " +
      "in the stack. No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("layout.reorder-requested", { op: "swap-prev" });
      return null;
    },
  });

  // Master-fraction tuning. The active layout plugin owns the parameter; the
  // launcher routes the relative delta to it and relayouts. No-op if the
  // active layout doesn't implement setParams.
  sdk.actions.register({
    name: "layout.grow-master",
    description: "Grow the master column by one step. No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("layout.master-fraction-requested", { delta: MASTER_STEP });
      return null;
    },
  });

  sdk.actions.register({
    name: "layout.shrink-master",
    description: "Shrink the master column by one step. No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("layout.master-fraction-requested", { delta: -MASTER_STEP });
      return null;
    },
  });

  // Gap tuning. Same shape as the master-fraction actions: the launcher
  // forwards the delta to the active layout plugin's setParams. No-op if
  // the active layout doesn't implement setParams or doesn't recognize
  // the gapDelta field.
  sdk.actions.register({
    name: "layout.grow-gap",
    description: "Grow the inter-tile gap by one step (px). No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("layout.gap-requested", { delta: GAP_STEP });
      return null;
    },
  });

  sdk.actions.register({
    name: "layout.shrink-gap",
    description: "Shrink the inter-tile gap by one step (px). " +
      "Clamps to 0 at the bottom. No params.",
    handler: async (): Promise<null> => {
      sdk.events.emit("layout.gap-requested", { delta: -GAP_STEP });
      return null;
    },
  });

  // KMS mode switch on one output. Params:
  //   { output: "DP-1" | "ACM-1234-...", width: 2560, height: 1440,
  //     refreshMhz?: 60000 }
  // `output` matches either the durable EDID id or the connector name --
  // same precedence the workspace plugin uses. `refreshMhz` is mHz
  // (Hz * 1000); when omitted the launcher picks any matching mode at the
  // requested dims. Emits 'output.switch-mode-requested' on the bus; the
  // launcher subscribes and calls addon.switchOutputMode after resolving
  // the durable id to a live dense outputId.
  sdk.actions.register({
    name: "output.switch-mode",
    description: "Switch a KMS-connected output to a new mode. Params: " +
      "{ output: string (durable id or connector name), width: int, " +
      "height: int, refreshMhz?: int (mHz; omit to match any refresh) }. " +
      "Both width and height must match a mode the connector advertises " +
      "(no custom-mode validation). Asynchronous; the next output.changed " +
      "event reflects the new mode.",
    handler: async (params: unknown): Promise<null> => {
      const p = (params ?? {}) as {
        output?: unknown; width?: unknown; height?: unknown; refreshMhz?: unknown;
      };
      if (typeof p.output !== "string" || p.output.length === 0) {
        throw new TypeError("output.switch-mode: params.output must be a non-empty string");
      }
      if (!Number.isInteger(p.width) || (p.width as number) <= 0) {
        throw new TypeError("output.switch-mode: params.width must be a positive integer");
      }
      if (!Number.isInteger(p.height) || (p.height as number) <= 0) {
        throw new TypeError("output.switch-mode: params.height must be a positive integer");
      }
      if (p.refreshMhz !== undefined
          && (!Number.isInteger(p.refreshMhz) || (p.refreshMhz as number) <= 0)) {
        throw new TypeError(
          "output.switch-mode: params.refreshMhz must be a positive integer (mHz)");
      }
      sdk.events.emit("output.switch-mode-requested", {
        output: p.output,
        width: p.width as number,
        height: p.height as number,
        refreshMhz: p.refreshMhz === undefined ? 0 : (p.refreshMhz as number),
      });
      return null;
    },
  });

  sdk.actions.register({
    name: "xwayland.restart",
    description: "Restart the Xwayland stack (Xwayland process + X window " +
      "manager + selection bridge) without restarting the compositor. Any " +
      "running X11 clients are killed. No-op when Xwayland is disabled in " +
      "config. Emits 'xwayland.restart-requested'; the launcher tears down " +
      "and respawns.",
    handler: async (): Promise<null> => {
      sdk.events.emit("xwayland.restart-requested", {});
      return null;
    },
  });

  sdk.log("core-actions registered");
}

// Per-command master-fraction increment for layout.grow-master / shrink-master.
const MASTER_STEP = 0.05;

// Per-command gap increment for layout.grow-gap / shrink-gap (logical px).
const GAP_STEP = 4;

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
