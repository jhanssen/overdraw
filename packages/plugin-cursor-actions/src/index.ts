// Bundled plugin that exposes the cursor SDK through the action registry,
// so hotkey configs and overdrawctl can drive the cursor without a full
// plugin install. Mirrors @overdraw/plugin-core-actions: tiny init, just
// wraps sdk.cursor.* in named actions.

import type { PluginSdkShape } from "@overdraw/plugin-sdk-types";

export default async function init(sdk: PluginSdkShape): Promise<void> {
  if (!sdk.cursor) {
    sdk.log("cursor SDK absent; cursor-actions not registered");
    return;
  }
  const cursor = sdk.cursor;

  sdk.actions.register({
    name: "cursor.set-shape",
    description: "Set the cursor to a named XCursor shape. " +
      "Installs as an explicit plugin override (priority 1: above client " +
      "cursor + matched rules). params: { name: string }.",
    handler: async (params: unknown): Promise<null> => {
      const name = (params as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("cursor.set-shape: params.name must be a non-empty string");
      }
      await cursor.setShape(name);
      return null;
    },
  });

  sdk.actions.register({
    name: "cursor.hide",
    description: "Hide the cursor. Installs as an explicit override; the " +
      "previously-installed cursor is restored by cursor.show or " +
      "cursor.clear-override.",
    handler: async (): Promise<null> => {
      await cursor.hide();
      return null;
    },
  });

  sdk.actions.register({
    name: "cursor.show",
    description: "Restore cursor visibility (counterpart to cursor.hide). " +
      "Does NOT clear an explicit override -- the previously-installed " +
      "shape/image is shown again.",
    handler: async (): Promise<null> => {
      await cursor.show();
      return null;
    },
  });

  sdk.actions.register({
    name: "cursor.clear-override",
    description: "Drop the plugin's explicit cursor override; re-evaluate " +
      "registered rules and fall back to the compositor default if none " +
      "match.",
    handler: async (): Promise<null> => {
      await cursor.clearOverride();
      return null;
    },
  });

  sdk.actions.register({
    name: "cursor.set-default",
    description: "Set the compositor's default cursor shape (priority 3: " +
      "shown when no plugin override + no rule match + no client cursor). " +
      "Pass null to clear back to the built-in 'default'. params: " +
      "{ shape: string | null }.",
    handler: async (params: unknown): Promise<null> => {
      const shape = (params as { shape?: unknown } | null)?.shape;
      if (shape !== null && typeof shape !== "string") {
        throw new Error("cursor.set-default: params.shape must be a string or null");
      }
      await cursor.setDefault(shape);
      return null;
    },
  });

  sdk.log("cursor-actions registered");
}
