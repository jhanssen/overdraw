// Structural well-formedness check across ALL generated interfaces (not just the
// spot-checked ones in gen-protocol.test.js). Regenerates the full default set
// from the system XML, then asserts invariants every signature must satisfy:
// sequential unique opcodes, known arg types, interface references that resolve,
// and a makeEvents sender per event wired to the right opcode. Catches broad
// generator regressions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const coreRoot = join(repoRoot, "packages", "core");
const INPUTS = [
  "/usr/share/wayland/wayland.xml",
  "/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml",
  "/usr/share/wayland-protocols/stable/linux-dmabuf/linux-dmabuf-v1.xml",
  "/usr/share/wayland-protocols/unstable/primary-selection/primary-selection-unstable-v1.xml",
];
const haveInputs = INPUTS.every((p) => existsSync(p));

const ARG_TYPES = new Set(["int", "uint", "fixed", "string", "object", "new_id", "array", "fd"]);

let outDir;
function ensureGenerated() {
  if (outDir) return outDir;
  outDir = mkdtempSync(join(tmpdir(), "overdraw-genall-"));
  execFileSync("node", [
    join(coreRoot, "tools", "gen-protocol", "gen-protocol.js"),
    "--out", outDir, ...INPUTS,
  ]);
  return outDir;
}

async function loadAll() {
  const dir = ensureGenerated();
  const mods = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const m = await import(pathToFileURL(join(dir, f)).href);
    if (m.signature) mods.set(m.signature.name, m);
  }
  return mods;
}

test("generator: a non-trivial set of interfaces is produced", { skip: !haveInputs }, async () => {
  const mods = await loadAll();
  assert.ok(mods.size >= 25, `expected >=25 interfaces, got ${mods.size}`);
  // The interfaces the compositor actually uses must all be present.
  for (const name of [
    "wl_compositor", "wl_surface", "wl_shm", "wl_shm_pool", "wl_buffer",
    "wl_seat", "wl_pointer", "wl_keyboard", "wl_output", "wl_region",
    "xdg_wm_base", "xdg_surface", "xdg_toplevel",
    "zwp_linux_dmabuf_v1", "zwp_linux_buffer_params_v1",
  ]) {
    assert.ok(mods.has(name), `missing generated interface ${name}`);
  }
});

test("generator: every signature is structurally well-formed", { skip: !haveInputs }, async () => {
  const mods = await loadAll();
  const known = new Set(mods.keys());

  for (const [name, m] of mods) {
    const s = m.signature;
    assert.equal(s.name, name, "signature.name matches module");
    assert.ok(Number.isInteger(s.version) && s.version >= 1, `${name}: valid version`);
    assert.ok(Array.isArray(s.requests) && Array.isArray(s.events), `${name}: req/event arrays`);

    for (const kind of ["requests", "events"]) {
      s[kind].forEach((msg, i) => {
        const where = `${name}.${kind}[${i}] (${msg.name})`;
        assert.equal(msg.opcode, i, `${where}: opcode is its index (sequential, unique)`);
        assert.ok(typeof msg.name === "string" && msg.name.length, `${where}: has a name`);
        assert.ok(Number.isInteger(msg.since) && msg.since >= 1, `${where}: valid since`);
        for (const a of msg.args) {
          assert.ok(ARG_TYPES.has(a.type), `${where}: arg ${a.name} unknown type ${a.type}`);
          // new_id/object args either name a known interface or are open (null).
          if (a.type === "object" || a.type === "new_id") {
            assert.ok(a.interface === "" || a.interface == null || known.has(a.interface),
              `${where}: arg ${a.name} references unknown interface ${a.interface}`);
          }
        }
      });
    }
  }
});

test("generator: makeEvents wires one sender per event at the right opcode", { skip: !haveInputs }, async () => {
  const mods = await loadAll();
  for (const [name, m] of mods) {
    const s = m.signature;
    if (typeof m.makeEvents !== "function" || s.events.length === 0) continue;
    const calls = [];
    const events = m.makeEvents((resource, opcode, args) => calls.push({ opcode, args }));
    for (const ev of s.events) {
      const sender = events[`send_${ev.name}`];
      assert.equal(typeof sender, "function", `${name}: send_${ev.name} exists`);
      calls.length = 0;
      // Call with dummy args (count = arg count); we only check opcode routing.
      sender("RES", ...ev.args.map(() => 0));
      assert.equal(calls.length, 1, `${name}.send_${ev.name}: posted once`);
      assert.equal(calls[0].opcode, ev.opcode, `${name}.send_${ev.name}: correct opcode`);
    }
  }
});
