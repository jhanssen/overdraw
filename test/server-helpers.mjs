// Shared helpers for the server-only protocol tests (GPU-free). Each server
// test file uses ONE startServer/stopServer lifecycle (start/stop is not safely
// repeatable in one process today; node --test isolates files into separate
// processes).

import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
export const addonPath = join(repoRoot, "build", "overdraw_native.node");
export const genDir = join(repoRoot, "dist", "protocols-gen");

export const haveAddon = existsSync(addonPath);
export const bin = (name) => join(repoRoot, "build", name);
export const loadAddon = () => require(addonPath);

// Skip reason if the addon and the named client binary aren't both built.
export function skipUnless(...clientNames) {
  if (!haveAddon) return "addon not built";
  for (const n of clientNames) if (!existsSync(bin(n))) return `${n} not built`;
  return false;
}

// Run a client binary against `sock`; resolve { code, stdout, stderr }. Async so
// Node's loop keeps dispatching the server socket while the client roundtrips.
export function runClient(name, sock) {
  return new Promise((resolve) => {
    execFile(bin(name), [sock], { timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load + register every generated signature so cross-references resolve. Returns
// the signature modules keyed by interface name (for makeEvents).
export async function registerAllSignatures(addon) {
  const sigs = [];
  const mods = {};
  for (const f of readdirSync(genDir)) {
    if (!f.endsWith(".js")) continue;
    const m = await import(pathToFileURL(join(genDir, f)).href);
    if (m.signature) { sigs.push(m.signature); mods[m.signature.name] = m; }
  }
  addon.registerProtocols(sigs);
  return mods;
}
