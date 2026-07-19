// xkbcommon keysym name -> numeric value, for the most common keys users bind.
// Values mirror <xkbcommon/xkbcommon-keysyms.h> exactly; the full set is
// thousands of symbols, but a hotkey config never needs the rare ones (Tibetan
// letters, dead keys, etc.).
//
// Lookup is case-insensitive on the name (so "Return" and "return" both work);
// the xkb keysym values are case-sensitive on the original name.

const SYMS: { [name: string]: number } = {
  // Whitespace / control
  Return: 0xff0d,
  Enter: 0xff0d,           // alias
  Escape: 0xff1b,
  Tab: 0xff09,
  BackSpace: 0xff08,
  Backspace: 0xff08,       // common typo
  Delete: 0xffff,
  Space: 0x0020,
  space: 0x0020,
  // Navigation
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Home: 0xff50,
  End: 0xff57,
  Page_Up: 0xff55,
  PageUp: 0xff55,
  Page_Down: 0xff56,
  PageDown: 0xff56,
  Insert: 0xff63,
  // Function keys
  F1:  0xffbe, F2:  0xffbf, F3:  0xffc0, F4:  0xffc1,
  F5:  0xffc2, F6:  0xffc3, F7:  0xffc4, F8:  0xffc5,
  F9:  0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
  // Punctuation that often appears in hotkeys
  comma: 0x002c,
  period: 0x002e,
  slash: 0x002f,
  semicolon: 0x003b,
  apostrophe: 0x0027,
  grave: 0x0060,
  bracketleft: 0x005b,
  bracketright: 0x005d,
  backslash: 0x005c,
  minus: 0x002d,
  equal: 0x003d,
  plus: 0x002b,
  // Lock keys (rarely bound but available)
  Caps_Lock: 0xffe5,
  Num_Lock: 0xff7f,
  Scroll_Lock: 0xff14,
  // Misc
  Print: 0xff61,
  Menu: 0xff67,
  Pause: 0xff13,
  // Media / brightness (XF86 keysyms from <xkbcommon/xkbcommon-keysyms.h>)
  XF86AudioMute: 0x1008ff12,
  XF86AudioLowerVolume: 0x1008ff11,
  XF86AudioRaiseVolume: 0x1008ff13,
  XF86AudioMicMute: 0x1008ffb2,
  XF86AudioPlay: 0x1008ff14,
  XF86AudioPause: 0x1008ff31,
  XF86AudioStop: 0x1008ff15,
  XF86AudioPrev: 0x1008ff16,
  XF86AudioNext: 0x1008ff17,
  XF86MonBrightnessUp: 0x1008ff02,
  XF86MonBrightnessDown: 0x1008ff03,
};

// Letters a-z map directly to ASCII code points (the X11 keysym convention).
for (let c = 0x61; c <= 0x7a; c++) {
  SYMS[String.fromCharCode(c)] = c;        // "a" .. "z"
  SYMS[String.fromCharCode(c - 0x20)] = c; // "A" .. "Z" -> same keysym (lower)
}
// Digits 0-9 map to ASCII directly.
for (let c = 0x30; c <= 0x39; c++) SYMS[String.fromCharCode(c)] = c;

// Case-insensitive lookup table built once.
const CI: { [lower: string]: number } = {};
for (const [k, v] of Object.entries(SYMS)) CI[k.toLowerCase()] = v;

// True for keysyms produced by modifier keys (Shift, Ctrl, Alt, Super,
// AltGr, locks). The binding chain treats an unbound press of these as
// neutral: it may be arming modifiers for a later chord step, so it never
// cancels a chord in progress.
export function isModifierKeysym(sym: number): boolean {
  return (sym >= 0xffe1 && sym <= 0xffee)   // Shift_L .. Hyper_R
    || sym === 0xfe03 || sym === 0xfe11     // ISO_Level3/5_Shift (AltGr)
    || sym === 0xff7e || sym === 0xff7f;    // Mode_switch, Num_Lock
}

// Resolve a keysym name to its numeric value, or null if unknown. Names are
// matched case-insensitively. Both XKB-style ("Return") and lowercase
// ("return") names work.
export function keysymOf(name: string): number | null {
  if (typeof name !== "string" || name.length === 0) return null;
  const v = CI[name.toLowerCase()];
  return v ?? null;
}

// Reverse lookup: numeric keysym to canonical name (the XKB-style spelling).
// Used in diagnostic messages. Returns hex literal when no name is known.
const NAMES: { [n: number]: string } = {};
for (const [k, v] of Object.entries(SYMS)) {
  // Prefer the first inserted name for each value (e.g. "Return", not "Enter").
  if (NAMES[v] === undefined) NAMES[v] = k;
}
export function keysymName(sym: number): string {
  return NAMES[sym] ?? `0x${sym.toString(16)}`;
}
