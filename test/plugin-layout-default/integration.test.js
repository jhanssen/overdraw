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
    const wm = createWm(mockCompositor(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
      configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
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

test('setParams: master-fraction delta widens the master on the next compute', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([bundledToResolved(layoutPluginSpec, layoutPluginSpec.module)]);
    await rt.waitForNamespace('layout');

    const inputs = {
      output: { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 },
      tileRegion: { x: 0, y: 0, width: 1000, height: 600 },
      windows: [
        { id: 1, role: 'toplevel' },
        { id: 2, role: 'toplevel' },
      ],
      reason: 'mapped',
    };

    // Default fraction 0.5: master is the left half.
    const before = await rt.invokeNamespace('layout', 'compute', [inputs]);
    assert.equal(before.rects.find((r) => r.id === 1).outer.width, 500);

    // Grow the master by 0.2 -> 0.7. setParams returns the resolved snapshot.
    const snap = await rt.invokeNamespace('layout', 'setParams', [{ masterFractionDelta: 0.2 }]);
    assert.equal(snap.masterFraction, 0.7);

    const after = await rt.invokeNamespace('layout', 'compute', [inputs]);
    assert.equal(after.rects.find((r) => r.id === 1).outer.width, 700);
    assert.equal(after.rects.find((r) => r.id === 2).outer.width, 300);
  });
});

test('setParams: master fraction clamps to [0.05, 0.95]', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([bundledToResolved(layoutPluginSpec, layoutPluginSpec.module)]);
    await rt.waitForNamespace('layout');

    const hi = await rt.invokeNamespace('layout', 'setParams', [{ masterFractionDelta: 10 }]);
    assert.equal(hi.masterFraction, 0.95);
    const lo = await rt.invokeNamespace('layout', 'setParams', [{ masterFractionDelta: -10 }]);
    assert.equal(lo.masterFraction, 0.05);
  });
});

// ---- config-driven gap + masterFraction ---------------------------------

test('init config: gap shrinks every tile by the gap amount + outer band', async () => {
  await withRuntime({}, async (rt) => {
    // Pass a non-default config: 8px gap + masterFraction 0.5.
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module, { layout: { gap: 8 } }),
    ]);
    await rt.waitForNamespace('layout');

    const inputs = {
      output: { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 },
      tileRegion: { x: 0, y: 0, width: 1000, height: 600 },
      windows: [
        { id: 1, role: 'toplevel' },
        { id: 2, role: 'toplevel' },
      ],
      reason: 'mapped',
    };
    const r = await rt.invokeNamespace('layout', 'compute', [inputs]);
    // Master starts at x=8 (left outer gap), width = (1000 - 16 - 8) / 2 = 488.
    // Stack starts at x = 8 + 488 + 8 = 504, width = 488 again.
    const m = r.rects.find((x) => x.id === 1).outer;
    const s = r.rects.find((x) => x.id === 2).outer;
    assert.deepEqual(m, { x: 8, y: 8, width: 488, height: 584 });
    assert.deepEqual(s, { x: 504, y: 8, width: 488, height: 584 });
  });
});

test('init config: masterFraction is honored', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module,
        { layout: { masterFraction: 0.7 } }),
    ]);
    await rt.waitForNamespace('layout');
    const inputs = {
      output: { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 },
      tileRegion: { x: 0, y: 0, width: 1000, height: 600 },
      windows: [{ id: 1, role: 'toplevel' }, { id: 2, role: 'toplevel' }],
      reason: 'mapped',
    };
    const r = await rt.invokeNamespace('layout', 'compute', [inputs]);
    assert.equal(r.rects.find((x) => x.id === 1).outer.width, 700);
    assert.equal(r.rects.find((x) => x.id === 2).outer.width, 300);
  });
});

test('init config: invalid gap puts the plugin in failed state', async () => {
  const logs = [];
  await withRuntime({ log: (m) => logs.push(m) }, async (rt) => {
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module,
        { layout: { gap: -1 } }),
    ]);
    const states = rt.states();
    assert.equal(states[0].state, 'failed');
    assert.ok(logs.some((l) => l.includes('init failed') && l.includes('non-negative')),
      `expected layout.gap error in logs; got: ${logs.join('\n')}`);
  });
});

test('init config: invalid masterFraction puts the plugin in failed state', async () => {
  const logs = [];
  await withRuntime({ log: (m) => logs.push(m) }, async (rt) => {
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module,
        { layout: { masterFraction: 1.5 } }),
    ]);
    const states = rt.states();
    assert.equal(states[0].state, 'failed');
    assert.ok(logs.some((l) => l.includes('init failed') && l.includes('masterFraction')),
      `expected masterFraction error in logs; got: ${logs.join('\n')}`);
  });
});

// ---- setParams: gap delta -----------------------------------------------

test('setParams: gapDelta grows the gap', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([bundledToResolved(layoutPluginSpec, layoutPluginSpec.module)]);
    await rt.waitForNamespace('layout');
    const snap = await rt.invokeNamespace('layout', 'setParams', [{ gapDelta: 8 }]);
    assert.equal(snap.gap, 8);
  });
});

test('setParams: gapDelta clamps to >= 0', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module,
        { layout: { gap: 4 } }),
    ]);
    await rt.waitForNamespace('layout');
    // From gap=4, request -100; the result clamps to 0, not negative.
    const snap = await rt.invokeNamespace('layout', 'setParams', [{ gapDelta: -100 }]);
    assert.equal(snap.gap, 0);
  });
});

test('setParams: combined gap + master deltas in a single call', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([bundledToResolved(layoutPluginSpec, layoutPluginSpec.module)]);
    await rt.waitForNamespace('layout');
    const snap = await rt.invokeNamespace('layout', 'setParams',
      [{ masterFractionDelta: 0.1, gapDelta: 12 }]);
    assert.equal(snap.masterFraction, 0.6);
    assert.equal(snap.gap, 12);
  });
});
