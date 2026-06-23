# overdraw — XWayland design

Rootless Xwayland under overdraw. Ground-truth status lives in
`docs/status.md`; this doc captures design rationale that outlives any one
slice and the future work (clipboard, DnD, polish) that has not yet
landed.

The governing constraint, set by the codebase: **xcb/X11 code and Wayland
code never share a file.** The Wayland server, trampoline, and protocol
handlers are already large; X11 is a second, unrelated wire protocol. The
two meet only at narrow, typed seams (the configure-sink router in
`protocols/index.ts`, the focus driver, the data-device), never inside one
another's source files. xcb sources live under `native/xwayland/` and the
TS XWM under `src/xwayland/`.

## What is built

Phases 0-3 are landed; see `docs/status.md` for the per-feature summary
and the (small) known limitations. The code itself is the source of
truth — refer to:

- `native/xwayland/server.cpp` — fork/exec rootless Xwayland, `-displayfd`
  readiness.
- `native/xwayland/xwm.cpp` — xcb connection, atom interning, event
  decode, the bookkeeper window, ICCCM/EWMH writers
  (`xwmChangeProperty`, `xwmDeleteProperty`, `xwmSetInputFocus`,
  `xwmSendWmProtocol`).
- `src/xwayland/xwm.ts` — TS XWM policy (ICCCM/EWMH consumption, focus
  mirror dispatch, override-redirect overlay placement).
- `src/xwayland/focus.ts` — pure-logic ICCCM focus truth table.
- `src/xwayland/properties.ts` — pure-byte ICCCM/EWMH property parsers.
- `src/xwayland/surface.ts` — serial registry for `WL_SURFACE_SERIAL`
  association.
- `src/protocols/xwayland_shell_v1.ts` — the wl-side half of association.

Production wiring: `config.xwayland.enabled` (default false) opts in;
`config.xwayland.displayNumber` (default 50) selects the X display. The
autopick path (no display arg, `-displayfd` alone) is rejected upstream
in `startXwayland` — it can collide with an existing X session.

## Out of scope

- **Legacy `WL_SURFACE_ID` association.** Advertising `xwayland_shell_v1`
  makes any Xwayland ≥ 23.1 use the serial path exclusively. The legacy
  path is racy (a reused 32-bit wl object id crossing the X socket
  against the wl socket) and resolving it would force
  `wl_client_get_object` — i.e. xcb and Wayland in one file, the thing
  we are avoiding. We pin a ≥ 23.1 minimum (the host has 24.1.10) and
  emit one loud error if a `WL_SURFACE_ID` message ever arrives, rather
  than silently dropping the window.
- **Rootful Xwayland; X RANDR / multi-monitor inside X.** overdraw owns
  outputs.
- **Per-window HiDPI scale.** X has no such concept; see "HiDPI" below.
- **`xwayland-keyboard-grab`** (full-screen game grabs); window icons
  polish; `xcb-res` PID attribution (we use `_NET_WM_PID` instead).

## Enduring design decisions

- **Native = policy-free xcb binding; TS = all XWM policy.** The native
  module owns only the X11 wire: the xcb connection, atom interning,
  request wrappers, and event decode → structured JS. Every convention
  (ICCCM size hints, EWMH state/type, focus model, stacking) is parsed
  and decided in TypeScript, alongside the rest of the WM policy. Same
  native-mechanism / TS-policy seam the whole project uses.
- **Parse property bytes in TS, not native.** `xcb_get_property` returns
  raw `{type, format, data}`; TS interprets it. Keeps native policy-free
  and avoids linking `xcb-icccm` / `xcb-ewmh`.
- **Single libuv loop, no extra thread.** xcb integrates exactly like
  the Wayland server: `uv_poll` on `xcb_get_file_descriptor`, drain
  `xcb_poll_for_event` in the callback, no threadsafe-function
  marshaling.
- **XWM lives in the core process**, not a third process: it shares the
  libuv loop and the focus/selection state, and (for any future
  client-identity need) sits next to the Wayland server.
- **Xwayland connects over `WAYLAND_DISPLAY`, as a normal client.**
  Association is by serial and client-agnostic, so we do not pre-create
  the client via socketpair + `wl_client_create`. The Xwayland spawn
  code never touches the Wayland server.
- **The WM stays protocol-agnostic.** Xwayland windows enter through the
  existing `wm.addWindow` / `propose` / `unmapWindow`. The
  `ConfigureSink` interface (which the WM calls with content-rect + does
  not know about roles) is the router: `protocols/index.ts` constructs
  the sink and branches by `SurfaceRecord.role`. The WM file holds zero
  X knowledge.

## Never block the node thread on Xwayland's progress (a deadlock class)

The node thread *is* the single-threaded Wayland server. Any blocking
native call that waits on something Xwayland can only do by making
Wayland progress will deadlock. Manifestations seen during development:

- A synchronous SIGTERM reap of Xwayland deadlocks against Xwayland's
  Wayland-dependent clean shutdown. Fix: SIGKILL the reap.
- Synchronous `xcb_get_property_reply` would deadlock if Xwayland is
  simultaneously blocked writing to a full Wayland socket. Fix: all
  per-window property reads are async (request returns a cookieId; the
  reply arrives as a `property-reply` XwmEvent). Atom interning at
  startup is the only synchronous reply path — safe because the quiet
  period at connect-time guarantees empty buffers.

When adding new native primitives that involve an xcb reply, default to
async unless you can prove the reply doesn't depend on Xwayland making
Wayland progress.

## HiDPI

X11 has no per-window scale. v1 takes the standard compromise: present
X clients at a single global scale (config-driven), upscaling
non-cooperating clients — correct size, soft at scale > 1, exactly as
overdraw already treats non-scale-aware Wayland clients. Per-window /
per-output fractional scaling of X apps is a known hard limitation
across all compositors. The global-scale knob itself is not wired yet;
v1 ships at scale=1.

## Phase 4 — clipboard / selection bridge

Path: `src/xwayland/selection.ts` (new). Because the native side already
exposes raw `xcb_get_property` / `xcb_change_property` / `xcb_send_event`,
the whole bridge — including the INCR chunk loop driven by `property`
events — lives in TS; no protocol dance forces it into C++ (clipboard is
not a hot path).

Three selections:
- `CLIPBOARD` ↔ `wl_data_device`
- `PRIMARY` ↔ primary selection (`wp_primary_selection_v1`)
- `XdndSelection` — DnD, deferred to Phase 5

### X owns → Wayland pastes

`xfixes-selection` tells us an X client took the selection; we read its
`TARGETS`, mint a `wl_data_source` advertising the mapped MIME types,
and on `wl_data_source.send` issue `convertSelection` + read the result
property (INCR if large) into the Wayland pipe fd.

### Wayland owns → X pastes

Own the X selection on a dedicated selection-owner window (created
alongside the bookkeeper at xwmConnect); answer `selection-request` by
writing the Wayland source's bytes to the requestor's property (INCR
for large), then `sendSelectionNotify`.

### Required additions

- New native dep: `xcb-xfixes` (selection-owner change tracking).
- New atoms: `CLIPBOARD`, `PRIMARY`, `TARGETS`, `INCR`, `TIMESTAMP`,
  `MULTIPLE`, `_XEMBED`, plus MIME-type atoms minted on demand.
- New native primitives: `xwmSetSelectionOwner`, `xwmGetSelectionOwner`,
  `xwmConvertSelection`, `xwmSendSelectionNotify`,
  `xwmXfixesSelectSelectionInput`.
- An X-side selection-owner window (similar shape to the bookkeeper but
  with selection event mask).
- MIME ↔ X target translation table.

INCR is the gnarly part: large transfers chunk via repeated property
writes, signaled by `PropertyNotify`. The state machine fits in TS; the
native side just round-trips `get_property` / `change_property` calls.

## Phase 5 — polish + DnD

- **Xdnd** ↔ `wl_data_device` drag-and-drop. Similar shape to
  selections: X protocol over ClientMessages + properties, all in TS
  over the existing native primitives plus possibly
  `xcb_query_pointer` for cursor-following.
- **`_NET_SUPPORTED`** on the root: list of EWMH atoms we honor.
  Cosmetic for most clients; some bars / desktop helpers read it.
- **`_NET_SUPPORTING_WM_CHECK`** on the root and on the bookkeeper:
  declares the WM is alive. Same audience as `_NET_SUPPORTED`.
- **Startup notification** (`_NET_STARTUP_ID`): match X clients to the
  launcher that spawned them.
- **Window icons** (`_NET_WM_ICON`): expose to plugins.
- **`xwayland-keyboard-grab`**: full-screen games grab the keyboard.
- **HiDPI policy knob.** The global scale config knob proposed in
  "HiDPI" above.
- **WM_STATE**: set `WM_STATE = NormalState` on managed windows,
  `WithdrawnState` on unmapped, `IconicState` on minimized. ICCCM
  §4.1.3.1 requires it; some older clients (libXt-based) won't react
  properly until WM_STATE shows up. Uses the existing
  `xwmChangeProperty` primitive.
- **`_NET_WM_STATE_FOCUSED` read-modify-write.** Phase 3.4 writes the
  whole `_NET_WM_STATE` property with REPLACE when toggling FOCUSED,
  clobbering client-set bits. Properly preserving the existing list
  needs the same async read-then-write pattern the property batch
  uses.

## Open questions (still applicable)

- **`WL_SURFACE_SERIAL` delivery mechanism is unverified.** The
  per-window `FOCUS|PROPERTY` mask selected at CreateNotify is present
  (needed for PropertyNotify/FocusIn anyway) and association works, but
  it has NOT been isolated whether that mask delivers the client-message
  or whether it arrives via root `SUBSTRUCTURE_REDIRECT` regardless.
  Cheap to confirm (drop the mask, see if the serial still arrives).
  Related robustness gap: a serial sent before we select events on a
  freshly-created window would be dropped → silently invisible X window.
  X per-connection ordering (CreateNotify before the message) should
  prevent this, but rapid create/map/destroy is untested; the
  bidirectional pending-match handles a *late* serial, not a *missing*
  one.
- **Eager vs. lazy Xwayland start.** Eager is what we ship. Lazy
  (`-terminate` + socket-activation re-spawn on the next X connection)
  saves idle resources; requires pre-creating the X11 sockets ourselves
  (lock file + unix + abstract + `-listenfd`).
- **Client identity.** v1 connects Xwayland over `WAYLAND_DISPLAY` and
  needs no `wl_client*` handle. Revisit only if sandboxing or legacy
  association is ever wanted (would add a socketpair + `wl_client_create`
  on the Wayland side).

## Testing tier

A new harness tier was added in Phase 1: real Xwayland child + a tiny
purpose-built xcb client (`packages/core/test/x11-test-client.c`). It is
not pure `node --test` (needs the GPU + host Wayland, like the existing
`*.gpu.mjs` tier) and self-skips when Xwayland is absent. Each xwayland
GPU test calls `harness.mjs:nextXDisplay()` to claim a fresh display
number per test (starting at 60), so the suite never collides with
`:0` even when run interactively.

Coverage today: 11 GPU tests (`test/xwayland-*.gpu.mjs`) and ~44 GPU-free
unit tests (`test/xwayland-*.test.js`) across server lifecycle, shell
serial registry, property parsers, configure round-trip, override-
redirect placement, focus mirror, ICCCM truth table, and the resize-tx
buffer-dims-only variant. Phase 4 will add selection-bridge tests at
both tiers (INCR chunking is a unit-testable state machine).
