// Pure-unit tests for the namespace registry. No transport / no Workers; just
// the data structure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NamespaceRegistry } from '../packages/core/dist/plugins/namespace-registry.js';

function reg(plugin, ns, prio, methods = ['m']) {
  return { pluginName: plugin, namespace: ns, priority: prio, methods: new Set(methods) };
}

// --- registration + active selection ---------------------------------------

test('register: empty registry returns no active', () => {
  const r = new NamespaceRegistry();
  assert.equal(r.active('workspace'), null);
});

test('register: a single registration becomes active', () => {
  const r = new NamespaceRegistry();
  const changed = r.register(reg('p1', 'workspace', 100));
  assert.equal(changed, true);
  assert.equal(r.active('workspace').pluginName, 'p1');
});

test('register: higher priority displaces the active', () => {
  const r = new NamespaceRegistry();
  r.register(reg('low', 'workspace', 0));
  assert.equal(r.active('workspace').pluginName, 'low');
  const changed = r.register(reg('high', 'workspace', 100));
  assert.equal(changed, true);
  assert.equal(r.active('workspace').pluginName, 'high');
});

test('register: lower priority does NOT displace the active', () => {
  const r = new NamespaceRegistry();
  r.register(reg('high', 'workspace', 100));
  const changed = r.register(reg('low', 'workspace', 0));
  assert.equal(changed, false);
  assert.equal(r.active('workspace').pluginName, 'high');
});

test('register: ties resolved by registration order (first wins, stays)', () => {
  const r = new NamespaceRegistry();
  r.register(reg('first', 'workspace', 100));
  r.register(reg('second', 'workspace', 100));
  assert.equal(r.active('workspace').pluginName, 'first');
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

test('register: non-finite priority throws', () => {
  const r = new NamespaceRegistry();
  assert.throws(() => r.register(reg('p1', 'workspace', Infinity)), TypeError);
  assert.throws(() => r.register(reg('p1', 'workspace', NaN)), TypeError);
});

// --- unregister + failure promotion ----------------------------------------

test('unregister: removing the active promotes the next-highest', () => {
  const r = new NamespaceRegistry();
  r.register(reg('low', 'workspace', 0));
  r.register(reg('high', 'workspace', 100));
  assert.equal(r.active('workspace').pluginName, 'high');
  const changed = r.unregister('high', 'workspace');
  assert.equal(changed, true);
  assert.equal(r.active('workspace').pluginName, 'low');
});

test('unregister: removing a dormant does NOT change the active', () => {
  const r = new NamespaceRegistry();
  r.register(reg('low', 'workspace', 0));
  r.register(reg('high', 'workspace', 100));
  const changed = r.unregister('low', 'workspace');
  assert.equal(changed, false);
  assert.equal(r.active('workspace').pluginName, 'high');
});

test('unregister: removing the last registration clears the namespace', () => {
  const r = new NamespaceRegistry();
  r.register(reg('only', 'workspace', 100));
  r.unregister('only', 'workspace');
  assert.equal(r.active('workspace'), null);
  assert.deepEqual(r.namespaces(), []);
});

test('unregister: idempotent (unknown plugin/namespace is no-op)', () => {
  const r = new NamespaceRegistry();
  assert.equal(r.unregister('nobody', 'workspace'), false);
  r.register(reg('p1', 'workspace', 100));
  assert.equal(r.unregister('p1', 'other-namespace'), false);
});

test('unregisterAllFor: removes every claim by that plugin', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'workspace', 100));
  r.register(reg('p1', 'layout', 100));
  r.register(reg('p2', 'workspace', 0));
  r.unregisterAllFor('p1');
  assert.equal(r.active('workspace').pluginName, 'p2');
  assert.equal(r.active('layout'), null);
});

// --- introspection ---------------------------------------------------------

test('registrations: returns priority-descending list', () => {
  const r = new NamespaceRegistry();
  r.register(reg('low', 'workspace', 0));
  r.register(reg('mid', 'workspace', 50));
  r.register(reg('high', 'workspace', 100));
  const rs = r.registrations('workspace');
  assert.equal(rs.length, 3);
  assert.equal(rs[0].pluginName, 'high');
  assert.equal(rs[1].pluginName, 'mid');
  assert.equal(rs[2].pluginName, 'low');
});

test('namespaces: lists every namespace with at least one claim', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'workspace', 100));
  r.register(reg('p1', 'layout', 100));
  assert.deepEqual([...r.namespaces()].sort(), ['layout', 'workspace']);
});

// --- onActiveChange notifications ------------------------------------------

test('onActiveChange: fires when first registration claims a namespace', () => {
  const r = new NamespaceRegistry();
  const events = [];
  r.onActiveChange((ns, prev, next) => events.push({ ns, prev: prev?.pluginName ?? null, next: next?.pluginName ?? null }));
  r.register(reg('p1', 'workspace', 100));
  assert.deepEqual(events, [{ ns: 'workspace', prev: null, next: 'p1' }]);
});

test('onActiveChange: fires when higher-priority displaces', () => {
  const r = new NamespaceRegistry();
  r.register(reg('low', 'workspace', 0));
  const events = [];
  r.onActiveChange((ns, prev, next) => events.push({ ns, prev: prev?.pluginName ?? null, next: next?.pluginName ?? null }));
  r.register(reg('high', 'workspace', 100));
  assert.deepEqual(events, [{ ns: 'workspace', prev: 'low', next: 'high' }]);
});

test('onActiveChange: fires when active unregisters and next promotes', () => {
  const r = new NamespaceRegistry();
  r.register(reg('low', 'workspace', 0));
  r.register(reg('high', 'workspace', 100));
  const events = [];
  r.onActiveChange((ns, prev, next) => events.push({ ns, prev: prev?.pluginName ?? null, next: next?.pluginName ?? null }));
  r.unregister('high', 'workspace');
  assert.deepEqual(events, [{ ns: 'workspace', prev: 'high', next: 'low' }]);
});

test('onActiveChange: fires when active unregisters and no fallback exists', () => {
  const r = new NamespaceRegistry();
  r.register(reg('only', 'workspace', 100));
  const events = [];
  r.onActiveChange((ns, prev, next) => events.push({ ns, prev: prev?.pluginName ?? null, next: next?.pluginName ?? null }));
  r.unregister('only', 'workspace');
  assert.deepEqual(events, [{ ns: 'workspace', prev: 'only', next: null }]);
});

test('onActiveChange: does NOT fire when dormant unregisters', () => {
  const r = new NamespaceRegistry();
  r.register(reg('low', 'workspace', 0));
  r.register(reg('high', 'workspace', 100));
  const events = [];
  r.onActiveChange((ns, prev, next) => events.push({ ns, prev: prev?.pluginName ?? null, next: next?.pluginName ?? null }));
  r.unregister('low', 'workspace');
  assert.deepEqual(events, []);
});

test('onActiveChange: throwing listener does not break the registry', () => {
  const r = new NamespaceRegistry();
  r.onActiveChange(() => { throw new Error('boom'); });
  let reached = false;
  r.onActiveChange(() => { reached = true; });
  // Should not throw, and second listener should still fire.
  r.register(reg('p1', 'workspace', 100));
  assert.equal(reached, true);
});

test('onActiveChange: unsubscribe stops delivery', () => {
  const r = new NamespaceRegistry();
  const events = [];
  const off = r.onActiveChange((ns, prev, next) => events.push({ ns, next: next?.pluginName }));
  r.register(reg('p1', 'workspace', 100));
  off();
  r.register(reg('p2', 'workspace', 200));   // would have been an active change
  assert.equal(events.length, 1);
});

test('unregisterAllFor: fires one change per affected namespace', () => {
  const r = new NamespaceRegistry();
  r.register(reg('p1', 'workspace', 100));
  r.register(reg('p1', 'layout', 100));
  const events = [];
  r.onActiveChange((ns) => events.push(ns));
  r.unregisterAllFor('p1');
  assert.deepEqual(events.sort(), ['layout', 'workspace']);
});
