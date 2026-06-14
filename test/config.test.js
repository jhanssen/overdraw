// Pure-unit tests for config loading. No GPU, no Wayland, no addon.
// Exercises arg parsing, --config/XDG resolution, default-export forms,
// validation, and defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfigArg, resolveConfigPath, loadConfig } from '../packages/core/dist/config/load.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'odcfg-')); }

test('parseConfigArg: space form, = form, absent', () => {
  assert.equal(parseConfigArg(['--config', '/a/b.ts', 'x']), '/a/b.ts');
  assert.equal(parseConfigArg(['--config=/c.js']), '/c.js');
  assert.equal(parseConfigArg(['x', 'y']), null);
  assert.throws(() => parseConfigArg(['--config', '--other']), /requires a path/);
  assert.throws(() => parseConfigArg(['--config']), /requires a path/);
});

test('loadConfig(null) returns a well-shaped resolved config', async () => {
  // XDG may or may not have a real file on the test host; assert only the shape.
  const c = await loadConfig(null);
  // focus is now unknown (verbatim pass-through to the focus plugin); the
  // bundled @overdraw/plugin-focus-default applies its own defaults when
  // this is undefined.
  assert.ok(Array.isArray(c.plugins));
});

test('explicit --config missing path is a hard error', () => {
  assert.throws(() => resolveConfigPath('/definitely/missing/config.ts'), /not found/);
});

test('object default export: validate + normalize + defaults applied', async () => {
  const dir = tmp();
  const p = join(dir, 'config.mjs');
  writeFileSync(p, 'export default { focus: { policy: "click-to-focus" }, plugins: [{ module: "/x.js" }] }');
  const c = await loadConfig(p);
  // focus is passed through verbatim; core does not validate or apply defaults.
  assert.deepEqual(c.focus, { policy: 'click-to-focus' });
  assert.equal(c.output, null);
  // plugins resolve to full entries with defaults + the original raw object.
  assert.deepEqual(c.plugins, [{
    module: '/x.js', name: '/x.js', restart: 'on-failure',
    maxRestarts: 3, windowSeconds: 60, bundled: false, raw: { module: '/x.js' },
  }]);
  assert.equal(c.sourcePath, p);
  rmSync(dir, { recursive: true, force: true });
});

test('function default export is invoked (async)', async () => {
  const dir = tmp();
  const p = join(dir, 'config.mjs');
  writeFileSync(p, 'export default async () => ({ output: { width: 800, height: 600 } })');
  const c = await loadConfig(p);
  assert.deepEqual(c.output, { width: 800, height: 600 });
  rmSync(dir, { recursive: true, force: true });
});

test('output.card: override, default, and validation', async () => {
  const dir = tmp();
  let n = 0;
  const write = (body) => {
    const p = join(dir, `card-${n++}.mjs`);
    writeFileSync(p, body);
    return p;
  };
  // override honored
  let c = await loadConfig(write('export default { output: { card: "/dev/dri/card1" } }'));
  assert.equal(c.card, '/dev/dri/card1');
  // absent -> null (auto-detect)
  c = await loadConfig(write('export default { output: { width: 800, height: 600 } }'));
  assert.equal(c.card, null);
  // no output block at all -> null
  c = await loadConfig(write('export default {}'));
  assert.equal(c.card, null);
  // invalid: empty string
  await assert.rejects(() => loadConfig(write('export default { output: { card: "" } }')),
    /output\.card/);
  // invalid: non-string
  await assert.rejects(() => loadConfig(write('export default { output: { card: 1 } }')),
    /output\.card/);
  rmSync(dir, { recursive: true, force: true });
});

test('output.scale: override, default, and validation', async () => {
  const dir = tmp();
  let n = 0;
  const write = (body) => {
    const p = join(dir, `scale-${n++}.mjs`);
    writeFileSync(p, body);
    return p;
  };
  // fractional override honored
  let c = await loadConfig(write('export default { output: { scale: 1.5 } }'));
  assert.equal(c.scale, 1.5);
  // absent -> null (auto-derive downstream)
  c = await loadConfig(write('export default { output: { width: 800, height: 600 } }'));
  assert.equal(c.scale, null);
  // no output block -> null
  c = await loadConfig(write('export default {}'));
  assert.equal(c.scale, null);
  // invalid: zero / negative / non-number
  await assert.rejects(() => loadConfig(write('export default { output: { scale: 0 } }')),
    /output\.scale/);
  await assert.rejects(() => loadConfig(write('export default { output: { scale: -1 } }')),
    /output\.scale/);
  await assert.rejects(() => loadConfig(write('export default { output: { scale: "2" } }')),
    /output\.scale/);
  rmSync(dir, { recursive: true, force: true });
});

test('focus is verbatim pass-through (core does NOT validate)', async () => {
  // Core accepts any value; the focus plugin owns the schema and throws
  // from init on bad config (surfacing as a fatal startup error).
  const dir = tmp();
  const p = join(dir, 'config.mjs');
  writeFileSync(p, 'export default { focus: { policy: "nope" } }');
  const c = await loadConfig(p);
  assert.deepEqual(c.focus, { policy: 'nope' });
  rmSync(dir, { recursive: true, force: true });
});

test('plugin without module string rejected', async () => {
  const dir = tmp();
  const p = join(dir, 'config.mjs');
  writeFileSync(p, 'export default { plugins: [{ name: "x" }] }');
  await assert.rejects(() => loadConfig(p), /plugins\[0\]\.module/);
  rmSync(dir, { recursive: true, force: true });
});

test('plugin restart-policy fields: defaults, overrides, and validation', async () => {
  const dir = tmp();
  let n = 0;
  const write = (body) => {
    // Unique filename per write: import() caches by URL, so reusing one path
    // would return the first (valid) module on later loads.
    const p = join(dir, `config-${n++}.mjs`);
    writeFileSync(p, body);
    return p;
  };
  // overrides honored
  let c = await loadConfig(write(
    'export default { plugins: [{ module: "/a.js", name: "a", restart: "never", maxRestarts: 5, windowSeconds: 30 }] }'));
  assert.deepEqual(c.plugins[0], {
    module: '/a.js', name: 'a', restart: 'never', maxRestarts: 5, windowSeconds: 30,
    bundled: false,
    raw: { module: '/a.js', name: 'a', restart: 'never', maxRestarts: 5, windowSeconds: 30 },
  });
  // invalid restart policy
  await assert.rejects(() => loadConfig(write(
    'export default { plugins: [{ module: "/a.js", restart: "sometimes" }] }')), /restart must be one of/);
  // invalid maxRestarts
  await assert.rejects(() => loadConfig(write(
    'export default { plugins: [{ module: "/a.js", maxRestarts: -1 }] }')), /maxRestarts/);
  // invalid windowSeconds
  await assert.rejects(() => loadConfig(write(
    'export default { plugins: [{ module: "/a.js", windowSeconds: 0 }] }')), /windowSeconds/);
  rmSync(dir, { recursive: true, force: true });
});

test('XDG resolution probes config.* and loads it', async () => {
  const base = tmp();
  mkdirSync(join(base, 'overdraw'), { recursive: true });
  const p = join(base, 'overdraw', 'config.mjs');
  writeFileSync(p, 'export default { focus: { focusOnMap: false } }');
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = base;
  try {
    assert.equal(resolveConfigPath(null), p);
    const c = await loadConfig(null);
    assert.deepEqual(c.focus, { focusOnMap: false });
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    rmSync(base, { recursive: true, force: true });
  }
});
