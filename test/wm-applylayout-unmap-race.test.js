// applyLayout iterates the WM's `windows` array while awaiting per-window
// relayout interceptors. A synchronous unmapWindow during such an await
// splices `windows`. Two failure modes:
//
//   1. Stale-win post-await: the window being processed (the one whose
//      relayout the interceptor was awaiting) gets unmapped during the
//      await. Code post-await still has the captured `win` and calls
//      setSurfaceLayout / configure on it -- the compositor's
//      setSurfaceLayout auto-creates the surface entry (a blank Surface)
//      so an unmap + auto-create dance resurrects the deleted surface.
//
//   2. Iteration corruption: splicing a position <= the iterator's
//      current index shifts the rest left; the for-of iterator skips
//      whatever moved into the just-passed slot.
//
// A5 fix:
//   - Iterate a SNAPSHOT of `windows`, not the live array (closes #2).
//   - After each await, re-check `windows.includes(win)` before any
//     side-effect call (closes #1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

function mockCompositor() {
  const layouts = [];
  return {
    setSurfaceLayout(id, x, y, w, h) { layouts.push({ id, x, y, w, h }); },
    setStack() {},
    _layouts: layouts,
  };
}

const rec = (id) => ({ resource: { __id: id } });
const OUT = [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }];

test('applyLayout: window unmapped during interceptor await is NOT pushed to compositor',
  async () => {
  const comp = mockCompositor();
  const configures = [];
  const configure = { configure: (surfaceId, _x, _y, w, h) => { configures.push({ surfaceId, w, h }); return null; }, configureMove: () => {} };
  const pluginBus = new DynamicBus();
  const wm = createWm(comp, OUT, {
    layoutDriverFactory: inlineMasterStackDriverFactory,
    pluginBus, configure,
  });

  // Three pre-existing mapped windows.
  wm.addWindow(1, rec(1));
  wm.addWindow(2, rec(2));
  wm.addWindow(3, rec(3));
  await wm.settled();
  wm.windowHasContent(1);
  wm.windowHasContent(2);
  wm.windowHasContent(3);

  // Interceptor: window 4 (iterated FIRST -- it's the master after the
  // upcoming addWindow's unshift to index 0) awaits briefly, then unmaps
  // window 2. Window 2 has not been iterated yet at that point, so the
  // post-await membership check has to be what skips it.
  // Arm once to avoid recursion if the unmap reschedules another applyLayout.
  let armed = true;
  pluginBus.intercept(WINDOW_EVENT.relayout, async (_, p) => {
    if (armed && p.surfaceId === 4) {
      armed = false;
      await new Promise((r) => setTimeout(r, 5));
      wm.unmapWindow(2);
    }
    return p;
  });

  // Reset captures so we only see the addWindow(4) layout pass.
  comp._layouts.length = 0;
  configures.length = 0;

  // Trigger a layout pass. addWindow(4) calls driver.schedule which fires
  // applyLayout for all mapped windows.
  wm.addWindow(4, rec(4));
  wm.windowHasContent(4);
  await wm.settled();

  // Window 2 must be gone from the WM.
  assert.equal(wm.state.windows.some((w) => w.surfaceId === 2), false,
    'window 2 should be gone from wm.state.windows');
  // Window 2's layout was NOT pushed during the racing applyLayout (the
  // post-await membership check skipped it).
  assert.ok(!comp._layouts.some((l) => l.id === 2),
    `setSurfaceLayout fired for unmapped window 2: ${JSON.stringify(comp._layouts)}`);
  // Window 2's configure was NOT fired either.
  assert.ok(!configures.some((c) => c.surfaceId === 2),
    `configure fired for unmapped window 2: ${JSON.stringify(configures)}`);
  // Windows 1, 3, 4 ARE still mapped and got their layouts (one of the
  // unmap-triggered reflows ultimately pushes them).
  for (const id of [1, 3, 4]) {
    assert.ok(comp._layouts.some((l) => l.id === id),
      `expected setSurfaceLayout for window ${id}`);
  }
});

test('applyLayout: self-unmap during interceptor await -- stale-win post-await is skipped',
  async () => {
  // Tests the membership re-check after the await. Window 3's interceptor
  // unmaps window 3 itself during its own emit's await. Post-await code
  // would otherwise call setSurfaceLayout(3, ...) on a freshly-unmapped
  // window -- the compositor's setSurfaceLayout auto-creates the surface,
  // resurrecting the entry that removeSurface had just dropped.
  const comp = mockCompositor();
  const configures = [];
  const configure = { configure: (surfaceId, _x, _y, w, h) => { configures.push({ surfaceId, w, h }); return null; }, configureMove: () => {} };
  const pluginBus = new DynamicBus();
  const wm = createWm(comp, OUT, {
    layoutDriverFactory: inlineMasterStackDriverFactory,
    pluginBus, configure,
  });
  wm.addWindow(1, rec(1));
  wm.addWindow(2, rec(2));
  wm.addWindow(3, rec(3));
  await wm.settled();
  wm.windowHasContent(1);
  wm.windowHasContent(2);
  wm.windowHasContent(3);

  // Window 3 unmaps ITSELF mid-await on its own relayout.
  let armed = true;
  pluginBus.intercept(WINDOW_EVENT.relayout, async (_, p) => {
    if (armed && p.surfaceId === 3) {
      armed = false;
      await new Promise((r) => setTimeout(r, 5));
      wm.unmapWindow(3);
    }
    return p;
  });

  comp._layouts.length = 0;
  configures.length = 0;
  wm.addWindow(4, rec(4));
  wm.windowHasContent(4);
  await wm.settled();

  // Window 3 unmapped.
  assert.equal(wm.state.windows.some((w) => w.surfaceId === 3), false,
    'window 3 should be unmapped');
  // Window 3's setSurfaceLayout MUST NOT fire in this racing applyLayout
  // pass. Without the fix, the stale `win` post-await would call
  // setSurfaceLayout(3, ...) on a window the WM has already removed;
  // the compositor's setSurfaceLayout auto-creates the surface entry
  // (resurrecting it) since removeSurface had separately fired at the
  // protocol layer. comp._layouts was cleared right before the trigger,
  // so any window-3 push captured here came from the post-await path.
  assert.ok(!comp._layouts.some((l) => l.id === 3),
    `expected NO layout push for window 3 post-unmap; got ${JSON.stringify(comp._layouts.filter((l) => l.id === 3))}`);
  // configure must NOT have fired for the unmapped window.
  assert.ok(!configures.some((c) => c.surfaceId === 3),
    `configure fired for unmapped window 3: ${JSON.stringify(configures)}`);
});
