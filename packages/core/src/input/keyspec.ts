// Parse a human-written key specification ("Mod+Shift+Return") into a
// KeyStep. Single-step and chord (KeyStep[]) shapes are both supported via
// parseSpec (single) and parseChord (array or "step1, step2").
//
// Modifier name -> X11 modifier bit mask:
//   Shift  0x01
//   Lock   0x02   (Caps_Lock; usually NOT used in bindings)
//   Ctrl   0x04
//   Alt    0x08   (Mod1; the typical Alt/Meta assignment in stock keymaps)
//   Mod2   0x10   (typically NumLock; included for completeness; not aliased)
//   Mod3   0x20
//   Mod    0x40   (Mod4; the Super/Logo/Windows key in stock keymaps)
//   Mod5   0x80   (typically AltGr / ISO_Level3_Shift)
//
// Aliases:  Mod = Super = Logo = Mod4 = 0x40
//           Ctrl = Control
//           Alt = Mod1
//
// Limitations of v1:
// - No layout-specific keysym aliases (we don't map "1" to the digit "1"
//   under a Dvorak layout; the user's keymap is what xkb resolves at match
//   time). The parser produces what the user TYPED; the seat compares
//   against the xkb-resolved keysym from the current state.
// - No release-event bindings ("up" half of a key). Bindings fire on
//   key-down only.
// - No mouse buttons. Keyboard only.

import { keysymOf, keysymName } from "./keysyms.js";

// X11 modifier bits (matching what xkb_state_serialize_mods returns).
export const MOD_SHIFT = 0x01;
export const MOD_LOCK = 0x02;
export const MOD_CTRL = 0x04;
export const MOD_MOD1 = 0x08;        // typically Alt
export const MOD_MOD2 = 0x10;        // typically NumLock
export const MOD_MOD3 = 0x20;
export const MOD_MOD4 = 0x40;        // typically Super/Logo
export const MOD_MOD5 = 0x80;        // typically AltGr

// One step of a binding: a set of modifier bits + a keysym. Equality is
// (modsMask === modsMask) && (keysym === keysym); see stepsEqual below.
export interface KeyStep {
  // Bit mask of modifiers that must be held when the key is pressed for the
  // step to match. Unstated modifiers (e.g. NumLock) are IGNORED at match
  // time -- only the bits set here are compared.
  mods: number;
  // The keysym (post-xkb-resolution) the key resolves to.
  keysym: number;
}

const MOD_ALIASES: { [name: string]: number } = {
  shift: MOD_SHIFT,
  ctrl: MOD_CTRL,
  control: MOD_CTRL,
  alt: MOD_MOD1,
  mod1: MOD_MOD1,
  mod2: MOD_MOD2,
  mod3: MOD_MOD3,
  mod: MOD_MOD4,
  super: MOD_MOD4,
  logo: MOD_MOD4,
  mod4: MOD_MOD4,
  mod5: MOD_MOD5,
  altgr: MOD_MOD5,
};

// Parse one step ("Mod+Shift+Return"). Tokens are split on '+'. The last
// token is the keysym; everything before is a modifier name. Whitespace is
// trimmed between tokens. Throws TypeError on shape errors (empty input,
// unknown modifier, unknown keysym).
export function parseSpec(spec: string): KeyStep {
  if (typeof spec !== "string") {
    throw new TypeError("key spec must be a string");
  }
  const trimmed = spec.trim();
  if (trimmed.length === 0) throw new TypeError("key spec is empty");

  const tokens = trimmed.split("+").map((t) => t.trim());
  if (tokens.some((t) => t.length === 0)) {
    throw new TypeError(`key spec has empty token: '${spec}'`);
  }
  const keyToken = tokens[tokens.length - 1];
  const modTokens = tokens.slice(0, -1);

  let mods = 0;
  for (const m of modTokens) {
    const bit = MOD_ALIASES[m.toLowerCase()];
    if (bit === undefined) {
      throw new TypeError(
        `unknown modifier '${m}' in key spec '${spec}'; ` +
        `known: Shift, Ctrl, Alt, Mod (=Super/Logo), Mod2..Mod5`);
    }
    if ((mods & bit) !== 0) {
      throw new TypeError(`duplicate modifier '${m}' in key spec '${spec}'`);
    }
    mods |= bit;
  }
  const keysym = keysymOf(keyToken);
  if (keysym === null) {
    throw new TypeError(
      `unknown keysym '${keyToken}' in key spec '${spec}'; ` +
      `see packages/core/src/input/keysyms.ts for the supported set`);
  }
  return { mods, keysym };
}

// Parse a chord. Accepts:
//   - a single string "Mod+a, Mod+b" or "Mod+a Mod+b" (commas or spaces
//     between steps; whichever the user prefers),
//   - an array of step strings ["Mod+a", "Mod+b"],
//   - a pre-parsed array of KeyStep.
// Always returns KeyStep[] with at least one step.
export function parseChord(input: string | readonly string[] | readonly KeyStep[]): KeyStep[] {
  if (Array.isArray(input)) {
    if (input.length === 0) throw new TypeError("chord is empty");
    const out: KeyStep[] = [];
    for (const step of input) {
      if (typeof step === "string") {
        out.push(parseSpec(step));
      } else if (isKeyStep(step)) {
        out.push({ mods: step.mods, keysym: step.keysym });
      } else {
        throw new TypeError(`chord entry must be a string or KeyStep, got ${typeof step}`);
      }
    }
    return out;
  }
  if (typeof input !== "string") {
    throw new TypeError("chord must be a string or array");
  }
  // Split on commas OR runs of whitespace; both are accepted.
  const parts = input.split(/[,\s]+/).filter((s) => s.length > 0);
  if (parts.length === 0) throw new TypeError(`chord is empty: '${input}'`);
  return parts.map(parseSpec);
}

function isKeyStep(v: unknown): v is KeyStep {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { [k: string]: unknown };
  return typeof o.mods === "number" && typeof o.keysym === "number";
}

// Render a KeyStep back to its canonical "Mod+Shift+Key" string. Used in
// diagnostic messages + the bus event payloads (so subscribers see a stable,
// human-readable identifier rather than two raw integers).
export function formatStep(step: KeyStep): string {
  const parts: string[] = [];
  if (step.mods & MOD_CTRL) parts.push("Ctrl");
  if (step.mods & MOD_MOD1) parts.push("Alt");
  if (step.mods & MOD_SHIFT) parts.push("Shift");
  if (step.mods & MOD_MOD4) parts.push("Mod");
  if (step.mods & MOD_MOD2) parts.push("Mod2");
  if (step.mods & MOD_MOD3) parts.push("Mod3");
  if (step.mods & MOD_MOD5) parts.push("Mod5");
  if (step.mods & MOD_LOCK) parts.push("Lock");
  parts.push(keysymName(step.keysym));
  return parts.join("+");
}

export function formatChord(steps: readonly KeyStep[]): string {
  return steps.map(formatStep).join(", ");
}

// Compare two KeySteps for equality (same mods AND same keysym).
export function stepsEqual(a: KeyStep, b: KeyStep): boolean {
  return a.mods === b.mods && a.keysym === b.keysym;
}
