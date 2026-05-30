// End-to-end trampoline test (T4): register wl_compositor + wl_surface from the
// generated signatures, create the wl_compositor global with a JS handler, then
// run the test client which binds wl_compositor and calls create_surface. The
// handler firing with a wl_surface resource proves the generator metadata drives
// real libwayland dispatch.

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const genDir = join(repoRoot, 'src', 'protocols-gen');
const addon = require(join(repoRoot, 'build', 'overdraw_native.node'));

const sock = addon.startServer();
console.log(`[test] server socket: ${sock}`);

// Register every generated core-wayland interface so cross-references (e.g.
// wl_surface.attach -> wl_buffer) resolve. The trampoline needs the full
// transitive closure of referenced interfaces.
const signatures = [];
let surfaceMod;
for (const f of readdirSync(genDir)) {
  if (!f.endsWith('.js')) continue;
  const m = await import(pathToFileURL(join(genDir, f)).href);
  if (m.signature) signatures.push(m.signature);
  if (f === 'wl_surface.js') surfaceMod = m;
}
addon.registerProtocols(signatures);

// Generated event senders for wl_surface, wired to the native post hook.
const surfaceEvents = surfaceMod.makeEvents(addon.postEvent);

let created = false;
let stashedSurface = null;
addon.createGlobal('wl_compositor', {
  create_surface(resource, surface) {
    created = true;
    stashedSurface = surface;  // keep to check destroy invalidation (T5c)
    console.log(`[test] HANDLER create_surface: resource=${resource.interfaceName} -> new ${surface.interfaceName}, destroyed=${surface.destroyed === true}`);
    surfaceEvents.send_preferred_buffer_scale(surface, 2);
    console.log('[test] sent wl_surface.preferred_buffer_scale(2)');
  },
});

// Run the client async so Node's loop keeps dispatching the Wayland socket
// while the client roundtrips (a sync child would deadlock: the server can't
// dispatch while Node is blocked).
execFile(join(repoRoot, 'build', 'wl-test-client'), [sock], (err, stdout, stderr) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (err) console.error('[test] client error:', err.message);
  setTimeout(() => {
    // T5c: the client destroyed its surface (wl_surface.destroy, then
    // disconnect), so the cached wrapper should be marked destroyed.
    const destroyedOk = stashedSurface && stashedSurface.destroyed === true;
    console.log(`[test] surface wrapper destroyed after client teardown: ${destroyedOk}`);
    addon.stopServer();
    const pass = created && destroyedOk;
    console.log(pass ? '[test] PASS: handler fired + resource invalidated' : '[test] FAIL');
    process.exit(pass ? 0 : 1);
  }, 100);
});
