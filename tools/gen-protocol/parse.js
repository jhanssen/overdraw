// Minimal parser for the Wayland protocol XML schema (see wayland.dtd):
//   protocol(name) > interface(name,version) > (request|event|enum)
//   request/event(name,type?,since?) > arg*
//   arg(name,type,interface?,enum?,allow-null?)
//   enum(name,bitfield?) > entry(name,value,since?)
//
// We only need the structural subset; <description>/<copyright> are ignored.
// Dependency-free: a small tag tokenizer over the constrained schema rather
// than a general XML library.

// Tokenize into a flat list of { kind: 'open'|'close'|'selfclose', name, attrs }.
// Text content (descriptions, copyright) is dropped.
function tokenize(xml) {
  const tokens = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    i = lt + 1;
    // Skip XML decl, comments, doctype, CDATA.
    if (xml[i] === '?' || xml[i] === '!') {
      const gt = xml.indexOf('>', i);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    const close = xml[i] === '/';
    if (close) i++;
    // Read tag name.
    let j = i;
    while (j < n && /[^\s/>]/.test(xml[j])) j++;
    const name = xml.slice(i, j);
    // Read up to the matching '>', tracking quotes so '>' inside attrs is safe.
    let k = j;
    let inQuote = null;
    while (k < n) {
      const c = xml[k];
      if (inQuote) {
        if (c === inQuote) inQuote = null;
      } else if (c === '"' || c === "'") {
        inQuote = c;
      } else if (c === '>') {
        break;
      }
      k++;
    }
    const inner = xml.slice(j, k);
    const selfclose = inner.trimEnd().endsWith('/');
    i = k + 1;
    if (close) {
      tokens.push({ kind: 'close', name });
    } else {
      tokens.push({
        kind: selfclose ? 'selfclose' : 'open',
        name,
        attrs: parseAttrs(inner),
      });
    }
  }
  return tokens;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const key = m[1] ?? m[3];
    const val = m[2] ?? m[4];
    attrs[key] = decodeEntities(val);
  }
  return attrs;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Parse the token stream into a protocol model:
//   { name, interfaces: [{ name, version, requests, events, enums }] }
// requests/events: [{ name, since, type, args: [{ name, type, interface, enum, allowNull }] }]
// enums: [{ name, bitfield, entries: [{ name, value, since }] }]
export function parseProtocol(xml) {
  const tokens = tokenize(xml);
  const protocol = { name: null, interfaces: [] };

  let iface = null;     // current interface
  let msg = null;       // current request/event
  let msgKind = null;   // 'request' | 'event'
  let en = null;        // current enum

  for (const t of tokens) {
    if (t.kind === 'open' || t.kind === 'selfclose') {
      switch (t.name) {
        case 'protocol':
          protocol.name = t.attrs.name ?? null;
          break;
        case 'interface':
          iface = {
            name: t.attrs.name,
            version: Number(t.attrs.version ?? 1),
            requests: [],
            events: [],
            enums: [],
          };
          protocol.interfaces.push(iface);
          break;
        case 'request':
        case 'event': {
          msgKind = t.name;
          msg = {
            name: t.attrs.name,
            since: t.attrs.since ? Number(t.attrs.since) : 1,
            type: t.attrs.type ?? null,
            args: [],
          };
          (msgKind === 'request' ? iface.requests : iface.events).push(msg);
          if (t.kind === 'selfclose') { msg = null; msgKind = null; }
          break;
        }
        case 'enum':
          en = {
            name: t.attrs.name,
            bitfield: t.attrs.bitfield === 'true',
            entries: [],
          };
          iface.enums.push(en);
          if (t.kind === 'selfclose') en = null;
          break;
        case 'entry':
          if (en) {
            en.entries.push({
              name: t.attrs.name,
              value: parseValue(t.attrs.value),
              since: t.attrs.since ? Number(t.attrs.since) : 1,
            });
          }
          break;
        case 'arg':
          if (msg) {
            msg.args.push({
              name: t.attrs.name,
              type: t.attrs.type,
              interface: t.attrs.interface ?? null,
              enum: t.attrs.enum ?? null,
              allowNull: t.attrs['allow-null'] === 'true',
            });
          }
          break;
        default:
          break;  // description, copyright, etc.
      }
    } else if (t.kind === 'close') {
      switch (t.name) {
        case 'interface': iface = null; break;
        case 'request':
        case 'event': msg = null; msgKind = null; break;
        case 'enum': en = null; break;
        default: break;
      }
    }
  }
  return protocol;
}

// Enum values may be decimal or hex (0x...).
function parseValue(v) {
  if (typeof v !== 'string') return v;
  return v.startsWith('0x') || v.startsWith('0X') ? parseInt(v, 16) : parseInt(v, 10);
}
