// Byte-level parsers for the X11 properties the XWM cares about. Pure
// functions: no xcb, no compositor state. The native xcb side delivers raw
// {atom, type, format, data} via "property-reply" events; this module turns
// those bytes into the typed values the WM uses (title, app_id, presentation,
// constraints, parent, protocols).
//
// The X protocol is little-endian on every host overdraw runs on (xcb_setup's
// image_byte_order is LSBFirst on Linux/x86_64/aarch64). We read with that
// assumption; if a future big-endian X server appears, switch to the
// connection's image_byte_order. Format gives the unit size:
//   - format=8  -> raw bytes
//   - format=16 -> u16 array (we don't currently parse any 16-bit property)
//   - format=32 -> u32 array; the X wire actually transports 32-bit values
//     padded to 4 bytes regardless of arch, so .byteLength / 4 is the count.
//
// Strings: WM_NAME / WM_CLASS are STRING (Latin-1) per ICCCM. _NET_WM_NAME is
// UTF8_STRING per EWMH. We decode UTF-8 when `type === UTF8_STRING`, Latin-1
// otherwise.

// Reply shape native delivers (matches deliverXwmEvent in napi_xwayland.cpp:
// PropertyReply branch). `data` is a Node Buffer; empty when the property was
// absent (format=0, length=0).
export interface PropertyReply {
  window: number;
  atom: number;
  cookieId: number;
  replyType: number;  // X atom -- the type the property is stored as
  format: number;     // 0 if property absent, else 8 / 16 / 32
  data: Uint8Array;   // Buffer extends Uint8Array
}

// Atom map: name -> interned X atom value. The xwmStart return passes this in;
// parsers receive only the subset they need.
export interface PropertyAtoms {
  WM_PROTOCOLS: number;
  WM_DELETE_WINDOW: number;
  WM_TAKE_FOCUS: number;
  UTF8_STRING: number;
  _NET_WM_STATE_FULLSCREEN: number;
  _NET_WM_STATE_MAXIMIZED_VERT: number;
  _NET_WM_STATE_MAXIMIZED_HORZ: number;
  _NET_WM_STATE_MODAL: number;
  _NET_WM_WINDOW_TYPE_NORMAL: number;
  _NET_WM_WINDOW_TYPE_DIALOG: number;
  _NET_WM_WINDOW_TYPE_UTILITY: number;
  _NET_WM_WINDOW_TYPE_MENU: number;
  _NET_WM_WINDOW_TYPE_DROPDOWN_MENU: number;
  _NET_WM_WINDOW_TYPE_POPUP_MENU: number;
  _NET_WM_WINDOW_TYPE_TOOLTIP: number;
  _NET_WM_WINDOW_TYPE_COMBO: number;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
// Latin-1 decoding: each byte is its own codepoint.
function decodeLatin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

// Trim trailing NULs (ICCCM WM_CLASS uses NUL separators; some clients append
// a trailing one to other strings too).
function trimTrailingNuls(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0) end--;
  return end === s.length ? s : s.slice(0, end);
}

// Decode a STRING / UTF8_STRING property into a JS string. `null` when the
// property is absent (format=0).
export function parseStringProperty(p: PropertyReply, atoms: { UTF8_STRING: number }): string | null {
  if (p.format === 0 || p.data.length === 0) return null;
  const raw = p.replyType === atoms.UTF8_STRING ? utf8Decoder.decode(p.data) : decodeLatin1(p.data);
  return trimTrailingNuls(raw);
}

// WM_CLASS is two NUL-terminated STRINGs back-to-back: instance, then class.
// EWMH/ICCCM convention treats the second (class) as the application's app_id
// equivalent, which is what xdg-shell calls app_id. Returns null when absent.
export function parseWmClass(p: PropertyReply): { instance: string; appId: string } | null {
  if (p.format === 0 || p.data.length === 0) return null;
  // Latin-1: each byte is one character. Find the first NUL (instance/class
  // separator) and the trailing NUL (end of class).
  let sep = -1;
  for (let i = 0; i < p.data.length; i++) {
    if (p.data[i] === 0) { sep = i; break; }
  }
  if (sep < 0) {
    // Malformed (no separator). Treat the whole thing as the class name.
    return { instance: "", appId: trimTrailingNuls(decodeLatin1(p.data)) };
  }
  const instance = decodeLatin1(p.data.subarray(0, sep));
  const rest = p.data.subarray(sep + 1);
  const appId = trimTrailingNuls(decodeLatin1(rest));
  return { instance, appId };
}

// View `data` as a u32 array (little-endian). `data.byteLength` may not be a
// multiple of 4 for malformed clients; we round down.
function asU32(data: Uint8Array): Uint32Array {
  const n = (data.byteLength / 4) | 0;
  if (n === 0) return new Uint32Array(0);
  // Align to a fresh ArrayBuffer if `data` is not 4-aligned (Buffer slices
  // generally aren't). Cheap; properties are short.
  if ((data.byteOffset & 3) === 0) {
    return new Uint32Array(data.buffer, data.byteOffset, n);
  }
  const copy = new Uint8Array(n * 4);
  copy.set(data.subarray(0, n * 4));
  return new Uint32Array(copy.buffer, 0, n);
}

// WM_PROTOCOLS: an ATOM[] list. Returns the set of protocol atoms the client
// supports (e.g. WM_DELETE_WINDOW, WM_TAKE_FOCUS).
export function parseWmProtocols(p: PropertyReply): Set<number> {
  const out = new Set<number>();
  if (p.format !== 32 || p.data.length < 4) return out;
  const a = asU32(p.data);
  for (let i = 0; i < a.length; i++) out.add(a[i]);
  return out;
}

// _NET_WM_STATE: an ATOM[] list of state hints currently set on the window.
// Returns the set; the caller maps fullscreen / maximized / modal atoms to a
// Presentation.
export function parseNetWmState(p: PropertyReply): Set<number> {
  const out = new Set<number>();
  if (p.format !== 32 || p.data.length < 4) return out;
  const a = asU32(p.data);
  for (let i = 0; i < a.length; i++) out.add(a[i]);
  return out;
}

// _NET_WM_WINDOW_TYPE: an ATOM[] list of window-type hints. EWMH says the
// first-supported type in client-priority order wins; we return the full list
// and let the caller choose.
export function parseNetWmWindowType(p: PropertyReply): number[] {
  if (p.format !== 32 || p.data.length < 4) return [];
  const a = asU32(p.data);
  return Array.from(a);
}

// WM_TRANSIENT_FOR: a WINDOW (u32). Returns the X window id of the parent, or
// null when absent.
export function parseTransientFor(p: PropertyReply): number | null {
  if (p.format !== 32 || p.data.length < 4) return null;
  const a = asU32(p.data);
  return a[0] === 0 ? null : a[0];
}

// WM_NORMAL_HINTS (XSizeHints, ICCCM §4.1.2.3). 18 INT32 fields:
//   [0] flags
//   [1..4] obsolete (x,y,width,height) -- ignored
//   [5..6] min_width, min_height       (PMinSize    = 1<<4 = 16)
//   [7..8] max_width, max_height       (PMaxSize    = 1<<5 = 32)
//   [9..10] width_inc, height_inc      (PResizeInc  = 1<<6 = 64)  -- unused (xdg has no equivalent)
//   [11..14] min/max aspect ratios     (PAspect     = 1<<7 = 128) -- unused
//   [15..16] base_width, base_height   (PBaseSize   = 1<<8 = 256) -- unused (xdg has no base)
//   [17] win_gravity                                              -- unused
//
// xdg_toplevel exposes only min_size / max_size; this parser returns those.
const SIZE_HINTS_PMINSIZE = 1 << 4;
const SIZE_HINTS_PMAXSIZE = 1 << 5;

export interface SizeHints {
  minSize: { width: number; height: number } | null;
  maxSize: { width: number; height: number } | null;
}

export function parseWmNormalHints(p: PropertyReply): SizeHints | null {
  if (p.format !== 32 || p.data.length < 18 * 4) return null;
  const a = asU32(p.data);
  // The X flags field is logically u32; minSize/maxSize as INT32. Cast via
  // DataView to honor sign for the size fields (negative values are nonsense
  // but we should treat them as absent).
  const flags = a[0];
  const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const i32 = (idx: number): number => dv.getInt32(idx * 4, true);
  const minW = i32(5), minH = i32(6);
  const maxW = i32(7), maxH = i32(8);
  let minSize: { width: number; height: number } | null = null;
  let maxSize: { width: number; height: number } | null = null;
  if ((flags & SIZE_HINTS_PMINSIZE) !== 0 && minW > 0 && minH > 0) {
    minSize = { width: minW, height: minH };
  }
  if ((flags & SIZE_HINTS_PMAXSIZE) !== 0 && maxW > 0 && maxH > 0) {
    maxSize = { width: maxW, height: maxH };
  }
  return { minSize, maxSize };
}

// WM_HINTS (XWMHints, ICCCM §4.1.2.4):
//   [0] flags
//   [1] input                          (InputHint   = 1<<0 = 1)
//   [2] initial_state
//   [3..7] icon_pixmap / icon_window / icon_x / icon_y / icon_mask -- unused
//   [8] window_group
//
// We currently only care about `input` (focus model decision in 3.4).
const WM_HINTS_INPUT_HINT = 1 << 0;

export interface WmHints {
  input: boolean | null;   // null when InputHint bit unset
}

export function parseWmHints(p: PropertyReply): WmHints | null {
  if (p.format !== 32 || p.data.length < 9 * 4) return null;
  const a = asU32(p.data);
  const flags = a[0];
  const input = (flags & WM_HINTS_INPUT_HINT) !== 0 ? a[1] !== 0 : null;
  return { input };
}

// Map the _NET_WM_STATE atom set to overdraw's Presentation. EWMH allows
// multiple states simultaneously (e.g. fullscreen + maximized); precedence
// follows the design doc:
//   1. fullscreen wins over maximized
//   2. maximized (vert OR horz; we treat either as the "maximized" presentation)
//   3. else null (caller keeps current presentation; default "managed")
export function netWmStateToPresentation(
  states: Set<number>,
  atoms: Pick<PropertyAtoms,
    "_NET_WM_STATE_FULLSCREEN" |
    "_NET_WM_STATE_MAXIMIZED_VERT" |
    "_NET_WM_STATE_MAXIMIZED_HORZ">,
): "fullscreen" | "maximized" | null {
  if (states.has(atoms._NET_WM_STATE_FULLSCREEN)) return "fullscreen";
  if (states.has(atoms._NET_WM_STATE_MAXIMIZED_VERT)
      || states.has(atoms._NET_WM_STATE_MAXIMIZED_HORZ)) {
    return "maximized";
  }
  return null;
}

// _NET_WM_STATE_MODAL: the client wishes the window to be treated as
// modal relative to its WM_TRANSIENT_FOR. The X equivalent of
// xdg_dialog_v1.set_modal. Mapped onto clientRequests.wantsModal in xwm.
export function netWmStateIsModal(
  states: Set<number>,
  atoms: Pick<PropertyAtoms, "_NET_WM_STATE_MODAL">,
): boolean {
  return states.has(atoms._NET_WM_STATE_MODAL);
}

// _NET_WM_WINDOW_TYPE: classify the highest-priority recognized type. Used by
// the WM to promote dialogs/utility/menus to floating (Phase 3 reuses the
// existing xdg dialog/transient-for floating policy via wm.propose).
export type WindowKind = "normal" | "dialog" | "utility" | "menu" | "tooltip" | "combo" | null;

export function classifyWindowType(
  types: readonly number[],
  atoms: Pick<PropertyAtoms,
    "_NET_WM_WINDOW_TYPE_NORMAL" |
    "_NET_WM_WINDOW_TYPE_DIALOG" |
    "_NET_WM_WINDOW_TYPE_UTILITY" |
    "_NET_WM_WINDOW_TYPE_MENU" |
    "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU" |
    "_NET_WM_WINDOW_TYPE_POPUP_MENU" |
    "_NET_WM_WINDOW_TYPE_TOOLTIP" |
    "_NET_WM_WINDOW_TYPE_COMBO">,
): WindowKind {
  // Walk the client-supplied list in order (EWMH says the client orders by
  // preference). Stop at the first one we recognize.
  for (const a of types) {
    if (a === atoms._NET_WM_WINDOW_TYPE_NORMAL) return "normal";
    if (a === atoms._NET_WM_WINDOW_TYPE_DIALOG) return "dialog";
    if (a === atoms._NET_WM_WINDOW_TYPE_UTILITY) return "utility";
    if (a === atoms._NET_WM_WINDOW_TYPE_MENU) return "menu";
    if (a === atoms._NET_WM_WINDOW_TYPE_DROPDOWN_MENU) return "menu";
    if (a === atoms._NET_WM_WINDOW_TYPE_POPUP_MENU) return "menu";
    if (a === atoms._NET_WM_WINDOW_TYPE_TOOLTIP) return "tooltip";
    if (a === atoms._NET_WM_WINDOW_TYPE_COMBO) return "combo";
  }
  return null;
}

// _NET_STARTUP_ID: an opaque ASCII id the launcher set on the window
// (matched against the SI message the launcher emitted via dbus). Stored
// as 8-bit data; spec is ASCII but we decode as Latin-1 since the bytes
// are an opaque token. Returns null when the property is absent.
export function parseStartupId(p: PropertyReply): string | null {
  if (p.format !== 8 || p.data.length === 0) return null;
  return trimTrailingNuls(decodeLatin1(p.data));
}

// _NET_WM_ICON: a CARDINAL[][2+N] of (width, height, ARGB pixels...). Each
// icon is `2 + width*height` u32 words; the property is the concatenation
// of one or more icons of different sizes. Returns the parsed list (empty
// when the property is absent or malformed). Pixels are 0xAARRGGBB,
// premultiplied alpha (EWMH §5.7).
export function parseNetWmIcon(p: PropertyReply): Array<{
  width: number; height: number; pixels: Uint32Array;
}> {
  if (p.format !== 32 || p.data.length < 12) return [];
  const a = asU32(p.data);
  const out: Array<{ width: number; height: number; pixels: Uint32Array }> = [];
  let i = 0;
  while (i + 2 <= a.length) {
    const w = a[i], h = a[i + 1];
    // Defensive: refuse zero / absurdly large dims (a malformed icon would
    // otherwise mis-slice into the next entry).
    if (w === 0 || h === 0 || w > 16384 || h > 16384) break;
    const n = w * h;
    if (i + 2 + n > a.length) break;  // truncated
    out.push({ width: w, height: h, pixels: a.slice(i + 2, i + 2 + n) });
    i += 2 + n;
  }
  return out;
}
