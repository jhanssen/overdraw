// Tests for release callbacks + button steps on the binding chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BindingChain,
} from '../packages/core/dist/input/binding-chain.js';
import {
  parseSpec, parseChord,
  MOD_MOD4,
  BTN_LEFT, BTN_RIGHT,
} from '../packages/core/dist/input/keyspec.js';

function newChain() { return new BindingChain(); }

// --- button-step parsing + dispatch ---

test('parseSpec: button1 returns a button step', () => {
  const s = parseSpec('button1');
  assert.deepEqual(s, { kind: 'button', mods: 0, button: BTN_LEFT });
});

test('parseSpec: Super+button1 is a modifier + button', () => {
  const s = parseSpec('Super+button1');
  assert.deepEqual(s, { kind: 'button', mods: MOD_MOD4, button: BTN_LEFT });
});

test('parseSpec: button3 is the right button (X11 convention)', () => {
  const s = parseSpec('button3');
  assert.deepEqual(s, { kind: 'button', mods: 0, button: BTN_RIGHT });
});

test('chain.dispatchPress: matches a button step', () => {
  const chain = newChain();
  let fired = 0;
  chain.bind({ steps: [parseSpec('Super+button1')], handler: () => { fired++; } });
  const r = chain.dispatchPress({ kind: 'button', mods: MOD_MOD4, button: BTN_LEFT });
  assert.equal(r.consume, true);
  assert.equal(r.matched, true);
  assert.equal(fired, 1);
});

test('chain.dispatchPress: button doesn\'t match a key binding with the same numeric value', () => {
  const chain = newChain();
  // Bind to a key whose keysym happens to equal BTN_LEFT's value (0x110).
  // Reaching into a synthetic step that uses that keysym.
  let fired = 0;
  chain.bind({
    steps: [{ kind: 'key', mods: 0, keysym: BTN_LEFT }],
    handler: () => { fired++; },
  });
  // A button press with the same numeric value should NOT match the key binding.
  const r = chain.dispatchPress({ kind: 'button', mods: 0, button: BTN_LEFT });
  assert.equal(r.matched, false);
  assert.equal(r.consume, false);
  assert.equal(fired, 0);
});

test('bind: rejects mid-chord button steps', () => {
  const chain = newChain();
  assert.throws(() =>
    chain.bind({
      steps: [parseSpec('button1'), parseSpec('Mod+a')],
      handler: () => {},
    }), /leaf \(last\) step/);
});

// --- release callbacks ---

test('release callback: fires when key alone is held + released', () => {
  const chain = newChain();
  let press = 0, release = 0;
  chain.bind({
    steps: parseChord('a'),
    handler: () => { press++; },
    release: () => { release++; },
  });
  chain.dispatchPress({ kind: 'key', mods: 0, keysym: parseSpec('a').keysym });
  assert.equal(press, 1);
  assert.equal(release, 0);
  assert.equal(chain.heldCount(), 1);
  chain.dispatchRelease({ kind: 'key', keysym: parseSpec('a').keysym });
  assert.equal(release, 1);
  assert.equal(chain.heldCount(), 0);
});

test('release callback: waits for ALL keys + mods to be released', () => {
  const chain = newChain();
  let press = 0, release = 0;
  chain.bind({
    steps: parseChord('Super+a'),
    handler: () => { press++; },
    release: () => { release++; },
  });
  chain.dispatchPress({ kind: 'key', mods: MOD_MOD4, keysym: parseSpec('a').keysym });
  assert.equal(press, 1);
  // a released first, Super still held -> no release yet.
  chain.dispatchRelease({ kind: 'key', keysym: parseSpec('a').keysym });
  assert.equal(release, 0);
  // Super released -> release fires.
  chain.dispatchRelease({ kind: 'mod', bit: MOD_MOD4 });
  assert.equal(release, 1);
});

test('release callback: modifier released first; trigger released second', () => {
  const chain = newChain();
  let release = 0;
  chain.bind({
    steps: parseChord('Super+a'),
    handler: () => {},
    release: () => { release++; },
  });
  chain.dispatchPress({ kind: 'key', mods: MOD_MOD4, keysym: parseSpec('a').keysym });
  chain.dispatchRelease({ kind: 'mod', bit: MOD_MOD4 });
  assert.equal(release, 0); // trigger still held
  chain.dispatchRelease({ kind: 'key', keysym: parseSpec('a').keysym });
  assert.equal(release, 1);
});

test('release callback: button step + modifier (Super+button1)', () => {
  const chain = newChain();
  let release = 0;
  chain.bind({
    steps: [parseSpec('Super+button1')],
    handler: () => {},
    release: () => { release++; },
  });
  chain.dispatchPress({ kind: 'button', mods: MOD_MOD4, button: BTN_LEFT });
  chain.dispatchRelease({ kind: 'button', button: BTN_LEFT });
  assert.equal(release, 0); // mod still held
  chain.dispatchRelease({ kind: 'mod', bit: MOD_MOD4 });
  assert.equal(release, 1);
});

test('release: dispatchRelease returns consume=true when a held instance participates', () => {
  const chain = newChain();
  chain.bind({
    steps: parseChord('Super+a'),
    handler: () => {},
    release: () => {},
  });
  chain.dispatchPress({ kind: 'key', mods: MOD_MOD4, keysym: parseSpec('a').keysym });
  const r = chain.dispatchRelease({ kind: 'key', keysym: parseSpec('a').keysym });
  assert.equal(r.consume, true);
});

test('release: dispatchRelease returns consume=false when no instance held the input', () => {
  const chain = newChain();
  // Bound but never pressed -> no held instance.
  chain.bind({
    steps: parseChord('Super+a'),
    handler: () => {},
    release: () => {},
  });
  const r = chain.dispatchRelease({ kind: 'key', keysym: parseSpec('a').keysym });
  assert.equal(r.consume, false);
});

test('release: multiple held instances drain independently', () => {
  const chain = newChain();
  let releaseA = 0, releaseB = 0;
  chain.bind({ steps: parseChord('Super+a'), handler: () => {}, release: () => { releaseA++; } });
  chain.bind({ steps: parseChord('Super+b'), handler: () => {}, release: () => { releaseB++; } });
  chain.dispatchPress({ kind: 'key', mods: MOD_MOD4, keysym: parseSpec('a').keysym });
  chain.dispatchPress({ kind: 'key', mods: MOD_MOD4, keysym: parseSpec('b').keysym });
  assert.equal(chain.heldCount(), 2);
  // Release Super: both instances lose their mod but each still holds their key.
  chain.dispatchRelease({ kind: 'mod', bit: MOD_MOD4 });
  assert.equal(releaseA, 0);
  assert.equal(releaseB, 0);
  // Release a -> A drains.
  chain.dispatchRelease({ kind: 'key', keysym: parseSpec('a').keysym });
  assert.equal(releaseA, 1);
  assert.equal(releaseB, 0);
  // Release b -> B drains.
  chain.dispatchRelease({ kind: 'key', keysym: parseSpec('b').keysym });
  assert.equal(releaseB, 1);
});

test('release: pressing the same binding twice creates two instances', () => {
  const chain = newChain();
  let release = 0;
  chain.bind({
    steps: parseChord('a'),
    handler: () => {},
    release: () => { release++; },
  });
  chain.dispatchPress({ kind: 'key', mods: 0, keysym: parseSpec('a').keysym });
  chain.dispatchRelease({ kind: 'key', keysym: parseSpec('a').keysym });
  assert.equal(release, 1);
  // Second press creates a fresh instance.
  chain.dispatchPress({ kind: 'key', mods: 0, keysym: parseSpec('a').keysym });
  chain.dispatchRelease({ kind: 'key', keysym: parseSpec('a').keysym });
  assert.equal(release, 2);
});

test('release: unbind drops held instances (no release fires later)', () => {
  const chain = newChain();
  let release = 0;
  const handle = chain.bind({
    steps: parseChord('a'),
    handler: () => {},
    release: () => { release++; },
  });
  chain.dispatchPress({ kind: 'key', mods: 0, keysym: parseSpec('a').keysym });
  handle.unbind();
  chain.dispatchRelease({ kind: 'key', keysym: parseSpec('a').keysym });
  assert.equal(release, 0);
});

test('bind: rejects release callback on chord bindings', () => {
  const chain = newChain();
  assert.throws(() =>
    chain.bind({
      steps: parseChord('Mod+a, Mod+b'),
      handler: () => {},
      release: () => {},
    }), /single-step/);
});

test('bind: release must be a function', () => {
  const chain = newChain();
  assert.throws(() =>
    chain.bind({
      steps: parseChord('a'),
      handler: () => {},
      // eslint-disable-next-line no-restricted-syntax
      release: /** @type {any} */ ("not a function"),
    }), /release must be a function/);
});

test('release handler throwing is logged but doesn\'t crash', () => {
  const chain = newChain();
  chain.bind({
    steps: parseChord('a'),
    handler: () => {},
    release: () => { throw new Error('boom'); },
  });
  chain.dispatchPress({ kind: 'key', mods: 0, keysym: parseSpec('a').keysym });
  // Should not throw out of dispatchRelease.
  chain.dispatchRelease({ kind: 'key', keysym: parseSpec('a').keysym });
  assert.equal(chain.heldCount(), 0);
});

test('release: binding without release callback creates no held instance', () => {
  const chain = newChain();
  chain.bind({
    steps: parseChord('a'),
    handler: () => {},
    // no release
  });
  chain.dispatchPress({ kind: 'key', mods: 0, keysym: parseSpec('a').keysym });
  assert.equal(chain.heldCount(), 0);
});
