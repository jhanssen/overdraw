// ext_foreign_toplevel_list_v1: a standardized, read-only enumeration of
// every mapped toplevel for "privileged" clients (status panels, window
// switchers, screen-share window pickers, scripted automation). The data
// surface is a strict subset of zwlr_foreign_toplevel_manager_v1 (also
// implemented here) -- it carries app_id / title / identifier, no
// requests on the handle besides destroy.
//
// Why both? The wlr variant is what older clients still bind (waybar's
// classic taskbar module, swayidle's window-state inputs); the ext
// variant is what newer tools and the foreign-toplevel image-capture
// source manager (the next protocol up) bind. Clients fall back
// internally. Implementing both means no client is left out and the
// foreign-toplevel-handle is also available as input to capture.
//
// Source of state (mirrors the wlr impl):
//   - window.map (typed bus): create handles on every bound list;
//     emit identifier + app_id + title + done.
//   - window.unmap (typed bus): emit closed; handle stays alive until
//     the client destroys it (spec: the toplevel "becomes inert").
//   - window.change (typed bus): re-emit title / app_id + done on the
//     affected surface's handle.
//
// Identifier: a UTF-8 string, up to 32 printable ASCII bytes, unique
// across the lifetime of the compositor. We mint "<surfaceId>:<seq>"
// where seq is a process-wide counter, so identifiers are stable for
// the duration of a single map and never re-used even if the surfaceId
// is recycled. Spec: "An identifier must not be reused by the
// compositor to ensure there are no races when sharing identifiers
// between processes."

import type { Ctx } from "./ctx.js";
import { titleAppId } from "../query.js";
import { WINDOW_EVENT } from "../events/types.js";
import type { Resource } from "../types.js";

import type { ExtForeignToplevelListV1Handler }
  from "#protocols-gen/ext_foreign_toplevel_list_v1.js";
import type { ExtForeignToplevelHandleV1Handler }
  from "#protocols-gen/ext_foreign_toplevel_handle_v1.js";

import { BindingRegistry, emitTitleAppIdChange } from "./foreign-toplevel-registry.js";
import type { Binding } from "./foreign-toplevel-registry.js";

// Module-local registry of bound lists + reverse handle->owner lookup;
// shared machinery with the wlr foreign-toplevel implementation, including
// disconnect pruning for clients that exit without stop().
const registry = new BindingRegistry();

// Identifier generator. Monotonic across the compositor's lifetime.
let identifierSeq = 0;
// Per-surfaceId identifier, set the first time a toplevel is mapped and
// invalidated on unmap. (Spec: identifier is only valid while the
// toplevel is mapped; a remap mints a new one.)
const identifiers = new Map<number, string>();
function identifierFor(surfaceId: number): string {
  let id = identifiers.get(surfaceId);
  if (id !== undefined) return id;
  id = `${surfaceId}:${++identifierSeq}`;
  identifiers.set(surfaceId, id);
  return id;
}

// Send the full initial burst for a toplevel on a single bound list.
// Order per spec: identifier -> app_id -> title -> done.
function emitInitial(ctx: Ctx, list: Binding, surfaceId: number): void {
  const events = ctx.events;
  const handle = registry.mint(list, surfaceId, () =>
    events.ext_foreign_toplevel_list_v1
      .send_toplevel(list.resource, null) as Resource | undefined);
  if (!handle) return;

  events.ext_foreign_toplevel_handle_v1.send_identifier(handle, identifierFor(surfaceId));
  const ta = titleAppId(ctx.state, surfaceId);
  if (ta.appId !== null)
    events.ext_foreign_toplevel_handle_v1.send_app_id(handle, ta.appId);
  if (ta.title !== null)
    events.ext_foreign_toplevel_handle_v1.send_title(handle, ta.title);
  events.ext_foreign_toplevel_handle_v1.send_done(handle);
}

// Re-emit title / app_id when window.change reports they moved.
function emitChange(ctx: Ctx, list: Binding, surfaceId: number,
                    fields: ReadonlySet<string>): void {
  const handle = registry.handleFor(list, surfaceId);
  if (!handle) return;
  const events = ctx.events;
  const any = emitTitleAppIdChange(ctx.state, events.ext_foreign_toplevel_handle_v1,
    handle, surfaceId, fields);
  if (any) events.ext_foreign_toplevel_handle_v1.send_done(handle);
}

// Send closed to every bound list's handle for this surfaceId. The
// identifier is invalidated (spec: must not be reused on remap).
function emitUnmap(ctx: Ctx, surfaceId: number): void {
  for (const list of registry.live()) {
    const handle = registry.handleFor(list, surfaceId);
    if (!handle) continue;
    ctx.events.ext_foreign_toplevel_handle_v1.send_closed(handle);
    list.handles.delete(surfaceId);
    // The registry's reverse lookup keeps the entry so destroy() finds the
    // list; the handle is now inert per spec.
  }
  identifiers.delete(surfaceId);
}

// Install the bus subscriptions. Called once from installProtocols.
export function installExtForeignToplevelBusHooks(ctx: Ctx): void {
  const bus = ctx.state.bus;
  if (!bus) return;
  bus.on(WINDOW_EVENT.map, (ev) => {
    // Layer-shell maps also ride window.map; this protocol covers
    // toplevels only, mirroring the wlr equivalent.
    if (ev.role !== undefined && ev.role !== "toplevel") return;
    for (const list of registry.live()) {
      emitInitial(ctx, list, ev.surfaceId);
    }
  });
  bus.on(WINDOW_EVENT.unmap, (ev) => {
    emitUnmap(ctx, ev.surfaceId);
  });
  bus.on(WINDOW_EVENT.change, (ev) => {
    const fields = new Set<string>(ev.changed);
    for (const list of registry.live()) {
      emitChange(ctx, list, ev.surfaceId, fields);
    }
  });
}

export default function makeExtForeignToplevelList(ctx: Ctx):
  ExtForeignToplevelListV1Handler & { bind(resource: Resource): void }
{
  return {
    bind(resource) {
      const list = registry.bind(resource);
      // Catch-up: every currently-mapped toplevel.
      const wm = ctx.state.wm;
      if (!wm) return;
      for (const w of wm.state.windows) {
        if (!w.hasContent) continue;
        emitInitial(ctx, list, w.surfaceId);
      }
    },
    stop(resource) {
      // The client no longer wants new-toplevel events. Send finished
      // and drop the list; the client is expected to destroy the list
      // resource (and its remaining handles) afterwards.
      if (registry.stop(resource)) {
        ctx.events.ext_foreign_toplevel_list_v1.send_finished(resource);
      }
    },
    destroy(_resource) { /* destructor */ },
  };
}

export function makeExtForeignToplevelHandle(_ctx: Ctx): ExtForeignToplevelHandleV1Handler {
  return {
    destroy(resource) {
      registry.releaseHandle(resource);
    },
  };
}

// Frame-tick disconnect sweep: drop lists whose client vanished without
// stop() (their resources are marked destroyed; no request handler ran).
export function sweepDisconnected(): void {
  registry.sweep();
}

// Test-only hook: clear all per-list state so a fresh installProtocols
// sees an empty registry.
export function _resetForTests(): void {
  registry.clear();
  identifiers.clear();
  identifierSeq = 0;
}

// Look up the surfaceId for a given handle resource. Used by
// ext_foreign_toplevel_image_capture_source_manager_v1 to map a
// client-supplied handle back to the toplevel.
export function surfaceIdForHandle(resource: Resource): number | null {
  return registry.surfaceIdOf(resource);
}
