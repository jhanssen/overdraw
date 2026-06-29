// ext_image_copy_capture_v1 + ext_image_capture_source_v1 -- the standardized
// successor to zwlr_screencopy. Three protocols, one module:
//
//   ext_image_capture_source_v1 (an opaque "this is what to capture" handle),
//   ext_output_image_capture_source_manager_v1                     -> source for wl_output,
//   ext_foreign_toplevel_image_capture_source_manager_v1           -> source for a toplevel handle,
//   ext_image_copy_capture_manager_v1.create_session(source,opts)  -> capturing session,
//   ext_image_copy_capture_manager_v1.create_pointer_cursor_session -> cursor sub-session (stubbed),
//   ext_image_copy_capture_session_v1                              -> advertises buffer constraints,
//   ext_image_copy_capture_frame_v1                                -> one capture, ready/failed.
//
// What we do:
//   - Source carries (kind, outputId|surfaceId), resolved at create_source.
//   - Session advertises buffer_size (output deviceSize or surface layout
//     size) + shm_format(argb8888) + done. dmabuf destination formats are
//     not advertised today -- importing a client dmabuf as a render/copy
//     target on coreDevice requires Dawn SharedTextureMemory machinery the
//     core process doesn't have wired (the existing dmabuf import is
//     sampler-only via the GPU process); clients fall back to shm. See
//     docs/status.md "Read first" once this is documented.
//   - Frame capture arms a "do it on the next flip-complete for this source"
//     intent. The same flip-complete that fires wp_presentation feedback
//     fires capture frames, so `presentation_time` carries the actual
//     scanout timestamp.
//   - For an output source, capture composes the listed output's content
//     stack via composeScene + readbackTexture, then memcpy into the
//     buffer (BGRA -> ARGB byte order matches on LE).
//   - For a toplevel source, capture composes the single window via
//     composeWindows. Surface unmap fires session.stopped.
//   - Streaming = the client just creates another frame after ready. We
//     don't pre-track "active streaming sessions" -- the next frame's
//     create+capture re-arms the intent.
//
// What's deliberately stubbed:
//   - Cursor sub-session (ext_image_copy_capture_cursor_session_v1): the
//     spec doesn't define a way to refuse a cursor session at construction
//     time -- it's a constructor (new_id), not a request that can error.
//     We accept the session, but on its get_capture_session we advertise
//     NO formats (no shm_format, no dmabuf_format) followed by done. The
//     spec says a client that gets no usable constraints must allocate
//     nothing and the compositor would fail the frame; in practice all
//     known clients see an empty constraint set and back off to "no cursor
//     capture available." This is the spec's only graceful refusal idiom.

import type { Ctx } from "./ctx.js";
import { surfaceIdForHandle } from "./ext_foreign_toplevel_list_v1.js";
import { outputIdForWlOutput } from "./wl_output.js";
import { computeBaseStack } from "../subsurfaces.js";
import { primaryOutputOfSurface } from "./output-resolve.js";
import { WINDOW_EVENT } from "../events/types.js";
import { OUTPUT_FALLBACK } from "./ctx.js";
import type { Resource } from "../types.js";

import type { ExtImageCaptureSourceV1Handler }
  from "#protocols-gen/ext_image_capture_source_v1.js";
import type { ExtOutputImageCaptureSourceManagerV1Handler }
  from "#protocols-gen/ext_output_image_capture_source_manager_v1.js";
import type { ExtForeignToplevelImageCaptureSourceManagerV1Handler }
  from "#protocols-gen/ext_foreign_toplevel_image_capture_source_manager_v1.js";
import type { ExtImageCopyCaptureManagerV1Handler }
  from "#protocols-gen/ext_image_copy_capture_manager_v1.js";
import {
  ExtImageCopyCaptureManagerV1_Error,
} from "#protocols-gen/ext_image_copy_capture_manager_v1.js";
import type { ExtImageCopyCaptureSessionV1Handler }
  from "#protocols-gen/ext_image_copy_capture_session_v1.js";
import {
  ExtImageCopyCaptureSessionV1_Error,
} from "#protocols-gen/ext_image_copy_capture_session_v1.js";
import type { ExtImageCopyCaptureFrameV1Handler }
  from "#protocols-gen/ext_image_copy_capture_frame_v1.js";
import {
  ExtImageCopyCaptureFrameV1_Error,
  ExtImageCopyCaptureFrameV1_FailureReason,
} from "#protocols-gen/ext_image_copy_capture_frame_v1.js";
import type { ExtImageCopyCaptureCursorSessionV1Handler }
  from "#protocols-gen/ext_image_copy_capture_cursor_session_v1.js";
import { WlShm_Format } from "#protocols-gen/wl_shm.js";

// ---- Source ---------------------------------------------------------------

type SourceKind = "output" | "toplevel";
interface SourceRecord {
  kind: SourceKind;
  // For kind=output: the outputId. For kind=toplevel: the surfaceId.
  // Either may be -1 if the underlying entity has gone away (an output
  // was hot-unplugged, or the toplevel unmapped). The session created
  // against it surfaces this as session.stopped at create-session time
  // (output) or via the unmap bus subscription (toplevel).
  id: number;
}
const sources = new WeakMap<Resource, SourceRecord>();

// Split a u64 into hi/lo for the presentation_time event helper.
function splitU64(v: bigint): { hi: number; lo: number } {
  const hi = Number((v >> 32n) & 0xffffffffn);
  const lo = Number(v & 0xffffffffn);
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

// ---- Session -------------------------------------------------------------

interface SessionRecord {
  resource: Resource;
  source: SourceRecord;
  // The single active frame for this session, or null. The spec allows at
  // most one frame per session at a time (`duplicate_frame` error).
  activeFrame: Resource | null;
  // The constraints last advertised. We re-advertise whenever the source's
  // size changes (output mode change, toplevel resize).
  bufferW: number;
  bufferH: number;
  // True once we've sent `stopped`. Subsequent operations are silent no-ops;
  // capture frames fail with reason=stopped.
  stopped: boolean;
  paintCursors: boolean;
}
// All live sessions, indexed by their resource. Frames index back via
// frameSession.
const sessions = new Map<Resource, SessionRecord>();

// Frame state. A frame is one-shot: create_frame -> attach_buffer ->
// (optional damage_buffer*) -> capture -> ready|failed -> client destroys.
interface FrameRecord {
  resource: Resource;
  session: SessionRecord;
  // null until attach_buffer; the attached wl_buffer.
  buffer: Resource | null;
  // Set by capture(); reset to false on ready/failed. Used to gate
  // re-arm on flip-complete.
  armed: boolean;
  // Set once capture has been sent (already_captured guard).
  captured: boolean;
  // The latest source-side damage rect we'll echo back on ready
  // (subsequent-frame contract: compositor's reported damage covers at
  // least the union of client's damage_buffer + actually-changed regions).
  // We don't currently track per-buffer reuse damage; we always full-
  // damage on ready.
  damageX: number; damageY: number; damageW: number; damageH: number;
}
const frames = new Map<Resource, FrameRecord>();

// Per-output: the set of armed frames waiting for a flip on that output.
// Populated by frame.capture(); drained by dispatchCaptureForOutput.
// Built lazily.
function collectArmedFramesForOutput(outputId: number): FrameRecord[] {
  const out: FrameRecord[] = [];
  for (const f of frames.values()) {
    if (!f.armed) continue;
    const s = f.session;
    if (s.stopped) continue;
    if (s.source.kind === "output") {
      if (s.source.id === outputId) out.push(f);
    } else {
      // toplevel source: pick whichever output the surface most overlaps.
      // For the test path this is the single output the headless harness
      // exposes; for multi-output, we just use the first output the surface
      // resides on.
      out.push(f);
    }
  }
  return out;
}

// Advertise the session's buffer constraints. The spec ordering: shm_format /
// dmabuf_format / dmabuf_device events in any order, exactly one buffer_size,
// then done. We send shm_format(argb8888 + xrgb8888) + buffer_size + done.
function sendConstraints(ctx: Ctx, s: SessionRecord): void {
  const e = ctx.events.ext_image_copy_capture_session_v1;
  e.send_buffer_size(s.resource, s.bufferW, s.bufferH);
  e.send_shm_format(s.resource, WlShm_Format.argb8888);
  e.send_shm_format(s.resource, WlShm_Format.xrgb8888);
  // dmabuf formats deliberately NOT advertised -- importing a client dmabuf
  // as a render/copy target on coreDevice needs Dawn SharedTextureMemory
  // machinery that lives in the GPU process today. shm-only is the
  // documented v1 path.
  e.send_done(s.resource);
}

// Resolve the (width, height) for a source's current frame. Returns null if
// the source's underlying entity is gone (the caller will mark the session
// stopped).
function sourceSize(ctx: Ctx, src: SourceRecord):
  { w: number; h: number } | null
{
  if (src.kind === "output") {
    const rec = ctx.state.outputs?.get(src.id);
    if (!rec || src.id === OUTPUT_FALLBACK) return null;
    return { w: rec.deviceSize.width, h: rec.deviceSize.height };
  }
  // toplevel: the WM's OUTER rect (decoration included), at the window's
  // output scale so the capture is device-resolution like the output path.
  const sRec = ctx.state.surfacesById?.get(src.id);
  if (!sRec || sRec.unmapped) return null;
  const rect = ctx.state.wm?.outerRectOf(src.id);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const scale = windowOutputScale(ctx, sRec.resource);
  return {
    w: Math.max(1, Math.round(rect.width * scale)),
    h: Math.max(1, Math.round(rect.height * scale)),
  };
}

// The integer/fractional scale of the output a window currently resides on
// (its primary output). Defaults to 1.
function windowOutputScale(ctx: Ctx, surfaceRes: Resource): number {
  const outputId = primaryOutputOfSurface(ctx.state, surfaceRes);
  const s = ctx.state.outputs?.get(outputId)?.scale ?? 1;
  return s > 0 ? s : 1;
}

// Stop a session: send stopped + mark it. Any active frame is failed with
// reason=stopped.
function stopSession(ctx: Ctx, s: SessionRecord, reason: "source-gone" | "explicit"): void {
  if (s.stopped) return;
  s.stopped = true;
  if (!s.resource.destroyed) {
    ctx.events.ext_image_copy_capture_session_v1.send_stopped(s.resource);
  }
  // Fail any in-flight frame.
  if (s.activeFrame) {
    const f = frames.get(s.activeFrame);
    if (f && !f.captured && !s.activeFrame.destroyed) {
      f.captured = true;
      ctx.events.ext_image_copy_capture_frame_v1.send_failed(
        s.activeFrame, ExtImageCopyCaptureFrameV1_FailureReason.stopped);
    }
  }
  // The session itself stays alive (the spec: "The client should destroy
  // the session after receiving this event"). reason is reserved for
  // diagnostic logging in the future.
  void reason;
}

// ---- Per-flip dispatch ----------------------------------------------------

// Drive one round of capture: walk armed frames whose source matches this
// output, render into their attached buffer, send ready (or failed). Called
// from the same flip-complete hook that fires wp_presentation feedback so the
// `presentation_time` event carries the actual scanout timestamp.
export function dispatchCaptureForOutput(
  ctx: Ctx,
  outputId: number,
  tvSec: bigint,
  tvNsec: number,
): void {
  if (!ctx.state.compositor.composeOutput
      || !ctx.state.compositor.composeRegion) {
    return;  // no JS compositor wired (GPU-free harness)
  }
  const armed = collectArmedFramesForOutput(outputId);
  for (const f of armed) {
    f.armed = false;
    if (f.resource.destroyed || !f.buffer || f.buffer.destroyed) continue;
    const ok = captureOneFrame(ctx, f, outputId, tvSec, tvNsec);
    if (!ok) {
      // captureOneFrame already sent failed; just clear the active frame.
      if (f.session.activeFrame === f.resource) f.session.activeFrame = null;
    }
  }
}

// Drive a single capture. Returns true on success (ready sent), false on
// failure (failed already sent).
function captureOneFrame(
  ctx: Ctx, f: FrameRecord, outputId: number, tvSec: bigint, tvNsec: number,
): boolean {
  const session = f.session;
  const buf = f.buffer;
  if (!buf) {
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
    return false;
  }

  // Currently only shm destinations are wired. Reject dmabuf with
  // buffer_constraints so the client knows to fall back.
  const desc = ctx.state.buffers?.get(buf);
  if (!desc) {
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
    return false;
  }
  if (desc.dmabuf) {
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.buffer_constraints);
    return false;
  }
  if (!desc.poolId) {
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
    return false;
  }
  const W = desc.width ?? 0, H = desc.height ?? 0;
  if (W <= 0 || H <= 0) {
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.buffer_constraints);
    return false;
  }
  if (W !== session.bufferW || H !== session.bufferH) {
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.buffer_constraints);
    return false;
  }

  // Compose + readback. Output source = full scene of windows residing on
  // the output. Toplevel source = the single toplevel.
  const compositor = ctx.state.compositor;
  if (!compositor.composeOutput || !compositor.composeRegion) {
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
    return false;
  }
  let tex: GPUTexture | null = null;
  try {
    if (session.source.kind === "output") {
      // Snapshot the output's full on-screen content (subsurfaces + decorations
      // + layers, scaled to device pixels) -- the same draw list renderFrame
      // uses, so the capture matches the screen.
      if (!compositor.composeOutput) {
        sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
        return false;
      }
      const r = compositor.composeOutput(session.source.id);
      if (!r) {
        sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
        return false;
      }
      // The advertised buffer_size is the output's device size, which is what
      // composeOutput produces; the earlier W/H == bufferW/bufferH check
      // guarantees the client's buffer matches.
      tex = r.texture;
    } else {
      // Single window: compose its full on-screen subtree (decoration +
      // toplevel + subsurfaces, via computeBaseStack) over its outer rect, at
      // the output scale -- so subsurface content (e.g. a browser's) and the
      // decoration both appear, at device resolution.
      const win = ctx.state.wm?.state.windows.find((w) => w.surfaceId === session.source.id);
      const rect = ctx.state.wm?.outerRectOf(session.source.id);
      const sRec = ctx.state.surfacesById?.get(session.source.id);
      if (!win || !rect || !sRec || !compositor.composeRegion) {
        sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
        return false;
      }
      const drawList = computeBaseStack(ctx.state, [win]);
      const r = compositor.composeRegion({
        drawList,
        region: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        scale: windowOutputScale(ctx, sRec.resource),
      });
      tex = r.texture;
      // If the window resized between advertise and capture, the device dims
      // won't match the client's buffer.
      if (r.outW !== W || r.outH !== H) {
        tex.destroy();
        sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.buffer_constraints);
        return false;
      }
    }
  } catch {
    if (tex) tex.destroy();
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
    return false;
  }

  // Async readback + write into the client's shm buffer, then send ready.
  // The dispatch is fire-and-forget from the flip-complete callback's POV;
  // we never block the per-frame path on the readback.
  void writeAndReady(ctx, f, tex, desc, tvSec, tvNsec);
  return true;
}


// Readback the captured texture into BGRA bytes and memcpy into the client's
// shm buffer (the format is ARGB8888/XRGB8888 in little-endian byte order,
// which is the same byte order as BGRA8Unorm produces -- no swizzle needed).
async function writeAndReady(
  ctx: Ctx,
  f: FrameRecord,
  tex: GPUTexture,
  desc: import("./ctx.js").BufferDesc,
  tvSec: bigint,
  tvNsec: number,
): Promise<void> {
  const session = f.session;
  const W = desc.width ?? 0, H = desc.height ?? 0;
  const compositor = ctx.state.compositor;
  if (!compositor.readbackTexture) {
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
    tex.destroy();
    return;
  }
  const poolId = desc.poolId;
  if (!poolId) {
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
    tex.destroy();
    return;
  }
  try {
    const out = await compositor.readbackTexture(tex, W, H);
    if (f.resource.destroyed || session.stopped) return;
    const stride = desc.stride ?? W * 4;
    const offset = desc.offset ?? 0;
    const length = stride * H;
    const ab = ctx.addon.shmMapWritable(poolId, offset, length);
    if (!ab) {
      sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
      return;
    }
    const dst = new Uint8Array(ab);
    if (stride === W * 4) {
      dst.set(out.data.subarray(0, length));
    } else {
      // Stride > tight: copy row-by-row.
      const rowBytes = W * 4;
      for (let y = 0; y < H; y++) {
        dst.set(out.data.subarray(y * rowBytes, (y + 1) * rowBytes), y * stride);
      }
    }
    // Send metadata + ready, in spec order (transform, damage,
    // presentation_time, then ready).
    sendReady(ctx, f, tvSec, tvNsec, W, H);
  } catch {
    sendFailed(ctx, f, ExtImageCopyCaptureFrameV1_FailureReason.unknown);
  } finally {
    tex.destroy();
  }
}

function sendReady(
  ctx: Ctx, f: FrameRecord, tvSec: bigint, tvNsec: number, W: number, H: number,
): void {
  if (f.captured || f.resource.destroyed) return;
  f.captured = true;
  const e = ctx.events.ext_image_copy_capture_frame_v1;
  // transform: we always render upright (no scanout-side rotation in v1).
  e.send_transform(f.resource, 0);
  // damage: full-buffer on every frame today (subsequent-frame damage
  // tracking would require per-frame diffs we don't accumulate yet -- the
  // spec mandates "first captured frame ... will always carry full damage"
  // and allows the optimization only as a subsequent-frame hint).
  e.send_damage(f.resource, 0, 0, W, H);
  const { hi: tvSecHi, lo: tvSecLo } = splitU64(tvSec);
  e.send_presentation_time(f.resource, tvSecHi, tvSecLo, tvNsec);
  e.send_ready(f.resource);
  // The session's slot is freed once the client destroys the frame; per
  // spec ("The client must destroy the object" after ready), but the
  // session is allowed to accept a new create_frame before the destroy
  // is processed by libwayland on the server -- the spec's
  // `duplicate_frame` guard handles that.
  if (f.session.activeFrame === f.resource) f.session.activeFrame = null;
}

function sendFailed(
  ctx: Ctx, f: FrameRecord, reason: import("#protocols-gen/ext_image_copy_capture_frame_v1.js").ExtImageCopyCaptureFrameV1_FailureReason,
): void {
  if (f.captured || f.resource.destroyed) return;
  f.captured = true;
  ctx.events.ext_image_copy_capture_frame_v1.send_failed(f.resource, reason);
  if (f.session.activeFrame === f.resource) f.session.activeFrame = null;
}

// ---- Bus hooks ------------------------------------------------------------

// Wire up window.unmap (per-toplevel sources -> session.stopped) and
// output.removed (output sources -> session.stopped). Called once from
// installProtocols, mirroring the ext_foreign_toplevel pattern.
export function installImageCopyCaptureBusHooks(ctx: Ctx): void {
  const bus = ctx.state.bus;
  const pluginBus = ctx.state.pluginBus;
  if (bus) {
    bus.on(WINDOW_EVENT.unmap, (ev) => {
      for (const s of sessions.values()) {
        if (s.source.kind !== "toplevel") continue;
        if (s.source.id !== ev.surfaceId) continue;
        stopSession(ctx, s, "source-gone");
      }
    });
  }
  if (pluginBus) {
    // output.pre-remove fires synchronously before state.outputs is torn
    // down -- this is the only window we can still resolve the outputId
    // to a record. We just need its id for the comparison.
    pluginBus.subscribe("output.pre-remove", (_n, payload) => {
      const p = payload as { outputId?: number } | undefined;
      if (!p || typeof p.outputId !== "number") return;
      for (const s of sessions.values()) {
        if (s.source.kind !== "output") continue;
        if (s.source.id !== p.outputId) continue;
        stopSession(ctx, s, "source-gone");
      }
    });
    // output.changed: re-advertise buffer constraints (size may have
    // changed via mode swap / nested host resize).
    pluginBus.subscribe("output.changed", (_n, payload) => {
      const p = payload as { outputId?: number } | undefined;
      if (!p || typeof p.outputId !== "number") return;
      for (const s of sessions.values()) {
        if (s.source.kind !== "output") continue;
        if (s.source.id !== p.outputId) continue;
        const sz = sourceSize(ctx, s.source);
        if (!sz) { stopSession(ctx, s, "source-gone"); continue; }
        if (sz.w === s.bufferW && sz.h === s.bufferH) continue;
        s.bufferW = sz.w; s.bufferH = sz.h;
        sendConstraints(ctx, s);
      }
    });
  }
}

// Test-only reset.
export function _resetForTests(): void {
  sessions.clear();
  frames.clear();
}

// ---- Handlers -------------------------------------------------------------

// Source -- the opaque "what to capture" handle. Only `destroy`.
export function makeImageCaptureSource(_ctx: Ctx): ExtImageCaptureSourceV1Handler {
  return {
    destroy(resource) { sources.delete(resource); },
  };
}

// Output-source manager: create_source(new_id, wl_output).
export default function makeOutputImageCaptureSourceManager(ctx: Ctx):
  ExtOutputImageCaptureSourceManagerV1Handler
{
  return {
    create_source(_mgr, source, output) {
      // Resolve wl_output -> outputId. Returns -1 if the resource is
      // destroyed or untracked; we still create the source, but a session
      // built from it will immediately stop.
      const outputId = outputIdForWlOutput(ctx.state, output) ?? -1;
      sources.set(source, { kind: "output", id: outputId });
    },
    destroy(_mgr) { /* destructor */ },
  };
}

// Foreign-toplevel-source manager: create_source(new_id, foreign_toplevel_handle).
export function makeForeignToplevelImageCaptureSourceManager(ctx: Ctx):
  ExtForeignToplevelImageCaptureSourceManagerV1Handler
{
  return {
    create_source(_mgr, source, handle) {
      void ctx;
      const surfaceId = surfaceIdForHandle(handle);
      sources.set(source, {
        kind: "toplevel", id: surfaceId ?? -1,
      });
    },
    destroy(_mgr) { /* destructor */ },
  };
}

// Manager: create_session, create_pointer_cursor_session, destroy.
export function makeImageCopyCaptureManager(ctx: Ctx):
  ExtImageCopyCaptureManagerV1Handler
{
  return {
    create_session(manager, sessionRes, sourceRes, options) {
      // Validate options bitfield (only paint_cursors=1 is defined).
      const validBits = 1;
      if ((options & ~validBits) !== 0) {
        ctx.addon.postError(manager,
          ExtImageCopyCaptureManagerV1_Error.invalid_option,
          "invalid option flag");
        return;
      }
      const paintCursors = (options & 1) !== 0;

      const src = sources.get(sourceRes);
      // Build the session record either way -- if the source is dead, we
      // still need to advertise some constraint set so the client doesn't
      // hang on the roundtrip, then `stopped` it.
      const sz = src ? sourceSize(ctx, src) : null;
      const rec: SessionRecord = {
        resource: sessionRes, source: src ?? { kind: "output", id: -1 },
        activeFrame: null,
        bufferW: sz?.w ?? 0, bufferH: sz?.h ?? 0,
        stopped: false, paintCursors,
      };
      sessions.set(sessionRes, rec);
      if (!src || !sz) {
        // Source already gone -- send a minimal constraints burst (size 0,
        // no formats, done) then stopped. A real client will see the size
        // and abort; the protocol path stays well-formed.
        const e = ctx.events.ext_image_copy_capture_session_v1;
        e.send_buffer_size(sessionRes, 0, 0);
        e.send_done(sessionRes);
        stopSession(ctx, rec, "source-gone");
        return;
      }
      sendConstraints(ctx, rec);
    },

    create_pointer_cursor_session(_manager, cursorRes, sourceRes, _pointer) {
      // Stubbed: bind the cursor-session resource but advertise no formats
      // on its inner session (see top-of-file rationale). The cursor
      // sub-session itself has events (enter/leave/position/hotspot) we
      // never fire.
      const src = sources.get(sourceRes);
      // Store the cursor-session state on the resource for the
      // get_capture_session callback below.
      cursorSessions.set(cursorRes, {
        source: src ?? { kind: "output", id: -1 },
        innerCreated: false,
      });
    },

    destroy(_manager) { /* destructor */ },
  };
}

// Session handler.
export function makeImageCopyCaptureSession(ctx: Ctx):
  ExtImageCopyCaptureSessionV1Handler
{
  return {
    create_frame(sessionRes, frameRes) {
      const s = sessions.get(sessionRes);
      if (!s) return;
      if (s.activeFrame && !s.activeFrame.destroyed) {
        ctx.addon.postError(sessionRes,
          ExtImageCopyCaptureSessionV1_Error.duplicate_frame,
          "create_frame sent before destroying previous frame");
        return;
      }
      s.activeFrame = frameRes;
      const fr: FrameRecord = {
        resource: frameRes, session: s, buffer: null,
        armed: false, captured: false,
        damageX: 0, damageY: 0, damageW: 0, damageH: 0,
      };
      frames.set(frameRes, fr);
      if (s.stopped) {
        // Newly-created frame on a stopped session: immediately fail it
        // so the client doesn't sit waiting for ready/failed forever.
        // The spec lists `stopped` as a valid failure_reason for exactly
        // this case.
        fr.captured = true;
        ctx.events.ext_image_copy_capture_frame_v1.send_failed(
          frameRes, ExtImageCopyCaptureFrameV1_FailureReason.stopped);
        s.activeFrame = null;
      }
    },
    destroy(sessionRes) {
      const s = sessions.get(sessionRes);
      if (!s) return;
      sessions.delete(sessionRes);
      // Frame objects survive their session per spec ("This request doesn't
      // affect ext_image_copy_capture_frame_v1 objects created by this
      // object"). The frame's own destroy handler cleans it up.
      void s;
    },
  };
}

// Frame handler.
export function makeImageCopyCaptureFrame(ctx: Ctx):
  ExtImageCopyCaptureFrameV1Handler
{
  return {
    destroy(frameRes) {
      const f = frames.get(frameRes);
      if (!f) return;
      frames.delete(frameRes);
      if (f.session.activeFrame === frameRes) f.session.activeFrame = null;
    },
    attach_buffer(frameRes, buffer) {
      const f = frames.get(frameRes);
      if (!f) return;
      if (f.captured) {
        ctx.addon.postError(frameRes,
          ExtImageCopyCaptureFrameV1_Error.already_captured,
          "attach_buffer sent after capture");
        return;
      }
      f.buffer = buffer;
    },
    damage_buffer(frameRes, x, y, width, height) {
      const f = frames.get(frameRes);
      if (!f) return;
      if (f.captured) {
        ctx.addon.postError(frameRes,
          ExtImageCopyCaptureFrameV1_Error.already_captured,
          "damage_buffer sent after capture");
        return;
      }
      if (x < 0 || y < 0 || width <= 0 || height <= 0) {
        ctx.addon.postError(frameRes,
          ExtImageCopyCaptureFrameV1_Error.invalid_buffer_damage,
          "damage_buffer with negative or non-positive dims");
        return;
      }
      // Accumulate the LATEST rect; we use damage only for our reported-
      // damage echo on ready (full-buffer today). Multiple damage_buffer
      // calls coalesce into a bounding box.
      if (f.damageW === 0 && f.damageH === 0) {
        f.damageX = x; f.damageY = y; f.damageW = width; f.damageH = height;
      } else {
        const x1 = Math.min(f.damageX, x);
        const y1 = Math.min(f.damageY, y);
        const x2 = Math.max(f.damageX + f.damageW, x + width);
        const y2 = Math.max(f.damageY + f.damageH, y + height);
        f.damageX = x1; f.damageY = y1;
        f.damageW = x2 - x1; f.damageH = y2 - y1;
      }
    },
    capture(frameRes) {
      const f = frames.get(frameRes);
      if (!f) return;
      if (f.captured) {
        ctx.addon.postError(frameRes,
          ExtImageCopyCaptureFrameV1_Error.already_captured,
          "capture sent twice");
        return;
      }
      if (!f.buffer) {
        ctx.addon.postError(frameRes,
          ExtImageCopyCaptureFrameV1_Error.no_buffer,
          "capture sent without attach_buffer");
        return;
      }
      if (f.session.stopped) {
        f.captured = true;
        ctx.events.ext_image_copy_capture_frame_v1.send_failed(
          frameRes, ExtImageCopyCaptureFrameV1_FailureReason.stopped);
        if (f.session.activeFrame === frameRes) f.session.activeFrame = null;
        return;
      }
      // Arm and wait for the next flip-complete on the relevant output.
      // Wake so an idle compositor (no clients with pending content) still
      // renders the next frame and fires our dispatch.
      f.armed = true;
      ctx.addon.wake();
    },
  };
}

// Cursor sub-session: see top-of-file rationale. We accept the construction
// but advertise NO formats on the inner session, so the client gracefully
// concludes "cursor capture not available."

interface CursorSessionRecord {
  source: SourceRecord;
  innerCreated: boolean;
}
const cursorSessions = new WeakMap<Resource, CursorSessionRecord>();

export function makeImageCopyCaptureCursorSession(ctx: Ctx):
  ExtImageCopyCaptureCursorSessionV1Handler
{
  return {
    destroy(_resource) { /* destructor */ },
    get_capture_session(cursorRes, sessionRes) {
      const rec = cursorSessions.get(cursorRes);
      if (!rec) return;
      if (rec.innerCreated) {
        ctx.addon.postError(cursorRes,
          1 /* duplicate_session */,
          "get_capture_session sent twice");
        return;
      }
      rec.innerCreated = true;
      // Bind the inner session record so requests against it dispatch, but
      // advertise an empty format set + done so the client backs off
      // gracefully. We never fire enter/position/hotspot (out of scope).
      const sRec: SessionRecord = {
        resource: sessionRes,
        source: rec.source,
        activeFrame: null,
        bufferW: 0, bufferH: 0,
        stopped: false, paintCursors: false,
      };
      sessions.set(sessionRes, sRec);
      const e = ctx.events.ext_image_copy_capture_session_v1;
      e.send_buffer_size(sessionRes, 0, 0);
      e.send_done(sessionRes);
      // We don't send `stopped` here -- the spec lets us simply never fire
      // events. The client sees zero formats + done and treats the session
      // as unavailable.
    },
  };
}
