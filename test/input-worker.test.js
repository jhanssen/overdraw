// End-to-end: a Worker plugin uses sdk.input.bind / defineMode / pushMode /
// popMode. The test wires the input broker against a real BindingChain
// and synthesizes key dispatches; the binding handler runs in the
// Worker; assertions read the Worker's log emissions back through the
// runtime.
//
// This is the explicit proof that 7a's input SDK works across the
// Worker transport, not just in-thread bundled plugins.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DynamicBus } from "../packages/core/dist/events/dynamic-bus.js";
import { BindingChain } from "../packages/core/dist/input/binding-chain.js";
import { createInputBroker, NOT_HANDLED as INPUT_NOT_HANDLED }
  from "../packages/core/dist/plugins/input-broker.js";
import { parseSpec } from "../packages/core/dist/input/keyspec.js";
import { entry, withRuntime, waitFor } from "./plugin-helpers.mjs";

function step(spec) { return parseSpec(spec); }

test("Worker plugin: sdk.input.bind + defineMode + pushMode/popMode end-to-end", async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const chain = new BindingChain();
  const state = { bindingChain: chain };

  // The input broker emits binding-fired via runtime.emit (assigned by
  // withRuntime below). The Worker dispatcher in input-sdk.ts routes
  // 'input.binding-fired' to the plugin's local handler table.
  let rt = null;
  const inputBroker = createInputBroker({
    state,
    emitToPlugin: (plugin, name, data) => { rt?.emit(plugin, name, data); },
  });

  await withRuntime({
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
    onRequest: (plugin, method, params) => {
      if (method.startsWith("input.")) {
        const r = inputBroker(plugin, method, params);
        if (r === INPUT_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      throw new Error(`no handler for '${method}'`);
    },
  }, async (runtime) => {
    rt = runtime;
    await runtime.load([entry("input-binder.mjs", { name: "input-binder" })]);
    await waitFor(() => events.some(
      (e) => e.p === "input-binder" && e.n === "log" && String(e.d) === "ready"));

    // Single-step binding fires.
    const r1 = chain.dispatch(step("Mod+w"));
    assert.equal(r1.consume, true);
    assert.equal(r1.matched, true);
    await waitFor(() => events.some(
      (e) => e.n === "log" && String(e.d) === "fired: Mod+w"));

    // Chord fires.
    chain.dispatch(step("Mod+a"));
    const r2 = chain.dispatch(step("Mod+b"));
    assert.equal(r2.consume, true);
    assert.equal(r2.matched, true);
    await waitFor(() => events.some(
      (e) => e.n === "log" && String(e.d) === "fired: Mod+a, Mod+b"));

    // pushMode: handler enters worker-mode.
    chain.dispatch(step("Mod+r"));
    await waitFor(() => events.some(
      (e) => e.n === "log" && String(e.d).includes("pushMode(worker-mode)")));
    assert.deepEqual(chain.stackNames(), ["default", "worker-mode"]);

    // In the new mode, Return is bound -> popMode.
    chain.dispatch(step("Return"));
    await waitFor(() => events.some(
      (e) => e.n === "log" && String(e.d).includes("popMode")));
    // pushMode / popMode are async (Promise<void> via endpoint.request);
    // give the round-trip a beat to settle.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(chain.stackNames(), ["default"]);
  });
});
