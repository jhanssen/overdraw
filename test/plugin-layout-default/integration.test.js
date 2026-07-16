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

// ---- declared mode + columns (canvas-design.md §5) -----------------------

const COLS_INPUTS = {
  output: { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 },
  tileRegion: { x: 0, y: 0, width: 1000, height: 600 },
  island: { id: 7 },
  windows: [{ id: 1, role: 'toplevel' }, { id: 2, role: 'toplevel' }],
  reason: 'mapped',
};

test('init config: mode "columns" tiles equal full-height columns', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module,
        { layout: { mode: 'columns' } }),
    ]);
    await rt.waitForNamespace('layout');
    const r = await rt.invokeNamespace('layout', 'compute', [COLS_INPUTS]);
    // Two 0.5 columns proportionally fill the 1000px region: no master.
    assert.deepEqual(r.rects.find((x) => x.id === 1).outer,
      { x: 0, y: 0, width: 500, height: 600 });
    assert.deepEqual(r.rects.find((x) => x.id === 2).outer,
      { x: 500, y: 0, width: 500, height: 600 });
  });
});

test('init config: invalid mode puts the plugin in failed state', async () => {
  const logs = [];
  await withRuntime({ log: (m) => logs.push(m) }, async (rt) => {
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module,
        { layout: { mode: 'dwindle' } }),
    ]);
    assert.equal(rt.states()[0].state, 'failed');
    assert.ok(logs.some((l) => l.includes('init failed') && l.includes('layout.mode')),
      `expected layout.mode error in logs; got: ${logs.join('\n')}`);
  });
});

test('island hint overrides the configured default mode, per island', async () => {
  await withRuntime({}, async (rt) => {
    // Config default master-stack; the island declares columns.
    await rt.load([bundledToResolved(layoutPluginSpec, layoutPluginSpec.module)]);
    await rt.waitForNamespace('layout');

    const declared = { ...COLS_INPUTS, island: { id: 7, layout: { mode: 'columns' } } };
    const cols = await rt.invokeNamespace('layout', 'compute', [declared]);
    assert.deepEqual(cols.rects.find((x) => x.id === 1).outer,
      { x: 0, y: 0, width: 500, height: 600 });

    // A different island with no hint still gets the configured default.
    const ms = await rt.invokeNamespace('layout', 'compute',
      [{ ...COLS_INPUTS, island: { id: 8 } }]);
    // master-stack(2) at fraction 0.5 is also 500/500 -- distinguish by
    // growing the master, which columns mode ignores.
    await rt.invokeNamespace('layout', 'setParams', [{ masterFractionDelta: 0.2 }]);
    const ms2 = await rt.invokeNamespace('layout', 'compute',
      [{ ...COLS_INPUTS, island: { id: 8 } }]);
    assert.equal(ms.rects.find((x) => x.id === 1).outer.width, 500);
    assert.equal(ms2.rects.find((x) => x.id === 1).outer.width, 700,
      'master-stack island honors masterFraction');
    const cols2 = await rt.invokeNamespace('layout', 'compute', [declared]);
    assert.equal(cols2.rects.find((x) => x.id === 1).outer.width, 500,
      'columns island is unaffected by masterFraction');
  });
});

test('measure: columns natural size grows with members; master-stack is inert', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module,
        { layout: { mode: 'columns' } }),
    ]);
    await rt.waitForNamespace('layout');
    const wa = { width: 1000, height: 600 };
    const measure = (windows, layout) => rt.invokeNamespace('layout', 'measure',
      [{ windows, workarea: wa, island: { id: 7, ...(layout ? { layout } : {}) } }]);

    // 2 x 500 = 1000 -> exactly the workarea.
    assert.deepEqual(await measure([{ id: 1 }, { id: 2 }]), { width: 1000, height: 600 });
    // 3 x 500 = 1500 -> grown.
    assert.deepEqual(await measure([{ id: 1 }, { id: 2 }, { id: 3 }]),
      { width: 1500, height: 600 });
    // Empty measures to the workarea, never smaller.
    assert.deepEqual(await measure([]), { width: 1000, height: 600 });
    // A master-stack island always fits: growth is inert.
    assert.deepEqual(
      await measure([{ id: 1 }, { id: 2 }, { id: 3 }], { mode: 'master-stack' }),
      { width: 1000, height: 600 });
  });
});

test('setParams: widthDelta resizes ONE window\'s column; others keep the default', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module,
        { layout: { mode: 'columns' } }),
    ]);
    await rt.waitForNamespace('layout');

    const snap = await rt.invokeNamespace('layout', 'setParams',
      [{ surfaceId: 1, widthDelta: 0.25 }]);
    assert.equal(snap.column, 0.5, 'the default seed is untouched by a per-window resize');

    // Window 1 is now 0.75 wide, window 2 stays 0.5: the region splits 0.6/0.4.
    const r = await rt.invokeNamespace('layout', 'compute', [COLS_INPUTS]);
    assert.equal(r.rects.find((x) => x.id === 1).outer.width, 600);
    assert.equal(r.rects.find((x) => x.id === 2).outer.width, 400);

    // And the natural size reflects the wider column: 750 + 500 = 1250.
    const m = await rt.invokeNamespace('layout', 'measure',
      [{ windows: [{ id: 1 }, { id: 2 }], workarea: { width: 1000, height: 600 },
         island: { id: 7 } }]);
    assert.deepEqual(m, { width: 1250, height: 600 });
  });
});

test('setParams: column width clamps to [0.1, 1] and accumulates', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module,
        { layout: { mode: 'columns' } }),
    ]);
    await rt.waitForNamespace('layout');
    const measure1 = async () => (await rt.invokeNamespace('layout', 'measure',
      [{ windows: [{ id: 1 }], workarea: { width: 1000, height: 600 },
         island: { id: 7 } }])).width;

    await rt.invokeNamespace('layout', 'setParams', [{ surfaceId: 1, widthDelta: 10 }]);
    assert.equal(await measure1(), 1000, 'clamped to a full-workarea column');
    await rt.invokeNamespace('layout', 'setParams', [{ surfaceId: 1, widthDelta: -10 }]);
    // 0.1 x 1000 = 100 natural, floored at the workarea by measure.
    assert.equal(await measure1(), 1000);
    // Two accumulating steps from the 0.1 floor: 0.1 + 0.05 + 0.05 = 0.2.
    await rt.invokeNamespace('layout', 'setParams', [{ surfaceId: 1, widthDelta: 0.05 }]);
    await rt.invokeNamespace('layout', 'setParams', [{ surfaceId: 1, widthDelta: 0.05 }]);
    const r = await rt.invokeNamespace('layout', 'compute',
      [{ ...COLS_INPUTS, windows: [{ id: 1, role: 'toplevel' }, { id: 2, role: 'toplevel' }] }]);
    // Weights 0.2 / 0.5 -> 2/7 and 5/7 of 1000.
    assert.equal(r.rects.find((x) => x.id === 1).outer.width, 285);
  });
});

test('an unresized window follows its island declaration; a resized one pins', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([
      bundledToResolved(layoutPluginSpec, layoutPluginSpec.module,
        { layout: { mode: 'columns' } }),
    ]);
    await rt.waitForNamespace('layout');
    const wa = { width: 1000, height: 600 };
    const measure = (layout) => rt.invokeNamespace('layout', 'measure',
      [{ windows: [{ id: 1 }, { id: 2 }], workarea: wa,
         island: { id: 7, ...(layout ? { layout } : {}) } }]);

    // Both windows follow the island's declared column fraction: a
    // re-declaration re-sizes them (0.75 each -> 1500 natural).
    assert.deepEqual(await measure({ mode: 'columns', column: 0.75 }),
      { width: 1500, height: 600 });

    // Pin window 1 by hand: the resize starts from what it last showed
    // (0.75), not the provider default -- 0.75 + 0.25 = 1.0.
    await rt.invokeNamespace('layout', 'setParams', [{ surfaceId: 1, widthDelta: 0.25 }]);
    // Re-declaring the island to 0.5 moves window 2 only; window 1 holds
    // its pinned full-width column: 1000 + 500 = 1500.
    assert.deepEqual(await measure({ mode: 'columns', column: 0.5 }),
      { width: 1500, height: 600 });
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

test('island layout hint { mode: "columns" } selects equal columns', async () => {
  await withRuntime({}, async (rt) => {
    await rt.load([bundledToResolved(layoutPluginSpec, layoutPluginSpec.module)]);
    await rt.waitForNamespace('layout');

    const inputs = {
      output: { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 },
      tileRegion: { x: 100, y: 0, width: 1200, height: 600 },
      island: { id: 7, layout: { mode: 'columns' } },
      windows: [
        { id: 1, role: 'toplevel' },
        { id: 2, role: 'toplevel' },
        { id: 3, role: 'toplevel' },
      ],
      reason: 'mapped',
    };
    const r = await rt.invokeNamespace('layout', 'compute', [inputs]);
    // Three equal full-height columns across the region, region-translated.
    assert.deepEqual(r.rects.map((x) => x.outer), [
      { x: 100, y: 0, width: 400, height: 600 },
      { x: 500, y: 0, width: 400, height: 600 },
      { x: 900, y: 0, width: 400, height: 600 },
    ]);

    // An unknown hint falls back to master-stack.
    const fallback = await rt.invokeNamespace('layout', 'compute',
      [{ ...inputs, island: { id: 7, layout: { mode: 'mystery' } } }]);
    assert.equal(fallback.rects[0].outer.width, Math.round((1200) * 0.5));
  });
});
