// Emits the .d.ts for one interface: branded resource types, enums, the handler
// interface (requests the handler implements), and the event-sender type
// (events the handler may send). Lets protocol handlers be written in TS with
// precise typing against the generated surface.
//
// Type mapping (Wayland arg type -> TS):
//   int, uint   -> number
//   fixed       -> number          (trampoline does the 24.8 conversion)
//   string      -> string
//   array       -> Uint8Array
//   fd          -> WaylandFd        (live fd wrapper; see runtime/wayland-fd)
//   object      -> ResourceOf<'iface'>  (or Resource if no interface given)
//   new_id      -> request: the created object's id is implicit (the handler
//                  receives a fresh resource); without interface (bind) the
//                  interface name + version are passed explicitly.
//   enum=...    -> the generated enum type for that arg
//   allow-null  -> `| null`

const SHARED_IMPORT = `import type { Resource, ResourceOf, WaylandFd } from './wayland-types.js';`;

// Reserved words that appear as Wayland arg names; sanitize for TS params.
const RESERVED = new Set([
  'interface', 'default', 'class', 'enum', 'export', 'import', 'new', 'delete',
  'function', 'return', 'var', 'let', 'const', 'in', 'instanceof', 'typeof',
  'void', 'this', 'super', 'switch', 'case', 'break', 'continue', 'for', 'while',
  'do', 'if', 'else', 'try', 'catch', 'finally', 'throw', 'with', 'yield',
]);
function safeParam(name) {
  return RESERVED.has(name) ? `${name}_` : name;
}

// wl_surface -> WlSurface
function pascal(name) {
  return name.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

function resourceType(ifaceName) {
  return ifaceName ? `ResourceOf<'${ifaceName}'>` : 'Resource';
}

// Resolve an arg's enum reference: "format" (local) or "wl_shm.format" (remote).
// Returns { type, ownerIface } so callers can collect cross-interface imports.
function enumRef(arg, iface) {
  if (!arg.enum) return null;
  if (arg.enum.includes('.')) {
    const [ ifaceName, enumName ] = arg.enum.split('.');
    return { type: `${pascal(ifaceName)}_${pascal(enumName)}`, ownerIface: ifaceName };
  }
  return { type: `${pascal(iface.name)}_${pascal(arg.enum)}`, ownerIface: iface.name };
}

function enumTypeName(arg, iface) {
  const ref = enumRef(arg, iface);
  return ref ? ref.type : null;
}

function tsType(arg, iface) {
  let base;
  const enumName = enumTypeName(arg, iface);
  switch (arg.type) {
    case 'int':
    case 'uint':
      base = enumName ?? 'number';
      break;
    case 'fixed':
      base = 'number';
      break;
    case 'string':
      base = 'string';
      break;
    case 'array':
      base = 'Uint8Array';
      break;
    case 'fd':
      base = 'WaylandFd';
      break;
    case 'object':
      base = resourceType(arg.interface);
      break;
    case 'new_id':
      base = arg.interface ? resourceType(arg.interface) : 'Resource';
      break;
    default:
      base = 'unknown';
      break;
  }
  return arg.allowNull ? `${base} | null` : base;
}

// For requests with a new_id WITHOUT an interface (registry.bind), the client
// also specifies the interface name + version; surface them as params.
function requestParams(m, iface) {
  const params = [];
  for (const a of m.args) {
    const p = safeParam(a.name);
    if (a.type === 'new_id' && !a.interface) {
      params.push(`interfaceName: string`);
      params.push(`version: number`);
      params.push(`${p}: number`);  // the new object id
    } else if (a.type === 'new_id') {
      // The handler is asked to create/bind this object; pass its id.
      params.push(`${p}: ${resourceType(a.interface)}`);
    } else {
      params.push(`${p}: ${tsType(a, iface)}`);
    }
  }
  return params;
}

function eventParams(m, iface) {
  return m.args.map((a) => `${safeParam(a.name)}: ${tsType(a, iface)}`);
}

export function emitDts(iface) {
  const R = pascal(iface.name);

  // Collect cross-interface enum references so we can import their types.
  // { ownerIface -> Set<typeName> }, excluding this interface's own enums.
  const imports = new Map();
  for (const m of [...iface.requests, ...iface.events]) {
    for (const a of m.args) {
      const ref = enumRef(a, iface);
      if (ref && ref.ownerIface !== iface.name) {
        if (!imports.has(ref.ownerIface)) imports.set(ref.ownerIface, new Set());
        imports.get(ref.ownerIface).add(ref.type);
      }
    }
  }

  const lines = [];
  lines.push(`// Generated from Wayland XML. Do not edit.`);
  lines.push(`// Interface: ${iface.name} (version ${iface.version})`);
  lines.push(SHARED_IMPORT);
  for (const [ownerIface, types] of imports) {
    const list = [...types].join(', ');
    lines.push(`import { ${list} } from './${ownerIface}.js';`);
  }
  lines.push(``);
  lines.push(`export type ${R}Resource = ResourceOf<'${iface.name}'>;`);
  lines.push(``);

  // Enums.
  for (const e of iface.enums) {
    const typeName = `${R}_${pascal(e.name)}`;
    const members = e.entries.map((en) => `  ${tsEnumKey(en.name)}: ${en.value},`).join('\n');
    lines.push(`export const ${typeName} = {`);
    lines.push(members);
    lines.push(`} as const;`);
    lines.push(`export type ${typeName} = typeof ${typeName}[keyof typeof ${typeName}];`);
    lines.push(``);
  }

  // Handler interface: the requests this interface's handler implements. Each
  // request receives the bound resource first, then the typed args.
  lines.push(`export interface ${R}Handler {`);
  for (const m of iface.requests) {
    const params = [`resource: ${R}Resource`, ...requestParams(m, iface)];
    lines.push(`  ${m.name}(${params.join(', ')}): void;`);
  }
  lines.push(`}`);
  lines.push(``);

  // Event senders: what the handler may emit on a resource.
  lines.push(`export interface ${R}Events {`);
  for (const m of iface.events) {
    const params = [`resource: ${R}Resource`, ...eventParams(m, iface)];
    lines.push(`  send_${m.name}(${params.join(', ')}): void;`);
  }
  lines.push(`}`);
  lines.push(``);

  // Runtime exports the .js module actually provides (consumed by the
  // handwritten handler layer today). `signature` is the request/event/enum
  // table; `makeEvents` builds the event-sender object wired to postEvent. These
  // declarations keep the .d.ts truthful about the module's real exports until
  // the handler layer is migrated to consume the typed Handler/Events contracts
  // above directly.
  lines.push(`export declare const signature: {`);
  lines.push(`  name: string;`);
  lines.push(`  version: number;`);
  lines.push(`  enums: Record<string, { bitfield?: boolean; entries: Record<string, number> }>;`);
  lines.push(`  requests: ReadonlyArray<unknown>;`);
  lines.push(`  events: ReadonlyArray<unknown>;`);
  lines.push(`};`);
  lines.push(`export declare function makeEvents(`);
  lines.push(`  post: (resource: Resource, opcode: number, args: unknown[]) => unknown,`);
  lines.push(`): ${R}Events;`);
  lines.push(``);
  return lines.join('\n');
}

// Enum entry names may start with a digit (illegal as a bare key) -> quote.
function tsEnumKey(name) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`;
}
