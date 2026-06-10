// Worker-side sdk.input surface (core-plugin-api.md §4). The plugin
// registers chord bindings + named modes; core's seat dispatches each
// key-down through the BindingChain. When a binding matches, core fires
// `input.binding-fired { id }` back to the plugin; this dispatcher routes
// to the plugin's local handler table.
//
// The handler is a plugin-side function; it is NEVER sent across the
// transport. The transport carries only the binding's numeric id (minted
// per-plugin) + the matched chord steps (for the event payload).
//
// Plugin -> core (one-way):
//   input.bind             { id, steps[], mode?, priority? }
//   input.unbind           { id }
//   input.define-mode      { name, exitOnEscape? }
//   input.undefine-mode    { name }
//   input.push-mode        { name }
//   input.pop-mode         null
//
// Core -> plugin (one-way):
//   input.binding-fired    { id, chord[] }   // chord is KeyStep[]
//
// Mode push/pop emits no plugin-targeted notification (plugins observe
// 'input.mode-pushed' / '-popped' via sdk.events.subscribe instead).

import type { Endpoint, Json } from "./protocol.js";
import type { KeyStep } from "../input/keyspec.js";
import { parseChord } from "../input/keyspec.js";

export type InputBindingHandler =
  (event: { chord: KeyStep[] }) => void | Promise<void>;

export interface BindOptions {
  // Either a single step ("Mod+a"), a chord ("Mod+a, Mod+b" or
  // ["Mod+a", "Mod+b"]), or pre-parsed KeyStep[].
  keys: string | readonly string[] | readonly KeyStep[];
  // The mode this binding belongs to. Defaults to "default".
  mode?: string;
  // Conflict-tiebreak priority when two plugins bind the same step
  // sequence in the same mode. Higher wins. Not yet meaningful (the
  // chain rejects exact-duplicate bindings outright); reserved.
  priority?: number;
  // Called when the chord matches. Sync or async; the consume decision
  // is made synchronously when the binding matches.
  handler: InputBindingHandler;
}

export interface DefineModeOptions {
  // Default: true. When false, Escape does not pop the mode -- the
  // mode's bindings (or a programmatic popMode) must do it.
  exitOnEscape?: boolean;
}

export interface InputRegistration { unregister(): void }
export interface ModeDefinition { undefine(): void }

export interface PluginInput {
  // Register a chord binding. Resolves with an unregister handle once the
  // chain has accepted the binding. Rejects on conflict (duplicate,
  // prefix-mask) or unknown mode.
  bind(opts: BindOptions): Promise<InputRegistration>;

  // Define a named mode. Resolves with an undefine handle once the chain
  // has the mode. Rejects if 'name' is 'default' or already defined.
  defineMode(name: string, opts?: DefineModeOptions): Promise<ModeDefinition>;

  // Push a defined mode onto the seat's mode stack. Idempotent if 'name'
  // is already at the top. Throws if 'name' is not defined.
  pushMode(name: string): Promise<void>;

  // Pop the top mode. No-op at root (the default mode is never popped).
  popMode(): Promise<void>;
}

export interface InputDispatcher {
  // Returns true when 'name' is an input.* event the dispatcher handled.
  dispatch(name: string, data: unknown): boolean;
}

export interface InputHandle {
  input: PluginInput;
  dispatcher: InputDispatcher;
}

export function createPluginInput(endpoint: Endpoint): InputHandle {
  let nextId = 1;
  const handlers = new Map<number, InputBindingHandler>();

  // bind / defineMode return Promises so the plugin awaits the chain
  // registration before proceeding. The broker validates + registers
  // synchronously inside the request; the await guarantees the binding
  // is present in the chain before subsequent calls (or the plugin's
  // init returning).
  async function bind(opts: BindOptions): Promise<InputRegistration> {
    if (typeof opts !== "object" || opts === null) {
      throw new TypeError("input.bind expects an options object");
    }
    if (typeof opts.handler !== "function") {
      throw new TypeError("input.bind handler must be a function");
    }
    const steps = parseChord(opts.keys);
    const id = nextId++;
    handlers.set(id, opts.handler);
    // KeyStep is { mods: number; keysym: number } -- structurally Json.
    const stepsJson: Json[] = steps.map((s) => ({ mods: s.mods, keysym: s.keysym }));
    const payload: Json = {
      id, steps: stepsJson,
      mode: opts.mode ?? "default",
    };
    if (opts.priority !== undefined) {
      (payload as { [k: string]: Json }).priority = opts.priority;
    }
    try {
      await endpoint.request("input.bind", payload);
    } catch (e) {
      handlers.delete(id);
      throw e;
    }
    return {
      unregister(): void {
        if (!handlers.has(id)) return;
        handlers.delete(id);
        // Unregister fire-and-forget: the plugin doesn't typically await
        // teardown, and a late delivery race is harmless (a binding
        // unregister-after-fire is idempotent).
        endpoint.emit("input.unbind", { id });
      },
    };
  }

  async function defineMode(name: string, opts?: DefineModeOptions): Promise<ModeDefinition> {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("defineMode name must be a non-empty string");
    }
    const payload: Json = { name };
    if (opts?.exitOnEscape !== undefined) {
      (payload as { [k: string]: Json }).exitOnEscape = opts.exitOnEscape;
    }
    await endpoint.request("input.define-mode", payload);
    return {
      undefine(): void { endpoint.emit("input.undefine-mode", { name }); },
    };
  }

  async function pushMode(name: string): Promise<void> {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("pushMode name must be a non-empty string");
    }
    await endpoint.request("input.push-mode", { name });
  }

  async function popMode(): Promise<void> {
    await endpoint.request("input.pop-mode", null);
  }

  const input: PluginInput = { bind, defineMode, pushMode, popMode };

  const dispatcher: InputDispatcher = {
    dispatch(eventName, data): boolean {
      if (eventName !== "input.binding-fired") return false;
      if (!isBindingFiredPayload(data)) return true;   // bad payload; drop
      const handler = handlers.get(data.id);
      if (!handler) return true;                       // late delivery; drop
      try {
        const r = handler({ chord: data.chord });
        if (r && typeof (r as Promise<unknown>).then === "function") {
          (r as Promise<unknown>).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            endpoint.emit("log",
              `[sdk.input] handler for binding ${data.id} failed: ${msg}`);
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        endpoint.emit("log",
          `[sdk.input] handler for binding ${data.id} threw: ${msg}`);
      }
      return true;
    },
  };

  return { input, dispatcher };
}

function isBindingFiredPayload(d: unknown): d is { id: number; chord: KeyStep[] } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  if (!Array.isArray(o.chord)) return false;
  return true;
}
