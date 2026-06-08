// Pure-unit tests for the action registry. No transport / no Workers; just
// the data structure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActionRegistry } from '../packages/core/dist/plugins/action-registry.js';

function reg(plugin, name, desc, schema) {
  const r = { pluginName: plugin, name };
  if (desc !== undefined) r.description = desc;
  if (schema !== undefined) r.schema = schema;
  return r;
}

// --- registration ---------------------------------------------------------

test('register: empty registry returns null lookup', () => {
  const r = new ActionRegistry();
  assert.equal(r.lookup('workspace.show'), null);
});

test('register: a single action is looked up by name', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'workspace.show', 'show a workspace'));
  const entry = r.lookup('workspace.show');
  assert.equal(entry.pluginName, 'p1');
  assert.equal(entry.name, 'workspace.show');
  assert.equal(entry.description, 'show a workspace');
});

test('register: empty/missing name throws', () => {
  const r = new ActionRegistry();
  assert.throws(() => r.register(reg('p1', '')), TypeError);
});

test('register: empty pluginName throws', () => {
  const r = new ActionRegistry();
  assert.throws(() => r.register(reg('', 'workspace.show')), TypeError);
});

test('register: duplicate name throws (collisions are bugs)', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'workspace.show'));
  assert.throws(() => r.register(reg('p2', 'workspace.show')), /already registered by 'p1'/);
});

test('register: same plugin re-registering same name is also a duplicate error', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'workspace.show'));
  assert.throws(() => r.register(reg('p1', 'workspace.show')), /already registered/);
});

test('register: distinct names from same plugin both register', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'workspace.show'));
  r.register(reg('p1', 'workspace.hide'));
  assert.equal(r.lookup('workspace.show').pluginName, 'p1');
  assert.equal(r.lookup('workspace.hide').pluginName, 'p1');
});

// --- unregister -----------------------------------------------------------

test('unregister: by owner returns true and clears lookup', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'workspace.show'));
  assert.equal(r.unregister('p1', 'workspace.show'), true);
  assert.equal(r.lookup('workspace.show'), null);
});

test('unregister: by non-owner is no-op (and lookup is still owned)', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'workspace.show'));
  assert.equal(r.unregister('p2', 'workspace.show'), false);
  assert.equal(r.lookup('workspace.show').pluginName, 'p1');
});

test('unregister: unknown name is no-op (idempotent)', () => {
  const r = new ActionRegistry();
  assert.equal(r.unregister('p1', 'nope'), false);
  assert.equal(r.unregister('p1', 'still-nope'), false);
});

test('unregisterAllFor: removes every action a plugin owns', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'workspace.show'));
  r.register(reg('p1', 'workspace.hide'));
  r.register(reg('p2', 'window.close'));
  r.unregisterAllFor('p1');
  assert.equal(r.lookup('workspace.show'), null);
  assert.equal(r.lookup('workspace.hide'), null);
  assert.equal(r.lookup('window.close').pluginName, 'p2');
});

test('unregisterAllFor: unknown plugin is no-op', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'workspace.show'));
  r.unregisterAllFor('nobody');
  assert.equal(r.lookup('workspace.show').pluginName, 'p1');
});

// --- list -----------------------------------------------------------------

test('list: empty registry returns empty array', () => {
  const r = new ActionRegistry();
  assert.deepEqual(r.list(), []);
});

test('list: returns entries in alphabetical order', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'window.close'));
  r.register(reg('p2', 'workspace.show'));
  r.register(reg('p3', 'output.list'));
  const names = r.list().map((i) => i.name);
  assert.deepEqual(names, ['output.list', 'window.close', 'workspace.show']);
});

test('list: includes description and schema when set; omits when absent', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'workspace.show', 'show a workspace', { type: 'object' }));
  r.register(reg('p1', 'workspace.hide'));
  const list = r.list();
  const show = list.find((i) => i.name === 'workspace.show');
  const hide = list.find((i) => i.name === 'workspace.hide');
  assert.equal(show.description, 'show a workspace');
  assert.deepEqual(show.schema, { type: 'object' });
  assert.equal(hide.description, undefined);
  assert.equal(hide.schema, undefined);
});

test('list: pluginName is NOT exposed (it is implementation detail)', () => {
  const r = new ActionRegistry();
  r.register(reg('p1', 'workspace.show'));
  const entry = r.list()[0];
  assert.equal(entry.pluginName, undefined);
});
