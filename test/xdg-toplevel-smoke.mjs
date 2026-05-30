// End-to-end first-light test: install the JS protocol layer (wl_compositor,
// wl_surface, xdg_wm_base, xdg_surface, xdg_toplevel) on a started server, then
// run the xdg test client. The client binds the globals, creates a surface, gets
// an xdg_toplevel, sets a title, and completes the configure handshake. Proves
// the handler modules drive real wire traffic and that xdg_toplevel.configure
// (a non-empty wl_array of states) encodes correctly over the wire — the client
// must receive 4 bytes decoding to the ACTIVATED state value. The client exits
// non-zero if the states array did not arrive intact, so a server-side encode
// bug fails the test.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

import { installProtocols } from '../dist/protocols/index.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const addon = require(join(repoRoot, 'build', 'overdraw_native.node'));

const sock = addon.startServer();
console.log(`[test] server socket: ${sock}`);

const state = await installProtocols(addon);

execFile(join(repoRoot, 'build', 'xdg-test-client'), [sock], (err, stdout, stderr) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (err) console.error('[test] client error:', err.message);
  // The client exits non-zero unless the configure handshake completed AND the
  // non-empty states wl_array arrived intact (4 bytes == ACTIVATED).
  const clientOk = !err;

  setTimeout(() => {
    // Verify server-side state: a toplevel was created, title recorded, and the
    // xdg_surface saw the ack (configured=true).
    const toplevels = state.toplevels ? [...state.toplevels.values()] : [];
    const tl = toplevels[0];
    const titleOk = tl && tl.title === 'overdraw-test';
    const appIdOk = tl && tl.appId === 'dev.overdraw.test';
    const acked = tl && tl.xdgSurface && tl.xdgSurface.configured === true;
    const roleOk = tl && tl.xdgSurface && tl.xdgSurface.role === 'toplevel';

    console.log(`[test] toplevel created: ${!!tl}`);
    console.log(`[test] title recorded: ${titleOk} (${tl ? tl.title : 'none'})`);
    console.log(`[test] app_id recorded: ${appIdOk} (${tl ? tl.appId : 'none'})`);
    console.log(`[test] role assigned: ${roleOk}`);
    console.log(`[test] ack_configure observed: ${acked}`);
    console.log(`[test] client states-array intact (exit 0): ${clientOk}`);

    addon.stopServer();
    const pass = !!tl && titleOk && appIdOk && acked && roleOk && clientOk;
    console.log(pass ? '[test] PASS: toplevel created + configured + acked + states encoded' : '[test] FAIL');
    process.exit(pass ? 0 : 1);
  }, 150);
});
