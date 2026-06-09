// Bundled focus plugin: follow-pointer / click-to-focus / focusOnMap.
// Registers at priority 0; replaceable by any higher-priority plugin in
// the 'focus' namespace.

import type { FocusAPI, FocusInputs, FocusResult } from "@overdraw/focus-types";
import { decideFocus, validateConfig, type FocusPluginConfig } from "./policy.js";

interface SdkLike {
  readonly name: string;
  log(...args: unknown[]): void;
  registerPlugin<A>(name: string, init: () => Promise<A> | A,
                   opts?: { priority?: number }): Promise<{ unregister(): void }>;
}

export default async function init(sdk: SdkLike, rawConfig?: unknown): Promise<void> {
  const config: FocusPluginConfig = validateConfig(rawConfig);
  sdk.log(`focus plugin: policy=${config.policy}, focusOnMap=${config.focusOnMap}`);

  const api: FocusAPI = {
    decide(inputs: FocusInputs): Promise<FocusResult> {
      return Promise.resolve(decideFocus(config, inputs));
    },
  };

  await sdk.registerPlugin("focus", () => api);
}
