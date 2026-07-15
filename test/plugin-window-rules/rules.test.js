// Pure-unit tests for the bundled window-rules plugin. No runtime, no addon,
// no Wayland: a fake sdk captures the window.preconfigure interceptor the
// plugin registers, and the tests drive it with synthetic payloads and assert
// the (possibly modified) returned payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import init from '../../packages/plugin-window-rules/dist/index.js';

// Build a fake sdk; returns the captured interceptor handler (or null if the
// plugin registered none, e.g. empty/absent config).
async function load(rules) {
  let handler = null;
  const logs = [];
  const stamps = [];
  const sdk = {
    name: 'window-rules',
    log: (...a) => logs.push(a.join(' ')),
    events: {
      intercept(pattern, cb) {
        assert.equal(pattern, 'window.preconfigure');
        handler = cb;
        return { unregister() {} };
      },
    },
    windows: {
      async setState(id, key, value) { stamps.push({ id, key, value }); },
    },
  };
  await init(sdk, rules);
  return { handler, logs, stamps };
}

// A synthetic window.preconfigure payload. initialState carries an extra field
// so we can assert it survives the shallow-clone.
function payload(opts = {}) {
  return {
    surfaceId: opts.surfaceId ?? 1,
    appId: opts.appId ?? null,
    title: opts.title ?? null,
    xwayland: opts.xwayland ?? false,
    initialState: { tiling: 'managed', exclusive: 'none', marker: 'keep' },
  };
}

test('appId regex: match floats, non-match is observe-only (undefined)', async () => {
  const { handler } = await load([{ match: { appId: '^Netflix$' }, float: true }]);
  const hit = await handler('window.preconfigure', payload({ appId: 'Netflix' }));
  assert.equal(hit.initialState.tiling, 'floating');
  assert.equal(hit.initialState.marker, 'keep'); // other fields preserved
  // non-match returns undefined (no payload modification)
  assert.equal(await handler('window.preconfigure', payload({ appId: 'firefox' })), undefined);
});

test('null appId never matches an appId regex', async () => {
  const { handler } = await load([{ match: { appId: '.*' }, float: true }]);
  assert.equal(await handler('window.preconfigure', payload({ appId: null })), undefined);
});

test('title regex match', async () => {
  const { handler } = await load([{ match: { title: 'YouTube' }, float: true }]);
  const hit = await handler('window.preconfigure', payload({ title: 'Cats - YouTube' }));
  assert.equal(hit.initialState.tiling, 'floating');
  assert.equal(await handler('window.preconfigure', payload({ title: 'nope' })), undefined);
});

test('appId AND title: both present fields must match', async () => {
  const { handler } = await load([
    { match: { appId: 'mpv', title: '^Big' }, float: true },
  ]);
  // only appId matches -> no
  assert.equal(await handler('window.preconfigure', payload({ appId: 'mpv', title: 'Small' })), undefined);
  // both match -> yes
  const hit = await handler('window.preconfigure', payload({ appId: 'mpv', title: 'Big Buck' }));
  assert.equal(hit.initialState.tiling, 'floating');
});

test('predicate match receives the window query incl. xwayland', async () => {
  const seen = [];
  const { handler } = await load([
    { match: (w) => { seen.push(w); return w.xwayland && w.appId === 'steam'; }, float: true },
  ]);
  assert.equal(await handler('window.preconfigure', payload({ appId: 'steam', xwayland: false })), undefined);
  const hit = await handler('window.preconfigure', payload({ appId: 'steam', xwayland: true }));
  assert.equal(hit.initialState.tiling, 'floating');
  assert.equal(seen.at(-1).xwayland, true);
  assert.equal(seen.at(-1).appId, 'steam');
});

test('apply lambda gets read fields plus the mutable state proposal', async () => {
  const captured = [];
  const { handler } = await load([
    { match: { appId: 'foo' }, apply: (win) => {
        captured.push({ surfaceId: win.surfaceId, appId: win.appId, title: win.title, xwayland: win.xwayland });
        win.state.tiling = 'floating';
      } },
  ]);
  const hit = await handler('window.preconfigure', payload({ appId: 'foo', title: 'bar', surfaceId: 7 }));
  assert.equal(hit.initialState.tiling, 'floating');
  assert.deepEqual(captured[0], { surfaceId: 7, appId: 'foo', title: 'bar', xwayland: false });
});

test('apply lambda can mutate any proposal field (exclusive, visible, constraints)', async () => {
  const { handler } = await load([
    { match: { appId: 'media' }, apply: (win) => {
        win.state.tiling = 'floating';
        win.state.exclusive = 'fullscreen';
        win.state.visible = false;
        win.state.constraints = { minSize: { width: 320, height: 240 }, maxSize: null };
      } },
  ]);
  const hit = await handler('window.preconfigure', payload({ appId: 'media' }));
  assert.equal(hit.initialState.tiling, 'floating');
  assert.equal(hit.initialState.exclusive, 'fullscreen');
  assert.equal(hit.initialState.visible, false);
  assert.deepEqual(hit.initialState.constraints, { minSize: { width: 320, height: 240 }, maxSize: null });
  assert.equal(hit.initialState.marker, 'keep'); // untouched fields preserved
});

test('float:false explicitly tiles; lambda can tile via state', async () => {
  const { handler } = await load([
    { match: { appId: 'x' }, float: false },
    { match: { appId: 'y' }, apply: (w) => { w.state.tiling = 'managed'; } },
  ]);
  // start a payload already-floating to see it forced back to managed
  const p1 = payload({ appId: 'x' });
  p1.initialState.tiling = 'floating';
  assert.equal((await handler('window.preconfigure', p1)).initialState.tiling, 'managed');
  const p2 = payload({ appId: 'y' });
  p2.initialState.tiling = 'floating';
  assert.equal((await handler('window.preconfigure', p2)).initialState.tiling, 'managed');
});

test('multiple matching rules: applied in order, last wins per axis', async () => {
  const { handler } = await load([
    { match: { appId: 'z' }, float: true },
    { match: { appId: 'z' }, float: false },
  ]);
  assert.equal((await handler('window.preconfigure', payload({ appId: 'z' }))).initialState.tiling, 'managed');
});

test('does not mutate the original initialState object', async () => {
  const { handler } = await load([{ match: { appId: 'foo' }, float: true }]);
  const p = payload({ appId: 'foo' });
  const original = p.initialState;
  const hit = await handler('window.preconfigure', p);
  assert.equal(original.tiling, 'managed');      // original untouched
  assert.equal(hit.initialState.tiling, 'floating'); // clone modified
  assert.notEqual(hit.initialState, original);
});

test('apply lambda that throws is caught (logged), does not abort interception', async () => {
  const { handler, logs } = await load([
    { match: { appId: 'foo' }, float: true, apply: () => { throw new Error('boom'); } },
  ]);
  const hit = await handler('window.preconfigure', payload({ appId: 'foo' }));
  assert.equal(hit.initialState.tiling, 'floating'); // declarative float still applied
  assert.ok(logs.some((l) => l.includes('boom')));
});

test('malformed payload is observe-only', async () => {
  const { handler } = await load([{ match: { appId: '.*' }, float: true }]);
  assert.equal(await handler('window.preconfigure', null), undefined);
  assert.equal(await handler('window.preconfigure', { surfaceId: 1 }), undefined); // no initialState
});

test('empty / absent config registers no interceptor', async () => {
  assert.equal((await load([])).handler, null);
  assert.equal((await load(undefined)).handler, null);
});

test('init validation: non-array, bad match/float/apply, invalid regex', async () => {
  await assert.rejects(() => load('nope'), /must be an array/);
  await assert.rejects(() => load([{ float: true }]), /must have a 'match'/);
  await assert.rejects(() => load([{ match: 123 }]), /must be an object or a function/);
  await assert.rejects(() => load([{ match: {} }]), /at least one of appId/);
  await assert.rejects(() => load([{ match: { appId: 5 } }]), /appId must be a regex string/);
  await assert.rejects(() => load([{ match: { appId: '(' } }]), /not a valid regex/);
  await assert.rejects(() => load([{ match: { appId: 'x' }, float: 1 }]), /float must be a boolean/);
  await assert.rejects(() => load([{ match: { appId: 'x' }, apply: 'no' }]), /apply must be a function/);
});

// ---- placement targets (workspace / output / show) -------------------------

test('workspace target stamps a workspace.place hint; state untouched', async () => {
  const { handler, stamps } = await load([
    { match: { appId: '^Slack$' }, workspace: 'comms' },
  ]);
  const r = await handler('window.preconfigure', payload({ appId: 'Slack', surfaceId: 9 }));
  assert.equal(r, undefined, 'placement alone modifies no window state');
  assert.deepEqual(stamps, [
    { id: 9, key: 'workspace.place', value: { name: 'comms' } },
  ]);
});

test('output and show ride the hint; float composes', async () => {
  const { handler, stamps } = await load([
    { match: { appId: 'mpv' }, workspace: 'media', output: 'HDMI-A-1', show: true, float: true },
  ]);
  const r = await handler('window.preconfigure', payload({ appId: 'mpv', surfaceId: 4 }));
  assert.equal(r.initialState.tiling, 'floating');
  assert.deepEqual(stamps, [
    { id: 4, key: 'workspace.place',
      value: { name: 'media', output: 'HDMI-A-1', show: true } },
  ]);
});

test('later placement rules win whole; non-placement matches leave the hint', async () => {
  const { handler, stamps } = await load([
    { match: { appId: '.' }, workspace: 'first', show: true },
    { match: { appId: 'x' }, workspace: 'second' },
    { match: { appId: 'x' }, float: true },   // matches, no placement fields
  ]);
  await handler('window.preconfigure', payload({ appId: 'x', surfaceId: 2 }));
  assert.deepEqual(stamps, [
    { id: 2, key: 'workspace.place', value: { name: 'second' } },
  ]);
});

test('no placement match -> no stamp', async () => {
  const { handler, stamps } = await load([
    { match: { appId: 'nope' }, workspace: 'comms' },
  ]);
  await handler('window.preconfigure', payload({ appId: 'other' }));
  assert.deepEqual(stamps, []);
});

test('placement validation: empty strings, show without target', async () => {
  await assert.rejects(load([{ match: { appId: 'a' }, workspace: '' }]), /non-empty/);
  await assert.rejects(load([{ match: { appId: 'a' }, output: '' }]), /non-empty/);
  await assert.rejects(load([{ match: { appId: 'a' }, show: true }]), /requires a workspace or output/);
});
