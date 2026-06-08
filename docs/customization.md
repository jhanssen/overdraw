# overdraw — customization

Design exploration for the visual customization and plugin extension model.
Building on `architecture.md` but supersedes it where they differ; the
canonical decisions will land when this gets built. Nothing here is
implemented yet unless explicitly noted; for what is actually built, see
`status.md`.

## Premise

Two motivations driving the design:

1. **Plugins must not be able to crash the compositor.** This is the
   structural reason for WebGPU + worker isolation as the plugin model.
   Hyprland-style dlopen'd C++ plugins crashing the compositor is the
   failure mode being deliberately avoided.
2. **Visual customization is plugin-authored, not core-authored.** The
   compositor ships a small set of mechanisms; plugins (bundled or
   third-party) supply the policy and the pixels. Third-party plugins are
   distributable (envisioned: npm). Some plugins ship with overdraw and
   are enabled by default.

These two together rule out the "core ships effects, users tune them"
model (Hyprland's posture) and rule in "core ships primitives, plugins
ship effects."

## Core principles

Two load-bearing decisions that shape every other choice in this
document. These take precedence; anything below that conflicts with
them is a mistake in this document.

### 1. Core is small. Everything else is a plugin.

Core owns mechanisms only:

- Wayland protocol handling.
- Buffer / dmabuf import, fence and sync.
- The frame loop, present, scanout.
- Input event source and raw routing primitives.
- Output management (the hardware-coupled part).
- Per-surface state storage and the compositor's shader that applies
  it.
- The compositing pipeline's structure (multi-pass, intercept slots,
  chain orchestration).
- Plugin lifecycle, capability gates, the SDK transport.

**Everything else is a plugin.** Layout, focus policy, decoration,
window appearance, animations, effects, workspaces, hotkeys, IPC
command dispatch, notifications, cursor behavior, session policy. The
default overdraw distribution is core + a curated set of bundled
plugins that together make a usable compositor.

A consequence: the "shipped product" is core plus the bundled plugin
distribution, not core alone. Bundled plugins are mandatory in the
sense that overdraw without them is not a usable system — but they
are still plugins, replaceable through the same mechanism third-party
plugins use.

### 2. Every plugin-facing API is async.

The SDK contract: every call core makes into a plugin returns a
promise; every callback the plugin registers may return a promise;
core awaits them.

This is required for external plugins (their transport is
postMessage), and held uniform for bundled plugins so the same plugin
source runs in either transport without modification. For bundled
plugins the promise resolves on the next microtask — near-free. For
external plugins it resolves after IPC round-trip — real latency
depending on payload size, OS scheduling, CPU contention.

**Consequence**: the *only* observable difference between bundled and
external plugins is latency. The plugin author writes one piece of
code; the SDK transport supplies the right resolution speed. This is
what makes a plugin replaceable across transports, and what keeps the
internal/external split from becoming two ecosystems.

Concrete numbers (Node Worker postMessage round-trip) are not
assumed in this document; they require measurement against real
workloads.

### How these two interact

The "small core, everything-is-a-plugin" decision only works because
the SDK is uniform across bundled and external. If bundled plugins had
a synchronous fast path and external plugins didn't, plugin authors
would write to one or the other, plugin-replaceability would be a
fiction, and the ecosystem would fragment.

Async-everywhere is what lets the SDK be one SDK. The performance cost
of consistency is bounded (one microtask for bundled; one IPC round-
trip for external — at human-input rates and per-frame rendering rates,
both are absorbed by other costs in the pipeline). High-frequency
events (pointer-move, scroll) use fire-and-forget semantics rather
than await-on-decision, capping the IPC budget there.

Everything below in this document elaborates these two principles.
Treat them as the load-bearing constraints; deviations require
explicit justification.

## Two execution paths, one SDK

Plugins run in one of two modes:

- **Bundled.** Shipped with overdraw, loaded in the core's main thread.
  SDK calls dispatch via direct calls / microtasks. Plugin runs on
  core's `wgpu::Device`. No cross-device handoff. No isolation — a
  bundled plugin can crash the compositor (same trust level as core
  code).
- **External.** Loaded from npm or user dir, runs in a worker on its
  own `wgpu::Device`. SDK calls dispatch via postMessage. Full isolation
  — failure is contained to the worker, restart policy applies.

Plugin source code is the **same** for both. The SDK abstracts over the
transport and the device assignment. A plugin moved from bundled to
external (or vice versa) needs no code change.

The user cannot mark an external plugin as trusted/bundled at runtime.
Bundled vs. external is fixed at distribution time. This avoids per-user
trust grants and the failure-attribution ambiguity they create. Two
transports are real complexity, but the trade is intentional: bundled
plugins get the perf of core-device execution; external plugins get the
isolation of separate execution.

**This supersedes `architecture.md` line 405** ("A plugin cannot inject
GPU commands into the core's render pass; it contributes buffers and
policy. Shared-device drawing would forfeit isolation and is out of
scope."). Bundled plugins explicitly run on core's device. The reasoning
in the original architecture still applies to external plugins; the
distinction is that bundled plugins are project-trusted code, not
third-party.

## What stays in core

Core owns mechanisms. Plugins own policy.

- Wayland protocol handling.
- Window state, lifecycle (map/unmap/destroy), surface tree.
- Window management, layout, focus, workspaces.
- Input routing, hit-testing, modifier tracking, keymap.
- Output management, modes, multi-monitor, scanout.
- The frame loop, fence waits on swapchain, present.
- Plugin lifecycle, watchdog, capability gates.
- **Per-surface effect state storage** (opacity, mask, transform,
  output margin) and the compositor's shader that applies them.
- Damage tracking (when implemented).

## Per-surface state primitives

Cheap per-surface state stored in core, applied by core's compositing
shader every frame at near-zero per-frame cost. Plugins set these via
SDK calls; values change on state events (focus, resize, etc.), not per
frame.

- `opacity: number` — scalar alpha multiplier.
- `mask: GPUTexture | null` — alpha mask sampled when drawing the
  surface. Covers rounded corners, custom shapes, arbitrary outlines.
- `transform: { translate, scale, rotate? }` — 2D transform applied
  per frame. Enables fade/slide animations and repositioning during
  move/resize without re-rendering.
- `outputMargin: { top, right, bottom, left }` — declares how far
  beyond the surface's rect anything (intercept output, decoration
  surfaces) may extend. Needed for shadows, glow, etc.

These cover the common decoration and animation cases without forcing
plugins through the intercept chain.

**This extends `architecture.md`** with new core state. The architecture
mentions "Compositor-side surface transforms (v2)" at line 1176;
this concretizes it and adds opacity/mask as peers.

## Buffer interception

Per-pixel intercept: plugin replaces the pixels of matched surfaces.
Used for effects that genuinely need pixel-level transformation (blur,
color grading, distortion, custom rendering). Heavier than the per-
surface state path; plugins should use state primitives when possible
and intercept only when needed.

### Scope: client, not surface

When a plugin's match catches a client, the intercept applies to **all
of that client's content surfaces**: toplevel, subsurfaces, popups, and
layer-shell surfaces. Cursor surfaces are excluded.

Reasoning: per-window-rule semantics match Hyprland/sway user
expectations; popup-overlap artifacts (rounded corners on toplevel
with unrounded popup overlapping the corner) are avoided naturally.

### Per-surface render callback under per-client match

The plugin registers per client; the SDK invokes its render callback
once per matched surface per frame the surface updates. The plugin sees
each surface independently and can use surface role metadata to apply
consistent state across them.

### Input texture and buffer import

The plugin renders against a `GPUTexture` it receives. The SDK imports
the client's dmabuf onto the plugin's device:

- For **external plugins**, this is a second import in addition to (or
  in place of) the existing import onto core's device. See "Import
  policy" below.
- For **bundled plugins** on core's device, no extra import is needed
  — the plugin uses the same texture core's compositor would have used.

### Import policy (open)

Core's import of the client buffer when a plugin intercepts is an open
design point. The original plan was dual-import (core and plugin both
get the buffer, core can fall back to drawing the client buffer raw if
plugin misses). This was reconsidered because the fall-back-to-raw is a
bad UX (the window flickers between styled and unstyled frames).

Current thinking: core does NOT import the client buffer for
intercepted surfaces in the steady state. The plugin is the sole
importer. Core caches the plugin's last successful output and reuses it
on transient miss. Core re-imports client buffers only on transitions
(plugin permanently failed, intercept rule removed, plugin uninstalled).

This makes plugins with intercept capability effectively equivalent to
tier-3 capture in terms of buffer access — read access to every matched
client's pixels.

### Phantom-window lifetime

Plugins may request that a window's surface state be kept alive past
unmap, for animations like collapse-on-close. Plugin signals when it
is done; core completes the destroy. Hard timeout prevents misbehaving
plugins from holding windows forever.

This same machinery is reusable for open animations (window enters
animated), workspace-switch animations, minimize, etc.

## Output rect control

For animations that change a surface's apparent position/size frame to
frame (CRT-off shrinking to a point, slide animations, scale
animations), plugins need geometry control in addition to pixel
control. The intercept render callback returns an optional output rect;
core composites the plugin's output at that rect rather than the
surface's natural geometry.

This subsumes the simple-transform-animation case (no pixel work, just
geometry change) — a plugin can return a per-frame rect with no
modification to the input texture.

## Chains

Multiple intercepts on the same client surface form a chain. Each
stage's output feeds the next stage's input. The final stage's output
is what core composites.

### Categorization

Plugins declare what they contribute:

- `pixels` — modifies texture content (decoration shape, color
  filters, blur).
- `geometry` — modifies position/size (animations).
- `composition` — modifies how the result is drawn into the scene
  (opacity, blend mode).

Core orders the pipeline by category: `pixels` first, then `geometry`,
then `composition`. Within a category, registration order applies
(explicit priority overrides).

### Chain orchestration

Chain orchestration runs through core, not direct plugin-to-plugin. Each
stage's completion is posted to core; core dispatches the next stage
with the previous stage's output handle and fence. Pluginauthors do not
know about chain neighbors.

Reasoning: failure handling is much cleaner with a central orchestrator
(skip a failed stage cleanly, fall back to upstream cached output). The
extra postMessage hops are microseconds and don't dominate the per-stage
GPU work cost.

### Padding allocation

Each stage's textures must accommodate any downstream stage's input
margin. Allocate every stage's texture at the conservative max across
the chain.

The plugin declares `inputMargin` (how far beyond the input rect it
samples) and `outputMargin` (how far beyond it writes). The pixel area
outside what upstream stages wrote is undefined — plugins sampling
beyond original content are responsible for handling it (clamp, fade,
etc.). This keeps stages independent of each other.

### Performance ceiling

Chain depth has real cost: each stage adds a cross-device fence wait
for external plugins. Honest expectation:
- 1-2 intercept stages per window at 60fps: easy.
- 3-4 stages per window: probably fine with good caching.
- 5+ stages per window: bumping the frame budget. Document as the
  ceiling.

Caching is the primary mitigation. A stage whose inputs (surface
buffer, window state, effect state) haven't changed since last frame
returns its previous output unchanged. Static effects on static windows
are free per frame.

## Capture

Read-only access to composited content. Use cases: screenshots, screen
recording, workspace overview thumbnails, accessibility magnifier,
color picker, screen sharing.

Sources: outputs, workspaces, individual windows. The captured texture
is composed by core; the consumer samples and uses it but cannot
affect what gets displayed.

### Push, not pull

Core renders sources on its own clock; subscribers receive per-frame
events with the texture handle. Plugin samples in its callback; the
texture lifetime is "valid during the callback; copy if needed later."

### Multiple subscribers

Multiple subscribers on the same source share core's rendered texture
(no extra work, texture is read-only and refcounted across consumers).
Subscribers on different sources may each force core to render
something it otherwise wouldn't (off-screen workspaces) — that's the
real cost, not subscriber count.

### Subscription shape

Per-source (`subscribe`) or pattern (`subscribeAll`). Pattern form
gets per-source added/removed events. Plugin chooses based on whether
it has per-source UI state.

## Output takeover

Plugin replaces what gets presented to an output. Use cases: workspace
overview animation, fullscreen effects (CRT-off the whole desktop),
lock screen, magnifier, fullscreen game mode.

### Composition with intercepts

Intercepts continue to run during takeover; their outputs feed core's
normal compositing; the takeover plugin's `input.texture` is the
composited scene with intercepts applied. The takeover plugin
transforms or replaces this final scene. Intercepts and takeover are
orthogonal layers.

### Input

Default mode: `route`. Plugin receives every input event; events the
plugin doesn't explicitly forward are dropped. Plugin forwards events
to specific surfaces (with coordinate translation if needed) via
`sdk.input.forward(surfaceId, event)`.

`passthrough` is an opt-in convenience meaning "treat input as if no
takeover were active." Useful for magnifier-style overlays.

### Cursor

Decoupled from takeover. Cursor is always visible by default. Separate
SDK (`sdk.cursor.hide()`, `sdk.cursor.setShape()`, etc.) controls
visibility and shape, orthogonal to who owns the output.

### Failure modes

- **Transient miss** (plugin didn't complete frame in time): hold the
  plugin's last good frame.
- **Permanent failure** (crash, watchdog kill, restart policy
  exhausted): release the takeover, fall back to core's normal
  compositing. User gets a functional desktop even if mid-animation;
  better than a frozen screen.

### Multi-output

Independent per output. Plugin may take over one, several, or all
outputs. Other outputs render normally.

### Build order

Capture lands first (lower stakes, useful immediately for
screenshot/recorder plugins). Takeover lands second, building on
capture's machinery. The workspace viewer needs both and ships as the
takeover demo. Phase-1 takeover can accept a small flicker at handoff
boundaries; seamless handoff is polish.

## Multi-output rendering

Plugins render once per frame regardless of how many outputs a surface
appears on. Core composites the plugin's output onto each output with
per-output scale/transform applied during compositing. The plugin
produces logical pixels; core deals with physical pixels.

Per-output variation (different effect intensity per monitor, etc.) is
deferred. Can be added later via an opt-in flag without breaking the
default model.

## SDK shape

Plugins import the SDK and call its methods. The SDK is identical
between bundled and external plugins.

### Top-level

```js
sdk.name            // string
sdk.log(...args)    // log to plugin's log stream
sdk.onShutdown(cb)  // graceful-shutdown callback
```

### Namespaces

```
sdk.windows      — window observation, per-surface state
sdk.intercept    — per-pixel intercept registration
sdk.overlay      — free overlay surfaces
sdk.decorations  — decoration surfaces bound to windows
sdk.capture      — read-only composited-content capture
sdk.output       — output observation, takeover
sdk.workspaces   — workspace observation
sdk.cursor       — cursor visibility and shape
sdk.input        — input forwarding (during takeover)
sdk.frame        — global frame ticks
```

### Window observation and state

```js
sdk.windows.observe({
  match: { app_id, title, focused, fullscreen, role, ... },
  setup: async () => ({
    onMatched: (surface) => {},
    onChange: (surface, change) => {},
    onUnmatched: (surface) => {},
  }),
})

sdk.windows.list()

sdk.windows.setOpacity(surfaceId, alpha)
sdk.windows.setMask(surfaceId, GPUTexture | null)
sdk.windows.setTransform(surfaceId, { translate, scale, rotate? })
sdk.windows.setOutputMargin(surfaceId, { top, right, bottom, left })

sdk.windows.requestExtendedLifetime(windowId, { reason, maxDuration })
```

### Intercept registration

A plugin may register zero or more intercepts. Each is independent.

```js
sdk.intercept.register({
  name: 'rounded-corners',
  match: { app_id: /.*/, ... },
  contributes: ['pixels'] | ['geometry'] | ['pixels', 'geometry'] | ['composition'],
  inputs: ['surface-buffer'] | ['scene-under'],
  inputMargin: { top, right, bottom, left },
  outputMargin: { top, right, bottom, left },
  priority: 100,  // higher runs later within the same category
  setup: async (device) => ({
    onSurfaceMatched: (surface) => {},
    onSurfaceUnmatched: (surface) => {},
    render: (input, output, ctx) => {
      // sync; encode + submit
      // input.texture: GPUTexture from previous stage (or client buffer if first)
      // input.rect:    where input content lies in surface coords
      // output.texture: GPUTexture to write into
      // output.rect:   bounds of output
      // ctx: { surface, window, time, frameNumber }
      // returns: { outputRect?, done? }
    },
    destroy: () => {},
  }),
})
```

Setup fires once when the registration becomes active. Render is sync;
the plugin encodes commands and submits before returning. SDK exports
the fence after render returns and orchestrates the chain.

Match changes (e.g. config edit, window state change) fire
`onSurfaceMatched`/`onSurfaceUnmatched`; setup does not re-run.

### Overlay and decoration surfaces (existing today)

```js
sdk.overlay.create({ layer, anchor, size, margin? })
sdk.decorations.register(pattern)
sdk.decorations.createDecoration(windowId, { insets, layer })
```

These produce *additional* surfaces composed alongside windows. Used
for titlebars, custom border art, panels, HUDs. Not in the intercept
chain.

### Capture

```js
sdk.capture.subscribe({
  source: 'output' | 'workspace' | 'window',
  sourceId,
  rate: 'every-frame' | 'on-damage',
  setup: async (device) => ({
    onFrame: (texture, ctx) => {},
    destroy: () => {},
  }),
})

sdk.capture.subscribeAll({
  source: 'output' | 'workspace',
  match?,
  setup: async (device) => ({
    onSourceAdded: (source) => {},
    onSourceRemoved: (source) => {},
    onFrame: (texture, ctx) => {},  // ctx.sourceId tells which
    destroy: () => {},
  }),
})
```

### Output takeover

```js
sdk.output.takeover(outputId, {
  inputMode: 'route' | 'passthrough',  // default 'route'
  setup: async (device) => ({
    render: (input, output, ctx) => {},
    onInput: (event) => {},  // if inputMode is 'route'
    destroy: () => {},
  }),
})
// returns: { release() }
```

### Output/workspace observation

```js
sdk.output.observe({ setup: () => ({ onMatched, onUnmatched, onChange }) })
sdk.output.list()
sdk.workspaces.observe({ setup: () => ({ onMatched, onUnmatched, onChange }) })
sdk.workspaces.list()
```

### Cursor

```js
sdk.cursor.show()
sdk.cursor.hide()
sdk.cursor.setShape(name)
sdk.cursor.setImage(texture, hotspot)
```

Scope is open (per-output? global? while plugin active?).

### Input forwarding (during takeover)

```js
sdk.input.forward(surfaceId, event)
```

Plugin uses inside `onInput` to deliver an event to a client surface
with whatever coordinate transform is appropriate.

### Frame ticks

```js
sdk.frame.onTick(cb)
```

For animation plugins that need ticks independent of any surface.

## Setup contract

`setup` is async. It runs once when the registration becomes active
(plugin loaded + capabilities granted). It receives the `GPUDevice`
(core's device for bundled plugins, the plugin's own device for
external plugins). It returns an object containing the per-frame
callbacks and optional lifecycle hooks.

On device-lost (worker plugins on driver hang, core's device on GPU-
process crash + recovery), `setup` may be invoked again with a fresh
device. The plugin's previous state is gone. Plugin authors do not
write explicit device-lost handlers; `setup` re-invocation is the
contract.

## Capability gating

Not designed in detail. The categories that need gates:

- `windows.observe` with broad match (privacy-equivalent to capture).
- `intercept` (read access to client buffers).
- `capture` (read access to composited output, tier 3 in
  `architecture.md`).
- `output.takeover` (replaces what user sees, highest privilege).
- Input forwarding (could be used to inject events).

Bundled plugins have all capabilities by default. External plugins
request capabilities in their package metadata; user grants explicitly
in config. Same model as `architecture.md` capability tiers.

## Decoration as a plugin

The default decoration is a bundled plugin using the same SDK as any
other plugin. The user can disable it (windows render undecorated) or
replace it with another plugin. There is no special "decoration
interface" separate from the plugin SDK.

The default decoration plugin combines:
- Per-surface state setters (`setMask` for rounded corners,
  `setOpacity` for fade, `setOutputMargin` for shadow extent) for the
  cheap path.
- Decoration surfaces (`createDecoration`) for titlebars and bordered
  regions.
- Optionally, intercept for per-pixel effects (only if it ships them
  built-in).

A third-party decoration plugin can take over either by configuring
itself as the decoration role or by running alongside the default and
restyling matched windows. Coexistence rules need explicit design
(probably: only one plugin can claim the "decoration role" slot;
others can still intercept and set state via the normal SDK).

## Async-everywhere SDK contract

Every plugin-facing SDK call is async. Every callback the plugin
registers can return a promise; core awaits it. This is required for
external plugins (postMessage is fundamentally async) and held uniform
for bundled plugins so the same plugin source runs in both transports.

For bundled plugins the promise resolves on the next microtask — near-
free. For external plugins it resolves after an IPC round-trip — real
latency that depends on payload size, worker state, OS scheduling, CPU
contention. **Numbers must be measured, not assumed.** Node Worker
postMessage round-trips can be anywhere from tens of microseconds (warm
worker, idle system) to single-digit milliseconds (cold scheduler,
contended CPU). Architecture decisions that depend on specific
latencies should be validated against measurement.

### High-frequency events need fire-and-forget

Events that fire at high rates (pointer-move, scroll, possibly key
events) cannot reasonably use an await-on-decision contract — a chain of
external plugins each round-tripping per pointer-move would saturate the
IPC channel. These events flow as one-way notifications: plugins observe
but cannot block or veto on the hot path. A plugin that wants to react
to pointer motion does so asynchronously and reacts after the fact;
the event is already delivered to whoever core would have delivered it
to.

Lower-frequency events (key down at human-input rates, window state
changes, focus changes) use await-on-decision; chain members can
consume or forward. The SDK declares per event type which mode applies.

## Internal vs. external plugins, revisited

Internal (bundled) plugins exist because they are how core delegates
its delegable responsibilities (layout, focus policy, decoration,
effects, animations, hotkeys, IPC dispatch, notifications). They are
the *default distribution* — overdraw without them isn't a usable
compositor.

Externally-installed plugins (npm, user directories) **always run
external**. There is no user-facing "elevate to internal" knob. Reasons:

- The performance gap is narrower than it first appears. Layout, focus,
  hotkey, IPC dispatcher plugins don't fire per-frame; an extra IPC
  round-trip per WM event is negligible. Only per-frame intercept and
  high-frequency input observers have meaningful IPC cost, and for
  per-frame intercept the dominant cost is the cross-device dmabuf+fence,
  not the IPC — elevation alone wouldn't fix it without also moving to
  core's GPU device.
- The "user trusts a plugin once, plugin auto-updates, plugin ships a
  bug" trust failure is real and badly recoverable.
- "Fork overdraw and add the plugin to the distribution" is the escape
  valve for the rare case someone needs internal execution.

Plugin promotion to internal happens by adoption into the distribution
(curation, code review), not by user choice.

## Failure recovery via priority chain

Each replaceable category has a built-in (internal) plugin registered
at low priority. External plugins register at higher priority. The
SDK invokes plugins in priority order.

Failure recovery is implicit. When an external plugin misbehaves
(timeout, crash, validation error, watchdog kill), the SDK
auto-deregisters it. The plugin's slot in the priority chain
disappears. The next-lower-priority plugin handles the work; eventually
the built-in catches everything.

No explicit fallback machinery needed. Failure handling and "user
disabled the plugin" share one code path.

### What this requires

- **The built-in plugin is the floor.** It must handle whatever state
  the failed external plugin left behind. Built-ins must be designed
  to work from observable state, not from inherited cached state.
- **Unregister-on-failure is atomic.** An event mid-flight when its
  current handler fails is re-dispatched to the next handler in the
  chain (input chain) or skipped (rendering chain).
- **State transitions are graceful.** External plugin crashing produces
  degradation, not breakage. Built-in's output is a reasonable
  baseline; the external plugin was an *addition*, not a replacement
  that leaves a hole.

### Exclusive vs. multiplex roles

Roles split by whether multiple plugins can be active at once:

- **Exclusive roles** (one active at a time): layout, focus policy,
  IPC command dispatcher, default hotkey handler. Highest-priority
  claim wins; lower-priority claims go dormant.
- **Multiplex roles** (many active): decoration (different plugins
  match different windows), capture (independent subscriptions),
  effects/intercept (chain), notifications (multiple sources),
  observation (any plugin can observe).

Exclusive roles use priority for selection. Multiplex roles use match
predicates for separation and priority for ordering within
conflicts/chains.

### Priority semantics differ by category

- **Input dispatch chain**: priority + consume/forward. Higher
  priority sees the event first; can consume (stop) or forward (next
  plugin sees it).
- **Rendering / intercept chain**: priority + category ordering. Every
  stage runs (no consume); the output of one stage feeds the next.
  Category ordering (`pixels` → `geometry` → `composition`) is
  separate from priority-within-category.

Do not conflate these in the SDK; they share the word "chain" but the
semantics differ.

### No safe mode

Earlier drafts considered a safe-mode boot (disable user plugins on
crash loop). v1 does not include this:

- External plugins are already isolated; their crashes are contained
  by the watchdog and restart policy.
- Bundled plugin bugs are core bugs — fixed in release, not at runtime.
  Disabling foundational bundled plugins (layout, decoration, focus)
  doesn't produce a usable system.
- A `--safe-config` startup flag (boots with default config, ignoring
  user customizations) covers the "user config wedged the system" case
  without persistent-state machinery.

## Plugin configuration

The user's config is a `.ts` (or `.js`) module. Plugins are
configured by passing options to plugin entry-points the user imports:

```ts
import myPlugin from 'overdraw-plugin-foo';
import blurPlugin from 'overdraw-plugin-blur';

export default {
  plugins: [
    myPlugin({ intensity: 0.5, color: '#ff8800' }),
    blurPlugin({ enabled: true, size: 8, passes: 3 }),
  ],
};
```

### Type checking via `.d.ts`

Plugins ship TypeScript declarations alongside their JS. Users writing
their config in `.ts` get standard TypeScript type-checking and editor
autocomplete against each plugin's configuration interface — typos and
type errors caught in the editor before overdraw even runs. This is
standard TypeScript ecosystem behavior; no overdraw-specific schema or
validation layer is needed.

overdraw ships its own `.d.ts` for the SDK so plugin authors can build
typed plugins against it; the type chain flows from SDK types →
plugin types → user config.

Plugins doing runtime validation of their config (for the case where a
user wrote `.js` instead of `.ts`, or somehow received untyped input)
is the plugin author's concern, not overdraw's.

## Categories and the SDK surface

A compositor's responsibilities split into a set of categories. For
each, what core owns vs. what plugins can do via the SDK.

This list is the planning surface for the SDK; not all categories are
fully designed in detail.

### Client window management

What it is: how application windows get placed, sized, focused,
stacked, moved across workspaces and outputs.

Core owns: window state (geometry, mapped, focus, workspace/output,
stacking), `xdg_toplevel` protocol semantics, input routing,
hit-testing.

Plugin SDK exposes:
- `sdk.windows.observe` — already designed.
- `sdk.windows.move`, `resize`, `setFloating`, `setFullscreen`,
  `setMaximized`, `setSticky`, `setUrgent`, `setMinimized`.
- `sdk.windows.focus(windowId)`, `focusInDirection`, `focusNext/Prev`,
  `cycleFocusHistory`.
- `sdk.windows.moveToWorkspace`, `sendToOutput`.
- `sdk.layouts.register({ name, algorithm })` — layout plugin
  registers a replacement. Bundled default registers at low priority.
- `sdk.windows.beginInteractiveMove`, `beginInteractiveResize` — for
  custom move/resize keybindings.
- Window rules: declarative match-predicate → action declarations,
  expressed via the config or via plugin-supplied rule sets.

Open: what the layout algorithm interface looks like; how pre-map
hooks interact with layout when both want to decide window position.

### Window appearance

What it is: how windows look — borders, corners, opacity, shadows,
blur, animations, transitions.

Core owns: per-surface state primitives (opacity, mask, transform,
output margin), the compositor's shader that applies them, the
intercept chain machinery.

Plugin SDK exposes: per-surface state setters (designed),
`sdk.intercept.register` (designed), decoration surfaces (existing),
phantom-window lifetime (open).

### Layer-shell surfaces

What it is: bars, wallpapers, notifications, launchers, lock screens —
surfaces created via `wlr-layer-shell-unstable-v1` /
`ext-layer-shell-v1`. Not normal `xdg_toplevel` windows. Identified by
namespace (string) and layer (background/bottom/top/overlay) rather
than app_id.

Core owns: layer-shell protocol semantics, layer-based stacking,
exclusive-zone management. **Not implemented in overdraw yet.**

Plugin SDK exposes:
- Same `sdk.intercept.register` as for windows; match predicate
  includes `role: 'layer-shell'` and `layer_namespace` regex.
- Same decoration / observation mechanisms.

Layer-shell surfaces are first-class intercept targets. From the
plugin's perspective the buffer pipeline is identical; only the
metadata (namespace vs. app_id, layer vs. workspace) differs.

### Output management

What it is: monitors, modes, scale, rotation, position, mirroring,
hot-plug, DPMS.

Core owns: KMS handling (phase 2), host-output handling (phase 1),
mode-set, output protocol (`wl_output`). Hardware-coupled; not
delegable.

Plugin SDK exposes:
- `sdk.output.observe({ onMatched, onUnmatched, onChange })` — react
  to outputs appearing/disappearing/changing.
- `sdk.output.list()` — enumerate.
- `sdk.output.takeover` — replace output presentation (designed).
- Output configuration (mode, scale, position) is *probably* set via
  user config, not by plugin. But: a plugin could expose policy
  ("auto-rotate when output is in portrait") that sets it on core's
  behalf.

### Input

What it is: keyboard layout, repeat rate, pointer accel, gestures,
hotkeys, modifier handling.

Core owns: libinput / host input event source, raw event routing,
modifier state tracking, keymap (xkbcommon), focus-based delivery to
clients.

Plugin SDK exposes:
- `sdk.input.observe({ pointer, key, gesture, ... })` — observation
  outside takeover. High-frequency event types (pointer move) are
  fire-and-forget.
- `sdk.input.bind({ key, modifiers, action })` — hotkey
  registration. Hotkey handlers run as priority + consume/forward.
- `sdk.input.gesture` — gesture recognizers (swipe, pinch).
- `sdk.input.forward` — within takeover or hotkey handler.
- Low-level libinput config (repeat rate, pointer accel, tap-to-click)
  is user config + reapplied at runtime.

Open: how hotkey conflicts resolve when multiple plugins register
overlapping bindings; how device-specific overrides work.

### Cursor

What it is: pointer appearance and behavior.

Core owns: cursor position state, host pointer integration.

Plugin SDK exposes: full cursor customization including
velocity-based effects (rotation, scaling, motion trails),
position-driven transforms, custom shapes per state. The cursor is
exposed as a customizable surface — a plugin can fully own its
appearance and per-frame transform. Example use case: a plugin that
tilts the cursor based on movement velocity (the
`hypr-dynamic-cursors` use case in Hyprland, which required hooking
nine internal functions).

Open: scope and shape of the cursor SDK (per-output, global; static
vs. animated; HW cursor interaction). Designed only at the level
"this is a customizable area, not an afterthought."

### Workspaces

What it is: creation, switching, naming, per-output assignment,
inter-workspace animations.

Core owns: which workspace a surface is on, which workspace an output
is currently showing. Single source of truth.

Plugin SDK exposes:
- `sdk.workspaces.observe`, `list`, `current(outputId)`.
- `sdk.workspaces.switch(outputId, workspace)`,
  `assignToOutput(workspace, outputId)`.
- `sdk.workspaces.create`, `destroy`, `setName`.
- Workspace manager is probably a plugin (the default ships a
  bundled implementation).

### Compositing pipeline

What it is: what gets drawn, in what order, with what effects, into
what render targets.

Core owns: the frame loop, render targets, the swapchain/scanout
present, fence machinery, multi-pass infrastructure.

Plugin SDK exposes: `sdk.intercept.register` (per-window),
`sdk.capture.subscribe` (read-only), `sdk.output.takeover`
(per-output). All designed.

### Capture / observation

Designed in earlier sections. Read-only access to composited content.

### IPC / control socket

What it is: external control via a CLI tool / socket — overdraw's
equivalent of `swaymsg` / `hyprctl`.

Core owns: the listening socket, message framing, authentication.

Plugin SDK exposes:
- `sdk.ipc.registerCommand({ name, handler, helpText, schema })` —
  plugin extends the CLI vocabulary.
- `sdk.ipc.emit({ event, payload })` — plugin publishes events to
  subscribers.
- A "named command / dispatcher" registry the IPC layer dispatches
  through. Hyprland's `addDispatcherV2`: commands are bindable from
  config, invokable via CLI, callable from other plugins.

Bundled IPC command set covers state queries (windows, outputs,
workspaces, focus), bindable actions (move/resize/focus/workspace
operations), and config reload.

Open: protocol shape (JSON, JSON-RPC, line-oriented), CLI tool name.
The Hyprland event-socket + command-socket split is one pattern;
sway's single-socket is another.

### Notifications and status

What it is: surfacing information from compositor or plugins to the
user.

Core owns: nothing intrinsic. Notifications are produced and
consumed.

Plugin SDK exposes:
- `sdk.notify({ text, color, time, icon? })` — plugin emits a
  notification.
- Notifications get rendered by *some* plugin (the bundled
  notification renderer, or an external one). Same pattern as
  every other category — bundled implementation, replaceable.

### Session and lifecycle

What it is: startup, shutdown, autostart, idle handling, lock state.

Core owns: process lifecycle, idle detection, session-lock protocol.

Plugin SDK exposes:
- `sdk.session.onIdle`, `onActive`, `requestIdleInhibit`,
  `releaseIdleInhibit`.
- `sdk.session.lock`, `unlock`, `onLockChange`.
- Autostart is user config (a list of `exec` lines), not plugin
  territory.

### Protocol surface

What it is: implementing or extending Wayland protocols beyond what
core ships.

Core owns: the generic protocol trampoline (architecture line 687),
interface registration with libwayland.

Plugin SDK exposes:
- `sdk.protocol.register({ interface, version, handlers })` —
  architecture's tier 4. Plugins implement new Wayland protocols or
  override standard ones. Capability-gated by interface list.

Per architecture: lower-layer (C++/core JS) handlers can be silently
overridden by plugin handlers. Plugin handlers take priority at bind
time.

## Cache invalidation primitives

Plugins doing intercept caching need to know when their cached output
is stale. The mechanism: a per-scope generation counter, bumped by
core whenever something that could affect intercept output changes.

Possible scopes:
- per-monitor scene generation (bump on window focus, workspace
  change, fullscreen toggle on that monitor).
- per-surface generation (bump on surface state change, buffer
  commit).

Plugins read the generation in their cache key. When the generation
changes, the cache miss naturally triggers re-render.

This is the pattern hyprglass reinvented per-plugin (its per-monitor
`bumpSceneGeneration`); making it an SDK primitive saves every
intercept plugin from rebuilding it.

Open: which scopes to expose (output, surface, workspace, all of
them?); what events bump the generation (probably configurable per
plugin, since different plugins care about different things).

## Open items

Designed in shape but not in detail:

- Capability gating mechanism.
- Cursor API scope and shape.
- Input event types, payload shape, hotkey conflict resolution.
- Phantom-window lifetime API specifics (event names, timeout
  behavior).
- Chain conflict resolution within a category (priority semantics,
  what happens on collision).
- Frame timing API specifics.
- `sdk.windows.list()` / observe details (what's in the change event,
  what's in the surface object).
- Bundled vs. external transport implementation.
- The decoration "role slot" — who owns it, how it's claimed, what
  happens on conflict.
- Output takeover handoff polish (seamless vs. one-frame flicker).
- Damage tracking interaction with capture / off-screen workspace
  rendering cost.
- Layout algorithm interface shape (what the plugin sees, what it
  returns).
- IPC protocol shape (JSON-RPC, line-oriented, ...).
- Performance characteristics under realistic load — needs measurement,
  not assumption. IPC round-trip costs, intercept chain depth limits,
  capture subscription cost on multiple sources.
- Cache invalidation scope set and trigger events.

## Relationship to `architecture.md`

This document supersedes `architecture.md` where they differ. The
canonical position will be reconciled when this is built.

Key divergences:

- `architecture.md` line 405 forbids plugins drawing on the core's
  device. This document allows it for bundled plugins.
- `architecture.md` describes decorations as a thin policy bundle on
  top of `requestInsets` + `createDecoration`. This document expands
  the decoration role to include per-surface state setters and
  optional buffer interception.
- `architecture.md` capability tiers (lines 376-407) listed
  contribution/output-takeover/capture/protocol as the tiers. This
  document adds intercept (per-pixel modification of client surfaces)
  as a distinct capability; it sits between contribution and capture
  in terms of privilege.
- `architecture.md` does not have per-surface effect state in core.
  This document adds it (opacity, mask, transform, output margin).
- `architecture.md` mentions surface transforms as v2 (line 1176).
  This document includes them in the per-surface state primitives as
  v1-relevant.

The above are intentional refinements; the original architecture's
reasoning is not invalidated, it's being extended for cases the
original didn't address (buffer interception, third-party-distributable
plugin ecosystem, replaceable decoration role).
