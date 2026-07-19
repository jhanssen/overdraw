// overdrawctl: CLI client for the overdraw IPC server
// (core-plugin-api.md §12).
//
// Subcommands:
//   invoke <action> [json-args]    -- invoke an action; print result as JSON
//   list-actions                    -- print every registered action
//   subscribe <pattern>             -- stream matching events to stdout
//
// Socket discovery (highest priority first):
//   --socket <path>                 explicit
//   $OVERDRAW_SOCKET                env var
//   $XDG_RUNTIME_DIR/overdraw-*.sock  exactly one match
//
// Wire: JSON-RPC 2.0 over a Unix stream socket, newline-delimited.

import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  encode, parseMessage, JSONRPC_ERRORS, type Request, type Response,
} from "../ipc/protocol.js";

type Args = {
  command: "invoke" | "list-actions" | "subscribe" | "switch-mode"
    | "restart-xwayland" | "help";
  socket?: string;
  action?: string;
  pattern?: string;
  actionArgs?: unknown;
  // switch-mode parsed args
  outputKey?: string;
  modeWidth?: number;
  modeHeight?: number;
  modeRefreshMhz?: number;
};

const USAGE = `\
overdrawctl - CLI client for overdraw

Usage:
  overdrawctl [--socket PATH] <command> [args...]

Commands:
  invoke <action> [json-args]   Invoke an action; prints the result as JSON.
  list-actions                  Print every registered action.
  subscribe <pattern>           Stream matching events to stdout (one event per
                                line as JSON). Pattern grammar matches the bus:
                                exact ('window.map'), prefix-glob ('workspace.*'),
                                or catch-all ('*').
  query <topic>                 Shorthand for: invoke query.<topic>. Topics:
                                  state   outputs, windows (rects, insets,
                                          window state, titles), stack, focus
                                  render  per-output draw order + direct-scanout
                                          status
  switch-mode --output NAME --mode WxH[@RATE]
                                Switch a KMS output to a new mode. NAME is the
                                connector name (e.g. 'DP-1') OR the durable EDID
                                id ('ACM-1234-CAFEBABE'); same precedence as the
                                workspace plugin. RATE is the refresh in Hz
                                (e.g. 60, 144); omit to match any rate at the
                                given dims. Equivalent to:
                                  invoke output.switch-mode
                                    '{"output":NAME,"width":W,"height":H,
                                      "refreshMhz":RATE*1000}'
  restart-xwayland              Restart the Xwayland stack (process + WM +
                                selection bridge) without restarting the
                                compositor. Kills running X11 clients.
                                Equivalent to: invoke xwayland.restart
  -h, --help                    Show this help.

Socket discovery (highest priority first):
  --socket PATH                  Explicit path.
  $OVERDRAW_SOCKET               Environment variable.
  $XDG_RUNTIME_DIR/overdraw-*.sock  Auto-discover (exactly one match).
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  const socketPath = await resolveSocket(args.socket);
  const sock = createConnection({ path: socketPath });
  sock.setEncoding("utf8");

  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });

  switch (args.command) {
    case "invoke":
      if (args.action === undefined) die("internal: invoke without action");
      await runInvoke(sock, args.action, args.actionArgs);
      return;
    case "list-actions":
      await runListActions(sock);
      return;
    case "subscribe":
      if (args.pattern === undefined) die("internal: subscribe without pattern");
      await runSubscribe(sock, args.pattern);
      return;
    case "switch-mode":
      if (args.outputKey === undefined
          || args.modeWidth === undefined
          || args.modeHeight === undefined) {
        die("internal: switch-mode without parsed args");
      }
      await runInvoke(sock, "output.switch-mode", {
        output: args.outputKey,
        width: args.modeWidth,
        height: args.modeHeight,
        ...(args.modeRefreshMhz !== undefined && args.modeRefreshMhz > 0
            ? { refreshMhz: args.modeRefreshMhz } : {}),
      });
      return;
    case "restart-xwayland":
      await runInvoke(sock, "xwayland.restart", null);
      return;
  }
}

function parseArgs(argv: string[]): Args {
  let socket: string | undefined;
  // switch-mode flags. Captured here so they can appear in any position
  // relative to the positional command.
  let outputKey: string | undefined;
  let modeSpec: string | undefined;
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { command: "help" };
    if (a === "--socket") {
      const next = argv[i + 1];
      if (!next) die("--socket requires a path");
      socket = next;
      i += 2;
      continue;
    }
    if (a.startsWith("--socket=")) { socket = a.slice("--socket=".length); i++; continue; }
    if (a === "--output") {
      const next = argv[i + 1];
      if (!next) die("--output requires a value");
      outputKey = next;
      i += 2;
      continue;
    }
    if (a.startsWith("--output=")) { outputKey = a.slice("--output=".length); i++; continue; }
    if (a === "--mode") {
      const next = argv[i + 1];
      if (!next) die("--mode requires a value");
      modeSpec = next;
      i += 2;
      continue;
    }
    if (a.startsWith("--mode=")) { modeSpec = a.slice("--mode=".length); i++; continue; }
    if (a.startsWith("--")) die(`unknown option: ${a}`);
    positional.push(a);
    i++;
  }
  if (positional.length === 0) die(`missing command (try --help)`);
  const cmd = positional[0];
  if (cmd === "invoke") {
    if (positional.length < 2) die("invoke requires an action name");
    const action = positional[1];
    let actionArgs: unknown = null;
    if (positional.length >= 3) {
      const raw = positional.slice(2).join(" ");
      try { actionArgs = JSON.parse(raw); }
      catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        die(`invoke args must be valid JSON: ${msg}`);
      }
    }
    return { command: "invoke", socket, action, actionArgs };
  }
  if (cmd === "list-actions") return { command: "list-actions", socket };
  if (cmd === "query") {
    if (positional.length < 2) die("query requires a topic (try --help)");
    return { command: "invoke", socket, action: `query.${positional[1]}`, actionArgs: null };
  }
  if (cmd === "restart-xwayland") return { command: "restart-xwayland", socket };
  if (cmd === "subscribe") {
    if (positional.length < 2) die("subscribe requires a pattern");
    return { command: "subscribe", socket, pattern: positional[1] };
  }
  if (cmd === "switch-mode") {
    if (!outputKey) die("switch-mode requires --output NAME");
    if (!modeSpec) die("switch-mode requires --mode WxH[@RATE]");
    const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(modeSpec);
    if (!m) die(`switch-mode: invalid --mode '${modeSpec}' (expected WxH[@RATE])`);
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (!(w > 0) || !(h > 0)) die("switch-mode: width/height must be positive");
    let refreshMhz = 0;
    if (m[3] !== undefined) {
      // Rate is in Hz on the CLI; the wire carries mHz (Hz * 1000).
      // parseFloat handles 60, 59.94, 144, etc.
      const hz = parseFloat(m[3]);
      if (!(hz > 0)) die("switch-mode: rate must be positive");
      refreshMhz = Math.round(hz * 1000);
    }
    return {
      command: "switch-mode", socket, outputKey,
      modeWidth: w, modeHeight: h, modeRefreshMhz: refreshMhz,
    };
  }
  die(`unknown command: ${cmd}`);
}

function die(msg: string): never {
  process.stderr.write(`overdrawctl: ${msg}\n`);
  process.exit(2);
}

async function resolveSocket(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const env = process.env.OVERDRAW_SOCKET;
  if (env) return env;

  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) die("XDG_RUNTIME_DIR not set; specify --socket explicitly");

  try {
    const entries = await readdir(runtimeDir);
    const matches = entries.filter((n) => n.startsWith("overdraw-") && n.endsWith(".sock"));
    if (matches.length === 0) {
      die(`no overdraw socket found in ${runtimeDir} (specify --socket)`);
    }
    if (matches.length > 1) {
      die(`multiple overdraw sockets in ${runtimeDir} (${matches.join(", ")}); specify --socket`);
    }
    return join(runtimeDir, matches[0]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    die(`cannot list ${runtimeDir}: ${msg}`);
  }
}

// Single-shot request/response: send one request, await its reply, exit.
async function singleShot(sock: Socket, req: Request): Promise<void> {
  let buf = "";
  const done = new Promise<void>((resolve, reject) => {
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Response;
        try { msg = parseMessage(line) as Response; }
        catch (e: unknown) {
          reject(e); return;
        }
        if (msg.id !== req.id) continue;   // stray notification; ignore
        if ("error" in msg) {
          // Match server-side error codes to exit statuses.
          const c = msg.error.code;
          const status = c === JSONRPC_ERRORS.METHOD_NOT_FOUND
            || c === JSONRPC_ERRORS.INVALID_PARAMS ? 3 : 1;
          process.stderr.write(`error ${c}: ${msg.error.message}\n`);
          process.exit(status);
        }
        process.stdout.write(JSON.stringify(msg.result, null, 2) + "\n");
        resolve();
        return;
      }
    });
    sock.on("close", () => reject(new Error("connection closed before reply")));
    sock.on("error", reject);
  });
  sock.write(encode(req));
  await done;
  sock.end();
}

async function runInvoke(sock: Socket, action: string, args: unknown): Promise<void> {
  await singleShot(sock, {
    jsonrpc: "2.0", id: 1, method: "invoke",
    params: { action, args: args === null ? null : (args as Parameters<typeof JSON.stringify>[0]) },
  });
}

async function runListActions(sock: Socket): Promise<void> {
  await singleShot(sock, { jsonrpc: "2.0", id: 1, method: "list-actions" });
}

// Streaming: send subscribe, then print every `event` notification as one
// JSON line per event to stdout. Runs until the process is killed
// (Ctrl-C / SIGTERM); on disconnect we exit cleanly.
async function runSubscribe(sock: Socket, pattern: string): Promise<void> {
  let buf = "";
  let subscriptionId: string | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: unknown;
        try { msg = parseMessage(line); }
        catch { continue; }
        const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
        if (m.id === 1 && "error" in m) {
          const e = m.error as { code: number; message: string };
          process.stderr.write(`error ${e.code}: ${e.message}\n`);
          process.exit(1);
        }
        if (m.id === 1 && "result" in m) {
          const r = m.result as { subscription: string };
          subscriptionId = r.subscription;
          resolve();
          continue;
        }
        if (m.method === "event") {
          // Print each event as a single JSON line on stdout. Status bars
          // / scripts consume this as a stream.
          process.stdout.write(JSON.stringify(m.params) + "\n");
        }
      }
    });
    sock.on("close", () => {
      if (subscriptionId === null) reject(new Error("connection closed before subscribe ack"));
      else process.exit(0);
    });
    sock.on("error", reject);
  });
  sock.write(encode({ jsonrpc: "2.0", id: 1, method: "subscribe", params: { pattern } }));
  await ready;
  // Run until disconnect / signal. The .on('data') handler keeps emitting.
  await new Promise<void>(() => {});   // never resolves; SIGINT exits
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`overdrawctl: ${msg}\n`);
  process.exit(1);
});
