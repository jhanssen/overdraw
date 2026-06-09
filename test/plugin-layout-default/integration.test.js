// End-to-end: WM + layout driver + real runtime + bundled master-stack
// plugin. Proves:
//   - The bundled plugin loads and registers in the 'layout' namespace.
//   - The layout driver calls runtime.invokeNamespace -> plugin.handle ->
//     plugin's compute() -> result back to core.
//   - The WM applies the result and the configure sink fires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { createWm } from '../../packages/core/dist/wm/index.js';
import { createLayoutDriver } from '../../packages/core/dist/wm/layout-driver.js';
import { bundledToResolved, BUNDLED_PLUGINS } from '../../packages/core/dist/plugins/bundled.js';
import { withRuntime } from '../plugin-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The bundled plugin's module specifier is a bare npm package name; resolve
// it via the workspace symlink in this repo's node_modules.
const layoutPluginSpec = BUNDLED_PLUGINS.find((p) => p.name === 'layout-default');
if (!layoutPluginSpec) throw new Error('test setup: layout-default not in BUNDLED_PLUGINS');
void __dirname;

function mockCompositor() {
  return {
    setSurfaceLayout() {}, setStack() {},
    _layouts: [], _stacks: [],
  };
}

const rec = (id) => ({ resource: { __id: id } });

test('end-to-end: bundled master-stack plugin assigns tiles via the runtime', async () => {
  const configures = [];
  await withRuntime({}, async (rt) => {
    // Load the bundled plugin -- the same path main.ts uses.
    await rt.load([bundledToResolved(layoutPluginSpec, layoutPluginSpec.module)]);
    // Wait for it to register the namespace.
    await rt.waitForNamespace('layout');

    // Build a WM backed by the real runtime-backed driver.
    const wm = createWm(mockCompositor(), { width: 1000, height: 600 }, {
      configure: (id, w, h) => configures.push({ id, w, h }),
      layoutDriverFactory: (target, snapshot) => createLayoutDriver({
        target, snapshot,
        compute: async (inputs) => {
          // Cast through the wire boundary.
          // eslint-disable-next-line no-restricted-syntax
          const args = [inputs];
          // eslint-disable-next-line no-restricted-syntax
          return await rt.invokeNamespace('layout', 'compute', args);
        },
      }),
    });

    // Add two windows; the master-stack plugin should assign them
    // master-front, half-each.
    wm.addWindow(1, rec(1));
    await wm.settled();
    wm.addWindow(2, rec(2));   // 2 becomes master (inserted at front)
    await wm.settled();

    // master-stack(2): 2 is master (left half), 1 is in the stack (right half).
    assert.deepEqual(wm.state.windows.map((w) => w.surfaceId), [2, 1]);
    const byId = (id) => wm.state.windows.find((w) => w.surfaceId === id);
    assert.deepEqual(byId(2).rect, { x: 0, y: 0, width: 500, height: 600 });
    assert.deepEqual(byId(1).rect, { x: 500, y: 0, width: 500, height: 600 });

    // Both configured: 1 was 1000x600, now 500x600; 2 was placeholder, now 500x600.
    const lastByConfId = Object.fromEntries(configures.map((c) => [c.id, c]));
    assert.deepEqual(lastByConfId[1], { id: 1, w: 500, h: 600 });
    assert.deepEqual(lastByConfId[2], { id: 2, w: 500, h: 600 });
  });
});
