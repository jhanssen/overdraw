// ext_workspace_v1: lets clients (status bars, docks, switchers) enumerate
// the compositor's workspaces, observe activation / urgency, and request
// activate / remove / create. The compositor's workspace concept is owned
// by the bundled workspace plugin (@overdraw/plugin-workspace-default);
// this protocol is a pure wire adapter onto its events + injected API.
//
// Per-manager bookkeeping: each bound manager resource holds its own
// per-output group handles and per-workspace handles. Map size =
// (#managers) * (#outputs + #workspaces). Bus events broadcast to every
// bound manager.
//
// Source of state:
//   - workspace.created  (plugin bus): per manager, emit `workspace` +
//     initial metadata (name, id, coordinates, state, capabilities) +
//     `workspace_enter` on the owning group + `done`.
//   - workspace.destroyed: emit `removed` on the handle; the resource
//     stays alive (spec: "becomes inert") until the client destroys it.
//   - workspace.shown / workspace.hidden: flip the active bit on the new
//     and old workspaces' state events; coalesced into one `done`.
//   - workspace.renamed: re-emit `name` + `done`.
//   - workspace.renumbered: re-emit `coordinates` for each changed
//     workspace + `done`.
//   - workspace.urgency-changed: re-emit `state` with the new urgent bit
//     (preserving the current active bit) + `done`.
//   - output.added / output.removed (plugin bus): create / remove the
//     corresponding group on each manager. output_enter / output_leave
//     are tied to group creation/removal -- this compositor's group
//     partition is exactly per-output, so a group's output set is always
//     a single output.
//
// Inbound requests:
//   - manager.commit: applied immediately. The compositor's plugin layer
//     already serializes its mutations through one applyEffects pass per
//     SDK call; we do not batch protocol requests between commits. This
//     deviates from the spec's atomic-batch model in the unusual case
//     where a client batches multiple activate/remove/create requests
//     before commit; observed clients (waybar) do not batch.
//   - manager.stop: emit `finished`, drop the manager. Mirrors
//     zwlr_foreign_toplevel_manager_v1.stop().
//   - group.create_workspace(name): create a workspace on the group's
//     output via the injected workspace driver.
//   - group.destroy: drop the per-manager group handle bookkeeping.
//   - workspace.activate: show the workspace on its output.
//   - workspace.remove: destroy the workspace.
//   - workspace.deactivate / workspace.assign: no-op (capabilities are
//     never advertised; spec requires the compositor to ignore them).
//   - workspace.destroy: drop the per-manager workspace handle.

import type {
  ExtWorkspaceManagerV1Handler, ExtWorkspaceManagerV1Resource,
} from "#protocols-gen/ext_workspace_manager_v1.js";
import type {
  ExtWorkspaceGroupHandleV1Handler, ExtWorkspaceGroupHandleV1Resource,
} from "#protocols-gen/ext_workspace_group_handle_v1.js";
import { signature as groupSig } from "#protocols-gen/ext_workspace_group_handle_v1.js";
import type {
  ExtWorkspaceHandleV1Handler, ExtWorkspaceHandleV1Resource,
} from "#protocols-gen/ext_workspace_handle_v1.js";
import { signature as wsSig } from "#protocols-gen/ext_workspace_handle_v1.js";

// Enum values pulled from the runtime signature (the per-interface .js
// only emits signature + makeEvents; the TS const enums in the .d.ts are
// type-only). Same idiom as zwlr_foreign_toplevel's STATE pull.
const GROUP_CAPS = groupSig.enums.group_capabilities.entries;
//   { create_workspace: 1 }
const WS_STATE = wsSig.enums.state.entries;
//   { active: 1, urgent: 2, hidden: 4 }
const WS_CAPS = wsSig.enums.workspace_capabilities.entries;
//   { activate: 1, deactivate: 2, remove: 4, assign: 8 }

import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";
import { log } from "../log.js";

// The driver injected by main.ts. Mirrors the subset of WorkspaceAPI the
// protocol routes inbound requests to; absence means "no workspace plugin
// active" and inbound requests are silently dropped (the catch-up burst
// also yields nothing, so a bound manager simply observes zero
// workspaces/groups).
export interface WorkspaceDriver {
  create(spec: { outputId: number; name?: string }): Promise<unknown>;
  destroy(index: number, outputId: number): Promise<unknown>;
  show(index: number, outputId: number): Promise<unknown>;
}

// Snapshot of one workspace as the protocol layer needs to render it.
// Sourced from the workspace plugin's bus events; cached locally so the
// catch-up burst on a fresh bind() doesn't have to round-trip the plugin.
interface WorkspaceInfo {
  // The plugin's durable WorkspaceHandle (an integer). Conveyed as the
  // protocol `id` event string.
  workspaceId: number;
  outputId: number;
  // 1-based index, sourced from workspace.created / renumbered. The
  // coordinates event encodes (index - 1) as a 1-D u32.
  index: number;
  name?: string;
  urgent: boolean;
}

// One inbound request queued between two commits. Spec: "The compositor
// must process a series of requests preceding a commit request atomically."
// Each request is captured at receive time (resolving its target handle
// to a workspace/output id NOW, before any subsequent request in the
// batch could renumber or destroy something out from under it) and
// applied in arrival order when commit() fires.
type PendingOp =
  | { kind: "activate"; workspaceId: number; outputId: number; index: number }
  | { kind: "remove"; workspaceId: number; outputId: number; index: number }
  | { kind: "create"; outputId: number; name: string };

// Per-bound-manager state. handles maps the durable WorkspaceHandle to
// the per-manager handle resource; groups maps the outputId to the
// per-manager group resource. `pending` accumulates requests between
// commits; `batching` is set true while commit() is draining `pending`
// so the bus-event broadcast suppresses this manager's per-event done
// (the drain emits exactly one trailing done covering the whole batch).
interface ManagerState {
  resource: ExtWorkspaceManagerV1Resource;
  clientId: number;
  groups: Map<number, ExtWorkspaceGroupHandleV1Resource>;
  handles: Map<number, ExtWorkspaceHandleV1Resource>;
  active: boolean;
  pending: PendingOp[];
  batching: boolean;
}

// Module-local registry. Mirrors the zwlr_foreign_toplevel_manager pattern:
// living outside CompositorState avoids polluting every other handler.
const managers = new Set<ManagerState>();

// A manager whose client disconnected without stop() never ran the stop
// handler: its resource is destroyed but the ManagerState lingers. Minting
// an event on the dead resource returns undefined (which would poison
// handleOwners.set), so treat destroyed as stopped and drop the state on
// sight.
function managerLive(mgr: ManagerState): boolean {
  if (mgr.resource.destroyed) { managers.delete(mgr); return false; }
  return mgr.active;
}

// Per-frame disconnect sweep (wired in installProtocols alongside the
// other protocol sweeps): frees manager state whose client vanished
// without stop(), even when no workspace/output event fires.
export function sweepDisconnected(): void {
  for (const mgr of managers) {
    if (mgr.resource.destroyed) managers.delete(mgr);
  }
}

const handleOwners = new WeakMap<Resource, {
  manager: ManagerState;
  kind: "group" | "workspace";
  workspaceId?: number;
  outputId?: number;
}>();

// Module-local cache of the workspace plugin's state. Updated by the bus
// subscriptions; consulted on every bind for the catch-up burst and on
// every state/coordinates re-emit. Keys are durable WorkspaceHandle ids.
const workspacesCache = new Map<number, WorkspaceInfo>();
// outputId -> the durable WorkspaceHandle currently shown there. Drives
// the `active` bit in the state bitfield.
const shownByOutput = new Map<number, number>();
// outputs the compositor has told us about (via output.added). We hold a
// group resource per output on each manager.
const liveOutputs = new Set<number>();

// Pack the coordinates Wayland array: a 1-D u32 = (index - 1) in
// little-endian host bytes. Coordinates arrays are little-endian on every
// platform Wayland runs on; matching foreign-toplevel's packStates idiom.
function packCoordinates(index: number): Uint8Array {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, index - 1, true);
  return new Uint8Array(buf);
}

// Build the state bitfield (active + urgent) for a workspace. The protocol's
// `hidden` bit is never set -- this compositor never explicitly hides a
// workspace from the UI; "not active" is the only inactive state.
function stateBits(ws: WorkspaceInfo): number {
  let bits = 0;
  if (shownByOutput.get(ws.outputId) === ws.workspaceId) {
    bits |= WS_STATE.active;
  }
  if (ws.urgent) bits |= WS_STATE.urgent;
  return bits;
}

// Look up the wl_output resource bound by this manager's client for
// outputId. Returns null when the client hasn't bound that wl_output yet
// (or the output doesn't exist). The protocol's output_enter argument
// requires a per-client wl_output resource; without one we can't address
// the output to this client. (The client typically binds wl_output before
// the workspace manager; absence in practice means the client just
// doesn't care about outputs.)
function wlOutputForClient(
  ctx: Ctx, clientId: number, outputId: number,
): Resource | null {
  const set = ctx.state.wlOutputResources?.get(outputId);
  if (!set) return null;
  for (const r of set) {
    if (r.destroyed) continue;
    if (ctx.addon.clientId(r) === clientId) return r;
  }
  return null;
}

// ---- Catch-up + per-event emission helpers --------------------------------
// Each helper mutates manager state (adding/removing handles) and emits the
// appropriate wire events. The caller is responsible for emitting a single
// trailing `done` on the manager after all per-handle events for the
// logical change are queued.

// Emit a group + its initial capabilities/output_enter on a single manager.
// Idempotent: a manager already holding a group for outputId is a no-op.
function emitGroupCreate(ctx: Ctx, mgr: ManagerState, outputId: number): void {
  if (mgr.groups.has(outputId)) return;
  const groupRes = ctx.events.ext_workspace_manager_v1
    .send_workspace_group(mgr.resource, null) as ExtWorkspaceGroupHandleV1Resource;
  // Minting on a dead manager resource yields undefined; never let that
  // poison the handle maps.
  if (!groupRes) return;
  mgr.groups.set(outputId, groupRes);
  handleOwners.set(groupRes, { manager: mgr, kind: "group", outputId });
  ctx.events.ext_workspace_group_handle_v1.send_capabilities(
    groupRes, GROUP_CAPS.create_workspace);
  const wlOut = wlOutputForClient(ctx, mgr.clientId, outputId);
  if (wlOut) {
    ctx.events.ext_workspace_group_handle_v1.send_output_enter(
      groupRes, wlOut as ExtWorkspaceGroupHandleV1Resource & Resource);
  }
}

// Tear down a group on a single manager: leave-then-removed-then-drop.
// Per spec the resource stays alive until the client destroys it; we just
// stop tracking it.
function emitGroupRemove(ctx: Ctx, mgr: ManagerState, outputId: number): void {
  const groupRes = mgr.groups.get(outputId);
  if (!groupRes) return;
  const wlOut = wlOutputForClient(ctx, mgr.clientId, outputId);
  if (wlOut) {
    ctx.events.ext_workspace_group_handle_v1.send_output_leave(
      groupRes, wlOut as ExtWorkspaceGroupHandleV1Resource & Resource);
  }
  ctx.events.ext_workspace_group_handle_v1.send_removed(groupRes);
  mgr.groups.delete(outputId);
}

// Emit the workspace + its initial metadata burst on a single manager.
// Workspace must already be in workspacesCache. Includes workspace_enter
// on the owning group (if a group exists for the workspace's output).
function emitWorkspaceCreate(ctx: Ctx, mgr: ManagerState, ws: WorkspaceInfo): void {
  if (mgr.handles.has(ws.workspaceId)) return;
  const wsRes = ctx.events.ext_workspace_manager_v1
    .send_workspace(mgr.resource, null) as ExtWorkspaceHandleV1Resource;
  if (!wsRes) return;
  mgr.handles.set(ws.workspaceId, wsRes);
  handleOwners.set(wsRes, { manager: mgr, kind: "workspace", workspaceId: ws.workspaceId });

  // Initial metadata events: id (durable), name (when present),
  // coordinates (1-D index), state (active/urgent bits), capabilities.
  ctx.events.ext_workspace_handle_v1.send_id(wsRes, String(ws.workspaceId));
  if (ws.name !== undefined) {
    ctx.events.ext_workspace_handle_v1.send_name(wsRes, ws.name);
  }
  ctx.events.ext_workspace_handle_v1.send_coordinates(wsRes, packCoordinates(ws.index));
  ctx.events.ext_workspace_handle_v1.send_state(wsRes, stateBits(ws));
  // Capabilities advertised: activate (this protocol's primary action)
  // and remove (workspaces are destroyable). deactivate is NEVER
  // advertised: the compositor's model guarantees exactly one shown
  // workspace per output, so "deactivate to nothing" doesn't exist.
  // assign is NEVER advertised: the plugin moves windows between
  // workspaces, not workspaces between groups.
  // Advertise activate (the protocol's primary action) and remove. Do NOT
  // advertise deactivate (compositor model has exactly one shown workspace
  // per output) or assign (the plugin moves windows between workspaces,
  // not workspaces between groups). Spec: clients hide UI for unadvertised
  // capabilities and the compositor ignores requests for them.
  ctx.events.ext_workspace_handle_v1.send_capabilities(
    wsRes, WS_CAPS.activate | WS_CAPS.remove);

  // Workspace_enter on its owning group. emitGroupCreate must have run
  // first; in the catch-up path that's the case (we walk outputs then
  // workspaces). For a workspace.created bus event the output's group
  // is already present.
  const groupRes = mgr.groups.get(ws.outputId);
  if (groupRes) {
    ctx.events.ext_workspace_group_handle_v1.send_workspace_enter(groupRes, wsRes);
  }
}

// Tear down a workspace on a single manager: leave-then-removed-then-drop.
function emitWorkspaceRemove(ctx: Ctx, mgr: ManagerState, workspaceId: number,
                             priorOutputId: number): void {
  const wsRes = mgr.handles.get(workspaceId);
  if (!wsRes) return;
  const groupRes = mgr.groups.get(priorOutputId);
  if (groupRes) {
    ctx.events.ext_workspace_group_handle_v1.send_workspace_leave(groupRes, wsRes);
  }
  ctx.events.ext_workspace_handle_v1.send_removed(wsRes);
  mgr.handles.delete(workspaceId);
}

// Re-emit `state` (active + urgent bits) for a workspace on a single manager.
function emitWorkspaceState(ctx: Ctx, mgr: ManagerState, ws: WorkspaceInfo): void {
  const wsRes = mgr.handles.get(ws.workspaceId);
  if (!wsRes) return;
  ctx.events.ext_workspace_handle_v1.send_state(wsRes, stateBits(ws));
}

// Re-emit `coordinates` for a workspace on a single manager.
function emitWorkspaceCoordinates(ctx: Ctx, mgr: ManagerState, ws: WorkspaceInfo): void {
  const wsRes = mgr.handles.get(ws.workspaceId);
  if (!wsRes) return;
  ctx.events.ext_workspace_handle_v1.send_coordinates(wsRes, packCoordinates(ws.index));
}

// Re-emit `name` for a workspace on a single manager.
function emitWorkspaceName(ctx: Ctx, mgr: ManagerState, ws: WorkspaceInfo): void {
  const wsRes = mgr.handles.get(ws.workspaceId);
  if (!wsRes) return;
  ctx.events.ext_workspace_handle_v1.send_name(wsRes, ws.name ?? "");
}

// Broadcast one done() per bound manager. Called at the end of every
// bus-event handler so the atomicity contract (one done per logical
// change per manager) holds.
//
// Managers in `batching` state are skipped: their commit() drain emits
// exactly one done at the end of the batch covering every state change
// the batched requests produced, regardless of how many bus events
// fired during the drain. Non-batching managers see the usual per-event
// done sequence -- their wire view is identical to the pre-batching
// model.
function broadcastDone(ctx: Ctx): void {
  for (const mgr of managers) {
    if (!managerLive(mgr)) continue;
    if (mgr.batching) continue;
    ctx.events.ext_workspace_manager_v1.send_done(mgr.resource);
  }
}

// ---- Bus subscriptions ----------------------------------------------------

// Narrow bus payload helpers. The plugin bus types payloads as `unknown`.
function isObj(v: unknown): v is { [k: string]: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asCreated(p: unknown):
  { handle: number; index: number; outputId: number; name?: string } | null {
  if (!isObj(p)) return null;
  if (typeof p.handle !== "number") return null;
  if (typeof p.index !== "number") return null;
  if (typeof p.outputId !== "number") return null;
  const name = typeof p.name === "string" ? p.name : undefined;
  return { handle: p.handle, index: p.index, outputId: p.outputId, ...(name !== undefined ? { name } : {}) };
}

function asDestroyed(p: unknown):
  { handle: number; outputId: number } | null {
  if (!isObj(p)) return null;
  if (typeof p.handle !== "number") return null;
  if (typeof p.outputId !== "number") return null;
  return { handle: p.handle, outputId: p.outputId };
}

function asShown(p: unknown):
  { handle: number; index: number; outputId: number } | null {
  if (!isObj(p)) return null;
  if (typeof p.handle !== "number") return null;
  if (typeof p.index !== "number") return null;
  if (typeof p.outputId !== "number") return null;
  return { handle: p.handle, index: p.index, outputId: p.outputId };
}

function asRenamed(p: unknown):
  { handle: number; outputId: number; name?: string } | null {
  if (!isObj(p)) return null;
  if (typeof p.handle !== "number") return null;
  if (typeof p.outputId !== "number") return null;
  const name = typeof p.name === "string" ? p.name : undefined;
  return { handle: p.handle, outputId: p.outputId, ...(name !== undefined ? { name } : {}) };
}

function asRenumbered(p: unknown):
  { outputId: number; changes: Array<{ handle: number; newIndex: number }> } | null {
  if (!isObj(p)) return null;
  if (typeof p.outputId !== "number") return null;
  if (!Array.isArray(p.changes)) return null;
  const out: Array<{ handle: number; newIndex: number }> = [];
  for (const c of p.changes) {
    if (!isObj(c)) return null;
    if (typeof c.handle !== "number" || typeof c.newIndex !== "number") return null;
    out.push({ handle: c.handle, newIndex: c.newIndex });
  }
  return { outputId: p.outputId, changes: out };
}

function asUrgencyChanged(p: unknown):
  { workspaceId: number; urgent: boolean; outputId: number } | null {
  if (!isObj(p)) return null;
  if (typeof p.workspaceId !== "number") return null;
  if (typeof p.urgent !== "boolean") return null;
  if (typeof p.outputId !== "number") return null;
  return { workspaceId: p.workspaceId, urgent: p.urgent, outputId: p.outputId };
}

function asOutputEvent(p: unknown): { outputId: number } | null {
  if (!isObj(p)) return null;
  if (typeof p.outputId !== "number") return null;
  return { outputId: p.outputId };
}

// Subscribe to plugin-bus events. Called once from installProtocols. The
// pluginBus may be absent in GPU-free harnesses; in that case the
// protocol is wired but never sees any state changes.
export function installExtWorkspaceBusHooks(ctx: Ctx): void {
  const pluginBus = ctx.state.pluginBus;
  if (!pluginBus) return;

  pluginBus.subscribe("output.added", (_n, payload) => {
    const p = asOutputEvent(payload);
    if (!p) return;
    if (liveOutputs.has(p.outputId)) return;
    liveOutputs.add(p.outputId);
    for (const mgr of managers) {
      if (!managerLive(mgr)) continue;
      emitGroupCreate(ctx, mgr, p.outputId);
    }
    broadcastDone(ctx);
  });

  pluginBus.subscribe("output.removed", (_n, payload) => {
    const p = asOutputEvent(payload);
    if (!p) return;
    if (!liveOutputs.has(p.outputId)) return;
    // The workspace plugin handles migration of workspaces off the
    // removed output BEFORE output.removed fires (see the plugin's
    // output.pre-remove subscription), so by the time we get here no
    // workspace claims this outputId. Drop the per-manager group.
    liveOutputs.delete(p.outputId);
    shownByOutput.delete(p.outputId);
    for (const mgr of managers) {
      if (!managerLive(mgr)) continue;
      emitGroupRemove(ctx, mgr, p.outputId);
    }
    broadcastDone(ctx);
  });

  pluginBus.subscribe("workspace.created", (_n, payload) => {
    const p = asCreated(payload);
    if (!p) return;
    const info: WorkspaceInfo = {
      workspaceId: p.handle, outputId: p.outputId, index: p.index, urgent: false,
      ...(p.name !== undefined ? { name: p.name } : {}),
    };
    workspacesCache.set(p.handle, info);
    // Ensure the group exists on every manager before emitting workspace.
    // output.added normally precedes the first workspace.created on that
    // output (the plugin's boot recompute creates the group first), but
    // be defensive: a workspace created on an output we haven't observed
    // yet still gets a group.
    if (!liveOutputs.has(p.outputId)) {
      liveOutputs.add(p.outputId);
      for (const mgr of managers) {
        if (!managerLive(mgr)) continue;
        emitGroupCreate(ctx, mgr, p.outputId);
      }
    }
    for (const mgr of managers) {
      if (!managerLive(mgr)) continue;
      emitWorkspaceCreate(ctx, mgr, info);
    }
    broadcastDone(ctx);
  });

  pluginBus.subscribe("workspace.destroyed", (_n, payload) => {
    const p = asDestroyed(payload);
    if (!p) return;
    workspacesCache.delete(p.handle);
    for (const mgr of managers) {
      if (!managerLive(mgr)) continue;
      emitWorkspaceRemove(ctx, mgr, p.handle, p.outputId);
    }
    broadcastDone(ctx);
  });

  pluginBus.subscribe("workspace.shown", (_n, payload) => {
    const p = asShown(payload);
    if (!p) return;
    const prev = shownByOutput.get(p.outputId);
    shownByOutput.set(p.outputId, p.handle);
    // Update the index too (the plugin's shown event carries it).
    const info = workspacesCache.get(p.handle);
    if (info) info.index = p.index;
    for (const mgr of managers) {
      if (!managerLive(mgr)) continue;
      if (prev !== undefined && prev !== p.handle) {
        const prevInfo = workspacesCache.get(prev);
        if (prevInfo) emitWorkspaceState(ctx, mgr, prevInfo);
      }
      if (info) emitWorkspaceState(ctx, mgr, info);
    }
    broadcastDone(ctx);
  });

  pluginBus.subscribe("workspace.hidden", (_n, _payload) => {
    // No-op. workspace.hidden always fires immediately before
    // workspace.shown on the plugin bus (registry.show() pushes hidden
    // then shown into one applyEffects pass). The workspace.shown
    // subscription above reads shownByOutput[outputId] to find the
    // PREVIOUS shown handle, emits state(0) for it and state(1) for the
    // new one, then a single done. If this handler mutated
    // shownByOutput, that read in workspace.shown would see undefined
    // and the previously-active workspace's state(0) would never reach
    // the wire -- bound clients would see the new workspace gain active
    // without the old one losing it.
  });

  pluginBus.subscribe("workspace.renamed", (_n, payload) => {
    const p = asRenamed(payload);
    if (!p) return;
    const info = workspacesCache.get(p.handle);
    if (!info) return;
    if (p.name !== undefined) info.name = p.name;
    else delete info.name;
    for (const mgr of managers) {
      if (!managerLive(mgr)) continue;
      emitWorkspaceName(ctx, mgr, info);
    }
    broadcastDone(ctx);
  });

  pluginBus.subscribe("workspace.renumbered", (_n, payload) => {
    const p = asRenumbered(payload);
    if (!p) return;
    for (const c of p.changes) {
      const info = workspacesCache.get(c.handle);
      if (info) info.index = c.newIndex;
    }
    for (const mgr of managers) {
      if (!managerLive(mgr)) continue;
      for (const c of p.changes) {
        const info = workspacesCache.get(c.handle);
        if (info) emitWorkspaceCoordinates(ctx, mgr, info);
      }
    }
    broadcastDone(ctx);
  });

  pluginBus.subscribe("workspace.urgency-changed", (_n, payload) => {
    const p = asUrgencyChanged(payload);
    if (!p) return;
    const info = workspacesCache.get(p.workspaceId);
    if (!info) return;
    info.urgent = p.urgent;
    for (const mgr of managers) {
      if (!managerLive(mgr)) continue;
      emitWorkspaceState(ctx, mgr, info);
    }
    broadcastDone(ctx);
  });
}

// ---- Handler factories ----------------------------------------------------

// Manager handler. `bind` is the synthetic on-bind hook the trampoline
// calls when a client binds the global; runs the catch-up burst.
type ManagerHandlerExt = ExtWorkspaceManagerV1Handler
  & { bind(resource: ExtWorkspaceManagerV1Resource): void };

export default function makeExtWorkspaceManager(ctx: Ctx): ManagerHandlerExt {
  return {
    bind(resource: ExtWorkspaceManagerV1Resource): void {
      const clientId = ctx.addon.clientId(resource);
      const mgr: ManagerState = {
        resource, clientId,
        groups: new Map(), handles: new Map(), active: true,
        pending: [], batching: false,
      };
      managers.add(mgr);

      // Catch-up burst: groups first (so workspace_enter has a target),
      // then workspaces in stable handle order. The catch-up emits its
      // own done() at the end -- per spec the initial state is delivered
      // as one logical event.
      for (const outputId of liveOutputs) {
        emitGroupCreate(ctx, mgr, outputId);
      }
      const sorted = [...workspacesCache.values()]
        .sort((a, b) => a.workspaceId - b.workspaceId);
      for (const ws of sorted) {
        emitWorkspaceCreate(ctx, mgr, ws);
      }
      ctx.events.ext_workspace_manager_v1.send_done(resource);
    },

    commit(resource: ExtWorkspaceManagerV1Resource): void {
      // Drain the pending request queue atomically per spec: "The
      // compositor must process a series of requests preceding a
      // commit request atomically." The mechanic:
      //   1. Find this manager's state; bail if none / inactive / no
      //      pending ops (an empty commit is a legitimate no-op).
      //   2. Mark batching=true so broadcastDone suppresses
      //      per-event done for this manager while we drain.
      //   3. Drain pending in arrival order, calling the driver per op.
      //      Each driver call resolves through runtime.invokeNamespace,
      //      which is async; drives are dispatched fire-and-forget here
      //      (the workspace plugin serializes them by virtue of being
      //      a single in-thread JS module, so order is preserved).
      //   4. After dispatching all ops, await the last one (this is
      //      what gives us "all bus events from this batch fired") and
      //      then clear batching=false + emit exactly one done.
      //
      // Other bound managers see their usual per-event done sequence:
      // only the batching one suppresses, and its drain emits one done
      // for the whole batch. This is the protocol's atomic-commit
      // semantic on the wire.
      let target: ManagerState | null = null;
      for (const mgr of managers) {
        if (mgr.resource === resource) { target = mgr; break; }
      }
      if (!target || !target.active) return;
      if (target.pending.length === 0) return;

      const driver = ctx.state.workspaceDriver;
      const ops = target.pending;
      target.pending = [];
      if (!driver) {
        // No driver to apply requests; dropping the batch matches the
        // "no workspaceDriver: silently drop" behavior of the
        // per-request path. No done emitted (no state changed).
        return;
      }

      target.batching = true;
      // Chain the driver calls so each completes before the next starts.
      // The plugin's actions run on the main JS thread (in-thread
      // bundled), so the chain reduces to "wait for each plugin tick
      // to flush its applyEffects". When the chain settles, every bus
      // event the batch produced has already broadcast (with this
      // manager's per-event done suppressed); we then emit one done
      // covering the whole batch.
      let chain: Promise<unknown> = Promise.resolve();
      for (const op of ops) {
        chain = chain.then(() => {
          switch (op.kind) {
            case "activate":
              return driver.show(op.index, op.outputId);
            case "remove":
              return driver.destroy(op.index, op.outputId);
            case "create": {
              const spec: { outputId: number; name?: string } = { outputId: op.outputId };
              if (op.name !== "") spec.name = op.name;
              return driver.create(spec);
            }
          }
        });
      }
      void chain
        .catch((err: unknown) => {
          log.warn("core", "ext_workspace_v1.commit drain failed: %o", err);
        })
        .finally(() => {
          // The manager may have been stopped or torn down mid-drain;
          // skip done in that case (spec: post-stop requests + events
          // are ignored). Otherwise emit the single batch-trailing done.
          if (!target.active) {
            target.batching = false;
            return;
          }
          target.batching = false;
          ctx.events.ext_workspace_manager_v1.send_done(target.resource);
        });
    },

    stop(resource: ExtWorkspaceManagerV1Resource): void {
      for (const mgr of managers) {
        if (mgr.resource !== resource) continue;
        if (!mgr.active) return;
        mgr.active = false;
        // Drop any uncommitted requests; spec: "The client must not
        // send any requests after [stop]". A request queued before
        // stop but not yet committed never gets the chance to apply.
        mgr.pending.length = 0;
        ctx.events.ext_workspace_manager_v1.send_finished(resource);
        managers.delete(mgr);
        return;
      }
    },
  };
}

export function makeExtWorkspaceGroupHandle(_ctx: Ctx): ExtWorkspaceGroupHandleV1Handler {
  return {
    create_workspace(resource: ExtWorkspaceGroupHandleV1Resource, workspace: string): void {
      const owner = handleOwners.get(resource);
      if (!owner || owner.kind !== "group" || owner.outputId === undefined) return;
      if (!owner.manager.active) return;
      // Queue the request; manager.commit drains it. Spec: requests
      // between commits apply atomically as one batch.
      owner.manager.pending.push({
        kind: "create", outputId: owner.outputId, name: workspace,
      });
    },
    destroy(resource: ExtWorkspaceGroupHandleV1Resource): void {
      const owner = handleOwners.get(resource);
      if (!owner || owner.kind !== "group" || owner.outputId === undefined) return;
      owner.manager.groups.delete(owner.outputId);
      handleOwners.delete(resource);
    },
  };
}

export function makeExtWorkspaceHandle(_ctx: Ctx): ExtWorkspaceHandleV1Handler {
  return {
    activate(resource: ExtWorkspaceHandleV1Resource): void {
      const owner = handleOwners.get(resource);
      if (!owner || owner.kind !== "workspace" || owner.workspaceId === undefined) return;
      if (!owner.manager.active) return;
      const info = workspacesCache.get(owner.workspaceId);
      if (!info) return;
      // Capture index + outputId at receive time. A later op in the
      // same batch could renumber the workspace; the spec's atomic
      // semantic is that THIS request was issued against THIS index.
      owner.manager.pending.push({
        kind: "activate", workspaceId: owner.workspaceId,
        outputId: info.outputId, index: info.index,
      });
    },
    deactivate(_resource: ExtWorkspaceHandleV1Resource): void {
      // Capability not advertised; spec requires the compositor to ignore.
      // The compositor's model guarantees exactly one shown workspace per
      // output, so deactivate-to-nothing has no meaning.
    },
    assign(_resource: ExtWorkspaceHandleV1Resource,
           _workspaceGroup: ExtWorkspaceGroupHandleV1Resource): void {
      // Capability not advertised; spec requires the compositor to ignore.
      // The plugin moves windows between workspaces, not workspaces
      // between groups.
    },
    remove(resource: ExtWorkspaceHandleV1Resource): void {
      const owner = handleOwners.get(resource);
      if (!owner || owner.kind !== "workspace" || owner.workspaceId === undefined) return;
      if (!owner.manager.active) return;
      const info = workspacesCache.get(owner.workspaceId);
      if (!info) return;
      owner.manager.pending.push({
        kind: "remove", workspaceId: owner.workspaceId,
        outputId: info.outputId, index: info.index,
      });
    },
    destroy(resource: ExtWorkspaceHandleV1Resource): void {
      const owner = handleOwners.get(resource);
      if (!owner || owner.kind !== "workspace" || owner.workspaceId === undefined) return;
      owner.manager.handles.delete(owner.workspaceId);
      handleOwners.delete(resource);
    },
  };
}

// Test-only hook to clear all module-local state between compositor
// instances stood up in the same process. Mirrors
// zwlr_foreign_toplevel_manager._resetForTests().
export function _resetForTests(): void {
  managers.clear();
  workspacesCache.clear();
  shownByOutput.clear();
  liveOutputs.clear();
}
