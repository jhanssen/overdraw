import { test } from "node:test";
import assert from "node:assert/strict";

import makeShortcutsInhibitManager, {
  makeShortcutsInhibitor, keyboardShortcutsInhibited, notifyShortcutsInhibitorFocus,
} from "../packages/core/dist/protocols/zwp_keyboard_shortcuts_inhibit_manager_v1.js";

// focusedSurfaceId: the surface that currently holds keyboard focus (undefined
// = none). Each call builds an isolated ctx (the registry is keyed by ctx).
function mkCtx(focusedSurfaceId) {
  const active = [], inactive = [], errors = [];
  const surfaces = new Map();
  const ctx = {
    addon: { postError: (res, code, msg) => errors.push({ res, code, msg }) },
    events: {
      zwp_keyboard_shortcuts_inhibitor_v1: {
        send_active: (r) => active.push(r),
        send_inactive: (r) => inactive.push(r),
      },
    },
    state: {
      surfaces,
      seat: { kbFocus: focusedSurfaceId === undefined ? null : { surfaceId: focusedSurfaceId } },
    },
  };
  return { ctx, active, inactive, errors, surfaces };
}
const surfaceRes = (id, surfaces) => { const r = {}; surfaces.set(r, { id }); return r; };

test("inhibit_shortcuts on the focused surface sends active immediately", () => {
  const { ctx, active, surfaces } = mkCtx(5);
  const surf = surfaceRes(5, surfaces);
  const inh = {};
  makeShortcutsInhibitManager(ctx).inhibit_shortcuts({}, inh, surf, {});
  assert.deepEqual(active, [inh]);
  assert.equal(keyboardShortcutsInhibited(ctx), true);
});

test("inhibit on an unfocused surface does not activate; focus elsewhere is not inhibited", () => {
  const { ctx, active, surfaces } = mkCtx(99);
  const surf = surfaceRes(5, surfaces);
  makeShortcutsInhibitManager(ctx).inhibit_shortcuts({}, {}, surf, {});
  assert.equal(active.length, 0);
  assert.equal(keyboardShortcutsInhibited(ctx), false);
});

test("a second inhibitor for the same surface posts already_inhibited", () => {
  const { ctx, errors, surfaces } = mkCtx(5);
  const surf = surfaceRes(5, surfaces);
  const mgr = makeShortcutsInhibitManager(ctx);
  mgr.inhibit_shortcuts({}, {}, surf, {});
  const mgrRes = {};
  mgr.inhibit_shortcuts(mgrRes, {}, surf, {});
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 0);   // already_inhibited
  assert.equal(errors[0].res, mgrRes);
});

test("focus change flips inhibitors active/inactive", () => {
  const { ctx, active, inactive, surfaces } = mkCtx(undefined);
  const surf = surfaceRes(1, surfaces);
  const inh = {};
  makeShortcutsInhibitManager(ctx).inhibit_shortcuts({}, inh, surf, {});
  assert.equal(active.length, 0);                 // not focused yet
  notifyShortcutsInhibitorFocus(ctx, undefined, 1);
  assert.deepEqual(active, [inh]);                // gained focus
  notifyShortcutsInhibitorFocus(ctx, 1, 2);
  assert.deepEqual(inactive, [inh]);              // lost focus
});

test("destroy removes the inhibitor", () => {
  const { ctx, surfaces } = mkCtx(5);
  const surf = surfaceRes(5, surfaces);
  const inh = {};
  makeShortcutsInhibitManager(ctx).inhibit_shortcuts({}, inh, surf, {});
  assert.equal(keyboardShortcutsInhibited(ctx), true);
  makeShortcutsInhibitor(ctx).destroy(inh);
  assert.equal(keyboardShortcutsInhibited(ctx), false);
});
