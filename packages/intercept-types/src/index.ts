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
}

// Per-frame input/output texture handles. The plugin must NOT retain
// these past the return of `render`; the SDK recycles them.
export interface InterceptInput {
  texture: GPUTexture;
  rect: Rect;
}

export interface InterceptOutput {
  texture: GPUTexture;
  rect: Rect;
}

// Per-frame render result. Returning `outputRect` overrides the
// surface's WM-assigned placement for this frame (geometry control).
// Returning `void` (or undefined) leaves the WM rect in place.
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
  }): InterceptRenderResult | void;

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
