// Parse a human-written key/button specification ("Mod+Shift+Return",
// "Super+button1") into an InputStep (KeyStep or ButtonStep). Single-step
// and chord (InputStep[]) shapes are both supported via parseSpec (single)
// and parseChord (array or "step1, step2").
//
// Modifier name -> X11 modifier bit mask:
//   Shift  0x01
//   Lock   0x02   (Caps_Lock; usually NOT used in bindings)
//   Ctrl   0x04
//   Alt    0x08   (Mod1)
//   Mod2   0x10   (typically NumLock)
//   Mod3   0x20
//   Mod    0x40   (Mod4 / Super / Logo)
//   Mod5   0x80   (typically AltGr / ISO_Level3_Shift)
//
// Aliases:  Mod = Super = Logo = Mod4 = 0x40;  Ctrl = Control;  Alt = Mod1.
//
// Buttons (X11 numbering for the common cases):
//   button1 = left   (BTN_LEFT   = 0x110)
//   button2 = middle (BTN_MIDDLE = 0x112)
//   button3 = right  (BTN_RIGHT  = 0x111)
//   button4..8       = BTN_SIDE/EXTRA/FORWARD/BACK/TASK (0x113..0x117)
//
// Limitations of v1:
// - No layout-specific keysym aliases under non-US layouts.
// - Bindings fire on press only by default. The hotkey plugin's
//   `releaseAction` lets a binding fire a second action on release.

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

// One step of a binding: a set of modifier bits + either a keysym (key
// step) or a pointer button code (button step). Equality is the union of
// the same fields (see stepsEqual below).
export interface KeyStep {
  kind?: "key";
  // Bit mask of modifiers that must be held for the step to match.
  // Unstated bits (e.g. NumLock) are IGNORED at match time.
  mods: number;
  // The keysym (post-xkb-resolution) the key resolves to.
  keysym: number;
}

export interface ButtonStep {
  kind: "button";
  mods: number;
  // Evdev button code (BTN_LEFT=0x110, etc.). Matches the value carried
  // in wl_pointer.button events.
  button: number;
}

// A pointer-scroll step ("Mod+scroll_up"). Fires on each scroll tick in `dir`;
// scroll has no release, so a scroll binding never carries a releaseAction.
export interface ScrollStep {
  kind: "scroll";
  mods: number;
  dir: ScrollDir;
}
// 0=up, 1=down (vertical axis), 2=left, 3=right (horizontal axis).
export type ScrollDir = 0 | 1 | 2 | 3;

export type InputStep = KeyStep | ButtonStep | ScrollStep;

// Evdev button codes (from <linux/input-event-codes.h>) for the named
// "button<N>" tokens in key specs.
export const BTN_LEFT = 0x110;
export const BTN_RIGHT = 0x111;
export const BTN_MIDDLE = 0x112;
export const BTN_SIDE = 0x113;
export const BTN_EXTRA = 0x114;
export const BTN_FORWARD = 0x115;
export const BTN_BACK = 0x116;
export const BTN_TASK = 0x117;

const BUTTON_ALIASES: { [name: string]: number } = {
  button1: BTN_LEFT,
  button2: BTN_MIDDLE,
  button3: BTN_RIGHT,
  button4: BTN_SIDE,
  button5: BTN_EXTRA,
  button6: BTN_FORWARD,
  button7: BTN_BACK,
  button8: BTN_TASK,
};

// Scroll-direction tokens. scroll_up/down/left/right are the canonical names;
// mouse_up/mouse_down are Hyprland-compatible aliases for vertical scroll.
const SCROLL_ALIASES: { [name: string]: ScrollDir } = {
  scroll_up: 0, scroll_down: 1, scroll_left: 2, scroll_right: 3,
  mouse_up: 0, mouse_down: 1,
};
const SCROLL_DIR_NAMES = ["scroll_up", "scroll_down", "scroll_left", "scroll_right"];

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

// Parse one step ("Mod+Shift+Return", "Super+button1"). Tokens are split
// on '+'. The last token is the keysym OR button alias; everything before
// is a modifier name. Throws TypeError on shape errors.
export function parseSpec(spec: string): InputStep {
  if (typeof spec !== "string") {
    throw new TypeError("input spec must be a string");
  }
  const trimmed = spec.trim();
  if (trimmed.length === 0) throw new TypeError("input spec is empty");

  const tokens = trimmed.split("+").map((t) => t.trim());
  if (tokens.some((t) => t.length === 0)) {
    throw new TypeError(`input spec has empty token: '${spec}'`);
  }
  const lastToken = tokens[tokens.length - 1];
  const modTokens = tokens.slice(0, -1);

  let mods = 0;
  for (const m of modTokens) {
    const bit = MOD_ALIASES[m.toLowerCase()];
    if (bit === undefined) {
      throw new TypeError(
        `unknown modifier '${m}' in input spec '${spec}'; ` +
        `known: Shift, Ctrl, Alt, Mod (=Super/Logo), Mod2..Mod5`);
    }
    if ((mods & bit) !== 0) {
      throw new TypeError(`duplicate modifier '${m}' in input spec '${spec}'`);
    }
    mods |= bit;
  }

  // Try button alias first ("button1" .. "button8"), then scroll
  // ("scroll_up" ...), then fall back to keysym.
  const button = BUTTON_ALIASES[lastToken.toLowerCase()];
  if (button !== undefined) {
    return { kind: "button", mods, button };
  }
  const dir = SCROLL_ALIASES[lastToken.toLowerCase()];
  if (dir !== undefined) {
    return { kind: "scroll", mods, dir };
  }
  const keysym = keysymOf(lastToken);
  if (keysym === null) {
    throw new TypeError(
      `unknown keysym/button '${lastToken}' in input spec '${spec}'; ` +
      `keys: see packages/core/src/input/keysyms.ts; ` +
      `buttons: button1..button8`);
  }
  return { kind: "key", mods, keysym };
}

// Parse a chord. Accepts:
//   - a single string "Mod+a, Mod+b" or "Mod+a Mod+b",
//   - an array of step strings,
//   - a pre-parsed array of InputStep.
// Always returns InputStep[] with at least one step.
export function parseChord(input: string | readonly string[] | readonly InputStep[]): InputStep[] {
  if (Array.isArray(input)) {
    if (input.length === 0) throw new TypeError("chord is empty");
    const out: InputStep[] = [];
    for (const step of input) {
      if (typeof step === "string") {
        out.push(parseSpec(step));
      } else if (isInputStep(step)) {
        out.push(cloneStep(step));
      } else {
        throw new TypeError(`chord entry must be a string or InputStep, got ${typeof step}`);
      }
    }
    return out;
  }
  if (typeof input !== "string") {
    throw new TypeError("chord must be a string or array");
  }
  const parts = input.split(/[,\s]+/).filter((s) => s.length > 0);
  if (parts.length === 0) throw new TypeError(`chord is empty: '${input}'`);
  return parts.map(parseSpec);
}

function isInputStep(v: unknown): v is InputStep {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { [k: string]: unknown };
  if (typeof o.mods !== "number") return false;
  // KeyStep: kind absent or 'key' + keysym number.
  if ((o.kind === undefined || o.kind === "key") && typeof o.keysym === "number") return true;
  // ButtonStep: kind 'button' + button number.
  if (o.kind === "button" && typeof o.button === "number") return true;
  // ScrollStep: kind 'scroll' + dir number.
  if (o.kind === "scroll" && typeof o.dir === "number") return true;
  return false;
}

function cloneStep(s: InputStep): InputStep {
  if (s.kind === "button") return { kind: "button", mods: s.mods, button: s.button };
  if (s.kind === "scroll") return { kind: "scroll", mods: s.mods, dir: s.dir };
  return { kind: "key", mods: s.mods, keysym: s.keysym };
}

// Return true if `step` is a button (vs. a key) step. A KeyStep without
// an explicit `kind` field defaults to a key step.
export function isButtonStep(step: InputStep): step is ButtonStep {
  return step.kind === "button";
}

export function isScrollStep(step: InputStep): step is ScrollStep {
  return step.kind === "scroll";
}

// Render an InputStep back to its canonical "Mod+Shift+Key" or
// "Mod+button1" string. Used in diagnostics + bus event payloads.
export function formatStep(step: InputStep): string {
  const parts: string[] = [];
  if (step.mods & MOD_CTRL) parts.push("Ctrl");
  if (step.mods & MOD_MOD1) parts.push("Alt");
  if (step.mods & MOD_SHIFT) parts.push("Shift");
  if (step.mods & MOD_MOD4) parts.push("Mod");
  if (step.mods & MOD_MOD2) parts.push("Mod2");
  if (step.mods & MOD_MOD3) parts.push("Mod3");
  if (step.mods & MOD_MOD5) parts.push("Mod5");
  if (step.mods & MOD_LOCK) parts.push("Lock");
  parts.push(
    isButtonStep(step) ? buttonName(step.button)
      : isScrollStep(step) ? SCROLL_DIR_NAMES[step.dir]
        : keysymName(step.keysym));
  return parts.join("+");
}

function buttonName(button: number): string {
  for (const [name, code] of Object.entries(BUTTON_ALIASES)) {
    if (code === button) return name;
  }
  return `button(0x${button.toString(16)})`;
}

export function formatChord(steps: readonly InputStep[]): string {
  return steps.map(formatStep).join(", ");
}

// Compare two InputSteps for equality.
export function stepsEqual(a: InputStep, b: InputStep): boolean {
  if (a.mods !== b.mods) return false;
  if ((a.kind ?? "key") !== (b.kind ?? "key")) return false;
  if (a.kind === "button") return a.button === (b as ButtonStep).button;
  if (a.kind === "scroll") return a.dir === (b as ScrollStep).dir;
  return a.keysym === (b as KeyStep).keysym;
}
