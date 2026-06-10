// Typed deferred-reference helpers exported from "overdraw/config" as
// the `ref` namespace. Used in action params to defer resolution from
// config-construction time to action-invoke time, so a hotkey can carry
// a value like "whatever surface is under the pointer right now":
//
//   import { ref } from "overdraw/config";
//   hotkeys: {
//     modes: {
//       default: [
//         { keys: "Mod+w", action: "workspace.move-window",
//           params: { surfaceId: ref.surfaceUnderPointer, index: 1 } },
//       ],
//     },
//   }
//
// `ref.X` is a sentinel value (`{ $ref: "X" }`) that the action registry
// recognizes during params traversal at invoke time and replaces with
// the value from a core-side resolver map. The user writes `ref.X`
// directly; TypeScript types it as `DeferredRef<T>` so action callers
// see a typed slot.
//
// Resolvers are populated by main.ts at boot (and by the harness in
// tests). The set in v1 covers the references actions commonly need;
// see RefName below. Adding a reference is one entry in this file +
// one entry in the resolver map in main.ts.

// Brand on each ref so action handlers' param types are honest:
//
//   workspace.move-window params: { surfaceId: number | DeferredRef<number> }
//
// at boot the resolver replaces every DeferredRef with its current value;
// the handler always sees the resolved type.
declare const REF_BRAND: unique symbol;
export interface DeferredRef<T> {
  $ref: string;
  // Phantom field; never present at runtime. Forces TypeScript to
  // distinguish DeferredRef<number> from DeferredRef<string> etc.,
  // so passing `ref.pointerX` where a string is expected is a type
  // error.
  [REF_BRAND]?: T;
}

// The canonical set of references the core resolver knows. Adding a new
// one: extend this union AND the resolver map in main.ts. (Type-checked
// at the boundary so a typo'd ref name fails at compile time.)
export type RefName =
  | "surfaceUnderPointer"   // number | null
  | "focusedWindow"         // number | null
  | "pointerX"              // number
  | "pointerY"              // number
  | "activeOutput"          // number
  | "currentWorkspace";     // number | null (index of the shown workspace)

function makeRef<T>(name: RefName): DeferredRef<T> {
  // The runtime shape is just { $ref: name }. The phantom T is erased.
  return { $ref: name };
}

// The user-facing `ref` namespace. Each property is a DeferredRef of
// the type the resolver will return at invoke time.
export const ref = {
  surfaceUnderPointer: makeRef<number | null>("surfaceUnderPointer"),
  focusedWindow: makeRef<number | null>("focusedWindow"),
  pointerX: makeRef<number>("pointerX"),
  pointerY: makeRef<number>("pointerY"),
  activeOutput: makeRef<number>("activeOutput"),
  currentWorkspace: makeRef<number | null>("currentWorkspace"),
} as const;

// Predicate: does the value look like a DeferredRef? Used by the action
// registry's resolver to recognize sentinels during params traversal.
// Conservatively checks the exact shape ({ $ref: string }, single own
// key) so a plausible user-written `{ $ref: "..." }` literal in params
// works the same way (deliberate -- if a user writes it, they meant it).
export function isDeferredRef(v: unknown): v is { $ref: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as { [k: string]: unknown };
  if (typeof o.$ref !== "string") return false;
  if (o.$ref.length === 0) return false;
  // Allow extra keys; reject only if $ref is absent. This is more
  // tolerant than a strict "only $ref" check; users who serialize a
  // ref over JSON-RPC and add diagnostic fields still get resolution.
  return true;
}
