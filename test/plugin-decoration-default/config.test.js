// Pure-unit tests for the bundled decoration plugin's config validator.
// validateConfig is a pure function (raw unknown -> ResolvedConfig);
// these pin the defaults, the schema, and the color-string parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateConfig, parseColor, insetShape,
} from '../../packages/plugin-decoration-default/dist/config.js';

// ---- validateConfig: defaults ----------------------------------------------

test('validateConfig: null / undefined / {} use the same defaults', () => {
  const a = validateConfig(null);
  const b = validateConfig(undefined);
  const c = validateConfig({});
  assert.equal(a.appIdPattern, '.*');
  assert.equal(a.borderWidth, 2);
  assert.deepEqual(a.outerShape, { kind: 'rounded-rect', radius: 8 });
  assert.equal(a.focused.stops.length, 2);    // gradient
  assert.equal(a.unfocused.stops.length, 1);  // solid
  // All three call shapes return structurally-equal config.
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test('validateConfig: rejects non-object', () => {
  assert.throws(() => validateConfig(42), /must be an object/);
  assert.throws(() => validateConfig('hi'), /must be an object/);
  assert.throws(() => validateConfig([1, 2]), /must be an object/);
});

// ---- appIdPattern -----------------------------------------------------------

test('validateConfig: custom appIdPattern + flags pass through', () => {
  const c = validateConfig({ appIdPattern: '^firefox$', appIdFlags: 'i' });
  assert.equal(c.appIdPattern, '^firefox$');
  assert.equal(c.appIdFlags, 'i');
});

test('validateConfig: rejects empty / non-string appIdPattern', () => {
  assert.throws(() => validateConfig({ appIdPattern: '' }), /non-empty string/);
  assert.throws(() => validateConfig({ appIdPattern: 42 }), /non-empty string/);
});

test('validateConfig: rejects un-compilable regex', () => {
  assert.throws(() => validateConfig({ appIdPattern: '[' }), /not a valid RegExp/);
});

test('validateConfig: rejects non-string appIdFlags', () => {
  assert.throws(() => validateConfig({ appIdFlags: 1 }), /must be a string/);
});

// ---- border -----------------------------------------------------------------

test('validateConfig: custom border.radius shorthand -> rounded-rect outerShape', () => {
  const c = validateConfig({ border: { width: 4, radius: 16 } });
  assert.equal(c.borderWidth, 4);
  assert.deepEqual(c.outerShape, { kind: 'rounded-rect', radius: 16 });
});

test('validateConfig: border.radius=0 collapses to a null (rectangle) outerShape', () => {
  const c = validateConfig({ border: { width: 0, radius: 0 } });
  assert.equal(c.borderWidth, 0);
  assert.equal(c.outerShape, null);
});

test('validateConfig: rejects negative border.width / radius', () => {
  assert.throws(() => validateConfig({ border: { width: -1 } }), /non-negative/);
  assert.throws(() => validateConfig({ border: { radius: -1 } }), /non-negative/);
});

test('validateConfig: rejects non-finite border values (NaN, Infinity)', () => {
  assert.throws(() => validateConfig({ border: { width: NaN } }), /non-negative finite/);
  assert.throws(() => validateConfig({ border: { radius: Infinity } }), /non-negative finite/);
});

// ---- border.shape: explicit shape overrides radius ------------------------

test('validateConfig: explicit border.shape rounded-rect passes through', () => {
  const c = validateConfig({ border: { shape: { kind: 'rounded-rect', radius: 12 } } });
  assert.deepEqual(c.outerShape, { kind: 'rounded-rect', radius: 12 });
});

test('validateConfig: explicit border.shape per-corner', () => {
  const c = validateConfig({
    border: { shape: { kind: 'rounded-rect-per-corner', tl: 12, tr: 12, br: 0, bl: 0 } },
  });
  assert.deepEqual(c.outerShape,
    { kind: 'rounded-rect-per-corner', tl: 12, tr: 12, br: 0, bl: 0 });
});

test('validateConfig: explicit border.shape superellipse (macOS squircle)', () => {
  const c = validateConfig({
    border: { shape: { kind: 'superellipse', exponent: 5, radius: 24 } },
  });
  assert.deepEqual(c.outerShape,
    { kind: 'superellipse', exponent: 5, radius: 24 });
});

test('validateConfig: border.shape null -> sharp rectangle', () => {
  const c = validateConfig({ border: { shape: null } });
  assert.equal(c.outerShape, null);
});

test('validateConfig: border.shape wins over border.radius when both given', () => {
  const c = validateConfig({
    border: { radius: 999, shape: { kind: 'rounded-rect', radius: 7 } },
  });
  assert.deepEqual(c.outerShape, { kind: 'rounded-rect', radius: 7 });
});

test('validateConfig: rejects unknown shape kind', () => {
  assert.throws(() => validateConfig({
    border: { shape: { kind: 'circle' } },
  }), /rounded-rect.*per-corner.*superellipse/);
});

test('validateConfig: rejects per-corner with missing corner', () => {
  assert.throws(() => validateConfig({
    border: { shape: { kind: 'rounded-rect-per-corner', tl: 8, tr: 8, br: 8 } },
  }), /must be a non-negative finite number/);
});

test('validateConfig: rejects superellipse with non-positive exponent', () => {
  assert.throws(() => validateConfig({
    border: { shape: { kind: 'superellipse', exponent: 0, radius: 12 } },
  }), /positive finite/);
  assert.throws(() => validateConfig({
    border: { shape: { kind: 'superellipse', exponent: -1, radius: 12 } },
  }), /positive finite/);
});

// ---- insetShape: derives the content-side shape -----------------------

test('insetShape: rounded-rect shrinks radius by borderWidth', () => {
  assert.deepEqual(insetShape({ kind: 'rounded-rect', radius: 10 }, 2),
    { kind: 'rounded-rect', radius: 8 });
});

test('insetShape: rounded-rect floors at 0 (returns null when fully consumed)', () => {
  assert.equal(insetShape({ kind: 'rounded-rect', radius: 4 }, 8), null);
});

test('insetShape: per-corner shrinks each corner independently', () => {
  assert.deepEqual(insetShape(
    { kind: 'rounded-rect-per-corner', tl: 12, tr: 12, br: 4, bl: 0 }, 4,
  ), { kind: 'rounded-rect-per-corner', tl: 8, tr: 8, br: 0, bl: 0 });
});

test('insetShape: per-corner with all-zero result collapses to null', () => {
  assert.equal(insetShape(
    { kind: 'rounded-rect-per-corner', tl: 2, tr: 2, br: 2, bl: 2 }, 4,
  ), null);
});

test('insetShape: superellipse shrinks radius, preserves exponent', () => {
  assert.deepEqual(insetShape({ kind: 'superellipse', exponent: 5, radius: 20 }, 4),
    { kind: 'superellipse', exponent: 5, radius: 16 });
});

test('insetShape: null is invariant', () => {
  assert.equal(insetShape(null, 4), null);
});

// ---- DecorationFill: solid / linear-gradient --------------------------------

test('validateConfig: solid focused fill', () => {
  const c = validateConfig({ focused: { kind: 'solid', color: '#ff0000' } });
  assert.equal(c.focused.stops.length, 1);
  assert.deepEqual(c.focused.stops[0].color,
    { r: 1, g: 0, b: 0, a: 1 });
});

test('validateConfig: linear-gradient with explicit positions', () => {
  const c = validateConfig({
    focused: {
      kind: 'linear-gradient', angle: 90,
      stops: [
        { color: '#000000', at: 0 },
        { color: '#ffffff', at: 1 },
      ],
    },
  });
  assert.equal(c.focused.stops.length, 2);
  assert.equal(c.focused.angleRad, Math.PI / 2);
  assert.equal(c.focused.stops[0].at, 0);
  assert.equal(c.focused.stops[1].at, 1);
});

test('validateConfig: linear-gradient with omitted positions distributes evenly', () => {
  const c = validateConfig({
    focused: {
      kind: 'linear-gradient',
      stops: [
        { color: '#000000' }, { color: '#888888' }, { color: '#ffffff' },
      ],
    },
  });
  assert.equal(c.focused.stops.length, 3);
  // Evenly distributed: 0, 0.5, 1.
  assert.deepEqual(c.focused.stops.map((s) => s.at), [0, 0.5, 1]);
});

test('validateConfig: gradient stops are sorted by `at` ascending', () => {
  const c = validateConfig({
    focused: {
      kind: 'linear-gradient',
      stops: [
        { color: '#0000ff', at: 1 },
        { color: '#ff0000', at: 0 },
      ],
    },
  });
  assert.deepEqual(c.focused.stops.map((s) => s.at), [0, 1]);
  assert.deepEqual(c.focused.stops[0].color, { r: 1, g: 0, b: 0, a: 1 });
});

test('validateConfig: rejects gradient with <2 stops', () => {
  assert.throws(() => validateConfig({
    focused: { kind: 'linear-gradient', stops: [{ color: '#fff' }] },
  }), />=2 stops/);
});

test('validateConfig: rejects gradient stop `at` outside [0,1]', () => {
  assert.throws(() => validateConfig({
    focused: { kind: 'linear-gradient', stops: [
      { color: '#000', at: -0.1 }, { color: '#fff', at: 1 },
    ] },
  }), /in \[0,1\]/);
});

test('validateConfig: rejects unknown DecorationFill.kind', () => {
  assert.throws(() => validateConfig({
    focused: { kind: 'radial-gradient', stops: [] },
  }), /"solid" or "linear-gradient"/);
});

// ---- parseColor -------------------------------------------------------------

test('parseColor: #rrggbb opaque', () => {
  assert.deepEqual(parseColor('#ff0000', 'x'), { r: 1, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('#00ff00', 'x'), { r: 0, g: 1, b: 0, a: 1 });
  assert.deepEqual(parseColor('#0000ff', 'x'), { r: 0, g: 0, b: 1, a: 1 });
});

test('parseColor: #rrggbbaa with alpha', () => {
  const c = parseColor('#ff000080', 'x');
  assert.equal(c.r, 1);
  assert.equal(c.g, 0);
  assert.equal(c.b, 0);
  assert.ok(Math.abs(c.a - 128 / 255) < 1e-6);
});

test('parseColor: #rgb shorthand expands each nibble', () => {
  // #f00 -> #ff0000 = solid red.
  assert.deepEqual(parseColor('#f00', 'x'), { r: 1, g: 0, b: 0, a: 1 });
  // #08f -> #0088ff.
  const c = parseColor('#08f', 'x');
  assert.equal(c.r, 0);
  assert.ok(Math.abs(c.g - 0x88 / 255) < 1e-6);
  assert.equal(c.b, 1);
  assert.equal(c.a, 1);
});

test('parseColor: rejects malformed strings', () => {
  assert.throws(() => parseColor('red', 'x'), /expected/);
  assert.throws(() => parseColor('#xyz', 'x'), /expected/);
  assert.throws(() => parseColor('#ff', 'x'), /expected/);
  assert.throws(() => parseColor('#fffff', 'x'), /expected/);
  assert.throws(() => parseColor('rgb(1,2,3)', 'x'), /expected/);
});
