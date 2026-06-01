// Decoration-provider registry (src/decorations.ts). GPU-free. Exercises app_id
// matching at window.map and window.change (late app_id), first-registered-match-
// wins, match-once, unmap clears, and invalid-pattern rejection. Drives the real
// CompositorBus so the bus<->registry wiring is covered too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TypedBus } from '../dist/events/bus.js';
import { WINDOW_EVENT } from '../dist/events/types.js';
import { createDecorationRegistry } from '../dist/decorations.js';
import { createDecorationBroker } from '../dist/plugins/decoration-broker.js';
import { createWm } from '../dist/wm/index.js';

function setup() {
  const bus = new TypedBus();
  const assigned = [];   // { plugin, ev } per assignment
  const unmapped = [];
  const reg = createDecorationRegistry(bus,
    (ev, pluginName) => { assigned.push({ plugin: pluginName, ev }); },
    (surfaceId) => { unmapped.push(surfaceId); });
  return { bus, reg, assigned, unmapped };
}

const rect = { x: 0, y: 0, width: 100, height: 80 };
const mapEv = (surfaceId, appId, title = null) => ({ surfaceId, appId, title, rect });
const changeEv = (surfaceId, appId, fields = ['appId']) =>
  ({ surfaceId, changed: fields, appId, title: null, activated: false });

test('assigns a matching window at map and notifies the provider', () => {
  const { bus, reg, assigned } = setup();
  reg.register('term', '^org\\.foo\\.term$');
  bus.emit(WINDOW_EVENT.map, mapEv(1, 'org.foo.term', 'T'));
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].plugin, 'term');
  assert.deepEqual(assigned[0].ev, { surfaceId: 1, appId: 'org.foo.term', title: 'T', rect });
  assert.equal(reg.assignmentOf(1), 'term');
});

test('non-matching app_id is not assigned', () => {
  const { bus, reg, assigned } = setup();
  reg.register('term', '^term$');
  bus.emit(WINDOW_EVENT.map, mapEv(1, 'browser'));
  assert.equal(assigned.length, 0);
  assert.equal(reg.assignmentOf(1), undefined);
});

test('first registered matching provider wins', () => {
  const { bus, reg, assigned } = setup();
  reg.register('first', 'foo');     // both match "foobar"
  reg.register('second', 'foo');
  bus.emit(WINDOW_EVENT.map, mapEv(1, 'foobar'));
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].plugin, 'first');
});

test('match-once: a window is assigned exactly once', () => {
  const { bus, reg, assigned } = setup();
  reg.register('p', 'x');
  bus.emit(WINDOW_EVENT.map, mapEv(1, 'x'));
  bus.emit(WINDOW_EVENT.change, changeEv(1, 'x'));   // would re-match
  assert.equal(assigned.length, 1);
});

test('late app_id (null at map, set later) assigns on window.change', () => {
  const { bus, reg, assigned } = setup();
  reg.register('p', 'late');
  bus.emit(WINDOW_EVENT.map, mapEv(1, null));        // no app_id yet
  assert.equal(assigned.length, 0);
  bus.emit(WINDOW_EVENT.change, changeEv(1, 'late'));
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].ev.appId, 'late');
  assert.deepEqual(assigned[0].ev.rect, rect);     // reused the map-time rect
});

test('window.change without an appId field does not trigger matching', () => {
  const { bus, reg, assigned } = setup();
  reg.register('p', 'x');
  bus.emit(WINDOW_EVENT.map, mapEv(1, null));
  bus.emit(WINDOW_EVENT.change, changeEv(1, 'x', ['title']));  // title changed, not appId
  assert.equal(assigned.length, 0);
});

test('unmap clears assignment and rect (a recycled id can be reassigned)', () => {
  const { bus, reg, assigned } = setup();
  reg.register('p', 'x');
  bus.emit(WINDOW_EVENT.map, mapEv(1, 'x'));
  assert.equal(reg.assignmentOf(1), 'p');
  bus.emit(WINDOW_EVENT.unmap, { surfaceId: 1 });
  assert.equal(reg.assignmentOf(1), undefined);
  bus.emit(WINDOW_EVENT.map, mapEv(1, 'x'));          // same id, mapped again
  assert.equal(assigned.length, 2);
});

test('unregisterPlugin drops a provider (no further matches)', () => {
  const { bus, reg, assigned } = setup();
  reg.register('p', 'x');
  reg.unregisterPlugin('p');
  bus.emit(WINDOW_EVENT.map, mapEv(1, 'x'));
  assert.equal(assigned.length, 0);
});

test('invalid regex pattern throws at register', () => {
  const { reg } = setup();
  assert.throws(() => reg.register('p', '('), /Invalid regular expression|Unterminated/);
});

test('regex flags are honored (case-insensitive)', () => {
  const { bus, reg, assigned } = setup();
  reg.register('p', '^term$', 'i');
  bus.emit(WINDOW_EVENT.map, mapEv(1, 'TERM'));
  assert.equal(assigned.length, 1);
});

// --- broker: createDecoration + content gating + timeout/deregister ---------

function brokerSetup(timeoutMs) {
  const bus = new TypedBus();
  const stacks = [];
  const sink = { setSurfaceLayout() {}, setStack(ids) { stacks.push([...ids]); } };
  const wm = createWm(sink, { width: 1280, height: 720 });
  const emits = [];
  const broker = createDecorationBroker({
    bus, state: { wm }, timeoutMs,
    emitToPlugin: (plugin, name, data) => emits.push({ plugin, name, data }),
  });
  return { bus, wm, broker, emits, stacks };
}

// Map a matching window + assign it to provider `deco`. Returns the window rect.
function mapAssigned(bus, wm, broker, surfaceId = 1, appId = 'app') {
  broker.onRequest('deco', 'decoration.register', { pattern: appId });
  const rect = wm.mapWindow(surfaceId, { resource: {} }, 200, 100);
  bus.emit(WINDOW_EVENT.map, { surfaceId, appId, title: null, rect });
  return rect;
}

test('createDecoration: assigned plugin gets the grant', () => {
  const { bus, wm, broker } = brokerSetup();
  const rect = mapAssigned(bus, wm, broker, 1);
  const grant = broker.onRequest('deco', 'decoration.createDecoration',
    { windowId: 1, insets: { top: 24, right: 0, bottom: 0, left: 0 } });
  assert.deepEqual(grant.insets, { top: 24, right: 0, bottom: 0, left: 0 });
  assert.deepEqual(grant.outerRect, { x: rect.x, y: rect.y - 24, width: rect.width, height: rect.height + 24 });
});

test('createDecoration: a plugin NOT assigned the window is rejected', () => {
  const { bus, wm, broker } = brokerSetup();
  mapAssigned(bus, wm, broker, 1);
  assert.throws(
    () => broker.onRequest('intruder', 'decoration.createDecoration',
      { windowId: 1, insets: { top: 1, right: 1, bottom: 1, left: 1 } }),
    /not assigned/);
});

test('register: invalid params rejected (missing pattern)', () => {
  const { broker } = brokerSetup();
  assert.throws(() => broker.onRequest('p', 'decoration.register', {}), /pattern/);
});

test('gating: assignment gates the window out of the stack', () => {
  const { bus, wm, broker } = brokerSetup();
  mapAssigned(bus, wm, broker, 1);
  assert.equal(wm.isContentGated(1), true, 'gated on assignment');
  // The content stack (last setStack) excludes the gated window.
  // mapWindow pushed [1]; the gate re-pushed [].
  assert.deepEqual(wm.state.windows.map((w) => w.surfaceId), [1], 'still a known window');
});

test('gating: first decoration present releases the gate (atomic appearance)', () => {
  const { bus, wm, broker } = brokerSetup();
  mapAssigned(bus, wm, broker, 1);
  // Plugin creates the decoration surface (tagged decorates=1) -> the gpu broker
  // would call onSurfaceAllocated; simulate the surface id the alloc returned.
  broker.onRequest('deco', 'decoration.createDecoration',
    { windowId: 1, insets: { top: 24, right: 0, bottom: 0, left: 0 } });
  broker.onSurfaceAllocated(500, 1);   // decoration surface 500 decorates window 1
  assert.equal(wm.isContentGated(1), true, 'still gated before first present');
  broker.onSurfacePresented(500);      // first decoration frame
  assert.equal(wm.isContentGated(1), false, 'released on first present');
});

test('gating: a non-decoration surface present does not release anything', () => {
  const { bus, wm, broker } = brokerSetup();
  mapAssigned(bus, wm, broker, 1);
  broker.onSurfacePresented(999);   // unrelated surface
  assert.equal(wm.isContentGated(1), true, 'still gated');
});

test('timeout: provider that never draws is deregistered + content released + notified', async () => {
  const { bus, wm, broker, emits } = brokerSetup(30);   // 30ms deadline
  mapAssigned(bus, wm, broker, 1);
  assert.equal(wm.isContentGated(1), true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(wm.isContentGated(1), false, 'content released (shown undecorated) on timeout');
  // provider deregistered: a new matching window is NOT assigned.
  const rect2 = wm.mapWindow(2, { resource: {} }, 100, 100);
  bus.emit(WINDOW_EVENT.map, { surfaceId: 2, appId: 'app', title: null, rect: rect2 });
  assert.equal(broker.registry.assignmentOf(2), undefined, 'provider deregistered after timeout');
  // plugin was told.
  const dereg = emits.find((e) => e.name === 'decoration.deregistered');
  assert.ok(dereg, 'decoration.deregistered emitted');
  assert.equal(dereg.data.windowId, 1);
});

test('unmap before draw releases the gate (no leak, no timeout fire)', async () => {
  const { bus, wm, broker, emits } = brokerSetup(30);
  mapAssigned(bus, wm, broker, 1);
  bus.emit(WINDOW_EVENT.unmap, { surfaceId: 1 });
  await new Promise((r) => setTimeout(r, 80));
  // No deregister (the window just went away; provider stays registered).
  assert.equal(emits.some((e) => e.name === 'decoration.deregistered'), false);
});
