// CLI: parse Wayland protocol XML and emit per-interface .js + .d.ts modules
// into the output dir (default dist/protocols-gen/, gitignored under dist/).
//
//   node tools/gen-protocol/gen-protocol.js [--out DIR] FILE.xml [FILE.xml ...]
//
// Default inputs (if none given) are the vendored protocol XMLs under
// protocols/. Each interface foo_bar -> protocols-gen/foo_bar.{js,d.ts}.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProtocol } from './parse.js';
import { emitJs } from './emit-js.js';
import { emitDts } from './emit-dts.js';
import { applyVersionPin } from './pin.js';

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
  // intact. For forwarding a request fd onto an async wire event while the
  // handler keeps (and eventually close()s) the original. The dispatcher owns
  // request fds: libwayland does NOT close them after dispatch, so a handler
  // must close() or transfer every fd it receives -- a merely-taken fd stays
  // open in the compositor forever (e.g. a pipe write-end whose reader then
  // never sees EOF).
  dup(): WaylandFd;
}
`;

// Every XML is vendored under protocols/ rather than read from
// /usr/share: generation must not depend on the host's wayland /
// wayland-protocols package. A distro bump that appends a request to an
// interface would otherwise add a member to the generated handler type and
// break the build on that machine only; an older package would drop one and
// break it the other way. See protocols/README.md for provenance and how to
// refresh.
const vendored = (f) => join(repoRoot, 'protocols', f);

const DEFAULT_INPUTS = [
  vendored('wayland.xml'),
  vendored('xdg-shell.xml'),
  vendored('linux-dmabuf-v1.xml'),
  vendored('primary-selection-unstable-v1.xml'),
  vendored('xdg-decoration-unstable-v1.xml'),
  vendored('xdg-output-unstable-v1.xml'),
  vendored('cursor-shape-v1.xml'),
  vendored('viewporter.xml'),
  vendored('fractional-scale-v1.xml'),
  vendored('linux-drm-syncobj-v1.xml'),
  vendored('ext-workspace-v1.xml'),
  vendored('xwayland-shell-v1.xml'),
  vendored('ext-data-control-v1.xml'),
  vendored('presentation-time.xml'),
  vendored('commit-timing-v1.xml'),
  vendored('tearing-control-v1.xml'),
  vendored('ext-foreign-toplevel-list-v1.xml'),
  vendored('ext-image-capture-source-v1.xml'),
  vendored('ext-image-copy-capture-v1.xml'),
  vendored('xdg-dialog-v1.xml'),
  vendored('xdg-foreign-unstable-v2.xml'),
  vendored('relative-pointer-unstable-v1.xml'),
  vendored('pointer-constraints-unstable-v1.xml'),
  vendored('keyboard-shortcuts-inhibit-unstable-v1.xml'),
  vendored('wlr-layer-shell-unstable-v1.xml'),
  // Legacy data-control: wl-clipboard <= 2.2.1 and older clipboard
  // managers bind only this variant, not ext-data-control. Without it
  // wl-copy falls back to mapping an invisible toplevel to grab focus,
  // which a tiler reflows around. Served by the shared data-control
  // handler alongside the ext family.
  vendored('wlr-data-control-unstable-v1.xml'),
  vendored('wlr-foreign-toplevel-management-unstable-v1.xml'),
  vendored('wlr-output-management-unstable-v1.xml'),
  vendored('wlr-virtual-pointer-unstable-v1.xml'),
  vendored('virtual-keyboard-unstable-v1.xml'),
  // KDE server-decoration (the older SSD-negotiation protocol that
  // pre-dates zxdg_decoration_manager_v1). GTK4 binds this one in
  // preference to the xdg variant, so a compositor that only
  // advertises zxdg gets ignored by GTK and the client keeps drawing
  // CSD (visible as a 28x29 GTK shadow band around every window).
  vendored('kde-server-decoration.xml'),
  // Mesa's legacy wl_drm. NVIDIA's libnvidia-egl-wayland binds it to
  // discover the DRM device during EGL init and null-derefs without it.
  vendored('wayland-drm.xml'),
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
      applyVersionPin(iface);
      writeFileSync(join(out, `${iface.name}.js`), emitJs(iface));
      writeFileSync(join(out, `${iface.name}.d.ts`), emitDts(iface));
      ifaceCount++;
    }
    console.log(`  ${proto.name}: ${proto.interfaces.length} interfaces (${file})`);
  }
  console.log(`generated ${ifaceCount} interfaces from ${protoCount} protocols into ${out}`);
}

main(process.argv.slice(2));
