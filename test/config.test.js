// Pure-unit tests for config loading. No GPU, no Wayland, no addon.
// Exercises arg parsing, --config/XDG resolution, default-export forms,
// validation, and defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfigArg, resolveConfigPath, loadConfig } from '../dist/config/load.js';

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
  assert.equal(typeof c.focus.policy, 'string');
  assert.equal(typeof c.focus.focusOnMap, 'boolean');
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
  assert.equal(c.focus.policy, 'click-to-focus');
  assert.equal(c.focus.focusOnMap, true); // default filled
  assert.equal(c.output, null);
  assert.deepEqual(c.plugins, [{ module: '/x.js' }]);
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

test('invalid focus.policy rejected with clear message', async () => {
  const dir = tmp();
  const p = join(dir, 'config.mjs');
  writeFileSync(p, 'export default { focus: { policy: "nope" } }');
  await assert.rejects(() => loadConfig(p), /focus\.policy/);
  rmSync(dir, { recursive: true, force: true });
});

test('plugin without module string rejected', async () => {
  const dir = tmp();
  const p = join(dir, 'config.mjs');
  writeFileSync(p, 'export default { plugins: [{ name: "x" }] }');
  await assert.rejects(() => loadConfig(p), /plugins\[0\]\.module/);
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
    assert.equal(c.focus.focusOnMap, false);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    rmSync(base, { recursive: true, force: true });
  }
});
