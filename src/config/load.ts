// Config resolution + loading.
//
// Resolution order:
//   1. An explicit `--config <path>` (or `--config=<path>`) CLI arg. If given,
//      that exact file must exist and load, else it is a hard error (a typo'd
//      --config must not silently fall through to defaults).
//   2. Otherwise XDG: $XDG_CONFIG_HOME/overdraw/ (or ~/.config/overdraw/),
//      probing config.{ts,cts,mts,js,cjs,mjs} in that order; first existing wins.
//   3. None found -> built-in defaults (overdraw runs with no config file).
//
// Config files are loaded with dynamic import(); Node 24 strips types from
// .ts/.cts/.mts natively (verified on the project's runtime), so no transpile
// step is needed. The default export is an OverdrawConfig object or a
// (sync/async) function returning one.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ConfigExport, OverdrawConfig, PluginConfig, ResolvedConfig, FocusPolicy,
} from "./types.js";

const CONFIG_EXTS = ["ts", "cts", "mts", "js", "cjs", "mjs"] as const;
const FOCUS_POLICIES: readonly FocusPolicy[] = ["follow-pointer", "click-to-focus"];

const DEFAULTS = {
  focus: { policy: "follow-pointer" as FocusPolicy, focusOnMap: true },
};

// Pull `--config <path>` / `--config=<path>` out of an argv-style array.
// Returns the path, or null if absent.
export function parseConfigArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--config requires a path argument");
      }
      return next;
    }
    if (a.startsWith("--config=")) return a.slice("--config=".length);
  }
  return null;
}

// The XDG config directory for overdraw.
function xdgConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME;
  return base && base.length > 0 ? join(base, "overdraw") : join(homedir(), ".config", "overdraw");
}

// Find the config file to load, honoring an explicit --config path. Returns an
// absolute path, or null when no file is found and none was demanded.
export function resolveConfigPath(explicit: string | null): string | null {
  if (explicit !== null) {
    const abs = isAbsolute(explicit) ? explicit : resolvePath(process.cwd(), explicit);
    if (!existsSync(abs)) throw new Error(`config file not found: ${abs}`);
    return abs;
  }
  const dir = xdgConfigDir();
  for (const ext of CONFIG_EXTS) {
    const p = join(dir, `config.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

function fail(msg: string, path: string): never {
  throw new Error(`invalid config (${path}): ${msg}`);
}

// Validate + normalize a raw user config object into a ResolvedConfig.
function normalize(raw: unknown, path: string): ResolvedConfig {
  if (raw === null || typeof raw !== "object") {
    fail("default export must be an object (or a function returning one)", path);
  }
  const cfg = raw as OverdrawConfig;

  // output
  let output: ResolvedConfig["output"] = null;
  if (cfg.output !== undefined) {
    const o = cfg.output;
    if (o === null || typeof o !== "object") fail("`output` must be an object", path);
    const w = o.width, h = o.height;
    if (w !== undefined || h !== undefined) {
      if (!Number.isInteger(w) || !Number.isInteger(h) || (w as number) <= 0 || (h as number) <= 0) {
        fail("`output.width`/`output.height` must be positive integers (both required together)", path);
      }
      output = { width: w as number, height: h as number };
    }
  }

  // focus
  const focus = { ...DEFAULTS.focus };
  if (cfg.focus !== undefined) {
    const f = cfg.focus;
    if (f === null || typeof f !== "object") fail("`focus` must be an object", path);
    if (f.policy !== undefined) {
      if (!FOCUS_POLICIES.includes(f.policy)) {
        fail(`\`focus.policy\` must be one of ${FOCUS_POLICIES.map((p) => `"${p}"`).join(", ")}`, path);
      }
      focus.policy = f.policy;
    }
    if (f.focusOnMap !== undefined) {
      if (typeof f.focusOnMap !== "boolean") fail("`focus.focusOnMap` must be a boolean", path);
      focus.focusOnMap = f.focusOnMap;
    }
  }

  // plugins (DEFERRED: validated/stored, not consumed — see types.ts)
  const plugins: PluginConfig[] = [];
  if (cfg.plugins !== undefined) {
    if (!Array.isArray(cfg.plugins)) fail("`plugins` must be an array", path);
    cfg.plugins.forEach((p, i) => {
      if (p === null || typeof p !== "object") fail(`plugins[${i}] must be an object`, path);
      if (typeof (p as PluginConfig).module !== "string" || (p as PluginConfig).module.length === 0) {
        fail(`plugins[${i}].module must be a non-empty string`, path);
      }
      plugins.push(p as PluginConfig);
    });
  }

  return { output, focus, plugins, sourcePath: path };
}

// Resolve, import, and normalize the config. `explicit` is the --config path (or
// null). Returns defaults when no config file exists and none was demanded.
export async function loadConfig(explicit: string | null): Promise<ResolvedConfig> {
  const path = resolveConfigPath(explicit);
  if (path === null) {
    return { output: null, focus: { ...DEFAULTS.focus }, plugins: [], sourcePath: null };
  }
  const mod = (await import(pathToFileURL(path).href)) as { default?: ConfigExport };
  if (mod.default === undefined) fail("file has no default export", path);
  let value: unknown = mod.default;
  if (typeof value === "function") {
    value = await (value as () => OverdrawConfig | Promise<OverdrawConfig>)();
  }
  return normalize(value, path);
}
