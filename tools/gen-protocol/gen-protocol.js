// CLI: parse Wayland protocol XML and emit per-interface .js + .d.ts modules
// into the output dir (default dist/protocols-gen/, gitignored under dist/).
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

// Shared, type-only module imported by every generated .d.ts. Emitted into the
// output dir so the generated protocol modules are self-contained.
const WAYLAND_TYPES_DTS = `// Generated. Shared types referenced by all generated protocol .d.ts files.
//
// A Resource is an opaque, C++-owned wl_resource; JS holds a weak handle. The
// brand is compile-time only and gives per-interface type safety.

declare const __iface: unique symbol;

export interface Resource {
  readonly interfaceName: string;
  readonly destroyed: boolean;
}

export type ResourceOf<Iface extends string> = Resource & {
  readonly [__iface]: Iface;
};

// A live file descriptor handed up from the trampoline (pipes, keymap fds).
export interface WaylandFd {
  readonly fd: number;
  readonly closed: boolean;
  readAll(): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<number>;
  takeRawFd(): number;
  close(): void;
}
`;

const DEFAULT_INPUTS = [
  '/usr/share/wayland/wayland.xml',
  '/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml',
  '/usr/share/wayland-protocols/stable/linux-dmabuf/linux-dmabuf-v1.xml',
];

function main(argv) {
  let out = join(repoRoot, 'dist', 'protocols-gen');
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { out = argv[++i]; }
    else inputs.push(argv[i]);
  }
  const files = inputs.length ? inputs : DEFAULT_INPUTS;

  mkdirSync(out, { recursive: true });

  // Shared type-only module the generated .d.ts files import. Emitted alongside
  // them so the generated dir is self-contained (no external runtime/ dep).
  writeFileSync(join(out, 'wayland-types.d.ts'), WAYLAND_TYPES_DTS);

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
