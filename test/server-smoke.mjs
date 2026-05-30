// Manual smoke test for the Wayland server skeleton (T1). Starts the server,
// prints the socket name, holds the loop briefly, then stops. A real client
// test comes once interface registration + dispatch land.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const addon = require(join(__dirname, '..', 'build', 'overdraw_native.node'));

const sock = addon.startServer();
console.log(`[test] wayland server socket: ${sock}`);

// Hold the loop open briefly (the server's uv handles keep it alive anyway).
setTimeout(() => {
  addon.stopServer();
  console.log('[test] server stopped');
}, Number(process.env.RUN_MS ?? 1500));
