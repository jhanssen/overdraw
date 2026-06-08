# overdraw — build order

Phased work plan for landing the core plugin API + the first round of
plugins on top of it. The API surface and the decisions behind it live in
`core-plugin-api.md`; this document is the implementation sequencing
derived from it.

Read order: `customization.md` (the model) → `core-plugin-api.md` (the API
surface + decisions) → this file (the build sequence). Ground truth for
what is actually built today is in `status.md`.

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

## Phase 0 — Foundation primitives

Pre-requisite to everything else. No user-visible behavior change.

### 0a. Event bus generalization

- Extend `src/events/bus.ts` to support plugin-side `emit` and pattern
  subscription (`'workspace.*'`, `'*'`).
- Extend `CompositorEventMap` to cover the full set named in
  `core-plugin-api.md` §3 (window.closing, output.*, frame.tick,
  hint-state events).
- ~200 lines.

### 0b. Plugin namespace registry

- New: `sdk.registerPlugin(name, init)` / `sdk.plugin(name)` with priority-
  chain arbitration per `core-plugin-api.md` §10.
- Failure promotion: active plugin permanently fails → promote next-lower
  registration.
- Document the shared interface package convention (no code yet — just
  the convention and core's `overdraw` `.d.ts` shape with the empty
  augmentable interfaces).
- ~150 lines.

### 0c. Action registry

- New: `sdk.actions.register` / `invoke` / `list` per `core-plugin-api.md`
  §9.
- Name collisions error.
- ~100 lines.

### 0d. Per-window state bag + hint-state setters

- New: `sdk.windows.setState` / `getState` (untyped runtime; structured-
  clone validated at the bundled/external boundary).
- Hint-state setters (`setFloating` / `setFullscreen` / `setMaximized` /
  `setMinimized`) — store as opaque state, emit `window.change` with the
  field.
- ~150 lines.

### 0e. `setOutputStack`

- New: per-output stack ordering primitive replacing the current global
  `setStack` in `src/wm/index.ts` / `src/gpu/compositor.ts`.
- The compositor filters its stack per output based on this.
- ~100 lines of new code + compositor changes.

**Total estimate**: ~700 lines, no GPU work, pure-unit testable.

**What this validates**: the event bus, action registry, and namespace
registry are the substrate for everything else. Getting them right at
this stage is cheap; retrofitting later would touch every plugin.

## Phase 1 — IPC and `overdrawctl`

Layers cleanly on the Phase 0 action registry + event bus.

### 1a. JSON-RPC 2.0 server

- Listen on `$XDG_RUNTIME_DIR/overdraw-<display>.sock` (700).
- JSON-RPC 2.0 framing.
- `invoke`, `list-actions`, `subscribe`, `unsubscribe` methods.
- Server-pushed events via JSON-RPC notifications with method `"event"`,
  per the convention in `core-plugin-api.md` §11.
- ~300 lines.

### 1b. `overdrawctl` binary

- Thin CLI wrapper mapping CLI invocations to JSON-RPC.
- ~200 lines.

**Total estimate**: ~500 lines, no GPU work.

**What this validates**: the action registry shape under a real consumer
(the CLI), and the IPC interop story is testable end-to-end early. Every
subsequent feature gets a CLI surface for free.

## Phase 2 — Layout extraction

The first exercise of the plugin namespace registry, on an extraction
seam that already exists in code (`src/wm/placement.ts`).

### 2a. Layout driver in core

- In `src/wm/index.ts`, replace the direct call to `computeMasterStack`
  with a call to `sdk.plugin('layout').compute(inputs)`.
- Coalesce in-flight `compute` per output (one at a time).
- Apply result via `setGeometry` + configure dispatch.
- ~100 lines of change in core.

### 2b. Bundled layout plugin

- New: `@overdraw/plugin-layout-master-stack` (or similar).
- Contains the existing `computeMasterStack` logic verbatim.
- Registers via `sdk.registerPlugin('layout', ...)` at priority 0.
- Ships with overdraw; loaded on boot.
- ~100 lines (mostly relocation).

### 2c. Shared interface package

- New: `@overdraw/layout-types` defining `LayoutAPI`, `LayoutInputs`,
  `LayoutResult`, `LayoutWindow`.
- Type-only.
- ~80 lines.

**Total estimate**: ~280 lines, mostly relocation.

**What this validates**: the namespace registry, the shared interface
package convention, and the "extraction without behavior change" path.
Existing `compositing.gpu.mjs` and tile-verification tests must still
pass — the master-stack behavior is unchanged.

## Phase 3 — Focus extraction

Same pattern as layout, smaller. Focus modes (`follow-pointer` /
`click-to-focus`) stay inline in core per the parameterized-mode pattern
(see `core-plugin-api.md` §"Cross-cutting patterns").

### 3a. Focus driver

- Consult `sdk.plugin('focus').getMode()` and dispatch:
  - `'follow-pointer'` / `'click-to-focus'`: evaluated in core.
  - `'custom'`: `decide` callback at coarse events.
- ~80 lines of change in core.

### 3b. Bundled focus plugin

- Implements `FocusAPI`. Returns the user's configured mode.
- ~50 lines.

### 3c. Shared interface package

- `@overdraw/focus-types`.
- ~40 lines.

**Total estimate**: ~170 lines.

**What this validates**: the parameterized-mode pattern for hot-path
policy. Existing `integration.gpu.mjs` focus tests must still pass.

## Phase 4 — Animation evaluator

First phase that touches GPU/compositor. Brings per-surface state
primitives + the declarative animation engine online.

### 4a. Per-surface state primitives

- Add `setOpacity` / `setMask` / `setTransform` / `setOutputMargin` to the
  compositor's shader uniforms in `src/gpu/compositor.ts`.
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
| 3. Focus extraction | 170 | no | parameterized-mode pattern |
| 4. Animation evaluator | 800 | yes | per-frame eval, spec serialization, springs |
| 5. Scene compose | 550 | yes | the load-bearing pixel primitive |
| 6. Workspaces (instant) | 500 | no | first real greenfield plugin |
| 7. Hotkeys | 300 | no | input.bind + actions composition |
| 8. Transitions | 350 | yes | compose + animations interplay |
| 9. Cursor + closing | 400 | yes | velocity, snapshot lifecycle |
| 10. Remaining greenfield | per demand | varies | — |

**Phases 0–3** (foundation + extractions): no user-visible change, but
the plugin model is exercised end-to-end on existing functionality. ~1650
lines.

**Phases 4–5** (animation + compose): the GPU primitives. ~1350 lines.

**Phases 6–8** (workspaces + hotkeys + transitions): first new user-
visible feature set. ~1150 lines.

**Phases 9–10**: polish + remaining greenfield.

Total to "a real compositor with workspaces and animated transitions"
(Phases 0–8): **~4150 lines** of core + plugin code. Comparable to the
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
