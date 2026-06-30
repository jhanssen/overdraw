// The @overdraw/* fallback resolve hook (packages/core/src/plugins/
// plugin-resolve-hooks.ts) lets a plugin loaded from OUTSIDE the install --
// a user's ~/.config/overdraw dir, which has no node_modules with the SDK
// packages -- import the bundled SDKs by bare specifier. runLoader registers
// it before importing any plugin; here we register it directly and import a
// fixture plugin written to a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('out-of-install plugin imports @overdraw/sdk-anim via the resolve hook', async () => {
  // A temp dir with no node_modules on its resolution path -- /tmp has no
  // @overdraw packages above it, so a bare import here fails without the hook.
  const dir = await mkdtemp(join(tmpdir(), 'overdraw-plugin-'));
  const file = join(dir, 'anim-plugin.mjs');
  await writeFile(file,
    'import { tween, target } from "@overdraw/sdk-anim";\n'
    + 'export default () => tween(target.windowOpacity(1), { from: 0, to: 1, duration: 100 });\n');
  const url = pathToFileURL(file).href;

  register(new URL('../packages/core/dist/plugins/plugin-resolve-hooks.js', import.meta.url));

  const mod = await import(url);
  const spec = mod.default();
  assert.equal(spec.type, 'tween', 'the imported builder produced a tween spec');
  assert.equal(spec.duration, 100);
});

test('resolve hook does not rescue a genuinely missing package', async () => {
  // The hook is scoped to @overdraw/*; an unrelated missing package still
  // fails, so the fallback never masks real resolution errors.
  const dir = await mkdtemp(join(tmpdir(), 'overdraw-plugin-'));
  const file = join(dir, 'bad-plugin.mjs');
  await writeFile(file, 'import "totally-not-a-real-package-xyz";\nexport default () => {};\n');
  await assert.rejects(import(pathToFileURL(file).href),
    /Cannot find package|ERR_MODULE_NOT_FOUND/);
});
