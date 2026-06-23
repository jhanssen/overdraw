# overdraw — XWayland design

Scoping/implementation plan for running X11 clients under overdraw via a
**rootless** Xwayland. **No code yet** — this is the plan. Design rationale
lives here; ground-truth status stays in `docs/status.md`. When work lands,
fold residual gaps into status.md's "Read first" section and trim this doc to
what is still future.

The governing constraint, set by the codebase: **xcb/X11 code and Wayland code
never share a file.** The Wayland server, trampoline, and protocol handlers are
already large; X11 is a second, unrelated wire protocol. The two meet only at
narrow, typed seams (the configure-sink router, the focus driver, the
data-device), never inside one another's source files.

## Scope

**In scope (v1):**

- Rootless Xwayland launched + supervised as a child (like the GPU process).
- Surface association via `xwayland_shell_v1` + `WL_SURFACE_SERIAL` **only**.
- Window-management bridge: create/map/unmap/destroy, the configure
  round-trip, ICCCM/EWMH property → window state, override-redirect
  (menus/tooltips) as unmanaged overlays, stacking, close, and keyboard focus
  wired through the existing focus driver.
- Accelerated X11 clients render through the **existing dmabuf import path**
  (Xwayland is itself a Wayland client using `zwp_linux_dmabuf_v1`); no new GPU
  work.

**Later phases (designed here, built after v1):**

- Clipboard bridge (`CLIPBOARD` + `PRIMARY` ↔ `wl_data_device` / primary
  selection), including INCR.
- Drag-and-drop bridge (Xdnd ↔ `wl_data_device`).

**Out of scope:**

- **Legacy `WL_SURFACE_ID` association.** Advertising `xwayland_shell_v1` makes
  any Xwayland ≥ 23.1 use the serial path *exclusively* — it never emits
  `WL_SURFACE_ID`. The legacy path is also the racy one (a reused 32-bit wl
  object id crossing the X socket against the wl socket) and resolving it would
  force `wl_client_get_object` — i.e. xcb and Wayland in one file, the thing we
  are avoiding. We pin a **≥ 23.1 minimum** (the host has 24.1.10) and emit one
  loud error if a `WL_SURFACE_ID` message ever arrives, rather than silently
  dropping the window.
- Rootful Xwayland; X RANDR / multi-monitor *inside* X (overdraw owns outputs).
- Per-window HiDPI scale (X has no such concept — see "HiDPI").
- `xwayland-keyboard-grab` (games); window icons polish; `xcb-res` PID
  attribution. All deferrable, isolated additions.

## Decision summary

- **Native = policy-free xcb binding; TS = all XWM policy.** The native module
  owns only the X11 *wire*: the xcb connection, atom interning, request
  wrappers, and event decode → structured JS. Every convention (ICCCM size
  hints, EWMH state/type, focus model, `_NET_SUPPORTED`, stacking) is parsed
  and decided in TypeScript, next to the rest of the WM policy. This is the
  same native-mechanism / TS-policy seam the whole project uses, and is the
  split already proven in `~/dev/owm` (a TS X11 WM over a thin xcb binding) —
  minus that project's cairo/pango drawing, reparenting, RANDR, and input
  grabs, none of which a rootless XWM needs.
- **Parse property bytes in TS, not native.** `get_property` returns raw
  `{type, format, data}`; TS interprets it. Keeps native policy-free and avoids
  linking `xcb-icccm`/`xcb-ewmh` (the latter is not even installed here).
- **Single libuv loop, no extra thread.** xcb integrates exactly like the
  Wayland server and input sockets already do: `uv_poll` on
  `xcb_get_file_descriptor`, drain `xcb_poll_for_event` in the callback,
  `uv_async` to flush. No threadsafe-function marshaling.
- **XWM lives in the core process**, not a third process: it shares the libuv
  loop and the focus/selection state, and (for any future client-identity need)
  sits next to the Wayland server.
- **Xwayland connects over `WAYLAND_DISPLAY`, as a normal client.** Association
  is by serial and is client-agnostic, so we do *not* need to pre-create the
  client via a socketpair + `wl_client_create`. That keeps the Xwayland
  spawn code from touching the Wayland server at all. (The socketpair +
  `wl_client_create` route is an optional later refinement if we ever need the
  client handle — legacy association, sandboxing.)
- **The WM stays protocol-agnostic.** Xwayland windows enter through the
  existing `wm.addWindow` / `propose` / `unmapWindow`. The only seam is the
  `ConfigureSink`, which becomes a tiny router (xdg vs. xwayland) wired in
  `main.ts` — *not* inside `wm/`.

**Native dependencies** (all present on the host): `xcb`, `xcb-composite`
(redirect root subwindows so toplevels present as wl_surfaces), `xcb-xfixes`
(selection-owner change tracking). Optional: `xcb-render` (root cursor only —
deferrable), `xcb-res` (`_NET_WM_PID`), `xcb-errors` (debug-readable error
names). **Not** `xcb-icccm` / `xcb-ewmh` — we intern atoms ourselves and parse
in TS.

## Module / file layout

```
packages/core/
  native/
    xwayland/                  # NEW — all xcb/X11 native code, zero Wayland
      server.cpp/.h            # spawn + supervise Xwayland (mirrors
                               #   native/core/gpu_process.cpp)
      xwm.cpp/.h               # xcb_connect_to_fd(wm_fd), uv_poll pump, atom
                               #   intern, request wrappers, event decode →
                               #   napi callback
      napi_xwayland.cpp        # N-API exports; addon.cpp calls one init fn
    wayland/                   # UNCHANGED
  src/
    xwayland/                  # NEW — all XWM *policy* in TS, zero wl-protocol
      index.ts                 # start/stop orchestrator; owns the native handle
      native.d.ts              # the native binding surface (see below)
      atoms.ts                 # atom name list + typed accessors
      properties.ts            # parse raw property buffers (ICCCM/EWMH in TS)
      surface.ts               # XwaylandSurface model + serial-association join
      xwm.ts                   # decoded-event handlers → drive the overdraw WM
      selection.ts             # clipboard / primary bridge (Phase 4)
      dnd.ts                   # Xdnd bridge (later)
    protocols/
      xwayland_shell_v1.ts     # NEW — the ONE Wayland-side file (it *is* a wl
                               #   protocol); does serial bookkeeping only and
                               #   delegates the join to src/xwayland/surface.ts
```

**Build:** a new CMake object lib `overdraw_xwayland` carries the xcb sources +
deps and is linked into the addon. xcb never enters the `overdraw_core` /
Wayland targets.

**Protocol generation:** add
`/usr/share/wayland-protocols/staging/xwayland-shell/xwayland-shell-v1.xml` to
`tools/gen-protocol/gen-protocol.js` `DEFAULT_INPUTS`; the generator emits
`protocols-gen/xwayland_shell_v1.{js,d.ts}` like every other interface. Add
`xwayland_shell_v1` to the `GLOBALS` list in `protocols/index.ts`.

## Native binding surface

The TS-facing contract lives in `src/xwayland/native.d.ts`. It is the policy-free
xcb subset a rootless XWM needs — owm's binding minus graphics, RANDR, grabs,
reparenting, and pixmaps/GCs, with surface association left as a raw
`client-message` for TS to interpret.

**Lifecycle:** `start(opts, onEvent) → { handle, displayName, root, wmWindow,
atoms }`; `stop(handle)`. `start` spawns Xwayland, connects xcb to the wm fd,
runs XWM init (root event mask, composite redirect, intern atoms, create the
`_NET_SUPPORTING_WM_CHECK` / selection-owner window), and begins the pump;
resolves once Xwayland signals ready.

**Requests (native → X):** `getProperty` / `changeProperty` / `deleteProperty`
(raw bytes), `configureWindow`, `sendConfigureNotify` (synthetic, ICCCM
§4.2.3), `changeWindowAttributes`, `mapWindow` / `unmapWindow` /
`destroyWindow` / `killClient`, `changeSaveSet`, `setInputFocus`,
`sendClientMessage` (DELETE_WINDOW / TAKE_FOCUS / Xdnd), `internAtom` /
`getAtomName`, `getGeometry`, `flush`. Selection (Phase 4): `setSelectionOwner`,
`getSelectionOwner`, `convertSelection`, `xfixesSelectSelectionInput`,
`sendSelectionNotify`.

**Decoded events (X → native → TS):** `server-ready`, `server-exit`, `create`
(incl. `overrideRedirect`), `destroy`, `map-request`, `map`, `unmap`,
`configure-request` (with `valueMask`), `configure`, `property`,
`client-message` (carries `WL_SURFACE_SERIAL`), `focus-in`. Selection (Phase 4):
`selection-request`, `selection-notify`, `selection-clear`,
`xfixes-selection`.

What is intentionally **absent** vs. a full xcb WM binding: the cairo/pango
graphics engine, pixmaps/GCs/`copy_area`/`poly_fill`, `reparent_window`, every
`grab_*` / `warp_pointer` / `allow_events`, xkb/keysyms, and RANDR/screens.
Xwayland delivers input to X clients over *Wayland*, and overdraw owns keybinds,
layout, outputs, and the cursor — so the XWM needs only the management subset.

## Server lifecycle (`native/xwayland/server.cpp`) — ✅ Phase 1 landed

Mirrors `native/core/gpu_process.cpp` (`fork` → child clears CLOEXEC + `execvp`
→ parent supervises + reaps). As built:

1. **A pipe for `-displayfd`:** the readiness signal. Xwayland writes its chosen
   display number + newline once its X11 sockets are open and it has finished
   the Wayland handshake.
2. **`fork` + `execvp`:** `Xwayland -rootless -displayfd <pipeW>` (no display
   arg → Xwayland picks the first free `N` and **creates its own X11 sockets**;
   `-terminate` optional). `WAYLAND_DISPLAY=<our socket>` in the child env,
   `DISPLAY` unset (rootless Xwayland is the X server, not a nested client),
   CLOEXEC cleared on the displayfd write end + stdio. `PR_SET_PDEATHSIG` +
   `getppid()` recheck guard the fork-vs-parent-death race.
3. **Readiness is async, via `uv_poll` (load-bearing).** A *blocking* read of
   the displayfd would deadlock: Xwayland only reports ready after its Wayland
   handshake completes, and our Wayland server runs on the same libuv loop the
   blocking read would freeze. So `server.cpp` only forks and returns the
   (non-blocking) pipe read fd; `napi_xwayland.cpp` polls it on the loop and
   fires a JS `onReady(err, {displayNumber, display})` callback. The TS
   orchestrator (`src/xwayland/index.ts`) wraps that in a promise; `DISPLAY` is
   set from the resolved display. Reap on shutdown with the
   `waitpid`/grace/`SIGTERM` pattern. Verified by `test/xwayland-server.gpu.mjs`
   (Xwayland comes up clean against headless overdraw — no missing-global or
   glamor complaints).

**Deferred (not needed for Phase 1):** the **WM socketpair + `-wm`** (the XWM's
`xcb_connect_to_fd` channel) lands with Phase 2. Pre-creating the X11 sockets
ourselves (lock file + unix + abstract + `-listenfd`), instead of letting
Xwayland create them, is only needed for **lazy start** (socket-activation
re-spawn on the next X connection) and is a later refinement; eager start needs
none of it. `-terminate` (exit when the last X client disconnects) is wired but
off by default.

## Surface association

The join is the one genuinely new mechanism; native stays dumb (it is just a
`client-message`).

1. `protocols/xwayland_shell_v1.ts` handles `get_xwayland_surface(wl_surface)`
   and `set_serial(lo, hi)` → `surface.ts: registerSerial(serial64, surfaceId,
   surfaceRec)`. It marks `SurfaceRecord.role = "xwayland"` (already a `string`
   field — no type change).
2. The X window posts `WL_SURFACE_SERIAL(lo, hi)`; native emits a
   `client-message`; `xwm.ts` decodes the u64 and calls
   `surface.ts: associateBySerial(window, serial64)`.
3. On the wl_surface's next content commit, the adapter calls `wm.addWindow` /
   `windowHasContent` (managed) or the unmanaged-overlay placement
   (override-redirect). The window then flows through overdraw's existing
   pipeline.

**Ordering:** the serial may be set on the wl_surface before or after the X
client-message arrives; `surface.ts` holds both half-associations and completes
when the second arrives (an `unpaired` set on each side), matching the
reference XWM's unpaired-surface handling.

**Legacy guard:** `xwm.ts` already sees every `client-message`; a branch on
`messageType === atoms.WL_SURFACE_ID` logs one error
(`unsupported Xwayland < 23.1`) instead of silently never mapping the window.

## Window-management bridge (`src/xwayland/xwm.ts`)

Decoded X events drive overdraw's existing WM; no X knowledge leaks into `wm/`.

- **Create / map / unmap / destroy.** `create` records geometry +
  `overrideRedirect`. Managed windows wait for `map-request` (we decide, then
  `mapWindow`); override-redirect windows skip it (they only `map`). `unmap` /
  `destroy` → `wm.unmapWindow` / teardown + dissociation.
- **Configure round-trip.** `configure-request` → consult layout. The
  compositor is authoritative for managed windows: we `configureWindow` to the
  WM-chosen size (and to the window's position in the **global logical layout
  space** — X apps that reason in absolute root coordinates, e.g. menu
  placement, then land correctly), and always follow with a synthetic
  `sendConfigureNotify` per ICCCM. The reverse direction — a layout pass
  resizing the window — goes through the **configure-sink router**: for an
  `xwayland`-role surface the sink calls `xwm.configure(window, rect)` instead
  of `configureToplevel`.
- **Properties → state.** On associate, batch `getProperty` for `WM_CLASS`,
  `_NET_WM_NAME`/`WM_NAME`, `WM_NORMAL_HINTS`, `WM_HINTS`, `WM_PROTOCOLS`,
  `_NET_WM_WINDOW_TYPE`, `_NET_WM_STATE`, `WM_TRANSIENT_FOR`. `property` events
  re-read the one that changed. `properties.ts` parses the bytes →
  `app_id` (class), `title` (name), `constraints` (min/max/base/inc),
  `parent` (transient-for), and presentation hints
  (`_NET_WM_STATE` fullscreen/maximized; `_NET_WM_WINDOW_TYPE`
  dialog/utility/menu). These feed `wm.addWindow` initial state and
  `wm.propose` — reusing the existing dialog/floating policy in
  `windowHasContent` (transient-for + fixed min==max already promotes to
  floating, which is exactly how X dialogs should behave).
- **Override-redirect** surfaces (menus, tooltips, combo-boxes, DnD icons) are
  **not** WM windows. `surface.ts` places them via `CompositorSink`
  (`setSurfaceLayout` at their absolute X coords mapped into the layout space)
  in a dedicated stack spliced **above** the content layer. They are composited
  and may take keyboard focus (menus), but carry no tile/decoration/layout.
- **Close.** If `WM_DELETE_WINDOW` is in `WM_PROTOCOLS`, send it as a
  client-message; else `killClient`. Wired to the same close path as
  `xdg_toplevel.close`.
- **Focus.** When the focus driver selects an `xwayland`-role surface, `xwm.ts`
  mirrors it to X: `setInputFocus` for the passive model, or send
  `WM_TAKE_FOCUS` for the locally/globally-active model (decided from
  `WM_HINTS.input` + `WM_TAKE_FOCUS` in `WM_PROTOCOLS`), and update
  `_NET_ACTIVE_WINDOW` + `_NET_WM_STATE_FOCUSED`. Wayland keyboard-enter to
  Xwayland's surface and X input-focus to the window must agree; the focus
  driver is the single source of truth and the XWM is a mirror.

## Clipboard / selection bridge (Phase 4, `src/xwayland/selection.ts`)

Because raw `getProperty`/`changeProperty`/`sendClientMessage` are exposed, the
whole bridge — including the INCR chunk loop driven by `property` events — lives
in TS; no protocol dance forces it into C++ (clipboard is not a hot path). Three
selections: `CLIPBOARD` ↔ `wl_data_device`, `PRIMARY` ↔ primary selection,
`XdndSelection` (DnD, deferred to `dnd.ts`).

- **X owns → Wayland pastes:** `xfixes-selection` tells us an X client took the
  selection; we read its `TARGETS`, mint a `wl_data_source` advertising the
  mapped MIME types, and on `wl_data_source.send` `convertSelection` + read the
  result property (INCR if large) into the Wayland pipe fd.
- **Wayland owns → X pastes:** own the X selection on our WM window; answer
  `selection-request` by writing the Wayland source's bytes to the requestor's
  property (INCR for large), then `sendSelectionNotify`.

MIME ↔ X target translation table lives here. The transfer logic is mechanical;
flag complexity (INCR state machines, target negotiation) in status.md when it
lands.

## Touchpoints in existing files (kept minimal, no xcb leaks in)

- **`wm/index.ts`:** unchanged in spirit. The `ConfigureSink` it already calls
  is the router *at the wiring site* (`protocols/index.ts`, where the sink is
  built; not `main.ts` -- the sink is built inside `installProtocols`): if
  the surface role is `xwayland`, the sink calls `addon.xwmConfigureWindow` +
  `addon.xwmSendConfigureNotify` (ICCCM §4.2.3 synthetic) and returns `null`;
  else it calls `configureToplevel`. The WM file gains zero X knowledge.
  Resize-readiness for X surfaces uses a `requireAck: false` flag on
  `PendingResize` so the hold gates on buffer dims (`surfaceReadyAt`) only --
  no ack_configure equivalent in X. The sink's return type (`number | null`)
  carries the role intent: a serial means "wait for ack", null means
  "buffer dims only". (Slice 3.2.)
- **`protocols/ctx.ts`:** set `SurfaceRecord.role = "xwayland"` (no type change);
  the serial registry lives in `src/xwayland/`, not on `state`.
- **`wl_seat.ts` / `wl_data_device_manager.ts`:** consumed from the xwayland
  side through their existing public surface (focus driver result; data-device
  functions). At most one or two functions get exported; no handler bodies
  change.

## HiDPI

X11 has no per-window scale. v1 takes the standard compromise: present X clients
at a single global scale (config-driven), upscaling non-cooperating clients —
correct size, soft at scale > 1, exactly as overdraw already treats
non-scale-aware Wayland clients. Per-window/ per-output fractional scaling of X
apps is a known hard limitation across all compositors and is out of scope.

## Testing

A new harness tier: a real Xwayland child + a tiny X11 client (`xclock` or a
purpose-built xcb client). It is **not** pure `node --test` (needs the GPU +
host Wayland, like the existing `*.gpu.mjs` tier) and must self-skip when
Xwayland or a Wayland session is absent. Coverage targets, smallest tier first:

- **Structural / unit:** generator metadata for `xwayland_shell_v1`;
  `properties.ts` byte-parsers (size hints, `_NET_WM_STATE`, `WM_CLASS`) against
  fixed buffers; `surface.ts` association ordering (serial-before-message and
  message-before-serial). All GPU-free.
- **Integration (`*.gpu.mjs`):** spawn Xwayland, run an X client, assert via
  `state.query()` that the window is mapped at the laid-out rect and takes
  focus; assert override-redirect placement; assert close. Per the testing
  policy, scaffolding X clients are verified in-tree and **not committed**;
  only persistent tests enter git.

## Open questions (resolve before the relevant slice)

- **Never block the node thread on Xwayland's progress (a deadlock class).**
  The SIGKILL reap (Phase 2) is one instance of a general hazard: the node
  thread *is* the single-threaded Wayland server, so any blocking native call
  that waits on something Xwayland can only do by making Wayland progress will
  deadlock. This directly threatens **Phase 3's synchronous xcb property reads**
  (`xcb_get_property_reply`, `xcb_get_geometry_reply`): the X reply itself is
  pure X protocol, but if Xwayland is simultaneously blocked writing to a *full*
  Wayland socket (unread because we're blocked in the xcb reply) and so cannot
  send our X reply, both wedge. Atom interning at startup is safe (quiet period,
  empty buffers); per-window reads under live load are the risk. Phase 3 should
  prefer pipelined/async property reads, or accept a low-probability synchronous
  -read deadlock and say so. (Slice 3.)
- **`WL_SURFACE_SERIAL` delivery mechanism is unverified.** The per-window
  `FOCUS|PROPERTY` mask selected at CreateNotify is present (Phase 3 needs it for
  PropertyNotify/FocusIn anyway) and association works, but it was NOT isolated
  whether that mask *delivers* the client-message or whether it arrives via the
  root's `SUBSTRUCTURE_REDIRECT` regardless. Cheap to confirm (drop the mask,
  see if the serial still arrives). Related robustness gap: a serial sent before
  we select events on a freshly-created window would be *dropped* -> a silently
  invisible X window. X per-connection ordering (CreateNotify before the
  message) should prevent this, but rapid create/map/destroy is untested; the
  bidirectional pending-match handles a *late* serial, not a *missing* one.
- **X-window resize readiness.** The WM resize transaction's serial gate is
  meaningless for X. Decide: gate `xwayland` resizes on `surfaceReadyAt`
  (buffer dims) only, accepting a possible one-frame imperfection, or add a
  buffer-dims-only hold variant. (Slice 3.)
- **Eager vs. lazy Xwayland start.** Eager is simpler; lazy (`-terminate` +
  re-spawn on first X connection) saves idle resources. v1 may ship eager.
- **Override-redirect focus & stacking.** Menus want focus and must sit above
  their owner; nailing the exact stacking vs. overdraw's layer model is a
  Slice-3 detail.
- **Client identity.** v1 connects Xwayland over `WAYLAND_DISPLAY` and needs no
  client handle. Revisit only if sandboxing or legacy association is ever
  wanted (would add a socketpair + `wl_client_create` on the Wayland side).

## Slices / sequencing

- **Phase 0 — `wl_resource_post_error` (general server infra, prerequisite).**
  The compositor has no way to post a spec protocol error; offending requests
  are silently dropped (sites annotated across `wl_surface.ts`,
  `cursor_shape.ts`, the viewporter + decoration handlers, `subsurfaces.ts`).
  Wire it: a native `postError(resource, code, msg)` sibling of `postEvent`
  (`trampoline.cpp` → `wl_resource_post_error`), a `ctx.postError` helper that
  reads error codes from the generated `enums.error` metadata, a GPU-free unit
  test (double-role a surface → assert error event + disconnect), and convert
  the annotated silent-drop sites. Closes the status.md "no `post_error`" gap
  and lets `xwayland_shell_v1.role` be posted properly (Phase 2) instead of
  logged. Not Xwayland code, but sequenced first because Xwayland needs it.
  No spike: overdraw's Wayland server is verified complete enough for rootless
  Xwayland (all required globals present bar `xwayland_shell_v1`), so #2/#3
  integration unknowns are retired inline during Phases 1-2 rather than in a
  throwaway.
- **Phase 1 — server lifecycle.** ✅ Landed. `native/xwayland/server.cpp`
  (fork/exec rootless Xwayland, `-displayfd` readiness), `napi_xwayland.cpp`
  (async `uv_poll` readiness + reap), `overdraw_xwayland` CMake lib,
  `src/xwayland/index.ts` orchestrator. `test/xwayland-server.gpu.mjs` confirms
  Xwayland initializes against overdraw and brings up an X display. No XWM yet.
- **Phase 2 — `xwayland_shell_v1` + minimal XWM + association.** ✅ Landed.
  2a (Wayland side): the protocol + handler + serial registry. 2b (native XWM):
  the `-wm` socketpair through the spawn, `native/xwayland/xwm.cpp` (xcb connect,
  root event mask + composite redirect, atom intern, decode create/map/unmap/
  destroy/configure-request + the `WL_SURFACE_SERIAL` client-message → `uv_poll`
  → napi), and `src/xwayland/xwm.ts` (serial join via the registry, allow maps,
  add mapped+associated toplevels to the WM). `test/xwayland-xwm.gpu.mjs` drives
  a real X11 client (`x11-test-client`) and confirms its window associates and
  enters the WM. Two findings: association works with the per-window
  `FOCUS|PROPERTY` mask selected at CreateNotify (whether that mask is the
  delivery path or the message arrives via root substructure-redirect is
  unverified -- see Open questions); and Xwayland must be reaped with
  **SIGKILL**, not SIGTERM -- a synchronous SIGTERM reap deadlocks against
  Xwayland's Wayland-dependent clean shutdown on the single-threaded loop (the
  visible tip of the "never block the node thread" hazard -- see Open
  questions). Geometry/properties/focus/override-redirect are Phase 3.
  Host wiring: `main.ts` calls `startXwayland` + `startXwm` when
  `config.xwayland.enabled` is set, exports `DISPLAY` to children spawned via
  the spawn action, and reaps both on shutdown. With this, Phase 2 is
  reachable from the binary -- an X11 client can connect to the running
  compositor (no geometry/title/focus/menus/close yet, per Phase 3 scope).
- **Phase 3 — window-management semantics.** Subdivided 3.1-3.4.
  - **3.1 — Properties + close.** ✅ Landed. ICCCM/EWMH property reads
    (async, cookie-keyed); title/app_id/constraints/parent/presentation
    plumbed into the WM (markInitialCommitComplete + propose); close
    routes through `closeSurface(state, surfaceId)` (WM_DELETE_WINDOW
    when advertised, else KillClient). window.map/unmap/change role
    gates widened to include xwayland.
  - **3.2 — Configure round-trip + holdUntilBufferDims.** ✅ Landed.
    The ConfigureSink became a role-dispatched router in
    `protocols/index.ts`: xdg returns a serial (ack path), xwayland
    returns null and the resize-tx hold gates on buffer dims alone via
    a new `requireAck: false` flag on `PendingResize`. Native
    `xwmSendConfigureNotify` emits the ICCCM §4.2.3 synthetic form
    alongside every `xwmConfigureWindow`. `configure-request` from a
    managed X window is answered with the WM's current rect rather
    than the client's request. GPU test asserts the synthetic
    ConfigureNotify carrying the WM-chosen dims reaches the X client.
  - **3.3 — Override-redirect overlays + pure-move ConfigureNotify.**
    ✅ Landed. The sink interface gained `configureMove(surfaceId, x,
    y, w, h)`; the WM calls it on pure-move (no size change), the
    xdg branch no-ops, the xwayland branch sends
    xwmConfigureWindow + xwmSendConfigureNotify so X clients see
    their new root coords on workspace switches and the like.
    Override-redirect xwayland windows (menus, tooltips, DnD icons)
    are tracked in `state.overrideRedirects` (Map<surfaceId, rect>)
    populated by xwm.ts on MapNotify / ConfigureNotify and cleared on
    UnmapNotify / DestroyNotify. The content-layer stack rebuild
    (`xdg_popup.ts:rebuildStackWithPopups`) appends OR ids above
    popups via `appendOverrideRedirects`, calling
    `setSurfaceLayout(id, x, y, w, h)` for each. OR surfaces never
    enter the WM, never emit `window.map` / `window.unmap` /
    `window.change` (those gates exclude OR by consulting
    `state.xwm.findBySurfaceId(id).overrideRedirect`), and are NOT
    auto-focused on map -- but `wl_seat.focusTargetFor` gained an OR
    arm so an explicit `applyKeyboardFocus(orSurfaceId)` lands. The
    native MapNotify event now carries x/y/w/h (sourced from a
    per-window tracker updated on CreateNotify / ConfigureNotify) so
    the placement at map time reflects any ConfigureWindow between
    create and map -- the standard menu-positioning pattern. GPU
    tests: OR placement at X-supplied coords; OR cleanup on destroy;
    OR focusability.
  - **3.4 — Focus mirroring.** Pending (parses WM_HINTS.input today
    but doesn't consume it; the SetInputFocus / WM_TAKE_FOCUS path is
    not wired).
- **Phase 4 — clipboard.** `CLIPBOARD` + `PRIMARY`, including INCR.
- **Phase 5 — polish + DnD.** Xdnd, `_NET_SUPPORTED` completeness, startup
  notification, window icons, `xwayland-keyboard-grab`, HiDPI policy knob.

## Reference

The canonical rootless-XWM architecture (socket setup, composite redirect, the
event handlers, the selection bridge) is wlroots' `xwayland/` module; the
TS-WM-over-thin-xcb-binding split is `~/dev/owm`. This design takes the binding
split from the latter and the rootless mechanics from the former, and adapts
both to overdraw's native-mechanism / TS-policy seam.
