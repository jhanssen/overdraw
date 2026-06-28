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
// A Resource is the trampoline's JS wrapper around a C++-owned wl_resource. The
// brand on ResourceOf is compile-time only and gives per-interface type safety
// (a wl_surface resource is not assignable to a wl_buffer parameter). The shape
// matches native/wayland/trampoline.cpp wrapResource: an opaque __resource
// external, the interface name, a destroyed flag, plus handler-attached fields.

declare const __iface: unique symbol;

export interface Resource {
  readonly __resource: unknown;
  readonly interfaceName: string;
  // Version the client bound this resource at. Gate version-'since' events on
  // this; sending an event newer than the bound version aborts the client.
  readonly version: number;
  destroyed: boolean;
  [key: string]: unknown;
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
  // An independent dup of this fd in a fresh WaylandFd; this wrapper is left
  // intact. For forwarding a request fd onto an async wire event (the original
  // is closed by libwayland when the dispatch returns).
  dup(): WaylandFd;
}
`;

const DEFAULT_INPUTS = [
  '/usr/share/wayland/wayland.xml',
  '/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml',
  '/usr/share/wayland-protocols/stable/linux-dmabuf/linux-dmabuf-v1.xml',
  '/usr/share/wayland-protocols/unstable/primary-selection/primary-selection-unstable-v1.xml',
  '/usr/share/wayland-protocols/unstable/xdg-decoration/xdg-decoration-unstable-v1.xml',
  '/usr/share/wayland-protocols/unstable/xdg-output/xdg-output-unstable-v1.xml',
  '/usr/share/wayland-protocols/staging/cursor-shape/cursor-shape-v1.xml',
  '/usr/share/wayland-protocols/stable/viewporter/viewporter.xml',
  '/usr/share/wayland-protocols/staging/fractional-scale/fractional-scale-v1.xml',
  '/usr/share/wayland-protocols/staging/linux-drm-syncobj/linux-drm-syncobj-v1.xml',
  '/usr/share/wayland-protocols/staging/ext-workspace/ext-workspace-v1.xml',
  '/usr/share/wayland-protocols/staging/xwayland-shell/xwayland-shell-v1.xml',
  '/usr/share/wayland-protocols/staging/ext-data-control/ext-data-control-v1.xml',
  '/usr/share/wayland-protocols/stable/presentation-time/presentation-time.xml',
  '/usr/share/wayland-protocols/staging/ext-foreign-toplevel-list/ext-foreign-toplevel-list-v1.xml',
  '/usr/share/wayland-protocols/staging/ext-image-capture-source/ext-image-capture-source-v1.xml',
  '/usr/share/wayland-protocols/staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml',
  '/usr/share/wayland-protocols/staging/xdg-dialog/xdg-dialog-v1.xml',
  '/usr/share/wayland-protocols/unstable/xdg-foreign/xdg-foreign-unstable-v2.xml',
  // wlr-* protocols are not in wayland-protocols upstream; vendor copies.
  join(repoRoot, 'protocols', 'wlr-layer-shell-unstable-v1.xml'),
  join(repoRoot, 'protocols', 'wlr-foreign-toplevel-management-unstable-v1.xml'),
  join(repoRoot, 'protocols', 'wlr-output-management-unstable-v1.xml'),
  join(repoRoot, 'protocols', 'wlr-virtual-pointer-unstable-v1.xml'),
  join(repoRoot, 'protocols', 'virtual-keyboard-unstable-v1.xml'),
  // KDE server-decoration (the older SSD-negotiation protocol that
  // pre-dates zxdg_decoration_manager_v1). GTK4 binds this one in
  // preference to the xdg variant, so a compositor that only
  // advertises zxdg gets ignored by GTK and the client keeps drawing
  // CSD (visible as a 28x29 GTK shadow band around every window).
  // Vendored copy lifted from wlroots' protocols/.
  join(repoRoot, 'protocols', 'kde-server-decoration.xml'),
  // Mesa's legacy wl_drm. Not in wayland-protocols upstream; NVIDIA's
  // libnvidia-egl-wayland binds it to discover the DRM device during EGL
  // init and null-derefs without it.
  join(repoRoot, 'protocols', 'wayland-drm.xml'),
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
