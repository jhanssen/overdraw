// Bundled focus plugin. Registers in the 'focus' namespace at priority 0
// (the floor; bundled-plugin default). Implements follow-pointer and
// click-to-focus via the pure policy state machine in policy.ts. A user
// who wants different behavior installs a third-party focus plugin at
// higher priority; the priority chain demotes back to this one on failure.
//
// The plugin runs in-thread (the runtime selects the in-thread transport
// for bundled plugins, Phase 3a). decide() is therefore near-free per call,
// resolving on the next microtask. Even so, the contract is async per the
// SDK rule; we return Promise.resolve(...) explicitly.

import type { FocusAPI, FocusInputs, FocusResult } from "@overdraw/focus-types";
import { decideFocus, validateConfig, type FocusPluginConfig } from "./policy.js";

interface SdkLike {
  readonly name: string;
  log(...args: unknown[]): void;
  registerPlugin<A>(name: string, init: () => Promise<A> | A,
                   opts?: { priority?: number }): Promise<{ unregister(): void }>;
}

export default async function init(sdk: SdkLike, rawConfig?: unknown): Promise<void> {
  // Validate the config eagerly. If it's bad, throw -- the in-thread
  // bundled-plugin transport (inthread-plugin.ts) treats init throws as
  // fatal startup errors, which is the desired behavior for a misconfigured
  // bundled plugin (release-blocking bug per core-plugin-api.md).
  const config: FocusPluginConfig = validateConfig(rawConfig);
  sdk.log(`focus plugin: policy=${config.policy}, focusOnMap=${config.focusOnMap}`);

  const api: FocusAPI = {
    decide(inputs: FocusInputs): Promise<FocusResult> {
      // decideFocus is pure; the Promise.resolve is the async contract,
      // not a real async hop. The in-thread transport elides the IPC
      // entirely; user-installed focus plugins in a Worker would pay a
      // postMessage round-trip here, which is acceptable at coarse-event
      // rate (per core-plugin-api.md §"Cross-cutting patterns" Pattern B).
      return Promise.resolve(decideFocus(config, inputs));
    },
  };

  await sdk.registerPlugin("focus", () => api);
}
