// The canonical plugin-facing SDK shape.
//
// A plugin's init(sdk) receives core's PluginSdk, but importing that type
// would couple the plugin to core's internal type packaging. Instead the
// plugin depends on this package: structural (duck-typed) slices of the SDK,
// one per capability, plus PluginSdkShape composing them. Core asserts at
// compile time that its real SDK satisfies each slice (see the
// _*SatisfiesPublished exports in core's plugins/sdk.ts), so the two cannot
// drift silently while the dependency direction stays one-way:
// plugin -> plugin-sdk-types, never plugin -> core.
//
// The slices are the STABLE subset plugin authors program against; core's
// concrete types may carry more (extra methods, richer event payloads).
// Additions here must keep core structurally assignable.

import type { FocusReason } from "@overdraw/focus-types";
import type { CursorAPI } from "@overdraw/cursor-types";
import type { InterceptAPI } from "@overdraw/intercept-types";

// ---- actions ---------------------------------------------------------------

export interface ActionRegisterSpec {
  name: string;
  description?: string;
  handler: (params: unknown) => unknown | Promise<unknown>;
}

export interface ActionRegistration {
  unregister(): void;
}

export interface PluginActionsLike {
  register(spec: ActionRegisterSpec): ActionRegistration;
  invoke(name: string, params?: unknown): Promise<unknown>;
}

// ---- events ----------------------------------------------------------------

export interface EventSubscription {
  off(): void;
}

export interface PluginEventsLike {
  emit(name: string, payload: unknown): void;
  subscribe(pattern: string, cb: (name: string, payload: unknown) => void): EventSubscription;
  // Await-capable participation: the emitter awaits the handler (and adopts
  // a non-undefined return as the new payload) before proceeding.
  intercept(
    pattern: string,
    cb: (name: string, payload: unknown) => unknown | Promise<unknown>,
  ): EventSubscription;
}

// ---- windows ---------------------------------------------------------------

export interface WindowSnapshotLike {
  surfaceId: number;
  // null = unplaced (no layout pass has assigned an output yet).
  outputId: number | null;
  // The window's outer rect in global logical (world) coordinates.
  outer?: { x: number; y: number; width: number; height: number };
  // Structural state the WM tracks per window. Optional so minimal test
  // harnesses can fake snapshots; the core always provides it.
  windowState?: {
    tiling: string;
    exclusive: string;
    visible: boolean;
    [k: string]: unknown;
  };
  state: { [key: string]: unknown };
}

export interface InsetsLike {
  top: number; right: number; bottom: number; left: number;
}

// What the WM accepted for a setInsets request (after clamping), plus the
// current outer rect and the derived content rect.
export interface InsetGrantLike {
  insets: InsetsLike;
  outerRect: { x: number; y: number; width: number; height: number };
  contentRect: { x: number; y: number; width: number; height: number };
}

// Perimeter clip applied at composite. null = sharp rectangle.
export type SurfaceShapeLike =
  | null
  | { kind: "rounded-rect"; radius: number }
  | { kind: "rounded-rect-per-corner";
      tl: number; tr: number; br: number; bl: number }
  | { kind: "superellipse"; exponent: number; radius: number };

export interface PluginWindowsLike {
  setState(id: number, key: string, value: unknown): Promise<void>;
  getState(id: number, key: string): Promise<unknown>;
  deleteState(id: number, key: string): Promise<void>;
  setOutputStack(outputId: number, ids: number[] | null): Promise<void>;
  setOutputCamera(outputId: number, x: number, y: number, zoom?: number): Promise<void>;
  getOutputCamera(outputId: number): Promise<{ x: number; y: number; zoom: number }>;
  beginCameraPan(outputId: number): Promise<boolean>;
  endCameraPan(outputId: number): Promise<{ x: number; y: number; zoom: number }>;
  setIslands(islands: ReadonlyArray<{
    id: number;
    contextOutputId: number;
    rect: { x: number; y: number; width: number; height: number } | null;
    members: ReadonlyArray<number>;
    // Per-island layout hint, passed through to the layout provider
    // (layout-types documents the recognized shapes).
    layout?: { [k: string]: unknown };
  }> | null): Promise<void>;
  requestFocusDecision(reason: FocusReason, trigger?: number): Promise<void>;
  list(): Promise<WindowSnapshotLike[]>;
  get(id: number): Promise<WindowSnapshotLike | null>;
  // Behavioral-state proposal (tiling, exclusive, visible, ...); runs the
  // window.proposed interceptor chain and returns the committed state.
  // Reason defaults to 'plugin'; pass 'user-input' when acting on a
  // user gesture.
  propose(id: number, proposal: { [k: string]: unknown },
          reason?: string): Promise<unknown>;
  onMap(cb: (ev: { surfaceId: number; outputId: number }) => void): void;
  onUnmap(cb: (ev: { surfaceId: number }) => void): void;
  // Reserve a band around the window's content (decoration providers).
  setInsets(id: number, insets: InsetsLike): Promise<InsetGrantLike | null>;
  setShape(id: number, shape: SurfaceShapeLike): Promise<void>;
}

// ---- gpu ---------------------------------------------------------------------

export interface PluginGpuLike {
  device: GPUDevice;
}

// ---- input (keyboard binding chain) ----------------------------------------

export interface InputBindOptions {
  keys: string | readonly string[];
  mode?: string;
  handler: (event: unknown) => void | Promise<void>;
  release?: (event: unknown) => void | Promise<void>;
  priority?: number;
}

export interface PluginInputLike {
  bind(opts: InputBindOptions): Promise<{ unregister(): void }>;
  defineMode(name: string, opts?: { exitOnEscape?: boolean }): Promise<{ undefine(): void }>;
  pushMode(name: string): Promise<void>;
  popMode(): Promise<void>;
}

// ---- compose / transitions ---------------------------------------------------

export interface SceneHandleLike {
  texture: unknown;
  outW: number;
  outH: number;
  id: number;
  release(): Promise<void>;
}

export interface PluginComposeLike {
  scene(args: {
    outputId: number;
    windows: readonly number[];
    mode: "snapshot" | "live";
    outW?: number;
    outH?: number;
  }): Promise<SceneHandleLike>;
}

export interface PluginTransitionsLike {
  run(opts: {
    outputId: number;
    kind: string;
    duration: number;
    easing?: unknown;
    from: SceneHandleLike;
    to: SceneHandleLike;
    commit?: { setOutputStack?: ReadonlyArray<{ outputId: number; ids: readonly number[] | null }> };
  }): Promise<void>;
}

// ---- animations ---------------------------------------------------------------

// Structural view of sdk.animations (core-plugin-api.md §9). Specs and
// targets are typed loosely here; @overdraw/animation-types carries the
// canonical AnimationSpec / TargetRef shapes for plugins that want them.
export interface PluginAnimationsLike {
  run(spec: unknown): Promise<void>;
  cancel(target: unknown): Promise<void>;
}

// ---- the composed SDK shape --------------------------------------------------

// What init(sdk) can rely on. Required fields are always provided by the
// runtime; optional fields are capability-by-shape (absent when the runtime
// didn't bring the backing machinery up -- probe with `sdk.compose?` etc.).
//
// registerPlugin is published with an unconstrained type parameter so plugin
// API interfaces need no index signature; core's implementation (constrained
// to RegisteredApi) accepts every call this signature admits, but the
// generic variance puts it outside the core-side assignability assertion.
export interface PluginSdkShape {
  readonly name: string;
  log(...args: unknown[]): void;
  registerPlugin<A>(name: string, init: () => Promise<A> | A,
                    opts?: { priority?: number }): Promise<{ unregister(): void }>;
  actions: PluginActionsLike;
  events: PluginEventsLike;
  windows: PluginWindowsLike;
  input: PluginInputLike;
  cursor?: CursorAPI;
  compose?: PluginComposeLike;
  transitions?: PluginTransitionsLike;
  animations?: PluginAnimationsLike;
  gpu?: PluginGpuLike;
  intercept?: InterceptAPI;
}
