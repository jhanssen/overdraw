// Version pinning in the generator: an interface listed in VERSION_PINS is
// emitted at the capped version with every later-'since' message dropped, so a
// client can neither bind nor reach a feature that has no implementation.
//
// The load-bearing invariant is opcode stability: opcodes are positional, so
// dropping messages must never renumber the ones that remain.
// Run: node --test test/gen-protocol-pin.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseProtocol } from '../packages/core/tools/gen-protocol/parse.js';
import { applyVersionPin, VERSION_PINS } from '../packages/core/tools/gen-protocol/pin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreRoot = join(__dirname, '..', 'packages', 'core');
const protoDir = join(coreRoot, 'protocols');
const INPUTS = ['wayland.xml', 'linux-dmabuf-v1.xml'].map((f) => join(protoDir, f));

let outDir;
function ensureGenerated() {
  if (outDir) return outDir;
  outDir = mkdtempSync(join(tmpdir(), 'overdraw-genpin-'));
  execFileSync('node', [
    join(coreRoot, 'tools', 'gen-protocol', 'gen-protocol.js'),
    '--out', outDir, ...INPUTS,
  ]);
  return outDir;
}

async function load(iface) {
  const mod = await import(pathToFileURL(join(ensureGenerated(), `${iface}.js`)).href);
  return mod.signature;
}

// The interfaces as the XML declares them, unpinned.
function parseUnpinned() {
  const byName = new Map();
  for (const file of INPUTS) {
    for (const iface of parseProtocol(readFileSync(file, 'utf8')).interfaces) {
      byName.set(iface.name, iface);
    }
  }
  return byName;
}

test('pinned interfaces are emitted at the capped version', async () => {
  for (const [name, pin] of Object.entries(VERSION_PINS)) {
    const raw = parseUnpinned().get(name);
    if (!raw) continue; // interface lives in an XML this test does not generate
    const s = await load(name);
    assert.equal(s.version, pin, `${name} advertises v${s.version}, expected the v${pin} pin`);
  }
});

test('messages introduced above the pin are dropped', async () => {
  const unpinned = parseUnpinned();
  for (const [name, pin] of Object.entries(VERSION_PINS)) {
    const raw = unpinned.get(name);
    if (!raw) continue;
    const s = await load(name);
    for (const kind of ['requests', 'events']) {
      const dropped = raw[kind].filter((m) => m.since > pin).map((m) => m.name);
      const emitted = s[kind].map((m) => m.name);
      for (const d of dropped) {
        assert.ok(!emitted.includes(d), `${name}.${d} (since > v${pin}) must not be emitted`);
      }
      for (const m of s[kind]) {
        assert.ok(m.since <= pin, `${name}.${m.name} has since=${m.since} above the v${pin} pin`);
      }
    }
  }
});

test('pinning does not renumber the opcodes of the messages it keeps', async () => {
  const unpinned = parseUnpinned();
  for (const name of Object.keys(VERSION_PINS)) {
    const raw = unpinned.get(name);
    if (!raw) continue;
    const s = await load(name);
    for (const kind of ['requests', 'events']) {
      for (const m of s[kind]) {
        const idx = raw[kind].findIndex((r) => r.name === m.name);
        assert.equal(m.opcode, idx, `${name}.${m.name}: opcode ${m.opcode} != XML index ${idx}`);
      }
    }
  }
});

test('the pins in force: no get_release, no set_sampling_device', async () => {
  const surface = await load('wl_surface');
  assert.equal(surface.version, 6);
  assert.ok(!surface.requests.some((r) => r.name === 'get_release'));
  // The requests that predate the cap keep their opcodes.
  assert.equal(surface.requests.find((r) => r.name === 'destroy').opcode, 0);
  assert.equal(surface.requests.find((r) => r.name === 'attach').opcode, 1);
  assert.equal(surface.requests.find((r) => r.name === 'offset').opcode, 10);

  const compositor = await load('wl_compositor');
  assert.equal(compositor.version, 6);
  assert.ok(!compositor.requests.some((r) => r.name === 'release'));

  const ddm = await load('wl_data_device_manager');
  assert.equal(ddm.version, 3);
  assert.ok(!ddm.requests.some((r) => r.name === 'release'));

  const params = await load('zwp_linux_buffer_params_v1');
  assert.equal(params.version, 5);
  assert.ok(!params.requests.some((r) => r.name === 'set_sampling_device'));

  // The whole dmabuf object tree caps together: a v6 zwp_linux_dmabuf_v1 would
  // hand out v6 params objects, re-exposing the request dropped above.
  assert.equal((await load('zwp_linux_dmabuf_v1')).version, 5);
  assert.equal((await load('zwp_linux_dmabuf_feedback_v1')).version, 5);
});

test('applyVersionPin: leaves an unpinned interface alone', () => {
  const iface = { name: 'wl_foo', version: 3, requests: [{ name: 'a', since: 3 }], events: [] };
  applyVersionPin(iface, { wl_bar: 1 });
  assert.equal(iface.version, 3);
  assert.deepEqual(iface.requests.map((r) => r.name), ['a']);
});

test('applyVersionPin: rejects a pin above the version the XML declares', () => {
  const iface = { name: 'wl_foo', version: 2, requests: [], events: [] };
  assert.throws(() => applyVersionPin(iface, { wl_foo: 3 }), /only declares v2/);
});

test('applyVersionPin: rejects a pin that would renumber opcodes', () => {
  // A hypothetical XML where a newer message precedes an older one: dropping it
  // shifts every later opcode down by one, silently misrouting requests.
  const iface = {
    name: 'wl_foo',
    version: 2,
    requests: [{ name: 'new', since: 2 }, { name: 'old', since: 1 }],
    events: [],
  };
  assert.throws(() => applyVersionPin(iface, { wl_foo: 1 }), /would renumber requests opcodes/);
});
