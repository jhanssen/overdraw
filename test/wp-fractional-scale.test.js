// Pure-unit tests for wp_fractional_scale_manager_v1 / wp_fractional_scale_v1:
// preferred_scale = round(scale * 120) on creation, re-emit on output-scale
// change (with destroyed-resource pruning), and untrack on destroy.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeFractionalScaleManager, {
  makeFractionalScale, reemitFractionalScale,
} from '../packages/core/dist/protocols/wp_fractional_scale_manager_v1.js';

function makeCtx(scale) {
  const sent = [];
  const events = {
    wp_fractional_scale_v1: { send_preferred_scale: (r, v) => sent.push([r, v]) },
  };
  const state = {
    outputs: new Map([[0, {
      id: 0, scale,
      logicalSize: { width: 1, height: 1 },
      deviceSize: { width: 1, height: 1 },
    }]]),
    events,
  };
  return { ctx: { state, events }, state, sent };
}

test('get_fractional_scale sends preferred_scale = round(scale*120)', () => {
  const { ctx, sent } = makeCtx(1.5);
  const mgr = makeFractionalScaleManager(ctx);
  const id = { id: 9 };
  mgr.get_fractional_scale(null, id, { id: 1 });
  assert.deepEqual(sent, [[id, 180]]);
});

test('reemitFractionalScale resends current scale and prunes destroyed', () => {
  const { ctx, state, sent } = makeCtx(2);
  const mgr = makeFractionalScaleManager(ctx);
  const a = { id: 1 }, b = { id: 2 };
  mgr.get_fractional_scale(null, a, {});
  mgr.get_fractional_scale(null, b, {});
  sent.length = 0;

  state.outputs.get(0).scale = 1.25;       // 1.25 * 120 = 150
  reemitFractionalScale(state);
  assert.deepEqual(sent, [[a, 150], [b, 150]]);

  b.destroyed = true;                       // pruned on next re-emit
  sent.length = 0;
  reemitFractionalScale(state);
  assert.deepEqual(sent, [[a, 150]]);
});

test('destroy untracks the resource', () => {
  const { ctx, state, sent } = makeCtx(2);
  const mgr = makeFractionalScaleManager(ctx);
  const h = makeFractionalScale(ctx);
  const a = { id: 1 };
  mgr.get_fractional_scale(null, a, {});
  h.destroy(a);
  sent.length = 0;
  reemitFractionalScale(state);
  assert.deepEqual(sent, []);
});
