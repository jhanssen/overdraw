// Cursor rule engine: stores registered CursorRuleSpec entries, evaluates
// predicates against the kinematic snapshot each frame, and installs the
// matching rule's outcome into the cursor slot. Plugin-facing surface is
// in plugins/cursor-sdk.ts; the broker routes register/unregister into
// here.
//
// Match semantics: rules are stored in registration order; the FIRST
// matching rule wins (per design doc Q3-ish "rules registered earlier
// match first"). Re-evaluation happens once per frame, not per pointer
// motion event -- this caps churn at the compositor's frame rate even
// under high-frequency pointer streams.
//
// Sharing with the cursor slot: the engine doesn't own the cursor slot.
// It calls into a small adapter (RuleInstaller) that the broker provides;
// the adapter knows how to install a CPU-bytes shape from the theme
// resolver or a plugin-supplied texture. This keeps the rule engine
// independent of the compositor / addon.
//
// Lazy kinematic enablement: each rule that uses speedRange / idle /
// shake bumps a refcount on the Kinematics state machine. Unregistering
// drops it; when no rule cares, the kinematic ring stops sampling.

import type { Kinematics, KinematicsSnapshot } from "./kinematics.js";
import type {
  CursorRuleSpec, CursorRuleHandle, CursorRuleWhen,
} from "@overdraw/cursor-types";

// What the rule engine needs from outside to actually install a matched
// rule into the compositor's cursor slot. The broker constructs one of
// these around the JsCompositor + theme resolver.
export interface RuleInstaller {
  // Install a named shape (theme resolver lookup). The installer is
  // expected to handle "not found" by leaving the previous cursor in
  // place; this method returns true if the install succeeded.
  installShape(name: string, enlarge: number): boolean;
  // Install a plugin-supplied texture. The installer handles cross-
  // transport differences (in-thread = direct GPUTexture; Worker not
  // supported in v1).
  installTexture(textureHandle: unknown, width: number, height: number,
                 hotspotX: number, hotspotY: number, enlarge: number): boolean;
  // Restore the compositor default (built-in / setDefault). Called when
  // no rule matches and no explicit override is active.
  installDefault(): void;
}

interface InternalRule {
  id: number;
  spec: CursorRuleSpec;
  // Cache of which kinematic capabilities this rule needs, so unregister
  // can drop the right number of refcounts.
  needsSpeed: boolean;
  needsIdle: boolean;
  needsShake: boolean;
}

export class CursorRuleEngine {
  private rules: InternalRule[] = [];
  private nextId = 1;
  private installer: RuleInstaller | null = null;
  private kinematics: Kinematics | null = null;
  // Which rule (by id) is currently installed. -1 = compositor default;
  // 0 = an explicit setShape/setImage override (rule engine doesn't
  // own the slot in that case).
  private activeRuleId = -1;
  // True while an explicit override (setShape/setImage from a plugin)
  // is in place. Rules don't preempt explicit overrides; the broker
  // sets this via setExplicitOverride().
  private explicitOverride = false;

  setInstaller(installer: RuleInstaller): void { this.installer = installer; }
  setKinematics(k: Kinematics): void { this.kinematics = k; }

  // Called by the broker on explicit setShape / setImage. While true, the
  // rule engine doesn't install rules (the plugin's explicit choice wins).
  // Cleared on clearOverride().
  setExplicitOverride(active: boolean): void {
    this.explicitOverride = active;
  }

  register(spec: CursorRuleSpec): CursorRuleHandle {
    validateSpec(spec);
    const r: InternalRule = {
      id: this.nextId++,
      spec,
      needsSpeed: spec.when.speedRange !== undefined,
      needsIdle: spec.when.idle !== undefined,
      needsShake: spec.when.shake !== undefined,
    };
    this.rules.push(r);
    // Bump kinematic refcount for each capability this rule needs. The
    // state machine starts sampling once any rule cares.
    const k = this.kinematics;
    if (k) {
      if (r.needsSpeed) k.enable();
      if (r.needsIdle) k.enable();
      if (r.needsShake) k.enable();
    }
    // Re-evaluate immediately so a newly-registered rule that matches
    // the current state installs without waiting for the next frame.
    this.evaluate();
    return {
      unregister: async () => {
        const idx = this.rules.findIndex((x) => x.id === r.id);
        if (idx < 0) return;
        this.rules.splice(idx, 1);
        if (k) {
          if (r.needsSpeed) k.disable();
          if (r.needsIdle) k.disable();
          if (r.needsShake) k.disable();
        }
        // If the unregistered rule was active, re-evaluate to find a
        // new match or revert to the compositor default.
        if (this.activeRuleId === r.id) this.evaluate();
      },
    };
  }

  // Returns the count of currently-registered rules (test introspection).
  ruleCount(): number { return this.rules.length; }

  // Per-frame match + install. The compositor (or the frame loop) calls
  // this in its beforeRender hook.
  evaluate(): void {
    if (this.explicitOverride || !this.installer) return;
    const snap = this.kinematics?.snapshot();
    const matchId = snap ? this.firstMatch(snap) : -1;
    if (matchId === this.activeRuleId) return;
    this.activeRuleId = matchId;
    if (matchId === -1) {
      this.installer.installDefault();
      return;
    }
    const rule = this.rules.find((r) => r.id === matchId);
    if (rule) this.applyOutcome(rule);
  }

  // Compute the maximum velocity sample window across all rules that use
  // speedRange. Used by the broker to configure the kinematic ring.
  maxVelocityWindowMs(): number {
    let max = 0;
    for (const r of this.rules) {
      const w = r.spec.when.speedWindowMs ?? 100;
      if (r.needsSpeed && w > max) max = w;
    }
    return max;
  }

  // Drop all rules. Used by the broker on shutdown / test reset.
  clear(): void {
    const k = this.kinematics;
    if (k) {
      for (const r of this.rules) {
        if (r.needsSpeed) k.disable();
        if (r.needsIdle) k.disable();
        if (r.needsShake) k.disable();
      }
    }
    this.rules = [];
    this.activeRuleId = -1;
  }

  // ----- internals -------------------------------------------------------

  private firstMatch(snap: Readonly<KinematicsSnapshot>): number {
    for (const r of this.rules) {
      if (predicateHolds(r.spec.when, snap)) return r.id;
    }
    return -1;
  }

  private applyOutcome(rule: InternalRule): void {
    const inst = this.installer;
    if (!inst) return;
    const enlarge = rule.spec.enlarge ?? 1.0;
    if (rule.spec.shape !== undefined) {
      inst.installShape(rule.spec.shape, enlarge);
      return;
    }
    if (rule.spec.texture !== undefined) {
      const t = rule.spec.texture;
      inst.installTexture(t.handle, t.width, t.height, t.hotspotX, t.hotspotY, enlarge);
      return;
    }
    // Shouldn't reach here: validateSpec rejected this case at registration.
  }
}

function predicateHolds(when: CursorRuleWhen, snap: Readonly<KinematicsSnapshot>): boolean {
  if (when.speedRange) {
    const [lo, hi] = when.speedRange;
    if (snap.speedPxPerSec < lo || snap.speedPxPerSec > hi) return false;
  }
  if (when.idle) {
    if (snap.idleMs < when.idle.afterMs) return false;
  }
  if (when.shake !== undefined) {
    if (snap.shake !== when.shake) return false;
  }
  return true;
}

function validateSpec(spec: CursorRuleSpec): void {
  if (!spec || typeof spec !== "object") {
    throw new Error("cursor rule: spec must be an object");
  }
  const hasShape = spec.shape !== undefined;
  const hasTexture = spec.texture !== undefined;
  if (hasShape === hasTexture) {
    throw new Error("cursor rule: exactly one of shape | texture must be set");
  }
  if (hasShape && typeof spec.shape !== "string") {
    throw new Error("cursor rule: shape must be a string");
  }
  if (!spec.when || typeof spec.when !== "object") {
    throw new Error("cursor rule: when must be an object");
  }
  const w = spec.when;
  if (w.speedRange !== undefined) {
    if (!Array.isArray(w.speedRange) || w.speedRange.length !== 2) {
      throw new Error("cursor rule: when.speedRange must be [lo, hi]");
    }
    const [lo, hi] = w.speedRange;
    if (!Number.isFinite(lo) || !(Number.isFinite(hi) || hi === Infinity) || lo < 0 || hi < lo) {
      throw new Error(`cursor rule: invalid speedRange [${lo}, ${hi}]`);
    }
  }
  if (w.idle !== undefined) {
    if (typeof w.idle.afterMs !== "number" || w.idle.afterMs < 0) {
      throw new Error("cursor rule: when.idle.afterMs must be a non-negative number");
    }
  }
  if (w.shake !== undefined && typeof w.shake !== "boolean") {
    throw new Error("cursor rule: when.shake must be a boolean");
  }
  if (spec.enlarge !== undefined &&
      (typeof spec.enlarge !== "number" || spec.enlarge <= 0)) {
    throw new Error("cursor rule: enlarge must be a positive number");
  }
}
