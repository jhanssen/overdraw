// Canonical types for the user-facing hotkey config consumed by the
// bundled `@overdraw/plugin-hotkey-default`. The user's config file
// supplies a HotkeyConfig under `overdraw.hotkeys`; the plugin reads it
// at init time, defines any non-default modes, and registers each
// binding via sdk.input.bind.
//
// One binding outcome per BindingSpec: exactly one of `action`,
// `pushMode`, or `popMode` is set. The plugin validates this at init
// (throws TypeError on a malformed binding; that surfaces as a fatal
// startup error via the in-thread bundled-plugin transport).
//
// Type-only package; the runtime plugin lives in
// @overdraw/plugin-hotkey-default.

// One step in a chord: a human-readable key spec parsed by core's
// key-spec parser. Accepts modifiers + a keysym name.
// Examples: "Mod+1", "Ctrl+Shift+Return", "h", "Escape".
export type KeySpec = string;

// A chord is one or more steps. Use a single string for a single-step
// binding ("Mod+1") or an array for multi-step ("Mod+a, Mod+b" is also
// accepted as a single string with comma- or space-separated steps).
export type Chord = KeySpec | KeySpec[];

// One binding entry. Exactly one of `action`, `pushMode`, `popMode`
// must be set; the plugin throws if more or fewer outcomes are present.
export interface BindingSpec {
  // The chord that triggers this binding.
  keys: Chord;

  // Outcome 1: invoke an action. `params` is passed verbatim as the
  // action handler's second argument. Action names are matched against
  // the action registry; an unknown action logs but doesn't fail the
  // binding (the bind itself succeeded; only the invoke at match time
  // surfaces the error).
  action?: string;
  params?: unknown;

  // Outcome 2: push a named mode onto the seat's mode stack.
  pushMode?: string;

  // Outcome 3: pop the current mode. The literal `true` is required;
  // any other value is a config error.
  popMode?: true;
}

// A mode is a named binding set. The "default" mode is always present.
// Sub-modes are defined by appearing as keys in `modes` (any name other
// than "default"). Each gets an implicit Escape-to-pop binding unless
// `exitOnEscape: false` is set.
export interface ModeSpec {
  bindings: BindingSpec[];
  // Defaults to true for non-default modes. The default mode never
  // exits on Escape (there's no mode beneath it to pop to); the
  // bundled hotkey plugin ignores this field for "default".
  exitOnEscape?: boolean;
}

// The top-level config object. `modes` is keyed by mode name; "default"
// is required (the root binding set). Other entries become sub-modes.
//
// Shorthand: instead of `modes: { default: { bindings: [...] } }`, the
// user can pass `default: [...]` directly -- the plugin normalizes a
// BindingSpec[] value into `{ bindings: [...] }`.
export interface KeyboardConfig {
  modes: {
    default: BindingSpec[] | ModeSpec;
    [name: string]: BindingSpec[] | ModeSpec;
  };
}
