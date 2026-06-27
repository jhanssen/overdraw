// Unit tests for zwp_linux_dmabuf_v1 bind-time format/modifier advertisement.
// The format (v1) and modifier (v3) events are deprecated since v4 and must not
// be sent to a v4+ binding -- those clients read get_default_feedback. Sending a
// modifier event on a v4 binding crashes NVIDIA's libnvidia-egl-wayland.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeLinuxDmabuf from '../packages/core/dist/protocols/zwp_linux_dmabuf_v1.js';

function setup() {
  const sent = [];
  const ctx = {
    state: {},
    addon: {},
    events: {
      zwp_linux_dmabuf_v1: {
        send_format: (_r, format) => sent.push({ ev: 'format', format }),
        send_modifier: (_r, format, hi, lo) => sent.push({ ev: 'modifier', format, hi, lo }),
      },
    },
  };
  return { handler: makeLinuxDmabuf(ctx), sent };
}

function counts(sent) {
  return {
    formats: sent.filter((e) => e.ev === 'format').length,
    modifiers: sent.filter((e) => e.ev === 'modifier').length,
  };
}

test('dmabuf bind v4: sends nothing (uses feedback; format/modifier deprecated)', () => {
  const { handler, sent } = setup();
  handler.bind({ version: 4, destroyed: false });
  assert.deepEqual(counts(sent), { formats: 0, modifiers: 0 });
});

test('dmabuf bind v3: sends format + modifier events', () => {
  const { handler, sent } = setup();
  handler.bind({ version: 3, destroyed: false });
  const c = counts(sent);
  assert.equal(c.formats, 2, 'both advertised formats');
  assert.equal(c.modifiers, 4, 'two modifiers per format');
});

test('dmabuf bind v2: sends format only (modifier is a since-3 event)', () => {
  const { handler, sent } = setup();
  handler.bind({ version: 2, destroyed: false });
  assert.deepEqual(counts(sent), { formats: 2, modifiers: 0 });
});

test('dmabuf bind v1: sends format only', () => {
  const { handler, sent } = setup();
  handler.bind({ version: 1, destroyed: false });
  assert.deepEqual(counts(sent), { formats: 2, modifiers: 0 });
});
