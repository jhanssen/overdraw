// X11 CLIPBOARD / PRIMARY selection bridge. Mediates between Wayland's
// wl_data_device / zwp_primary_selection_device_v1 and the X selections
// so a copy in an X client can be pasted into a Wayland client and vice
// versa. No xcb here -- native owns the X11 wire; this is policy.
//
// Two directions, both gated on an X client being X-focused:
//
//   X owns -> Wayland pastes (incoming)
//     xfixes-selection-notify -> ConvertSelection(TARGETS) onto our owner
//     window -> SelectionNotify -> read property -> resolve atoms to MIMEs
//     -> publish state.xClipboardSource / xPrimarySource for the wl side
//     to re-push the focused client's data_device. wl_data_offer.receive
//     on an X-backed offer kicks off a per-mime ConvertSelection on a
//     fresh per-transfer X window; SelectionNotify reads the property,
//     INCR is driven by PropertyNotify(NewValue) until a zero-length new
//     value signals end-of-stream.
//
//   Wayland owns -> X pastes (outgoing)
//     wl set_selection -> SetSelectionOwner on our owner window. xfixes
//     self-notify caches the X timestamp. SelectionRequest from an X
//     requestor: TARGETS / TIMESTAMP / MULTIPLE / data target. For data
//     targets, allocate a pipe; wl_data_source.send_send takes the write
//     end; we drain the read end on the libuv loop. Up to 64 KiB is sent
//     as one property; larger transfers switch to INCR (property type =
//     INCR, value = total-size hint; subsequent chunks on each
//     PropertyNotify(Delete) on the requestor's destination property).
//     A zero-length read is EOF: the last chunk (non-INCR) or one final
//     empty property (INCR).
//
// MIME <-> X target translation: UTF8_STRING <-> text/plain;charset=utf-8,
// TEXT / STRING <-> text/plain; everything else passes through verbatim if
// the atom name contains "/" (heuristic for a sane MIME string), else is
// dropped.

import * as fs from "node:fs";
import type { CompositorState } from "../protocols/ctx.js";
import type { Addon, Resource } from "../types.js";
import type { Xwm, XwmEventMsg } from "./xwm.js";
import { SELECTION_EVENT } from "../events/window-bus.js";

// 64 KiB. Above this, outgoing transfers switch to INCR.
const INCR_CHUNK_SIZE = 64 * 1024;

// xfixes-select-selection-input mask: all three change kinds.
//   SET_SELECTION_OWNER          = 1
//   SELECTION_WINDOW_DESTROY     = 2
//   SELECTION_CLIENT_CLOSE       = 4
const XFIXES_MASK_ALL = 0x7;

// X event-mask bits.
const EVENT_PROPERTY_CHANGE = 1 << 22;   // 0x00400000
const EVENT_SUBSTRUCTURE_NOTIFY = 1 << 19;   // 0x00080000
const SEL_WIN_MASK = EVENT_PROPERTY_CHANGE | EVENT_SUBSTRUCTURE_NOTIFY;

// xcb_property_state values.
const PROPERTY_NEW_VALUE = 0;
const PROPERTY_DELETE = 1;

// X11 predefined atoms (xproto.h XA_*). Hard-coded -- the X server
// allocates them at startup with fixed values; they are not interned.
const XA_ATOM = 4;
const XA_INTEGER = 19;

// ---------- pure helpers (exported for unit tests) ----------

/**
 * Translate an X target atom name to a wayland MIME type, or null if the
 * target should not be surfaced on the wayland side (selection-protocol
 * metadata, clipboard-manager privates, or X-specific compound types we
 * don't translate).
 */
export function mimeFromAtomName(name: string): string | null {
  if (name === "UTF8_STRING") return "text/plain;charset=utf-8";
  if (name === "TEXT" || name === "STRING") return "text/plain";
  if (name === "TARGETS" || name === "TIMESTAMP" || name === "MULTIPLE"
      || name === "DELETE" || name === "INCR" || name === "SAVE_TARGETS") {
    return null;
  }
  // Names containing "/" are treated as MIME strings verbatim. Atoms
  // without "/" are X-specific (e.g. _QT_TASKBAR_ICON) and would produce
  // MIME strings the wayland receiver cannot honor; drop them.
  if (name.includes("/")) return name;
  return null;
}

/** Translate a wayland MIME type to the canonical X atom name to intern. */
export function atomNameFromMime(mime: string): string {
  if (mime === "text/plain;charset=utf-8") return "UTF8_STRING";
  if (mime === "text/plain") return "TEXT";
  return mime;
}

/**
 * Parse a CARDINAL32 atom array from a property reply payload. Format is
 * assumed to be 32; data length must be a multiple of 4 (we round down on
 * malformed input).
 */
export function parseAtomArray(data: Uint8Array): number[] {
  const n = (data.byteLength / 4) | 0;
  if (n === 0) return [];
  // Buffer subarrays may not be 4-aligned; copy to a fresh ArrayBuffer when
  // needed.
  let view: DataView;
  if ((data.byteOffset & 3) === 0) {
    view = new DataView(data.buffer, data.byteOffset, n * 4);
  } else {
    const copy = new Uint8Array(n * 4);
    copy.set(data.subarray(0, n * 4));
    view = new DataView(copy.buffer);
  }
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

/**
 * Decide whether an outgoing transfer should switch to INCR. Pure helper
 * for unit testing; returns true iff the source's accumulated buffer has
 * reached the chunk-size boundary without EOF, meaning we cannot fit the
 * payload in a single property write.
 */
export function shouldSwitchToIncr(bufferTotal: number, eof: boolean): boolean {
  return !eof && bufferTotal >= INCR_CHUNK_SIZE;
}

// ---------- bridge ----------

export type SelectionKind = "clipboard" | "primary";

// X-backed selection source advertised to wayland. When the wayland
// receiver calls wl_data_offer.receive(mime, fd), `receive` triggers a
// per-mime ConvertSelection.
export interface XSelectionSource {
  mimes: string[];
  receive(mime: string, fd: number): void;
}

interface BridgeAtoms {
  CLIPBOARD: number;
  PRIMARY: number;
  TARGETS: number;
  TIMESTAMP: number;
  INCR: number;
  TEXT: number;
  STRING: number;
  MULTIPLE: number;
  DELETE: number;
  CLIPBOARD_MANAGER: number;
  OVERDRAW_SELECTION: number;
  UTF8_STRING: number;
}

function readAtoms(xwm: Xwm): BridgeAtoms {
  const a = xwm.atoms();
  const g = (n: string): number => a[n] ?? 0;
  return {
    CLIPBOARD: g("CLIPBOARD"),
    PRIMARY: g("PRIMARY"),
    TARGETS: g("TARGETS"),
    TIMESTAMP: g("TIMESTAMP"),
    INCR: g("INCR"),
    TEXT: g("TEXT"),
    STRING: g("STRING"),
    MULTIPLE: g("MULTIPLE"),
    DELETE: g("DELETE"),
    CLIPBOARD_MANAGER: g("CLIPBOARD_MANAGER"),
    OVERDRAW_SELECTION: g("_OVERDRAW_SELECTION"),
    UTF8_STRING: g("UTF8_STRING"),
  };
}

interface IncomingTransfer {
  window: number;
  mime: string;
  mimeAtom: number;
  fd: number;          // wayland-receiver pipe write-fd (bridge owns + closes)
  incr: boolean;       // first SelectionNotify revealed INCR type
  pendingReadCookie: number;
}

interface OutgoingTransfer {
  requestor: number;
  selection: number;
  target: number;
  property: number;
  mime: string;
  timestamp: number;   // SelectionRequest's X timestamp, echoed in our reply
  pipeReadFd: number;
  readStream: fs.ReadStream;
  buffer: Buffer[];
  bufferTotal: number;
  incr: boolean;
  eof: boolean;
  selectionNotifySent: boolean;
  // INCR continuation gating: true after we've written a chunk (or the
  // INCR header) and are waiting for the requestor's PROPERTY_DELETE.
  // While true, no further property writes happen -- a second
  // ChangeProperty(REPLACE) before the requestor reads would clobber
  // the prior chunk. Flipped to false in onRequestorPropertyDelete; the
  // delete handler immediately writes the next chunk and flips back true.
  awaitingRequestorAck: boolean;
  // For INCR transfers: set once we've written the final empty property
  // (EOF signal). The next PROPERTY_DELETE on the requestor's destination
  // property destroys the transfer.
  eofPropertyWritten: boolean;
}

interface SelectionInstance {
  kind: SelectionKind;
  selectionAtom: number;
  ownerWindow: number;       // bridge-owned; X selection sits here when wl owns
  ownerTimestamp: number;    // cached from xfixes self-notify
  xOwner: number;            // most recently observed X owner
  // Incoming (X -> wl) state.
  xSource: XSelectionSource | null;
  targetsReadCookie: number;
  pendingAtomNames: Map<number, number>;   // cookieId -> atom
  resolvingAtoms: number[];
  resolvedNames: Map<number, string | null>;
  incomingTransfers: Map<number, IncomingTransfer>;  // by transfer window
  // Outgoing (wl -> X) state.
  wlSource: Resource | null;
  wlSourceProtocol: "data" | "primary" | null;
  outgoingTransfers: Map<number, OutgoingTransfer>;  // by requestor
}

export interface SelectionBridge {
  stop(): void;
  // Called by the wl side when a wayland client claims or releases a
  // selection. protocol distinguishes wl_data_source ("data") from
  // zwp_primary_selection_source_v1 ("primary") for the dispatch on
  // outgoing SelectionRequests.
  onWlSelectionChanged(
    kind: SelectionKind, source: Resource | null,
    protocol: "data" | "primary",
  ): void;
  // Called by wl_data_offer.receive (and primary equivalent) for X-backed
  // offers. Returns true iff handled; the caller must NOT also forward to
  // a wl source. fd is owned by the bridge from here.
  receiveForXSource(kind: SelectionKind, mime: string, fd: number): boolean;
}

export function startSelectionBridge(
  state: CompositorState, addon: Addon, xwm: Xwm,
): SelectionBridge {
  const atoms = readAtoms(xwm);

  // Bridge-owned windows: selection-owner windows + per-incoming-transfer
  // windows. PropertyNotify on these is routed to the bridge.
  const ownedWindows = new Set<number>();
  // Requestor windows we have selected PROPERTY_CHANGE on, for outgoing
  // INCR continuation. We unselect on transfer destroy.
  const watchedRequestors = new Set<number>();

  // Cached MIME <-> atom mappings. Atoms are connection-scoped so one
  // cache serves both selections.
  const mimeToAtom = new Map<string, number>();
  const atomToMime = new Map<number, string>();

  function lookupMimeAtomSync(mime: string): number {
    const cached = mimeToAtom.get(mime);
    if (cached !== undefined) return cached;
    const name = atomNameFromMime(mime);
    const atom = addon.xwmInternAtom(name);
    if (atom !== 0) {
      mimeToAtom.set(mime, atom);
      atomToMime.set(atom, mime);
    }
    return atom;
  }

  // Synchronous atom -> MIME for the standard set; null for "drop";
  // undefined for "unknown, must xwmGetAtomName".
  function knownAtomMime(atom: number): string | null | undefined {
    if (atom === atoms.UTF8_STRING) return "text/plain;charset=utf-8";
    if (atom === atoms.TEXT || atom === atoms.STRING) return "text/plain";
    if (atom === atoms.TARGETS || atom === atoms.TIMESTAMP
        || atom === atoms.MULTIPLE || atom === atoms.DELETE
        || atom === atoms.INCR) return null;
    return undefined;
  }

  function selAtomOf(kind: SelectionKind): number {
    return kind === "clipboard" ? atoms.CLIPBOARD : atoms.PRIMARY;
  }

  function makeInstance(kind: SelectionKind): SelectionInstance {
    const window = addon.xwmCreateSelectionWindow(SEL_WIN_MASK, false);
    ownedWindows.add(window);
    addon.xwmXfixesSelectSelectionInput(window, selAtomOf(kind), XFIXES_MASK_ALL);
    return {
      kind, selectionAtom: selAtomOf(kind), ownerWindow: window,
      ownerTimestamp: 0, xOwner: 0,
      xSource: null, targetsReadCookie: 0,
      pendingAtomNames: new Map(), resolvingAtoms: [], resolvedNames: new Map(),
      incomingTransfers: new Map(),
      wlSource: null, wlSourceProtocol: null,
      outgoingTransfers: new Map(),
    };
  }

  const sels: Record<SelectionKind, SelectionInstance> = {
    clipboard: makeInstance("clipboard"),
    primary: makeInstance("primary"),
  };

  function selByAtom(a: number): SelectionInstance | null {
    if (a === atoms.CLIPBOARD) return sels.clipboard;
    if (a === atoms.PRIMARY) return sels.primary;
    return null;
  }
  function selByOwnerWindow(w: number): SelectionInstance | null {
    if (w === sels.clipboard.ownerWindow) return sels.clipboard;
    if (w === sels.primary.ownerWindow) return sels.primary;
    return null;
  }
  function findIncomingTransfer(w: number): {
    sel: SelectionInstance; t: IncomingTransfer;
  } | null {
    for (const k of ["clipboard", "primary"] as const) {
      const t = sels[k].incomingTransfers.get(w);
      if (t) return { sel: sels[k], t };
    }
    return null;
  }
  function findOutgoingTransferByRequestor(w: number): {
    sel: SelectionInstance; t: OutgoingTransfer;
  } | null {
    for (const k of ["clipboard", "primary"] as const) {
      const t = sels[k].outgoingTransfers.get(w);
      if (t) return { sel: sels[k], t };
    }
    return null;
  }

  function publishXSource(sel: SelectionInstance): void {
    if (sel.kind === "clipboard") state.xClipboardSource = sel.xSource;
    else state.xPrimarySource = sel.xSource;
    state.onXSelectionAvailable?.(sel.kind);
    // Same broadcast wl_data_device's set_selection makes -- subscribers
    // that bypass keyboard-focus gating (data-control) need to learn that
    // an X-backed source took ownership of this selection.
    state.bus?.emit(SELECTION_EVENT.changed, { kind: sel.kind });
  }

  // ---- focus gate ----

  function xClientFocused(): boolean {
    return xwm.xFocusedWindow() !== null;
  }

  // ---- INCOMING (X -> wl) ----

  function startTargetsProbe(sel: SelectionInstance, timestamp: number): void {
    // Stash a marker so the SelectionNotify reaches onIncomingTargetsNotify.
    addon.xwmConvertSelection(
      sel.ownerWindow, sel.selectionAtom, atoms.TARGETS,
      atoms.OVERDRAW_SELECTION, timestamp);
  }

  function onIncomingTargetsNotify(sel: SelectionInstance, ev: XwmEventMsg): void {
    if ((ev.property ?? 0) === 0) {
      // Conversion refused.
      sel.xSource = null;
      publishXSource(sel);
      return;
    }
    const cookie = addon.xwmGetProperty(sel.ownerWindow, atoms.OVERDRAW_SELECTION, 4096);
    sel.targetsReadCookie = cookie;
  }

  function onIncomingTargetsRead(sel: SelectionInstance, ev: XwmEventMsg): void {
    sel.targetsReadCookie = 0;
    addon.xwmDeleteProperty(sel.ownerWindow, atoms.OVERDRAW_SELECTION);
    if ((ev.format ?? 0) !== 32 || !ev.data || ev.data.byteLength < 4) {
      sel.xSource = null;
      publishXSource(sel);
      return;
    }
    const targetAtoms = parseAtomArray(ev.data);
    sel.resolvingAtoms = targetAtoms;
    sel.resolvedNames = new Map();
    sel.pendingAtomNames = new Map();
    for (const a of targetAtoms) {
      const known = knownAtomMime(a);
      if (known !== undefined) {
        sel.resolvedNames.set(a, known);
      } else {
        const cookie = addon.xwmGetAtomName(a);
        sel.pendingAtomNames.set(cookie, a);
      }
    }
    maybeCommitTargets(sel);
  }

  function onAtomNameReply(ev: XwmEventMsg): void {
    const cookie = ev.cookieId ?? 0;
    if (cookie === 0) return;
    for (const k of ["clipboard", "primary"] as const) {
      const sel = sels[k];
      const atomValue = sel.pendingAtomNames.get(cookie);
      if (atomValue === undefined) continue;
      sel.pendingAtomNames.delete(cookie);
      sel.resolvedNames.set(atomValue, mimeFromAtomName(ev.name ?? ""));
      maybeCommitTargets(sel);
      return;
    }
  }

  function maybeCommitTargets(sel: SelectionInstance): void {
    if (sel.pendingAtomNames.size > 0) return;
    const mimes: string[] = [];
    const seen = new Set<string>();
    for (const a of sel.resolvingAtoms) {
      const m = sel.resolvedNames.get(a);
      if (m && !seen.has(m)) { seen.add(m); mimes.push(m); }
    }
    sel.resolvingAtoms = [];
    sel.resolvedNames.clear();
    if (mimes.length === 0) {
      sel.xSource = null;
    } else {
      sel.xSource = {
        mimes,
        receive: (mime, fd) => startIncomingTransfer(sel, mime, fd),
      };
    }
    publishXSource(sel);
  }

  function startIncomingTransfer(
    sel: SelectionInstance, mime: string, fd: number,
  ): void {
    const mimeAtom = lookupMimeAtomSync(mime);
    if (mimeAtom === 0) { fsCloseSafe(fd); return; }
    const window = addon.xwmCreateSelectionWindow(SEL_WIN_MASK, false);
    if (window === 0) { fsCloseSafe(fd); return; }
    ownedWindows.add(window);
    const transfer: IncomingTransfer = {
      window, mime, mimeAtom, fd,
      incr: false, pendingReadCookie: 0,
    };
    sel.incomingTransfers.set(window, transfer);
    addon.xwmConvertSelection(
      window, sel.selectionAtom, mimeAtom,
      atoms.OVERDRAW_SELECTION, 0 /*XCB_CURRENT_TIME*/);
  }

  function onIncomingTransferNotify(
    sel: SelectionInstance, t: IncomingTransfer, ev: XwmEventMsg,
  ): void {
    if ((ev.property ?? 0) === 0) {
      destroyIncomingTransfer(sel, t);
      return;
    }
    const cookie = addon.xwmGetProperty(t.window, atoms.OVERDRAW_SELECTION, 65536);
    t.pendingReadCookie = cookie;
  }



  function onIncomingTransferRead(
    sel: SelectionInstance, t: IncomingTransfer, ev: XwmEventMsg,
  ): void {
    t.pendingReadCookie = 0;
    const replyType = ev.replyType ?? 0;
    const data = ev.data ?? new Uint8Array(0);
    // Delete the property so the next chunk's NEW_VALUE fires properly.
    addon.xwmDeleteProperty(t.window, atoms.OVERDRAW_SELECTION);

    if (replyType === atoms.INCR) {
      // First-property INCR header; the owner waits for our delete (above)
      // before sending the first chunk. Subsequent PropertyNotify(NewValue)
      // events on this window carry chunks.
      t.incr = true;
      return;
    }
    // Non-INCR path: a single property contains the whole payload.
    if (!t.incr) {
      if (data.byteLength > 0) writeAllSync(t.fd, data);
      destroyIncomingTransfer(sel, t);
      return;
    }
    // INCR continuation: each NEW_VALUE read with non-zero bytes is a
    // chunk; zero-length terminates the stream.
    if (data.byteLength === 0) {
      destroyIncomingTransfer(sel, t);
      return;
    }
    writeAllSync(t.fd, data);
  }

  function onIncomingPropertyNotify(
    _sel: SelectionInstance, t: IncomingTransfer, ev: XwmEventMsg,
  ): void {
    if (ev.atom !== atoms.OVERDRAW_SELECTION) return;
    if (ev.propertyState !== PROPERTY_NEW_VALUE) return;
    if (!t.incr) return;
    if (t.pendingReadCookie !== 0) return;   // already reading
    const cookie = addon.xwmGetProperty(t.window, atoms.OVERDRAW_SELECTION, 65536);
    t.pendingReadCookie = cookie;
  }

  function destroyIncomingTransfer(sel: SelectionInstance, t: IncomingTransfer): void {
    sel.incomingTransfers.delete(t.window);
    fsCloseSafe(t.fd);
    addon.xwmDestroyWindow(t.window);
    ownedWindows.delete(t.window);
  }

  // ---- OUTGOING (wl -> X) ----

  function onWlSelectionChangedImpl(
    kind: SelectionKind, source: Resource | null,
    protocol: "data" | "primary",
  ): void {
    const sel = sels[kind];
    if (source !== null) {
      sel.wlSource = source;
      sel.wlSourceProtocol = protocol;
      addon.xwmSetSelectionOwner(sel.selectionAtom, sel.ownerWindow, 0);
      return;
    }
    // Release.
    if (sel.wlSource !== null) {
      addon.xwmSetSelectionOwner(sel.selectionAtom, 0, sel.ownerTimestamp);
      sel.wlSource = null;
      sel.wlSourceProtocol = null;
    }
    for (const t of [...sel.outgoingTransfers.values()]) destroyOutgoingTransfer(sel, t);
  }

  function onSelectionRequest(ev: XwmEventMsg): void {
    const sel = selByAtom(ev.selection ?? 0);
    if (!sel) return;
    const requestor = ev.requestor ?? 0;
    const target = ev.target ?? 0;
    const evProperty = ev.property ?? 0;
    const property = evProperty !== 0 ? evProperty : target;
    const timestamp = ev.timestamp ?? 0;

    // Refuse if wayland doesn't currently own the selection or if the
    // X-side owner is not us. (CLIPBOARD_MANAGER is a no-op short-circuit
    // -- a separate selection atom that requestors use to ask "please
    // preserve my clipboard contents"; we accept and do nothing.)
    if (target === atoms.CLIPBOARD_MANAGER) {
      addon.xwmSendSelectionNotify(requestor, sel.selectionAtom, target, property, timestamp);
      return;
    }
    if (sel.wlSource === null || sel.xOwner !== sel.ownerWindow) {
      refuse(requestor, sel.selectionAtom, target, timestamp);
      return;
    }
    // Stale timestamp guard.
    if (timestamp !== 0 && sel.ownerTimestamp !== 0
        && timestamp < sel.ownerTimestamp) {
      refuse(requestor, sel.selectionAtom, target, timestamp);
      return;
    }

    if (target === atoms.TARGETS) {
      replyTargets(sel, requestor, property, timestamp);
      return;
    }
    if (target === atoms.TIMESTAMP) {
      replyTimestamp(sel, requestor, property, timestamp);
      return;
    }
    if (target === atoms.MULTIPLE) {
      refuse(requestor, sel.selectionAtom, target, timestamp);
      return;
    }

    const mime = targetAtomToMime(target);
    if (mime === null) {
      refuse(requestor, sel.selectionAtom, target, timestamp);
      return;
    }

    // Stale-transfer purge: a second SelectionRequest from the same
    // requestor invalidates the previous reply (the requestor only ever
    // reads the latest one; leaving the prior pending hangs the bridge).
    const prior = sel.outgoingTransfers.get(requestor);
    if (prior) destroyOutgoingTransfer(sel, prior);

    startOutgoingTransfer(sel, requestor, target, property, mime, timestamp);
  }

  function targetAtomToMime(atom: number): string | null {
    const known = knownAtomMime(atom);
    if (known !== undefined) return known;
    const cached = atomToMime.get(atom);
    if (cached !== undefined) return cached;
    // Unadvertised target. We could async-resolve via xwmGetAtomName, but
    // SelectionRequest semantics expect a bounded-time reply; refuse rather
    // than block.
    return null;
  }

  function replyTargets(
    sel: SelectionInstance, requestor: number, property: number, timestamp: number,
  ): void {
    const mimes = mimesForOutgoing(sel);
    const list: number[] = [atoms.TIMESTAMP, atoms.TARGETS];
    for (const m of mimes) {
      const a = lookupMimeAtomSync(m);
      if (a !== 0) list.push(a);
    }
    const buf = new Uint32Array(list);
    addon.xwmChangeProperty(requestor, property, XA_ATOM, 32, buf, list.length);
    addon.xwmSendSelectionNotify(requestor, sel.selectionAtom, atoms.TARGETS, property, timestamp);
  }

  function replyTimestamp(
    sel: SelectionInstance, requestor: number, property: number, timestamp: number,
  ): void {
    const buf = new Uint32Array([sel.ownerTimestamp]);
    addon.xwmChangeProperty(requestor, property, XA_INTEGER, 32, buf, 1);
    addon.xwmSendSelectionNotify(requestor, sel.selectionAtom, atoms.TIMESTAMP, property, timestamp);
  }

  function refuse(requestor: number, selection: number, target: number, timestamp: number): void {
    addon.xwmSendSelectionNotify(requestor, selection, target, 0, timestamp);
  }

  function mimesForOutgoing(sel: SelectionInstance): string[] {
    const source = sel.wlSource;
    if (!source) return [];
    if (sel.wlSourceProtocol === "data") {
      return state.dataSources?.get(source)?.mimes ?? [];
    }
    return state.primarySources?.get(source)?.mimes ?? [];
  }

  function startOutgoingTransfer(
    sel: SelectionInstance, requestor: number, target: number, property: number,
    mime: string, timestamp: number,
  ): void {
    const source = sel.wlSource;
    if (!source) {
      refuse(requestor, sel.selectionAtom, target, timestamp);
      return;
    }
    let readFd = -1, writeFd = -1;
    try {
      const p = addon.makePipe();
      readFd = p.readFd; writeFd = p.writeFd;
    } catch {
      refuse(requestor, sel.selectionAtom, target, timestamp);
      return;
    }

    // Subscribe to PROPERTY_CHANGE on the requestor so we observe
    // PROPERTY_DELETE (INCR-continuation signal). Independent of the
    // client's own mask.
    addon.xwmSelectWindowEvents(requestor, EVENT_PROPERTY_CHANGE);
    watchedRequestors.add(requestor);

    const readStream = fs.createReadStream("", { fd: readFd, autoClose: false });
    const transfer: OutgoingTransfer = {
      requestor, selection: sel.selectionAtom, target, property, mime, timestamp,
      pipeReadFd: readFd, readStream,
      buffer: [], bufferTotal: 0,
      incr: false, eof: false, selectionNotifySent: false,
      awaitingRequestorAck: false, eofPropertyWritten: false,
    };
    sel.outgoingTransfers.set(requestor, transfer);

    const onDataOrEof = (): void => {
      // Two phases:
      //   - Pre-INCR: pumpOutgoing decides whether to switch to INCR or
      //     emit a single small property. Bytes accumulate in the buffer.
      //   - INCR: pumpOutgoing is a no-op; chunks are written only in
      //     response to the requestor's PROPERTY_DELETE. EOF, however,
      //     may need to flush a terminator immediately if the requestor
      //     is already waiting -- otherwise the transfer deadlocks.
      if (!transfer.incr) {
        pumpOutgoing(sel, transfer);
      } else {
        maybeWriteNextIncrChunk(transfer);
      }
    };
    readStream.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      transfer.buffer.push(buf);
      transfer.bufferTotal += buf.byteLength;
      onDataOrEof();
    });
    readStream.on("end", () => {
      transfer.eof = true;
      onDataOrEof();
    });
    readStream.on("error", () => {
      transfer.eof = true;
      onDataOrEof();
    });

    // Hand the write-fd to the wayland source. send_send expects a WaylandFd
    // wrapper; the wire transfers the dup'd fd to the source client and
    // closes its end here. Our `readFd` is independent (it's the other end
    // of the kernel pipe).
    const wrapped = addon.wrapFd(writeFd);
    if (sel.wlSourceProtocol === "data") {
      state.events?.wl_data_source.send_send(source, mime, wrapped);
    } else {
      state.events?.zwp_primary_selection_source_v1.send_send(source, mime, wrapped);
    }
  }

  function pumpOutgoing(sel: SelectionInstance, t: OutgoingTransfer): void {
    if (t.incr) {
      // Once we're in INCR mode, the requestor's PROPERTY_DELETE on its
      // destination property is the SOLE driver of chunk writes -- not
      // ReadStream data events. Buffer accumulates; the next PROPERTY_DELETE
      // calls maybeWriteNextIncrChunk to actually write. This avoids racing
      // the X server with two ChangeProperty(REPLACE)s back-to-back (the
      // second would clobber the first before the requestor reads it).
      return;
    }

    // Pre-INCR: buffer until 64 KiB or EOF.
    if (!shouldSwitchToIncr(t.bufferTotal, t.eof) && !t.eof) return;

    if (t.eof && t.bufferTotal <= INCR_CHUNK_SIZE) {
      // Small transfer: one property + SelectionNotify, done.
      const all = takeBytes(t, INCR_CHUNK_SIZE);
      writeBytesProperty(t.requestor, t.property, all, t.target);
      addon.xwmSendSelectionNotify(
        t.requestor, t.selection, t.target, t.property, t.timestamp);
      t.selectionNotifySent = true;
      destroyOutgoingTransfer(sel, t);
      return;
    }

    // Large: switch to INCR. Write the INCR-typed property (value = size
    // hint, 4 bytes), send SelectionNotify, then continue chunking on
    // PROPERTY_DELETE.
    //
    // The size hint is just informational for the requestor (most ignore
    // it). We don't know the final size yet (the wl source hasn't EOF'd);
    // pass the current buffered size as a best-effort upper bound and
    // accept that this is approximate.
    t.incr = true;
    const hint = new Uint32Array([t.bufferTotal]);
    addon.xwmChangeProperty(t.requestor, t.property, atoms.INCR, 32, hint, 1);
    addon.xwmSendSelectionNotify(
      t.requestor, t.selection, t.target, t.property, t.timestamp);
    t.selectionNotifySent = true;
    t.awaitingRequestorAck = true;
    // The requestor will PROPERTY_DELETE the destination property after it
    // reads the INCR header; that triggers the first chunk write via
    // maybeWriteNextIncrChunk.
  }

  // Write the next INCR chunk if the requestor is ready (i.e. has acked
  // the previous one via PROPERTY_DELETE). Skip if we're still awaiting
  // ack, or if EOF has already been signaled. Called from:
  //   - onRequestorPropertyDelete (the requestor just acked)
  //   - ReadStream 'end' (EOF arrived while requestor was already ready;
  //     write the zero-length terminator now rather than wait for data
  //     that will never come)
  function maybeWriteNextIncrChunk(t: OutgoingTransfer): void {
    if (t.eofPropertyWritten) return;
    if (t.awaitingRequestorAck) return;
    if (t.bufferTotal === 0 && !t.eof) return;
    const chunk = takeBytes(t, INCR_CHUNK_SIZE);
    writeOutgoingChunk(t, chunk);
    t.awaitingRequestorAck = true;
  }

  function writeBytesProperty(
    window: number, property: number, data: Buffer, type: number,
  ): void {
    // Even a zero-length write must call xwmChangeProperty (REPLACE) so the
    // requestor sees a NEW_VALUE PropertyNotify.
    addon.xwmChangeProperty(window, property, type, 8, data, data.byteLength);
  }

  function writeOutgoingChunk(t: OutgoingTransfer, chunk: Buffer): void {
    writeBytesProperty(t.requestor, t.property, chunk, t.target);
    if (chunk.byteLength === 0) {
      t.eofPropertyWritten = true;
    }
  }

  function takeBytes(t: OutgoingTransfer, max: number): Buffer {
    if (t.bufferTotal === 0) return Buffer.alloc(0);
    const out: Buffer[] = [];
    let taken = 0;
    while (t.buffer.length > 0 && taken < max) {
      const head = t.buffer[0];
      const remaining = max - taken;
      if (head.byteLength <= remaining) {
        out.push(head);
        taken += head.byteLength;
        t.buffer.shift();
      } else {
        out.push(head.subarray(0, remaining));
        t.buffer[0] = head.subarray(remaining);
        taken += remaining;
      }
    }
    t.bufferTotal -= taken;
    return Buffer.concat(out, taken);
  }

  function onRequestorPropertyDelete(t: OutgoingTransfer): void {
    const sel = sels[t.selection === atoms.CLIPBOARD ? "clipboard" : "primary"];
    if (t.eofPropertyWritten) {
      // EOF acknowledged by the requestor; tear down.
      destroyOutgoingTransfer(sel, t);
      return;
    }
    // Requestor consumed the previous chunk (or the INCR header) and is
    // ready for the next. Flip the gate, then write whatever's queued
    // (or wait, if no data has arrived yet on the pipe).
    t.awaitingRequestorAck = false;
    maybeWriteNextIncrChunk(t);
  }

  function destroyOutgoingTransfer(sel: SelectionInstance, t: OutgoingTransfer): void {
    sel.outgoingTransfers.delete(t.requestor);
    try { t.readStream.destroy(); } catch { /* ignore */ }
    fsCloseSafe(t.pipeReadFd);
    // Unsubscribe from PROPERTY_CHANGE on the requestor IF we have no
    // other outgoing transfers to it. (Two selections to the same
    // requestor concurrently is rare but legal.)
    if (!hasAnyOutgoingToRequestor(t.requestor)) {
      addon.xwmSelectWindowEvents(t.requestor, 0);
      watchedRequestors.delete(t.requestor);
    }
    if (!t.selectionNotifySent) {
      refuse(t.requestor, t.selection, t.target, t.timestamp);
    }
  }

  function hasAnyOutgoingToRequestor(requestor: number): boolean {
    return sels.clipboard.outgoingTransfers.has(requestor)
        || sels.primary.outgoingTransfers.has(requestor);
  }

  // ---- xfixes-selection-notify ----

  function onXfixesSelectionNotify(ev: XwmEventMsg): void {
    const sel = selByAtom(ev.selection ?? 0);
    if (!sel) return;
    const newOwner = ev.selectionOwner ?? 0;
    const timestamp = ev.timestamp ?? 0;
    sel.xOwner = newOwner;

    if (newOwner === sel.ownerWindow) {
      sel.ownerTimestamp = timestamp;
      sel.xSource = null;
      publishXSource(sel);
      return;
    }
    if (newOwner === 0) {
      sel.xSource = null;
      publishXSource(sel);
      return;
    }
    if (!xClientFocused()) {
      sel.xSource = null;
      publishXSource(sel);
      return;
    }
    startTargetsProbe(sel, timestamp);
  }

  // ---- top-level event dispatch ----

  function onSelectionNotify(ev: XwmEventMsg): void {
    const requestor = ev.requestor ?? 0;
    const sel = selByOwnerWindow(requestor);
    if (sel) { onIncomingTargetsNotify(sel, ev); return; }
    const tx = findIncomingTransfer(requestor);
    if (tx) { onIncomingTransferNotify(tx.sel, tx.t, ev); return; }
  }

  function onPropertyNotify(ev: XwmEventMsg): void {
    const window = ev.window;
    // Incoming transfer INCR continuation (NEW_VALUE on bridge-owned window).
    const tx = findIncomingTransfer(window);
    if (tx) { onIncomingPropertyNotify(tx.sel, tx.t, ev); return; }
    // Outgoing transfer INCR continuation (DELETE on requestor).
    if (ev.propertyState === PROPERTY_DELETE && watchedRequestors.has(window)) {
      const out = findOutgoingTransferByRequestor(window);
      if (out && ev.atom === out.t.property) {
        onRequestorPropertyDelete(out.t);
      } else {
      }
    }
  }

  function onPropertyReply(ev: XwmEventMsg): void {
    const cookie = ev.cookieId ?? 0;
    if (cookie === 0) return;
    for (const k of ["clipboard", "primary"] as const) {
      if (sels[k].targetsReadCookie === cookie) {
        onIncomingTargetsRead(sels[k], ev);
        return;
      }
    }
    for (const k of ["clipboard", "primary"] as const) {
      for (const t of sels[k].incomingTransfers.values()) {
        if (t.pendingReadCookie === cookie) {
          onIncomingTransferRead(sels[k], t, ev);
          return;
        }
      }
    }
  }

  function onHookedEvent(ev: XwmEventMsg): void {
    switch (ev.type) {
      case "xfixes-selection-notify": onXfixesSelectionNotify(ev); break;
      case "selection-request": onSelectionRequest(ev); break;
      case "selection-notify": onSelectionNotify(ev); break;
      case "property-notify": onPropertyNotify(ev); break;
      case "property-reply": onPropertyReply(ev); break;
      case "atom-name-reply": onAtomNameReply(ev); break;
    }
  }

  function propertyOwner(window: number): boolean {
    return ownedWindows.has(window) || watchedRequestors.has(window);
  }

  xwm.setSelectionHook(onHookedEvent, propertyOwner);

  return {
    stop() {
      for (const sel of [sels.clipboard, sels.primary]) {
        if (sel.xOwner === sel.ownerWindow) {
          addon.xwmSetSelectionOwner(sel.selectionAtom, 0, sel.ownerTimestamp);
        }
        addon.xwmDestroyWindow(sel.ownerWindow);
        ownedWindows.delete(sel.ownerWindow);
        for (const t of [...sel.incomingTransfers.values()]) {
          destroyIncomingTransfer(sel, t);
        }
        for (const t of [...sel.outgoingTransfers.values()]) {
          destroyOutgoingTransfer(sel, t);
        }
      }
      xwm.setSelectionHook(null, null);
      state.xClipboardSource = null;
      state.xPrimarySource = null;
    },
    onWlSelectionChanged: onWlSelectionChangedImpl,
    receiveForXSource(kind, mime, fd) {
      const sel = sels[kind];
      if (!sel.xSource) return false;
      // The X-side source might have advertised a MIME not in our cache.
      // mimes is the canonical list; trust the wl-side to only call us for
      // a MIME we advertised.
      sel.xSource.receive(mime, fd);
      return true;
    },
  };
}

function fsCloseSafe(fd: number): void {
  try { fs.closeSync(fd); } catch { /* ignore */ }
}

function writeAllSync(fd: number, buf: Uint8Array): void {
  let off = 0;
  while (off < buf.byteLength) {
    try {
      const n = fs.writeSync(fd, buf, off, buf.byteLength - off);
      if (n <= 0) break;
      off += n;
    } catch {
      break;
    }
  }
}
