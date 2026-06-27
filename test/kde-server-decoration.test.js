// org_kde_kwin_server_decoration: the compositor forces Server (SSD) mode and
// ignores the client's request_mode. A client that wants Client mode (Firefox)
// re-requests on every `mode` event it receives, so an unconditional reply
// ping-pongs request_mode<->mode forever and pins the CPU. The handler caps the
// replies per decoration to break that loop.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeKdeDecorationManager, { makeKdeDecoration }
  from '../packages/core/dist/protocols/org_kde_kwin_server_decoration_manager.js';
import { signature as decoSig }
  from '../packages/core/dist/protocols-gen/org_kde_kwin_server_decoration.js';

const MODE = decoSig.enums.mode.entries; // None=0, Client=1, Server=2

function makeCtx() {
  const modeCalls = [];
  const defaultModeCalls = [];
  const ctx = {
    state: {},
    events: {
      org_kde_kwin_server_decoration: {
        send_mode: (resource, mode) => modeCalls.push({ resource, mode }),
      },
      org_kde_kwin_server_decoration_manager: {
        send_default_mode: (resource, mode) => defaultModeCalls.push({ resource, mode }),
      },
    },
  };
  return { ctx, modeCalls, defaultModeCalls };
}

test('create announces Server mode once', () => {
  const { ctx, modeCalls } = makeCtx();
  const mgr = makeKdeDecorationManager(ctx);
  const mgrRes = { id: 1 }, decoRes = { id: 2 }, surf = { id: 3 };

  mgr.create(mgrRes, decoRes, surf);
  assert.equal(modeCalls.length, 1);
  assert.equal(modeCalls[0].mode, MODE.Server);
  assert.equal(modeCalls[0].resource, decoRes);
});

test('request_mode replies are capped to break the request<->mode loop', () => {
  const { ctx, modeCalls } = makeCtx();
  const deco = makeKdeDecoration(ctx);
  const decoRes = { id: 2 };

  // A stubborn client that re-requests Client mode many times.
  for (let i = 0; i < 1000; i++) deco.request_mode(decoRes, MODE.Client);

  // Bounded, not 1000: the loop is broken.
  assert.ok(modeCalls.length > 0, 'replies at least once');
  assert.ok(modeCalls.length <= 4,
    `replies must be capped (got ${modeCalls.length})`);
  // Every reply forces Server regardless of the requested Client mode.
  for (const c of modeCalls) assert.equal(c.mode, MODE.Server);
});

test('the cap is per-decoration, not global', () => {
  const { ctx, modeCalls } = makeCtx();
  const deco = makeKdeDecoration(ctx);
  const a = { id: 10 }, b = { id: 11 };

  for (let i = 0; i < 50; i++) { deco.request_mode(a, MODE.Client); deco.request_mode(b, MODE.Client); }

  const aReplies = modeCalls.filter((c) => c.resource === a).length;
  const bReplies = modeCalls.filter((c) => c.resource === b).length;
  assert.ok(aReplies > 0 && aReplies <= 4, `a capped (got ${aReplies})`);
  assert.ok(bReplies > 0 && bReplies <= 4, `b capped (got ${bReplies})`);
});
