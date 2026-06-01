// Decoration-provider registry (src/decorations.ts). GPU-free. Exercises app_id
// matching at window.map and window.change (late app_id), first-registered-match-
// wins, match-once, unmap clears, and invalid-pattern rejection. Drives the real
// CompositorBus so the bus<->registry wiring is covered too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TypedBus } from '../dist/events/bus.js';
import { WINDOW_EVENT, DECORATION_EVENT } from '../dist/events/types.js';
import { createDecorationRegistry } from '../dist/decorations.js';
import { createDecorationBroker } from '../dist/plugins/decoration-broker.js';
import { createWm } from '../dist/wm/index.js';

function setup() {
  const bus = new TypedBus();
  const assigned = [];
  const reg = createDecorationRegistry(bus, (plugin, name, data) => {
    assigned.push({ plugin, name, data });
  });
  return { bus, reg, assigned };
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
  assert.equal(assigned[0].name, DECORATION_EVENT.assigned);
  assert.deepEqual(assigned[0].data, { surfaceId: 1, appId: 'org.foo.term', title: 'T', rect });
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
  assert.equal(assigned[0].data.appId, 'late');
  assert.deepEqual(assigned[0].data.rect, rect);     // reused the map-time rect
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

// --- broker: requestInsets authorization -----------------------------------

function brokerSetup() {
  const bus = new TypedBus();
  const sink = { setSurfaceLayout() {}, setStack() {} };
  const wm = createWm(sink, { width: 1280, height: 720 });
  const broker = createDecorationBroker({ bus, state: { wm }, emitToPlugin: () => {} });
  return { bus, wm, broker };
}

test('requestInsets: assigned plugin gets the grant', () => {
  const { bus, wm, broker } = brokerSetup();
  broker.onRequest('deco', 'decoration.register', { pattern: 'app' });
  const rect = wm.mapWindow(1, { resource: {} }, 200, 100);
  bus.emit(WINDOW_EVENT.map, { surfaceId: 1, appId: 'app', title: null, rect });
  const grant = broker.onRequest('deco', 'decoration.requestInsets',
    { surfaceId: 1, insets: { top: 24, right: 0, bottom: 0, left: 0 } });
  assert.deepEqual(grant.insets, { top: 24, right: 0, bottom: 0, left: 0 });
  assert.deepEqual(grant.outerRect, { x: rect.x, y: rect.y - 24, width: rect.width, height: rect.height + 24 });
});

test('requestInsets: a plugin NOT assigned the window is rejected', () => {
  const { bus, wm, broker } = brokerSetup();
  broker.onRequest('deco', 'decoration.register', { pattern: 'app' });
  const rect = wm.mapWindow(1, { resource: {} }, 200, 100);
  bus.emit(WINDOW_EVENT.map, { surfaceId: 1, appId: 'app', title: null, rect });
  assert.throws(
    () => broker.onRequest('intruder', 'decoration.requestInsets',
      { surfaceId: 1, insets: { top: 1, right: 1, bottom: 1, left: 1 } }),
    /not assigned/);
});

test('requestInsets: unknown/unmapped surface is rejected', () => {
  const { broker } = brokerSetup();
  broker.onRequest('deco', 'decoration.register', { pattern: 'app' });
  // never assigned -> auth check fails first
  assert.throws(
    () => broker.onRequest('deco', 'decoration.requestInsets',
      { surfaceId: 99, insets: { top: 1, right: 1, bottom: 1, left: 1 } }),
    /not assigned/);
});

test('register: invalid params rejected (missing pattern)', () => {
  const { broker } = brokerSetup();
  assert.throws(() => broker.onRequest('p', 'decoration.register', {}), /pattern/);
});
