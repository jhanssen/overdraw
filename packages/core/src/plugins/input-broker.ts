// Input broker: services plugin-side sdk.input.* requests by routing into
// the seat's BindingChain. Owns the binding-id mapping (per-plugin: id ->
// chain registration) so the chain can fire `input.binding-fired` events
// back to the originating plugin's endpoint when a binding matches.
//
// Hooks into main.ts's onRequest chain (and the harness's). Pure JS; no
// GPU.

import type { CompositorState } from "../protocols/ctx.js";
import type { InputStep } from "../input/keyspec.js";

// One-way emit-to-plugin shape the runtime exposes. Used to deliver
// 'input.binding-fired' to the plugin that registered the binding.
export type EmitToPlugin = (pluginName: string, name: string, data: unknown) => void;

export interface InputBrokerDeps {
  state: CompositorState;
  emitToPlugin: EmitToPlugin;
}

export const NOT_HANDLED = Symbol("input-broker:not-handled");

export type InputBroker = (
  pluginName: string, method: string, params: unknown,
) => unknown | typeof NOT_HANDLED;

export function createInputBroker(deps: InputBrokerDeps): InputBroker {
  const { state, emitToPlugin } = deps;

  // Per-plugin registration tables. Each plugin mints its own binding ids
  // (via input-sdk's nextId counter); the broker maps (pluginName, id) ->
  // chain unbind. On unbind or plugin teardown, we walk the table.
  const bindings = new Map<string, Map<number, { unbind(): void }>>();
  // Per-plugin defined modes; on teardown we undefine them.
  const modes = new Map<string, Map<string, { undefine(): void }>>();

  function pluginBindings(name: string): Map<number, { unbind(): void }> {
    let m = bindings.get(name);
    if (!m) { m = new Map(); bindings.set(name, m); }
    return m;
  }
  function pluginModes(name: string): Map<string, { undefine(): void }> {
    let m = modes.get(name);
    if (!m) { m = new Map(); modes.set(name, m); }
    return m;
  }

  return (pluginName: string, method: string, params: unknown): unknown | typeof NOT_HANDLED => {
    const chain = state.bindingChain;
    if (!chain) return NOT_HANDLED;

    switch (method) {
      case "input.bind": {
        if (!isBindPayload(params)) {
          throw new Error("input.bind: malformed payload");
        }
        const bindSpec: Parameters<typeof chain.bind>[0] = {
          steps: params.steps,
          mode: params.mode ?? "default",
          handler: ({ chord }) => {
            emitToPlugin(pluginName, "input.binding-fired",
              { id: params.id, chord });
          },
        };
        if (params.priority !== undefined) bindSpec.priority = params.priority;
        // Release-capable bindings: the chain fires `release()` when every
        // input held at press time is released. We forward as a separate
        // event ('input.binding-released') so the plugin SDK can dispatch
        // it to a user-supplied release handler.
        if (params.release === true) {
          bindSpec.release = ({ chord }) => {
            emitToPlugin(pluginName, "input.binding-released",
              { id: params.id, chord });
          };
        }
        const handle = chain.bind(bindSpec);
        pluginBindings(pluginName).set(params.id, handle);
        return null;
      }
      case "input.unbind": {
        if (!isUnbindPayload(params)) {
          throw new Error("input.unbind: malformed payload");
        }
        const m = pluginBindings(pluginName);
        const handle = m.get(params.id);
        if (handle) { handle.unbind(); m.delete(params.id); }
        return null;
      }
      case "input.define-mode": {
        if (!isDefineModePayload(params)) {
          throw new Error("input.define-mode: malformed payload");
        }
        const handle = chain.defineMode(params.name,
          params.exitOnEscape !== undefined ? { exitOnEscape: params.exitOnEscape } : undefined);
        pluginModes(pluginName).set(params.name, handle);
        return null;
      }
      case "input.undefine-mode": {
        if (!isUndefineModePayload(params)) {
          throw new Error("input.undefine-mode: malformed payload");
        }
        const m = pluginModes(pluginName);
        const handle = m.get(params.name);
        if (handle) { handle.undefine(); m.delete(params.name); }
        return null;
      }
      case "input.push-mode": {
        if (!isPushModePayload(params)) {
          throw new Error("input.push-mode: malformed payload");
        }
        chain.pushMode(params.name);
        return null;
      }
      case "input.pop-mode": {
        chain.popMode();
        return null;
      }
      default:
        return NOT_HANDLED;
    }
  };
}

// ---- Payload guards -------------------------------------------------------

function isStep(v: unknown): v is InputStep {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { [k: string]: unknown };
  if (typeof o.mods !== "number") return false;
  if (o.kind === "button") return typeof o.button === "number";
  // Default ('key' or absent kind): needs a keysym.
  if (o.kind === undefined || o.kind === "key") return typeof o.keysym === "number";
  return false;
}

function isBindPayload(d: unknown): d is {
  id: number; steps: InputStep[]; mode?: string; priority?: number; release?: boolean;
} {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.id !== "number") return false;
  if (!Array.isArray(o.steps) || o.steps.length === 0) return false;
  for (const s of o.steps) if (!isStep(s)) return false;
  if (o.mode !== undefined && typeof o.mode !== "string") return false;
  if (o.priority !== undefined && typeof o.priority !== "number") return false;
  if (o.release !== undefined && typeof o.release !== "boolean") return false;
  return true;
}

function isUnbindPayload(d: unknown): d is { id: number } {
  if (typeof d !== "object" || d === null) return false;
  return typeof (d as { id?: unknown }).id === "number";
}

function isDefineModePayload(d: unknown): d is { name: string; exitOnEscape?: boolean } {
  if (typeof d !== "object" || d === null) return false;
  const o = d as { [k: string]: unknown };
  if (typeof o.name !== "string" || o.name.length === 0) return false;
  if (o.exitOnEscape !== undefined && typeof o.exitOnEscape !== "boolean") return false;
  return true;
}

function isUndefineModePayload(d: unknown): d is { name: string } {
  if (typeof d !== "object" || d === null) return false;
  return typeof (d as { name?: unknown }).name === "string";
}

function isPushModePayload(d: unknown): d is { name: string } {
  return isUndefineModePayload(d);
}
