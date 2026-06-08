// IPC server: JSON-RPC 2.0 over a Unix stream socket
// (core-plugin-api.md §12). One server per overdraw instance; many
// concurrent clients (overdrawctl invocations, status bars, language
// bindings).
//
// Methods (request -> result):
//   invoke       params: { action: string, args?: unknown }   -> action result
//   list-actions params: none                                 -> ActionInfo[]
//   subscribe    params: { pattern: string }                  -> { subscription: string }
//   unsubscribe  params: { subscription: string }             -> null
//
// Server-pushed events (notifications, id-less, method "event"):
//   params: { subscription: string, name: string, payload: unknown }
//
// Wire format: newline-delimited JSON. Each message is a complete JSON object
// terminated by '\n'.
//
// Authentication: filesystem permissions on the socket (700). The socket
// lives in $XDG_RUNTIME_DIR which is already user-private on a standard
// systemd setup.

import { createServer, type Server, type Socket } from "node:net";
import { unlink, chmod } from "node:fs/promises";

import type { PluginRuntime } from "../plugins/runtime.js";
import type { Json as WireJson } from "../plugins/protocol.js";
import type { DynamicBus, Subscription } from "../events/dynamic-bus.js";
import {
  JSONRPC_ERRORS, encode, isRequest, ok, err, notify, parseMessage,
  type Json, type Request,
} from "./protocol.js";

export interface IpcServerOptions {
  // Absolute path of the Unix socket to listen on. Overdraw chooses
  // $XDG_RUNTIME_DIR/overdraw-<display>.sock; tests use a temp path.
  socketPath: string;
  // The plugin runtime: backs invoke / list-actions.
  runtime: PluginRuntime;
  // The dynamic event bus: backs subscribe / unsubscribe.
  bus: DynamicBus;
  // Diagnostics sink (default: console.warn for errors). Tests can capture.
  log?: (msg: string) => void;
}

export class IpcServer {
  private opts: IpcServerOptions;
  private server: Server | null = null;
  private connections = new Set<Connection>();
  private log: (msg: string) => void;

  constructor(opts: IpcServerOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((m) => console.warn(`[ipc] ${m}`));
  }

  // Start listening. Removes any stale socket file first (a previous overdraw
  // crash may have left one). chmods to 0o700 so only the user can connect.
  async start(): Promise<void> {
    // Remove a stale socket file from a prior run; ignore "not found".
    try { await unlink(this.opts.socketPath); }
    catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
    }

    const server = createServer((sock) => { this.onConnection(sock); });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // Restrict to the user only. EACCES on the socket file otherwise relies
    // on the directory's mode, which $XDG_RUNTIME_DIR provides but the
    // socket inheriting from umask is not guaranteed.
    await chmod(this.opts.socketPath, 0o700);
  }

  // Stop accepting new connections, disconnect all current clients (releasing
  // their subscriptions), and remove the socket file.
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    // Disconnect all live connections (their finalizers release subscriptions).
    for (const c of [...this.connections]) c.close("server stopping");
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    try { await unlink(this.opts.socketPath); }
    catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") this.log(`stop: unlink failed: ${err.message}`);
    }
  }

  private onConnection(sock: Socket): void {
    const c = new Connection(sock, this.opts, this.log, () => { this.connections.delete(c); });
    this.connections.add(c);
  }

  // Diagnostics: how many clients are connected.
  connectionCount(): number { return this.connections.size; }
}

// One client connection: line-buffered JSON, per-connection subscription
// table, request dispatch.
class Connection {
  private sock: Socket;
  private opts: IpcServerOptions;
  private log: (msg: string) => void;
  private onClose: () => void;
  private buf = "";
  // subscriptionId -> bus subscription handle (so we can release on disconnect
  // or explicit unsubscribe). Subscription IDs are server-minted strings.
  private subs = new Map<string, Subscription>();
  private nextSubId = 1;
  private closed = false;

  constructor(sock: Socket, opts: IpcServerOptions, log: (msg: string) => void,
              onClose: () => void) {
    this.sock = sock;
    this.opts = opts;
    this.log = log;
    this.onClose = onClose;

    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => { this.onData(chunk); });
    sock.on("close", () => { this.cleanup(); });
    sock.on("error", (e) => {
      this.log(`connection error: ${e.message}`);
      this.cleanup();
    });
  }

  // Disconnect this client (server-initiated; caller releases subscriptions
  // via cleanup() on close).
  close(reason: string): void {
    if (this.closed) return;
    this.sock.destroy(new Error(reason));
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subs.values()) sub.off();
    this.subs.clear();
    this.onClose();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    // Process every complete line. Anything after the last \n stays buffered.
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;   // tolerate empty lines (e.g. clients sending \r\n)
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try { msg = parseMessage(line); }
    catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.send(err(null, JSONRPC_ERRORS.PARSE_ERROR, `Parse error: ${errMsg}`));
      return;
    }

    if (!isRequest(msg)) {
      // Notification or malformed message. Per spec, notifications get no
      // reply. Malformed-but-shaped-as-notification: also no reply. Truly
      // malformed input that isn't a notification: send Invalid Request.
      // (We can't reply without an id; the spec says use id: null for
      // server-detected errors where the id can't be determined.)
      if (typeof msg === "object" && msg !== null && !Array.isArray(msg)
          && (msg as { method?: unknown }).method !== undefined) {
        return;   // notification: drop silently
      }
      this.send(err(null, JSONRPC_ERRORS.INVALID_REQUEST, "Invalid Request"));
      return;
    }

    // Dispatch by method. All requests get a reply (success or error).
    this.dispatch(msg).catch((e: unknown) => {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.send(err(msg.id, JSONRPC_ERRORS.INTERNAL_ERROR, errMsg));
    });
  }

  private async dispatch(req: Request): Promise<void> {
    switch (req.method) {
      case "invoke": {
        const p = parseInvokeParams(req.params);
        if (!p.ok) {
          this.send(err(req.id, JSONRPC_ERRORS.INVALID_PARAMS, p.message));
          return;
        }
        try {
          // invokeAction takes/returns plugins/protocol.ts Json (includes
          // bigint, valid over postMessage). The IPC wire is strict JSON
          // (no bigint). Cast at the boundary; JSON.stringify in encode()
          // would throw on a bigint result and the outer catch turns it
          // into an Internal Error -- the action author is responsible for
          // returning JSON-safe values when exposed over IPC.
          const args = (p.value.args ?? null) as WireJson;
          const result = await this.opts.runtime.invokeAction(p.value.action, args);
          this.send(ok(req.id, jsonOfWire(result)));
        } catch (e: unknown) {
          const m = e instanceof Error ? e.message : String(e);
          this.send(err(req.id, JSONRPC_ERRORS.ACTION_FAILED, m));
        }
        return;
      }
      case "list-actions": {
        try {
          const result = await this.opts.runtime.listActions();
          // ActionInfo[] is JSON-safe (name/description are strings; schema
          // arrived via postMessage and is structured-clone-safe; if a
          // plugin passed a bigint schema, that's the plugin's bug).
          this.send(ok(req.id, jsonOfWire(result)));
        } catch (e: unknown) {
          const m = e instanceof Error ? e.message : String(e);
          this.send(err(req.id, JSONRPC_ERRORS.INTERNAL_ERROR, m));
        }
        return;
      }
      case "subscribe": {
        const p = parseSubscribeParams(req.params);
        if (!p.ok) {
          this.send(err(req.id, JSONRPC_ERRORS.INVALID_PARAMS, p.message));
          return;
        }
        const subId = `s${this.nextSubId++}`;
        try {
          const sub = this.opts.bus.subscribe(p.value.pattern, (name, payload) => {
            // Deliver as a JSON-RPC notification. The payload is `unknown`
            // from the bus; cast at the boundary (any non-JSON value would
            // throw on send -- the bus enforces nothing).
            this.send(notify("event",
              { subscription: subId, name, payload: payload as Json }));
          });
          this.subs.set(subId, sub);
          this.send(ok(req.id, { subscription: subId }));
        } catch (e: unknown) {
          const m = e instanceof Error ? e.message : String(e);
          this.send(err(req.id, JSONRPC_ERRORS.INVALID_PARAMS, m));
        }
        return;
      }
      case "unsubscribe": {
        const p = parseUnsubscribeParams(req.params);
        if (!p.ok) {
          this.send(err(req.id, JSONRPC_ERRORS.INVALID_PARAMS, p.message));
          return;
        }
        const sub = this.subs.get(p.value.subscription);
        if (!sub) {
          this.send(err(req.id, JSONRPC_ERRORS.SUBSCRIPTION_UNKNOWN,
            `No such subscription: ${p.value.subscription}`));
          return;
        }
        sub.off();
        this.subs.delete(p.value.subscription);
        this.send(ok(req.id, null));
        return;
      }
      default:
        this.send(err(req.id, JSONRPC_ERRORS.METHOD_NOT_FOUND,
          `Method not found: ${req.method}`));
    }
  }

  private send(msg: Parameters<typeof encode>[0]): void {
    if (this.closed) return;
    try { this.sock.write(encode(msg)); }
    catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      this.log(`send failed: ${m}`);
    }
  }
}

// Param parsers: each returns either {ok: true, value} or {ok: false, message}.
// Keeping them flat (instead of throws) so the dispatcher can map cleanly to
// JSON-RPC Invalid Params errors.

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function parseInvokeParams(p: unknown): ParseResult<{ action: string; args?: Json }> {
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    return { ok: false, message: "invoke params must be an object" };
  }
  const o = p as { [k: string]: unknown };
  if (typeof o.action !== "string" || o.action.length === 0) {
    return { ok: false, message: "invoke params.action must be a non-empty string" };
  }
  // args is optional. Whatever it is, pass through verbatim; the action
  // handler is responsible for validating per its schema.
  return { ok: true, value: { action: o.action, args: o.args as Json | undefined } };
}

function parseSubscribeParams(p: unknown): ParseResult<{ pattern: string }> {
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    return { ok: false, message: "subscribe params must be an object" };
  }
  const o = p as { [k: string]: unknown };
  if (typeof o.pattern !== "string" || o.pattern.length === 0) {
    return { ok: false, message: "subscribe params.pattern must be a non-empty string" };
  }
  return { ok: true, value: { pattern: o.pattern } };
}

function parseUnsubscribeParams(p: unknown): ParseResult<{ subscription: string }> {
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    return { ok: false, message: "unsubscribe params must be an object" };
  }
  const o = p as { [k: string]: unknown };
  if (typeof o.subscription !== "string" || o.subscription.length === 0) {
    return { ok: false, message: "unsubscribe params.subscription must be a non-empty string" };
  }
  return { ok: true, value: { subscription: o.subscription } };
}

// Cast a worker-wire Json (which permits bigint) to a JSON-RPC Json (which
// does not). A bigint anywhere in the payload will throw on JSON.stringify
// later; the IPC server's outer catch maps that to an Internal Error response.
// Centralized so the eslint-disable lives in one place with a clear comment.
// eslint-disable-next-line no-restricted-syntax
function jsonOfWire(v: WireJson): Json { return v as unknown as Json; }
