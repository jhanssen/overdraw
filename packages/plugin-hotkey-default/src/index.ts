// Bundled hotkey plugin. Parses the user's hotkey config (KeyboardConfig
// from @overdraw/hotkey-types), defines any sub-modes on the seat's
// binding chain, and registers each binding via sdk.input.bind. The
// binding handler dispatches per the BindingSpec's outcome (action /
// pushMode / popMode).
//
// In-thread, namespace 'hotkey', priority 0 (the bundled-plugin floor). A
// higher-priority claim on 'hotkey' replaces this plugin outright: mode
// definitions and key binds happen inside the activation callback, so when
// another claimant wins, none of this plugin's bindings exist.

import type {
  BindingSpec, ModeSpec,
} from "@overdraw/hotkey-types";
import type { PluginSdkShape } from "@overdraw/plugin-sdk-types";

export default async function init(sdk: PluginSdkShape, rawConfig?: unknown): Promise<void> {
  // Config validation is eager (a bad config fails the plugin at load);
  // modes and binds are established only on activation.
  const config = validateConfig(rawConfig);
  await sdk.registerPlugin("hotkey", () => activate(sdk, config));
}

// The namespace API is empty -- there's nothing for other plugins to call
// into today. Activation's value is its side effects: the seat modes and
// key binds come into existence here, for the winning claimant only.
async function activate(
  sdk: PluginSdkShape, config: NormalizedConfig,
): Promise<{ [k: string]: unknown }> {
  // The config validator returns an empty config when rawConfig is null /
  // undefined; in that case there's nothing to define or bind. The plugin
  // still claims its namespace (so the priority chain works) but is
  // otherwise inert.
  for (const [modeName, modeSpec] of Object.entries(config.modes)) {
    if (modeName === "default") continue;
    await sdk.input.defineMode(modeName,
      modeSpec.exitOnEscape !== undefined ? { exitOnEscape: modeSpec.exitOnEscape } : undefined);
  }

  // No teardown bookkeeping here: the core's input broker drops every
  // bind and mode this plugin registered when the plugin is torn down
  // (runtime onPluginRelease), so a restart -- crash respawn or config
  // reload -- re-defines and re-binds from a clean slate.
  for (const [modeName, modeSpec] of Object.entries(config.modes)) {
    for (const binding of modeSpec.bindings) {
      const hasRelease = binding.releaseAction !== undefined
        || binding.releasePushMode !== undefined
        || binding.releasePopMode !== undefined;
      const bindOpts: Parameters<typeof sdk.input.bind>[0] = {
        keys: binding.keys as string | readonly string[],
        mode: modeName,
        handler: () => dispatchPress(binding),
      };
      if (hasRelease) {
        bindOpts.release = () => dispatchRelease(binding);
      }
      await sdk.input.bind(bindOpts);
    }
  }

  // Shared outcome dispatcher: press and release differ only in which
  // BindingSpec fields carry the outcome (action/pushMode/popMode vs the
  // release* counterparts). `fieldPrefix` keys the log messages to the
  // field the user actually wrote.
  async function dispatchOutcome(
    outcome: { action?: string; params?: unknown; pushMode?: string; popMode?: true },
    fieldPrefix: "" | "release",
    noOutcomeMsg: string,
  ): Promise<void> {
    const field = (name: string) =>
      fieldPrefix === "" ? name : fieldPrefix + name[0].toUpperCase() + name.slice(1);
    const fail = (what: string, err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      sdk.log(`${what} failed: ${msg}`);
    };
    if (outcome.action) {
      try {
        await sdk.actions.invoke(outcome.action, outcome.params);
      } catch (err: unknown) {
        fail(`${field("action")} '${outcome.action}'`, err);
      }
      return;
    }
    if (outcome.pushMode) {
      try {
        await sdk.input.pushMode(outcome.pushMode);
      } catch (err: unknown) {
        fail(`${field("pushMode")} '${outcome.pushMode}'`, err);
      }
      return;
    }
    if (outcome.popMode) {
      try {
        await sdk.input.popMode();
      } catch (err: unknown) {
        fail(field("popMode"), err);
      }
      return;
    }
    sdk.log(noOutcomeMsg);
  }

  function dispatchPress(binding: BindingSpec): Promise<void> {
    return dispatchOutcome(
      { action: binding.action, params: binding.params,
        pushMode: binding.pushMode, popMode: binding.popMode },
      "",
      `binding has no outcome: ${JSON.stringify(binding)}`);
  }

  function dispatchRelease(binding: BindingSpec): Promise<void> {
    return dispatchOutcome(
      { action: binding.releaseAction, params: binding.releaseParams,
        pushMode: binding.releasePushMode, popMode: binding.releasePopMode },
      "release",
      `binding has releaseAction but no outcome: ${JSON.stringify(binding)}`);
  }

  const totalBindings = Object.values(config.modes)
    .reduce((n, m) => n + m.bindings.length, 0);
  const modeCount = Object.keys(config.modes).length;
  sdk.log(`hotkey plugin activated (${totalBindings} bindings across ${modeCount} mode${modeCount === 1 ? "" : "s"})`);
  return {};
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

  // Release-half validation: at most one of releaseAction / releasePushMode /
  // releasePopMode. Empty (none) is fine; it just means the binding has no
  // release behavior.
  const releaseOutcomes = [b.releaseAction, b.releasePushMode, b.releasePopMode]
    .filter((v) => v !== undefined);
  if (releaseOutcomes.length > 1) {
    throw new TypeError(
      `hotkey '${modeName}' binding has multiple release outcomes (set at most one of releaseAction / releasePushMode / releasePopMode): ${JSON.stringify(b)}`);
  }
  if (b.releaseAction !== undefined
      && (typeof b.releaseAction !== "string" || b.releaseAction.length === 0)) {
    throw new TypeError(`hotkey '${modeName}' binding 'releaseAction' must be a non-empty string`);
  }
  if (b.releasePushMode !== undefined
      && (typeof b.releasePushMode !== "string" || b.releasePushMode.length === 0)) {
    throw new TypeError(`hotkey '${modeName}' binding 'releasePushMode' must be a non-empty string`);
  }
  if (b.releasePopMode !== undefined && b.releasePopMode !== true) {
    throw new TypeError(`hotkey '${modeName}' binding 'releasePopMode' must be the literal true`);
  }
}
