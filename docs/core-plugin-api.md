# overdraw — core plugin API

The core APIs needed so that everything-not-mechanism can live as a plugin.
Builds on `customization.md` (which sets the model) and supersedes parts of it
where the model has been refined. Nothing here is implemented yet; for what is
actually built, see `status.md`.

## Premise

`customization.md` commits to "core ships mechanisms, plugins ship policy" and
"every plugin-facing API is async." This document is the concrete consequence:
the smallest core API surface that supports the plugin model — what
*specifically* core must expose for layout, focus, workspaces, animations,
hotkeys, IPC, and the rest to live in plugin land.

The exercise revealed that core's surface is smaller than `customization.md`
suggests. Several categories the doc treats as core-territory or as distinct
plugin SDK namespaces collapse into a few load-bearing primitives:

- An event bus (subscribe by pattern, emit from anywhere).
- An action registry (named operations registered by plugins, invoked by
  hotkeys / IPC / other plugins).
- A plugin namespace registry (a plugin claims a name, exposes a typed API,
  other plugins consume it).
- Per-surface state primitives (already in `customization.md`).
- A scene-compose primitive (render arbitrary window subsets to textures).
- An animation evaluator (declarative animation specs interpreted in core).

Most of the doc's named SDK namespaces (`sdk.workspaces`, `sdk.cursor`, etc.)
become plugin-defined, not core-defined.

## Working principle

Core knows about *windows*, *outputs*, *surfaces*, *inputs*, *frames*, and the
primitives needed to compose them. Core does not know what a workspace is, what
a hotkey is, what a layout policy is, what a notification is. Plugins introduce
those concepts and core remains oblivious.

The line between "core primitive" and "plugin concept" is drawn at the render
path: anything the compositor must read every frame to draw is a core
primitive; anything else is plugin state.

## Cross-cutting patterns

Three patterns appear in every category. Naming them once so we don't relitigate
in each section.

### Exclusive vs. multiplex roles

Some plugin slots admit exactly one active plugin at a time (layout policy,
focus policy). Others admit many in parallel (intercepts, observers,
action handlers). Per `customization.md`:

- **Exclusive**: highest-priority registration wins; lower-priority dormant.
  Failure of the active plugin promotes the next.
- **Multiplex**: all matching plugins run; ordering by priority where order
  matters (input chain, intercept chain).

The exclusive-role arbitration logic is the same regardless of which role.
Core provides one mechanism (the plugin-namespace registry) that all exclusive
roles use; categories don't reimplement it.

### Hot path: fire-and-forget, not parameterize-and-bypass

The async-everywhere model breaks down on per-frame or per-pointer-event
decisions: a chain of plugins each round-tripping per pointer-move
saturates the IPC channel and ties tail latency to plugin Worker
liveness. Two patterns address this; they look similar but address
different problems.

**Pattern A — Closed vocabulary for core machinery (§6, §8, §9).** Where
the *behavior* is core's job and the plugin is choosing *which* of
several core-provided implementations to use, the API exposes a closed
string set:

- `sdk.compose.scene({mode: 'snapshot' | 'live' | 'live-on-damage'})` —
  freshness contract for core's render-cache scheduling.
- `sdk.transitions.run({kind: 'crossfade' | 'slide-N' | 'scale'})` —
  core's built-in shaders.
- `AnimationSpec` types (`'tween' | 'spring' | ...`) — core's
  animation evaluator's instruction set.

Plugins extend beyond these via the documented escape hatch: `sdk.output.
takeover` for compose/transitions; `sdk.frame.onTick` + manual state
writes for animations. There is no `'custom'` mode inside the closed
set; the escape hatch is the explicitly-different shape.

**Pattern B — Fire-and-forget for policy (§14).** Where the *decision*
is policy and doesn't belong in core, core calls into the plugin
asynchronously and does NOT await before returning from the hot-path
handler. The plugin's result applies on the next tick via core SDK
calls (`sdk.windows.focus`, `sdk.windows.setOutputStack`, etc.).
Sequencing by request id discards stale results. The hot path stays
synchronous and bounded.

This pattern requires:
- The decision being decoupled from the event whose handler triggers it
  (e.g. pointer-motion can drop a stale focus-change without breaking
  Wayland pointer routing — pointer events always follow the pointer
  regardless of keyboard focus).
- Coarse-event granularity (not literally per pointer-move; per
  pointer-cross-surface, per button-press, per map/unmap). Plugins
  observe the coarse event, not the underlying high-rate stream.

**Avoid Pattern A for policy.** An earlier design used Pattern A for
focus, with `getMode()` returning `'follow-pointer' | 'click-to-focus' |
'custom'`. This conflated the two patterns: the named modes were
implementations of policy that the plugin merely selected, requiring
core to know the modes. The fire-and-forget approach (Pattern B) keeps
focus policy out of core entirely.

### Policy plugin pushes state into core

Where a plugin owns a concept (workspaces, window-rules, etc.), it pushes the
*projection* of that concept onto the render path into core via core
primitives. The plugin's internal model is private; core sees only the
projection.

Workspace example: the workspace plugin maintains a rich workspace registry
internally. Core sees only `setOutputStack(outputId, windowIds[])` — which
windows are visible on which output, in what order. The plugin updates this
when the workspace changes. Core doesn't know what a workspace is.

This avoids "core asks plugin synchronously on the render path" (which would
break the async-everywhere rule) without ceding render-path correctness.

## What core provides

Fourteen API areas. Each is a load-bearing primitive; together they support
everything else.

### 1. Window primitives

Core owns the window list, lifecycle, surface tree, and the per-surface state
the compositor reads each frame.

```ts
sdk.windows.list(): Promise<Window[]>
sdk.windows.get(id): Promise<Window | null>

// State setters (per-surface; applied by compositor shader every frame)
sdk.windows.setOpacity(id, alpha): Promise<void>
sdk.windows.setMask(id, texture | null): Promise<void>
sdk.windows.setTransform(id, { translate, scale, rotate? }): Promise<void>
sdk.windows.setOutputMargin(id, { top, right, bottom, left }): Promise<void>

// State requests originating from clients (xdg_toplevel) or other plugins
// — stored as opaque per-window state; layout/policy plugins read these as hints
sdk.windows.setFloating(id, boolean): Promise<void>
sdk.windows.setFullscreen(id, boolean): Promise<void>
sdk.windows.setMaximized(id, boolean): Promise<void>
sdk.windows.setMinimized(id, boolean): Promise<void>

// Stack & ordering — per output
sdk.windows.setOutputStack(outputId, windowIds[]): Promise<void>
sdk.windows.raise(id): Promise<void>
sdk.windows.lower(id): Promise<void>

// Focus
sdk.windows.focus(id): Promise<void>            // explicit override

// Geometry, set by layout-driver
sdk.windows.setGeometry(id, { x, y, w, h }): Promise<void>

// Phantom-window lifetime is NOT an explicit API. It's implicit in the
// `window.closing` event being await-on-decision — subscribers that want the
// surface kept alive for a close animation `await` their work in the handler.
// See "Phantom-window lifetime" under Decisions.

// Freeform per-window state bag (for plugin-defined concepts: workspaceId, rule tags, etc.)
sdk.windows.setState(id, key: string, value: unknown): Promise<void>
sdk.windows.getState(id, key: string): Promise<unknown>
```

`Window` shape: ids, role (toplevel | layer-shell), client-derived metadata
(app_id, title), current geometry, current per-surface state, hint state
(floating/fullscreen/etc.), and the arbitrary state bag. Plugin-defined
concepts (workspaceId, ruleTags, etc.) live in the state bag — they are
not first-class fields on `Window`.

Per-surface state is **global per surface**, not per-output-per-surface. The
scene-compose primitive (below) handles transitions where you'd want
per-output variation, so per-output per-surface state isn't required.

### 2. Output primitives

Core owns output state (size, scale, position, mode).

```ts
sdk.output.list(): Promise<Output[]>
sdk.output.get(id): Promise<Output | null>
```

Output configuration (mode-set, position, scale) is set via user config and
core; plugins observe, don't set, in v1. Future: plugin-driven policy
("auto-rotate when portrait") via an action that calls back into core.

### 3. Event bus

A pattern-subscribable, plugin-emittable event bus. The primary observation
mechanism; replaces ad-hoc per-category observe APIs.

```ts
sdk.events.emit(name: string, payload: unknown): void
sdk.events.subscribe(pattern: string, cb: (name, payload) => void): { unsubscribe }
```

Pattern is exact (`window.map`) or glob (`workspace.*`, `*`).

Core emits a stable set of events:

- `window.map`, `window.unmap`, `window.change`, `window.closing`. The
  `window.change` payload covers core-tracked state only (title, app_id,
  focused, floating/fullscreen/maximized/minimized, geometry). Plugin
  concepts like workspace membership are not in this payload — plugins
  observe their own state-bag changes via separate events they emit.
- `output.added`, `output.removed`, `output.changed`
- `pointer.focus`, `keyboard.focus`
- `frame.tick` (per output)

`window.closing` is *await-on-decision*: subscribers may async-await; core
awaits all with a 500ms bounded timeout before processing the unmap. See
the "Phantom-window lifetime" decision.

Plugins emit whatever they want under their own namespace. The event bus is
also the substrate for IPC subscriptions (below).

Typed wrappers (e.g. `sdk.windows.onChange(cb)`) can layer on top for
ergonomics, but the bus is the primitive.

### 4. Input primitives

```ts
// Fire-and-forget observation (high-rate events)
sdk.input.observe({ onKey?, onPointer?, onPointerMove? }): { unobserve }

// Await-on-decision binding (key events; can consume)
sdk.input.bind({
  binding?: { key, modifiers[] },
  match?: (event: KeyEvent) => boolean,
  priority?: number,
  handler: (event: KeyEvent) => Promise<boolean | void>,  // true = consume
}): { unbind }
```

`PointerEvent` carries `position`, `velocity` (smoothed by core),
`button`/`buttonState`, `modifiers`, `timestamp`, `focused`. `KeyEvent` carries
`type`, `keysym` (xkbcommon-named), `keycode`, `modifiers`, `timestamp`,
`focused`.

Velocity is core-computed (smoothed over a short window). For raw unsmoothed
velocity, observers compute their own from position deltas.

The input chain: plugin handlers (priority order) → focused client. A handler
returning `true` consumes the event; the client doesn't see it.

### 5. Frame ticks

```ts
sdk.frame.onTick(outputId | null, cb: (frame: FrameInfo) => void): { off }
```

`outputId: null` ticks per global frame. Used by animation plugins, plugins
needing per-frame compute outside the takeover path.

`FrameInfo`: `{ time, frameNumber, deltaMs }`.

### 6. Scene compose

The load-bearing primitive for "do something pixel-level with windows."

```ts
sdk.compose.windows({
  outputId,
  windows: ReadonlyArray<{ id: SurfaceId, rect?: { x, y, w, h } }>,
  mode: 'snapshot' | 'live' | 'live-on-damage',
}): Promise<WindowComposition>

sdk.compose.scene({
  outputId,
  windows: ReadonlyArray<SurfaceId>,
  mode: 'snapshot' | 'live' | 'live-on-damage',
}): Promise<SceneHandle>

type WindowComposition = {
  windows: ReadonlyArray<{ id, texture: GPUTexture, rect }>;
  release(): Promise<void>;
};
type SceneHandle = { texture: GPUTexture; release(): Promise<void>; };
```

`compose.windows` returns one texture per window (each with its intercept
chain applied and per-surface state baked in). `compose.scene` returns the
composed result as a single texture (built on the same primitive).

Modes:

- `'snapshot'`: one-shot render, texture never updates. Cheap; for short
  transitions where one frame's snapshot is enough.
- `'live'`: core re-renders every frame regardless of source state.
  Texture content updates on every frame. For ongoing thumbnails / overview
  mode where the content is part of an animation.
- `'live-on-damage'`: core re-renders only when source windows commit
  damage. Texture content updates on real changes. For screen recording /
  long-lived thumbnails / anywhere you want freshness without paying for
  re-rendering static content.

Capture use cases (screenshots, recording, thumbnails) are served by this
primitive. No separate `sdk.capture` namespace. Per-frame delivery, if a
plugin wants a callback per frame, is built on top via `sdk.frame.onTick`
reading the live texture in the callback.

### 7. Output takeover

Plugin replaces what gets presented to an output. Shape per
`customization.md` §"Output takeover"; this doc tracks it for completeness.

```ts
sdk.output.takeover(outputId, {
  inputMode: 'route' | 'passthrough',
  setup: async (device) => ({ render, onInput?, destroy }),
}): Promise<{ release(): Promise<void> }>
```

Combined with `compose.windows`, this is how custom animations, transitions,
overview modes, screen-locks etc. are built. Plugin owns per-frame render
during takeover.

### 8. Transitions

A transition blends two composed scenes over time. Distinct from
animations (§9, which target per-window state values) because the
interpolation target is "which pixels go on screen," not a numeric value.

Closed set of built-in shaders; custom transitions use compose + takeover
(§7).

```ts
sdk.transitions.run(outputId, {
  kind: 'crossfade' | 'slide-left' | 'slide-right' | 'slide-up'
      | 'slide-down' | 'scale',
  from: SceneHandle,
  to: SceneHandle,
  duration: number,           // ms
  easing?: EasingSpec,        // same set as animations
}): Promise<void>             // resolves when the transition completes
```

While a transition runs on an output, the output's normal compositing is
replaced by the transition's render. When `run` resolves, the plugin is
responsible for having already pushed the post-transition state (e.g. the
workspace plugin sets the new `setOutputStack` *before* awaiting `run`),
so normal compositing picks up correctly when the transition ends.

`from` and `to` are `SceneHandle`s produced by `sdk.compose.scene` in
`'snapshot'` mode (typical for short transitions where the snapshot is
fresh) or `'live'` mode (rarer, but lets in-flight client updates show
through). The transition does not extend their lifetime — the caller
releases them after `run` resolves.

Per-output. A workspace plugin animating a switch on multiple outputs
runs one `transitions.run` per output, in parallel.

**Anything more elaborate than the built-in set** (physics-based,
custom shaders, per-window choreography in `compose.windows` results, or
anything stateful per-frame) uses `sdk.output.takeover` with a per-frame
render callback. Built-ins are the easy path; takeover is the full-power
path.

### 9. Animations

Declarative animation specs evaluated in core. Plugin-side library
(`overdraw-sdk-anim`) produces specs; core evaluates per frame.

```ts
sdk.animations.run(spec: AnimationSpec): Promise<void>
sdk.animations.cancel(handle): Promise<void>

type AnimationSpec =
  | { type: 'tween',    target: TargetRef, from?, to, duration, easing }
  | { type: 'spring',   target: TargetRef, from?, to, stiffness, damping, mass }
  | { type: 'decay',    target: TargetRef, initialVelocity, ... }
  | { type: 'keyframes', target: TargetRef, frames, times?, easing? }
  | { type: 'sequence', items: AnimationSpec[] }
  | { type: 'parallel', items: AnimationSpec[] }
  | { type: 'stagger',  items: AnimationSpec[], delay: number };

type TargetRef =
  | { kind: 'window-opacity', windowId }
  | { kind: 'window-transform', windowId }
  | { kind: 'window-output-margin', windowId };
```

Targets are limited to core-owned per-surface state. Animating
plugin-owned values (e.g. an intercept plugin's shader uniform) is not
supported by core's evaluator. Pattern for those: the plugin animates a
per-surface state value via core's evaluator, then reads it back in its
shader/intercept logic. Or it runs its own per-frame loop with
`sdk.frame.onTick` and writes its own state directly.

The library-side API mirrors Motion One (or similar) for author
familiarity. The library provides convenience builders for `TargetRef`
values and the `animate` / `spring` / `sequence` / `parallel` builders for
`AnimationSpec`:

```ts
import { animate, spring, sequence, target } from 'overdraw-sdk-anim';

animate(
  target.windowOpacity(windowId),
  { from: 1, to: 0 },
  spring({ stiffness: 200, damping: 20 })
);
```

`animate(...)` builds an `AnimationSpec` and calls `sdk.animations.run(spec)`.
The `target.*` helpers build `TargetRef` values. No per-frame IPC; the
plugin's only call to core is the one `animations.run` per animation.

Core's evaluator: ~500–1000 lines. Tween/keyframes are trivial; spring physics
is the meatiest (borrow a known-good integrator, don't roll fresh).

User-function easings (`ease: (t) => f(t)`) are not supported — not
serializable. Cubic-bezier with arbitrary control points covers most cases;
truly exotic curves require takeover.

### 10. Actions

Named operations, registered by plugins, invokable from hotkeys / IPC / other
plugins.

```ts
sdk.actions.register({
  name: string,                          // namespaced: 'workspace.show'
  description?: string,
  schema?: ParamSchema,                  // JSON Schema for IPC validation + help
  handler: (params) => Promise<unknown>,
}): { unregister }

sdk.actions.invoke(name: string, params?: unknown): Promise<unknown>
sdk.actions.list(): Promise<ActionInfo[]>
```

Name collisions are errors (the second `register` of the same name fails).
Actions are the primary mechanism by which non-trivial plugin functionality is
made invokable from hotkeys, config, IPC, and other plugins.

### 11. Plugin namespace registry

```ts
sdk.registerPlugin<API>(name: string, init: () => Promise<API>): { unregister }
sdk.plugin<API>(name: string): Promise<API>     // resolves when ready; rejects if missing
```

A plugin claims a namespace (`'workspace'`), exposes a typed API (defined in
its own `.d.ts`), and other plugins consume it. Core knows nothing about the
API surface; it routes calls.

For exclusive-role plugins (layout, focus, workspace, etc.), the namespace
registry + priority is the arbitration mechanism: the highest-priority
registration under a name wins; lower-priority registrations are queried
only on failure (the priority-chain failure-recovery pattern from the doc).

For multiplex roles (intercepts, observers, decoration-by-match,
action-handlers-by-match), the registry holds all registrations and the
consuming machinery iterates them (in priority order where order matters,
unordered where it doesn't). The same primitive serves both; what differs
is how callers consume the registry.

Inter-plugin types are unenforced at runtime (the `.d.ts` is a build-time
contract). Plugins validate inputs they receive from other plugins; same as
any RPC system.

### 12. IPC

Built into core. A Unix socket at `$XDG_RUNTIME_DIR/overdraw-<display>.sock`
(700 permissions) speaking **JSON-RPC 2.0** strict.

Methods:

```
invoke       params: { action: string, args?: unknown }   -> action result
list-actions params: none                                 -> ActionInfo[]
subscribe    params: { pattern: string }                  -> { subscription: string }
unsubscribe  params: { subscription: string }             -> null
```

Server-pushed events (JSON-RPC 2.0 doesn't spec these — they're a
documented convention on top). Server sends id-less notifications:

```
method: "event"
params: { subscription: string, name: string, payload: unknown }
```

A subscriber registers a pattern; the server pushes matching events from
the bus as `"event"` notifications carrying the subscription id, the
event name, and the payload. Unsubscribe to stop the flow.

Backed by the action registry and event bus directly — no IPC plugin
required. `overdrawctl` is a thin client tool that ships with overdraw and
maps CLI invocations to JSON-RPC.

Authentication: filesystem permissions on the socket. No token / further
auth in v1.

### 13. Layout driver

A core-side hook that calls out to an exclusive-role layout plugin. The plugin
registered in the `'layout'` namespace (with highest priority) decides tile
positions.

```ts
// What the layout plugin implements (via sdk.registerPlugin('layout', ...))
type LayoutAPI = {
  compute(inputs: LayoutInputs): Promise<LayoutResult>;
};

type LayoutInputs = {
  output: { id, rect, scale };
  windows: ReadonlyArray<LayoutWindow>;       // pre-filtered by visibility
  reason: 'mapped' | 'unmapped' | 'output-resized' | 'focus-changed'
        | 'reorder' | 'param-changed';
};

type LayoutWindow = {
  id, appId?, title?, role,
  hints: { minSize?, maxSize?, wantsFullscreen?, wantsMaximized?, floating? },
  currentRect?,
};

type LayoutResult = { rects: Array<{ id, outer: { x, y, w, h } }> };
```

Core's responsibilities:
- Maintain the window list, output rect, current visible window set per output
  (the latter pushed by the workspace plugin via `setOutputStack`).
- Invoke `compute` on the right events (map/unmap/output-resize/etc.).
- Apply the result: `setGeometry` per window, `xdg_toplevel.configure` per
  affected window, configure→ack→commit settle.

The bundled master-stack layout is a `sdk.registerPlugin('layout', ...)`
registration at priority 0 — extracted from core to
`packages/plugin-layout-master-stack/` as of Phase 2. The seam in core is
`packages/core/src/wm/layout-driver.ts`, which invokes the active
'layout' plugin via the namespace registry.

### 14. Focus driver

Same shape as layout: an exclusive-role plugin in the `'focus'` namespace
decides keyboard focus on coarse events. Unlike layout, no named modes
are baked into core — the plugin owns the policy end-to-end. Core fires
a `decide()` call per focus-relevant coarse event and applies the
returned focus target.

```ts
type FocusAPI = {
  decide(inputs: FocusInputs): Promise<FocusResult>;
};

type FocusInputs = {
  // What triggered this decision. Coarse events only (human-input rate or
  // slower); pointer-motion does NOT trigger decide (pointer events always
  // follow the pointer per Wayland semantics; only KEYBOARD focus is the
  // plugin's call, and a follow-pointer plugin reacts to pointer-enter /
  // pointer-leave, not per-motion).
  reason: 'pointer-button' | 'pointer-enter' | 'pointer-leave'
        | 'window-mapped' | 'window-unmapped'
        | 'window-raised' | 'workspace-changed' | 'explicit';
  pointer: { x: number; y: number; surfaceUnderPointer: SurfaceId | null };
  currentKeyboardFocus: SurfaceId | null;
  trigger?: SurfaceId;        // e.g. the mapped/raised/clicked window
  // The plugin may consult sdk.windows.list() for full window state; the
  // small payload here is what changed since the last decide.
};

type FocusResult = {
  // The new keyboard focus target, or null to clear focus, or undefined
  // to leave focus unchanged. (undefined is the common case: most events
  // do not trigger a focus change under a click-to-focus policy.)
  keyboardFocus?: SurfaceId | null;
};
```

**Hot-path note.** The core call-site is fire-and-forget: `handleInput`
dispatches `decide()` and continues; it does NOT await the result. The
Promise's resolution applies the focus change on the next tick via
`sdk.windows.focus(id)` (§1). Sequencing is by request id — a decision
arriving after a newer request was already dispatched is discarded
(stale results don't apply). This keeps the input path synchronous and
bounded regardless of plugin latency.

**Why no `'mode'` parameter.** An earlier design surfaced
`getMode()` returning a closed string set (`'follow-pointer' |
'click-to-focus' | 'custom'`) so core could implement the two named
modes inline. That conflated two different things — core machinery
(compose modes, transition kinds, animation specs — see §6, §8, §9) where
the closed vocabulary IS the API, and policy (focus) where the closed
vocabulary was an optimization for the common case. The optimization
introduced a special case in core for behavior that genuinely doesn't
belong to core. The fire-and-forget `decide()` pattern keeps the runtime
contract uniform and removes core's knowledge of focus modes entirely.
The bundled focus plugin implements follow-pointer / click-to-focus
internally; a `'custom'` mode is no longer a distinct concept because
every focus plugin is by definition custom.

## Typing model

The runtime API is permissive (string-keyed state, string-keyed events,
string-keyed actions, `unknown` payloads). TypeScript types are layered on
via **module augmentation**.

Core (`overdraw`) ships its `.d.ts` with empty, augmentable interfaces:

```ts
declare module 'overdraw' {
  interface WindowStateMap {}      // plugins augment with their state-bag keys
  interface EventMap {}            // plugins augment with their event names
  interface ActionMap {}           // plugins augment with their action names + params/result
  interface PluginNamespaceMap {}  // plugins augment with their registerPlugin name -> API
}
```

The core SDK signatures use these maps to type their string-keyed APIs:

```ts
declare module 'overdraw' {
  export interface SDK {
    windows: {
      setState<K extends keyof WindowStateMap>(
        id: SurfaceId, key: K, value: WindowStateMap[K]
      ): Promise<void>;
      getState<K extends keyof WindowStateMap>(
        id: SurfaceId, key: K
      ): Promise<WindowStateMap[K] | undefined>;
      // ...
    };
    events: {
      subscribe<K extends keyof EventMap>(
        pattern: K, cb: (name: K, payload: EventMap[K]) => void
      ): { unsubscribe(): void };
      emit<K extends keyof EventMap>(name: K, payload: EventMap[K]): void;
    };
    actions: {
      register<K extends keyof ActionMap>(spec: {
        name: K;
        handler: (p: ActionMap[K]['params']) => Promise<ActionMap[K]['result']>;
      }): { unregister(): void };
      invoke<K extends keyof ActionMap>(
        name: K, params: ActionMap[K]['params']
      ): Promise<ActionMap[K]['result']>;
    };
    plugin<K extends keyof PluginNamespaceMap>(name: K): Promise<PluginNamespaceMap[K]>;
    registerPlugin<K extends keyof PluginNamespaceMap>(
      name: K, init: () => Promise<PluginNamespaceMap[K]>
    ): { unregister(): void };
  }
}
```

Each plugin's `.d.ts` augments these interfaces:

```ts
// overdraw-plugin-workspace/types.d.ts
declare module 'overdraw' {
  interface PluginNamespaceMap {
    workspace: WorkspaceAPI;
  }
  interface WindowStateMap {
    'workspace.id': WorkspaceId;
  }
  interface EventMap {
    'workspace.shown':  { workspaceId: WorkspaceId; outputId: OutputId };
    'workspace.hidden': { workspaceId: WorkspaceId; outputId: OutputId };
    // ...
  }
  interface ActionMap {
    'workspace.show': { params: { id: WorkspaceId; outputId: OutputId }; result: void };
    // ...
  }

  export type WorkspaceId = number & { __brand: 'WorkspaceId' };
  export interface WorkspaceAPI {
    create(spec?: { name?: string }): Promise<WorkspaceId>;
    destroy(id: WorkspaceId): Promise<void>;
    show(id: WorkspaceId, outputId: OutputId): Promise<void>;
    // ...
  }
}
```

The plugin's `package.json` has `"types": "./types.d.ts"`. The user's
config (or another plugin) `import workspacePlugin from 'overdraw-plugin-
workspace'`; TypeScript picks up the augmentation transitively. The user's
`sdk.windows.getState(id, 'workspace.id')` is typed as `WorkspaceId`.

For plugins that want to consume another plugin's state but don't import
its runtime module, the side-effect import brings the augmentation in:

```ts
import 'overdraw-plugin-workspace';   // for the type augmentation only

const wsId = await sdk.windows.getState(id, 'workspace.id');  // typed: WorkspaceId
```

**No central type registry, no install hook, no special tsconfig.** The npm
ecosystem (package `"types"` field + module augmentation flowing through
imports) does what's needed. Plugin authors writing `.d.ts` files use a
boilerplate snippet from the plugin-author docs.

Runtime remains untyped (any string key, any value). Module augmentation is
a build-time contract; the runtime trusts the plugin to write keys it owns
and read keys with the agreed type.

### Namespace = API contract

The core rule: **a namespace name IS the API contract.** Two plugins
claiming `'workspace'` are asserting they implement the same canonical
`WorkspaceAPI`. If their APIs actually differ, they don't share the
namespace — they claim distinct names.

This dissolves the "competing implementations" problem. Either:

- Two plugins genuinely implement the same contract → same namespace,
  same shared interface, swappable. The user picks which to install based
  on behavior; consumers see the same type. No conflict.
- They don't → different namespaces (`'workspace'` vs.
  `'workspace-i3style'`, or any distinguishing name). No type merging
  between them; consumers explicitly target whichever they need.

There's no in-between. The "subset/superset" case (one plugin adds extra
methods) means a different contract → a different namespace.

**Shared interface packages.** For namespaces that may have multiple
implementations (workspace, layout, focus, decoration), core publishes a
type-only package defining the canonical interface:
`@overdraw/workspace-types`, `@overdraw/layout-types`,
`@overdraw/focus-types`, `@overdraw/decoration-types`. Plugins implementing
the namespace augment by *reference* to the shared type, not by inlining
their own shape:

```ts
// any plugin implementing workspace
declare module 'overdraw' {
  interface PluginNamespaceMap {
    workspace: import('@overdraw/workspace-types').WorkspaceAPI;
  }
}
```

Multiple plugins augmenting with the same referenced type produce identical
declarations; TypeScript merges them with no conflict.

A plugin author who inlines a different shape under an existing namespace
hits a compile error — the desired outcome, because they're either making
a real mistake (should use the canonical type) or implementing a different
contract (should use a different namespace).

**Versioning.** Adding methods to a canonical API is a versioning event.
The shared interface package follows semver:

- **Patch / minor** (additive only): a new optional method, or a new
  optional property on a payload. Implementing plugins SHOULD support it but
  may omit during their own upgrade window. Consumers checking
  `if (typeof ws.newMethod === 'function')` work across versions.
- **Major** (breaking): a removed method, changed signature, or required
  new method. The interface package's major version bumps. Implementing
  plugins must update to match; the user's package manager surfaces the
  mismatch.

Practical recommendation: keep canonical interfaces minimal; prefer adding
methods to non-canonical extension namespaces (`'workspace-extras'`) over
breaking the canonical one. Same discipline as any cross-implementation
interface (POSIX, OpenGL, Wayland protocols).

**Explicit type override at call sites.** When a consumer wants to be
explicit about which type contract it expects (e.g. depending on a
specific plugin's extended API in a non-canonical namespace), it passes
the type:

```ts
import type { I3StyleWorkspaceAPI } from 'overdraw-plugin-workspace-i3style';
const ws = await sdk.plugin<I3StyleWorkspaceAPI>('workspace-i3style');
```

This is the normal case for non-canonical namespaces; consumers know which
specific plugin they're targeting and use its types directly.

## Summary of new core internals

Beyond the SDK surface above, core gains these internal mechanisms:

- **Action registry**: name → handler + schema + owning plugin.
- **Event bus** (extending `packages/core/src/events/bus.ts`): pattern
  subscription, plugin emission, IPC routing.
- **Plugin namespace registry**: name → list of registrations with priorities;
  exclusive-role arbitration; failure-promotion.
- **Animation evaluator**: in-flight animation list, per-frame evaluation,
  spring integrator.
- **Scene composer**: render arbitrary window subsets into textures (single
  or per-window).
- **Transition shaders + driver**: built-in scene-blend shaders
  (crossfade / slide-N / scale); per-output transition lifecycle.
- **IPC server**: socket + JSON-RPC + dispatch to action registry / event bus.
- **`overdrawctl`** binary.
- **Velocity computation** for pointer events.

## Migration map (what currently in core moves where)

Cross-reference of current implementation (per `status.md`) against the
target.

### Stays in core (already correct)
- Wayland protocol handling, trampoline, generator (`native/wayland/`,
  `packages/core/src/protocols-gen/`).
- Frame loop, present, fence machinery (`native/core/`, `gpu-process/`).
- Buffer/dmabuf import + fence (`native/core/shm.cpp`, dmabuf path).
- Input event source (`native/core/input.h`, `input_wayland.cpp`).
- `wl_output` (such as it is).
- Window state, lifecycle, surface tree (the `Window`/`Surface` records
  in `packages/core/src/wm/index.ts`).
- Compositing pass (`packages/core/src/gpu/compositor.ts`).
- Plugin runtime + watchdog + restart (`packages/core/src/plugins/runtime.ts`,
  `protocol.ts`, `bootstrap.ts`).

### Already extracted to bundled plugins
- **Master-stack layout policy** → `packages/plugin-layout-master-stack/`,
  registered at priority 0 in namespace `'layout'`. Core seam:
  `packages/core/src/wm/layout-driver.ts`. Type contract:
  `packages/layout-types/`. Phase 2 of `build-order.md`.

### Currently in core, must move to plugin
- **Focus policy** (the `follow-pointer`/`click-to-focus` logic in
  `packages/core/src/protocols/wl_seat.ts`) → bundled focus plugin in
  namespace `'focus'`. The plugin owns the policy end-to-end via
  `decide()` (fire-and-forget per the hot-path pattern in §"Cross-
  cutting patterns"); no named modes in core. Phase 3 of
  `build-order.md`. Note: Phase 3 also introduces the in-thread bundled
  plugin transport (used by both this and the migrated layout plugin)
  and the per-bundled-plugin config channel.

### Decoration broker (in core, stays)
- `packages/core/src/plugins/decoration-broker.ts` is broker machinery
  for an exclusive-multiplex pattern. The namespace registry
  (`packages/core/src/plugins/namespace-registry.ts`) now exists (Phase
  0b), but the decoration broker has not been refactored on top of it —
  it still runs its own arbitration. Open: whether to fold decoration
  arbitration into the namespace registry, or leave the broker as the
  multiplex-with-match pattern (the namespace registry today serves
  exclusive-role plugins; multiplex semantics are not the same shape).
  The specific decoration logic stays in
  `packages/core/src/decorations.ts` on the plugin side.

### Greenfield (build as plugin from day one)
The following are not built; per the model they should be plugins, not core:

- Workspaces.
- Hotkeys / keybinding handler.
- Notifications (emitter + renderer).
- Window rules.
- Cursor customization (the dynamic-cursor case).
- Animation choreography beyond `animations.run`.
- Idle/lock policy.
- Layer-shell consumers (status bars, wallpapers, etc. — once the protocol
  lands).

What core needs to support these is in the API list above; the plugins
themselves are not core's code.

### Required core additions to support the plugins above
- `setOutputStack`, `setState`/`getState`, hint-state setters
  (`setFloating` etc.).
- `window.closing` event (await-on-decision; bounded timeout) and the
  associated last-buffer snapshot machinery for close animations.
- Event bus generalization (emit + pattern subscribe + IPC routing).
- Action registry.
- Plugin namespace registry.
- In-thread bundled plugin transport + per-bundled-plugin config channel
  (Phase 3 of `build-order.md`).
- `sdk.windows.focus(id)` (§1; the focus plugin uses this to apply its
  `decide()` result back into core).
- Animation evaluator + spec format.
- `compose.windows` / `compose.scene`.
- `transitions.run` with built-in shaders (crossfade, slide-N, scale).
- `setShape` / `setImage` cursor primitive; velocity in pointer events.
- IPC server + `overdrawctl`.

## Decisions

### Decided

- **Scene compose mode**: no default; `mode` is required on every `compose`
  call. Snapshot and live have different correctness properties (a snapshot
  goes stale on client updates; live keeps re-rendering). Caller picks.

- **Action namespace collisions**: error on duplicate `register`. Collisions
  are bugs, not policies. The priority-chain is for handlers of *events*,
  not for naming.

- **Easing function set**: bezier + spring + decay + keyframes + the
  composition primitives (sequence/parallel/stagger). User-function easings
  (`(t) => number`) excluded — not serializable across the bundled/external
  boundary. Truly exotic curves use compose + takeover.

- **Decoration in compose results**: part of the window texture (the
  composed result includes any decoration drawn at the window's inset).
  Matches the logical model "decoration is part of the window." If a future
  use case wants to animate decoration separately from content, the API can
  grow a `separateDecorations: true` flag without breaking the default.

- **Layout invocation throttling**: core coalesces. At most one `compute`
  in flight per output at a time; subsequent invalidations replace the
  pending invocation. Implementation detail of the layout driver, not a
  separate API decision.

- **Workspace model**: dynamic. Workspaces are created and destroyed on
  demand, may carry names, may be empty. Subsumes static behavior (a plugin
  can pre-create N workspaces at boot and never destroy them). Tags
  (multi-membership) are a different model with different UX; if anyone
  wants tags, a separate plugin can claim the `'workspace'` namespace with
  that semantics. Core API (`setOutputStack`) is agnostic either way.

- **Phantom-window-lifetime API**: no explicit
  `requestExtendedLifetime` call. Lifetime extension is implicit in the
  `window.closing` event being an *await-on-decision* event. When a client
  destroys its window, core fires `window.closing` and awaits all
  subscribers with a 500ms bounded timeout. Subscribers that want the
  surface kept alive for an animation `await` their animation's completion
  in the handler; subscribers that just want to react (layout, focus,
  observers) return immediately. Core snapshots the client's last buffer
  at close so animations can run even if the client disconnects.
  `window.unmap` fires after all closing subscribers have resolved or the
  timeout elapses; that's the actual moment of surface destruction.
  Multiple subscribers awaiting compose naturally — core waits for the
  longest. No explicit refcount, no per-call `maxDuration` (one system-wide
  timeout).

- **`sdk.capture` dropped**: no `sdk.capture` namespace. The capture use
  cases (screenshots, recording, thumbnails, accessibility magnifier) are
  served by `sdk.compose.windows` / `sdk.compose.scene`. `mode` is
  `'snapshot' | 'live' | 'live-on-damage'`; `'live-on-damage'` re-renders
  only when source windows commit, which covers the common "I want to
  observe every change" case efficiently. Per-frame delivery (if a plugin
  wants a callback per frame) is built on top via `sdk.frame.onTick`
  reading the compose texture.

- **Animation library**: in-house, with the API surface modeled on Motion
  One for author familiarity. The spec/evaluator split (plugin builds spec,
  core evaluates) is fundamental and not how existing libraries are
  architected; adapting one would be a fork we then maintain. Building our
  own — `overdraw-sdk-anim` (~300 lines, spec builder) + core's evaluator
  (~700 lines) — is cheaper than tracking upstream and gives full control
  over the spec format. Spring physics borrows a known-good integrator
  (semi-implicit Euler with standard rest-velocity thresholds); don't
  experiment. **Ship v1 minimal** (`tween`, `spring`, `sequence`,
  `parallel`); add `stagger`, `decay`, `keyframes` as concrete plugin use
  cases demand them.

- **IPC wire protocol**: JSON-RPC 2.0 strict. Well-spec'd, language
  bindings exist in every major language, standardized error codes. Server-
  pushed events (subscriptions) are not part of the spec; we layer a
  documented convention on top: `subscribe` returns a subscription id;
  events arrive as JSON-RPC notifications (id-less messages) with method
  `"event"` and params `{ subscription, name, payload }`. `overdrawctl`
  speaks JSON-RPC 2.0 internally. Third-party tools (status bars, language
  bindings) get a stable, library-supported interop story.

- **Per-window state bag — typed or untyped?**: fully untyped at runtime.
  `setState(id, key: string, value: unknown)` / `getState(id, key:
  string): Promise<unknown>`. Structured-clone-validity is enforced
  naturally at the bundled/external boundary. Types are layered on via
  TypeScript module augmentation — see the "Typing model" section below.
  Convention: namespace your keys under your plugin's name
  (`'workspace.id'`, `'rules.tags'`); ownership is conventional, not
  enforced.

- **No-plugin-loaded fallback**: no hardcoded fallback in core. Bundled
  plugins ARE the floor of the priority chain — they ship with overdraw,
  load on boot at priority 0, and cannot be uninstalled. The user can
  replace one by registering a higher-priority plugin in the same
  namespace; the bundled stays installed and dormant. If the
  higher-priority replacement permanently fails, the chain demotes back to
  the bundled. No separate code path in core for "no plugin loaded" —
  there always is one. If the bundled plugin itself permanently fails,
  that's a release-blocking bug in overdraw, not a runtime concern.
  Consistent with `customization.md` lines 701–711 ("built-in is the
  floor") and 742–753 ("no safe mode").

- **Bundled plugins run in-thread.** Bundled plugins (those in
  `BUNDLED_PLUGINS`) load on the main thread, not in a `worker_threads`
  Worker. Same SDK contract as Worker plugins (every call returns a
  Promise) but the transport is direct call + microtask hop, so calls
  resolve near-free with no `postMessage` / structured-clone cost. User-
  installed (third-party) plugins always run in a Worker, isolated and
  watchdogged.

  Rationale: bundled plugins are core's own code, trusted at the same
  level as core, so the Worker isolation costs (per-call IPC, separate
  GPU device handoff for `sdk.gpu`, restart machinery) buy nothing.
  Putting them in-thread makes "bundled = near-free per call" honest
  and matches the design intent that the priority-chain floor is a
  zero-tax default. Failure handling for in-thread plugins differs:
  init-time exceptions are fatal startup errors (release-blocking bug
  per above); per-call exceptions from registered methods are caught at
  the runtime boundary, logged (and surfaced to the user via a TBD
  user-facing diagnostic stream), and treated as a null/empty result —
  the plugin stays registered.

- **Per-bundled-plugin config**: bundled-plugin `init` takes a second
  argument. The plugin module exports
  `default async function init(sdk, config?: unknown): Promise<void>`;
  the config value is whatever the user's config file sets under the
  plugin's name (e.g. `config.focus` flows into the bundled focus
  plugin; `config.layout` into the bundled layout plugin). Core does
  NOT validate plugin-specific config — it passes the value through
  verbatim. The plugin owns its config schema and validates at init;
  invalid config throws from init and surfaces the error to the user
  (mechanism TBD; for now this manifests as the plugin failing to
  register). The same second-arg shape applies to user-installed
  plugins, populated from their `ResolvedPlugin.raw` entry — so a
  plugin's `init` signature is the same regardless of how it's
  installed.

### Open

- **User-facing exception surfacing.** When an in-thread bundled
  plugin's per-call method throws, or when init throws on a
  config-validation failure, the error today goes to the log. A real
  user-facing diagnostic stream (status-bar notification, IPC event,
  CLI command) is TBD.

(Seven decisions originally resolved; two more above.)

## Doc corrections to `customization.md`

Specific corrections to fold into `customization.md` when this gets built:

- **Line 952 ("IPC command dispatch" as exclusive plugin role)**: wrong.
  IPC transport + JSON-RPC dispatch is in core; only the registered actions
  are plugin-owned. Replace with the architecture described in §12.
- **Lines 414–427 (SDK namespaces list)**: most of `sdk.workspaces`,
  `sdk.cursor`, `sdk.input.bind`, etc. are plugin-defined namespaces, not
  core-defined SDK namespaces. The core surface is smaller; see §1–§14.
- **Line 1018 (cache invalidation generation counters)**: subsumed by the
  event bus + scene-compose's live mode. Plugins doing intercept caching
  use bus event subscription as their invalidation source.
- **Animation absence**: `customization.md` has no animation section. Add
  sections covering §8 (Transitions) and §9 (Animations) of this doc —
  built-in scene transitions plus declarative animation specs evaluated in
  core; in-house library `overdraw-sdk-anim`; animation targets limited to
  core-owned per-surface state; no user-function easings.
- **§"Capture" (lines 309–337)**: dropped. No `sdk.capture` namespace.
  Capture use cases use `sdk.compose.windows` / `sdk.compose.scene` with
  `mode: 'live'` or `'live-on-damage'`. Per-frame delivery via
  `sdk.frame.onTick` reading the live texture.

## Relationship to other docs

- `architecture.md`: load-bearing for process topology, IPC, GPU process,
  trampoline, buffer lifecycles. Unchanged.
- `customization.md`: the design framing. This document is the concrete API
  manifest derived from it. Where they differ in detail, this document is
  newer.
- `status.md`: ground truth for what's actually built. This document is
  forward-looking; consult `status.md` for what exists today.
