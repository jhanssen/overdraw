// Type contract for the intercept namespace (intercept-design.md).
// Used by core's intercept broker + match engine, and by any plugin
// that wants to type-check intercept registrations directly.

// Rect in output-space pixels.
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Role filter values. Cursor / decoration roles are ALWAYS excluded
// regardless of this filter -- those surfaces are not user content.
export type InterceptableRole = "toplevel" | "popup" | "subsurface";

// Match predicate. All conditions are AND'd; the match holds only when
// every present condition holds. Empty match (no fields) catches every
// client (every content surface).
export interface InterceptMatch {
  // RegExp serialized as { source, flags } so the spec is clone-safe
  // across postMessage. The broker reconstructs the RegExp at register
  // time.
  appId?: { source: string; flags: string };
  // Default: ["toplevel", "popup", "subsurface"] (all content roles).
  // Pass a subset to restrict.
  roles?: ReadonlyArray<InterceptableRole>;
}

// Forward-compatibility field. Recorded but not used for ordering in
// 10a (single intercept per surface; no chain). 10b's chain dispatch
// will consume it.
export type ContributesCategory = "pixels" | "geometry" | "composition";

// Setup-time context handed to the plugin. The device is core's device
// for in-thread plugins (shared) and the plugin's own device for Worker
// plugins. Either way it's the device the plugin renders against.
export interface InterceptSetupCtx {
  device: GPUDevice;
}

// Per-frame context.
export interface InterceptRenderCtx {
  surfaceId: number;
  frameNumber: number;
  time: number;
  // The surface's WM-assigned outer rect.
  //
  // In-thread transport: live (re-read each tick from the WM state).
  // Worker transport: static (snapshot taken at match time; the
  //   Worker-side ctx does not subscribe to WM rect changes in 10a).
  //
  // Useful for plugins that compute placement-relative output (e.g.
  // border plugins comparing input dims against expected post-inset
  // content dims). Coordinates are in global compositor logical space
  // (same as surface placement; per-output origin is applied by the
  // compositor downstream).
  surfaceRect: Rect;
  // True iff the client committed new content (a new buffer) for this
  // surface since this plugin last rendered it. The plugin can't observe
  // this itself (the client texture is sampled, not diffed), so the SDK
  // supplies it. A static effect uses it to decide whether to re-render:
  // when false and the plugin's own inputs (focus, geometry) are unchanged,
  // return `false` from render to skip. Always true on the first render.
  contentChanged: boolean;
  // True once the committed buffer matches surfaceRect at the output scale --
  // the scale-correct signal a gating plugin releases on (comparing input.rect
  // in buffer px against surfaceRect in logical px only agrees at scale 1.0).
  // In-thread: live each tick. Worker: always false (gates are in-thread only).
  contentReady: boolean;
  // True iff this surface currently holds keyboard focus (the active window).
  // Level-triggered: re-read from the seat each tick, so a plugin drives its
  // focused vs. unfocused styling from this rather than caching an edge from
  // window.change. Reading current state (not an edge) is what lets a static
  // window -- one that never commits again -- reflect a focus change on the
  // frame the focus-causing input wakes.
  // In-thread: live each tick. Worker: always false (seat focus is not threaded
  // across the Worker boundary).
  activated: boolean;
  // Release the WM content gate engaged by gates:true at match time.
  // Idempotent; no-op when the registration did not declare `gates`. The
  // window enters the draw stack on the next composite, sampling the output
  // from THIS render. Gate on ctx.contentReady, not on dimension comparisons
  // (input.rect is buffer px, surfaceRect is logical px -- they only agree at
  // scale 1.0).
  releaseGate: () => void;
  // Buffer pixels per logical pixel of the client content: the factor the
  // SDK used to map the surface-local window geometry into input.rect. 1 for
  // scale-1 clients; a fractional-scale or buffer_scale>1 client reports its
  // effective scale (e.g. 1.5, 2). A plugin drawing pixel-thickness features
  // (borders, corner radii) into the output ring multiplies logical
  // thicknesses by this so they display at the intended logical size.
  // Worker transport: always 1 (the geometry/scale mapping is not wired).
  inputScale: number;
}

// Per-frame input/output texture handles. The plugin must NOT retain
// these past the return of `render`; the SDK recycles them.
export interface InterceptInput {
  texture: GPUTexture;
  // The CONTENT sub-rect within `texture`, in buffer px: the client's window
  // geometry (set_window_geometry) clamped to the buffer, or the whole buffer
  // when the client never set geometry. For a CSD client this excludes the
  // transparent drop-shadow margin, so a decoration bands the real window. A
  // plugin that samples the texture must map `rect` into UVs itself
  // (rect.x/y and rect.w/h against texture.width/height); it is NOT always
  // the full texture.
  rect: Rect;
  // True when the client committed an opaque-format buffer (XRGB8888 shm,
  // XR24/XB24/XR30 dmabuf, ...): the texture's alpha channel is the format's
  // undefined X byte, NOT coverage. A plugin that samples the texture and
  // blends MUST force alpha to 1 when this is set (X11 clients through
  // Xwayland routinely leave garbage in the X byte).
  opaque: boolean;
}

export interface InterceptOutput {
  texture: GPUTexture;
  rect: Rect;
}

// Per-frame render result. Returning `outputRect` overrides the
// surface's WM-assigned placement for this frame (geometry control).
// Returning `void` (or undefined) leaves the WM rect in place.
//
// Returning `false` means "I produced NO new output this frame -- keep
// the previously-installed output." The SDK then does not install or
// damage anything for this surface, so the compositor's per-output dirty
// gate can skip recompositing. A static effect (e.g. a decoration border)
// returns `false` whenever ctx.contentChanged is false AND none of its
// own inputs (focus, geometry) changed, which lets an idle desktop drop to
// ~0% GPU. A per-frame effect simply never returns `false`.
export interface InterceptRenderResult {
  outputRect?: Rect;
}

// Surface info handed to the lifecycle callbacks. Reflects the WM's
// view of the surface at the moment the callback fires; not a live
// reference (subsequent `onChange` events update the view, but the
// SDK doesn't re-deliver the SurfaceInfo here -- the broker emits
// `window.change` on the bus as usual).
export interface InterceptSurfaceInfo {
  surfaceId: number;
  role: InterceptableRole;
  appId?: string;
  title?: string;
}

export interface InterceptHandlers {
  // Optional. Called when the SDK is about to allocate or reallocate
  // the output ring. Receives the current input texture dimensions
  // (the client's committed buffer size). Returns the dimensions to
  // use for the output ring. Default: identity (output = input).
  //
  // Reallocation triggers when input dimensions change (client commits
  // a buffer at a new size). The output ring follows by recomputing
  // through this callback. Throwing or returning invalid dimensions
  // (zero, negative, exceeding GPU limits) increments the per-surface
  // failure counter; sustained failure auto-unregisters the plugin.
  //
  // Border-style intercepts return { w: inputW + 2*B, h: inputH + 2*B }
  // to extend the output by B on every side (the band). `inputScale` is
  // the same buffer-px-per-logical-px factor the render ctx reports (see
  // InterceptRenderCtx.inputScale); a band that should display B LOGICAL
  // pixels thick extends by round(B * inputScale) ring pixels.
  //
  // 10a: in-thread transport only. Worker plugins that declare a
  // non-identity outputDimensions are rejected at registration; the
  // Worker ring lifecycle does not yet renegotiate dimensions.
  outputDimensions?(inputW: number, inputH: number, inputScale: number): { w: number; h: number };

  // Fired once per matched surface, immediately after the registration
  // is set up (for already-matched surfaces) or when a new surface
  // newly satisfies the match.
  onSurfaceMatched?(surface: InterceptSurfaceInfo): void;

  // Fired when a previously-matched surface ceases to match (unmap,
  // app_id change, role change, intercept unregister).
  onSurfaceUnmatched?(surface: InterceptSurfaceInfo): void;

  // Per-frame render. Encodes commands + submits synchronously; returns
  // optional outputRect for geometry control.
  //
  // input.texture: in-thread = the client's currently-committed sampled
  //                texture (long-lived); Worker = the plugin-device view
  //                of the next input-ring slot (per-frame copy from the
  //                client texture on core device).
  // output.texture: a rotating-slot texture the SDK provides. The
  //                 plugin writes its result; the SDK installs the
  //                 just-rendered slot as the surface's intercept
  //                 output for compositing.
  render(args: {
    input: InterceptInput;
    output: InterceptOutput;
    ctx: InterceptRenderCtx;
  }): InterceptRenderResult | false | void;

  // Fired once on unregister (after every matched surface has
  // received onSurfaceUnmatched).
  destroy?(): void;
}

export interface InterceptSpec {
  // Plugin-visible label. Used in logs and (in the future) IPC
  // identification.
  name: string;
  match: InterceptMatch;
  contributes?: ReadonlyArray<ContributesCategory>;
  // Lower numbers match first. Same-priority falls back to registration
  // order. Default 0. Bundled fallback intercepts (e.g. the decoration
  // plugin matching ".*") use a higher number so user-installed
  // narrower-pattern effects win.
  priority?: number;
  // When set, the SDK engages a WM content gate under owner
  // `"intercept-${spec.name}"` at onSurfaceMatched time so the window
  // does NOT enter the draw stack until the plugin releases it via
  // ctx.releaseGate() inside a render call. Used by decoration-like
  // intercepts that need to hold the window invisible until their
  // first render at the post-insets size lands.
  //
  //   gates: true                  -> engage gate; 10s backstop timeout.
  //   gates: { timeoutMs: 500 }    -> engage gate; explicit timeout.
  //   gates: false / omitted       -> no gate (default; observe-only).
  //
  // Backstop semantics: if the plugin does not call releaseGate() and
  // does not produce a successful render within timeoutMs, the SDK
  // force-releases the gate so a stuck/broken plugin cannot hold a
  // window invisible indefinitely. Default backstop is 10000 (10s).
  //
  // The gate also auto-releases on:
  //  - onSurfaceUnmatched (the surface unmapped / the registration is
  //    being torn down): the gate would otherwise stay engaged on a
  //    surface that may be re-matched by a peer.
  //  - render throw: a broken render call should not hold the window
  //    invisible. The intercept falls back to raw client; the gate
  //    releases. Mirrors today's "broken decoration provider →
  //    undecorated window" semantics.
  gates?: boolean | { timeoutMs?: number };
  // Called once when the registration becomes active. Returns the
  // per-surface handlers used for the lifetime of the registration.
  setup(ctx: InterceptSetupCtx): Promise<InterceptHandlers> | InterceptHandlers;
}

export interface InterceptRegistration {
  unregister(): Promise<void>;
}

export interface InterceptAPI {
  register(spec: InterceptSpec): Promise<InterceptRegistration>;
}
