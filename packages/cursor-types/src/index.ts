// Type contract for the cursor namespace (cursor-design.md). Used by core's
// cursor broker + rule engine, and by any plugin that wants to type-check
// cursor rule registrations directly.

// Cursor rule predicate. All conditions are AND'd; the rule matches only
// when every present condition holds. At least one condition is required
// or the rule matches on every frame (which is supported but useless).
export interface CursorRuleWhen {
  // Speed in pixels per second (smoothed by the kinematic state machine).
  // Inclusive on both ends; use Infinity for an open upper bound.
  speedRange?: [number, number];
  // Velocity-sample window in ms; the rule engine takes the max across
  // all rules and configures the state machine accordingly. Default 100ms.
  speedWindowMs?: number;
  // Match when the cursor has been idle (no motion) for at least afterMs
  // milliseconds.
  idle?: { afterMs: number };
  // Match when the kinematic state's shake flag is in this state.
  shake?: boolean;
  // Reserved for future versions: direction quadrant, acceleration range,
  // per-surface region matching.
}

// Outcome of a rule match: a named shape (resolved by the theme resolver)
// or arbitrary plugin-supplied texture. Exactly one of `shape` | `texture`
// must be set. `enlarge` scales the rendered size; default 1.0.
export interface CursorRuleOutcome {
  shape?: string;
  // Plugin-supplied texture (in-thread plugins only; Worker plugins throw
  // a "not yet implemented" error).
  texture?: CursorTexture;
  enlarge?: number;
}

export interface CursorTexture {
  // Branding via the implementation; in-thread the type is GPUTexture.
  // Loosely typed here so the type package has no GPU dependency.
  readonly handle: unknown;
  readonly width: number;
  readonly height: number;
  readonly hotspotX: number;
  readonly hotspotY: number;
}

export interface CursorRuleSpec extends CursorRuleOutcome {
  when: CursorRuleWhen;
}

// Plugin-facing API. setShape/setImage/hide/show/setDefault are direct
// commands; defineRule is the declarative path.
export interface CursorAPI {
  setShape(name: string): Promise<void>;
  setImage(texture: CursorTexture): Promise<void>;
  hide(): Promise<void>;
  show(): Promise<void>;
  clearOverride(): Promise<void>;
  setDefault(shape: string | null): Promise<void>;
  defineRule(spec: CursorRuleSpec): Promise<CursorRuleHandle>;
}

export interface CursorRuleHandle {
  unregister(): Promise<void>;
}
