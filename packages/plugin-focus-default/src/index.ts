// Bundled focus plugin: follow-pointer / click-to-focus / focusOnMap.
// Registers at priority 0; replaceable by any higher-priority plugin in
// the 'focus' namespace.

import type { FocusAPI, FocusInputs, FocusResult } from "@overdraw/focus-types";
import type { PluginSdkShape } from "@overdraw/plugin-sdk-types";
import { decideFocus, validateConfig, type FocusPluginConfig } from "./policy.js";

export default async function init(sdk: PluginSdkShape, rawConfig?: unknown): Promise<void> {
  const config: FocusPluginConfig = validateConfig(rawConfig);
  sdk.log(`focus plugin: policy=${config.policy}, focusOnMap=${config.focusOnMap}, `
    + `followRepick=${config.followRepick}`);

  const api: FocusAPI = {
    decide(inputs: FocusInputs): Promise<FocusResult> {
      return Promise.resolve(decideFocus(config, inputs));
    },
  };

  await sdk.registerPlugin("focus", () => api);
}
