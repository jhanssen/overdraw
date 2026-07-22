// Intercept broker. Owns the match engine + per-surface state. Listens
// on the core typed bus for window.map / window.change / window.unmap;
// drives the plugin lifecycle callbacks; ticks each active state per
// frame.
//
// 10a transport: in-thread bundled plugins ONLY. The broker constructs
// InThreadInterceptState objects; the broker has no Worker path yet.
// 10b adds the Worker transport via parallel WorkerInterceptState +
// cross-device dmabuf wiring.

import type {
  InterceptHandlers, InterceptSetupCtx, InterceptSpec,
  InterceptSurfaceInfo,
} from "@overdraw/intercept-types";
import type { CompositorBus } from "../events/window-bus.js";
import type { CompositorSink } from "../protocols/ctx.js";
import { WINDOW_EVENT } from "../events/types.js";
import {
  MatchEngine, compileAppIdRegex, type MatchEvent,
  type ToplevelData,
} from "./match-engine.js";
import {
  InThreadInterceptState,
  type InThreadTickDeps, type InThreadGateConfig,
} from "./inthread-state.js";
import {
  WorkerInterceptState, type RingsAllocPayload, type RingsAllocResult,
} from "./worker-state.js";
import type { Addon } from "../types.js";
import type { DawnWire } from "../gpu/compositor.js";

export interface InterceptBrokerDeps {
  bus: CompositorBus;
  // The plugin-visible dynamic bus. window.committed (sizeMode
  // transitions -> excludeFullscreen re-evaluation) is only emitted
  // there. Optional for harnesses.
  pluginBus?: {
    subscribe(name: string, handler: (name: string, payload: unknown) => void): unknown;
  };
  compositor: CompositorSink;
  // How long an unmatched Worker surface's rings stay parked waiting
  // for the worker's intercept.unmatch-ack before being released
  // anyway (worker dead or wedged). Tests shrink this.
  unmatchAckTimeoutMs?: number;
  // Whether a surface currently holds keyboard focus (the active window).
  // Read live at tick time and surfaced as ctx.activated so decoration-style
  // plugins style focus from current seat state, not an async window.change
  // edge. Optional: absent in test harnesses with no seat (defaults unfocused).
  isActivated?(surfaceId: number): boolean;
  // Whether a surface is CURRENTLY fullscreen, read live from the WM.
  // The preconfigure payload's initialState is a snapshot taken before the
  // plugin round-trip; a pre-content fullscreen stamp landing DURING that
  // round-trip both post-dates the snapshot and pre-dates this broker's
  // registration of the toplevel (the committed edge fires before the
  // toplevel is known here). Pulling the live state at registration time
  // closes that ordering hole. Optional: harnesses without a WM fall back
  // to the payload snapshot.
  isFullscreen?(surfaceId: number): boolean;
  // The client's declared window geometry (set_window_geometry): the opaque
  // window sub-rect within the buffer, in buffer px. CSD clients (GTK) draw
  // transparent shadow margins outside this. Null when the client never set
  // it (the whole buffer is the window).
  surfaceGeometry?(surfaceId: number):
    { x: number; y: number; width: number; height: number } | null;
  // WM content-gate sink. The broker engages/releases per-surface
  // content gates under owner key `"intercept-${spec.name}"` when a
  // registration declares `gates: true`. Optional: when absent,
  // gates-declaring registrations log a warning at register time and
  // behave as if gates were false (the broker can't ask the WM to
  // hold draw).
  gateSink?: {
    engageContentGate(surfaceId: number, owner: string): void;
    releaseContentGate(surfaceId: number, owner: string): void;
  };
  // The core device + texture-usage flags, for in-thread output rings.
  // Optional: when absent, the broker rejects in-thread register
  // requests (no rings to allocate against).
  inThread?: {
    device: GPUDevice;
    textureUsage: typeof GPUTextureUsage;
  };
  // Cross-device dmabuf machinery for Worker intercept (10a Worker leg).
  // Optional: when absent, registerWorker rejects.
  worker?: {
    addon: Addon;
    dawn: DawnWire;
    coreDeviceHandle: bigint;
    textureUsage: typeof GPUTextureUsage;
    // Per-plugin connection id (the plugin's wire client). The broker
    // needs this to make AllocComposeBuf / AllocSurfaceBuf calls.
    // Resolved by name; the gpu-broker holds the mapping.
    connIdByPlugin: (pluginName: string) => number | undefined;
    // Async allocators matching gpu-broker.ts's pAllocCompose / pAlloc.
    allocCompose(connId: number, w: number, h: number,
                 ctId: number, ctGen: number, cdId: number, cdGen: number,
                 wireSerial: bigint): Promise<{ surfaceBufId: number }>;
    allocSurface(connId: number, w: number, h: number,
                 ptId: number, ptGen: number, pdId: number, pdGen: number,
                 wireSerial: bigint): Promise<{ surfaceBufId: number }>;
  };
  log: (line: string) => void;
}

// Per-registration bookkeeping. Transport-tagged: either in-thread
// (handlers are JS functions called directly) or Worker (handlers
// live on the worker; core sees the per-surface lifecycle via
// requests/events). The two state classes are interchangeable from
// the broker's point of view -- both expose ids() + destroy() + a
// per-frame tick.
interface ActiveRegistrationInThread {
  transport: "in-thread";
  id: number;
  pluginName: string;
  spec: InterceptSpec;
  handlers: InterceptHandlers;
  surfaces: Map<number, InThreadInterceptState>;
}

// Worker-side notify carries the same SurfaceInfo as the plugin sees
// PLUS the surface dimensions the worker needs to reserve its rings
// against. Dims aren't part of InterceptSurfaceInfo (which is the
// plugin-facing shape) so we package them separately.
export interface WorkerMatchedNotification {
  info: InterceptSurfaceInfo;
  width: number;
  height: number;
  // Opaque (X-alpha) buffer format at match time: the worker's render must
  // force alpha=1 when sampling the input (see InterceptInput.opaque).
  opaque: boolean;
}

interface ActiveRegistrationWorker {
  transport: "worker";
  id: number;
  pluginName: string;
  // Spec sans setup -- the Worker SDK ran setup locally with the
  // worker's GPUDevice; core never sees the JS setup function.
  match: InterceptSpec["match"];
  // The worker's matched-surface notification path: when core fires
  // a matched event, it sends "intercept.matched" to the worker
  // (worker translates to onSurfaceMatched). The worker drives
  // render itself in its tick loop.
  notifyMatched(n: WorkerMatchedNotification): Promise<void>;
  notifyUnmatched(info: InterceptSurfaceInfo): Promise<void>;
  surfaces: Map<number, WorkerInterceptState>;
}

type ActiveRegistration = ActiveRegistrationInThread | ActiveRegistrationWorker;

const DEFAULT_UNMATCH_ACK_TIMEOUT_MS = 1000;

export class InterceptBroker {
  private readonly engine: MatchEngine;
  private readonly registrations = new Map<number, ActiveRegistration>();
  private nextRegistrationId = 1;
  private readonly deps: InterceptBrokerDeps;
  // Worker surfaces whose rings are parked between the unmatch notify
  // and the worker's intercept.unmatch-ack (or the timeout). Keyed
  // `${registrationId}:${surfaceId}`; survives unregister (the ack can
  // land after the registration itself is gone).
  private readonly pendingUnmatchAcks = new Map<
    string, { state: { destroy(): void }; timer: ReturnType<typeof setTimeout> }>();

  constructor(deps: InterceptBrokerDeps) {
    this.deps = deps;
    this.engine = new MatchEngine({
      ...(deps.isFullscreen ? { isFullscreen: deps.isFullscreen } : {}),
    });
    // Subscribe to the core window-event bus. window.preconfigure fires
    // synchronously inside markInitialCommitComplete BEFORE the first
    // sized configure goes out: matching at this seam lets the plugin's
    // synchronous setInsets land in time so the client receives the
    // post-insets size on its FIRST sized configure (no wrong-size
    // flash). window.map is the catch-up seam for surfaces that were
    // already mapped when a registration was added, or that didn't have
    // an appId at preconfigure time.
    deps.bus.on(WINDOW_EVENT.preconfigure, (ev) => {
      this.onPreconfigure({
        surfaceId: ev.surfaceId,
        appId: ev.appId,
        title: ev.title,
        // Fallback seed for harnesses without deps.isFullscreen; with a
        // live reader wired the engine resolves fullscreen at match time
        // and this snapshot is never consulted.
        fullscreen: ev.initialState.sizeMode === "fullscreen",
      });
    });
    deps.bus.on(WINDOW_EVENT.map, (ev) => {
      this.onMapped({
        surfaceId: ev.surfaceId,
        appId: ev.appId,
        title: ev.title,
      });
    });
    deps.bus.on(WINDOW_EVENT.change, (ev) => {
      if (!ev.changed.includes("appId")) return;
      this.engine.onToplevelChanged(ev.surfaceId, ev.appId, ev.title)
        .forEach((e) => this.dispatchMatchEvent(e));
    });
    // window.committed (behavioral-state transitions) rides the PLUGIN
    // bus, not the core compositor bus. Fullscreen entry/exit re-runs
    // the match so excludeFullscreen registrations release / reclaim
    // the surface. Optional: a harness without a plugin bus simply
    // never re-evaluates on state changes.
    deps.pluginBus?.subscribe(WINDOW_EVENT.committed, (_name, payload) => {
      const ev = payload as {
        surfaceId?: number;
        changed?: ReadonlyArray<string>;
        current?: { sizeMode?: string };
      } | null;
      if (!ev || typeof ev.surfaceId !== "number") return;
      if (!Array.isArray(ev.changed) || !ev.changed.includes("sizeMode")) return;
      this.engine.onToplevelFullscreenChanged(
        ev.surfaceId, ev.current?.sizeMode === "fullscreen")
        .forEach((e) => this.dispatchMatchEvent(e));
    });
    deps.bus.on(WINDOW_EVENT.unmap, (ev) => {
      this.engine.onToplevelUnmapped(ev.surfaceId)
        .forEach((e) => this.dispatchMatchEvent(e));
    });
  }

  // Plugin-facing register entrypoint (in-thread bundled plugins).
  async registerInThread(spec: InterceptSpec, pluginName: string): Promise<number> {
    if (!this.deps.inThread) {
      throw new Error(
        "intercept.register: in-thread transport not configured (no GPUDevice)");
    }
    const appIdRegex = compileAppIdRegex(spec.match.appId);   // throws on invalid pattern
    const setupCtx: InterceptSetupCtx = { device: this.deps.inThread.device };
    const handlers = await Promise.resolve(spec.setup(setupCtx));

    const id = this.nextRegistrationId++;
    const regData = {
      id,
      pluginName,
      appIdRegex,
      roles: spec.match.roles ? [...spec.match.roles] : null,
      priority: spec.priority ?? 0,
      excludeFullscreen: spec.match.excludeFullscreen ?? false,
    };
    const active: ActiveRegistrationInThread = {
      transport: "in-thread",
      id,
      pluginName,
      spec,
      handlers,
      surfaces: new Map(),
    };
    this.registrations.set(id, active);

    const events = this.engine.addRegistration(regData);
    for (const e of events) this.dispatchMatchEvent(e);
    return id;
  }

  // Plugin-facing register entrypoint (Worker plugins). The Worker SDK
  // ran setup() locally with the worker's GPUDevice; core doesn't see
  // the JS setup function. The match data is enough to drive the
  // engine; per-surface lifecycle notifications cross the wire via
  // the supplied callbacks. notifyMatched carries the surface dims
  // (the worker reserves rings against them).
  async registerWorker(args: {
    match: InterceptSpec["match"];
    pluginName: string;
    priority?: number;
    notifyMatched(n: WorkerMatchedNotification): Promise<void>;
    notifyUnmatched(info: InterceptSurfaceInfo): Promise<void>;
  }): Promise<number> {
    if (!this.deps.worker) {
      throw new Error(
        "intercept.register: Worker transport not configured");
    }
    const appIdRegex = compileAppIdRegex(args.match.appId);

    const id = this.nextRegistrationId++;
    const regData = {
      id,
      pluginName: args.pluginName,
      appIdRegex,
      roles: args.match.roles ? [...args.match.roles] : null,
      priority: args.priority ?? 0,
      excludeFullscreen: args.match.excludeFullscreen ?? false,
    };
    const active: ActiveRegistrationWorker = {
      transport: "worker",
      id,
      pluginName: args.pluginName,
      match: args.match,
      notifyMatched: args.notifyMatched,
      notifyUnmatched: args.notifyUnmatched,
      surfaces: new Map(),
    };
    this.registrations.set(id, active);

    const events = this.engine.addRegistration(regData);
    for (const e of events) this.dispatchMatchEvent(e);
    return id;
  }

  async unregister(registrationId: number): Promise<void> {
    const active = this.registrations.get(registrationId);
    if (!active) return;
    // Engine emits unmatched events for every surface assigned to this
    // registration; possibly also matched events for surfaces that
    // now match a lower-priority registration.
    const events = this.engine.removeRegistration(registrationId);
    for (const e of events) this.dispatchMatchEvent(e);
    // Drop the registration AFTER engine events were dispatched.
    this.registrations.delete(registrationId);
    if (active.transport === "in-thread") {
      try {
        active.handlers.destroy?.();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.log(`[intercept ${active.pluginName}] destroy threw: ${msg}`);
      }
    }
    // Worker transport's destroy is the responsibility of the SDK's
    // unregister-rule round-trip on the plugin side; the broker
    // doesn't directly call into a Worker's destroy callback here.
  }

  // Per-frame tick. The launcher's beforeRender hook calls this BEFORE
  // True iff at least one registration has at least one matched surface
  // currently active. The frame-trigger loop (main.ts onFrame) consults
  // this after each render to decide whether to wake again -- intercept
  // wants per-frame render callbacks for every matched surface, so an
  // active registration drives continuous re-render at vsync.
  // Whether the compositor should keep waking per-frame for intercept work.
  // True iff the most recent tick() actually PRODUCED a frame for some surface
  // -- not merely that surfaces are registered. A decoration that has settled
  // (its render returns the static skip) reports not-rendered, so the frame
  // loop can idle until a real event (commit, focus, resize) re-drives a tick.
  // Without this a single registration matching every window (the default
  // decoration's ".*") would force a render every vblank forever.
  hasActive(): boolean {
    return this.lastTickRendered;
  }

  private lastTickRendered = false;

  // the compositor's renderFrame. Iterates every active state across
  // every registration and dispatches its render.
  tick(timeMs: number): void {
    let anyRendered = false;
    for (const active of this.registrations.values()) {
      // Snapshot because a render that crosses the failure threshold
      // causes unregister, which mutates the map.
      let registrationDead = false;
      if (active.transport === "in-thread") {
        const states = Array.from(active.surfaces.values());
        for (const state of states) {
          const r = state.tick(timeMs);
          if (r.rendered) anyRendered = true;
          if (!r.ok) { registrationDead = true; break; }
        }
      } else {
        const states = Array.from(active.surfaces.values());
        for (const state of states) {
          const r = state.tickCore(timeMs);
          if (r.rendered) anyRendered = true;
          if (!r.ok) { registrationDead = true; break; }
        }
      }
      if (registrationDead) {
        const id = active.id;
        queueMicrotask(() => {
          this.unregister(id).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            this.deps.log(`[intercept] auto-unregister threw: ${msg}`);
          });
        });
      }
    }
    this.lastTickRendered = anyRendered;
  }

  // Teardown: synchronously destroy every per-surface state across
  // every registration. Drops compositor intercept output bindings
  // and releases the dmabuf rings (deferred via afterCurrentFrame
  // for the in-thread compositor; for Worker plugins, the wire ops
  // post to the addon synchronously). Called by the launcher's
  // teardown BEFORE the addon stops, so the wire is drained before
  // Dawn's wire link is destroyed.
  shutdown(): void {
    for (const active of this.registrations.values()) {
      for (const state of active.surfaces.values()) {
        state.destroy();
      }
      active.surfaces.clear();
    }
    this.registrations.clear();
    this.engine.shutdown();
  }

  // Test / introspection.
  registrationCount(): number { return this.registrations.size; }
  activeSurfacesFor(registrationId: number): number[] {
    const a = this.registrations.get(registrationId);
    if (!a) return [];
    return Array.from(a.surfaces.keys());
  }

  // The plugin name that owns the intercept currently assigned to
  // `surfaceId`, or undefined when no intercept is assigned. Used by
  // windows-broker's setInsets authorization (only the assigned
  // intercept's owner may move that surface's insets).
  pluginNameForSurface(surfaceId: number): string | undefined {
    const regId = this.engine.registrationFor(surfaceId);
    if (regId === undefined) return undefined;
    return this.registrations.get(regId)?.pluginName;
  }

  private onPreconfigure(top: ToplevelData): void {
    const events = this.engine.onToplevelPreconfigure(top);
    for (const e of events) this.dispatchMatchEvent(e);
  }

  private onMapped(top: ToplevelData): void {
    const events = this.engine.onToplevelMapped(top);
    for (const e of events) this.dispatchMatchEvent(e);
    // Retry dispatch for any surface already assigned in the engine
    // but not yet active in any registration's surfaces map. This
    // covers the Worker silent-gap: dispatchMatchedWorker bails when
    // matched fires before the client has committed a buffer (e.g. at
    // preconfigure time). window.map fires once a buffer exists; re-
    // dispatch now so the Worker fixture finally receives its matched
    // event. dispatchMatched is idempotent (early-out on
    // active.surfaces.has). The in-thread path is unaffected (its
    // onSurfaceMatched fires synchronously on the original dispatch).
    const assignedRegId = this.engine.registrationFor(top.surfaceId);
    if (assignedRegId !== undefined) {
      const active = this.registrations.get(assignedRegId);
      if (active && !active.surfaces.has(top.surfaceId)) {
        this.dispatchMatched(active, top.surfaceId);
      }
    }
  }

  private dispatchMatchEvent(event: MatchEvent): void {
    const active = this.registrations.get(event.registrationId);
    if (!active) return;       // registration was removed mid-dispatch
    if (event.kind === "matched") {
      this.dispatchMatched(active, event.surfaceId);
    } else {
      this.dispatchUnmatched(active, event.surfaceId);
    }
  }

  private dispatchMatched(active: ActiveRegistration, surfaceId: number): void {
    if (active.surfaces.has(surfaceId)) return;     // shouldn't happen, defensive

    const top = this.engine.toplevelData(surfaceId);
    const info: InterceptSurfaceInfo = {
      surfaceId,
      role: "toplevel",   // 10a covers toplevels only
      appId: top?.appId ?? undefined,
      title: top?.title ?? undefined,
    };
    if (active.transport === "in-thread") {
      this.dispatchMatchedInThread(active, surfaceId, info);
    } else {
      // Worker dispatch is async (alloc round-trips); fire-and-forget
      // so dispatchMatchEvent stays synchronous. If alloc fails, log
      // and leave the surface unmatched (the engine still has it
      // assigned; on next change/unmap we'll fire an unmatched).
      this.dispatchMatchedWorker(active, surfaceId, info)
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          this.deps.log(
            `[intercept ${active.pluginName}] worker matched setup failed: ${msg}`);
        });
    }
  }

  private dispatchMatchedInThread(
    active: ActiveRegistrationInThread,
    surfaceId: number,
    info: InterceptSurfaceInfo,
  ): void {
    const inThread = this.deps.inThread;
    if (!inThread) {
      this.deps.log(
        `[intercept ${active.pluginName}] matched ${surfaceId} but no in-thread transport`);
      return;
    }
    const tickDeps: InThreadTickDeps = {
      device: inThread.device,
      clientTexture: (sid) => this.deps.compositor.surfaceClientTexture?.(sid) ?? null,
      surfaceOpaque: (sid) => this.deps.compositor.surfaceIsOpaque?.(sid) ?? false,
      surfaceLogicalSize: (sid) => this.deps.compositor.surfaceLogicalSize?.(sid) ?? null,
      contentEpoch: (sid) => this.deps.compositor.surfaceContentEpoch?.(sid) ?? 0,
      isPresentable: (sid) => this.deps.compositor.surfaceIsPresentable?.(sid) ?? false,
      surfaceWmRect: (sid) => this.deps.compositor.surfaceWmRect?.(sid) ?? null,
      contentReady: (sid) => this.deps.compositor.surfaceContentReady?.(sid) ?? false,
      isActivated: (sid) => this.deps.isActivated?.(sid) ?? false,
      surfaceGeometry: (sid) => this.deps.surfaceGeometry?.(sid) ?? null,
      withClientTextureAccess: (sid, fn) =>
        this.deps.compositor.withClientTextureAccess
          ? this.deps.compositor.withClientTextureAccess(sid, fn)
          : (fn(), true),   // no-op if the sink doesn't implement (tests with stub compositors)
      installOutput: (sid, view, placement) =>
        this.deps.compositor.installInterceptOutput?.(sid, view, placement),
      clearOutput: (sid) => this.deps.compositor.clearInterceptOutput?.(sid),
      textureUsage: inThread.textureUsage,
      log: this.deps.log,
    };
    const gate = this.resolveGateConfig(active);
    const state = new InThreadInterceptState(
      surfaceId, active.pluginName, active.handlers, tickDeps, gate);
    active.surfaces.set(surfaceId, state);

    try {
      active.handlers.onSurfaceMatched?.(info);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.log(
        `[intercept ${active.pluginName}] onSurfaceMatched threw: ${msg}`);
    }
  }

  // Resolve the gate config from spec.gates. Returns null when gates
  // are not declared, or when declared but the gate sink isn't wired
  // (in which case we log a warning so the plugin sees their gate
  // declaration was silently ignored).
  private resolveGateConfig(active: ActiveRegistrationInThread):
    InThreadGateConfig | null {
    const decl = active.spec.gates;
    if (!decl) return null;
    if (!this.deps.gateSink) {
      this.deps.log(
        `[intercept ${active.pluginName}] declared gates:true but no gate sink ` +
        `wired in the broker; gate request ignored. The window will draw without ` +
        `waiting for releaseGate().`);
      return null;
    }
    const timeoutMs = typeof decl === "object" && decl.timeoutMs !== undefined
      ? decl.timeoutMs
      : InThreadInterceptState.DEFAULT_GATE_TIMEOUT_MS;
    const sink = this.deps.gateSink;
    return {
      ownerKey: `intercept-${active.spec.name}`,
      engage: (sid, owner) => sink.engageContentGate(sid, owner),
      release: (sid, owner) => sink.releaseContentGate(sid, owner),
      timeoutMs,
    };
  }

  private async dispatchMatchedWorker(
    active: ActiveRegistrationWorker,
    surfaceId: number,
    info: InterceptSurfaceInfo,
  ): Promise<void> {
    const worker = this.deps.worker;
    if (!worker) {
      this.deps.log(
        `[intercept ${active.pluginName}] matched ${surfaceId} but no Worker transport`);
      return;
    }
    const connId = worker.connIdByPlugin(active.pluginName);
    if (connId === undefined) {
      this.deps.log(
        `[intercept ${active.pluginName}] matched ${surfaceId} but no plugin conn`);
      return;
    }
    // Determine the matched surface's dimensions from its current
    // client texture. The compositor exposes the surface's sampled
    // dims; if no buffer has been committed yet, we don't know the
    // size. Fall back to a sensible default (the WM's outer rect)
    // since the dmabuf needs concrete dimensions to allocate. For
    // 10a, require the client to have a committed buffer before
    // matched fires; otherwise skip alloc and let it retry on
    // subsequent matched events.
    const client = this.deps.compositor.surfaceClientTexture?.(surfaceId);
    if (!client) {
      this.deps.log(
        `[intercept ${active.pluginName}] surface ${surfaceId} matched before client buffer; ` +
        `skipping ring alloc (will retry on next match)`);
      return;
    }

    // Allocate rings. The worker has reserved its consumer + producer
    // textures and sent them via notifyMatched -> alloc-rings request;
    // but actually the broker is the caller of notifyMatched. We need
    // the worker to give us its reservations FIRST so we can run the
    // alloc round-trip. That doesn't fit notifyMatched's signature.
    //
    // The Worker SDK + broker need a different rendezvous: when core
    // observes a matched surface, it tells the worker (via notify),
    // the worker reserves its rings + reports back via a follow-up
    // request, the broker runs alloc + replies with the SAB +
    // surfaceBufIds. To keep the broker simple, we let the worker
    // perform the reservation AS PART of notifyMatched's return
    // (the worker's notifyMatched returns the reservations the broker
    // needs).
    //
    // Adjusted flow: notifyMatched is "I'll set up local state for
    // this surface; return your reservations." The broker then runs
    // alloc + creates the WorkerInterceptState + calls a second
    // notification with the SAB + ids so the worker can finish wiring.
    //
    // For simplicity in 10a, fold both steps into notifyMatched (the
    // SDK contract): the broker calls notifyMatched(info, alloc) where
    // alloc is a hook the worker calls with its reservations and gets
    // back the SAB + ids. See WorkerInterceptState.allocate.
    const state = new WorkerInterceptState({
      surfaceId,
      registrationId: active.id,
      pluginName: active.pluginName,
      pluginConnId: connId,
      width: client.w,
      height: client.h,
      allocCompose: worker.allocCompose,
      allocSurface: worker.allocSurface,
      addon: worker.addon,
      compositor: this.deps.compositor,
      dawn: worker.dawn,
      coreDeviceHandle: worker.coreDeviceHandle,
      textureUsage: worker.textureUsage,
      log: this.deps.log,
    });
    active.surfaces.set(surfaceId, state);

    // notifyMatched receives the surface info + the state. The Worker
    // SDK calls state.allocate(payload) with its reservations to
    // complete the wiring; this returns the SAB + ids the worker uses
    // to wire its tick loop. We pass the state to notifyMatched via a
    // dummy alloc placeholder; the SDK calls broker.allocateRings
    // directly through a separate request.
    //
    // For the 10a v1 path, the broker's `notifyMatched` is the only
    // surface->worker signal. The Worker SDK responds by reserving
    // textures, calling `intercept.alloc-rings` over the endpoint,
    // and on success starts its tick loop. We pre-create the state
    // here (with width/height); the alloc completes through the
    // broker's intercept.alloc-rings handler (separate route).
    //
    try {
      await active.notifyMatched({
        info,
        width: client.w,
        height: client.h,
        opaque: this.deps.compositor.surfaceIsOpaque?.(surfaceId) ?? false,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.log(
        `[intercept ${active.pluginName}] notifyMatched threw: ${msg}`);
      active.surfaces.delete(surfaceId);
      state.destroy();
    }
  }

  private dispatchUnmatched(active: ActiveRegistration, surfaceId: number): void {
    const state = active.surfaces.get(surfaceId);
    if (!state) return;
    active.surfaces.delete(surfaceId);
    const top = this.engine.toplevelData(surfaceId);
    const info: InterceptSurfaceInfo = {
      surfaceId,
      role: "toplevel",
      appId: top?.appId ?? undefined,
      title: top?.title ?? undefined,
    };
    if (active.transport === "in-thread") {
      try {
        active.handlers.onSurfaceUnmatched?.(info);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.log(
          `[intercept ${active.pluginName}] onSurfaceUnmatched threw: ${msg}`);
      }
      state.destroy();
      return;
    }

    // Worker transport: the worker's tick loop may be mid-frame with
    // producer/consumer brackets already written to its wire. Releasing
    // the surface bufs now would race those in-flight frames on the GPU
    // process, so park the state until the worker acks that its loop
    // has stopped (intercept.unmatch-ack). The timeout covers a dead or
    // wedged worker -- rings must not leak forever.
    const key = `${active.id}:${surfaceId}`;
    const stale = this.pendingUnmatchAcks.get(key);
    if (stale) {
      // A previous unmatch for this surface never resolved (re-match +
      // re-unmatch inside the ack window). Release the old rings now.
      this.pendingUnmatchAcks.delete(key);
      clearTimeout(stale.timer);
      stale.state.destroy();
    }
    const timeoutMs = this.deps.unmatchAckTimeoutMs ?? DEFAULT_UNMATCH_ACK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.pendingUnmatchAcks.delete(key);
      this.deps.log(
        `[intercept ${active.pluginName}] no unmatch-ack for surface ` +
        `${surfaceId} after ${timeoutMs}ms; releasing rings`);
      state.destroy();
    }, timeoutMs);
    timer.unref?.();
    this.pendingUnmatchAcks.set(key, { state, timer });
    active.notifyUnmatched(info).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.log(
        `[intercept ${active.pluginName}] notifyUnmatched threw: ${msg}`);
      // The notify never reached the worker, so no ack will come.
      this.ackUnmatched(active.id, surfaceId);
    });
  }

  // Worker SDK -> broker: the worker observed the unmatch and stopped
  // the surface's tick loop -- its wire carries no further brackets for
  // these rings, so releasing them can't race in-flight frames. No-op
  // when nothing is parked (timeout already fired, or the ack is a
  // duplicate).
  ackUnmatched(registrationId: number, surfaceId: number): void {
    const key = `${registrationId}:${surfaceId}`;
    const pending = this.pendingUnmatchAcks.get(key);
    if (!pending) return;
    this.pendingUnmatchAcks.delete(key);
    clearTimeout(pending.timer);
    pending.state.destroy();
  }

  // Worker SDK -> broker: complete ring allocation for a matched
  // surface. The SDK reserved its plugin-side textures; this routes
  // through to WorkerInterceptState.allocate and returns the SABs +
  // surfaceBufIds the worker uses for its tick loop.
  async allocateWorkerRings(
    registrationId: number, surfaceId: number, payload: RingsAllocPayload,
  ): Promise<RingsAllocResult> {
    const active = this.registrations.get(registrationId);
    if (!active || active.transport !== "worker") {
      throw new Error(`intercept.alloc-rings: no Worker registration ${registrationId}`);
    }
    const state = active.surfaces.get(surfaceId);
    if (!state) {
      throw new Error(
        `intercept.alloc-rings: no Worker state for surface ${surfaceId}`);
    }
    return await state.allocate(payload);
  }
}
