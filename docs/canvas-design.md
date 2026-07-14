# Canvas design — shared world, monitors as cameras, islands

Design/scoping doc for replacing the workspace model with a shared-world
infinite canvas. **No code yet — this is the plan.** Design rationale lives
here; ground-truth status stays in `docs/status.md`. When work lands, fold
residual gaps into status.md and trim this doc to what is still future.

The model in one paragraph: all windows live at positions in the existing
global logical coordinate space, which becomes an infinite 2D **world**.
Tiled windows belong to **islands** — named world rects, each running its
own layout policy over its members. Each connected monitor is a **camera**:
a movable (eventually zoomable) viewport into the world. **Bookmarks** are
named camera framings (an island, a set of islands, or a rect + zoom) — the
successor to "workspace N". Workspaces stop being the model and become one
projection of it: a fixed island with a permanently docked camera behaves
exactly like a workspace, including what ext-workspace/waybar sees.

## 1. Why the architecture is friendly to this

Properties that already exist and carry most of the load:

- **One global logical coordinate space.** Window `outer`/`rect`, cursor
  position, and output positions (`WmOutput.rect`, `OutputRecord.
  logicalPosition`) all live in it (`wm/index.ts`). Each output renders a
  *slice* of that space by subtracting its origin: `updateUniforms` in
  `gpu/compositor.ts` computes `px = s.x - output.originX` per surface. A
  camera is one more term in that subtraction.
- **Input hit-tests in the same space.** `wl_seat.ts pick()` →
  `wm.windowAt(x,y)` → `hitTestSurfaceTree`; `activeOutputId` tests the
  pointer against `logicalPosition`. `surface-geometry.ts` is deliberately
  shared between the render and input paths so they cannot diverge.
- **No client-buffer direct scanout.** Every output composites into the
  compositor's own scanout target. Nothing requires windows to sit at
  integer positions on a plane, so a fractional, animated pan of the whole
  world costs a full-output repaint (same as transitions today) and
  nothing else. The usual plane-compositor argument against smooth world
  panning does not exist here.
- **Workspaces and layout are already swappable plugins.**
  `plugin-workspace-default` owns the exclusive `'workspace'` namespace;
  `plugin-layout-default` owns `'layout'`. The single core seam that
  decides per-output visibility is `sdk.windows.setOutputStack`.
- **The layout contract is already region-based.** The layout-driver
  invokes the layout plugin per output with a `tileRegion`; the plugin
  computes region-local rects and translates by `tileRegion.x/y`
  (`plugin-layout-default/src/index.ts`). Passing an island's world rect
  instead of the output's rect requires no change to layout plugins.
- **A spring/easing evaluator driven on per-output vblank ticks**
  (`animations/spring.ts`, `dispatchForOutput`) — the right engine for a
  continuous camera value. (The transition system is snapshot-based FROM/TO
  texture blending — built for discrete A→B swaps, wrong for continuous
  scroll.)
- **`wp_fractional_scale_v1` + `wp_viewporter` are wired end-to-end** —
  the ingredient that makes camera zoom *native* rather than a magnifier
  trick (§5).

## 2. Primitives

Three objects, no more:

- **Island** — `{ id, name?, rect (world), members[], layoutRef, growth }`.
  A world rect whose member windows are tiled by the referenced layout
  provider. `growth` is `fixed` (rect never changes; layout compresses,
  classic workspace behavior) or `elastic` (rect grows along one anchored
  axis as members exceed fit — a niri strip is an elastic island).
- **Camera** — per connected monitor: `{ outputId, target (island ref |
  free position), offset, zoom }`. The output's view origin into the world.
  Persisted across disconnects keyed by monitor identity (EDID serial,
  matching the hotplug identity the workspace plugin uses today).
- **Bookmark** — `{ name, framing }` where framing resolves to a camera
  target: one island, a set of islands (fit their combined bounds), or a
  raw rect + zoom. Bookmarks are what hotkeys and window rules name, and
  what the ext-workspace adapter advertises.

The load-bearing invariant across all three: **nothing durable references
raw world coordinates.** Cameras dock to island refs, rules target island/
bookmark names, hotplug records store island refs. World x/y is solver
output — the world-arrangement policy may reposition islands (§6) and
nothing dangles. The only raw-coordinate holders are free-roaming cameras
and floating windows, both of which just observe the (animated) shift.

## 3. Core vs. plugin split

Core ships mechanisms, plugins ship policy (`core-plugin-api.md`). The
split here:

**Core mechanisms:**

- The per-output **camera term**: view origin `(x, y)` + `zoom`, default
  identity `(0, 0, 1)`, applied everywhere world↔output mapping happens
  (§4), settable by plugins via an SDK call.
- The **island object** and per-island layout invocation: the
  layout-driver generalized from "one region per output" to "N islands,
  each with a rect, members, and a layout provider". Default: one implicit
  island per output, rect = tileRegion — behavior-identical to today.
- **Derived output membership**: which outputs see a window (for
  `wl_surface.enter/leave`, preferred scale) computed from geometry
  through the camera, rather than the cached per-window `outputId`
  ownership. With identity cameras the derivation is equivalent to the
  cache.

**Plugin policy (a `plugin-canvas` claiming the `'workspace'` namespace,
and eventually the layout driver's provider selection):**

- Island lifecycle: creation (sized to the creating camera's viewport),
  naming, hygiene (unnamed empty islands evaporate), membership on
  map/close/drag.
- World arrangement: placement with gutters, growth, shove (§6).
- Camera policy: docking, follow-focus, fly-to animations, hotplug
  persistence and focus rescue (§8).
- Placement rules and attention policy (§7).
- The ext-workspace façade (§9) and the `workspace` namespace verb set
  (§10), so waybar / keybinds / core actions keep working unchanged.

## 4. The camera

Definition: for output O showing world through camera C, a content surface
at world `(x, y)` renders at device
`((x - C.x) * C.zoom - O.originX) * O.scale` (and likewise y). With
`C = (0, 0, 1)` this is exactly today's expression.

Sites that must agree — the camera term is a *mapping* change, and every
world↔output mapping site must apply it identically or clicks, damage, and
scale events desync from pixels:

1. **Render**: `updateUniforms` (`gpu/compositor.ts`) — the single
   insertion point for per-surface position uniforms. No new core↔GPU IPC:
   uniforms already flow over the existing Dawn wire path.
2. **Input**: `wl_seat.ts pick()` (pointer world position for hit-testing)
   and `activeOutputId` (`main.ts`). One transform at the top of each.
3. **Damage partitioning**: `output-damage-map.ts` maps global-logical
   damage to per-output damage by output rect; the effective output rect
   in world space becomes the camera's view rect.
4. **Enter/leave + preferred scale**: window↔output intersection tests
   move from "window rect vs output rect" to "window rect vs camera view
   rect".
5. **Popup/constraint solving**: `xdg_positioner` constraint boxes for
   content surfaces are the camera view rect, not the raw output rect.

Gating: the camera applies to **content surfaces only**. Layer-shell
(`background/below/above/overlay`) and the cursor are output-anchored and
keep the raw origin. `drawOrder` composites content + layer surfaces
together per output, so the gate lives per surface role inside
`updateUniforms` — and the identical gate in hit-testing (layer surfaces
and their popups hit-test in un-panned space).

Animation: a camera move is a spring-driven scalar evaluated on that
output's vblank tick, forcing full-output damage while unsettled
(mirroring `activeTransitions`). Layout is **never** recomputed during a
pan — `LayoutReason` has no "pan" on purpose. Panning is purely
render+input; layout runs on structural events only. Do not implement the
camera as per-surface `fx.translate`: that channel is owned by per-window
open/move animations and would collide.

Zoom is two features:

- **Optical zoom** (transient): compositor-side scaling in the same
  uniform expression. Clients keep rendering at native size; output is
  downsampled. Fine for a peek or the overview gesture; wrong as a resting
  state.
- **True zoom** (resting): advertise effective scale = output scale ×
  camera zoom through `wp_fractional_scale_v1`; fractional-scale-aware
  clients re-render crisply at the new density. Camera zoom becomes a
  per-monitor density knob ("show the world at 0.85×, sharply"). Legacy
  clients degrade to the optical path.

Zoom changes *density*; layout changes *structure*. A zoom must never
trigger a relayout or island reflow. If the user wants smaller-but-more
windows as a permanent state, that is an explicit island resize/reflow.

## 5. Islands and layout

The layout-driver's per-output invocation generalizes to per-island: core
holds the island list, resolves non-managed lanes as today (fullscreen /
maximized / floating / invisible), and calls the island's layout provider
with `tileRegion = island.rect`. Existing layout plugins work unchanged —
they already treat the region as opaque and translate by its origin.

Consequences:

- The exclusive `'layout'` namespace becomes a **provider registry**; each
  island's `layoutRef` selects one. Layout plugins shrink toward
  primitives (columns, even-split, stack, monocle) and screen *structure*
  moves into island arrangement, which is user-manipulable at runtime. A
  grid screen is two even-split islands stacked with a camera framing
  both — not a new layout plugin.
- **Fixed islands** compress on overflow (master-stack rows get thinner —
  today's behavior). **Elastic islands** grow along their anchored axis
  and the docked camera scrolls within them (niri strip). One flag, per
  island.
- Cameras **dock** to islands (pin to origin/framing exactly) rather than
  free-pan near them; free panning is for traveling and floating-window
  territory. Docked-on-a-fixed-island is pixel-identical to a workspace.

Visibility: `setOutputStack` semantics invert from "the shown workspace's
members" to "everything near the camera's view rect" (with margin for
pan). The camera + per-output scissor culls; windows far off-view are
omitted from the stack entirely. `pushStack` gating (exclusive-window
suppression etc.) keys on islands-in-view rather than the per-window
output cache.

## 6. World arrangement (no overlap, shove)

Islands may not overlap. Placement policy (plugin):

- New islands auto-place with **generous gutters** — the canvas is
  infinite; gutters are expansion joints that absorb typical elastic
  growth so collisions are rare.
- Each island grows in one direction from a fixed anchor edge (e.g.
  anchored left, grows right), so growth is predictable and shoves
  propagate one way.
- When growth does collide, the **neighbor is shoved** further along the
  growth axis (transitively). Shoves are order-preserving, axis-aligned,
  and minimal — never reorder, never repack. Spatial memory is relational
  ("comms is left of code"); a monotone shove preserves every relational
  fact. No auto-compaction, ever.
- Safe because of the §2 invariant: docked cameras follow their island
  automatically; names don't move; only free cameras and floating windows
  observe the (animated) shift.

Shoving is itself a layout problem one level up — islands are the
"windows", the world the "screen", and the policy is a compute-rects
function in the same shape as the layout contract. Not worth forcing
through the plugin interface initially, but the recursion means world
arrangement (rows / grid / freeform) can become pluggable with existing
machinery.

Floating windows live at raw world positions outside islands, render above
tiled content (as today), and may opt into anchoring to a nearby island
(stored island-relative) so they travel with their neighborhood. A shove
sliding an island under a float is tolerated, not prevented.

## 7. Placement and window rules

Wayland clients never see world coordinates (no global positioning in the
protocol), so placement is entirely compositor policy:

- **Rules target island/bookmark names**, not coordinates:
  `Slack → island "comms"`. Durable across hotplug and reorganization.
- **Unruled spawns are camera-relative**: appear in the viewport of the
  focused camera ("open where I'm looking") — the analog of "open on the
  current workspace". Deliberately not durable.
- **Monitor-targeted rules split into two intents**: *glass-relative*
  ("appear on the TV, wherever it's looking" — camera-relative to a
  monitor identity) and *home-region* ("go to monitor 2's home island" —
  desugars to an island rule, and keeps working while the monitor is
  unplugged: the window waits in the island).
- **Placement is structural for tiled windows** (insert as column / stack
  into focused / new island), literal x/y only for floating.
- **Placement and attention are orthogonal**: place in "comms" quietly;
  place in "comms" and fly my camera there; place here. This is
  xdg-activation focus-stealing policy expressed spatially — richer than
  the workspace model, where "open quietly elsewhere" only works if the
  target happens to be hidden.

Mechanically: the canvas plugin's `onMap` handler (where `applyMap`
assigns workspaces today) becomes the placement resolver;
`plugin-window-rules` stays the matching side, with the rule *target*
gaining island semantics.

## 8. Hotplug — the model's strongest case

Today windows belong to monitors, so disconnect is a migration problem
(elaborate `recomputeOutputs` / `preferredOutputs` machinery; replug
logical-position restore is a known gap in status.md). In the shared
world, windows belong to world coordinates and monitors are cameras:

- **Disconnect**: the camera is destroyed; its island region and every
  window in it are untouched. No relayout, no client resize storm, no
  stacking churn. Persist the camera record keyed by monitor identity —
  as an island ref + offset, not raw coordinates (§2 invariant, survives
  shoves).
- **Focus rescue** (policy): if the focused window is now off every
  camera, either focus the nearest visible window or fly a remaining
  camera to the orphaned island — "monitor A glances over at what B was
  showing", a verb workspaces cannot express.
- **Reachability**: orphaned islands must stay navigable — overview/zoom
  and bookmarks are load-bearing, not nice-to-have. Urgency on off-camera
  windows badges the island in waybar even while no monitor looks at it.
- **Reconnect**: restore the camera to its persisted island ref — the
  exact view reappears instantly. The replug-restoration gap doesn't get
  fixed; it dissolves, because nothing moved.
- **Overlapping cameras are legal** (two monitors viewing the same world
  region is coherent; mirroring falls out for free). Policy may nudge a
  wandering camera back when its region's original monitor returns, but
  nothing breaks if it doesn't.

Camera linkage is an open spectrum: **rigid** (all monitors are cutouts of
one arrangement viewport; bezel-spanning windows; no per-monitor scroll)
vs. **independent** (each camera scrolls alone; pointer crossing between
monitors is a world-space teleport; windows never straddle monitors).
Lean: independent cameras first, with **snap clusters** later (adjacent
world regions dock into one continuous view on demand).

Heterogeneous monitors (a 1080p camera flying to a region tiled for 4K):
resting behavior is **pan more** (the world is 1:1 logical everywhere);
**zoom** is the transient; **reflow to this camera** is explicit user
action only. Automatic reflow on hotplug is exactly the client-visible
resize storm this model otherwise eliminates.

## 9. ext-workspace / waybar mapping

The `ext_workspace_v1` adapter is a pure wire adapter over `workspace.*`
bus events plus the inbound `state.workspaceDriver` verbs — it doesn't
care what produces the events. Islands map:

- One workspace object per island (or per bookmark — see open questions);
  urgency and names pass straight through; click-to-activate = fly/dock a
  camera.
- **Activate needs a "which camera" answer** (groups are per-output;
  islands are global). Preferred: advertise every island into every
  output's group, so activating from monitor 2's bar docks monitor 2's
  camera. Needs an empirical waybar test (one workspace in multiple
  groups, or per-group duplicates keyed to one island). Fallback: one
  global group, activate resolves to the focused output's camera.
- Per-group **active** state = the island that output's camera is docked
  on (multi-monitor shows multiple actives, as today). A free-roaming
  camera honestly shows no active island.

Waybar is the 1D index of the world; the overview is its 2D map; both are
views over the same island list.

## 10. Compatibility surface (what core knows about workspaces today)

Core has no workspace data model; coupling is an interface, all of it
implementable by the canvas plugin with island semantics:

- `runtime.invokeNamespace("workspace", ...)` verbs from `main.ts`:
  `ensureOutput` + `moveWindow` (window.move-to-output actions), `reorder`
  (layout.promote/swap), `create`/`destroy`/`show` (the
  `state.workspaceDriver` behind ext-workspace).
- The `workspace.shown` bus subscription caching per-output indices for
  the `currentWorkspace` config ref (`config/refs.ts`).
- The `output.pre-remove` synchronous-migration ordering contract
  (`output/hotplug.ts`).
- The opaque `"workspace.id"` state-bag key; `outputContent` /
  `outputToplevelStacks` consumed by the WM/layout-driver as anonymous
  per-output stacks.

The canvas plugin keeps this verb set as a **compatibility façade**
(`show(index, outputId)` = dock that output's camera on the island at
that position; `moveWindow` = re-parent to island; `ensureOutput` = "the
island this output's camera is on, creating one if none"). Keybinds,
core actions, config refs, and ext-workspace keep working without core
changes for workspace reasons — there is essentially nothing to unpick.

## 11. Sequencing — behavior-intact first, policy later

The first two steps land in core with **zero behavior change** (identity
defaults), which is the point: establish that every mapping site honors
the mechanism while nothing exercises it, with non-identity covered by
tests only.

1. **Camera term in core, identity default.** Add view origin (+zoom
   placeholder) per output; apply at all five mapping sites (§4) gated to
   content surfaces; SDK setter + spring-driven moves + full-output
   damage while unsettled. Nothing sets it, so behavior is pixel-identical.
   GPU test: set a non-identity camera, readback shifted pixel positions,
   verify input hits the shifted window, verify layer-shell/cursor did
   not move. This also unlocks replacing snapshot-based workspace slide
   transitions with real camera moves later — optional, not part of this
   step.
2. **Island object in core.** Generalize the layout-driver to iterate
   islands; instantiate one implicit island per output (rect = tileRegion,
   members = that output's stack, layoutRef = the sole layout plugin).
   Behavior-identical refactor; existing layout plugins untouched. Unit
   tests move from per-output to per-island vocabulary.
3. **`plugin-canvas` in workspace-parity mode.** New plugin claiming the
   `'workspace'` namespace: N fixed islands 1:1 with today's workspaces,
   cameras permanently docked, `show` = dock camera, the §10 façade, the
   same `workspace.*` bus events. Behaviorally indistinguishable from
   `plugin-workspace-default` (including waybar) — validated by running
   the existing workspace test suite against it. Opt-in via config while
   both plugins exist.
4. **Canvas features** (all policy, all incremental from parity): free
   roaming + fly-to bookmarks; elastic islands; placement rules targeting
   islands; gutters + shove; hotplug persistence/rescue; overview
   (optical zoom); island hygiene.
5. **Later**: true zoom via fractional-scale; snap clusters /
   bezel-spanning; per-island layout providers (layout registry);
   world-arrangement pluggability.

Steps 1–2 are useful even if the canvas never ships: the camera subsumes
slide transitions, and islands give reserved-zone/region handling a
first-class object.

## 12. Open questions

- **Waybar vs. multi-group workspaces** (§9): does waybar tolerate one
  workspace in several groups? Decides the activate story. One-evening
  empirical test.
- **Islands vs. bookmarks in ext-workspace**: advertise every island, or
  only named/bookmarked ones? Lean: every named island; scratch islands
  stay off the bar.
- **Grid-bookmark active state**: camera framing two islands — both
  active or primary only? Cosmetic.
- **Namespace verb shape**: keep the index/output-shaped `workspace`
  verbs as façade forever, or version the namespace contract to island
  refs once parity mode is retired?
- **Shared canvas across outputs vs. per-output worlds**: this doc
  assumes one shared world (the coordinate space already is). If
  independent-camera teleport semantics prove confusing in practice, a
  per-output world (niri's shape) is a strict subset — same mechanisms,
  cameras just never leave their band.
- **Multi-camera scale selection**: a window visible on two cameras with
  different effective scales (zoom × output scale) — which preferred
  scale wins? Today's spanning-output answer (primary/max) probably
  carries over.
