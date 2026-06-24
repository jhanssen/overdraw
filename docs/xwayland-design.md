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

Phases 0-4 are landed; see `docs/status.md` for the per-feature summary
and the (small) known limitations. The code itself is the source of
truth — refer to:

- `native/xwayland/server.cpp` — fork/exec rootless Xwayland, `-displayfd`
  readiness.
- `native/xwayland/xwm.cpp` — xcb connection, atom interning, event
  decode, the bookkeeper window, ICCCM/EWMH writers
  (`xwmChangeProperty`, `xwmDeleteProperty`, `xwmSetInputFocus`,
  `xwmSendWmProtocol`), selection-bridge primitives (xfixes init +
  `xwmCreateSelectionWindow` / `xwmSetSelectionOwner` /
  `xwmConvertSelection` / `xwmSendSelectionNotify` /
  `xwmXfixesSelectSelectionInput` / `xwmInternAtom` /
  `xwmGetAtomName` / `xwmSelectWindowEvents`).
- `src/xwayland/xwm.ts` — TS XWM policy (ICCCM/EWMH consumption, focus
  mirror dispatch, override-redirect overlay placement, selection
  hook dispatch).
- `src/xwayland/focus.ts` — pure-logic ICCCM focus truth table.
- `src/xwayland/properties.ts` — pure-byte ICCCM/EWMH property parsers.
- `src/xwayland/surface.ts` — serial registry for `WL_SURFACE_SERIAL`
  association.
- `src/xwayland/selection.ts` — CLIPBOARD / PRIMARY selection bridge.
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

X11 has no per-window scale. overdraw takes the single-global-integer
compromise that every Xwayland-hosting compositor lands on. Per-window /
per-output fractional scaling of X apps is a known hard limitation
across the ecosystem and is out of scope.

**Effective scale.** One integer per Xwayland session, in `[1,3]`. The
config knob `config.xwayland.scale` selects it:

- `0` (default) → auto: `ceil(max(output.scale))` over the outputs
  present when Xwayland starts.
- `1..3` → explicit override.

The scale is computed once at Xwayland start and frozen for the session.
Output hotplug after start changes nothing on the X side: a new monitor
with a higher scale leaves X clients soft on that monitor until Xwayland
is restarted. Restart-on-scale-change is intentionally not wired — it
would kill every X client, which is more disruptive than the blur.

**What "effective scale = N" means on the wire (path A — the only path
implemented).** The X client sees an oversized world. The compositor
lies to it about pixel sizes and coordinates by a factor of N; the X
client renders into a buffer of that oversized size; the compositor
treats that buffer as a wayland surface with `bufferScale = N` so the
existing composite path renders it at the right *logical* size. The
seams:

- **Configure to X.** The WM-chosen logical rect `(x, y, w, h)` is
  multiplied by N before reaching `xwmConfigureWindow` /
  `xwmSendConfigureNotify`. X clients react by drawing at `N*w × N*h`.
- **X surface bufferScale.** On surface association
  (`xwayland_shell_v1.set_serial`), the wl surface is forced to
  `bufferScale = N`. X clients never call `wl_surface.set_buffer_scale`;
  the compositor sets it synthetically. The existing composite path
  divides buffer dims by `bufferScale` to get intrinsic logical size,
  so the oversized X buffer ends up drawn at the correct logical size.
- **X → compositor coords** (`configure-notify`, override-redirect
  placement, ICCCM size hints): divided by N.
- **Compositor → X coords** (`configure-request` reply, pointer
  surface-local coords sent to X clients, DnD enter/motion): multiplied
  by N.
- **`xdg_output` for X-backed clients** reports `logical_position *
  N`, `logical_size * N` so the X client sees an output of its own
  "device" pixels. `wl_output` for X-backed clients is unchanged
  (Xwayland uses its own X-side RANDR view, not `wl_output`).

Trade-offs versus the "do nothing, let the renderer filter upscale"
approach (what wlroots-based compositors ship by default):

- Pro: toolkit-aware X clients (Qt with `QT_AUTO_SCREEN_SCALE_FACTOR`,
  GTK with `GDK_SCALE`, recent Chromium / Firefox / Electron) render
  crisp at the higher scale because they actually paint more pixels.
- Pro: non-cooperating X clients still get the right *logical* size;
  the compositor downscales their oversized buffer instead of
  upscaling a small one. End result is the same blur but starting from
  more pixels, not fewer.
- Con: every X client gets the same N. On a mixed-DPI setup the lower-
  scale monitor wastes some pixels.
- Con: `Xft.dpi` / `RESOURCE_MANAGER` writes are out of scope. X
  clients that key off Xft.dpi for font sizing (older GTK2, Tk, some
  Java toolkits) will not pick up the scale. This is a known gap; if
  it bites in practice, the fix is a separate small piece of work
  inside the XWM.

## Phase 4 — clipboard / selection bridge (landed)

`src/xwayland/selection.ts` mediates two of the three X selections to
their wayland counterparts; the native side exposes raw xcb primitives
and the state machine lives in TS.

- `CLIPBOARD` ↔ `wl_data_device`
- `PRIMARY` ↔ `zwp_primary_selection_v1`
- `XdndSelection` — DnD, deferred to Phase 5

Both directions are wired and tested end-to-end:

- **X owns → Wayland pastes.** `xfixes-selection-notify` fires when an
  X client claims `CLIPBOARD` / `PRIMARY`. The bridge issues
  `ConvertSelection(TARGETS)` onto our owner window, reads the property,
  resolves each atom to a MIME (standard set inline, async
  `xwmGetAtomName` for the rest), and publishes `state.xClipboardSource`
  / `xPrimarySource`. `wl_data_device_manager.sendSelectionTo` falls
  back to that source when no wl client owns the selection; the
  focused wl client gets a server-minted offer carrying the mapped
  mimes. `wl_data_offer.receive` on an X-backed offer kicks off a
  per-mime `ConvertSelection` on a fresh per-transfer window;
  `SelectionNotify` reads the property; INCR fires when the reply type
  is `INCR` and continues via `PropertyNotify(NewValue)` until a
  zero-length new value signals end-of-stream.

- **Wayland owns → X pastes.** `wl_data_device.set_selection` (and the
  primary equivalent) calls into the bridge; the bridge
  `SetSelectionOwner`s our owner window. `xfixes-selection-notify`
  self-confirms; we cache the X timestamp for `TIMESTAMP`-target
  replies. `SelectionRequest` from an X requestor: `TARGETS` is built
  from `state.dataSources[source].mimes`; `TIMESTAMP` echoes the
  cached timestamp; otherwise we allocate a pipe (`addon.makePipe`),
  hand the write-fd to the wl source via `send_send`, drain the read
  end on the libuv loop, and write the requestor's property. Above 64
  KiB we switch to INCR (property type `INCR` + size hint; subsequent
  chunks on each `PropertyNotify(Delete)` on the requestor's
  destination property, observed via `addon.xwmSelectWindowEvents(req,
  PROPERTY_CHANGE)`). EOF closes with one empty-property write.

Per-requestor stale-transfer purge: a second SelectionRequest from the
same requestor drops the previous transfer (real X apps only read the
latest reply; leaving the prior pending hangs the bridge).

Focus gate: the bridge only probes `TARGETS` when an X client is
X-focused. This avoids minting wayland-side X-backed sources for X
clients running in the background.

Atoms / native primitives added in Phase 4:
- 11 atoms: `CLIPBOARD`, `PRIMARY`, `TARGETS`, `TIMESTAMP`, `INCR`,
  `TEXT`, `STRING`, `MULTIPLE`, `DELETE`, `CLIPBOARD_MANAGER`,
  `_OVERDRAW_SELECTION`.
- Event kinds: `xfixes-selection-notify`, `selection-request`,
  `selection-notify`, `atom-name-reply`. `property-notify` now also
  carries the `NEW_VALUE` / `DELETE` state (the bridge's two INCR
  pumps key off this distinction).
- Primitives: `xwmCreateSelectionWindow`, `xwmDestroyWindow`,
  `xwmSetSelectionOwner`, `xwmConvertSelection`,
  `xwmSendSelectionNotify`, `xwmXfixesSelectSelectionInput`,
  `xwmInternAtom`, `xwmGetAtomName`, `xwmSelectWindowEvents`,
  `xwmFlush`. Plus `addon.makePipe()` (pipe(2) returning `{readFd,
  writeFd}`, both blocking + CLOEXEC) and `addon.wrapFd(rawFd)`
  (raw int → `WaylandFd` so the bridge can pass the write end through
  `wl_data_source.send_send`).
- New dep: `xcb-xfixes`.

Out of scope / known gaps:
- **`MULTIPLE` target.** Refused. Real apps rarely use it.
- **`CLIPBOARD_MANAGER`.** Short-circuited with a success notify
  without actually doing anything (matches the convention used by
  other rootless WMs; clipboard managers that need bytes use the
  normal CLIPBOARD path).
- **Async target → MIME resolution on the outgoing path.** If an X
  client requests a target atom we have not minted (i.e. has not been
  in our `TARGETS` reply), we refuse rather than block on
  `xwmGetAtomName`. SelectionRequest requires a bounded-time reply.
- **Read-modify-write of `_NET_WM_STATE_FOCUSED`** — the same gap
  already flagged in Phase 3.4 / "polish."

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

## Open questions

- **`WL_SURFACE_SERIAL` delivery: answered.** Verified empirically by
  removing the per-window `FOCUS_CHANGE | PROPERTY_CHANGE` mask at
  CreateNotify and re-running the serial-association GPU test; the
  serial still arrives. ClientMessages routed to a managed window are
  delivered via the root's `SUBSTRUCTURE_REDIRECT`, not the per-window
  mask. The per-window mask remains load-bearing for FocusIn and
  PropertyNotify on the WM-managed window itself, just not for
  client-messages.
- **Related: serial sent before CreateNotify is processed.** Still a
  silent-gap risk in principle. Per-X-connection ordering (CreateNotify
  before the ClientMessage on the same xcb stream) prevents it in
  practice; rapid create/map/destroy is untested. `pendingBySerial`
  handles a *late* serial, not a *missing* one.
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

Coverage today: 17 GPU tests (`test/xwayland-*.gpu.mjs`) and 64
GPU-free unit tests (`test/xwayland-*.test.js`) across server lifecycle,
shell serial registry, property parsers, configure round-trip,
override-redirect placement, focus mirror, ICCCM truth table, the
resize-tx buffer-dims-only variant, the MIME↔atom translation table,
the selection bridge end-to-end in both directions (small payload +
INCR >64 KiB), and the TIMESTAMP-target reply path.

The selection-bridge end-to-end tests need a Wayland clipboard test
client and a small purpose-built X11 selection client
(`packages/core/test/x11-selection-client.c`) that can both serve and
paste a selection (handling INCR continuations on the paste side).
