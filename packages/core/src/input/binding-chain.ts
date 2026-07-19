// The binding-chain: a per-mode trie of registered chord bindings + a stack
// of active modes. Owned by the seat (one BindingChain per compositor
// session). Consulted on each key-down BEFORE wl_keyboard delivery; if a
// binding fires, the key is consumed and not forwarded to the focused
// client.
//
// Concepts:
//   Binding   -- a sequence of KeySteps (length >= 1) + a handler.
//                A single-step binding is a chord of length 1.
//   Mode      -- a named binding set. Has its own trie. The "default" mode
//                exists from boot; sub-modes are defined via defineMode.
//   ModeStack -- the active list of modes. Top frame is consulted on each
//                key-down. push() adds a frame; pop() removes one.
//                The root frame (default) is never popped.
//   Path      -- per-frame chord progress. Starts at the frame's trie root
//                each time the frame becomes the top of the stack.
//
// Dispatch (per key-down):
//   1. Build a KeyStep from (currentMods, keysym).
//   2. If the top frame's path has a child for this step:
//        - leaf: fire handler; reset path; consume.
//        - branch: advance path; consume.
//   3. Else if the key is itself a modifier (Shift, Super, ...): neutral --
//      it may be arming modifiers for a later chord step ("Insert,
//      Shift+c"), so it neither advances nor cancels the path.
//   4. Else: check the frame's exitOnEscape for an Escape match -> pop;
//      otherwise reset the path; forward to client.
//
// Behaviorally isolated: when a key isn't bound in the top mode, it does
// NOT fall through to a lower mode in the stack. The user pressed a key
// the active mode doesn't claim; the client gets it.

import type { InputStep, KeyStep, ButtonStep } from "./keyspec.js";
import { MOD_LOCK, MOD_MOD2, formatStep, formatChord, isButtonStep, isScrollStep } from "./keyspec.js";
import { isModifierKeysym } from "./keysyms.js";
import { log } from "../log.js";

// A press handler. Returns a boolean to indicate consume (true) or forward
// (false). Returning void/undefined means consume. May be async; the
// consume decision must be made synchronously, so the chain ALWAYS
// consumes a matched binding.
export type BindingHandler =
  (event: { step: InputStep; chord: InputStep[] }) => void | boolean | Promise<void | boolean>;

// A release handler. Fires when every key/button/mod that was held at
// press time has been released. No return semantics; release events are
// always consumed if they participate in a held instance.
export type BindingReleaseHandler =
  (event: { chord: InputStep[] }) => void | Promise<void>;

// One registered binding. The chain owns these inside its tries; callers
// receive an opaque {unbind} handle.
interface RegisteredBinding {
  steps: InputStep[];
  handler: BindingHandler;
  release?: BindingReleaseHandler;
  priority: number;
  mode: string;
}

// A live "held" instance: created on a successful press of a binding that
// has a release callback. The instance tracks WHICH inputs are still down;
// when the set drains to empty, the release callback fires and the
// instance is destroyed.
//
// Two kinds of tracked inputs:
//   - mod bits: the modifier bitmask that was set at press time. Each mod
//     bit becomes a tracked entry, released individually as the user lifts
//     each modifier key.
//   - trigger: the matched step's keysym (for KeyStep) or button code
//     (for ButtonStep). Released by the corresponding key-up/button-up.
//
// A release event for an input not in the set is ignored (does NOT
// participate, does NOT consume).
interface HeldInstance {
  binding: RegisteredBinding;
  // The matched step (the leaf step the press matched). The chord may
  // have more steps but release tracking only applies to the leaf.
  triggerStep: InputStep;
  // Mod bits still held. Each mod bit is decremented as the user lifts
  // that modifier key.
  heldMods: number;
  // True until the trigger key/button has been released.
  triggerHeld: boolean;
}

// Trie node. `children` keyed by a step's serialized "mods:keysym" form. A
// node has a binding (it's a leaf) OR children OR both -- both means a
// shorter chord (Mod+a) coexists with a longer one starting with the same
// prefix (Mod+a, Mod+b). Registration rejects that ambiguity (the longer
// chord would never fire because the shorter one matches first).
interface TrieNode {
  binding?: RegisteredBinding;
  children: Map<string, TrieNode>;
}

function newNode(): TrieNode { return { children: new Map() }; }

function stepKey(step: InputStep): string {
  if (isButtonStep(step)) return `${step.mods}:b:${step.button}`;
  if (isScrollStep(step)) return `${step.mods}:s:${step.dir}`;
  return `${step.mods}:k:${step.keysym}`;
}

function cloneInputStep(s: InputStep): InputStep {
  if (isButtonStep(s)) return { kind: "button", mods: s.mods, button: s.button };
  if (isScrollStep(s)) return { kind: "scroll", mods: s.mods, dir: s.dir };
  return { kind: "key", mods: s.mods, keysym: s.keysym };
}

// Parse a stepKey back into an InputStep. Inverse of stepKey() above.
function parseStepKey(key: string): InputStep {
  const [modsStr, kindChar, codeStr] = key.split(":");
  const mods = Number(modsStr);
  const code = Number(codeStr);
  if (kindChar === "b") return { kind: "button", mods, button: code };
  if (kindChar === "s") return { kind: "scroll", mods, dir: code as 0 | 1 | 2 | 3 };
  return { kind: "key", mods, keysym: code };
}

// Modes the user has access to. The default mode is always present; other
// modes are added via defineMode(). Each mode has its own trie + flags.
interface ModeDef {
  name: string;
  root: TrieNode;
  exitOnEscape: boolean;
  // Tracked for diagnostics + the workspace.* convention -- the bus emit
  // includes the mode name on every chord event.
}

// A frame on the mode stack: a reference to the ModeDef + a path pointer
// for the current chord progress within that frame.
interface ModeFrame {
  def: ModeDef;
  path: TrieNode;        // either def.root or a descendant
}

// Escape key, no modifiers; the default exitOnEscape match.
const ESCAPE_KEYSYM = 0xff1b;

// Mods to ignore when comparing event mods against binding mods. NumLock
// (Mod2) and Caps_Lock (Lock) frequently confuse otherwise-clean bindings:
// if the user is typing with NumLock on, every key event would carry Mod2,
// no binding would ever match. Strip them for comparison.
const IGNORED_MODS = MOD_LOCK | MOD_MOD2;

// Emitted by the chain to a caller-supplied callback. The seat plumbs these
// to the plugin bus so a status bar can observe.
export type ChainEvent =
  | { kind: "mode-pushed"; name: string; stack: string[] }
  | { kind: "mode-popped"; name: string; stack: string[] }
  | { kind: "chord-entered"; mode: string; path: string }     // path is formatted chord prefix
  | { kind: "chord-cancelled"; mode: string; path: string }
  | { kind: "chord-matched"; mode: string; path: string };

export type ChainEventListener = (ev: ChainEvent) => void;

export class BindingChain {
  // All defined modes, keyed by name. The default mode is created at
  // construction time and cannot be undefined.
  private modes = new Map<string, ModeDef>();
  // Active stack; top is modes[stack.length - 1].
  private stack: ModeFrame[] = [];
  private listener: ChainEventListener | null = null;
  // Held instances created by presses of bindings with release callbacks.
  // Each release event (key-up / button-up / mod release) decrements one
  // or more instances; when an instance's set is empty its release fires.
  private held: HeldInstance[] = [];

  constructor() {
    const def: ModeDef = { name: "default", root: newNode(), exitOnEscape: false };
    this.modes.set("default", def);
    this.stack.push({ def, path: def.root });
  }

  // Set a single listener for chain events (mode push/pop, chord
  // enter/cancel/match). The seat sets this at construction; replacing it
  // unwires the old one. Pass null to detach.
  setListener(l: ChainEventListener | null): void { this.listener = l; }

  // Define a new mode. exitOnEscape defaults to true (Escape pops the mode
  // when it's at the top of the stack and the path is at root). The
  // default mode is created with exitOnEscape: false and cannot be
  // overridden through this call -- it's an error to redefine "default".
  // Calling defineMode on an existing name throws (each mode has one
  // owner; redefinition would break in-flight bindings).
  defineMode(name: string, opts?: { exitOnEscape?: boolean }): { undefine(): void } {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("defineMode name must be a non-empty string");
    }
    if (name === "default") {
      throw new Error("the 'default' mode is built-in and cannot be redefined");
    }
    if (this.modes.has(name)) {
      throw new Error(`mode '${name}' is already defined`);
    }
    const def: ModeDef = {
      name, root: newNode(),
      exitOnEscape: opts?.exitOnEscape ?? true,
    };
    this.modes.set(name, def);
    return { undefine: () => this.undefineMode(name) };
  }

  private undefineMode(name: string): void {
    const def = this.modes.get(name);
    if (!def) return;
    // Pop any frames whose mode is being undefined. The default mode
    // can't be undefined, so the stack always has at least one frame
    // after this.
    while (this.stack.length > 1 && this.stack[this.stack.length - 1].def === def) {
      this.popMode();
    }
    this.modes.delete(name);
  }

  // Register a binding. Returns {unbind} to remove it. Throws on conflict:
  // either a binding with the same step sequence already exists, OR the
  // step sequence is a strict prefix of an existing binding, OR an existing
  // binding is a strict prefix of this one.
  //
  // `release` is an optional callback that fires when every key/button/mod
  // held at press time has been released. Only valid on single-step
  // bindings (length === 1): a multi-step chord cancels its prefix on
  // dispatch, so there's nothing to "release" after a chord matches.
  // Button-step chords (mid-chord button presses) are not supported; a
  // button may only appear as the SINGLE leaf step.
  bind(spec: {
    steps: InputStep[];
    mode?: string;
    handler: BindingHandler;
    release?: BindingReleaseHandler;
    priority?: number;
  }): { unbind(): void } {
    if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
      throw new TypeError("bind: steps must be a non-empty array");
    }
    if (typeof spec.handler !== "function") {
      throw new TypeError("bind: handler must be a function");
    }
    if (spec.release !== undefined) {
      if (typeof spec.release !== "function") {
        throw new TypeError("bind: release must be a function or omitted");
      }
      if (spec.steps.length > 1) {
        throw new TypeError(
          "bind: release callback is only valid on single-step bindings (chords cannot be released)");
      }
    }
    // Button/scroll steps may only appear as the SINGLE leaf step. Mid-chord
    // pointer steps ("Mod+a then button1") aren't supported in v1.
    for (let i = 0; i < spec.steps.length - 1; i++) {
      if (isButtonStep(spec.steps[i]) || isScrollStep(spec.steps[i])) {
        throw new TypeError(
          "bind: button/scroll steps may only appear as the leaf (last) step of a binding");
      }
    }
    const modeName = spec.mode ?? "default";
    const def = this.modes.get(modeName);
    if (!def) {
      throw new Error(`bind: mode '${modeName}' is not defined`);
    }
    const binding: RegisteredBinding = {
      steps: spec.steps.map((s) => cloneInputStep(s)),
      handler: spec.handler,
      ...(spec.release ? { release: spec.release } : {}),
      priority: spec.priority ?? 0,
      mode: modeName,
    };
    // Walk + create trie nodes. At each step, also verify no conflict:
    //   - We cannot place a leaf where one exists (duplicate).
    //   - We cannot extend past an existing leaf (would mask).
    //   - We cannot leave our path with children we don't want.
    let node = def.root;
    for (let i = 0; i < binding.steps.length; i++) {
      const step = binding.steps[i];
      // Reject extending past a leaf: walking through a node that already
      // has a binding means our binding is "Mod+a, X..." while a "Mod+a"
      // binding already exists -- the shorter one masks ours.
      if (node.binding) {
        const existing = formatChord(node.binding.steps);
        const tried = formatChord(binding.steps);
        throw new Error(
          `bind: binding '${tried}' is masked by existing shorter binding '${existing}' in mode '${modeName}'`);
      }
      const key = stepKey(step);
      let next = node.children.get(key);
      if (!next) {
        next = newNode();
        node.children.set(key, next);
      }
      node = next;
    }
    // After walking, `node` is where the leaf goes. If it already carries
    // a binding -> duplicate. If it has children -> a longer binding
    // already exists past this point and we'd mask it.
    if (node.binding) {
      throw new Error(
        `bind: duplicate binding for '${formatChord(binding.steps)}' in mode '${modeName}'`);
    }
    if (node.children.size > 0) {
      throw new Error(
        `bind: binding '${formatChord(binding.steps)}' would mask a longer binding ` +
        `already registered in mode '${modeName}'`);
    }
    node.binding = binding;
    return { unbind: () => this.unbindLeaf(modeName, binding.steps) };
  }

  private unbindLeaf(modeName: string, steps: InputStep[]): void {
    const def = this.modes.get(modeName);
    if (!def) return;
    // Walk + record the chain so we can prune empty branches on the way back.
    const path: { node: TrieNode; key: string }[] = [];
    let node = def.root;
    for (const step of steps) {
      const key = stepKey(step);
      const next = node.children.get(key);
      if (!next) return;     // not present; idempotent
      path.push({ node, key });
      node = next;
    }
    if (!node.binding) return;
    // Drop any held instances tied to this binding (the user can no
    // longer trigger its release; without this, a held instance would
    // leak forever).
    this.held = this.held.filter((h) => h.binding !== node.binding);
    delete node.binding;
    // Prune empty nodes from the bottom up.
    for (let i = path.length - 1; i >= 0; i--) {
      const { node: parent, key } = path[i];
      const child = parent.children.get(key);
      if (!child) break;
      if (child.children.size === 0 && !child.binding) {
        parent.children.delete(key);
      } else {
        break;
      }
    }
    // If we just unbound the path under the active top frame, reset its
    // path pointer so it doesn't dangle.
    const top = this.stack[this.stack.length - 1];
    if (top.def === def) top.path = def.root;
  }

  // Push a defined mode onto the stack. No-op if the mode is already at
  // the top (idempotent for "pressed the mode key twice"). Resets the new
  // mode's path to its root.
  pushMode(name: string): void {
    const def = this.modes.get(name);
    if (!def) throw new Error(`pushMode: mode '${name}' is not defined`);
    const top = this.stack[this.stack.length - 1];
    if (top.def === def) return;
    this.stack.push({ def, path: def.root });
    this.emit({ kind: "mode-pushed", name, stack: this.stackNames() });
  }

  // Pop the top mode. No-op if at the root (the default mode is never
  // popped).
  popMode(): void {
    if (this.stack.length <= 1) return;
    const top = this.stack.pop();
    if (!top) return;
    // Reset the now-top frame's path so a cancelled chord doesn't dangle.
    const newTop = this.stack[this.stack.length - 1];
    if (newTop.path !== newTop.def.root) {
      newTop.path = newTop.def.root;
    }
    this.emit({ kind: "mode-popped", name: top.def.name, stack: this.stackNames() });
  }

  // Names on the stack, root first. For diagnostics + the bus.
  stackNames(): string[] { return this.stack.map((f) => f.def.name); }

  // Snapshot of the current chord progress (the steps consumed so far in
  // the top frame). Empty if the top frame is at root.
  currentPath(): InputStep[] {
    const top = this.stack[this.stack.length - 1];
    if (top.path === top.def.root) return [];
    return this.pathToSteps(top.def, top.path);
  }

  // Reconstruct the steps from a path node by re-walking the trie. Slow
  // (O(depth * branching)) but only called for diagnostics.
  private pathToSteps(def: ModeDef, target: TrieNode): InputStep[] {
    if (target === def.root) return [];
    const result: InputStep[] = [];
    const walk = (node: TrieNode, acc: InputStep[]): boolean => {
      if (node === target) { result.push(...acc); return true; }
      for (const [key, child] of node.children) {
        acc.push(parseStepKey(key));
        if (walk(child, acc)) return true;
        acc.pop();
      }
      return false;
    };
    walk(def.root, []);
    return result;
  }

  // Dispatch a press event (key-down or button-down). The seat consumes
  // when consume is true and forwards when false. matched=true means a
  // binding fired (the press handler has been called synchronously; a
  // Promise it returns is dropped -- consume decisions can't await).
  dispatchPress(step: InputStep): { consume: boolean; matched: boolean } {
    const top = this.stack[this.stack.length - 1];
    // Match-time mods: strip the bits we don't care about.
    const compareStep: InputStep = cloneInputStep(step);
    compareStep.mods = step.mods & ~IGNORED_MODS;
    const key = stepKey(compareStep);
    const next = top.path.children.get(key);
    if (next) {
      if (next.binding) {
        // Leaf: fire + reset + consume.
        const binding = next.binding;
        const chord = binding.steps;
        this.emit({
          kind: "chord-matched", mode: top.def.name, path: formatChord(chord),
        });
        top.path = top.def.root;
        // If this binding has a release callback, register a held
        // instance. The trigger step is `compareStep` (the actually-
        // matched leaf, in case future code needs it).
        if (binding.release) {
          this.held.push({
            binding,
            triggerStep: cloneInputStep(compareStep),
            heldMods: compareStep.mods,
            triggerHeld: true,
          });
        }
        // Run the press handler. Errors are logged but don't block the
        // consume decision.
        try {
          const r = binding.handler({ step, chord });
          if (r && typeof (r as Promise<unknown>).then === "function") {
            (r as Promise<unknown>).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              log.err("input", `binding-chain: handler for '${formatChord(chord)}' failed: ${msg}`);
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.err("input", `binding-chain: handler for '${formatChord(chord)}' threw: ${msg}`);
        }
        return { consume: true, matched: true };
      }
      // Branch: advance + consume + emit chord-entered with the new prefix.
      top.path = next;
      this.emit({
        kind: "chord-entered", mode: top.def.name,
        path: formatChord(this.pathToSteps(top.def, top.path)),
      });
      return { consume: true, matched: false };
    }
    // An unbound modifier press is neutral: it may be arming modifiers for
    // a later chord step, so it must not cancel an in-progress chord. Mode
    // isolation still applies (swallowed in a pushed mode, forwarded in
    // default). A modifier sym that IS bound as a step matched above.
    if (!isButtonStep(compareStep) && !isScrollStep(compareStep)
        && isModifierKeysym(compareStep.keysym)) {
      return { consume: this.stack.length > 1, matched: false };
    }
    // No match in the trie. Check exit-on-Escape (only meaningful for
    // a non-default top frame with exitOnEscape, when the chord pointer
    // is at root and the step is the bare Escape keysym).
    if (
      this.stack.length > 1
      && top.def.exitOnEscape
      && top.path === top.def.root
      && !isButtonStep(compareStep)
      && !isScrollStep(compareStep)
      && compareStep.keysym === ESCAPE_KEYSYM
      && compareStep.mods === 0
    ) {
      this.popMode();
      return { consume: true, matched: false };
    }
    // In-progress chord that didn't match: cancel it. The event itself is
    // still dispatched per the rule below.
    if (top.path !== top.def.root) {
      this.emit({
        kind: "chord-cancelled", mode: top.def.name,
        path: formatStep(compareStep),
      });
      top.path = top.def.root;
    }
    // A pushed mode ISOLATES the keyboard: an unbound key is swallowed
    // rather than forwarded to the focused client, so a mode's key space
    // is exactly its bindings (plus Escape) and stray keys can't leak
    // into the app underneath. Pointer input is a separate device and
    // keeps flowing -- a mode captures the keyboard, not the mouse, so
    // clicking a window while a mode is up still works.
    //
    // Presses only: a key or modifier pressed BEFORE the mode was pushed
    // was forwarded, and the client needs its release to avoid a stuck
    // key (entering a mode via Mod+z with Super still held is the
    // ordinary case). dispatchRelease therefore stays lane-agnostic.
    if (this.stack.length > 1
        && !isButtonStep(compareStep) && !isScrollStep(compareStep)) {
      return { consume: true, matched: false };
    }
    return { consume: false, matched: false };
  }

  // Dispatch a release event (key-up or button-up). Decrements held
  // instances; fires release callbacks when an instance's set drains.
  // Returns consume=true if the released input participated in at least
  // one held instance (so the seat can suppress forwarding).
  //
  // `event` is the raw input event:
  //   - keyboard release: kind='key' + keysym.
  //   - button release: kind='button' + button.
  //   - mod release: kind='mod' + the modifier bit that became unset
  //     (computed by the seat by diff against the prior mod mask).
  dispatchRelease(event:
      | { kind: "key"; keysym: number }
      | { kind: "button"; button: number }
      | { kind: "mod"; bit: number },
  ): { consume: boolean } {
    if (this.held.length === 0) return { consume: false };
    let anyParticipated = false;
    const drained: HeldInstance[] = [];
    for (let i = this.held.length - 1; i >= 0; i--) {
      const inst = this.held[i];
      let participated = false;
      if (event.kind === "mod") {
        if ((inst.heldMods & event.bit) !== 0) {
          inst.heldMods &= ~event.bit;
          participated = true;
        }
      } else if (event.kind === "key"
                 && inst.triggerHeld
                 && !isButtonStep(inst.triggerStep)
                 && (inst.triggerStep as KeyStep).keysym === event.keysym) {
        inst.triggerHeld = false;
        participated = true;
      } else if (event.kind === "button"
                 && inst.triggerHeld
                 && isButtonStep(inst.triggerStep)
                 && (inst.triggerStep as ButtonStep).button === event.button) {
        inst.triggerHeld = false;
        participated = true;
      }
      if (participated) {
        anyParticipated = true;
        // Drain check: no mods left AND trigger released -> instance done.
        if (inst.heldMods === 0 && !inst.triggerHeld) {
          drained.push(inst);
          this.held.splice(i, 1);
        }
      }
    }
    // Fire release callbacks AFTER mutating held[], so a release handler
    // that synchronously presses keys / re-enters dispatch sees a clean
    // held list.
    for (const inst of drained) {
      try {
        const r = inst.binding.release?.({ chord: inst.binding.steps });
        if (r && typeof (r as Promise<unknown>).then === "function") {
          (r as Promise<unknown>).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.err("input", `binding-chain: release for '${formatChord(inst.binding.steps)}' failed: ${msg}`);
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.err("input", `binding-chain: release for '${formatChord(inst.binding.steps)}' threw: ${msg}`);
      }
    }
    return { consume: anyParticipated };
  }

  // Diagnostic: number of currently-held release-capable instances. Used
  // by tests and the seat (to know whether to bother calling
  // dispatchRelease on every key-up).
  heldCount(): number { return this.held.length; }

  private emit(ev: ChainEvent): void {
    if (!this.listener) return;
    try { this.listener(ev); } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.err("input", `binding-chain: listener threw on '${ev.kind}': ${msg}`);
    }
  }
}
