// Pure-unit tests for the bundled focus plugin's policy state machine.
// No runtime, no addon, no Wayland. decideFocus is a pure function of
// (config, inputs); these pin the follow-pointer + click-to-focus behaviors.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideFocus, validateConfig, DEFAULT_CONFIG,
} from '../../packages/plugin-focus-default/dist/policy.js';

const FOLLOW = { policy: 'follow-pointer', focusOnMap: true };
const CLICK  = { policy: 'click-to-focus', focusOnMap: true };
const NO_MAP = { policy: 'follow-pointer', focusOnMap: false };

// Convenience: a synthetic FocusInputs.
function inputs(reason, opts = {}) {
  return {
    reason,
    pointer: {
      x: opts.x ?? 0, y: opts.y ?? 0,
      surfaceUnderPointer: opts.under === undefined ? null : opts.under,
    },
    currentKeyboardFocus: opts.currentKb === undefined ? null : opts.currentKb,
    ...(opts.trigger !== undefined ? { trigger: opts.trigger } : {}),
  };
}

// ---- validateConfig ---------------------------------------------------------

test('validateConfig: null/undefined uses defaults', () => {
  assert.deepEqual(validateConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(validateConfig(undefined), DEFAULT_CONFIG);
});

test('validateConfig: full custom value passes through', () => {
  const c = validateConfig(
    { policy: 'click-to-focus', focusOnMap: false, followRepick: true });
  assert.deepEqual(c,
    { policy: 'click-to-focus', focusOnMap: false, followRepick: true });
});

test('validateConfig: partial fills with defaults', () => {
  assert.deepEqual(validateConfig({ policy: 'click-to-focus' }),
    { policy: 'click-to-focus', focusOnMap: true, followRepick: false });
  assert.deepEqual(validateConfig({ focusOnMap: false }),
    { policy: 'follow-pointer', focusOnMap: false, followRepick: false });
});

test('validateConfig: rejects non-boolean followRepick', () => {
  assert.throws(() => validateConfig({ followRepick: 1 }), /followRepick/);
});

test('validateConfig: rejects invalid policy string', () => {
  assert.throws(() => validateConfig({ policy: 'nope' }), /focus\.policy/);
});

test('validateConfig: rejects non-boolean focusOnMap', () => {
  assert.throws(() => validateConfig({ focusOnMap: 1 }), /focusOnMap/);
});

test('validateConfig: rejects non-object input', () => {
  assert.throws(() => validateConfig('hi'), /must be an object/);
  assert.throws(() => validateConfig([1, 2]), /must be an object/);
});

// ---- follow-pointer ---------------------------------------------------------

test('follow-pointer: pointer-enter focuses surface under pointer', () => {
  const r = decideFocus(FOLLOW, inputs('pointer-enter', { under: 42 }));
  assert.deepEqual(r, { keyboardFocus: 42 });
});

test('follow-pointer: pointer-enter with no surface focuses null', () => {
  const r = decideFocus(FOLLOW, inputs('pointer-enter', { under: null }));
  assert.deepEqual(r, { keyboardFocus: null });
});

test('follow-pointer: pointer-leave clears focus', () => {
  const r = decideFocus(FOLLOW, inputs('pointer-leave', { currentKb: 42 }));
  assert.deepEqual(r, { keyboardFocus: null });
});

test('follow-pointer: pointer-button does NOT change focus', () => {
  const r = decideFocus(FOLLOW, inputs('pointer-button',
    { under: 99, currentKb: 42 }));
  assert.deepEqual(r, {});
});

// pointer-repick = the world moved under a stationary pointer (camera
// flight, strip scroll, retile). Ignored by default so camera motion
// never hands focus to whatever slides under the cursor; followRepick
// opts back into treating it as pointer motion.
test('follow-pointer: pointer-repick is ignored by default', () => {
  const r = decideFocus(FOLLOW, inputs('pointer-repick',
    { under: 99, currentKb: 42 }));
  assert.deepEqual(r, {});
});

test('follow-pointer + followRepick: pointer-repick refocuses (and clears on null)', () => {
  const cfg = { ...FOLLOW, followRepick: true };
  assert.deepEqual(
    decideFocus(cfg, inputs('pointer-repick', { under: 99, currentKb: 42 })),
    { keyboardFocus: 99 });
  assert.deepEqual(
    decideFocus(cfg, inputs('pointer-repick', { currentKb: 42 })),
    { keyboardFocus: null });
});

test('click-to-focus: pointer-repick is ignored even with followRepick', () => {
  const r = decideFocus({ ...CLICK, followRepick: true },
    inputs('pointer-repick', { under: 99, currentKb: 42 }));
  assert.deepEqual(r, {});
});

// ---- click-to-focus ---------------------------------------------------------

test('click-to-focus: pointer-enter does NOT change focus', () => {
  const r = decideFocus(CLICK, inputs('pointer-enter', { under: 42 }));
  assert.deepEqual(r, {});
});

test('click-to-focus: pointer-leave does NOT change focus', () => {
  const r = decideFocus(CLICK, inputs('pointer-leave', { currentKb: 42 }));
  assert.deepEqual(r, {});
});

test('click-to-focus: pointer-button over surface focuses it', () => {
  const r = decideFocus(CLICK, inputs('pointer-button',
    { under: 99, currentKb: 42 }));
  assert.deepEqual(r, { keyboardFocus: 99 });
});

test('click-to-focus: pointer-button with no surface does NOT change focus', () => {
  const r = decideFocus(CLICK, inputs('pointer-button',
    { under: null, currentKb: 42 }));
  assert.deepEqual(r, {});
});

// ---- focusOnMap (both policies) --------------------------------------------

test('focusOnMap=true: window-mapped focuses the trigger', () => {
  for (const cfg of [FOLLOW, CLICK]) {
    const r = decideFocus(cfg, inputs('window-mapped', { trigger: 7 }));
    assert.deepEqual(r, { keyboardFocus: 7 },
      `policy=${cfg.policy}`);
  }
});

test('focusOnMap=false: window-mapped does NOT change focus', () => {
  const r = decideFocus(NO_MAP, inputs('window-mapped', { trigger: 7 }));
  assert.deepEqual(r, {});
});

test('window-mapped without trigger does NOT change focus (defensive)', () => {
  const r = decideFocus(FOLLOW, inputs('window-mapped'));
  assert.deepEqual(r, {});
});

// ---- window-unmapped --------------------------------------------------------

test('window-unmapped of the focused window clears focus', () => {
  const r = decideFocus(FOLLOW, inputs('window-unmapped',
    { trigger: 42, currentKb: 42 }));
  assert.deepEqual(r, { keyboardFocus: null });
});

test('window-unmapped of a different window does NOT change focus', () => {
  const r = decideFocus(FOLLOW, inputs('window-unmapped',
    { trigger: 99, currentKb: 42 }));
  assert.deepEqual(r, {});
});

// ---- explicit ---------------------------------------------------------------

test('explicit with trigger focuses it', () => {
  const r = decideFocus(FOLLOW, inputs('explicit', { trigger: 7 }));
  assert.deepEqual(r, { keyboardFocus: 7 });
});

test('explicit without trigger clears focus', () => {
  const r = decideFocus(FOLLOW, inputs('explicit', { currentKb: 42 }));
  assert.deepEqual(r, { keyboardFocus: null });
});

// ---- workspace-changed ------------------------------------------------------

test('follow-pointer: workspace-changed focuses surface now under the pointer', () => {
  const r = decideFocus(FOLLOW, inputs('workspace-changed', { under: 7 }));
  assert.deepEqual(r, { keyboardFocus: 7 });
});

test('follow-pointer: workspace-changed with no surface clears focus', () => {
  const r = decideFocus(FOLLOW, inputs('workspace-changed',
    { under: null, currentKb: 42 }));
  assert.deepEqual(r, { keyboardFocus: null });
});

test('click-to-focus: workspace-changed does NOT change focus', () => {
  const r = decideFocus(CLICK, inputs('workspace-changed',
    { under: 7, currentKb: 42 }));
  assert.deepEqual(r, {});
});

// ---- window-raised ----------------------------------------------------------

test('window-raised is a no-op in the bundled plugin', () => {
  for (const cfg of [FOLLOW, CLICK]) {
    const r = decideFocus(cfg, inputs('window-raised', { under: 7, currentKb: 42 }));
    assert.deepEqual(r, {}, `policy=${cfg.policy}`);
  }
});
