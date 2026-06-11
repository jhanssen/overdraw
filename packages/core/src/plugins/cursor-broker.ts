// Cursor broker. Routes plugin-side cursor.* requests into the cursor
// rule engine + compositor cursor slot. Per the design (cursor-design.md),
// explicit setShape / setImage / hide / show / setDefault sit at priority
// 1 (above the client cursor). defineRule installs into the same
// priority-1 slot when its predicate matches.
//
// The broker owns:
//   - the resolver (XCursor theme lookup)
//   - the rule engine
//   - the kinematic state machine
//   - the compositor adapter (RuleInstaller) that translates rule
//     outcomes into compositor mutations
//
// State the broker holds across requests:
//   - explicitOverrideActive: true while a plugin's setShape / setImage /
//     hide is in effect (cleared by clearOverride).
//   - default shape name (string | null); used when no override + no
//     rule + no client cursor.
//   - per-plugin rule registrations (so a plugin teardown can drop them).

import type { Addon } from "../types.js";
import type { CompositorSink } from "../protocols/ctx.js";
import type { CursorThemeResolver } from "../cursor/theme-resolver.js";
import type { Kinematics } from "../cursor/kinematics.js";
import { CursorRuleEngine, type RuleInstaller } from "../cursor/rule-engine.js";
import type { CursorRuleSpec } from "@overdraw/cursor-types";

export interface CursorBrokerDeps {
  addon: Pick<Addon, "resolveCursorShape">;
  compositor: CompositorSink;
  resolver: CursorThemeResolver;
  kinematics: Kinematics;
  ruleEngine: CursorRuleEngine;
  // The size to use for shape resolution. Today: XCURSOR_SIZE env or
  // 24. When the wl_output reconfiguration pre-condition lands, this
  // becomes per-output * scale.
  cursorSizePx: number;
}

export const CURSOR_NOT_HANDLED = Symbol("cursor-broker:not-handled");

export type CursorBroker = (
  pluginName: string, method: string, params: unknown,
) => Promise<unknown> | unknown | typeof CURSOR_NOT_HANDLED;

interface RulesByPlugin {
  // pluginName -> ruleId -> handle
  [pluginName: string]: Map<number, { unregister(): Promise<void> }>;
}

export function createCursorBroker(deps: CursorBrokerDeps): CursorBroker & {
  // Test/main hooks:
  releasePluginRules(pluginName: string): void;
  setDefaultShape(name: string | null): void;
  applyDefault(): void;
} {
  const { addon, compositor, resolver, ruleEngine, cursorSizePx } = deps;

  // Rule engine's installer adapter: knows how to install a named shape
  // (via resolver + setCursorPixels) or a plugin-supplied texture (via
  // setCursorTexture).
  const installer: RuleInstaller = {
    installShape(name: string, _enlarge: number): boolean {
      // enlarge ignored in v1: would need a scale uniform path (the
      // cursor texture is already in core's GPU device; a render-into-
      // scaled-cursor would be the cleanest fix when continuous transforms
      // land). Static enlarge could be done by uploading a larger
      // pre-scaled image -- punt.
      const r = resolver.resolveShape(name, cursorSizePx, 1);
      if (!r) return false;
      compositor.setCursorPixels?.(
        r.rgba, r.width, r.height, r.hotspotX, r.hotspotY);
      compositor.setCursorVisible?.(true);
      return true;
    },
    installTexture(handle: unknown, width: number, height: number,
                   hotspotX: number, hotspotY: number, _enlarge: number): boolean {
      // In-thread bundled plugins pass a GPUTexture directly. The
      // compositor adapter does the install.
      const tex = handle as GPUTexture;
      compositor.setCursorTexture?.(tex, width, height, hotspotX, hotspotY);
      compositor.setCursorVisible?.(true);
      return true;
    },
    installDefault(): void {
      // Re-resolve and install the current default shape (set via
      // sdk.cursor.setDefault, or 'default' at boot).
      const name = defaultShape ?? "default";
      const r = resolver.resolveShape(name, cursorSizePx, 1);
      if (r) {
        compositor.setCursorPixels?.(
          r.rgba, r.width, r.height, r.hotspotX, r.hotspotY);
      }
      compositor.setCursorVisible?.(true);
    },
  };
  ruleEngine.setInstaller(installer);
  ruleEngine.setKinematics(deps.kinematics);

  let defaultShape: string | null = null;
  let explicitOverrideActive = false;
  let nextRuleId = 1;
  // Map of ruleId -> the rule engine's handle (so we can drop by id
  // when the SDK calls unregister-rule).
  const ruleHandles = new Map<number, { unregister(): Promise<void> }>();
  const rulesByPlugin: RulesByPlugin = {};

  function trackRule(pluginName: string, ruleId: number, handle: { unregister(): Promise<void> }): void {
    let m = rulesByPlugin[pluginName];
    if (!m) { m = new Map(); rulesByPlugin[pluginName] = m; }
    m.set(ruleId, handle);
    ruleHandles.set(ruleId, handle);
  }

  function untrackRule(ruleId: number): { unregister(): Promise<void> } | undefined {
    const handle = ruleHandles.get(ruleId);
    if (!handle) return undefined;
    ruleHandles.delete(ruleId);
    for (const m of Object.values(rulesByPlugin)) {
      if (m.has(ruleId)) m.delete(ruleId);
    }
    return handle;
  }

  const broker = (pluginName: string, method: string, params: unknown):
      unknown | typeof CURSOR_NOT_HANDLED => {
    if (method === "cursor.set-shape") return handleSetShape(params);
    if (method === "cursor.set-image") return handleSetImage(params);
    if (method === "cursor.hide") return handleHide();
    if (method === "cursor.show") return handleShow();
    if (method === "cursor.clear-override") return handleClearOverride();
    if (method === "cursor.set-default") return handleSetDefault(params);
    if (method === "cursor.define-rule") return handleDefineRule(pluginName, params);
    if (method === "cursor.unregister-rule") return handleUnregisterRule(params);
    return CURSOR_NOT_HANDLED;
  };

  function handleSetShape(p: unknown): null {
    if (!isShapePayload(p)) throw new Error("cursor.set-shape: malformed payload");
    const r = resolver.resolveShape(p.name, cursorSizePx, 1);
    if (!r) {
      throw new Error(`cursor.set-shape: shape '${p.name}' not in active theme`);
    }
    explicitOverrideActive = true;
    ruleEngine.setExplicitOverride(true);
    compositor.setCursorPixels?.(
      r.rgba, r.width, r.height, r.hotspotX, r.hotspotY);
    compositor.setCursorVisible?.(true);
    return null;
  }

  function handleSetImage(p: unknown): null {
    if (!isImagePayload(p)) throw new Error("cursor.set-image: malformed payload");
    // Worker plugins can't pass a usable GPUTexture (no shared device).
    // In-thread bundled plugins pass the GPUTexture by reference; the
    // handle has the standard GPUTexture interface members. Worker
    // plugins should have rejected the call client-side; this is the
    // server-side guard.
    const handle = p.handle;
    if (!handle || typeof handle !== "object" || !("createView" in handle)) {
      throw new Error(
        "cursor.set-image: cross-device textures not supported; in-thread only in v1");
    }
    explicitOverrideActive = true;
    ruleEngine.setExplicitOverride(true);
    // eslint-disable-next-line no-restricted-syntax -- duck-typed above
    const tex = handle as unknown as GPUTexture;
    compositor.setCursorTexture?.(tex, p.width, p.height, p.hotspotX, p.hotspotY);
    compositor.setCursorVisible?.(true);
    return null;
  }

  function handleHide(): null {
    explicitOverrideActive = true;
    ruleEngine.setExplicitOverride(true);
    compositor.setCursorVisible?.(false);
    return null;
  }

  function handleShow(): null {
    // show() un-hides but does NOT remove an explicit override -- the
    // previously-installed shape/image is restored.
    compositor.setCursorVisible?.(true);
    return null;
  }

  function handleClearOverride(): null {
    explicitOverrideActive = false;
    ruleEngine.setExplicitOverride(false);
    // Re-evaluate rules. If none match, the engine's installer.installDefault
    // re-installs whatever defaultShape we have.
    ruleEngine.evaluate();
    return null;
  }

  function handleSetDefault(p: unknown): null {
    if (!isSetDefaultPayload(p)) throw new Error("cursor.set-default: malformed payload");
    defaultShape = p.shape;
    // If no explicit override + no rule is active, the change shows up
    // by re-installing the default.
    if (!explicitOverrideActive) {
      // evaluate() with no rule matching falls through to installer.
      // installDefault which reads the latest defaultShape.
      ruleEngine.evaluate();
      // If still nothing was installed (no rules, no current install
      // change), force a default install.
      installer.installDefault();
    }
    return null;
  }

  function handleDefineRule(pluginName: string, p: unknown): { ruleId: number } {
    if (!isRuleSpecPayload(p)) throw new Error("cursor.define-rule: malformed payload");
    const handle = ruleEngine.register(p);
    const ruleId = nextRuleId++;
    trackRule(pluginName, ruleId, handle);
    return { ruleId };
  }

  async function handleUnregisterRule(p: unknown): Promise<null> {
    if (!isUnregisterRulePayload(p)) {
      throw new Error("cursor.unregister-rule: malformed payload");
    }
    const handle = untrackRule(p.ruleId);
    if (handle) await handle.unregister();
    return null;
  }

  return Object.assign(broker, {
    // Called when a plugin disconnects/dies: drop all rules it registered.
    releasePluginRules(pluginName: string): void {
      const m = rulesByPlugin[pluginName];
      if (!m) return;
      for (const [id, handle] of m.entries()) {
        ruleHandles.delete(id);
        handle.unregister().catch(() => { /* best effort */ });
      }
      delete rulesByPlugin[pluginName];
    },
    setDefaultShape(name: string | null): void { defaultShape = name; },
    applyDefault(): void { installer.installDefault(); },
  });
  void addon;  // referenced in type but used via resolver.
}

// --- payload typeguards ----------------------------------------------------

function isShapePayload(p: unknown): p is { name: string } {
  return !!p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string";
}

function isImagePayload(p: unknown): p is {
  handle: unknown; width: number; height: number; hotspotX: number; hotspotY: number;
} {
  if (!p || typeof p !== "object") return false;
  const x = p as Record<string, unknown>;
  return typeof x.width === "number" && typeof x.height === "number"
      && typeof x.hotspotX === "number" && typeof x.hotspotY === "number"
      && x.handle !== undefined;
}

function isSetDefaultPayload(p: unknown): p is { shape: string | null } {
  if (!p || typeof p !== "object") return false;
  const x = p as { shape?: unknown };
  return x.shape === null || typeof x.shape === "string";
}

function isRuleSpecPayload(p: unknown): p is CursorRuleSpec {
  // Light shape check; the rule engine's validateSpec does the full check.
  if (!p || typeof p !== "object") return false;
  const x = p as Record<string, unknown>;
  return typeof x.when === "object" && x.when !== null
    && (typeof x.shape === "string" || typeof x.texture === "object");
}

function isUnregisterRulePayload(p: unknown): p is { ruleId: number } {
  return !!p && typeof p === "object"
    && typeof (p as { ruleId?: unknown }).ruleId === "number";
}
