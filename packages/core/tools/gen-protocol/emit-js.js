// Emits the runtime .js module for one interface: the signature tables
// (requests/events with opcodes, arg metadata, since-versions; enums) and an
// event-sender factory. The signature is plain data the trampoline consumes to
// register the interface with libwayland and to decode/encode the typed tuple.
//
// Event senders are produced by makeEvents(post), where `post(resource, opcode,
// args)` is supplied by the trampoline at runtime (it converts args to a
// wl_argument array and calls wl_resource_post_event_array). Kept as a factory
// so the generated module has no native dependency and is inspectable in tests.

import { pascal, tsEnumKey } from './util.js';

function argData(a) {
  // Mirror the XML arg, normalized. The trampoline reads this to marshal.
  return {
    name: a.name,
    type: a.type,
    interface: a.interface,
    enum: a.enum,
    allowNull: a.allowNull,
  };
}

function messageData(m, opcode) {
  return {
    name: m.name,
    opcode,
    since: m.since,
    type: m.type,
    args: m.args.map(argData),
  };
}

// JS reserved words that appear as Wayland arg names (notably 'interface').
// Sanitize to a safe param identifier; the array passed to post() uses the same
// sanitized name so the binding stays consistent.
const JS_RESERVED = new Set([
  'interface', 'default', 'class', 'enum', 'export', 'import', 'new', 'delete',
  'function', 'return', 'var', 'let', 'const', 'in', 'instanceof', 'typeof',
  'void', 'this', 'super', 'switch', 'case', 'break', 'continue', 'for', 'while',
  'do', 'if', 'else', 'try', 'catch', 'finally', 'throw', 'with', 'yield',
]);
function safeParam(name) {
  return JS_RESERVED.has(name) ? `${name}_` : name;
}

export function emitJs(iface) {
  const requests = iface.requests.map((m, i) => messageData(m, i));
  const events = iface.events.map((m, i) => messageData(m, i));

  const enums = {};
  for (const e of iface.enums) {
    enums[e.name] = { bitfield: e.bitfield, entries: {} };
    for (const entry of e.entries) enums[e.name].entries[entry.name] = entry.value;
  }

  const signature = {
    name: iface.name,
    version: iface.version,
    requests,
    events,
    enums,
  };

  const lines = [];
  lines.push(`// Generated from Wayland XML. Do not edit.`);
  lines.push(`// Interface: ${iface.name} (version ${iface.version})`);
  lines.push(``);
  lines.push(`export const signature = ${JSON.stringify(signature, null, 2)};`);
  lines.push(``);
  // Enum value objects, names matching the .d.ts consts (e.g. WlSurface_Error).
  // The runtime backing for those declarations: handlers import these to pass
  // typed error codes to postError / to compare enum args.
  const R = pascal(iface.name);
  for (const e of iface.enums) {
    lines.push(`export const ${R}_${pascal(e.name)} = {`);
    for (const entry of e.entries) lines.push(`  ${tsEnumKey(entry.name)}: ${entry.value},`);
    lines.push(`};`);
    lines.push(``);
  }
  // Event-sender factory: one send_<event> per event, calling the injected post.
  lines.push(`// makeEvents(post) -> { send_<event>(resource, ...args) }`);
  lines.push(`// post(resource, opcode, args) is supplied by the trampoline.`);
  lines.push(`export function makeEvents(post) {`);
  lines.push(`  return {`);
  for (const ev of events) {
    const names = ev.args.map((a) => safeParam(a.name));
    const params = names.join(', ');
    const argList = names.length ? `[${names.join(', ')}]` : `[]`;
    const sep = params ? ', ' : '';
    lines.push(`    send_${ev.name}(resource${sep}${params}) {`);
    lines.push(`      return post(resource, ${ev.opcode}, ${argList});`);
    lines.push(`    },`);
  }
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  return lines.join('\n');
}
