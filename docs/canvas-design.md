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
open/move animations and would collide (as a separate uniform term the
camera composes with fx cleanly). The SDK setter suffices for docked
jumps and coarse animation; smooth per-vblank springs from a Worker
plugin would pay one IPC round-trip per frame, so the follow-up is an
`output-camera` target kind in the animation evaluator (`animations/
value.ts` TargetRef) letting plugins hand core a spring spec and get
in-core per-tick evaluation, like window fx animations do.

**Glass or world is a property of the surface, and pointer-borne chrome is
glass.** The camera moves every content surface that is not camera-exempt
(`outputAnchored`, a layer surface, or the cursor sprite). A surface
positioned from raw pointer coordinates must therefore be anchored, or the
camera pans it away from the very pointer it tracks: the DnD icon
(`wl_data_device_manager.ts`) rides `lastX/lastY` and is anchored for
exactly this reason, alongside the cursor. The rule generalizes — anything
placed in glass coordinates must say so, because "glass" is the exception
and world content is the default.

Interactive grabs (`computeGrabRect`): anchor and deltas are glass-space,
the grabbed rect is world-space — correct while the camera is constant,
so camera policy must not animate an output's camera during an active
grab on it (or must re-anchor the grab). Same rule covers a grab whose
pointer crosses onto an output with a different camera: the grab keeps
its starting camera frame until release.

Capture/compose interplay: output screen-capture (`composeOutput`) renders
through the same per-output context as scanout, so it is camera-correct by
construction; single-window capture (`composeRegion`) is world-space and
correctly camera-independent. The plugin compose APIs (`compose.scene`,
live scenes) capture **world regions** at identity camera — right for
world-rect semantics, but a live view built from `outputRegion(outputId)`
shows the output's arrangement slot, not its camera view. When mirror
semantics are needed under non-identity cameras, add an opt-in
"follow output N's camera" mode that refreshes the synthetic context per
frame. Same caveat for transition FROM/TO snapshots (moot in the canvas
end-state, where camera moves replace snapshot transitions).

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
- **Fixed islands** compress on overflow (the layout divides a
  workarea-sized rect — master-stack rows get thinner). **Elastic
  islands** grow along their anchored axis and the docked camera scrolls
  within them (niri strip). One flag, per island — and strictly a sizing
  flag: growth never selects the algorithm (see "Layout mode is
  declared" below).
- Cameras **dock** to islands (pin to origin/framing exactly) rather than
  free-pan near them; free panning is for traveling and floating-window
  territory. Docked-on-a-fixed-island is pixel-identical to a workspace.

**Layout mode is declared; growth only sizes the region.** The full
provider registry is future work, but its first consequence binds now:
WHICH algorithm tiles an island is declared configuration
(`layout.mode`), and the island's growth flag never selects it — growth
only decides what region the algorithm receives. The two compose:

- `columns` + elastic = the niri strip: fixed-width columns, island rect
  = the layout's natural size, docked camera scrolls within it.
- `columns` + fixed = even-split: the same column widths compressed
  proportionally into the workarea. The "even-split" primitive above is
  columns under fixed growth, not a second algorithm.
- `master-stack` + elastic = inert growth: master-stack's natural size
  IS the workarea (it always fits), so the island simply never grows.
  Valid, not an error.

Config: `layout: { mode: "master-stack" | "columns", gap }` plus
mode-specific params — `masterFraction` (master-stack) or `column`, the
default column-width fraction (columns). `canvas.workspaces[].layout`
(`{ mode, column? }`) overrides per name; `workspace.set-layout
{index?, output?, mode?, column?}` overrides one island at runtime
(omit `mode` to clear the override). `workspace.set-elastic` stays pure
growth (boolean only — the `{ column }` form retires into the layout
config, with no compatibility sugar; `canvas.elastic` sets the growth
default and nothing else).

Sizing contract: the provider gains `measure(inputs) -> { width,
height }` — its natural size for these members in this workarea. An
elastic island's rect is the measure result (anchored per §6); a fixed
island's rect is the workarea. The canvas plugin neither computes strip
geometry itself nor injects a layout hint: a canvas-side count × column
computation would duplicate the layout's own arithmetic, and two owners
of one geometry is exactly how the modes drift apart.

The declared mode also picks WHICH END a newly mapped window joins,
because the member list is the layout's order and the two modes read it
oppositely: master-stack's head is its master slot, where a new window
belongs, while in columns the head is the leftmost column — the oldest
window — so a new window belongs at the TAIL and the strip reads left to
right in the order things opened. The island source resolves the end
from the island's declared mode and hands it to the registry, which owns
member order but knows nothing of layout; a registry that always
unshifts is a master-stack assumption baked into a layout-agnostic
component, and it put every new column on the far left of the strip.

Columns mode: one window per column is an invariant (vertical division
belongs to master-stack or a future stack primitive). Column widths are
per-window provider state — seeded from `column`, keyed by window id so
widths follow reorders, pruned when the window leaves the island.
`layout.grow-column` / `layout.shrink-column { surfaceId? }` (default:
the focused window) adjust one width through `setParams({ surfaceId,
widthDelta })`, the same plumbing shape as the master-fraction actions.
Under elastic growth a width change changes the measure and shoves
neighbors (§6); under fixed growth it changes the ratios within the
workarea. The invariant this restores: every mode × growth combination
keeps a live, user-visible size knob — an elastic island is never more
restrictive than a fixed one. (Params other than per-window widths —
`masterFraction`, `gap` — remain provider-global until the registry
lands: a fraction tweak still applies to every master-stack island at
once.)

A column's fraction is its share of the workarea PITCH — the glass it
occupies *including* its gap allotment — so the measure is Σ widths,
with the gaps carved out of the columns rather than added around them.
That is what makes N columns of 1/N tile the glass exactly: the
everyday two-windows-side-by-side case must leave nothing offscreen.
Measuring Σ widths + gaps instead puts every such pair 3 × gap past the
viewport edge, and the camera scrolls a strip that plainly fits. The
trade is that a column is fractionally narrower than `column ×
workarea` once gap > 0 — the same one master-stack makes, where the gap
eats the tiles, not the screen.

**Client size constraints bound the column, not the fraction.** A window
below its declared minimum is often not merely ugly but unusable, so in
columns mode `min/max width` is a hard bound and `column` is the
preference that fills what the bounds leave. Allocation is a water-fill:
bounded columns pin to their bound, the remainder re-divides among the
rest by weight, and a `min` that exceeds a `max` resolves to `min` (a
window that cannot shrink further wins over one that would rather be
smaller). Constraints reach the provider through `MeasureInputs.windows[]`
as well as `compute()` — measuring without them sizes a strip the
provider's own `compute()` then overflows.

Only WIDTH is expressible here, and that is the mode's shape rather than
an omission: one window per column means every column is full-height, so
a height floor has nowhere to go. Growth decides what happens when the
floors do not fit: elastic seats them exactly and the strip grows past
the glass (the camera scrolls — this is the *only* case where two windows
legitimately leave the viewport, and it is the client's own floor asking
for it, not the compositor wasting space), while fixed has no such room
and squeezes proportionally *inside* the island, since an island that
overflowed its workarea would overlap its neighbors in the world. A
`max` never forces either: the slack is absorbed by neighboring columns
rather than left as dead glass.

**The focused column's position in the strip picks its alignment.** A
strip wider than the glass means the docked camera chooses what sits
beside the focus, and the choice is the user's only evidence of what
exists off-view. A column with strip on BOTH sides is therefore
CENTERED, splitting the slack so each neighbor peeks in; a head or tail
column sits flush to the side that has strip in it, spending the slack
where there is something to show rather than on void. Revealing a column
flush against the edge it came from instead — the minimal scroll — hides
whatever is past that edge and gives no hint it is there at all, which
under follow-pointer focus makes it unreachable: there is nothing on
screen to aim at, so the neighbor can only be reached by fit, pan, or a
keyboard cycle. A column wider than the view can satisfy neither rule;
its left edge wins.

Visibility: `setOutputStack` semantics invert from "the shown workspace's
members" to "everything near the camera's view rect" (with margin for
pan). The camera + per-output scissor culls; windows far off-view are
omitted from the stack entirely. `pushStack` gating (exclusive-window
suppression etc.) keys on islands-in-view rather than the per-window
output cache.

**Hidden means hidden** (LANDED): visibility is explicit stack state, not
a geometric accident -- a camera roaming over a hidden island's world
position shows void, and residency agrees: `surfaceVisibleOutputs`
(stack membership ∩ camera-view geometry) drives `wl_surface.enter/
leave` + preferred scale, so hidden-workspace windows get leave and
truthfully reside nowhere. Frame pacing keeps the ungated geometric
`surfaceOutputs` so a hidden client still receives `wl_callback.done`
(clients that block on `done` before committing must not deadlock).
Distinct from hidden is merely UNVIEWED (no camera there, world-visible
when one roams past -- e.g. an orphaned island); the plugin decides
which state an island is in via what it stacks.

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

**The grid's wrap is width-aware, and it is the one thing that repacks.**
Under `arrangement: "grid"` the wrap column is chosen so the world's
overall bounds land as close to the output's aspect as they can — try
every row count, fill greedily in slot order, keep the packing whose
bounds-aspect misses the screen's by the least (compared in log space, so
too-wide and too-tall are judged alike). Wrapping on COUNT instead
(~sqrt(N)) silently assumes every island is one screen wide; elastic
strips break that, and a 3×-wide island counts as one cell while eating
three, so `workspace.fit` frames a ribbon and wastes the glass the grid
exists to save.

This has to react to GROWTH, not just to the island set, and that is the
concession to §6's "never repack": a workspace is workarea-wide the
moment it is created and only becomes a long strip as it fills, so a wrap
frozen at creation would pack every strip as though it were narrow — the
exact waste the grid is for. A repack can therefore move a bystander
island to another row, which a monotone shove never does. Two things keep
it from thrashing: rows are STICKY (the packing is re-adopted only when it
beats the current one by a margin, so one more window in an already-wide
island changes nothing while a strip doubling in length rewraps), and slot
order is untouched — a repack re-flows the same sequence, so "comms is
before code" survives even when "left of" becomes "above". Within a row,
growth still shoves, and rows stay independent.

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

## 7b. X11 and the 16-bit world

X11 coordinates are int16 (±32767); a world that sprawls past that breaks
X clients if their X-visible positions are world positions. Answer:
**X space is a maintained fiction, not world space** -- built BEFORE
world positions ship (a step-4 prerequisite), not retrofitted. (A
"confine X-containing islands to an origin district" interim was
considered and rejected: it is throwaway policy code in the arrangement
solver -- constraint tracking, shove exclusions, move-rejection UX --
that costs more than the fiction it defers. Its residue is a safety
clamp: if a told coordinate would ever exceed int16, clamp and log
loudly rather than let X wrap silently.)

The XWM tells X clients GLASS positions (world minus the owning output's
camera): bounded by the physical arrangement, always int16-safe, and
consistent for everything X uses root coords for (override-redirect
menus relative to the parent's believed position, sibling placement --
relative offsets in glass equal what the user sees, and pointer root
coords are synthesized from the told positions). OR-window world
positions derive by the inverse mapping. Re-tell positions on camera
settle (not per pan frame). Precedent: the HiDPI `xwaylandScale`
fiction already translates X coordinates specially (xwayland-design.md).

LANDED (`xwayland/glass-map.ts`): the chart is the camera of the
lowest-id output that SHOWS the window (stack-gated residency), falling
back to geometric overlap -- so a hidden window keeps being told
coordinates in its last home's frame (retained fiction; the structured
per-island attic arrives with world positions). Outbound: the configure
sink + the XWM's ConfigureRequest reply map world -> glass -> X-device,
int16 clamp-and-log. Inbound: override-redirect placements invert
through the containing output's camera, so overlays land at WORLD
positions and pan with their openers. Re-tell triggers:
`state.xwm.retellPositions()` on camera change and on stack-visibility
change (idempotent; skips unmoved windows). Chart cameras are pan-only
(zoom treated as 1) per the rule above. GPU test
(`xwayland-camera.gpu.mjs`): camera pan re-narrates the told position
via synthetic ConfigureNotify; identity restores.

  **Unviewed windows** (island shown on no camera) have no glass
  position, and don't need a true one: a hidden window's told position
  is dormant -- interaction requires visibility, and the show path
  re-tells real coords first. Park hidden ISLANDS (not windows) in a
  reserved attic band outside any plausible arrangement (e.g.
  y >= 20000): each hidden island gets a deterministic slot, each member
  is told slot origin + its island-relative offset. That keeps
  intra-island relative geometry valid for multi-window X apps, is
  deterministic for windows spawned directly onto hidden islands, and
  never overlaps live glass or contains the pointer. (Today's model
  already tolerates the degenerate version -- hidden-workspace X
  windows keep stale in-arrangement coords overlapping the shown
  workspace -- so the attic tidies an accepted fiction rather than
  fixing a new fragility.)

**Doubly-viewed windows** (two cameras on the same island -- overlapping
cameras are legal, §8) have two glass positions but can be told only
one. Resolution: each island has a designated **chart** camera (e.g. the
lowest-id viewer, re-designated + re-told when it goes away), used for
BOTH directions -- outbound ConfigureNotify positions and inbound
ConfigureRequest / override-redirect coordinates. This is sufficient
because X clients can never observe physical glass from inside the X
connection; everything they do with root coordinates is relative
arithmetic against other told coordinates (menus at parent+offset,
sibling placement, pointer root coords synthesized from told+local). A
click on the non-chart copy delivers identical per-surface events; a
menu placed via the chart's inverse mapping lands at the correct world
position and renders on both viewers. Windows on the same island always
share a chart, so intra-island relative geometry stays valid;
cross-island X geometry is already fictional (see the attic).

(The straddling variant -- one window half on each of two disagreeing
cameras -- still does not arise: independent cameras clip at their
edges, §8.)

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

- Urgency and names pass straight through; click-to-activate = fly/dock a
  camera. `activate` semantics are explicitly compositor-defined in the
  spec ("may or may not deactivate all other workspaces in the same
  group"), so docking a camera is a conforming interpretation.
- **Activate needs a "which camera" answer** (groups are per-output;
  islands are global), and the protocol constrains the options: a
  workspace may belong to **at most one group at a time** (re-assignable;
  `ext-workspace-v1.xml` `workspace_enter`), and waybar's `ext/workspaces`
  module (defaults: `all-outputs=false`) shows only workspaces whose
  group has entered the bar's output and **hides group-less workspaces
  entirely**. So: sharing one workspace object across groups is
  spec-illegal, and dynamic re-assignment would make un-viewed islands
  vanish from every bar. The conforming mapping is **per-group duplicate
  workspace objects** — one handle per (island × output group). Each bar
  shows its own group's set once; clicking sends `activate` on that
  group's duplicate, which identifies the output whose camera should
  dock. Waybar does not deduplicate across groups, which is exactly right
  here; the only cosmetic caveat is `all-outputs=true` would render one
  button per (island × group), which is honest if unusual. Duplication
  is gated on the island's output affinity (§10b): only `affinity:
  none` islands duplicate into every group; homed islands (`preferred`
  / `pinned`) advertise only in their home group while it is connected,
  so per-monitor bars keep their disjoint traditional lists and a
  disconnect migrates the orphans to a surviving group.
- The workspace `id` event is defined as stable across sessions — a
  natural carrier for durable island identity (suffixed per group so
  duplicate handles keep unique ids; waybar sorts within one group, so
  a uniform per-group suffix doesn't perturb order).
- The `coordinates` event organizes workspaces as an N-dimensional grid
  per group (unique coords per group, uint32) — the adapter can advertise
  normalized island world positions, and spatially-aware clients can
  sort/render by them (`sort-by-coordinates` in waybar).
- The `hidden` state bit lets scratch/unnamed islands be advertised but
  not displayed, if hygiene policy wants them enumerable.
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

## 10b. De-workspacing core (the model-level retirement pass)

Standing rule: **the word "workspace" must not appear in core.** It is
purely a plugin concept; any core occurrence is a bug. The façade in
§10 keeps behavior stable, but the names and shapes it hangs off are
still workspace-flavored. This pass renames the seams and retires the
APIs whose semantics the canvas model supersedes. It was deferred until
the questions it depended on (hidden semantics, zoom-as-z,
pointer/camera separation) were settled; all three now are.

Renames (behavior-preserving):

- The `"workspace"` **namespace role** in core dispatch
  (`invokeNamespace("workspace", ...)`, `state.workspaceDriver`) gets a
  model-neutral name (candidate: `organizer`; the role is "the plugin
  that decides what each output shows"). The plugin keeps registering
  the old name as an alias while configs migrate.
- The `currentWorkspace` **config ref** gets a neutral name with the
  old one as a deprecated alias; its backing `workspace.shown` bus
  subscription follows whatever event vocabulary the organizer role
  standardizes.
- **Comment scrub**: core comments that explain themselves in workspace
  terms get rewritten in stack/island/camera terms.
- Exception, by design: `protocols/ext_workspace_v1.ts` keeps its name
  and vocabulary — it implements a wire protocol literally called
  ext-workspace; that is the protocol's name, not a core concept.

Retirements (semantics superseded by the model):

- **`WorkspaceIndex` as a public identifier.** Per-output positional
  indices are a projection for bars and keybinds, not identity. Island
  ids / names become the durable references; index-shaped verbs survive
  only inside the façade.
- **`ensureOutput`.** "Make sure this output has a workspace" becomes
  "the island this output's camera frames, creating one if none" — a
  camera question, not an output-provisioning verb.
- **`preferredOutputs` migration records.** Hotplug re-homing keyed on
  durable output identity is superseded by camera persistence (§8):
  hotplug records store island refs + camera framings; windows never
  move, cameras do. RE-EXPRESSED, not deleted: output affinity is a
  feature users of the traditional model actively want, so the
  MECHANISM (migration records) retires while the POLICY survives as
  a per-island affinity constraint on camera docking -- `none` (free
  canvas island, any camera), `preferred` (today's default: soft
  homing; other cameras may view it, and it falls back to live
  outputs while its home is unplugged, reclaiming on replug), or
  `pinned` (dockable only by its home output's camera while that
  output is connected; unplugging relaxes it to the fallback
  behavior). One piece of "home" is IRREDUCIBLE and survives even
  full dissolution: every island needs exactly one SIZING AUTHORITY
  -- the workarea that shapes its rect, layout, and elastic column
  width (`contextOutputId` in the driver; content has concrete pixel
  geometry, and you cannot lay out for two workareas at once). A
  camera from a differently-sized output can only VISIT (fit-zoom the
  whole island at < 1.0, or dock at 1.0 and crop/scroll -- the
  elastic-strip scroll generalized to both axes); making the content
  actually fit that glass means ADOPTING the island, i.e. moving its
  home so it re-lays-out to the new workarea. Affinity is therefore
  "how mobile the home is" (`pinned` = never adopted away, protecting
  e.g. an ultrawide layout from a smaller adopter), never "whether a
  home exists". Declared per workspace (a `canvas.workspaces` field,
  next to `output`); `none` is always EXPLICIT -- an entry that omits
  `output` still homes where it is created with `preferred` affinity,
  so traditional configs never fall into all-bars projection by
  omission. The ext-workspace projection follows it: an
  island with a home (`preferred` or `pinned`) advertises ONLY in its
  home output's group while that output is connected -- per-output
  bars keep showing disjoint per-monitor lists, and a disconnect
  migrates the orphans into a surviving output's group (today's
  behavior, preserved) -- while §9's per-group duplicate handles
  apply only to `affinity: none` islands. The naive "duplicate every
  island into every group" projection would erase the per-monitor
  bar separation traditional users rely on; duplicates are the
  opt-in, not the default.
- **Spawn-output assignment as ownership.** The map-event `outputId`
  becomes a placement HINT (which island's region the window lands in);
  placement rules target islands/bookmarks (§7), not outputs.
- **Per-output state shapes**: `outputContent` / `outputOf` and the
  exclusive-window suppression keys scoped per-output move to
  island-scoped equivalents (`LayoutIsland` already scopes exclusive
  ownership; the per-output forms remain as the implicit-island
  degenerate case).
- **`focusedOutputIdCache`** in the organizer plugin: derivable from
  focus + camera framing; retire the cache once island refs make the
  derivation cheap.
- **ext-workspace groups**: the per-output group projection is replaced
  by the per-group duplicate-handle scheme (§9) once islands roam.

Sequencing: renames can land any time (pure churn, zero behavior);
retirements land with the features that supersede them (camera
persistence retires `preferredOutputs`; roaming retires the per-output
shapes; placement rules retire spawn-ownership).

## 11. Sequencing — behavior-intact first, policy later

The first two steps land in core with **zero behavior change** (identity
defaults), which is the point: establish that every mapping site honors
the mechanism while nothing exercises it, with non-identity covered by
tests only.

1. **Camera term in core, identity default.** LANDED, including the
   zoom term: the camera is (x, y, zoom), applied at all five mapping
   sites (§4) gated to content surfaces, plus pointer-constraint regions
   and popup constraint boxes; input generalizes through
   `SeatViewTransform` (glass<->world with zoom); SDK setter
   (`sdk.windows.setOutputCamera(outputId, x, y, zoom?)`); full-output
   damage on camera change; `query()` exposes per-output camera. GPU
   tests (`output-camera.gpu.mjs`): pan and zoom each shift/scale
   content + hit-testing while a layer panel stays anchored; identity
   restores repaint. Zoom is compositor-side optics (clients render at
   real size; fx translate/margins stay glass-space); X told-coordinates
   use pan-only charts (§7b). Camera motion is an in-core animation
   evaluator target (`{kind: "output-camera", outputId}`, tween or
   spring on x/y/zoom): per-frame writes are TRANSIENT (they update
   render/damage/input and the `state.outputCameras` mirror but defer
   the residency sweep + X re-narration to the mover's one settled
   write at arrival), and the animations broker's `cameraGate` denies
   camera runs during interactive grabs/drags.
2. **Island object in core.** LANDED. The layout-driver iterates
   `LayoutIsland`s ({id, outputId, rect | null, members}); the WM derives
   one implicit island per output (rect = null -> output minus reserved
   zones) from the workspace plugin's per-output content; explicit
   islands pass their rect verbatim and scope exclusive-window ownership
   to the island. `LayoutInputs.island` identifies the pass; existing
   layout plugins work unchanged. Unit tests:
   `layout-driver-islands.test.js`. No explicit-island producer exists
   yet -- that arrives with the canvas plugin (step 3).
3. **`plugin-canvas` in workspace-parity mode.** LANDED.
   `@overdraw/plugin-canvas` claims the `'workspace'` namespace with the
   identical verb/event/action surface (it shares
   plugin-workspace-default's registry via the `./registry` subpath
   export; index wiring is a fork), and publishes each output's shown
   workspace as an explicit island (id = the workspace's durable handle,
   rect = null, members = the pushed stack) through the new
   `sdk.windows.setIslands` -> `wm.setIslands` seam. Cameras stay
   identity (nothing to dock while every island's region equals its
   output). Opt-in: a `canvas: {}` slice in config.mjs swaps it in for
   workspace-default (`selectBundledPlugins`). Validated by the
   workspace GPU flow re-run against it
   (`test/plugin-canvas/canvas-parity.gpu.mjs`) + an integration suite
   asserting verb/event parity and island publication.
4. **Canvas features** (all policy, all incremental from parity).
   LANDED so far -- **world slots (rows model)**, opt-in via
   `canvas: { world: true }`: every workspace publishes as an island at
   a world rect along its output's row (islands are WORKAREA-sized --
   the viewport minus reserved zones -- and packed with only
   `canvas.gutter` between them; slots per-handle, freed on destroy,
   collision-resolved after hotplug migration); hidden members lay out
   at their slots (pre-sized on show) while the draw stack gates
   visibility; `show` docks the camera so the island origin lands at
   the WORKAREA origin -- the bar lives on the lens, not in the world:
   reserved zones never carve explicit island rects (the layout driver
   uses them verbatim; only implicit rect-null islands derive
   output-minus-zones), the world carries no dead bands, and zone
   changes (`output.workarea-changed`, emitted by the reserved-zone
   registry's onChange hook) resize islands + re-dock cameras. A
   fullscreen member of an explicit island covers the full glass (the
   driver shifts the island origin back by the workarea offset at
   output size); hidden X windows are narrated in
   their ISLAND FRAME (glass-map.ts: the camera that would show them),
   staying int16-safe at any slot distance. Camera changes sweep
   residency + X narration via a core-side single-method patch (the
   stack sweep alone ran before the dock landed). GPU test:
   `plugin-canvas/canvas-world.gpu.mjs`.
   ALSO LANDED -- **camera flights**: `workspace.show` with a
   `transition` in world mode flies the camera to the destination slot
   (a tween on the evaluator's `output-camera` target; the transition's
   duration + easing carry over; the snapshot `kind` vocabulary is
   irrelevant to a real camera move and is ignored). The registry truth
   flips at takeoff (bar highlight, workspace.shown/hidden, focus
   policy see the destination immediately); the union of departure +
   destination stacks rides the output for the journey so the world
   slides by instead of a void; settle = destination stack + one
   settled camera write (residency sweep, X re-narration, pointer
   repick) + the deferred focus decision. A newer show preempts the
   flight (the loser abandons its settle; the winner tweens from the
   live mid-flight camera via `windows.get-output-camera`); an instant
   show cancels it. Flights denied during grabs/drags (the broker's
   cameraGate) fall back to an instant dock.
   ALSO LANDED -- **fit zoom** (`workspace.fit` / `workspace.unfit`):
   fit optically zooms the camera out to frame a consecutive workspace
   range (start/end per-output positions, defaults first..last;
   centered + letterboxed on the slots' bounding box). The camera and
   stack hold the framing: the union of the framed workspaces' members
   rides the draw stack (so they composite and gain residency) and is
   maintained across structural changes; the framing re-solves on
   membership/geometry change. While fitted every framed window is
   focusable and the SHOWN workspace follows focus (bar highlight =
   what the user selected) without moving the optics. Any show on the
   output exits the fit; unfit zooms back in (default target the
   focused window's workspace, else the shown one -- optics-only when
   already shown, a show otherwise). Both accept a `transition
   {duration, easing?}` camera tween with the flight machinery's
   preemption/instant-fallback semantics. GPU test:
   `plugin-canvas/canvas-fit.gpu.mjs`.
   ALSO LANDED -- **free roaming + bookmarks**: `workspace.pan {dx,
   dy}` / `workspace.zoom {factor}` (keyboard verbs) and the
   `workspace.pan-grab` / `pan-grab-end` drag gesture (a held button
   pans the camera 1:1 through `sdk.windows.beginCameraPan` /
   `endCameraPan`; GPU test `plugin-canvas/canvas-drag-pan.gpu.mjs`)
   park the camera at arbitrary world framings through the same
   per-output camera-override state as fit.
   While overridden, every workspace on the output rides the draw
   stack -- the plugin's roaming answer to §5's hidden-vs-unviewed
   choice: everything is viewable while traveling -- the shown
   workspace follows focus, and structural changes never move a parked
   free camera (fit framings re-solve). Bookmarks name camera framings
   (§2): `bookmark-set` captures what the camera is doing (dock ->
   island ref, fit -> handle range, roam -> raw rect+zoom, the
   sanctioned raw-coordinate holder), `bookmark-go` replays through
   show / fit / free-park respectively (flown with a `transition`);
   `bookmark-delete` / `bookmark-list` manage them. Config
   `canvas.bookmarks` entries re-seed each start and reference
   workspaces by NAME, resolved at go time (create-on-reference);
   runtime bookmarks are session-scoped. Unit coverage in
   `plugin-canvas/integration.test.js`; GPU roam test in
   `canvas-fit.gpu.mjs`.
   ALSO LANDED -- **elastic islands**, per workspace (§2's one flag
   per island): config `canvas.elastic` sets the DEFAULT (`true` /
   `{ column }` = all elastic; `{ default: false, column }` = fixed
   unless opted in) and `workspace.set-elastic {index?, output?,
   elastic?}` overrides one workspace at runtime (omit `elastic` to
   toggle; index defaults to the shown workspace; overrides are
   session-scoped). An elastic island grows along its row -- one
   column of `column` × workarea width (default 0.5) per visible
   managed member; floating members take none, and an exclusive member
   collapses the strip to the workarea (maximize covers the usable
   glass, not the strip). Members tile as equal full-height columns via a
   per-island layout HINT (`LayoutIsland.layout`, passed through
   verbatim to `LayoutInputs.island.layout`; the bundled provider
   recognizes `{ mode: "columns" }`) -- a deliberate small step toward
   §5's per-island providers. The row arrangement generalizes from
   fixed slot pitch to cumulative origins in sticky slot order, so a
   growing island SHOVES its right-hand neighbors (monotone,
   order-preserving -- §6's shove, scoped to one row; docked cameras
   follow automatically). The docked camera scrolls within the strip
   to keep the focused window visible (per-workspace scroll offset,
   clamped on use; triggered by focus changes and by the focused
   window's retiles via stack.relayout). Landing this exposed and
   fixed a frame-pacing gap: surfaces outside EVERY camera view got no
   wl_callback.done at all ("wait until it re-enters an output"),
   deadlocking off-view clients that block on done before committing a
   resize -- §5's pacing promise now holds: off-view callbacks ride
   any output's flip-complete, and a fully idle compositor forces one
   flip. GPU test: `plugin-canvas/canvas-elastic.gpu.mjs`.
   GAP (superseded by §5 "Layout mode is declared; growth only sizes
   the region"): the landed strip keys the ALGORITHM off the growth
   flag -- elastic injects the columns hint, so the `layout` config
   block silently stops meaning master-stack, `masterFraction` and the
   grow/shrink-master actions no-op on strips, and columns are uniform
   with no runtime width knob at all (the column fraction is
   config-only; `set-elastic` takes a boolean). `elasticWidth` also
   duplicates the layout's geometry canvas-side. The §5 contract
   (explicit `layout.mode`, `measure`, per-column widths +
   grow/shrink-column, `workspace.set-layout`) replaces this; the
   `canvas.elastic: { column }` config form goes away with it.
   ALSO LANDED -- **drag-pan** (the pointer gesture for free roaming):
   a third seat grab kind, `camera-pan` -- while it holds, pointer
   motion pans the output's camera 1:1 (content follows the hand;
   glass deltas / zoom -> world) as TRANSIENT writes with no client
   delivery and no per-frame repick; endGrab sends the one settled
   write and repicks, since the world moved under a stationary
   pointer. This is the one grab that IS camera motion, inverting §4's
   "no camera animation during a grab" -- which still holds for
   animations (the broker's cameraGate denies flights while any grab,
   including this one, is active; two camera writers would fight).
   Exposed as `sdk.windows.beginCameraPan/endCameraPan`; the canvas
   plugin's `workspace.pan-grab` (bind with releaseAction:
   `workspace.pan-grab-end`) enters the free-roaming override (union
   stack) at the current camera and hands the pointer to the grab,
   backing out cleanly when another grab owns the pointer. GPU test:
   `plugin-canvas/canvas-drag-pan.gpu.mjs`.
   ALSO LANDED -- **empty-island backdrops**: islands with no members
   draw a translucent world-space quad (a compositor-private 1x1
   colored surface stretched to the island rect, inserted at the
   bottom of the content segment -- above wallpaper, below windows --
   and camera-mapped, so it pans/zooms with the island). Empty
   (typically persistent) workspaces read as places instead of void
   while fitted or roaming. `canvas.islandBackdrop` sets the color
   (`#rrggbb[aa]`, default a faint gray; `false` disables). Sink
   surface via `setIslandBackdrops` (windows.set-island-backdrops);
   backdrops are render-only -- not hit-testable, no residency.
   ALSO LANDED -- **membership on drag** (§3's third membership
   trigger): a move grab's release emits `window.drag-dropped` with
   the pointer's WORLD position (through the content camera, so drops
   land where the cursor points while fitted/roaming) and whether the
   window was tiled before the grab floated it. TILED STAYS TILED: a
   previously-tiled window re-tiles wherever it drops -- into another
   island (re-parent), at the drop position within its own island's
   member order (rearrange past a neighbor; `reorder`'s
   `{ moveToIndex }` op, index from a horizontal-flow half-plane
   heuristic against the hit window's rect -- a layout-owned
   drop-index query is future work), or back into its old slot (void
   drop). Floating is an explicit verb (`window.toggle-floating`,
   core-actions), never a drag side effect; a window the user floated
   stays floating wherever it's dropped, only its membership follows
   the cursor. Island bookmarks also survive evaporation now: they
   capture the workspace's name and degrade to create-on-reference
   when the handle is dead -- closing the last island-hygiene gap.
   ALSO LANDED -- **grid arrangement** (`canvas.arrangement:
   "grid"`; default "rows"): the world-arrangement policy's first
   alternative (§6's rows/grid/freeform). Slots wrap row-major after
   ceil(sqrt(N)) columns, vertical pitch = island (workarea) height +
   gutter, so the gutter reads the same on both axes;
   fit frames the 2D bounds (near-square block, so the overview zoom
   wastes far less glass on wide monitors than the filmstrip), docks
   move the camera on both axes, and elastic shove stays scoped to an
   island's own grid row. Not yet pluggable -- a config switch between
   two built-in policies; the §6 recursion (arrangement as a
   layout-shaped compute) remains future work.
   ALSO LANDED -- **declarative workspaces** (`canvas.workspaces`):
   config entries `{ name, output?, persistent?, elastic? }` declare
   named workspaces that exist from boot -- persistent by default (a
   declared workspace shouldn't evaporate mid-session), homed on
   `output` when given (also seeded into preferredOutputs for replug),
   with `elastic` declaring growth BY NAME (survives destroy/recreate;
   boolean or `{ column }` for a per-workspace column fraction;
   precedence: runtime set-elastic > declared name > config default).
   Backed by registry-level name idempotence: `workspace.create` with
   a name that already exists anywhere is a no-op returning the
   existing workspace -- named workspaces are stable identities
   (show / rules / bookmarks all resolve by name), and seeding is
   idempotent by construction. This is the config-declaration answer
   to persistence: restart resets the world (clients die with the
   compositor), so durable setup is DECLARED, not saved/restored;
   runtime bookmark-set / set-elastic stay deliberately ephemeral.
   ALSO LANDED -- **placement rules targeting workspaces** (§7):
   window rules gain `workspace: "name"` (resolved across all outputs
   by user-set name, digit-handle fallback; created on reference when
   absent -- any name, since a rule is explicit config), `output:
   "DP-1"` (alone = "appear on that monitor, whatever it shows" --
   glass-relative; with a name = where a created workspace homes --
   the §7 home-region intent, and the name keeps resolving while the
   monitor is unplugged), and `show: true` (placement + attention;
   default is quiet -- the shown workspace, camera, and stack never
   move). Mechanically per §7: plugin-window-rules stays the matching
   side and stamps `{name?, output?, show?}` into the window's
   `workspace.place` state-bag key during preconfigure (awaited before
   the map); the canvas plugin's map handler is the placement resolver
   that consumes the one-shot hint, assigning membership via the
   registry's `applyMapAt` (direct-to-handle; no transient stack on
   the spawn workspace). Unruled spawns stay camera-relative ("open
   where I'm looking"). With plugin-workspace-default the hint is
   inert. GPU test: `plugin-canvas/canvas-placement.gpu.mjs`.
   NOT yet: bookmark advertising on the bar
   (§12's islands-vs-bookmarks question); rules targeting BOOKMARKS
   (rules name workspaces today; a bookmark target adds camera
   framings); fly-to attention (rule `show` docks instantly; no
   transition plumbing in rules yet); gutters + shove beyond the
   per-row arrangement; hotplug camera
   persistence/rescue; overview UX (an interactive picker/gesture on
   top of the landed fit-zoom optics);
   camera-following compose/live scenes (§4: a live view built from
   `outputRegion(outputId)` needs a "follow output N's camera" mode);
   ext-workspace per-group duplicate-handle projection (§9, needed once
   islands roam across outputs); the de-workspacing renames/retirements
   (§10b, each landing with the feature that supersedes it).
5. **Later**: true zoom via fractional-scale -- with a structural
   constraint: fractional scale is a SURFACE property (one buffer, one
   scale), so simultaneous viewers at different zooms cannot all be
   native-crisp. The workable shape: negotiate each surface to the MAX
   effective scale across its viewing cameras (zoom × output scale) --
   the most-zoomed-in viewer is crisp, everyone else minifies a
   higher-res buffer (supersampling; the bad direction, upscaling,
   never occurs under max) -- and renegotiate only on SETTLED camera
   writes (transient writes during pans/tweens stay optical; a
   per-frame scale change would be a client re-render storm). The
   dominant case (a docked island's single camera) gets full true
   zoom. Lifting the constraint outright would take a NEW protocol
   (per-view rendering: a client submits distinct buffers per
   compositor-declared view/scale) -- technically possible, but it
   only pays off once toolkits adopt it, so it is an ecosystem bet,
   not a design dependency; max-over-viewers is the plan of record.
   Also later: snap clusters / bezel-spanning; per-island layout
   providers (layout registry); world-arrangement pluggability.

Steps 1–2 are useful even if the canvas never ships: the camera subsumes
slide transitions, and islands give reserved-zone/region handling a
first-class object.

## 12. Open questions

- **Islands vs. bookmarks in ext-workspace**: RESOLVED -- advertise
  every island, each in its affinity-appropriate group(s) (§10b: homed
  islands in their home output's group only while it is connected --
  one bar; `affinity: none` islands in every group via duplicate
  handles). No island is ever group-less/invisible-everywhere.
  "Scratch" has no members in the current model: every
  user-created workspace is named (create-on-reference stores digit
  names), the unnamed ones (boot, hotplug donor) are either shown or
  holding windows and must display, and unnamed+hidden+empty
  evaporates before it could clutter a bar. The `hidden` state bit
  stays shelved until some feature mints unnamed islands that
  deliberately linger.
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
