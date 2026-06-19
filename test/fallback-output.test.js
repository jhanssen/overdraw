// Sentinel constants for the virtual fallback output. The fallback itself is
// seeded inside installProtocols; full end-to-end coverage rides along with
// the broader protocol tests. Here we lock in the sentinel-id and name
// invariants -- the things downstream callers depend on for disambiguation
// against real dense ids.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTPUT_DEFAULT, OUTPUT_FALLBACK, FALLBACK_OUTPUT_NAME,
} from '../packages/core/dist/protocols/ctx.js';

test('OUTPUT_FALLBACK is negative -- never collides with a real dense id', () => {
  // Real connector ids are >= 0; the sentinel is negative so the workspace
  // plugin can stash it alongside live ids without aliasing.
  assert.ok(OUTPUT_FALLBACK < 0);
});

test('OUTPUT_FALLBACK differs from OUTPUT_DEFAULT', () => {
  assert.notEqual(OUTPUT_FALLBACK, OUTPUT_DEFAULT);
});

test('FALLBACK_OUTPUT_NAME uses a reserved sentinel pattern', () => {
  // The double-underscore prefix guarantees no collision with DRM connector
  // names ("DP-1", "HDMI-A-2", etc.).
  assert.match(FALLBACK_OUTPUT_NAME, /^__.*__$/);
});
