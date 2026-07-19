// Pure-unit tests for the binding chain (trie + mode stack). No xkbcommon,
// no seat -- synthesize KeyStep values directly and observe dispatch
// outcomes + listener events.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BindingChain } from "../packages/core/dist/input/binding-chain.js";
import {
  parseSpec, parseChord, MOD_MOD4, MOD_CTRL, MOD_SHIFT,
} from "../packages/core/dist/input/keyspec.js";

// Build a dispatch event for the chain. The chain compares the step's
// mods (after stripping ignored bits) and keysym; nothing else is read.
function step(modsKey) {
  return parseSpec(modsKey);
}

// Helper: build a chain + a recorder of listener events.
function newChain() {
  const chain = new BindingChain();
  const events = [];
  chain.setListener((ev) => events.push(ev));
  return { chain, events };
}

// ---- Bind + dispatch single-step ------------------------------------------

test("single-step binding fires and consumes on exact match", () => {
  const { chain } = newChain();
  let fired = 0;
  chain.bind({ steps: [step("Mod+a")], handler: () => { fired++; } });
  const r = chain.dispatchPress(step("Mod+a"));
  assert.equal(r.consume, true);
  assert.equal(r.matched, true);
  assert.equal(fired, 1);
});

test("unbound key is not consumed", () => {
  const { chain } = newChain();
  chain.bind({ steps: [step("Mod+a")], handler: () => {} });
  const r = chain.dispatchPress(step("Mod+b"));
  assert.equal(r.consume, false);
  assert.equal(r.matched, false);
});

test("modifier mismatch is not consumed", () => {
  const { chain } = newChain();
  chain.bind({ steps: [step("Mod+a")], handler: () => {} });
  // Same keysym, different (no) modifier.
  const r = chain.dispatchPress({ mods: 0, keysym: parseSpec("a").keysym });
  assert.equal(r.consume, false);
});

test("ignores Lock + Mod2 bits when comparing modifiers", () => {
  const { chain } = newChain();
  let fired = 0;
  chain.bind({ steps: [step("Mod+a")], handler: () => { fired++; } });
  // Press Mod+a with NumLock (Mod2 = 0x10) also active.
  const r = chain.dispatchPress({ mods: MOD_MOD4 | 0x10 | 0x02, keysym: parseSpec("a").keysym });
  assert.equal(r.consume, true);
  assert.equal(fired, 1);
});

// ---- Chord (multi-step) ---------------------------------------------------

test("two-step chord enters prefix state, then matches", () => {
  const { chain, events } = newChain();
  let fired = 0;
  chain.bind({ steps: parseChord(["Mod+a", "Mod+b"]), handler: () => { fired++; } });

  // First step: consume + enter chord state, no fire yet.
  const r1 = chain.dispatchPress(step("Mod+a"));
  assert.equal(r1.consume, true);
  assert.equal(r1.matched, false);
  assert.equal(fired, 0);
  assert.ok(events.some((e) => e.kind === "chord-entered" && e.mode === "default"));

  // Second step: match + fire.
  const r2 = chain.dispatchPress(step("Mod+b"));
  assert.equal(r2.consume, true);
  assert.equal(r2.matched, true);
  assert.equal(fired, 1);
  assert.ok(events.some((e) => e.kind === "chord-matched"));
});

test("chord prefix followed by non-matching key cancels + forwards the non-match", () => {
  const { chain, events } = newChain();
  let fired = 0;
  chain.bind({ steps: parseChord(["Mod+a", "Mod+b"]), handler: () => { fired++; } });

  chain.dispatchPress(step("Mod+a"));            // enter prefix
  const r = chain.dispatchPress(step("Mod+x"));  // cancel
  assert.equal(r.consume, false);           // the non-matching key is NOT consumed
  assert.equal(fired, 0);
  assert.ok(events.some((e) => e.kind === "chord-cancelled"));

  // After cancellation we're back at root: pressing Mod+a should re-enter the chord.
  const r2 = chain.dispatchPress(step("Mod+a"));
  assert.equal(r2.consume, true);
});

test("modifier press mid-chord is neutral: 'Insert, Shift+c' fires", () => {
  const { chain, events } = newChain();
  let fired = 0;
  chain.bind({ steps: parseChord(["Insert", "Shift+c"]), handler: () => { fired++; } });

  assert.equal(chain.dispatchPress(step("Insert")).consume, true);
  // The physical Shift press: keysym Shift_L, Shift bit now depressed.
  const r = chain.dispatchPress({ mods: MOD_SHIFT, keysym: 0xffe1 });
  assert.equal(r.consume, false);                // forwarded in default mode
  assert.ok(!events.some((e) => e.kind === "chord-cancelled"));
  assert.equal(chain.currentPath().length, 1);   // prefix still armed

  const r2 = chain.dispatchPress(step("Shift+c"));
  assert.equal(r2.matched, true);
  assert.equal(fired, 1);
});

test("modifier press in a pushed mode is swallowed and keeps chord progress", () => {
  const { chain, events } = newChain();
  let fired = 0;
  chain.defineMode("m");
  chain.bind({ steps: parseChord(["a", "Shift+b"]), mode: "m", handler: () => { fired++; } });
  chain.pushMode("m");

  chain.dispatchPress(step("a"));
  const r = chain.dispatchPress({ mods: MOD_SHIFT, keysym: 0xffe1 });
  assert.equal(r.consume, true);                 // mode isolates the keyboard
  assert.ok(!events.some((e) => e.kind === "chord-cancelled"));
  assert.equal(chain.dispatchPress(step("Shift+b")).matched, true);
  assert.equal(fired, 1);
});

test("a bound lock-key step still matches (neutrality only applies unbound)", () => {
  const { chain } = newChain();
  let fired = 0;
  chain.bind({ steps: parseChord(["Insert", "Caps_Lock"]), handler: () => { fired++; } });
  chain.dispatchPress(step("Insert"));
  // Caps_Lock (0xffe5) is in the modifier-sym range but bound as the leaf.
  const r = chain.dispatchPress(step("Caps_Lock"));
  assert.equal(r.matched, true);
  assert.equal(fired, 1);
});

test("currentPath reflects in-progress chord", () => {
  const { chain } = newChain();
  chain.bind({ steps: parseChord(["Mod+a", "Mod+b"]), handler: () => {} });
  assert.equal(chain.currentPath().length, 0);
  chain.dispatchPress(step("Mod+a"));
  assert.equal(chain.currentPath().length, 1);
  chain.dispatchPress(step("Mod+b"));            // match resets
  assert.equal(chain.currentPath().length, 0);
});

// ---- Conflict rejection ---------------------------------------------------

test("duplicate exact binding throws", () => {
  const { chain } = newChain();
  chain.bind({ steps: [step("Mod+a")], handler: () => {} });
  assert.throws(() => {
    chain.bind({ steps: [step("Mod+a")], handler: () => {} });
  }, /duplicate binding/);
});

test("short binding then longer one with same prefix throws (would mask)", () => {
  const { chain } = newChain();
  chain.bind({ steps: [step("Mod+a")], handler: () => {} });
  assert.throws(() => {
    chain.bind({ steps: parseChord(["Mod+a", "Mod+b"]), handler: () => {} });
  }, /masked by existing/);
});

test("longer binding then shorter one with same prefix throws (would mask longer)", () => {
  const { chain } = newChain();
  chain.bind({ steps: parseChord(["Mod+a", "Mod+b"]), handler: () => {} });
  assert.throws(() => {
    chain.bind({ steps: [step("Mod+a")], handler: () => {} });
  }, /would mask a longer/);
});

// ---- Unbind ---------------------------------------------------------------

test("unbind removes the binding; the key is no longer consumed", () => {
  const { chain } = newChain();
  let fired = 0;
  const h = chain.bind({ steps: [step("Mod+a")], handler: () => { fired++; } });
  h.unbind();
  const r = chain.dispatchPress(step("Mod+a"));
  assert.equal(r.consume, false);
  assert.equal(fired, 0);
});

test("unbind is idempotent", () => {
  const { chain } = newChain();
  const h = chain.bind({ steps: [step("Mod+a")], handler: () => {} });
  h.unbind();
  assert.doesNotThrow(() => h.unbind());
});

test("after unbind, the freed prefix can be reused by a different binding", () => {
  const { chain } = newChain();
  const h = chain.bind({ steps: parseChord(["Mod+a", "Mod+b"]), handler: () => {} });
  h.unbind();
  // Same prefix now free.
  assert.doesNotThrow(() => {
    chain.bind({ steps: [step("Mod+a")], handler: () => {} });
  });
});

// ---- Modes ----------------------------------------------------------------

test("defineMode + pushMode shifts the active trie", () => {
  const { chain, events } = newChain();
  chain.defineMode("resize");
  let defaultFired = 0, resizeFired = 0;
  chain.bind({ steps: [step("h")], handler: () => { defaultFired++; } });
  chain.bind({ steps: [step("h")], mode: "resize", handler: () => { resizeFired++; } });

  // Before push: default mode is active.
  chain.dispatchPress(step("h"));
  assert.equal(defaultFired, 1);
  assert.equal(resizeFired, 0);

  chain.pushMode("resize");
  assert.ok(events.some((e) => e.kind === "mode-pushed" && e.name === "resize"));

  chain.dispatchPress(step("h"));
  assert.equal(defaultFired, 1);
  assert.equal(resizeFired, 1);
});

test("modes are isolated: an unbound key in the top mode never reaches the mode below", () => {
  const { chain } = newChain();
  chain.defineMode("resize");
  let defaultFired = 0;
  chain.bind({ steps: [step("Mod+1")], handler: () => { defaultFired++; } });
  // No binding for Mod+1 in resize.
  chain.pushMode("resize");
  const r = chain.dispatchPress(step("Mod+1"));
  assert.equal(defaultFired, 0);  // default's Mod+1 is NOT consulted
  // ...and it doesn't reach the client either: a pushed mode swallows
  // unbound keys, so its key space is exactly its own bindings.
  assert.equal(r.consume, true);
  assert.equal(r.matched, false);
});

test("modes are isolated: a still-held modifier doesn't leak the key to the client", () => {
  // The Mod+z -> resize case: Super is still down when the user hits an
  // arrow, so the step carries Mod and matches no bare-arrow binding.
  const { chain } = newChain();
  chain.defineMode("resize");
  let fired = 0;
  chain.bind({ steps: [step("Left")], mode: "resize", handler: () => { fired++; } });
  chain.pushMode("resize");

  const held = chain.dispatchPress(step("Mod+Left"));
  assert.equal(held.consume, true, "swallowed, not forwarded to the app");
  assert.equal(fired, 0, "Mod+Left is not the bare-Left binding");

  const released = chain.dispatchPress(step("Left"));
  assert.equal(released.consume, true);
  assert.equal(fired, 1, "bare Left fires once Super is released");
});

test("modes isolate the KEYBOARD only: unbound buttons/scroll still reach the client", () => {
  const { chain } = newChain();
  chain.defineMode("resize");
  chain.pushMode("resize");
  // A mode captures the keyboard, not the mouse: clicking a window while
  // a mode is up must still work.
  assert.equal(chain.dispatchPress(step("button1")).consume, false);
  assert.equal(chain.dispatchPress(step("Mod+button3")).consume, false);
  assert.equal(chain.dispatchPress(step("scroll_up")).consume, false);
});

test("the default mode never isolates: unbound keys forward as normal typing", () => {
  const { chain } = newChain();
  chain.defineMode("resize");
  chain.bind({ steps: [step("Left")], mode: "resize", handler: () => {} });
  // Root frame: 'a' is just typing.
  assert.equal(chain.dispatchPress(step("a")).consume, false);
  // Isolated while the mode is up...
  chain.pushMode("resize");
  assert.equal(chain.dispatchPress(step("a")).consume, true);
  // ...and typing resumes the moment it pops.
  chain.popMode();
  assert.equal(chain.dispatchPress(step("a")).consume, false);
});

test("a cancelled chord inside a mode is swallowed, not forwarded", () => {
  const { chain, events } = newChain();
  chain.defineMode("resize");
  chain.bind({
    steps: [step("Mod+a"), step("Mod+b")], mode: "resize", handler: () => {},
  });
  chain.pushMode("resize");
  assert.equal(chain.dispatchPress(step("Mod+a")).consume, true);  // enters the chord
  // 'x' doesn't continue the chord: it cancels -- and stays swallowed.
  const r = chain.dispatchPress(step("x"));
  assert.equal(r.consume, true);
  assert.ok(events.some((e) => e.kind === "chord-cancelled"));
});

test("Escape pops a mode by default", () => {
  const { chain, events } = newChain();
  chain.defineMode("resize");
  chain.pushMode("resize");
  assert.deepEqual(chain.stackNames(), ["default", "resize"]);
  const r = chain.dispatchPress(step("Escape"));
  assert.equal(r.consume, true);
  assert.deepEqual(chain.stackNames(), ["default"]);
  assert.ok(events.some((e) => e.kind === "mode-popped" && e.name === "resize"));
});

test("Escape does NOT pop when exitOnEscape: false", () => {
  const { chain } = newChain();
  chain.defineMode("modal", { exitOnEscape: false });
  chain.pushMode("modal");
  const r = chain.dispatchPress(step("Escape"));
  // The mode holds: Escape neither pops it nor reaches the client (an
  // unbound key in a pushed mode is swallowed). Exiting is up to the
  // mode's own bindings or a programmatic popMode.
  assert.equal(r.consume, true);
  assert.deepEqual(chain.stackNames(), ["default", "modal"]);
});

test("Escape on the default mode does NOT pop (root frame is never popped)", () => {
  const { chain } = newChain();
  const r = chain.dispatchPress(step("Escape"));
  assert.equal(r.consume, false);   // unbound; default has exitOnEscape=false
  assert.deepEqual(chain.stackNames(), ["default"]);
});

test("popMode is a no-op at root", () => {
  const { chain } = newChain();
  chain.popMode();
  assert.deepEqual(chain.stackNames(), ["default"]);
});

test("defining default throws", () => {
  const { chain } = newChain();
  assert.throws(() => chain.defineMode("default"), /built-in/);
});

test("redefining an existing mode throws", () => {
  const { chain } = newChain();
  chain.defineMode("resize");
  assert.throws(() => chain.defineMode("resize"), /already defined/);
});

test("binding in an undefined mode throws", () => {
  const { chain } = newChain();
  assert.throws(
    () => chain.bind({ steps: [step("Mod+a")], mode: "nonexistent", handler: () => {} }),
    /not defined/);
});

test("undefine pops frames using that mode", () => {
  const { chain } = newChain();
  const h = chain.defineMode("resize");
  chain.pushMode("resize");
  assert.deepEqual(chain.stackNames(), ["default", "resize"]);
  h.undefine();
  assert.deepEqual(chain.stackNames(), ["default"]);
});

test("pushing the same mode twice is idempotent", () => {
  const { chain } = newChain();
  chain.defineMode("resize");
  chain.pushMode("resize");
  chain.pushMode("resize");
  assert.deepEqual(chain.stackNames(), ["default", "resize"]);
});

// ---- Listener -------------------------------------------------------------

test("listener is invoked for mode pushes / pops / chord events", () => {
  const events = [];
  const chain = new BindingChain();
  chain.setListener((ev) => events.push(ev.kind));
  chain.defineMode("resize");
  chain.pushMode("resize");
  chain.popMode();
  // Stack changes recorded.
  assert.deepEqual(events, ["mode-pushed", "mode-popped"]);

  chain.bind({ steps: parseChord(["Mod+a", "Mod+b"]), handler: () => {} });
  events.length = 0;
  chain.dispatchPress(step("Mod+a"));
  chain.dispatchPress(step("Mod+b"));
  assert.deepEqual(events, ["chord-entered", "chord-matched"]);
});

test("setListener(null) detaches", () => {
  const events = [];
  const chain = new BindingChain();
  chain.setListener((ev) => events.push(ev));
  chain.setListener(null);
  chain.defineMode("resize");
  chain.pushMode("resize");
  assert.equal(events.length, 0);
});

// ---- Error containment ----------------------------------------------------

test("handler throwing still consumes the key and resets the path", () => {
  const { chain } = newChain();
  chain.bind({ steps: [step("Mod+a")], handler: () => { throw new Error("boom"); } });
  // Should NOT throw out of dispatch.
  const r = chain.dispatchPress(step("Mod+a"));
  assert.equal(r.consume, true);
  // Path reset: next press is a fresh start.
  assert.equal(chain.currentPath().length, 0);
});
