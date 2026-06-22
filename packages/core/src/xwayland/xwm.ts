// XWM policy (TS side). Consumes the decoded X events the native XWM
// (native/xwayland/xwm.cpp) delivers, resolves WL_SURFACE_SERIAL to the
// wl_surface Xwayland created, brings managed windows into overdraw's WM, and
// drives the ICCCM/EWMH property reads that yield title / app_id / size
// constraints / parent / presentation. The close path (WM_DELETE_WINDOW /
// KillClient) lives here too; it is invoked via closeXwaylandSurface.
//
// No xcb here -- the native side owns the X11 wire; this is window-management
// policy.

import type { CompositorState, SurfaceRecord } from "../protocols/ctx.js";
import type { Addon } from "../types.js";
import { markWindowChanged } from "../protocols/window-changes.js";
import { ensureXwaylandState, lookupBySerial } from "./surface.js";
import {
  parseStringProperty,
  parseWmClass,
  parseWmProtocols,
  parseNetWmState,
  parseNetWmWindowType,
  parseTransientFor,
  parseWmNormalHints,
  parseWmHints,
  netWmStateToPresentation,
  classifyWindowType,
  type PropertyAtoms,
  type PropertyReply,
} from "./properties.js";

export interface XwmEventMsg {
  type:
    | "create"
    | "destroy"
    | "map-request"
    | "map"
    | "unmap"
    | "configure-request"
    | "surface-serial"
    | "property-notify"
    | "property-reply";
  window: number;
  x: number;
  y: number;
  width: number;
  height: number;
  overrideRedirect: boolean;
  serialLo: number;
  serialHi: number;
  atom?: number;
  cookieId?: number;
  replyType?: number;
  format?: number;
  data?: Uint8Array;
}

export interface XWindow {
  window: number;             // X11 window id
  x: number;
  y: number;
  width: number;
  height: number;
  overrideRedirect: boolean;
  mapped: boolean;
  surfaceId: number | null;   // resolved via WL_SURFACE_SERIAL
  addedToWm: boolean;
  // Parsed ICCCM / EWMH properties. null until the corresponding property
  // reply has landed (or the property is absent).
  title: string | null;
  appId: string | null;
  wmProtocols: Set<number>;   // atoms (incl. WM_DELETE_WINDOW when supported)
  transientFor: number | null; // X window id of parent toplevel
  minSize: { width: number; height: number } | null;
  maxSize: { width: number; height: number } | null;
  windowKind: ReturnType<typeof classifyWindowType>;
  presentationHint: "fullscreen" | "maximized" | null;
}

// A narrow view stashed on CompositorState so unrelated modules (titleAppId,
// close-surface) can look up X-backed windows or initiate their close path
// without taking a dep on the full Xwm.
export interface XwmStateView {
  findBySurfaceId(surfaceId: number): XWindow | null;
  // Initiate close. Returns true iff a matching X window was found; the
  // close-surface helper uses that to skip the xdg branch.
  closeBySurfaceId(surfaceId: number): boolean;
}

export interface Xwm {
  stop(): void;
  windows(): ReadonlyMap<number, XWindow>;  // inspection (tests)
  // Initiate a close on an x-backed surface, by surfaceId. Sends a
  // WM_DELETE_WINDOW client-message when the client supports it, else
  // KillClient. Returns true iff a matching X window was found.
  closeBySurfaceId(surfaceId: number): boolean;
}

// All properties we batch-read on associate. PropertyNotify on any of these
// also re-reads only the one that changed.
function pickWatchedAtoms(atoms: Record<string, number>): Array<{ name: string; atom: number }> {
  const names = [
    "_NET_WM_NAME", "WM_NAME",
    "WM_CLASS",
    "WM_PROTOCOLS",
    "WM_NORMAL_HINTS",
    "WM_HINTS",
    "WM_TRANSIENT_FOR",
    "_NET_WM_STATE",
    "_NET_WM_WINDOW_TYPE",
  ];
  return names.map((n) => ({ name: n, atom: atoms[n] ?? 0 })).filter((e) => e.atom !== 0);
}

function newXWindow(window: number, x: number, y: number, w: number, h: number,
                    overrideRedirect: boolean): XWindow {
  return {
    window, x, y, width: w, height: h, overrideRedirect,
    mapped: false, surfaceId: null, addedToWm: false,
    title: null, appId: null,
    wmProtocols: new Set<number>(),
    transientFor: null,
    minSize: null, maxSize: null,
    windowKind: null,
    presentationHint: null,
  };
}

// Helpers for the parsers that need the atom-name table. We type-assert here
// because the native side hands us an unstructured Record<string, number>;
// missing atoms (interned to 0) yield property-not-supported behavior in the
// parsers anyway.
function asPropertyAtoms(raw: Record<string, number>): PropertyAtoms {
  const a = (n: string): number => raw[n] ?? 0;
  return {
    WM_PROTOCOLS: a("WM_PROTOCOLS"),
    WM_DELETE_WINDOW: a("WM_DELETE_WINDOW"),
    WM_TAKE_FOCUS: a("WM_TAKE_FOCUS"),
    UTF8_STRING: a("UTF8_STRING"),
    _NET_WM_STATE_FULLSCREEN: a("_NET_WM_STATE_FULLSCREEN"),
    _NET_WM_STATE_MAXIMIZED_VERT: a("_NET_WM_STATE_MAXIMIZED_VERT"),
    _NET_WM_STATE_MAXIMIZED_HORZ: a("_NET_WM_STATE_MAXIMIZED_HORZ"),
    _NET_WM_STATE_MODAL: a("_NET_WM_STATE_MODAL"),
    _NET_WM_WINDOW_TYPE_NORMAL: a("_NET_WM_WINDOW_TYPE_NORMAL"),
    _NET_WM_WINDOW_TYPE_DIALOG: a("_NET_WM_WINDOW_TYPE_DIALOG"),
    _NET_WM_WINDOW_TYPE_UTILITY: a("_NET_WM_WINDOW_TYPE_UTILITY"),
    _NET_WM_WINDOW_TYPE_MENU: a("_NET_WM_WINDOW_TYPE_MENU"),
    _NET_WM_WINDOW_TYPE_DROPDOWN_MENU: a("_NET_WM_WINDOW_TYPE_DROPDOWN_MENU"),
    _NET_WM_WINDOW_TYPE_POPUP_MENU: a("_NET_WM_WINDOW_TYPE_POPUP_MENU"),
    _NET_WM_WINDOW_TYPE_TOOLTIP: a("_NET_WM_WINDOW_TYPE_TOOLTIP"),
    _NET_WM_WINDOW_TYPE_COMBO: a("_NET_WM_WINDOW_TYPE_COMBO"),
  };
}

export function startXwm(state: CompositorState, addon: Addon, wmFd: number): Xwm {
  const windows = new Map<number, XWindow>();
  // X windows that announced their serial before the wayland side registered
  // it; completed when onSerialRegistered fires for that serial.
  const pendingBySerial = new Map<bigint, XWindow>();
  // cookieId -> { window, atomName } for in-flight property reads.
  const pendingReads = new Map<number, { window: number; name: string }>();
  // surfaceId -> X window, populated on association. Cheap reverse lookup for
  // titleAppId / closeBySurfaceId.
  const bySurface = new Map<number, XWindow>();

  // Atoms are not available until xwmStart returns; provisional empty map
  // satisfies the type until then. (No property work happens before the
  // associate path, which runs after xwmStart resolves.)
  let atomsByName: Record<string, number> = {};
  let pa: PropertyAtoms = asPropertyAtoms({});

  ensureXwaylandState(state).onSerialRegistered = (serial, surfaceId) => {
    const w = pendingBySerial.get(serial);
    if (!w) return;
    pendingBySerial.delete(serial);
    w.surfaceId = surfaceId;
    onAssociated(w);
  };

  // A non-override-redirect window that is both mapped and associated with a
  // wl_surface enters the WM. (Override-redirect placement is Phase 3.3.)
  function maybeManage(w: XWindow): void {
    if (w.addedToWm || w.overrideRedirect || !w.mapped || w.surfaceId === null) return;
    const surfRec = state.surfacesById?.get(w.surfaceId);
    if (!surfRec || !state.wm) return;
    // Pick a spawn output: under the pointer if known, else the primary.
    // (X11 has no per-window output hint; the same fallback xdg_surface uses.)
    if (surfRec.spawnOutputId === undefined) {
      surfRec.spawnOutputId = state.wm.primaryOutputId?.();
    }
    state.wm.addWindow(w.surfaceId, surfRec);
    w.addedToWm = true;
    // Plumb the parsed properties (title/appId/constraints/parent/presentation)
    // into the WM now that the window is managed. Order: first markInitial so
    // window.map carries title/appId; then proposals for structural fields.
    publishInitial(w, surfRec);
  }

  function unmanage(w: XWindow): void {
    if (w.addedToWm && w.surfaceId !== null) state.wm?.unmapWindow(w.surfaceId);
    w.addedToWm = false;
  }

  // When a window first associates with a wl_surface: batch-read every
  // ICCCM/EWMH property we care about. Each reply lands as a "property-reply"
  // event; the cookieId routes it back to the right window.
  function onAssociated(w: XWindow): void {
    if (w.surfaceId !== null) bySurface.set(w.surfaceId, w);
    const watched = pickWatchedAtoms(atomsByName);
    for (const e of watched) {
      const cookie = addon.xwmGetProperty(w.window, e.atom);
      pendingReads.set(cookie, { window: w.window, name: e.name });
    }
    // The window may already be mapped; if so, try to manage it now (else
    // wait for the map event). We do this AFTER firing the batch reads so
    // markInitialCommitComplete sees the still-null title/appId only if no
    // reply has come back yet -- and the subsequent property-replies will
    // markWindowChanged to publish the real values.
    maybeManage(w);
  }

  // Translate the parsed property state into wm.markInitialCommitComplete /
  // wm.propose calls. This mirrors the xdg_toplevel boot path (in
  // wl_surface.commit). Idempotent on re-call.
  function publishInitial(w: XWindow, _surfRec: SurfaceRecord): void {
    if (w.surfaceId === null || !state.wm) return;
    state.wm.markInitialCommitComplete?.(w.surfaceId, { appId: w.appId, title: w.title });
    sendStructuralProposals(w);
  }

  // Map parsed properties onto a wm.propose for structural fields. Called on
  // initial associate AND on PropertyNotify re-reads.
  function sendStructuralProposals(w: XWindow): void {
    if (w.surfaceId === null || !w.addedToWm || !state.wm) return;
    const proposal: Parameters<NonNullable<typeof state.wm>["propose"]>[1] = {};
    // Constraints: min/max from WM_NORMAL_HINTS.
    if (w.minSize !== null || w.maxSize !== null) {
      proposal.constraints = { minSize: w.minSize, maxSize: w.maxSize };
    }
    // Parent: WM_TRANSIENT_FOR -> the parent X window's surfaceId, if we know
    // it. (If the parent X window hasn't associated yet, we leave it null;
    // a later PropertyNotify will re-publish.)
    if (w.transientFor !== null) {
      const parent = windows.get(w.transientFor);
      if (parent && parent.surfaceId !== null) proposal.parent = parent.surfaceId;
    }
    // Presentation: derived from _NET_WM_STATE first, then a fallback
    // dialog-hint from _NET_WM_WINDOW_TYPE / WM_TRANSIENT_FOR. The dialog /
    // utility / menu kinds promote to floating via xdg's existing min==max
    // policy when constraints are set; we don't override presentation for
    // them.
    if (w.presentationHint !== null) {
      proposal.presentation = w.presentationHint;
    }
    if (Object.keys(proposal).length > 0) {
      void state.wm.propose(w.surfaceId, proposal, "client-request");
    }
  }

  // Apply a parsed property reply to the XWindow's state. Returns true iff a
  // user-observable field (title/appId) changed -- caller emits window.change.
  function applyProperty(w: XWindow, name: string, p: PropertyReply): boolean {
    let observableChanged = false;
    switch (name) {
      case "_NET_WM_NAME": {
        // _NET_WM_NAME (UTF-8) wins over WM_NAME (Latin-1) when present.
        const v = parseStringProperty(p, pa);
        if (v !== null && v !== w.title) { w.title = v; observableChanged = true; }
        break;
      }
      case "WM_NAME": {
        // Only honored when _NET_WM_NAME absent. We approximate by ignoring
        // WM_NAME if a non-null title was already set from _NET_WM_NAME this
        // session. PropertyNotify on WM_NAME after _NET_WM_NAME is rare; if it
        // happens, the next _NET_WM_NAME read re-wins.
        if (w.title === null) {
          const v = parseStringProperty(p, pa);
          if (v !== null && v !== w.title) { w.title = v; observableChanged = true; }
        }
        break;
      }
      case "WM_CLASS": {
        const v = parseWmClass(p);
        const next = v?.appId ?? null;
        if (next !== w.appId) { w.appId = next; observableChanged = true; }
        break;
      }
      case "WM_PROTOCOLS":
        w.wmProtocols = parseWmProtocols(p);
        break;
      case "WM_NORMAL_HINTS": {
        const v = parseWmNormalHints(p);
        w.minSize = v?.minSize ?? null;
        w.maxSize = v?.maxSize ?? null;
        sendStructuralProposals(w);
        break;
      }
      case "WM_HINTS":
        // parseWmHints currently exposes only the input-model bit (used in
        // 3.4). Storing the parse here keeps the cookie loop tidy.
        parseWmHints(p);
        break;
      case "WM_TRANSIENT_FOR":
        w.transientFor = parseTransientFor(p);
        sendStructuralProposals(w);
        break;
      case "_NET_WM_STATE": {
        const states = parseNetWmState(p);
        w.presentationHint = netWmStateToPresentation(states, pa);
        sendStructuralProposals(w);
        break;
      }
      case "_NET_WM_WINDOW_TYPE": {
        const types = parseNetWmWindowType(p);
        w.windowKind = classifyWindowType(types, pa);
        break;
      }
    }
    return observableChanged;
  }

  function onEvent(ev: XwmEventMsg): void {
    switch (ev.type) {
      case "create":
        windows.set(ev.window,
          newXWindow(ev.window, ev.x, ev.y, ev.width, ev.height, ev.overrideRedirect));
        break;
      case "map-request":
        // Allow the window to map; the compositor shows it once content arrives.
        addon.xwmMapWindow(ev.window);
        break;
      case "map": {
        const w = windows.get(ev.window);
        if (w) { w.mapped = true; maybeManage(w); }
        break;
      }
      case "unmap": {
        const w = windows.get(ev.window);
        if (w) { w.mapped = false; unmanage(w); }
        break;
      }
      case "destroy": {
        const w = windows.get(ev.window);
        if (w) {
          unmanage(w);
          if (w.surfaceId !== null) bySurface.delete(w.surfaceId);
        }
        windows.delete(ev.window);
        break;
      }
      case "configure-request":
        // 3.1 still honors the client's requested geometry verbatim.
        // Compositor-authoritative sizing + synthetic ConfigureNotify is 3.2.
        addon.xwmConfigureWindow(ev.window, ev.x, ev.y, ev.width, ev.height);
        break;
      case "surface-serial": {
        const serial = (BigInt(ev.serialHi >>> 0) << 32n) | BigInt(ev.serialLo >>> 0);
        const w = windows.get(ev.window);
        if (!w) break;
        const surfaceId = lookupBySerial(state, serial);
        if (surfaceId !== null) { w.surfaceId = surfaceId; onAssociated(w); }
        else pendingBySerial.set(serial, w);  // wayland side not registered yet
        break;
      }
      case "property-notify": {
        // A watched property changed; re-read it. We ignore PropertyNotify on
        // windows we haven't seen (e.g. root); the create event mask scopes
        // delivery to managed windows.
        const w = windows.get(ev.window);
        if (!w || ev.atom === undefined) break;
        const name = nameOfAtom(atomsByName, ev.atom);
        if (name === null) break;
        const cookie = addon.xwmGetProperty(ev.window, ev.atom);
        pendingReads.set(cookie, { window: ev.window, name });
        break;
      }
      case "property-reply": {
        if (ev.cookieId === undefined) break;
        const pend = pendingReads.get(ev.cookieId);
        if (!pend) break;
        pendingReads.delete(ev.cookieId);
        const w = windows.get(pend.window);
        if (!w) break;  // window destroyed before reply arrived
        const reply: PropertyReply = {
          window: pend.window,
          atom: ev.atom ?? 0,
          cookieId: ev.cookieId,
          replyType: ev.replyType ?? 0,
          format: ev.format ?? 0,
          data: ev.data ?? new Uint8Array(0),
        };
        const observableChanged = applyProperty(w, pend.name, reply);
        if (observableChanged && w.addedToWm && w.surfaceId !== null) {
          // window.change ("title" / "appId") goes through the standard flush
          // (window-changes.ts), which calls back into titleAppId -- which
          // reads from XWindow now.
          markWindowChanged(state, w.surfaceId,
            pend.name === "WM_CLASS" ? "appId" : "title");
        }
        break;
      }
    }
  }

  // Reverse-lookup atom -> name. The watched-atom list is small (~9 entries)
  // so a linear scan is fine; building an inverse map at startup would also work.
  function nameOfAtom(table: Record<string, number>, atom: number): string | null {
    for (const [name, value] of Object.entries(table)) {
      if (value === atom) return name;
    }
    return null;
  }

  const startResult = addon.xwmStart(wmFd, onEvent);
  atomsByName = startResult.atoms;
  pa = asPropertyAtoms(atomsByName);

  function closeBySurfaceId(surfaceId: number): boolean {
    const w = bySurface.get(surfaceId);
    if (!w) return false;
    if (w.wmProtocols.has(pa.WM_DELETE_WINDOW)) {
      addon.xwmSendWmProtocol(w.window, pa.WM_DELETE_WINDOW);
    } else {
      addon.xwmKillClient(w.window);
    }
    return true;
  }

  // Stash a view on CompositorState so titleAppId / closeSurface can reach
  // x-backed windows without taking a dep on the full Xwm.
  state.xwm = {
    findBySurfaceId(surfaceId) { return bySurface.get(surfaceId) ?? null; },
    closeBySurfaceId,
  };

  return {
    stop() {
      addon.xwmStop();
      state.xwm = undefined;
    },
    windows() { return windows; },
    closeBySurfaceId,
  };
}
