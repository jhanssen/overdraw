// Unit tests for the wl_drm (Mesa wayland-drm) protocol handler:
//   - bind advertises the render node, the supported formats, and (at v2) the
//     PRIME capability; capabilities is gated on the bound version.
//   - authenticate confirms immediately (render nodes need no DRM magic).
//   - create_prime_buffer records a dmabuf BufferDesc (implicit modifier).
//   - create_buffer / create_planar_buffer post invalid_name (GEM-name buffers
//     are unsupported off a render node).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeWlDrm from '../packages/core/dist/protocols/wl_drm.js';
import { WlDrm_Error, WlDrm_Capability } from '../packages/core/dist/protocols-gen/wl_drm.js';
import { DRM_FORMAT_ARGB8888, DRM_FORMAT_XRGB8888 } from '../packages/core/dist/protocols/zwp_linux_dmabuf_v1.js';

const RENDER_NODE = '/dev/dri/renderD128';

function setup() {
  const sent = [];
  const postErrorCalls = [];
  const wl_drm = {
    send_device: (r, name) => sent.push({ ev: 'device', r, name }),
    send_format: (r, format) => sent.push({ ev: 'format', r, format }),
    send_authenticated: (r) => sent.push({ ev: 'authenticated', r }),
    send_capabilities: (r, value) => sent.push({ ev: 'capabilities', r, value }),
  };
  const state = {};
  const addon = {
    gpuRenderNode: () => RENDER_NODE,
    postError: (resource, code, message) => postErrorCalls.push({ resource, code, message }),
  };
  const ctx = { state, addon, events: { wl_drm } };
  return { handler: makeWlDrm(ctx), state, sent, postErrorCalls };
}

test('wl_drm: bind (v2) advertises device, formats, and PRIME capability', () => {
  const { handler, sent } = setup();
  handler.bind({ id: 'drm', version: 2, destroyed: false });

  const device = sent.find((e) => e.ev === 'device');
  assert.equal(device?.name, RENDER_NODE, 'device is the GPU render node');

  const formats = sent.filter((e) => e.ev === 'format').map((e) => e.format);
  assert.deepEqual(formats, [DRM_FORMAT_ARGB8888, DRM_FORMAT_XRGB8888]);

  const caps = sent.find((e) => e.ev === 'capabilities');
  assert.equal(caps?.value, WlDrm_Capability.prime, 'PRIME capability advertised');
});

test('wl_drm: bind (v1) omits capabilities (version-gated)', () => {
  const { handler, sent } = setup();
  handler.bind({ id: 'drm', version: 1, destroyed: false });

  assert.ok(sent.some((e) => e.ev === 'device'), 'device still sent at v1');
  assert.equal(sent.filter((e) => e.ev === 'format').length, 2, 'formats still sent at v1');
  assert.ok(!sent.some((e) => e.ev === 'capabilities'), 'no capabilities at v1');
});

test('wl_drm: authenticate confirms immediately', () => {
  const { handler, sent } = setup();
  const resource = { id: 'drm', version: 2, destroyed: false };
  handler.authenticate(resource, 42);
  assert.deepEqual(sent, [{ ev: 'authenticated', r: resource }]);
});

test('wl_drm: create_prime_buffer records a dmabuf descriptor', () => {
  const { handler, state } = setup();
  const buffer = { id: 'buf', version: 2, destroyed: false };
  const fd = { fd: 7 };  // stand-in WaylandFd
  handler.create_prime_buffer(
    { id: 'drm', version: 2, destroyed: false },
    buffer, fd, 640, 480, DRM_FORMAT_ARGB8888,
    /* offset0 */ 0, /* stride0 */ 2560,
    /* offset1 */ 0, /* stride1 */ 0, /* offset2 */ 0, /* stride2 */ 0);

  const desc = state.buffers.get(buffer);
  assert.ok(desc, 'buffer descriptor recorded');
  assert.equal(desc.dmabuf, true);
  assert.equal(desc.fd, fd);
  assert.equal(desc.width, 640);
  assert.equal(desc.height, 480);
  assert.equal(desc.format, DRM_FORMAT_ARGB8888);
  assert.equal(desc.stride, 2560);
  assert.equal(desc.offset, 0);
  // Implicit modifier (DRM_FORMAT_MOD_INVALID) split into 32-bit halves.
  assert.equal(desc.modifierHi >>> 0, 0xffffffff);
  assert.equal(desc.modifierLo >>> 0, 0xffffffff);
});

test('wl_drm: create_buffer rejects GEM-name buffers with invalid_name', () => {
  const { handler, postErrorCalls } = setup();
  const resource = { id: 'drm', version: 2, destroyed: false };
  handler.create_buffer(resource, { id: 'buf' }, /* name */ 1, 64, 64, 256, DRM_FORMAT_ARGB8888);
  assert.equal(postErrorCalls.length, 1);
  assert.equal(postErrorCalls[0].resource, resource);
  assert.equal(postErrorCalls[0].code, WlDrm_Error.invalid_name);
});

test('wl_drm: create_planar_buffer rejects GEM-name buffers with invalid_name', () => {
  const { handler, postErrorCalls } = setup();
  const resource = { id: 'drm', version: 2, destroyed: false };
  handler.create_planar_buffer(resource, { id: 'buf' }, 1, 64, 64,
    DRM_FORMAT_ARGB8888, 0, 256, 0, 0, 0, 0);
  assert.equal(postErrorCalls.length, 1);
  assert.equal(postErrorCalls[0].code, WlDrm_Error.invalid_name);
});
