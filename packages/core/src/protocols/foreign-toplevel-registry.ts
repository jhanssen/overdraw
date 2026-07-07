// Shared bookkeeping for the foreign-toplevel enumeration protocols
// (zwlr_foreign_toplevel_manager_v1, ext_foreign_toplevel_list_v1). Each
// bound manager/list resource holds one handle resource per mapped
// toplevel; the registry owns the binding set, the reverse handle->owner
// lookup, and disconnect pruning. A client that vanishes without sending
// stop() has its resource marked destroyed by libwayland without running
// any request handler, so live() drops such bindings during event fan-out
// and sweep() drops them on the frame tick.

import type { EventSenders, Resource } from "../types.js";
import { titleAppId } from "../query.js";
import type { CompositorState } from "./ctx.js";

export interface Binding {
  resource: Resource;
  handles: Map<number, Resource>; // surfaceId -> per-binding handle resource
  active: boolean;
}


export class BindingRegistry {
  private readonly bindings = new Set<Binding>();
  private readonly owners = new WeakMap<Resource, { binding: Binding; surfaceId: number }>();

  bind(resource: Resource): Binding {
    const binding: Binding = { resource, handles: new Map(), active: true };
    this.bindings.add(binding);
    return binding;
  }

  // Active bindings whose client is still connected. Prunes destroyed
  // bindings as it iterates so event fan-out never addresses a resource
  // whose client is gone.
  *live(): IterableIterator<Binding> {
    for (const binding of this.bindings) {
      if (binding.resource.destroyed) { this.bindings.delete(binding); continue; }
      if (binding.active) yield binding;
    }
  }

  // Handle the protocol's stop request: mark inactive + remove. Returns
  // true when the binding was still active (the caller then sends
  // finished exactly once).
  stop(resource: Resource): boolean {
    for (const binding of this.bindings) {
      if (binding.resource !== resource) continue;
      const wasActive = binding.active;
      binding.active = false;
      this.bindings.delete(binding);
      return wasActive;
    }
    return false;
  }

  // Mint a per-binding handle via the protocol's new_id-carrying event and
  // record it. Returns null when nothing was minted -- posting to a
  // destroyed resource is a no-op that creates no server-side new_id, so a
  // binding whose client vanished mid-tick yields no handle and the caller
  // must skip its emission burst.
  mint(binding: Binding, surfaceId: number,
       send: () => Resource | null | undefined): Resource | null {
    const handle = send() ?? null;
    if (!handle) return null;
    binding.handles.set(surfaceId, handle);
    this.owners.set(handle, { binding, surfaceId });
    return handle;
  }

  handleFor(binding: Binding, surfaceId: number): Resource | undefined {
    return binding.handles.get(surfaceId);
  }

  surfaceIdOf(handle: Resource): number | null {
    return this.owners.get(handle)?.surfaceId ?? null;
  }

  // Handle the client destroying a handle resource: drop the per-binding
  // mapping. The binding itself stays.
  releaseHandle(handle: Resource): void {
    const owner = this.owners.get(handle);
    if (!owner) return;
    owner.binding.handles.delete(owner.surfaceId);
    this.owners.delete(handle);
  }

  // Frame-tick disconnect sweep: drop bindings whose client vanished
  // without stop(). live() also prunes lazily, but only when a window
  // event fans out; this bounds the leak to one frame.
  sweep(): void {
    for (const binding of this.bindings) {
      if (binding.resource.destroyed) this.bindings.delete(binding);
    }
  }

  clear(): void { this.bindings.clear(); }
}

// Re-emit title / app_id on a handle when window.change reports they
// moved. `events` is either handle interface's sender table (both carry
// send_title / send_app_id with the same shape). Returns whether anything
// was sent so the caller can close the burst with its own done event.
export function emitTitleAppIdChange(
  state: CompositorState, events: EventSenders, handle: Resource,
  surfaceId: number, fields: ReadonlySet<string>,
): boolean {
  let any = false;
  if (fields.has("title")) {
    const t = titleAppId(state, surfaceId).title;
    if (t !== null) { events.send_title(handle, t); any = true; }
  }
  if (fields.has("appId")) {
    const a = titleAppId(state, surfaceId).appId;
    if (a !== null) { events.send_app_id(handle, a); any = true; }
  }
  return any;
}
