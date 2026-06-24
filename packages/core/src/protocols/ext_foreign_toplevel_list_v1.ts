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

// Per-bound-list state.
interface ListState {
  resource: Resource;
  // surfaceId -> ext_foreign_toplevel_handle_v1 resource. The handle is
  // valid until the client destroys it (or the list is `stop`ed and
  // `finished`); after closed it's "inert" but still alive.
  handles: Map<number, Resource>;
  active: boolean;
}

// Module-local registry. Same pattern as the wlr impl: a Set of bound
// lists, plus a reverse map so a destroyed handle can find its owner
// for bookkeeping cleanup.
const lists = new Set<ListState>();
const handleOwners = new WeakMap<Resource, { list: ListState; surfaceId: number }>();

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
function emitInitial(ctx: Ctx, list: ListState, surfaceId: number): void {
  const events = ctx.events;
  const handle = events.ext_foreign_toplevel_list_v1
    .send_toplevel(list.resource, null) as Resource;
  if (!handle) return;
  list.handles.set(surfaceId, handle);
  handleOwners.set(handle, { list, surfaceId });

  events.ext_foreign_toplevel_handle_v1.send_identifier(handle, identifierFor(surfaceId));
  const ta = titleAppId(ctx.state, surfaceId);
  if (ta.appId !== null)
    events.ext_foreign_toplevel_handle_v1.send_app_id(handle, ta.appId);
  if (ta.title !== null)
    events.ext_foreign_toplevel_handle_v1.send_title(handle, ta.title);
  events.ext_foreign_toplevel_handle_v1.send_done(handle);
}

// Re-emit title / app_id when window.change reports they moved.
function emitChange(ctx: Ctx, list: ListState, surfaceId: number,
                    fields: ReadonlySet<string>): void {
  const handle = list.handles.get(surfaceId);
  if (!handle) return;
  const events = ctx.events;
  let any = false;
  if (fields.has("title")) {
    const t = titleAppId(ctx.state, surfaceId).title;
    if (t !== null) {
      events.ext_foreign_toplevel_handle_v1.send_title(handle, t);
      any = true;
    }
  }
  if (fields.has("appId")) {
    const a = titleAppId(ctx.state, surfaceId).appId;
    if (a !== null) {
      events.ext_foreign_toplevel_handle_v1.send_app_id(handle, a);
      any = true;
    }
  }
  if (any) events.ext_foreign_toplevel_handle_v1.send_done(handle);
}

// Send closed to every bound list's handle for this surfaceId. The
// identifier is invalidated (spec: must not be reused on remap).
function emitUnmap(ctx: Ctx, surfaceId: number): void {
  for (const list of lists) {
    if (!list.active) continue;
    const handle = list.handles.get(surfaceId);
    if (!handle) continue;
    ctx.events.ext_foreign_toplevel_handle_v1.send_closed(handle);
    list.handles.delete(surfaceId);
    // Keep handleOwners around so destroy() finds the list; the handle
    // is now inert per spec.
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
    for (const list of lists) {
      if (!list.active) continue;
      emitInitial(ctx, list, ev.surfaceId);
    }
  });
  bus.on(WINDOW_EVENT.unmap, (ev) => {
    emitUnmap(ctx, ev.surfaceId);
  });
  bus.on(WINDOW_EVENT.change, (ev) => {
    const fields = new Set<string>(ev.changed);
    for (const list of lists) {
      if (!list.active) continue;
      emitChange(ctx, list, ev.surfaceId, fields);
    }
  });
}

export default function makeExtForeignToplevelList(ctx: Ctx):
  ExtForeignToplevelListV1Handler & { bind(resource: Resource): void }
{
  return {
    bind(resource) {
      const list: ListState = { resource, handles: new Map(), active: true };
      lists.add(list);
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
      // and mark the list inactive; the client is expected to destroy
      // the list resource (and its remaining handles) afterwards.
      for (const list of lists) {
        if (list.resource !== resource) continue;
        if (!list.active) return;
        list.active = false;
        ctx.events.ext_foreign_toplevel_list_v1.send_finished(resource);
        lists.delete(list);
        return;
      }
    },
    destroy(_resource) { /* destructor */ },
  };
}

export function makeExtForeignToplevelHandle(_ctx: Ctx): ExtForeignToplevelHandleV1Handler {
  return {
    destroy(resource) {
      const owner = handleOwners.get(resource);
      if (!owner) return;
      owner.list.handles.delete(owner.surfaceId);
      handleOwners.delete(resource);
    },
  };
}

// Test-only hook: clear all per-list state so a fresh installProtocols
// sees an empty registry.
export function _resetForTests(): void {
  lists.clear();
  identifiers.clear();
  identifierSeq = 0;
}

// Look up the surfaceId for a given handle resource. Used by the
// (forthcoming) ext_foreign_toplevel_image_capture_source_manager_v1
// to map a client-supplied handle back to the toplevel.
export function surfaceIdForHandle(resource: Resource): number | null {
  const o = handleOwners.get(resource);
  return o ? o.surfaceId : null;
}
