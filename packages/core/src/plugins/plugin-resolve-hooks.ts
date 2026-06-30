// ESM resolve hook (registered via module.register; see registerPluginResolveHooks
// in loader.ts) so a plugin loaded from OUTSIDE the overdraw install -- e.g. a
// user's ~/.config/overdraw directory -- can import the bundled @overdraw/* SDK
// packages (sdk-anim, layout-types, ...) by their bare specifier.
//
// Node resolves a bare specifier relative to the importing file, walking up for
// node_modules; a user plugin's directory has none with these packages, so the
// import throws "Cannot find package '@overdraw/...'". When normal resolution of
// an @overdraw/* specifier fails, retry it as if imported from THIS module --
// which lives inside the install, so its resolution path reaches the workspace
// packages. Successful resolutions (the install's own imports, plugins that ship
// their own node_modules) are never touched: the fallback runs only on failure.

import type { ResolveHook } from "node:module";

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  if (!specifier.startsWith("@overdraw/")) return nextResolve(specifier, context);
  try {
    return await nextResolve(specifier, context);
  } catch {
    return nextResolve(specifier, { ...context, parentURL: import.meta.url });
  }
};
