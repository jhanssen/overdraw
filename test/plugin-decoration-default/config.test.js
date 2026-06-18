// Pure-unit tests for the bundled decoration plugin's config validator.
// validateConfig is a pure function (raw unknown -> ResolvedConfig);
// these pin the defaults, the schema, and the color-string parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateConfig, parseColor,
} from '../../packages/plugin-decoration-default/dist/config.js';

// ---- validateConfig: defaults ----------------------------------------------

test('validateConfig: null / undefined / {} use the same defaults', () => {
  const a = validateConfig(null);
  const b = validateConfig(undefined);
  const c = validateConfig({});
  assert.equal(a.appIdPattern, '.*');
  assert.equal(a.borderWidth, 2);
  assert.equal(a.borderRadius, 8);
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

test('validateConfig: custom border values pass through', () => {
  const c = validateConfig({ border: { width: 4, radius: 16 } });
  assert.equal(c.borderWidth, 4);
  assert.equal(c.borderRadius, 16);
});

test('validateConfig: border.width and border.radius accept 0 (no rounding)', () => {
  const c = validateConfig({ border: { width: 0, radius: 0 } });
  assert.equal(c.borderWidth, 0);
  assert.equal(c.borderRadius, 0);
});

test('validateConfig: rejects negative border.width / radius', () => {
  assert.throws(() => validateConfig({ border: { width: -1 } }), /non-negative/);
  assert.throws(() => validateConfig({ border: { radius: -1 } }), /non-negative/);
});

test('validateConfig: rejects non-finite border values (NaN, Infinity)', () => {
  assert.throws(() => validateConfig({ border: { width: NaN } }), /non-negative finite/);
  assert.throws(() => validateConfig({ border: { radius: Infinity } }), /non-negative finite/);
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
