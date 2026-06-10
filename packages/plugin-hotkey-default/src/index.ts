// Bundled hotkey plugin. Parses the user's hotkey config (KeyboardConfig
// from @overdraw/hotkey-types), defines any sub-modes on the seat's
// binding chain, and registers each binding via sdk.input.bind. The
// binding handler dispatches per the BindingSpec's outcome (action /
// pushMode / popMode).
//
// In-thread, namespace 'hotkey', priority 0 (the bundled-plugin floor).
// User configs may override by registering a higher-priority hotkey
// plugin in the same namespace.

import type {
  KeyboardConfig, BindingSpec, ModeSpec,
} from "@overdraw/hotkey-types";

interface SdkLike {
  readonly name: string;
  log(...args: unknown[]): void;
  registerPlugin<A>(name: string, init: () => Promise<A> | A,
                   opts?: { priority?: number }): Promise<{ unregister(): void }>;
  actions: {
    invoke(name: string, params?: unknown): Promise<unknown>;
  };
  input: {
    bind(opts: { keys: string | readonly string[]; mode?: string;
                 handler: (event: unknown) => void | Promise<void>;
                 priority?: number; }): Promise<{ unregister(): void }>;
    defineMode(name: string, opts?: { exitOnEscape?: boolean }):
      Promise<{ undefine(): void }>;
    pushMode(name: string): Promise<void>;
    popMode(): Promise<void>;
  };
}

// Minimal namespace API the plugin exposes. There's nothing for other
// plugins to call into today; the namespace exists so a third-party
// hotkey plugin can replace this one via the priority chain.
const api = {} as const;

export default async function init(sdk: SdkLike, rawConfig?: unknown): Promise<void> {
  const config = validateConfig(rawConfig);

  // The config validator returns an empty config when rawConfig is null /
  // undefined; in that case there's nothing to define or bind. The plugin
  // still registers its namespace (so the priority chain works) but is
  // otherwise inert.
  for (const [modeName, modeSpec] of Object.entries(config.modes)) {
    if (modeName === "default") continue;
    await sdk.input.defineMode(modeName,
      modeSpec.exitOnEscape !== undefined ? { exitOnEscape: modeSpec.exitOnEscape } : undefined);
  }

  // Track bind handles for later sdk.windows.onShutdown cleanup. (The
  // runtime calls onShutdown on plugin termination; binding unregister
  // is reentrant-safe with the chain.)
  const bindings: { unregister(): void }[] = [];
  for (const [modeName, modeSpec] of Object.entries(config.modes)) {
    for (const binding of modeSpec.bindings) {
      const handle = await sdk.input.bind({
        keys: binding.keys as string | readonly string[],
        mode: modeName,
        handler: () => dispatch(binding),
      });
      bindings.push(handle);
    }
  }

  async function dispatch(binding: BindingSpec): Promise<void> {
    if (binding.action) {
      try {
        await sdk.actions.invoke(binding.action, binding.params);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sdk.log(`action '${binding.action}' failed: ${msg}`);
      }
      return;
    }
    if (binding.pushMode) {
      try {
        await sdk.input.pushMode(binding.pushMode);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sdk.log(`pushMode '${binding.pushMode}' failed: ${msg}`);
      }
      return;
    }
    if (binding.popMode) {
      try {
        await sdk.input.popMode();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sdk.log(`popMode failed: ${msg}`);
      }
      return;
    }
    // validateConfig rejects bindings with no outcome; this is defensive.
    sdk.log(`binding has no outcome: ${JSON.stringify(binding)}`);
  }

  await sdk.registerPlugin("hotkey", () => api);
  const totalBindings = Object.values(config.modes)
    .reduce((n, m) => n + m.bindings.length, 0);
  const modeCount = Object.keys(config.modes).length;
  sdk.log(`hotkey plugin registered (${totalBindings} bindings across ${modeCount} mode${modeCount === 1 ? "" : "s"})`);
}

// Normalize + validate the user's config. Returns a NormalizedConfig where
// every mode is in the ModeSpec form (no BindingSpec[] shorthand).
// Empty / absent config is allowed (returns no modes, no bindings).
//
// Throws TypeError on schema deviation; init throws are fatal startup
// errors per the in-thread bundled-plugin contract.
interface NormalizedConfig {
  modes: { [name: string]: ModeSpec };
}

export function validateConfig(raw: unknown): NormalizedConfig {
  if (raw === null || raw === undefined) {
    return { modes: { default: { bindings: [] } } };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`hotkey config must be an object (got ${typeof raw})`);
  }
  const o = raw as { [k: string]: unknown };
  if (o.modes === undefined) {
    throw new TypeError("hotkey config missing 'modes'");
  }
  if (typeof o.modes !== "object" || o.modes === null || Array.isArray(o.modes)) {
    throw new TypeError("hotkey config 'modes' must be an object");
  }
  const modesIn = o.modes as { [k: string]: unknown };
  if (modesIn.default === undefined) {
    throw new TypeError("hotkey config 'modes' must include 'default'");
  }
  const modes: { [name: string]: ModeSpec } = {};
  for (const [name, val] of Object.entries(modesIn)) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`hotkey mode name must be a non-empty string`);
    }
    const spec = normalizeModeSpec(name, val);
    for (const b of spec.bindings) validateBindingSpec(name, b);
    modes[name] = spec;
  }
  return { modes };
}

function normalizeModeSpec(name: string, val: unknown): ModeSpec {
  if (Array.isArray(val)) {
    return { bindings: val as BindingSpec[] };
  }
  if (typeof val !== "object" || val === null) {
    throw new TypeError(`hotkey mode '${name}' must be a BindingSpec[] or ModeSpec`);
  }
  const o = val as { [k: string]: unknown };
  if (!Array.isArray(o.bindings)) {
    throw new TypeError(`hotkey mode '${name}' missing 'bindings' array`);
  }
  const spec: ModeSpec = { bindings: o.bindings as BindingSpec[] };
  if (o.exitOnEscape !== undefined) {
    if (typeof o.exitOnEscape !== "boolean") {
      throw new TypeError(`hotkey mode '${name}' exitOnEscape must be a boolean`);
    }
    spec.exitOnEscape = o.exitOnEscape;
  }
  return spec;
}

function validateBindingSpec(modeName: string, b: BindingSpec): void {
  if (typeof b !== "object" || b === null) {
    throw new TypeError(`hotkey '${modeName}' has a non-object binding`);
  }
  if (b.keys === undefined) {
    throw new TypeError(`hotkey '${modeName}' binding missing 'keys'`);
  }
  if (typeof b.keys !== "string" && !Array.isArray(b.keys)) {
    throw new TypeError(`hotkey '${modeName}' binding 'keys' must be a string or array`);
  }
  // Exactly one outcome.
  const outcomes = [b.action, b.pushMode, b.popMode].filter((v) => v !== undefined);
  if (outcomes.length === 0) {
    throw new TypeError(
      `hotkey '${modeName}' binding has no outcome (set one of action / pushMode / popMode): ${JSON.stringify(b)}`);
  }
  if (outcomes.length > 1) {
    throw new TypeError(
      `hotkey '${modeName}' binding has multiple outcomes (set only one of action / pushMode / popMode): ${JSON.stringify(b)}`);
  }
  if (b.action !== undefined && (typeof b.action !== "string" || b.action.length === 0)) {
    throw new TypeError(`hotkey '${modeName}' binding 'action' must be a non-empty string`);
  }
  if (b.pushMode !== undefined && (typeof b.pushMode !== "string" || b.pushMode.length === 0)) {
    throw new TypeError(`hotkey '${modeName}' binding 'pushMode' must be a non-empty string`);
  }
  if (b.popMode !== undefined && b.popMode !== true) {
    throw new TypeError(`hotkey '${modeName}' binding 'popMode' must be the literal true`);
  }
}
