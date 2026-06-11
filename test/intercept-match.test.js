// Pure-unit tests for the intercept match engine: registration order
// determines first-match-wins; app_id regex matching; app_id change
// triggers re-evaluation; unmap clears assignments; remove-registration
// re-evaluates freed surfaces against remaining registrations.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MatchEngine, compileAppIdRegex } from '../packages/core/dist/intercept/match-engine.js';

function reg(id, opts = {}) {
  return {
    id,
    pluginName: opts.pluginName ?? `plugin-${id}`,
    appIdRegex: opts.appIdRegex ?? null,
    roles: opts.roles ?? null,
  };
}

function top(surfaceId, appId = null, title = null) {
  return { surfaceId, appId, title };
}

// --- compileAppIdRegex ----------------------------------------------------

test('match engine: compileAppIdRegex compiles spec to RegExp', () => {
  const r = compileAppIdRegex({ source: '^firefox', flags: 'i' });
  assert.ok(r instanceof RegExp);
  assert.equal(r.test('Firefox'), true);
  assert.equal(r.test('chromium'), false);
});

test('match engine: compileAppIdRegex returns null for undefined spec', () => {
  assert.equal(compileAppIdRegex(undefined), null);
});

test('match engine: compileAppIdRegex throws on invalid pattern', () => {
  assert.throws(() => compileAppIdRegex({ source: '[', flags: '' }), SyntaxError);
});

// --- addRegistration ------------------------------------------------------

test('match engine: addRegistration matches existing toplevels', () => {
  const e = new MatchEngine();
  e.onToplevelMapped(top(1, 'firefox'));
  e.onToplevelMapped(top(2, 'chrome'));
  const events = e.addRegistration(reg(100, { appIdRegex: /^firefox$/ }));
  assert.deepEqual(events, [{ kind: 'matched', registrationId: 100, surfaceId: 1 }]);
  assert.equal(e.registrationFor(1), 100);
  assert.equal(e.registrationFor(2), undefined);
});

test('match engine: addRegistration empty match matches everything', () => {
  const e = new MatchEngine();
  e.onToplevelMapped(top(1, 'a'));
  e.onToplevelMapped(top(2, 'b'));
  // Spec with no appId / no roles -> always matches.
  const events = e.addRegistration(reg(100));
  // Both toplevels matched; order is iteration order over the toplevels map.
  assert.equal(events.length, 2);
  assert.ok(events.every((ev) => ev.kind === 'matched' && ev.registrationId === 100));
});

test('match engine: addRegistration skips already-assigned surfaces', () => {
  const e = new MatchEngine();
  e.onToplevelMapped(top(1, 'firefox'));
  e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  // Second registration with a wider pattern; surface 1 is already
  // assigned to 100, so it stays with 100.
  const events = e.addRegistration(reg(200, { appIdRegex: /.*/ }));
  assert.deepEqual(events, []);
  assert.equal(e.registrationFor(1), 100);
});

test('match engine: no app_id -> no match (waits for set_app_id)', () => {
  const e = new MatchEngine();
  e.onToplevelMapped(top(1, null));   // app_id not set yet
  const events = e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  assert.deepEqual(events, []);
});

// --- onToplevelMapped -----------------------------------------------------

test('match engine: onToplevelMapped assigns to first matching reg', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  e.addRegistration(reg(200, { appIdRegex: /.*/ }));
  const events = e.onToplevelMapped(top(1, 'firefox'));
  assert.deepEqual(events, [{ kind: 'matched', registrationId: 100, surfaceId: 1 }]);
});

test('match engine: onToplevelMapped no match -> no event', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  const events = e.onToplevelMapped(top(1, 'chrome'));
  assert.deepEqual(events, []);
  assert.equal(e.registrationFor(1), undefined);
});

// --- onToplevelUnmapped ---------------------------------------------------

test('match engine: onToplevelUnmapped fires unmatched + clears assignment', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /.*/ }));
  e.onToplevelMapped(top(1, 'firefox'));
  const events = e.onToplevelUnmapped(1);
  assert.deepEqual(events, [{ kind: 'unmatched', registrationId: 100, surfaceId: 1 }]);
  assert.equal(e.registrationFor(1), undefined);
});

test('match engine: onToplevelUnmapped on unassigned surface is silent', () => {
  const e = new MatchEngine();
  e.onToplevelMapped(top(1, 'firefox'));   // no registration, no assignment
  const events = e.onToplevelUnmapped(1);
  assert.deepEqual(events, []);
});

// --- onToplevelChanged ----------------------------------------------------

test('match engine: appId change can promote unmatched -> matched', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  e.onToplevelMapped(top(1, 'chrome'));   // doesn't match
  const events = e.onToplevelChanged(1, 'firefox', null);
  assert.deepEqual(events, [{ kind: 'matched', registrationId: 100, surfaceId: 1 }]);
});

test('match engine: appId change can demote matched -> unmatched', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  e.onToplevelMapped(top(1, 'firefox'));
  const events = e.onToplevelChanged(1, 'chrome', null);
  assert.deepEqual(events, [{ kind: 'unmatched', registrationId: 100, surfaceId: 1 }]);
});

test('match engine: appId change can switch winner', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  e.addRegistration(reg(200, { appIdRegex: /chrome/ }));
  e.onToplevelMapped(top(1, 'firefox'));   // assigned to 100
  const events = e.onToplevelChanged(1, 'chrome', null);
  assert.deepEqual(events, [
    { kind: 'unmatched', registrationId: 100, surfaceId: 1 },
    { kind: 'matched', registrationId: 200, surfaceId: 1 },
  ]);
});

test('match engine: appId change with no effective change is silent', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  e.onToplevelMapped(top(1, 'firefox'));
  // Same matching app_id -> no winner change.
  const events = e.onToplevelChanged(1, 'firefox', 'new title');
  assert.deepEqual(events, []);
});

test('match engine: onToplevelChanged on unmapped surface is silent', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  const events = e.onToplevelChanged(99, 'firefox', null);
  assert.deepEqual(events, []);
});

// --- removeRegistration ---------------------------------------------------

test('match engine: removeRegistration fires unmatched for assigned surfaces', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /.*/ }));
  e.onToplevelMapped(top(1, 'firefox'));
  e.onToplevelMapped(top(2, 'chrome'));
  const events = e.removeRegistration(100);
  // Both surfaces unmatched; order is iteration order.
  const kinds = events.map((ev) => ev.kind);
  assert.deepEqual(kinds, ['unmatched', 'unmatched']);
  const ids = new Set(events.map((ev) => ev.surfaceId));
  assert.deepEqual([...ids].sort(), [1, 2]);
  assert.equal(e.registrationFor(1), undefined);
  assert.equal(e.registrationFor(2), undefined);
});

test('match engine: removeRegistration re-assigns freed surfaces', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  e.addRegistration(reg(200, { appIdRegex: /.*/ }));
  e.onToplevelMapped(top(1, 'firefox'));   // assigned to 100 (first)
  const events = e.removeRegistration(100);
  // Surface 1 first unmatches from 100, then matches against 200.
  assert.deepEqual(events, [
    { kind: 'unmatched', registrationId: 100, surfaceId: 1 },
    { kind: 'matched', registrationId: 200, surfaceId: 1 },
  ]);
  assert.equal(e.registrationFor(1), 200);
});

test('match engine: removeRegistration of unknown id is silent', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100));
  const events = e.removeRegistration(999);
  assert.deepEqual(events, []);
});

// --- roles filter ---------------------------------------------------------

test('match engine: roles=["toplevel"] matches', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { roles: ['toplevel'] }));
  const events = e.onToplevelMapped(top(1, 'firefox'));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'matched');
});

test('match engine: roles excluding "toplevel" never matches (10a)', () => {
  const e = new MatchEngine();
  // 10a only tracks toplevels; a filter that excludes "toplevel" never
  // matches anything.
  e.addRegistration(reg(100, { roles: ['popup'] }));
  const events = e.onToplevelMapped(top(1, 'firefox'));
  assert.deepEqual(events, []);
});

// --- introspection --------------------------------------------------------

test('match engine: assignmentList enumerates current matches', () => {
  const e = new MatchEngine();
  e.addRegistration(reg(100, { appIdRegex: /firefox/ }));
  e.addRegistration(reg(200, { appIdRegex: /chrome/ }));
  e.onToplevelMapped(top(1, 'firefox'));
  e.onToplevelMapped(top(2, 'chrome'));
  e.onToplevelMapped(top(3, 'unrelated'));  // no match
  const list = e.assignmentList();
  list.sort((a, b) => a.surfaceId - b.surfaceId);
  assert.deepEqual(list, [
    { surfaceId: 1, registrationId: 100 },
    { surfaceId: 2, registrationId: 200 },
  ]);
});

test('match engine: registerCount tracks active registrations', () => {
  const e = new MatchEngine();
  assert.equal(e.registerCount(), 0);
  e.addRegistration(reg(100));
  e.addRegistration(reg(200));
  assert.equal(e.registerCount(), 2);
  e.removeRegistration(100);
  assert.equal(e.registerCount(), 1);
});
