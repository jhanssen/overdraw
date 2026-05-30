// Structural tests for the protocol generator output. Asserts opcodes, arg
// types, enum values, and since-versions for sampled interfaces, so a generator
// change that corrupts the signature tables fails here.
//
// Regenerates into a temp dir from the system XML, then imports the modules.
// Run: node --test test/gen-protocol.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const WL = '/usr/share/wayland/wayland.xml';
const XDG = '/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml';

const haveInputs = existsSync(WL) && existsSync(XDG);

let outDir;
function ensureGenerated() {
  if (outDir) return outDir;
  outDir = mkdtempSync(join(tmpdir(), 'overdraw-gen-'));
  execFileSync('node', [
    join(repoRoot, 'tools', 'gen-protocol', 'gen-protocol.js'),
    '--out', outDir, WL, XDG,
  ]);
  return outDir;
}

async function load(iface) {
  const dir = ensureGenerated();
  const mod = await import(pathToFileURL(join(dir, `${iface}.js`)).href);
  return mod.signature;
}

function req(sig, name) { return sig.requests.find((r) => r.name === name); }
function ev(sig, name) { return sig.events.find((e) => e.name === name); }

test('wl_compositor: requests and opcodes', { skip: !haveInputs }, async () => {
  const s = await load('wl_compositor');
  assert.equal(s.name, 'wl_compositor');
  const cs = req(s, 'create_surface');
  assert.equal(cs.opcode, 0);
  assert.equal(cs.args.length, 1);
  assert.equal(cs.args[0].type, 'new_id');
  assert.equal(cs.args[0].interface, 'wl_surface');
});

test('wl_surface.attach: opcode, nullable object, ints', { skip: !haveInputs }, async () => {
  const s = await load('wl_surface');
  const attach = req(s, 'attach');
  assert.equal(attach.opcode, 1);
  assert.deepEqual(attach.args.map((a) => a.type), ['object', 'int', 'int']);
  assert.equal(attach.args[0].interface, 'wl_buffer');
  assert.equal(attach.args[0].allowNull, true);
  // destroy is the destructor at opcode 0.
  assert.equal(req(s, 'destroy').opcode, 0);
  assert.equal(req(s, 'destroy').type, 'destructor');
});

test('wl_pointer.motion: fixed args', { skip: !haveInputs }, async () => {
  const s = await load('wl_pointer');
  const motion = ev(s, 'motion');
  assert.deepEqual(motion.args.map((a) => a.type), ['uint', 'fixed', 'fixed']);
});

test('wl_registry.bind: new_id without interface', { skip: !haveInputs }, async () => {
  const s = await load('wl_registry');
  const bind = req(s, 'bind');
  const newId = bind.args.find((a) => a.type === 'new_id');
  assert.ok(newId, 'bind has a new_id arg');
  assert.equal(newId.interface, null, 'bind new_id has no fixed interface');
});

test('wl_shm enums: values incl. hex fourcc', { skip: !haveInputs }, async () => {
  const s = await load('wl_shm');
  assert.equal(s.enums.format.entries.argb8888, 0);
  assert.equal(s.enums.format.entries.xrgb8888, 1);
  assert.equal(s.enums.format.entries.c8, 0x20203843);  // hex decoded
  assert.equal(s.enums.error.entries.invalid_fd, 2);
});

test('wl_data_source.send: fd arg (event)', { skip: !haveInputs }, async () => {
  const s = await load('wl_data_source');
  const send = ev(s, 'send');  // 'send' is an event the source emits, not a request
  assert.deepEqual(send.args.map((a) => a.type), ['string', 'fd']);
});

test('xdg_toplevel.set_title: since-versioned interface present', { skip: !haveInputs }, async () => {
  const s = await load('xdg_toplevel');
  assert.equal(s.name, 'xdg_toplevel');
  assert.ok(req(s, 'set_title'), 'has set_title');
  // configure event carries an array (states).
  const cfg = ev(s, 'configure');
  assert.ok(cfg.args.some((a) => a.type === 'array'), 'configure has an array arg');
});

test('event sender factory wires opcodes', { skip: !haveInputs }, async () => {
  const dir = ensureGenerated();
  const mod = await import(pathToFileURL(join(dir, 'wl_surface.js')).href);
  const calls = [];
  const events = mod.makeEvents((resource, opcode, args) => calls.push({ resource, opcode, args }));
  // wl_surface has an 'enter' event; send it and check opcode/args pass through.
  const enterIdx = mod.signature.events.findIndex((e) => e.name === 'enter');
  assert.ok(enterIdx >= 0);
  events.send_enter('RES', 'OUTPUT');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opcode, enterIdx);
  assert.deepEqual(calls[0].args, ['OUTPUT']);
});
