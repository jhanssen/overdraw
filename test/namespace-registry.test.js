// Pure-unit tests for the namespace registry. No transport / no Workers; just
// the data structure. Claims are inert bookkeeping; active() reflects only
// ACTIVATED claims (the runtime activates via markActivated after running
// the claimant's init).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceRegistry } from '../packages/core/dist/plugins/namespace-registry.js';

function reg(plugin, ns, prio) {
  return { pluginName: plugin, namespace: ns, priority: prio, methods: null };
}

// --- claims + top-claim selection -------------------------------------------

test('register: empty registry has no active and no top claim', () => {
  const r = new NamespaceRegistry();
  assert.equal(r.active('workspace'), null);
  assert.equal(r.topClaim('workspace'), null);
});

test('register: a claim is inert -- topClaim is set, active stays null', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'workspace', 100));
  assert.equal(r.topClaim('workspace').pluginName, 'p1');
  assert.equal(r.active('workspace'), null);
});

test('register: higher priority becomes the top claim', () => {
  const r = new NamespaceRegistry();
  r.register(reg('low', 'workspace', 0));
  r.register(reg('high', 'workspace', 100));
  assert.equal(r.topClaim('workspace').pluginName, 'high');
});

test('register: ties resolved by registration order (first wins, stays)', () => {
  const r = new NamespaceRegistry();
  r.register(reg('first', 'workspace', 100));
  r.register(reg('second', 'workspace', 100));
  assert.equal(r.topClaim('workspace').pluginName, 'first');
});

test('register: duplicate (plugin, namespace) throws', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'workspace', 100));
  assert.throws(() => r.register(reg('p1', 'workspace', 50)), /already registered/);
});

test('register: empty/missing namespace throws', () => {
  const r = new NamespaceRegistry();
  assert.throws(() => r.register(reg('p1', '', 100)), TypeError);
});

// --- activation --------------------------------------------------------------

test('markActivated: makes the claim active and records methods', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'workspace', 100));
  r.markActivated('workspace', 'p1', ['show', 'list']);
  const active = r.active('workspace');
  assert.equal(active.pluginName, 'p1');
  assert.ok(active.methods.has('show'));
  assert.ok(active.methods.has('list'));
});

test('markActivated: a non-top claim can be activated (runtime decides)', () => {
  const r = new NamespaceRegistry();
  r.register(reg('high', 'workspace', 100));
  r.register(reg('low', 'workspace', 0));
  r.markActivated('workspace', 'low', []);
  assert.equal(r.active('workspace').pluginName, 'low');
});

test('markActivated: unknown claim throws', () => {
  const r = new NamespaceRegistry();
  assert.throws(() => r.markActivated('workspace', 'ghost', []), /no claim/);
});

test('markActivated: activating over a different activated claim throws', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'workspace', 100));
  r.register(reg('p2', 'workspace', 0));
  r.markActivated('workspace', 'p1', []);
  assert.throws(() => r.markActivated('workspace', 'p2', []), /already activated/);
});

test('a claim registered above the activated one does not change active()', () => {
  const r = new NamespaceRegistry();
  r.register(reg('bundled', 'workspace', 0));
  r.markActivated('workspace', 'bundled', []);
  r.register(reg('user', 'workspace', 100));
  assert.equal(r.active('workspace').pluginName, 'bundled');
  assert.equal(r.topClaim('workspace').pluginName, 'user');
});

// --- unregister --------------------------------------------------------------

test('unregister: removing the activated claim clears active', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'workspace', 100));
  r.register(reg('p2', 'workspace', 0));
  r.markActivated('workspace', 'p1', []);
  r.unregister('p1', 'workspace');
  assert.equal(r.active('workspace'), null);
  assert.equal(r.topClaim('workspace').pluginName, 'p2');
});

test('unregister: removing a dormant claim leaves active untouched', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'workspace', 100));
  r.register(reg('p2', 'workspace', 0));
  r.markActivated('workspace', 'p1', []);
  r.unregister('p2', 'workspace');
  assert.equal(r.active('workspace').pluginName, 'p1');
});

test('unregister: unknown claim is a silent no-op', () => {
  const r = new NamespaceRegistry();
  assert.equal(r.unregister('ghost', 'workspace'), false);
});

test('unregisterAllFor: removes every claim by that plugin', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'workspace', 100));
  r.register(reg('p1', 'layout', 100));
  r.register(reg('p2', 'workspace', 0));
  r.unregisterAllFor('p1');
  assert.equal(r.topClaim('workspace').pluginName, 'p2');
  assert.equal(r.topClaim('layout'), null);
});

// --- onChange notifications ---------------------------------------------------

test('onChange: claim-added fires on register', () => {
  const r = new NamespaceRegistry();
  const events = [];
  r.onChange((ns, ch) => events.push({ ns, kind: ch.kind, plugin: ch.registration.pluginName }));
  r.register(reg('p1', 'workspace', 100));
  assert.deepEqual(events, [{ ns: 'workspace', kind: 'claim-added', plugin: 'p1' }]);
});

test('onChange: activated fires on markActivated', () => {
  const r = new NamespaceRegistry();
  const events = [];
  r.register(reg('p1', 'workspace', 100));
  r.onChange((ns, ch) => events.push(ch.kind));
  r.markActivated('workspace', 'p1', []);
  assert.deepEqual(events, ['activated']);
});

test('onChange: claim-removed carries wasActivated for the activated claim', () => {
  const r = new NamespaceRegistry();
  const events = [];
  r.register(reg('p1', 'workspace', 100));
  r.register(reg('p2', 'workspace', 0));
  r.markActivated('workspace', 'p1', []);
  r.onChange((ns, ch) => events.push({ kind: ch.kind, wasActivated: ch.wasActivated }));
  r.unregister('p1', 'workspace');
  r.unregister('p2', 'workspace');
  assert.deepEqual(events, [
    { kind: 'claim-removed', wasActivated: true },
    { kind: 'claim-removed', wasActivated: false },
  ]);
});

test('onChange: throwing listener does not break the registry', () => {
  const r = new NamespaceRegistry();
  r.onChange(() => { throw new Error('boom'); });
  let reached = false;
  r.onChange(() => { reached = true; });
  r.register(reg('p1', 'workspace', 100));
  assert.equal(reached, true);
  assert.equal(r.topClaim('workspace').pluginName, 'p1');
});

test('onChange: unsubscribe stops delivery', () => {
  const r = new NamespaceRegistry();
  const events = [];
  const off = r.onChange((ns) => events.push(ns));
  r.register(reg('p1', 'workspace', 100));
  off();
  r.register(reg('p2', 'workspace', 0));
  assert.deepEqual(events, ['workspace']);
});

test('unregisterAllFor: fires one claim-removed per affected namespace', () => {
  const r = new NamespaceRegistry();
  const events = [];
  r.register(reg('p1', 'workspace', 100));
  r.register(reg('p1', 'layout', 100));
  r.onChange((ns, ch) => { if (ch.kind === 'claim-removed') events.push(ns); });
  r.unregisterAllFor('p1');
  assert.deepEqual(events.sort(), ['layout', 'workspace']);
});

// --- introspection ------------------------------------------------------------

test('registrations: priority-descending order', () => {
  const r = new NamespaceRegistry();
  r.register(reg('low', 'workspace', 0));
  r.register(reg('high', 'workspace', 100));
  r.register(reg('mid', 'workspace', 50));
  assert.deepEqual(r.registrations('workspace').map((x) => x.pluginName),
    ['high', 'mid', 'low']);
});

test('namespaces: first-claim order', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'layout', 0));
  r.register(reg('p2', 'workspace', 0));
  r.register(reg('p3', 'layout', 100));
  assert.deepEqual([...r.namespaces()], ['layout', 'workspace']);
});
