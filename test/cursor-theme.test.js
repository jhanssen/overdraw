// CursorThemeResolver: native addon binding + LRU cache.
//
// Two tiers:
//   0. createCursorThemeResolver with a stub addon: LRU semantics (hit
//      promotion, miss -> set, eviction at limit, reload clears).
//   1. The real native addon: 'default' shape always resolves (built-in
//      fallback), an unknown shape resolves to null when not in any theme.
//      Filesystem-dependent — gated on XCURSOR_THEME unset / the host's
//      theme situation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createCursorThemeResolver } from '../packages/core/dist/cursor/theme-resolver.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- tier 0: LRU cache semantics --------------------------------------------

function stubAddon(callsLog) {
  return {
    resolveCursorShape(name, sizePx, scale) {
      callsLog.push(`${name}|${sizePx}|${scale}`);
      // Synthesize a tiny image; 1x1 BGRA.
      return {
        width: 1,
        height: 1,
        hotspotX: 0,
        hotspotY: 0,
        rgba: new Uint8Array([0, 0, 0, 255]),
      };
    },
  };
}

test('resolver: caches by (name, sizePx, scale)', () => {
  const calls = [];
  const r = createCursorThemeResolver(stubAddon(calls));
  r.resolveShape('default', 24, 1);
  r.resolveShape('default', 24, 1);
  r.resolveShape('default', 24, 1);
  assert.equal(calls.length, 1);
});

test('resolver: distinct keys do not collide', () => {
  const calls = [];
  const r = createCursorThemeResolver(stubAddon(calls));
  r.resolveShape('default', 24, 1);
  r.resolveShape('default', 32, 1);          // different size
  r.resolveShape('default', 24, 2);          // different scale
  r.resolveShape('pointer', 24, 1);          // different name
  assert.equal(calls.length, 4);
});

test('resolver: LRU evicts oldest beyond cacheLimit', () => {
  const calls = [];
  const r = createCursorThemeResolver(stubAddon(calls), { cacheLimit: 2 });
  r.resolveShape('a', 24, 1);                // calls 1
  r.resolveShape('b', 24, 1);                // calls 2
  r.resolveShape('c', 24, 1);                // calls 3; 'a' evicted
  r.resolveShape('a', 24, 1);                // calls 4 (re-miss)
  assert.equal(calls.length, 4);
});

test('resolver: hit promotes (LRU touch)', () => {
  const calls = [];
  const r = createCursorThemeResolver(stubAddon(calls), { cacheLimit: 2 });
  r.resolveShape('a', 24, 1);                // calls 1
  r.resolveShape('b', 24, 1);                // calls 2
  r.resolveShape('a', 24, 1);                // hit; 'b' is now LRU
  r.resolveShape('c', 24, 1);                // calls 3; 'b' evicted, 'a' kept
  r.resolveShape('a', 24, 1);                // still cached: no call
  assert.equal(calls.length, 3);
});

test('resolver: null miss is cached (does not refetch)', () => {
  const calls = [];
  let returnNull = true;
  const addon = {
    resolveCursorShape(name, sizePx, scale) {
      calls.push(`${name}|${sizePx}|${scale}`);
      return returnNull ? null : { width: 1, height: 1, hotspotX: 0, hotspotY: 0, rgba: new Uint8Array(4) };
    },
  };
  const r = createCursorThemeResolver(addon);
  assert.equal(r.resolveShape('nope', 24, 1), null);
  assert.equal(r.resolveShape('nope', 24, 1), null);
  // Even if the underlying answer would change, the cached null wins.
  returnNull = false;
  assert.equal(r.resolveShape('nope', 24, 1), null);
  assert.equal(calls.length, 1);
});

test('resolver: reload() clears the cache', () => {
  const calls = [];
  const r = createCursorThemeResolver(stubAddon(calls));
  r.resolveShape('default', 24, 1);
  r.resolveShape('default', 24, 1);
  assert.equal(calls.length, 1);
  r.reload();
  r.resolveShape('default', 24, 1);
  assert.equal(calls.length, 2);
});

// --- tier 1: the real native addon ------------------------------------------
//
// Skipped if the native addon hasn't been built yet (the unit-test path can
// run on a CI machine without the GPU process built, though the shared addon
// .node should usually be present).

function tryLoadAddon() {
  try {
    return require(path.join(here, '..', 'packages', 'core', 'build', 'overdraw_native.node'));
  } catch {
    return null;
  }
}

test('native: default shape resolves via built-in fallback (no theme dependency)', (t) => {
  const addon = tryLoadAddon();
  if (!addon) { t.skip('native addon not built'); return; }
  // Force an obviously-bogus theme so the filesystem walk misses and the
  // built-in fallback is exercised.
  const prev = process.env.XCURSOR_THEME;
  process.env.XCURSOR_THEME = 'overdraw-test-this-theme-does-not-exist-' + Math.random();
  try {
    const r = addon.resolveCursorShape('default', 24, 1);
    assert.ok(r, 'default shape always resolves');
    assert.equal(r.width, 16, 'built-in fallback is 16x16');
    assert.equal(r.height, 16);
    assert.equal(r.rgba.length, 16 * 16 * 4);
    // The fallback writes some non-zero alpha pixels (the arrow body).
    let any = false;
    for (let i = 3; i < r.rgba.length; i += 4) if (r.rgba[i] !== 0) { any = true; break; }
    assert.ok(any, 'fallback has non-transparent pixels');
  } finally {
    if (prev === undefined) delete process.env.XCURSOR_THEME;
    else process.env.XCURSOR_THEME = prev;
  }
});

test('native: unknown shape with bogus theme returns null', (t) => {
  const addon = tryLoadAddon();
  if (!addon) { t.skip('native addon not built'); return; }
  const prev = process.env.XCURSOR_THEME;
  process.env.XCURSOR_THEME = 'overdraw-test-this-theme-does-not-exist-' + Math.random();
  try {
    const r = addon.resolveCursorShape('not-a-real-cursor-shape-overdraw', 24, 1);
    assert.equal(r, null);
  } finally {
    if (prev === undefined) delete process.env.XCURSOR_THEME;
    else process.env.XCURSOR_THEME = prev;
  }
});
