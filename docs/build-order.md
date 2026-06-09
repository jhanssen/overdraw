# overdraw — build order

Phased work plan for landing the core plugin API + the first round of
plugins on top of it. The API surface and the decisions behind it live in
`core-plugin-api.md`; this document is the implementation sequencing
derived from it.

Read order: `customization.md` (the model) → `core-plugin-api.md` (the API
surface + decisions) → this file (the build sequence). Ground truth for
what is actually built today is in `status.md`.

## Status

Phases 0a, 0b, 0c, 0d, 0e, 1, 2, 3, 4 are landed (see `git log` and
`status.md`). Phase 4.5 (event interception) is next. The text below
describes each phase in its original forward-looking shape; ✅ marks
the completed ones inline.

## Principle

Build the load-bearing primitives early so everything else can layer on
top. Do extractions of existing-in-core code before greenfield where the
extraction validates the API shape; do greenfield only once the primitives
are real.

Each phase lists estimated lines, whether it involves GPU work, and what
the phase validates about the plugin API.

## Pre-conditions (not part of this plan, but real blockers)

Items already listed in `status.md` "Not yet built" that gate parts of
this plan:

- **`wl_output` reconfiguration + host-window resize**
  (`status.md` lines 24–34). Multi-output workspaces, output observation,
  and per-output anything depend on this. Currently `wl_output` is
  fabricated.
- **Display-driven frame clock** (`status.md` lines 39–45). Animation
  correctness degrades with a non-vsync-locked timer. Not blocking but
  real.
- **`xdg_toplevel` state requests not no-ops** (`status.md` lines 14–21).
  For maximize/fullscreen/minimize hints to drive behavior, the server-
  side state changes must happen and the layout plugin must observe the
  hints. Surfaces in Phase 2 (layout extraction) — at minimum the bundled
  layout plugin needs to react to `wantsFullscreen` somehow.

These don't have to come first, but they limit the user-visible payoff of
later phases until resolved.

## Phase 0 — Foundation primitives ✅

Pre-requisite to everything else. No user-visible behavior change.

### 0a. Event bus generalization ✅

- Extend `packages/core/src/events/bus.ts` to support plugin-side `emit`
  and pattern subscription (`'workspace.*'`, `'*'`).
- Extend `CompositorEventMap` to cover the full set named in
  `core-plugin-api.md` §3 (window.closing, output.*, frame.tick,
  hint-state events).
- ~200 lines.

### 0b. Plugin namespace registry ✅

- New: `sdk.registerPlugin(name, init)` / `sdk.plugin(name)` with priority-
  chain arbitration per `core-plugin-api.md` §10.
- Failure promotion: active plugin permanently fails → promote next-lower
  registration.
- Document the shared interface package convention (no code yet — just
  the convention and core's `overdraw` `.d.ts` shape with the empty
  augmentable interfaces).
- ~150 lines.

### 0c. Action registry ✅

- New: `sdk.actions.register` / `invoke` / `list` per `core-plugin-api.md`
  §9.
- Name collisions error.
- ~100 lines.

### 0d. Per-window state bag + hint-state setters ✅

- New: `sdk.windows.setState` / `getState` (untyped runtime; structured-
  clone validated at the bundled/external boundary).
- Hint-state setters (`setFloating` / `setFullscreen` / `setMaximized` /
  `setMinimized`) — store as opaque state, emit `window.change` with the
  field.
- ~150 lines.

### 0e. `setOutputStack` ✅

- New: per-output stack ordering primitive replacing the current global
  `setStack` in `packages/core/src/wm/index.ts` /
  `packages/core/src/gpu/compositor.ts`.
- The compositor filters its stack per output based on this.
- ~100 lines of new code + compositor changes.

**Total estimate**: ~700 lines, no GPU work, pure-unit testable.

**What this validates**: the event bus, action registry, and namespace
registry are the substrate for everything else. Getting them right at
this stage is cheap; retrofitting later would touch every plugin.

## Phase 1 — IPC and `overdrawctl` ✅

Layers cleanly on the Phase 0 action registry + event bus.

### 1a. JSON-RPC 2.0 server ✅

- Listen on `$XDG_RUNTIME_DIR/overdraw-<display>.sock` (700).
- JSON-RPC 2.0 framing.
- `invoke`, `list-actions`, `subscribe`, `unsubscribe` methods.
- Server-pushed events via JSON-RPC notifications with method `"event"`,
  per the convention in `core-plugin-api.md` §11.
- ~300 lines.

### 1b. `overdrawctl` binary ✅

- Thin CLI wrapper mapping CLI invocations to JSON-RPC.
- ~200 lines.

**Total estimate**: ~500 lines, no GPU work.

**What this validates**: the action registry shape under a real consumer
(the CLI), and the IPC interop story is testable end-to-end early. Every
subsequent feature gets a CLI surface for free.

## Phase 2 — Layout extraction ✅

The first exercise of the plugin namespace registry, on an extraction
seam that already existed in code (previously `src/wm/placement.ts`).

### 2a. Layout driver in core ✅

- `packages/core/src/wm/layout-driver.ts` invokes the active 'layout'
  plugin via the runtime's namespace dispatch; `packages/core/src/wm/
  index.ts` schedules through the driver.
- Coalesces in-flight `compute` per output (one at a time;
  most-recent reason wins on coalesce).
- Apply path: result rects flow back to the WM, which updates records,
  pushes `setSurfaceLayout` to the compositor, and fires configure on
  size change.

### 2b. Bundled layout plugin ✅

- `packages/plugin-layout-default/` (npm name
  `@overdraw/plugin-layout-default`). The bundled default for the
  'layout' namespace; implements master-stack tiling. Package name
  follows the "by role" convention -- the name says it's the bundled
  default; the algorithm (master-stack) is an internal implementation
  detail.
- Contains the existing master-stack algorithm.
- Registers via `sdk.registerPlugin('layout', ...)` at priority 0 (the
  bundled-plugin floor).
- Listed in `packages/core/src/plugins/bundled.ts`, loaded on boot.

### 2c. Shared interface package ✅

- `packages/layout-types/` (npm name `@overdraw/layout-types`) defining
  `LayoutAPI`, `LayoutInputs`, `LayoutResult`, `LayoutWindow`,
  `LayoutReason`.
- Type-only.

**Total estimate**: ~280 lines, mostly relocation.

**What this validates**: the namespace registry, the shared interface
package convention, and the "extraction without behavior change" path.
Existing `compositing.gpu.mjs` and tile-verification tests must still
pass — the master-stack behavior is unchanged.

## Phase 3 — Focus extraction + bundled-plugin substrate ✅

Bigger than the original plan: in addition to extracting focus, Phase 3
adds two pieces of runtime substrate that bundled plugins (Phase 2's
layout and this phase's focus) both need going forward — the in-thread
bundled-plugin transport and the per-bundled-plugin config channel. The
layout plugin from Phase 2 is migrated onto the new transport as part
of this phase.

The design changed during planning: the original "parameterized mode"
pattern for focus (`getMode()` returning a closed string set) is
rejected in favor of pure fire-and-forget `decide()`. See
`core-plugin-api.md` §14 and §"Cross-cutting patterns" / Pattern A vs.
Pattern B. Reason: focus is policy and core should not know the named
modes; the optimization Pattern A bought (zero IPC for the common case)
doesn't justify special-casing policy when fire-and-forget keeps the
hot path bounded anyway.

### 3a. In-thread bundled plugin transport

Bundled plugins are core's own code, trusted at the same level. The
Worker isolation (postMessage, structured clone, watchdog, restart
machinery) costs more than it buys for them.

- New: in-thread bootstrap path in the runtime. Selected by
  `ResolvedPlugin.bundled === true`; user plugins continue through the
  Worker path unchanged.
- The in-thread plugin's `init` runs on the main event loop; the SDK is
  the same shape (every call returns a Promise) but the transport is
  direct call + microtask hop. `invokeNamespace` for an in-thread
  target calls the registered method directly.
- Failure handling per `core-plugin-api.md` "Decided" list: init-time
  exceptions are fatal startup errors; per-call exceptions are caught,
  logged, treated as null/empty result; the plugin stays registered.
- No watchdog ping/pong, no `resourceLimits`, no terminate-on-fault for
  in-thread plugins. Sharing the main loop means liveness is co-extensive
  with core.
- ~100–150 lines in the runtime (parallel to `bootstrap.ts` /
  `runtime.ts`'s Worker path).

### 3b. Per-bundled-plugin config channel

- Plugin `init` signature becomes `init(sdk, config?: unknown)`. Core
  passes the user-config value for the plugin's namespace verbatim;
  the plugin owns validation.
- Same shape applies to user-installed plugins (config from
  `ResolvedPlugin.raw`); the plugin author writes one init signature.
- Invalid config throws from init; in-thread bundled plugins treat
  that as a fatal startup error per (3a) (user-facing diagnostic
  surfacing is TBD per the open item in `core-plugin-api.md`).
- ~30–50 lines: config plumbing from `loadConfig` → `bundledToResolved`
  → bootstrap.

### 3c. Migrate `@overdraw/plugin-layout-default` to in-thread

- Same registration, same algorithm. Only the runtime transport
  changes. The Worker-mode tests for layout are deleted (their behavior
  is exercised end-to-end by `test/plugin-layout-default/integration.
  test.js`); the in-thread tests assert direct-call semantics.
- ~20 lines of change in the plugin (mostly tsconfig / dependency
  cleanup).

### 3d. Shared interface package: `@overdraw/focus-types`

- `FocusAPI = { decide(inputs): Promise<FocusResult> }`. No `getMode`,
  no `'custom'`.
- `FocusInputs.reason` enumerates coarse events:
  `'pointer-button' | 'pointer-enter' | 'pointer-leave' |
  'window-mapped' | 'window-unmapped' | 'window-raised' |
  'workspace-changed' | 'explicit'`.
- `FocusResult.keyboardFocus?: SurfaceId | null | undefined`
  (`undefined` = leave focus alone, the common case).
- ~50 lines type-only.

### 3e. Bundled focus plugin: `@overdraw/plugin-focus-default`

- In-thread bundled plugin, priority 0, namespace `'focus'`.
- Implements `decide()` with the follow-pointer and click-to-focus
  state machines internally. The `focusOnMap` behavior (today a core
  config field that auto-focuses freshly mapped windows) becomes a
  plugin behavior: the plugin observes `pointer-enter` / `pointer-leave`
  / `pointer-button` / `window-mapped` and returns the appropriate
  `keyboardFocus`.
- Config (verbatim from user's `config.focus`):
  `{ policy: 'follow-pointer' | 'click-to-focus', focusOnMap: boolean }`.
  Defaults: `policy: 'follow-pointer'`, `focusOnMap: true`. Validates
  at init.
- ~150 lines (includes the two state machines that used to live in
  `wl_seat.ts`).

### 3f. Core focus driver rewrite

- In `packages/core/src/protocols/wl_seat.ts`: remove all `focus.policy
  === ...` branches. At each focus-relevant coarse event,
  fire-and-forget `runtime.invokeNamespace('focus', 'decide', [inputs])`
  with a per-request sequence number; apply the result via the existing
  `setKbFocus()` path. Discard stale results.
- `sdk.windows.focus(id)` (§1 of `core-plugin-api.md`) — add this so
  the bundled focus plugin can apply its decisions back into core
  (without it the plugin can't actually change focus). ~30 lines in
  the windows broker.
- Remove `FocusOptions.policy` and `focusOnMap` from core config; the
  user's `focus` config field is now consumed by the bundled focus
  plugin's config (no backward compatibility — no existing users).
- ~120 lines of change in core (mostly subtractive in `wl_seat.ts`;
  the new dispatch + sequencing logic is ~40 lines).

### 3g. Tests

- Pure-unit (the two state machines tested in isolation against
  synthetic event sequences).
- Pure-unit for the in-thread bootstrap (a fake bundled plugin
  registers a namespace; an external caller invokes it; assert
  direct-call semantics + no Worker spawned).
- The existing `integration.gpu.mjs` focus tests (follow-pointer,
  click-to-focus, focus-on-map) must still pass against the extracted
  plugin — these are the regression contract.

**Total estimate**: ~500 lines (vs. ~170 in the original plan).
Roughly: 130 substrate (3a + 3b), 20 layout migration (3c), 50 types
(3d), 150 focus plugin (3e), 120 core changes (3f), tests on top.

**What this validates**: the fire-and-forget hot-path pattern (Pattern
B in `core-plugin-api.md`); the in-thread bundled-plugin transport
that the priority-chain floor is supposed to provide near-free; the
config channel that future bundled plugins (and any user plugin
needing config) will use.

## Phase 4 — Animation evaluator ✅

First phase that touches GPU/compositor. Brings per-surface state
primitives + the declarative animation engine online.

### 4a. Per-surface state primitives

- Add `setOpacity` / `setMask` / `setTransform` / `setOutputMargin` to the
  compositor's shader uniforms in `packages/core/src/gpu/compositor.ts`.
- Independent of animation — these are useful for any plugin styling.
- ~200 lines of compositor change + WGSL.

### 4b. Animation evaluator

- In-core animation list; per-frame evaluation in the render loop.
- v1 minimal: `tween` and `spring`. (Per `core-plugin-api.md` Decided list.)
- Spring physics: semi-implicit Euler with rest-velocity threshold;
  borrow a known-good integrator.
- ~400 lines.

### 4c. `overdraw-sdk-anim` library

- Plugin-side spec builder: `animate`, `spring`, `sequence`, `parallel`,
  `target.*` helpers.
- ~200 lines.

**Total estimate**: ~800 lines, GPU work.

**What this validates**: per-frame evaluation in core, spec serialization
across the bundled/external boundary, spring physics correctness. New
GPU tests in `test/animations.gpu.mjs`: animate opacity with pixel readback
at midpoint; spring overshoot + settle; cancel-on-new-animation
replacement semantics.

## Phase 4.5 — Event interception

Generalize the bus from observe-only into observe-or-modify. Lifecycle
events become interceptable: a plugin can modify the payload core uses,
or defer core's downstream action while it prepares state. The first
real consumer is animated relayout (a plugin pre-snaps each window's
transform on `window.relayout` so the entry/move animation has no
visible jump), but the mechanism is general -- any event is
interceptable, including plugin-emitted events.

See `core-plugin-api.md` §3.1 for the full design. Summary:

- `sdk.events.emit<T>(name, payload, opts?)` returns
  `Promise<T>`; resolves to the final post-modification payload.
- `sdk.events.intercept<T>(pattern, handler, opts?)` registers an
  interceptor that returns `T | Promise<T> | void`. Returning a value
  modifies the payload; returning nothing observes; returning a Promise
  defers core's downstream action until it settles.
- Hot path is unchanged when no interceptors are registered: observers
  fan out synchronously, Promise resolves with the original payload.
- Per-event timeout policy: a slow / hung interceptor is skipped after
  the timeout; chain continues with the prior payload.

### 4.5a. Bus mechanism

- Extend `packages/core/src/events/dynamic-bus.ts` with `intercept`
  registration + an `emit` variant that runs the interceptor chain in
  priority order, awaiting each handler's result, then fans out to
  observers with the final payload. Hot path (no interceptors) stays
  synchronous.
- Backward-compatible: today's `emit(name, payload): void` becomes
  `emit(name, payload): Promise<T>` whose Promise is already-resolved
  when no interceptors exist (an `emit` not followed by `await` is
  fire-and-forget at the same cost as today).
- Sync-only emit sites (frame timer, synchronous input handlers) use
  a new `emitSync` variant that runs observers only -- interceptors
  on those events still register but their return values are not
  honored. The bus logs a warning at first intercept of a sync-only
  name.
- ~150 lines.

### 4.5b. First interceptable event: `window.relayout`

- Emit `window.relayout` from `applyLayout` in the WM
  (`packages/core/src/wm/index.ts`), BEFORE pushing the new outer
  rect to the compositor + before firing `xdg_toplevel.configure`.
  Payload: `{ surfaceId, oldOuter, newOuter }`.
- Use the new `emit` (awaitable). Per-event default timeout 100ms.
- The plugin's interceptor runs while `applyLayout` is paused; the
  interceptor can call `sdk.windows.setTransform(surfaceId,
  oldToNewTransform)` to pre-snap the surface. After interceptors
  resolve, `applyLayout` pushes the new rect; the next compositor
  frame draws the surface with the pre-snap transform in effect.
- ~40 lines for the emit-site wiring + the new event type.

### 4.5c. Worker-plugin interception path

- Worker plugins register interceptors the same way as in-thread
  bundled plugins. The transport already supports request-response
  semantics via `endpoint.handleRequests`; intercept handlers ride
  the same machinery, just with a different request method
  (`events.intercept-handle`).
- Per-Worker postMessage round-trip per intercepted emit. Bounded by
  the per-event timeout (a Worker that exceeds it is skipped).
- ~80 lines of wiring.

### 4.5d. Tests

- Pure-unit: bus mechanism (intercept registration; chain runs in
  priority order; modification chaining; observer sees post-mod
  payload; timeout; throwing interceptor skipped; sync-only emit
  rejects intercept).
- Pure-unit: `window.relayout` emitted with correct payload from
  `applyLayout`; interceptor can modify; without interceptor the
  emit is fire-and-forget cost.
- GPU integration: a bundled plugin intercepts `window.relayout`,
  pre-snaps a window's transform from old rect to new rect on map;
  pixel readback during the animation midpoint shows the window at
  an intermediate position (not the final layout rect).

**Total estimate**: ~270 lines + the animated-relayout demo plugin
(~120 lines, lands as a bundled plugin or separate example).

**What this validates**: the bus's intercept primitive end-to-end,
the await-on-decision model for lifecycle events generalized beyond
`window.closing` (which Phase 9 reuses), and the relayout animation
case that's been the design driver. Subsequent phases (workspace
transitions, hotkey-driven layout switches, window-closing animations)
all reuse the same mechanism.

## Phase 5 — Scene compose

The other GPU primitive. Enables workspace transitions, overview modes,
screen recording, thumbnails.

### 5a. `compose.windows` / `compose.scene`

- Render-to-texture path in the compositor accepting explicit window list
  + output context.
- Three modes: `'snapshot'`, `'live'`, `'live-on-damage'`.
- Texture lifecycle: refcounted handles; `release()` semantics.
- ~400 lines.

### 5b. Cross-device for external plugins

- Compose textures imported as dmabuf on the plugin's device.
- Reuses existing intercept/overlay machinery
  (`status.md` §"Cross-device dmabuf + fence").
- ~150 lines, mostly wiring.

**Total estimate**: ~550 lines, GPU-heavy.

**What this validates**: the most novel core mechanism. New GPU tests in
`test/compose.gpu.mjs`: snapshot returns expected pixels; live mode
updates on client commit; live-on-damage doesn't re-render static content
(count render passes).

## Phase 6 — Workspaces (first greenfield plugin, instant transitions)

The first big user-visible plugin built on the foundation.

### 6a. Shared interface package

- `@overdraw/workspace-types` with `WorkspaceAPI`, `WorkspaceId`, etc.

### 6b. Bundled workspace plugin

- Dynamic workspaces (per the Decided model).
- Per-output assignment.
- `show(ws, output)`: atomically updates `setOutputStack`. **No
  transition** in v1 — animated transitions land in Phase 8.
- Actions: `workspace.create`, `workspace.show`, `workspace.move-window`,
  `workspace.destroy`, etc. (registered via `sdk.actions.register`).
- Events: `workspace.shown`, `workspace.created`, etc. (emitted via
  `sdk.events.emit`).
- ~400 lines + types.

**Total estimate**: ~500 lines plugin + types. No new core work.

**What this validates**: first real greenfield plugin; `setOutputStack`
as the workspace projection onto core; the full action + event + state-bag
loop. GPU integration test: switch workspaces; verify only the new
workspace's windows composite.

## Phase 7 — Hotkeys

Brings keyboard control online. First validation that actions +
`sdk.input.bind` compose into a real user feature.

### 7a. `sdk.input.bind` in core

- Add key-binding chain: priority-ordered plugin handlers before client
  delivery.
- Consume vs. forward semantics per `core-plugin-api.md` §4.
- ~150 lines.

### 7b. Bundled hotkey plugin

- Parses user config's hotkey table.
- Registers `sdk.input.bind` per binding.
- Handler invokes `sdk.actions.invoke(actionName, params)`.
- ~150 lines.

**Total estimate**: ~300 lines.

**What this validates**: input chain + action invocation. GPU integration
test: launch with config hotkey for `workspace.show`, send key, verify
workspace switch occurs via state query.

## Phase 8 — Transitions primitive

Built-in named transitions consuming scene snapshots. Closes the gap
between scene compose and workspace-animation-without-takeover.

### 8a. `sdk.transitions.run`

- Takes `from: SceneHandle`, `to: SceneHandle`, `kind` (crossfade /
  slide-N / scale), `duration`, `easing`.
- Core-side shader implementations of the named transitions.
- Resolves the promise when the transition completes; releases the scenes.
- ~300 lines + shader code.

### 8b. Workspace plugin updated

- `show()` uses `transitions.run` instead of instant swap.
- ~50 lines change.

**Total estimate**: ~350 lines.

**What this validates**: scene compose + animation interplay. GPU test:
two scenes with distinct colors; crossfade midpoint has blended pixels.
The API surface for `sdk.transitions.run` is `core-plugin-api.md` §8.

## Phase 9 — Cursor + window-closing

### 9a. `window.closing` event + last-buffer snapshot

- Snapshot the last buffer at unmap.
- Await closing subscribers with 500ms timeout.
- Emit `window.unmap` only after closing subscribers have resolved /
  timed out.
- ~200 lines.

### 9b. Velocity in pointer events

- Smoothed velocity computation in core (EMA over last ~50ms).
- Include in `PointerEvent` payload.
- ~50 lines.

### 9c. `sdk.cursor` primitive

- `setShape` (XCursor theme), `setImage(texture, hotspot)`, `hide`,
  `show`.
- Compositing of the cursor as a special overlay.
- ~150 lines.

**Total estimate**: ~400 lines.

**What this validates**: phantom-window lifetime via the
await-on-decision pattern; cursor customization end-to-end.

## Phase 10 — Remaining greenfield (per demand)

Demand-driven; ordering doesn't matter much:

- **Window rules** plugin (consumes events, sets state). ~200 lines.
- **Notifications** (emitter + renderer plugins). ~300 lines.
- **Animation library expansions**: `stagger`, `decay`, `keyframes` as
  use cases demand them. ~100–200 lines each.
- **Layer-shell consumers** (status bars, wallpapers). Pre-condition:
  `wlr-layer-shell-unstable-v1` server-side implementation in core
  (separate work, not part of this plan).
- **Multi-output workspace transitions**. Pre-condition: `wl_output`
  reconfiguration.

## Critical path summary

| Phase | Estimate (lines) | GPU | Validates |
|---|---|---|---|
| 0. Foundation | 700 | no | bus, registry, actions, state, setOutputStack |
| 1. IPC + overdrawctl | 500 | no | action registry under a real consumer |
| 2. Layout extraction | 280 | minimal | namespace registry; shared types convention |
| 3. Focus extraction + bundled-plugin substrate | 500 | no | in-thread bundled transport, config channel, fire-and-forget hot path |
| 4. Animation evaluator | 800 | yes | per-frame eval, spec serialization, springs |
| 4.5. Event interception | 270 | minimal | bus modify/defer; `window.relayout`; await-on-decision generalized |
| 5. Scene compose | 550 | yes | the load-bearing pixel primitive |
| 6. Workspaces (instant) | 500 | no | first real greenfield plugin |
| 7. Hotkeys | 300 | no | input.bind + actions composition |
| 8. Transitions | 350 | yes | compose + animations interplay |
| 9. Cursor + closing | 400 | yes | velocity, snapshot lifecycle |
| 10. Remaining greenfield | per demand | varies | — |

**Phases 0–3** (foundation + extractions): no user-visible change, but
the plugin model is exercised end-to-end on existing functionality. ~1650
lines.

**Phases 4–4.5** (animation + interception): GPU primitives + bus
generalization. ~1070 lines.

**Phase 5** (scene compose): the load-bearing pixel primitive. ~550 lines.

**Phases 6–8** (workspaces + hotkeys + transitions): first new user-
visible feature set. ~1150 lines.

**Phases 9–10**: polish + remaining greenfield.

Total to "a real compositor with workspaces and animated transitions"
(Phases 0–8): **~4420 lines** of core + plugin code. Comparable to the
existing `src/` size (~6000 lines incl. tests).

## What this plan does not promise

- These estimates are rough. Spring physics, the JSON-RPC framing, and
  the compose dmabuf wiring each have unknowns that could change the
  shape of the work.
- The plan assumes the seven decisions in `core-plugin-api.md` hold. If
  any are revisited (especially "scene compose" or "animation library
  in-house"), the affected phases reshape.
- Pre-conditions (`wl_output` reconfiguration, frame clock, xdg_toplevel
  state) are real and may need to be interleaved. The plan doesn't
  schedule them; it assumes they land alongside the work as needed.
- "Lines of code" is a poor proxy for time. GPU work (Phases 4, 5, 8, 9)
  is typically more time per line than pure-CPU code (0, 1, 2, 3, 6, 7).
