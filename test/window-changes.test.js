// Core-side window-change coalescing (src/protocols/window-changes.ts). GPU-free.
// Exercises the dirty-set -> one-window.change-per-surface flush, dedup, the
// skip-unmapped guard, and the no-bus short-circuit, against a hand-built minimal
// CompositorState (no live server needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TypedBus } from '../packages/core/dist/events/bus.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';
import { markWindowChanged, flushWindowChanges } from '../packages/core/dist/protocols/window-changes.js';

// Build a minimal CompositorState with one mapped toplevel (surfaceId) whose
// toplevel record carries title/appId. titleAppId() resolves via
// surface.xdgSurface.toplevel -> state.toplevels.get(tl).
function makeState({ surfaceId = 1, title = 'T', appId = 'app', mapped = true, kbFocusId = null } = {}) {
  const tlResource = { __tl: true };
  const surface = { id: surfaceId, role: 'xdg_toplevel', mapped, xdgSurface: { toplevel: tlResource } };
  const toplevels = new Map([[tlResource, { title, appId }]]);
  const bus = new TypedBus();
  const events = [];
  bus.on(WINDOW_EVENT.change, (ev) => events.push(ev));
  const state = {
    surfaces: new Map([[surface.resource ?? {}, surface]]),
    toplevels,
    bus,
    seat: kbFocusId == null ? undefined : { kbFocus: { surfaceId: kbFocusId } },
  };
  return { state, events, surfaceId };
}

test('coalesces multiple field changes into one window.change', () => {
  const { state, events, surfaceId } = makeState({ title: 'New', appId: 'foo' });
  markWindowChanged(state, surfaceId, 'title');
  markWindowChanged(state, surfaceId, 'appId');
  markWindowChanged(state, surfaceId, 'title');   // dup field
  flushWindowChanges(state);
  assert.equal(events.length, 1);
  assert.equal(events[0].surfaceId, surfaceId);
  assert.deepEqual([...events[0].changed].sort(), ['appId', 'title']);
  assert.equal(events[0].title, 'New');
  assert.equal(events[0].appId, 'foo');
});

test('activated edges carry the recorded focus reason; other edges do not', () => {
  const { state, events, surfaceId } = makeState({ kbFocusId: 1 });
  state.lastFocusReason = 'pointer-enter';
  markWindowChanged(state, surfaceId, 'activated');
  flushWindowChanges(state);
  assert.equal(events.length, 1);
  assert.equal(events[0].focusReason, 'pointer-enter');
  // A title-only change has no focus cause to report.
  markWindowChanged(state, surfaceId, 'title');
  flushWindowChanges(state);
  assert.equal(events[1].focusReason, undefined);
});

test('flush clears pending so a second flush emits nothing', () => {
  const { state, events, surfaceId } = makeState();
  markWindowChanged(state, surfaceId, 'title');
  flushWindowChanges(state);
  flushWindowChanges(state);
  assert.equal(events.length, 1);
});

test('activated reflects keyboard focus at flush time', () => {
  const focused = makeState({ surfaceId: 7, kbFocusId: 7 });
  markWindowChanged(focused.state, 7, 'activated');
  flushWindowChanges(focused.state);
  assert.equal(focused.events[0].activated, true);

  const unfocused = makeState({ surfaceId: 7, kbFocusId: 9 });
  markWindowChanged(unfocused.state, 7, 'activated');
  flushWindowChanges(unfocused.state);
  assert.equal(unfocused.events[0].activated, false);
});

test('skips a surface that is no longer a mapped toplevel', () => {
  const { state, events, surfaceId } = makeState({ mapped: false });
  markWindowChanged(state, surfaceId, 'title');
  flushWindowChanges(state);
  assert.equal(events.length, 0);
});

test('no bus -> markWindowChanged is a no-op (no pending bookkeeping)', () => {
  const state = { surfaces: new Map(), toplevels: new Map() }; // no bus
  markWindowChanged(state, 1, 'title');
  assert.equal(state.pendingWindowChanges, undefined);
  // flush on a bus-less state must not throw
  assert.doesNotThrow(() => flushWindowChanges(state));
});
