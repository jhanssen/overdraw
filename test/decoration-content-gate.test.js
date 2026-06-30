// The decoration content-gate releases on the client's CONFIGURE ACK, not on
// an exact buffer-size match. A client that commits a buffer slightly larger
// (or smaller) than the size we configured -- xterm rounds to whole character
// cells plus a 2px internal border; CSD clients add a shadow margin; fixed-size
// dialogs ignore the configure entirely -- must still appear as soon as it has
// content and has acked, NOT hang on the gate's 10s backstop.
//
// contentGateReleased is the pure core of Compositor.surfaceContentReady.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contentGateReleased } from '../packages/core/dist/gpu/compositor.js';

// Models the xterm case: the WM configured the window (cfgSerial=5) at, say,
// 800x600; the client acked serial 5 and committed a 802x602 buffer (2px over).
// The buffer size is not even an input to the decision -- that's the point:
// the gate must not care.
test('gate releases on ack even when the committed buffer differs from the configure', () => {
  assert.equal(contentGateReleased({
    hasBuffer: true, layoutW: 800, layoutH: 600, cfgSerial: 5, ackSerial: 5,
  }), true, 'acked the latest configure -> released regardless of buffer size');
});

test('gate stays closed until the client acks the latest configure', () => {
  // Drawable buffer present, but the client has only acked an older serial than
  // the configure we just sent -> not ready yet (it has not responded to us).
  assert.equal(contentGateReleased({
    hasBuffer: true, layoutW: 800, layoutH: 600, cfgSerial: 7, ackSerial: 4,
  }), false, 'unacked latest configure -> not released');
  // Acking exactly the latest serial releases it.
  assert.equal(contentGateReleased({
    hasBuffer: true, layoutW: 800, layoutH: 600, cfgSerial: 7, ackSerial: 7,
  }), true, 'ack catches up -> released');
});

test('xwayland (no ack_configure) releases on first drawable buffer', () => {
  // cfgSerial undefined: X11 windows have no ack; a managed window with a
  // drawable buffer is ready.
  assert.equal(contentGateReleased({
    hasBuffer: true, layoutW: 1701, layoutH: 1416,
  }), true, 'no configure-ack expected -> released on buffer');
});

test('gate stays closed without a drawable buffer or a layout rect', () => {
  assert.equal(contentGateReleased({
    hasBuffer: false, layoutW: 800, layoutH: 600, cfgSerial: 5, ackSerial: 5,
  }), false, 'no buffer -> not released');
  assert.equal(contentGateReleased({
    hasBuffer: true, layoutW: 0, layoutH: 0, cfgSerial: 5, ackSerial: 5,
  }), false, 'no layout rect yet -> not released');
});
