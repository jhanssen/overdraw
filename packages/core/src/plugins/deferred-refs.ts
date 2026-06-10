// Deferred-reference resolver: walks an action's params payload and
// substitutes every { $ref: name } sentinel with the resolver map's
// current value for that name. Called by PluginRuntime.onActionInvoke
// before dispatching the action to its owning plugin.
//
// Refs are recognized by the { $ref: string } shape, NOT by reference
// equality with the `ref.X` exports -- this is intentional so:
//   - Refs survive structured-clone (IPC, postMessage).
//   - User configs MAY write { $ref: "name" } literals directly (the
//     ref.X helpers are sugar over the same shape).
//   - The resolver works the same in every transport.
//
// An unknown ref name resolves to undefined, which the action sees as
// "the value was a typo or refers to something this build doesn't
// know about." Caller action handlers decide whether to reject or
// treat undefined as a sensible default.

import { isDeferredRef } from "../config/refs.js";
import type { RefName } from "../config/refs.js";

// A resolver map: name -> "what's the current value." Pure function;
// invoked once per ref occurrence during params traversal. Sync because
// the action invocation hot path can't await per-ref.
export type ResolverMap = { [K in RefName]?: () => unknown };

// Walk `params` recursively, returning a new value with every ref
// substituted. The input is not mutated.
//
// Recognized shapes:
//   - { $ref: name }  -> resolver[name]() (or undefined if unknown)
//   - { ... }         -> new object with each value resolved
//   - [ ... ]         -> new array with each element resolved
//   - other (number, string, boolean, null, bigint) -> passed through
//
// If a ref's resolver throws, the exception propagates -- action
// resolution is best-effort and an unexpected resolver error should
// surface at invoke time rather than be silently swallowed.
export function resolveRefs(params: unknown, resolvers: ResolverMap): unknown {
  if (params === null || params === undefined) return params;
  if (Array.isArray(params)) {
    return params.map((v) => resolveRefs(v, resolvers));
  }
  if (isDeferredRef(params)) {
    const r = resolvers[params.$ref as RefName];
    if (!r) return undefined;
    return r();
  }
  if (typeof params === "object") {
    const out: { [k: string]: unknown } = {};
    for (const [k, v] of Object.entries(params)) {
      out[k] = resolveRefs(v, resolvers);
    }
    return out;
  }
  return params;
}

// Convenience constructor for the resolver function passed via
// RuntimeOptions.resolveDeferredRefs. Closes over the map; the map is
// LIVE (the resolver functions are read at each invoke), so callers
// can swap a function without rebuilding the resolver.
export function buildResolver(map: ResolverMap): (params: unknown) => unknown {
  return (params) => resolveRefs(params, map);
}
