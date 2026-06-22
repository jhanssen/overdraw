// zwlr_foreign_toplevel_manager_v1 / zwlr_foreign_toplevel_handle_v1: lets a
// "privileged" client (taskbar / dock / window switcher) observe every
// mapped toplevel and request state changes on them. Every client that
// binds the global gets the full list -- there is no per-client auth (the
// same approach reference compositors take; user-level isolation lives at
// the socket / sandbox layer, not here).
//
// Per-manager bookkeeping: each bound manager resource holds its own
// per-toplevel handle resource. Map size = (#managers) * (#mapped
// toplevels). When a window changes title / app_id / activation /
// presentation / parent, every bound manager's matching handle re-emits
// the changed property + done.
//
// Source of state:
//   - window.map (typed bus): create handles on every existing manager;
//     send the initial burst (title, app_id, state, done).
//   - window.unmap (typed bus): handle emits closed; resource stays alive
//     until the client destroys it (spec: the toplevel "becomes inert").
//   - window.change (typed bus): title / appId / activated re-emit on
//     each handle for the affected surface.
//   - window.committed (plugin bus): presentation / parent changes
//     translate to a re-emitted state array + parent event.
//
// Inbound requests on a handle:
//   - set_maximized / unset_maximized / set_minimized / unset_minimized /
//     set_fullscreen / unset_fullscreen: route through wm.propose() so the
//     interceptable proposed/committed chain runs.
//   - activate(wl_seat): seat.applyKeyboardFocus(surfaceId) directly,
//     bypassing the focus driver (matches the reference compositor model:
//     these clients are window switchers; their selection is explicit
//     user intent that policy plugins shouldn't second-guess).
//   - close: send xdg_toplevel.close to the toplevel's client.
//   - set_rectangle(wl_surface, x, y, w, h): hint for minimize-to-icon
//     animations. Accepted; not consumed by any animation today.

import { signature as handleSig } from "#protocols-gen/zwlr_foreign_toplevel_handle_v1.js";
import type { ZwlrForeignToplevelManagerV1Handler }
  from "#protocols-gen/zwlr_foreign_toplevel_manager_v1.js";
import type { ZwlrForeignToplevelHandleV1Handler }
  from "#protocols-gen/zwlr_foreign_toplevel_handle_v1.js";

import type { Ctx } from "./ctx.js";
import { titleAppId } from "../query.js";
import { closeSurface } from "./close-surface.js";
import { WINDOW_EVENT } from "../events/types.js";
import type { Resource } from "../types.js";
import type { WindowState } from "../events/types.js";

const STATE = handleSig.enums.state.entries;
//   { maximized: 0, minimized: 1, activated: 2, fullscreen: 3 }

// Per-manager state: which handle this client received for each surfaceId,
// plus an `active` flag flipped on stop() so further events suppress.
interface ManagerState {
  resource: Resource;
  handles: Map<number, Resource>; // surfaceId -> zwlr_foreign_toplevel_handle_v1
  active: boolean;
}

// Module-local registry of all bound managers + reverse lookup from a
// handle resource back to its (manager, surfaceId). Living outside the
// CompositorState avoids leaking foreign-toplevel internals to every other
// handler.
const managers = new Set<ManagerState>();
const handleOwners = new WeakMap<Resource, { manager: ManagerState; surfaceId: number }>();

// Pack the foreign-toplevel state array. Same wire shape as
// xdg_toplevel.configure states: a contiguous run of host-endian uint32.
function packStates(values: number[]): Uint8Array {
  const buf = new ArrayBuffer(values.length * 4);
  new Uint32Array(buf).set(values);
  return new Uint8Array(buf);
}

// Narrow a dynamic-bus payload to the window.committed shape. Defensive
// (the dynamic bus emits payloads as `unknown` to subscribers).
function isCommittedPayload(p: unknown): p is { surfaceId: number; previous: WindowState; current: WindowState } {
  if (typeof p !== "object" || p === null) return false;
  const o = p as { [k: string]: unknown };
  return typeof o.surfaceId === "number"
    && typeof o.previous === "object" && o.previous !== null
    && typeof o.current === "object" && o.current !== null;
}

// Build the state array from current window state + the activated focus.
function buildStateArray(ws: WindowState | null, activated: boolean): Uint8Array {
  const out: number[] = [];
  if (ws) {
    switch (ws.presentation) {
      case "maximized": out.push(STATE.maximized); break;
      case "fullscreen": out.push(STATE.fullscreen); break;
      case "minimized": out.push(STATE.minimized); break;
      // "managed" and "floating" have no foreign-toplevel state.
    }
  }
  if (activated) out.push(STATE.activated);
  return packStates(out);
}

// Send the full initial burst for a freshly-tracked toplevel on a single
// manager. Emits in order:
//   toplevel -> app_id -> title -> state -> done
// (output_enter is omitted today; see status.md "Read first" --
// per-client wl_output resource resolution isn't wired and single-output
// means there's only one valid value anyway).
function emitInitial(ctx: Ctx, mgr: ManagerState, surfaceId: number): void {
  const state = ctx.state;
  // Mint a server-side new_id for the handle. The trampoline returns the
  // freshly created resource when the new_id arg is null. Same idiom the
  // wl_data_device.send_data_offer path uses.
  const handle = ctx.events.zwlr_foreign_toplevel_manager_v1
    .send_toplevel(mgr.resource, null) as Resource;
  mgr.handles.set(surfaceId, handle);
  handleOwners.set(handle, { manager: mgr, surfaceId });

  const ta = titleAppId(state, surfaceId);
  if (ta.appId !== null) ctx.events.zwlr_foreign_toplevel_handle_v1.send_app_id(handle, ta.appId);
  if (ta.title !== null) ctx.events.zwlr_foreign_toplevel_handle_v1.send_title(handle, ta.title);
  const ws = state.wm?.getWindowState(surfaceId) ?? null;
  const activated = state.seat?.kbFocus?.surfaceId === surfaceId;
  ctx.events.zwlr_foreign_toplevel_handle_v1.send_state(handle, buildStateArray(ws, activated));
  ctx.events.zwlr_foreign_toplevel_handle_v1.send_done(handle);
}

// Translate a window.change field set into per-handle re-emissions.
function emitChange(ctx: Ctx, mgr: ManagerState, surfaceId: number,
                    fields: ReadonlySet<string>): void {
  const handle = mgr.handles.get(surfaceId);
  if (!handle) return;
  const state = ctx.state;
  let any = false;
  if (fields.has("title")) {
    const t = titleAppId(state, surfaceId).title;
    if (t !== null) {
      ctx.events.zwlr_foreign_toplevel_handle_v1.send_title(handle, t);
      any = true;
    }
  }
  if (fields.has("appId")) {
    const a = titleAppId(state, surfaceId).appId;
    if (a !== null) {
      ctx.events.zwlr_foreign_toplevel_handle_v1.send_app_id(handle, a);
      any = true;
    }
  }
  if (fields.has("activated")) {
    const ws = state.wm?.getWindowState(surfaceId) ?? null;
    const activated = state.seat?.kbFocus?.surfaceId === surfaceId;
    ctx.events.zwlr_foreign_toplevel_handle_v1.send_state(handle, buildStateArray(ws, activated));
    any = true;
  }
  if (any) ctx.events.zwlr_foreign_toplevel_handle_v1.send_done(handle);
}

// Re-emit the state array (presentation change) and parent event when the
// committed window state changed.
function emitCommitted(ctx: Ctx, mgr: ManagerState, surfaceId: number,
                       prev: WindowState, next: WindowState): void {
  const handle = mgr.handles.get(surfaceId);
  if (!handle) return;
  let any = false;
  if (prev.presentation !== next.presentation) {
    const activated = ctx.state.seat?.kbFocus?.surfaceId === surfaceId;
    ctx.events.zwlr_foreign_toplevel_handle_v1.send_state(handle, buildStateArray(next, activated));
    any = true;
  }
  if (prev.parent !== next.parent) {
    const parentHandle = next.parent != null ? mgr.handles.get(next.parent) ?? null : null;
    ctx.events.zwlr_foreign_toplevel_handle_v1.send_parent(handle, parentHandle);
    any = true;
  }
  if (any) ctx.events.zwlr_foreign_toplevel_handle_v1.send_done(handle);
}

// Send `closed` to every manager's handle for this surfaceId and drop the
// per-manager bookkeeping. The handle resource stays alive (the spec
// requires the client to destroy it); we just stop addressing it as
// "tracking this toplevel".
function emitUnmap(ctx: Ctx, surfaceId: number): void {
  for (const mgr of managers) {
    if (!mgr.active) continue;
    const handle = mgr.handles.get(surfaceId);
    if (!handle) continue;
    ctx.events.zwlr_foreign_toplevel_handle_v1.send_closed(handle);
    mgr.handles.delete(surfaceId);
    // Keep handleOwners so destroy() finds the manager; the handle is now
    // inert per spec.
  }
}

// Subscribe to the typed bus + the dynamic plugin bus to drive emissions.
// Called once from installProtocols when both buses are available.
export function installForeignToplevelBusHooks(ctx: Ctx): void {
  const state = ctx.state;
  if (state.bus) {
    state.bus.on(WINDOW_EVENT.map, (ev) => {
      // Layer-shell maps also fire window.map; only toplevels go through
      // the foreign-toplevel manager.
      if (ev.role !== undefined && ev.role !== "toplevel") return;
      for (const mgr of managers) {
        if (!mgr.active) continue;
        emitInitial(ctx, mgr, ev.surfaceId);
      }
    });
    state.bus.on(WINDOW_EVENT.unmap, (ev) => {
      emitUnmap(ctx, ev.surfaceId);
    });
    state.bus.on(WINDOW_EVENT.change, (ev) => {
      const fields = new Set<string>(ev.changed);
      for (const mgr of managers) {
        if (!mgr.active) continue;
        emitChange(ctx, mgr, ev.surfaceId, fields);
      }
    });
  }
  // window.committed lives on the plugin bus (it's the post-propose
  // interceptable event chain). Subscribe there for presentation / parent
  // changes.
  if (state.pluginBus) {
    state.pluginBus.subscribe(WINDOW_EVENT.committed, (_name, payload) => {
      if (!isCommittedPayload(payload)) return;
      for (const mgr of managers) {
        if (!mgr.active) continue;
        emitCommitted(ctx, mgr, payload.surfaceId, payload.previous, payload.current);
      }
    });
  }
}

// ---- handler factories ---------------------------------------------------

export default function makeForeignToplevelManager(ctx: Ctx): ZwlrForeignToplevelManagerV1Handler & { bind(resource: Resource): void } {
  return {
    bind(resource) {
      const mgr: ManagerState = { resource, handles: new Map(), active: true };
      managers.add(mgr);
      // Catch-up: emit toplevel + initial burst for every currently-mapped
      // window. The WM is the authority on which toplevels exist.
      const wm = ctx.state.wm;
      if (wm) {
        for (const w of wm.state.windows) {
          if (!w.hasContent) continue;
          // The role check: a layer-shell surface isn't in wm.state.windows
          // anyway, so this loop only sees toplevels.
          emitInitial(ctx, mgr, w.surfaceId);
        }
      }
    },
    stop(resource) {
      // The client no longer wants events. Send finished + mark the manager
      // inactive. Per spec: "The server will destroy the object immediately
      // after sending this request" -- the trampoline's destructor handler
      // wires that up; we just send the event + flag.
      for (const mgr of managers) {
        if (mgr.resource !== resource) continue;
        if (!mgr.active) return;
        mgr.active = false;
        ctx.events.zwlr_foreign_toplevel_manager_v1.send_finished(resource);
        managers.delete(mgr);
        return;
      }
    },
  };
}

export function makeForeignToplevelHandle(ctx: Ctx): ZwlrForeignToplevelHandleV1Handler {
  const surfaceIdOf = (resource: Resource): number | null => {
    const o = handleOwners.get(resource);
    return o ? o.surfaceId : null;
  };

  return {
    set_maximized(resource) {
      const id = surfaceIdOf(resource);
      if (id === null) return;
      void ctx.state.wm?.propose(id, { presentation: "maximized" }, "plugin");
    },
    unset_maximized(resource) {
      const id = surfaceIdOf(resource);
      if (id === null) return;
      void ctx.state.wm?.propose(id, { presentation: "managed" }, "plugin");
    },
    set_minimized(resource) {
      const id = surfaceIdOf(resource);
      if (id === null) return;
      void ctx.state.wm?.propose(id, { presentation: "minimized" }, "plugin");
    },
    unset_minimized(resource) {
      const id = surfaceIdOf(resource);
      if (id === null) return;
      void ctx.state.wm?.propose(id, { presentation: "managed" }, "plugin");
    },
    set_fullscreen(resource, _output) {
      // _output is a hint we ignore today (single-output; see status.md
      // "Read first").
      const id = surfaceIdOf(resource);
      if (id === null) return;
      void ctx.state.wm?.propose(id, { presentation: "fullscreen" }, "plugin");
    },
    unset_fullscreen(resource) {
      const id = surfaceIdOf(resource);
      if (id === null) return;
      void ctx.state.wm?.propose(id, { presentation: "managed" }, "plugin");
    },
    activate(resource, _seat) {
      // _seat is ignored: there's only one seat in this compositor.
      // Bypass the focus driver -- the foreign-toplevel client is making
      // an explicit user-driven selection (taskbar click, window switcher
      // pick); policy plugins shouldn't second-guess it.
      const id = surfaceIdOf(resource);
      if (id === null) return;
      ctx.state.seat?.applyKeyboardFocus(id);
    },
    close(resource) {
      const id = surfaceIdOf(resource);
      if (id === null) return;
      closeSurface(ctx.state, id);
    },
    set_rectangle(_resource, _surface, _x, _y, _width, _height) {
      // Taskbar minimize-to-icon hint. Recorded by other compositors to
      // animate the toplevel toward the taskbar entry. No minimize
      // animation here; accepting and discarding.
    },
    destroy(resource) {
      // The client is done with this handle. Drop the per-manager mapping;
      // the resource itself is torn down by the trampoline.
      const owner = handleOwners.get(resource);
      if (!owner) return;
      owner.manager.handles.delete(owner.surfaceId);
      handleOwners.delete(resource);
    },
  };
}

// Test-only hook: clear all manager + handle state. Module-local state
// persists across installProtocols calls in the same process; tests that
// stand up multiple compositors in one process call this between them.
export function _resetForTests(): void {
  managers.clear();
}
