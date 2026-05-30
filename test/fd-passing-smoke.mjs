// End-to-end fd-passing test: register wl_shm with a handler that receives the
// create_pool fd as an opaque handle, takes the raw fd, and reads it back to
// confirm the client's marker bytes are present. Proves request fd-arg decode,
// the dup-into-table, and fdTake ownership transfer.

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { readdirSync, readSync, closeSync } from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const genDir = join(repoRoot, 'dist', 'protocols-gen');
const addon = require(join(repoRoot, 'build', 'overdraw_native.node'));

const sock = addon.startServer();
console.log(`[test] server socket: ${sock}`);

// Register every signature so cross-references resolve.
const signatures = [];
for (const f of readdirSync(genDir)) {
  if (!f.endsWith('.js')) continue;
  const m = await import(pathToFileURL(join(genDir, f)).href);
  if (m.signature) signatures.push(m.signature);
}
addon.registerProtocols(signatures);

let gotFd = false;
let markerOk = false;

addon.createGlobal('wl_shm', {
  create_pool(_resource, _pool, fdHandle, size) {
    gotFd = typeof fdHandle === 'number' && fdHandle > 0;
    console.log(`[test] create_pool: fdHandle=${fdHandle} size=${size}`);
    // Take ownership of the raw fd and read the marker the client wrote.
    const raw = addon.fdTake(fdHandle);
    console.log(`[test] fdTake -> raw fd ${raw}`);
    if (raw >= 0) {
      try {
        const buf = Buffer.alloc(32);
        readSync(raw, buf, 0, buf.length, 0);
        const s = buf.toString('latin1');
        markerOk = s.startsWith('OVERDRAW_FD_OK');
        console.log(`[test] read marker: ${markerOk} (${JSON.stringify(s.slice(0, 14))})`);
      } finally {
        closeSync(raw); // we own it now
      }
    }
  },
});

execFile(join(repoRoot, 'build', 'fd-test-client'), [sock], (err, stdout, stderr) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (err) console.error('[test] client error:', err.message);

  setTimeout(() => {
    addon.stopServer();
    const pass = gotFd && markerOk;
    console.log(pass ? '[test] PASS: fd received + readable with correct marker' : '[test] FAIL');
    process.exit(pass ? 0 : 1);
  }, 150);
});
