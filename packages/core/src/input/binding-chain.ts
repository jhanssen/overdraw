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
//   3. Else: check the frame's exitOnEscape for an Escape match -> pop;
//      otherwise reset the path; forward to client.
//
// Behaviorally isolated: when a key isn't bound in the top mode, it does
// NOT fall through to a lower mode in the stack. The user pressed a key
// the active mode doesn't claim; the client gets it.

import type { KeyStep } from "./keyspec.js";
import { MOD_LOCK, MOD_MOD2, stepsEqual, formatStep, formatChord } from "./keyspec.js";

// A handler called when a binding matches. Returns a boolean to indicate
// whether the key event should be consumed (true) or forwarded to the
// client (false). Returning void / undefined means consume (the common
// case -- bound keys usually shouldn't reach the client).
//
// May be async; the consume decision must be made synchronously, so the
// chain ALWAYS consumes a matched binding regardless of what the handler
// eventually returns. The boolean is reserved for future async-vetoing
// designs; today the seat treats matched = consumed unconditionally.
export type BindingHandler =
  (event: { step: KeyStep; chord: KeyStep[] }) => void | boolean | Promise<void | boolean>;

// One registered binding. The chain owns these inside its tries; callers
// receive an opaque {unbind} handle.
interface RegisteredBinding {
  steps: KeyStep[];
  handler: BindingHandler;
  priority: number;
  mode: string;
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

function stepKey(step: KeyStep): string { return `${step.mods}:${step.keysym}`; }

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

export type ModeStackName = string;

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
  // binding is a strict prefix of this one. Same-prefix conflicts are
  // ambiguous because the shorter binding would always match first.
  bind(spec: {
    steps: KeyStep[];
    mode?: string;
    handler: BindingHandler;
    priority?: number;
  }): { unbind(): void } {
    if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
      throw new TypeError("bind: steps must be a non-empty array");
    }
    if (typeof spec.handler !== "function") {
      throw new TypeError("bind: handler must be a function");
    }
    const modeName = spec.mode ?? "default";
    const def = this.modes.get(modeName);
    if (!def) {
      throw new Error(`bind: mode '${modeName}' is not defined`);
    }
    const binding: RegisteredBinding = {
      steps: spec.steps.map((s) => ({ mods: s.mods, keysym: s.keysym })),
      handler: spec.handler,
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

  private unbindLeaf(modeName: string, steps: KeyStep[]): void {
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
  currentPath(): KeyStep[] {
    const top = this.stack[this.stack.length - 1];
    if (top.path === top.def.root) return [];
    return this.pathToSteps(top.def, top.path);
  }

  // Reconstruct the steps from a path node by re-walking the trie. Slow
  // (O(depth * branching)) but only called for diagnostics.
  private pathToSteps(def: ModeDef, target: TrieNode): KeyStep[] {
    if (target === def.root) return [];
    const result: KeyStep[] = [];
    const walk = (node: TrieNode, acc: KeyStep[]): boolean => {
      if (node === target) { result.push(...acc); return true; }
      for (const [key, child] of node.children) {
        const [modsStr, symStr] = key.split(":");
        acc.push({ mods: Number(modsStr), keysym: Number(symStr) });
        if (walk(child, acc)) return true;
        acc.pop();
      }
      return false;
    };
    walk(def.root, []);
    return result;
  }

  // Outcome of dispatching one key-down. The seat consumes when consume is
  // true (skip wl_keyboard.key) and forwards when false. matched=true means
  // a binding fired; the handler has been called (synchronously, but any
  // Promise it returns is dropped -- consume decisions can't await).
  dispatch(step: KeyStep): { consume: boolean; matched: boolean } {
    const top = this.stack[this.stack.length - 1];
    // Match-time mods: strip the bits we don't care about.
    const compareStep: KeyStep = { mods: step.mods & ~IGNORED_MODS, keysym: step.keysym };
    const key = stepKey(compareStep);
    const next = top.path.children.get(key);
    if (next) {
      if (next.binding) {
        // Leaf: fire + reset + consume.
        const chord = next.binding.steps;
        this.emit({
          kind: "chord-matched", mode: top.def.name, path: formatChord(chord),
        });
        const handler = next.binding.handler;
        top.path = top.def.root;
        // Run the handler; errors are logged but don't block the consume
        // decision. The handler may push/pop modes; that's OK -- those
        // affect subsequent key events, not this one.
        try {
          const r = handler({ step, chord });
          if (r && typeof (r as Promise<unknown>).then === "function") {
            (r as Promise<unknown>).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[binding-chain] handler for '${formatChord(chord)}' failed: ${msg}`);
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[binding-chain] handler for '${formatChord(chord)}' threw: ${msg}`);
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
    // No match in the trie. Check exit-on-Escape (only meaningful when the
    // top frame is not the default mode AND its exitOnEscape is true AND
    // the chord pointer is at root -- otherwise an in-progress chord
    // would just cancel, see below).
    if (
      this.stack.length > 1
      && top.def.exitOnEscape
      && top.path === top.def.root
      && compareStep.keysym === ESCAPE_KEYSYM
      && compareStep.mods === 0
    ) {
      this.popMode();
      return { consume: true, matched: false };
    }
    // In-progress chord that didn't match: cancel and forward THIS key to
    // the client. (Cancel does NOT forward the prior consumed prefix; we
    // can't un-consume those.)
    if (top.path !== top.def.root) {
      this.emit({
        kind: "chord-cancelled", mode: top.def.name,
        path: formatStep(compareStep),
      });
      top.path = top.def.root;
    }
    return { consume: false, matched: false };
  }

  private emit(ev: ChainEvent): void {
    if (!this.listener) return;
    try { this.listener(ev); } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[binding-chain] listener threw on '${ev.kind}': ${msg}`);
    }
  }
}
