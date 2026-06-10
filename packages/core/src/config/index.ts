// Public surface of overdraw's config helpers. The user's config file
// imports from here:
//
//   import type { OverdrawConfig } from "overdraw/config";
//   import { ref } from "overdraw/config";
//   export default {
//     hotkeys: {
//       modes: { default: [
//         { keys: "Mod+w", action: "workspace.move-window",
//           params: { surfaceId: ref.surfaceUnderPointer, index: 1 } },
//       ] },
//     },
//   } satisfies OverdrawConfig;

export type {
  OverdrawConfig, OutputConfig, PluginConfig, RestartPolicy, ConfigExport,
} from "./types.js";

export { ref, isDeferredRef } from "./refs.js";
export type { DeferredRef, RefName } from "./refs.js";
