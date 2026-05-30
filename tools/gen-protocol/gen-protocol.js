// CLI: parse Wayland protocol XML and emit per-interface .js + .d.ts modules
// into the output dir (default src/protocols-gen/, gitignored).
//
//   node tools/gen-protocol/gen-protocol.js [--out DIR] FILE.xml [FILE.xml ...]
//
// Default inputs (if none given) are the system wayland-protocols files the
// server needs. Each interface foo_bar -> protocols-gen/foo_bar.{js,d.ts}.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProtocol } from './parse.js';
import { emitJs } from './emit-js.js';
import { emitDts } from './emit-dts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

const DEFAULT_INPUTS = [
  '/usr/share/wayland/wayland.xml',
  '/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml',
  '/usr/share/wayland-protocols/stable/linux-dmabuf/linux-dmabuf-v1.xml',
];

function main(argv) {
  let out = join(repoRoot, 'src', 'protocols-gen');
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { out = argv[++i]; }
    else inputs.push(argv[i]);
  }
  const files = inputs.length ? inputs : DEFAULT_INPUTS;

  mkdirSync(out, { recursive: true });

  let ifaceCount = 0;
  let protoCount = 0;
  for (const file of files) {
    const xml = readFileSync(file, 'utf8');
    const proto = parseProtocol(xml);
    protoCount++;
    for (const iface of proto.interfaces) {
      writeFileSync(join(out, `${iface.name}.js`), emitJs(iface));
      writeFileSync(join(out, `${iface.name}.d.ts`), emitDts(iface));
      ifaceCount++;
    }
    console.log(`  ${proto.name}: ${proto.interfaces.length} interfaces (${file})`);
  }
  console.log(`generated ${ifaceCount} interfaces from ${protoCount} protocols into ${out}`);
}

main(process.argv.slice(2));
