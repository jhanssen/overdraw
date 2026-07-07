// zwlr_output_management_unstable_v1: a transactional protocol for clients
// (wlr-randr, kanshi, wdisplays, KDE display panel) to read and modify
// output device configuration -- position, scale, mode, transform,
// adaptive-sync, enabled. Five interfaces:
//
//   zwlr_output_manager_v1            -- the global; emits head + done(serial)
//   zwlr_output_head_v1               -- one per output; read-only events
//   zwlr_output_mode_v1               -- one per head per mode; read-only events
//   zwlr_output_configuration_v1      -- mutable; build then apply/test
//   zwlr_output_configuration_head_v1 -- per-head mutations in a config
//
// Read-only side: every bound manager carries its own per-output head +
// mode resources (managers don't share resource objects per spec; each
// client gets its own object tree). Heads + modes are auto-allocated by
// the trampoline (send_head/send_mode pass null new_id, the trampoline
// constructs the resource and returns it). Initial burst on bind walks
// state.outputs; subsequent updates come from output.added /
// output.removed / output.changed plugin-bus events. A monotonic
// `currentSerial` is bumped on any output state change and surfaced via
// `done(serial)` after each burst -- this is the serial clients echo on
// create_configuration so the server can detect stale configurations.
//
// Apply side: create_configuration(serial) returns a new config object.
// The client populates it via enable_head/disable_head + per-head
// set_position/set_scale/set_mode/set_transform/set_adaptive_sync, then
// applies (or tests). Current scope:
//
//   - set_position / set_scale: applied through state.outputs and the
//     existing layer-push path (pushOutputsToLayers); output.changed
//     fires synchronously.
//   - set_mode: ACCEPTED for a mode that was advertised on the same
//     head (looked up via the per-head mode list). Dispatched to
//     addon.switchOutputMode, which sends a SwitchMode wire frame to
//     the GPU process. The protocol's apply replies `succeeded`
//     immediately; the actual mode swap completes asynchronously and
//     the resulting OutputDescriptor re-emit drives output.changed
//     to bound clients (per spec: "In case the configuration is
//     successfully applied, there is no guarantee that the new output
//     state matches completely the requested configuration").
//   - set_custom_mode: REJECTED with `failed` (no DRM mode-table
//     validation today).
//   - set_transform != normal: REJECTED with `failed` (no rotated-
//     output rendering).
//   - set_adaptive_sync: REJECTED with `failed` (VRR_ENABLED connector
//     property not wired).
//   - disable_head: REJECTED with `failed` ("connected but dark" is
//     new state-machine territory and not v1).
//   - A configuration with NO head mutations applies as `succeeded`
//     (the client is just probing).
//   - A configuration whose serial is stale replies `cancelled` per
//     spec; the client re-creates with a fresh serial after the next
//     done event.

import { signature as headSig } from "#protocols-gen/zwlr_output_head_v1.js";
import { signature as modeSig } from "#protocols-gen/zwlr_output_mode_v1.js";
import type { ZwlrOutputManagerV1Handler } from "#protocols-gen/zwlr_output_manager_v1.js";
import type { ZwlrOutputHeadV1Handler } from "#protocols-gen/zwlr_output_head_v1.js";
import type { ZwlrOutputModeV1Handler } from "#protocols-gen/zwlr_output_mode_v1.js";
import type {
  ZwlrOutputConfigurationV1Handler,
} from "#protocols-gen/zwlr_output_configuration_v1.js";
import type {
  ZwlrOutputConfigurationHeadV1Handler,
} from "#protocols-gen/zwlr_output_configuration_head_v1.js";

import type { Ctx, OutputRecord } from "./ctx.js";
import type { Resource } from "../types.js";
import { pushOutputsToLayers } from "../output/hotplug.js";
import { durableKeyOf } from "../output/arrangement.js";
import { logicalSize, snapScale } from "../output/scale.js";
import { updateAllSurfaceResidency } from "./surface-residency.js";
import { reemitFractionalScale } from "./wp_fractional_scale_manager_v1.js";

// Unused but documents the source of the enum values applied below.
void headSig;
void modeSig;

// One advertised mode object, with the dims/refresh used to resolve a
// client-picked zwlr_output_mode_v1 back to (width, height, refreshMhz).
interface ModeEntry {
  resource: Resource;
  width: number;
  height: number;
  refreshMhz: number;
}

// Per-head bookkeeping inside one bound manager. `modes` is keyed by
// the mode resource itself (clients reference modes by that resource on
// configuration_head.set_mode). The configurations look up dims/refresh
// via the matching ModeEntry. `currentModeRes` is the mode resource the
// head reports as `current_mode` -- one of the entries in `modes`.
interface HeadEntry {
  head: Resource;
  modes: ModeEntry[];
  currentModeRes: Resource | null;
  outputId: number;
}

// Per-bound-manager state. Each client that binds the manager global gets
// its own ManagerState with its own head + mode resources -- the protocol
// doesn't share resources across clients.
interface ManagerState {
  resource: Resource;
  heads: Map<number, HeadEntry>; // outputId -> head/mode/outputId
  active: boolean;               // false after stop() / finished
}

// In-progress configuration object. Lives between create_configuration and
// apply/test (after which the spec says only destroy may be sent).
interface ConfigState {
  resource: Resource;
  serial: number;             // serial the client echoed
  used: boolean;              // true after apply() or test() ran
  // Maps from configuration_head resource -> the head it configures.
  // disable_head doesn't create a configuration_head, so disabled heads
  // are tracked separately.
  enabled: Map<Resource, ConfigHeadState>;
  disabled: Set<number>;      // outputIds explicitly disabled
  touched: Set<number>;       // outputIds appearing on either side; used to detect dup
}

// Per-configured-head mutations the client accumulated.
interface ConfigHeadState {
  resource: Resource;
  configResource: Resource;   // parent configuration
  outputId: number;
  position?: { x: number; y: number };
  scale?: number;             // wl_fixed (24.8); decoded on apply.
  mode?: Resource;            // a zwlr_output_mode_v1 the client picked
  customMode?: { width: number; height: number; refresh: number };
  transform?: number;
  adaptiveSync?: number;
  // Flags so apply() can detect set-twice (also_set protocol error). The
  // spec actually says "set the same property twice" is a protocol error
  // we should post on the wire; for v1 we treat it as a failed apply
  // (no wl_resource_post_error mechanism today -- see status.md).
  positionSet: boolean;
  scaleSet: boolean;
  modeSet: boolean;
  transformSet: boolean;
  adaptiveSyncSet: boolean;
}

// Module-local state -- mirrors the foreign-toplevel pattern. Managers
// are owned by their bound resource lifetime; reverse-lookup maps let
// the per-resource request handlers find their owner.
const managers = new Set<ManagerState>();
const headOwners = new WeakMap<Resource, { manager: ManagerState; entry: HeadEntry }>();
const modeOwners = new WeakMap<Resource, { manager: ManagerState; outputId: number }>();
const configOwners = new WeakMap<Resource, ConfigState>();
const configHeadOwners = new WeakMap<Resource, ConfigHeadState>();

// Monotonic configuration serial. Bumped on every output state change
// (add / remove / position / scale / mode / transform / enabled). Surfaced
// to clients via manager.done(serial); echoed back on create_configuration.
let currentSerial = 0;

// installOutputManagerBusHooks (called once by installProtocols) wires the
// plugin-bus subscribers for output.added/removed/changed. The ctx
// reference here is the live one for the running compositor; lazy
// per-bind install would freeze a stale ctx across test instances.

// ---- Helpers ------------------------------------------------------------

// Extract the protocol's `serial_number` event value from the durable
// edidId ("MFR-PRODHEX-SERIALHEX"). The compositor's edidId already
// composes the EDID-derived identity that clients use to recognize heads
// across sessions; the serial-portion suffix is exactly what most clients
// (wlr-randr, kanshi) read for this purpose. Empty edidId -> empty
// serial_number; the event is then skipped per spec.
function edidSerialNumber(edidId: string): string {
  // edidId looks like "DEL-40A1-12345678"; the last '-' splits the serial.
  const i = edidId.lastIndexOf("-");
  if (i < 0) return edidId;
  return edidId.slice(i + 1);
}

// Encode a number into the wl_output.transform enum used by the
// configuration_head.set_transform request. v1 rejects anything non-zero.
function isNormalTransform(t: number): boolean {
  return t === 0;
}

// wl_fixed -> double. wl_fixed is a 24.8 signed fixed-point integer.
function fixedToDouble(v: number): number {
  return v / 256;
}

// Send the full read-only event burst for one head on one manager. Spec
// requires name/description/physical_size/mode/enabled before any
// non-static events (current_mode/position/transform/scale/etc.). The
// done event is emitted by the caller after the whole burst across all
// affected heads.
// Emit one zwlr_output_mode_v1 child of `headRes` carrying the given
// dims + refresh + preferred bit. Returns the ModeEntry for tracking.
function emitOneMode(
  ctx: Ctx, mgr: ManagerState, outputId: number, headRes: Resource,
  width: number, height: number, refreshMhz: number, preferred: boolean,
): ModeEntry {
  const modeRes = ctx.events.zwlr_output_head_v1.send_mode(headRes, null) as Resource;
  modeOwners.set(modeRes, { manager: mgr, outputId });
  ctx.events.zwlr_output_mode_v1.send_size(modeRes, width, height);
  if (refreshMhz > 0) {
    ctx.events.zwlr_output_mode_v1.send_refresh(modeRes, refreshMhz);
  }
  if (preferred) ctx.events.zwlr_output_mode_v1.send_preferred(modeRes);
  return { resource: modeRes, width, height, refreshMhz };
}

// Build the list of modes to advertise for a head. KMS-mode records
// drive the list when rec.availableModes is populated; the nested
// fallback synthesizes a single mode from the current dims (matching
// the pre-multi-mode behavior).
function buildModeList(rec: OutputRecord):
    Array<{ width: number; height: number; refreshMhz: number; preferred: boolean }> {
  if (rec.availableModes && rec.availableModes.length > 0) {
    return rec.availableModes.map((m) => ({
      width: m.width, height: m.height,
      refreshMhz: m.refreshMhz, preferred: m.preferred,
    }));
  }
  // Synthetic single-mode advertisement for nested-host outputs (no
  // connector mode list). Marked preferred so a client picking by
  // preferred-only finds it.
  return [{
    width: rec.deviceSize.width, height: rec.deviceSize.height,
    refreshMhz: rec.refreshMhz, preferred: true,
  }];
}

// Pick the ModeEntry whose dims + refresh match the OutputRecord's
// current state. Refresh tolerance ~100 mHz (matches drm_utils::findMode).
// Returns null when no match (no current_mode event emitted).
function findCurrentMode(rec: OutputRecord, modes: ModeEntry[]): ModeEntry | null {
  for (const m of modes) {
    // A mode the client released must never be re-selected: sending it as
    // a current_mode argument would reference a destroyed resource.
    if (m.resource.destroyed) continue;
    if (m.width !== rec.deviceSize.width || m.height !== rec.deviceSize.height) continue;
    const delta = Math.abs(m.refreshMhz - rec.refreshMhz);
    if (delta > 100 && rec.refreshMhz > 0) continue;
    return m;
  }
  return null;
}

function emitHeadInitial(ctx: Ctx, mgr: ManagerState, rec: OutputRecord): HeadEntry {
  const headRes = ctx.events.zwlr_output_manager_v1.send_head(mgr.resource, null) as Resource;

  const entry: HeadEntry = {
    head: headRes,
    modes: [],
    currentModeRes: null,
    outputId: rec.id,
  };
  mgr.heads.set(rec.id, entry);
  headOwners.set(headRes, { manager: mgr, entry });

  // Static events (sent once per object).
  ctx.events.zwlr_output_head_v1.send_name(headRes, rec.name);
  ctx.events.zwlr_output_head_v1.send_description(headRes, rec.description);
  if (rec.physicalWidthMm > 0 || rec.physicalHeightMm > 0) {
    ctx.events.zwlr_output_head_v1.send_physical_size(
      headRes, rec.physicalWidthMm, rec.physicalHeightMm);
  }
  // make/model/serial_number are version >= 2.
  if (headRes.version >= 2) {
    if (rec.make !== "") ctx.events.zwlr_output_head_v1.send_make(headRes, rec.make);
    if (rec.model !== "") ctx.events.zwlr_output_head_v1.send_model(headRes, rec.model);
    const sn = edidSerialNumber(rec.edidId);
    if (sn !== "") ctx.events.zwlr_output_head_v1.send_serial_number(headRes, sn);
  }

  // Advertise every mode the connector supports. Each is a child
  // zwlr_output_mode_v1 object; static events (size/refresh/preferred)
  // fire once per object.
  for (const m of buildModeList(rec)) {
    entry.modes.push(emitOneMode(ctx, mgr, rec.id, headRes,
      m.width, m.height, m.refreshMhz, m.preferred));
  }
  entry.currentModeRes = findCurrentMode(rec, entry.modes)?.resource ?? null;

  // Mutable state. enabled is implicitly true for every output in
  // state.outputs (disabled outputs aren't yet a thing here); when it
  // becomes representable, drive it from rec.
  ctx.events.zwlr_output_head_v1.send_enabled(headRes, 1);
  if (entry.currentModeRes !== null) {
    ctx.events.zwlr_output_head_v1.send_current_mode(headRes, entry.currentModeRes);
  }
  ctx.events.zwlr_output_head_v1.send_position(
    headRes, rec.logicalPosition.x, rec.logicalPosition.y);
  // wl_output.transform: normal=0. The protocol field is typed enum but the
  // wire is uint; the generated send_transform accepts a number.
  ctx.events.zwlr_output_head_v1.send_transform(headRes, rec.transform as 0);
  // scale is wl_fixed.
  ctx.events.zwlr_output_head_v1.send_scale(headRes, Math.round(rec.scale * 256));
  // adaptive_sync (version >= 4) -- always disabled today.
  if (headRes.version >= 4) {
    ctx.events.zwlr_output_head_v1.send_adaptive_sync(headRes, 0);
  }

  return entry;
}

// Re-emit the MUTABLE portion of a head's state (position / transform /
// scale / current_mode / enabled / adaptive_sync). Static events on
// mode objects are emit-once per spec; this resolves the new
// `current_mode` pointer against the already-advertised mode list. A
// mode swap that drops to a different advertised mode just changes
// which entry the head points at -- no new mode object is created.
function emitHeadUpdate(ctx: Ctx, entry: HeadEntry, rec: OutputRecord): void {
  entry.currentModeRes = findCurrentMode(rec, entry.modes)?.resource ?? null;

  ctx.events.zwlr_output_head_v1.send_enabled(entry.head, 1);
  if (entry.currentModeRes !== null) {
    ctx.events.zwlr_output_head_v1.send_current_mode(entry.head, entry.currentModeRes);
  }
  ctx.events.zwlr_output_head_v1.send_position(
    entry.head, rec.logicalPosition.x, rec.logicalPosition.y);
  ctx.events.zwlr_output_head_v1.send_transform(entry.head, rec.transform as 0);
  ctx.events.zwlr_output_head_v1.send_scale(entry.head, Math.round(rec.scale * 256));
  if (entry.head.version >= 4) {
    ctx.events.zwlr_output_head_v1.send_adaptive_sync(entry.head, 0);
  }
}

// Mark a head + its mode as finished and drop them from the manager's
// map. Per spec the resource becomes inert; the client destroys it on
// its own time.
function finishHead(ctx: Ctx, mgr: ManagerState, outputId: number): void {
  const entry = mgr.heads.get(outputId);
  if (!entry) return;
  // Every mode object becomes inert before the head itself (the head
  // holds current_mode references to one of them).
  for (const m of entry.modes) {
    ctx.events.zwlr_output_mode_v1.send_finished(m.resource);
  }
  ctx.events.zwlr_output_head_v1.send_finished(entry.head);
  mgr.heads.delete(outputId);
}

function bumpSerialAndAnnounce(ctx: Ctx): void {
  currentSerial = (currentSerial + 1) >>> 0;
  for (const mgr of managers) {
    if (!mgr.active) continue;
    ctx.events.zwlr_output_manager_v1.send_done(mgr.resource, currentSerial);
  }
}

// Wire the plugin-bus subscribers for output lifecycle / change events.
// Called from installProtocols after the global is registered. No-ops
// when no pluginBus is configured (GPU-free harnesses that only exercise
// the bind path can omit it).
export function installOutputManagerBusHooks(ctx: Ctx): void {
  const pb = ctx.state.pluginBus;
  if (!pb) return;

  pb.subscribe("output.added", (_name, payload) => {
    const p = payload as { outputId?: number } | undefined;
    if (!p || typeof p.outputId !== "number") return;
    const rec = ctx.state.outputs?.get(p.outputId);
    if (!rec) return;
    for (const mgr of managers) {
      if (!mgr.active) continue;
      emitHeadInitial(ctx, mgr, rec);
    }
    bumpSerialAndAnnounce(ctx);
  });

  pb.subscribe("output.removed", (_name, payload) => {
    const p = payload as { outputId?: number } | undefined;
    if (!p || typeof p.outputId !== "number") return;
    for (const mgr of managers) {
      if (!mgr.active) continue;
      finishHead(ctx, mgr, p.outputId);
    }
    bumpSerialAndAnnounce(ctx);
  });

  pb.subscribe("output.modes-changed", (_name, payload) => {
    // The advertised mode list for one output changed (initial KMS
    // OutputModes arrival; hot-plugged connector). The protocol spec
    // says zwlr_output_mode_v1 events are emit-once and a mode going
    // away sends `finished`. We honor that here: every existing mode
    // resource on every bound manager gets a `finished`, then we
    // advertise the fresh list as new resources and repoint current_mode.
    const p = payload as { outputId?: number } | undefined;
    if (!p || typeof p.outputId !== "number") return;
    const rec = ctx.state.outputs?.get(p.outputId);
    if (!rec) return;
    for (const mgr of managers) {
      if (!mgr.active) continue;
      const entry = mgr.heads.get(p.outputId);
      if (!entry) continue;
      // Finish the old mode objects.
      for (const m of entry.modes) {
        ctx.events.zwlr_output_mode_v1.send_finished(m.resource);
        modeOwners.delete(m.resource);
      }
      entry.modes = [];
      // Re-advertise from the new list.
      for (const m of buildModeList(rec)) {
        entry.modes.push(emitOneMode(ctx, mgr, rec.id, entry.head,
          m.width, m.height, m.refreshMhz, m.preferred));
      }
      entry.currentModeRes = findCurrentMode(rec, entry.modes)?.resource ?? null;
      if (entry.currentModeRes !== null) {
        ctx.events.zwlr_output_head_v1.send_current_mode(entry.head, entry.currentModeRes);
      }
    }
    bumpSerialAndAnnounce(ctx);
  });

  pb.subscribe("output.changed", (_name, payload) => {
    // wl_output's existing main.ts subscriber re-emits wl_output / xdg_output;
    // we layer output-management's per-head update on top, scoped to the
    // outputId in the payload when present (or every head when absent).
    const p = payload as { outputId?: number } | undefined;
    let any = false;
    for (const mgr of managers) {
      if (!mgr.active) continue;
      if (p && typeof p.outputId === "number") {
        const entry = mgr.heads.get(p.outputId);
        const rec = ctx.state.outputs?.get(p.outputId);
        if (entry && rec) { emitHeadUpdate(ctx, entry, rec); any = true; }
      } else {
        // No outputId in payload -- re-emit every head this manager owns
        // against the current state. Cheap; outputs are few.
        for (const [outputId, entry] of mgr.heads) {
          const rec = ctx.state.outputs?.get(outputId);
          if (rec) { emitHeadUpdate(ctx, entry, rec); any = true; }
        }
      }
    }
    if (any) bumpSerialAndAnnounce(ctx);
  });
}

// ---- Manager handler ----------------------------------------------------

export default function makeOutputManager(
  ctx: Ctx,
): ZwlrOutputManagerV1Handler & { bind(resource: Resource): void } {
  return {
    bind(resource) {
      const mgr: ManagerState = { resource, heads: new Map(), active: true };
      managers.add(mgr);
      // Initial burst: every live output.
      const outputs = ctx.state.outputs;
      if (outputs) {
        for (const rec of outputs.values()) {
          emitHeadInitial(ctx, mgr, rec);
        }
      }
      // Spec: "Immediately after the output manager is bound, all current
      // heads are advertised" then a single done(serial) closes the burst.
      // The serial is the current global value -- not incremented here
      // (the catch-up is observation of state, not a new state version).
      ctx.events.zwlr_output_manager_v1.send_done(resource, currentSerial);
    },
    create_configuration(resource, id, serial) {
      // The trampoline auto-creates `id` and resolves it to a Resource for
      // us. Build a ConfigState and bind it to that resource.
      const idRes: Resource = id;
      const cfg: ConfigState = {
        resource: idRes,
        serial,
        used: false,
        enabled: new Map(),
        disabled: new Set(),
        touched: new Set(),
      };
      configOwners.set(idRes, cfg);
      // Track the parent manager only via the bus -- the manager doesn't
      // own configurations after creation; their lifetime is the
      // configuration object's own. (Match wl_data_offer / etc.)
      void resource;
    },
    stop(resource) {
      // Client doesn't want events anymore. Send finished and mark the
      // manager inactive. Per spec, "The server will destroy the object
      // immediately after sending this event"; the trampoline's
      // destructor logic owns that.
      for (const mgr of managers) {
        if (mgr.resource !== resource) continue;
        if (!mgr.active) return;
        mgr.active = false;
        ctx.events.zwlr_output_manager_v1.send_finished(resource);
        managers.delete(mgr);
        return;
      }
    },
  };
}

// ---- Head handler -------------------------------------------------------

export function makeOutputHead(_ctx: Ctx): ZwlrOutputHeadV1Handler {
  return {
    release(resource) {
      // Client done with head. Drop the per-manager mapping; the
      // trampoline tears down the underlying resource.
      const owner = headOwners.get(resource);
      if (!owner) return;
      owner.manager.heads.delete(owner.entry.outputId);
      headOwners.delete(resource);
      // The mode resource may still be alive (the client may not have
      // released it yet); leave its modeOwners entry until the client
      // calls mode.release().
    },
  };
}

// ---- Mode handler -------------------------------------------------------

export function makeOutputMode(_ctx: Ctx): ZwlrOutputModeV1Handler {
  return {
    release(resource) {
      // Prune the released mode from its head's advertised list so a later
      // head update cannot re-select it as current_mode (the resource is
      // destroyed; referencing it in an event would kill the client).
      const owner = modeOwners.get(resource);
      if (owner) {
        const entry = owner.manager.heads.get(owner.outputId);
        if (entry) {
          entry.modes = entry.modes.filter((m) => m.resource !== resource);
          if (entry.currentModeRes === resource) entry.currentModeRes = null;
        }
      }
      modeOwners.delete(resource);
    },
  };
}

// ---- Configuration handler ---------------------------------------------

export function makeOutputConfiguration(
  ctx: Ctx,
): ZwlrOutputConfigurationV1Handler {
  return {
    enable_head(resource, id, head) {
      const cfg = configOwners.get(resource);
      if (!cfg || cfg.used) return;
      const headRes: Resource = head;
      const idRes: Resource = id;
      const headOwner = headOwners.get(headRes);
      // The protocol requires we not see a head twice across enable/disable.
      // Without wl_resource_post_error, mark the config so apply() fails.
      if (!headOwner) {
        cfg.used = true; // poison: any subsequent apply returns failed
        return;
      }
      const outputId = headOwner.entry.outputId;
      if (cfg.touched.has(outputId)) { cfg.used = true; return; }
      cfg.touched.add(outputId);

      const ch: ConfigHeadState = {
        resource: idRes,
        configResource: resource,
        outputId,
        positionSet: false, scaleSet: false, modeSet: false,
        transformSet: false, adaptiveSyncSet: false,
      };
      cfg.enabled.set(idRes, ch);
      configHeadOwners.set(idRes, ch);
    },
    disable_head(resource, head) {
      const cfg = configOwners.get(resource);
      if (!cfg || cfg.used) return;
      const headRes: Resource = head;
      const headOwner = headOwners.get(headRes);
      if (!headOwner) { cfg.used = true; return; }
      const outputId = headOwner.entry.outputId;
      if (cfg.touched.has(outputId)) { cfg.used = true; return; }
      cfg.touched.add(outputId);
      cfg.disabled.add(outputId);
    },
    apply(resource) {
      runApplyOrTest(ctx, resource, /*commit=*/ true);
    },
    test(resource) {
      runApplyOrTest(ctx, resource, /*commit=*/ false);
    },
    destroy(resource) {
      const cfg = configOwners.get(resource);
      if (cfg) {
        for (const ch of cfg.enabled.values()) configHeadOwners.delete(ch.resource);
        configOwners.delete(resource);
      }
    },
  };
}

// ---- Configuration-head handler ----------------------------------------

export function makeOutputConfigurationHead(
  _ctx: Ctx,
): ZwlrOutputConfigurationHeadV1Handler {
  // Spec calls "set the same property twice" a protocol error; absent
  // wl_resource_post_error, poison the parent configuration so the next
  // apply/test returns failed deterministically.
  type SetFlag = "positionSet" | "scaleSet" | "modeSet" | "transformSet" | "adaptiveSyncSet";
  function setOnce(ch: ConfigHeadState, flag: SetFlag, fn: () => void): void {
    if (ch[flag]) {
      const parent = configOwners.get(ch.configResource);
      if (parent) parent.used = true;
      return;
    }
    fn();
    ch[flag] = true;
  }
  return {
    set_mode(resource, mode) {
      const ch = configHeadOwners.get(resource);
      if (!ch) return;
      setOnce(ch, "modeSet", () => { ch.mode = mode; });
    },
    set_custom_mode(resource, width, height, refresh) {
      const ch = configHeadOwners.get(resource);
      if (!ch) return;
      setOnce(ch, "modeSet", () => { ch.customMode = { width, height, refresh }; });
    },
    set_position(resource, x, y) {
      const ch = configHeadOwners.get(resource);
      if (!ch) return;
      setOnce(ch, "positionSet", () => { ch.position = { x, y }; });
    },
    set_transform(resource, transform) {
      const ch = configHeadOwners.get(resource);
      if (!ch) return;
      setOnce(ch, "transformSet", () => { ch.transform = transform; });
    },
    set_scale(resource, scale) {
      const ch = configHeadOwners.get(resource);
      if (!ch) return;
      setOnce(ch, "scaleSet", () => { ch.scale = scale; });
    },
    set_adaptive_sync(resource, state) {
      const ch = configHeadOwners.get(resource);
      if (!ch) return;
      setOnce(ch, "adaptiveSyncSet", () => { ch.adaptiveSync = state; });
    },
  };
}

// Shared apply/test pipeline. `commit=true` mutates state on success;
// `commit=false` only validates. Both reply on the wire identically:
// succeeded / failed / cancelled.
function runApplyOrTest(ctx: Ctx, resource: Resource, commit: boolean): void {
  const cfg = configOwners.get(resource);
  if (!cfg) return;
  if (cfg.used) {
    ctx.events.zwlr_output_configuration_v1.send_failed(resource);
    return;
  }
  cfg.used = true;
  if (cfg.serial !== currentSerial) {
    ctx.events.zwlr_output_configuration_v1.send_cancelled(resource);
    return;
  }
  const reason = validateConfig(ctx, cfg);
  if (reason !== null) {
    ctx.events.zwlr_output_configuration_v1.send_failed(resource);
    return;
  }
  if (commit) commitConfig(ctx, cfg);
  ctx.events.zwlr_output_configuration_v1.send_succeeded(resource);
}

// Validate a configuration against the current accept/reject matrix.
// Returns null if applying it is legal (commitConfig is safe to call),
// otherwise a short reason string the caller folds into `failed`.
//
// Accepted: set_position (any integer), set_scale (positive fixed).
// Rejected:
//   - disable_head: no "connected but dark" state machine yet.
//   - set_mode / set_custom_mode: needs ScanoutRebuild (follow-up).
//   - set_transform != 0: no rotated rendering today.
//   - set_adaptive_sync: VRR_ENABLED connector property not wired.
//   - any head not in state.outputs (stale reference).
// Resolve a client-picked zwlr_output_mode_v1 resource to its dims and
// refresh by walking the owning head's mode list. Returns null when the
// mode doesn't belong to a tracked head (stale resource, never finished
// by the client) -- the protocol treats that as an apply-time error.
function resolveModeResource(modeRes: Resource):
    { entry: ModeEntry; outputId: number } | null {
  const owner = modeOwners.get(modeRes);
  if (!owner) return null;
  const head = owner.manager.heads.get(owner.outputId);
  if (!head) return null;
  for (const m of head.modes) {
    if (m.resource === modeRes) return { entry: m, outputId: owner.outputId };
  }
  return null;
}

function validateConfig(ctx: Ctx, cfg: ConfigState): string | null {
  if (cfg.disabled.size > 0) return "disable_head not supported";
  for (const ch of cfg.enabled.values()) {
    if (!ctx.state.outputs?.has(ch.outputId)) return "head no longer present";
    if (ch.transformSet && ch.transform !== undefined && !isNormalTransform(ch.transform)) {
      return "non-normal transform not supported";
    }
    if (ch.adaptiveSyncSet) return "adaptive_sync not supported";
    if (ch.modeSet) {
      // set_custom_mode (no mode resource, just dims) is rejected in v1.
      if (ch.customMode !== undefined) return "set_custom_mode not supported";
      if (!ch.mode) return "set_mode without mode resource";
      const resolved = resolveModeResource(ch.mode);
      if (!resolved) return "set_mode: mode not advertised on this head";
      if (resolved.outputId !== ch.outputId) {
        // Spec: invalid_mode (mode doesn't belong to head).
        return "set_mode: mode does not belong to this head";
      }
    }
    if (ch.scaleSet) {
      const s = ch.scale !== undefined ? fixedToDouble(ch.scale) : 0;
      if (!(s > 0)) return "scale must be positive";
    }
    // positionSet has no further validation -- any integer (x, y) is legal,
    // including negative.
  }
  return null;
}

// Commit a validated configuration: mutate state.outputs, propagate to
// every layer (compositor / WM / input / wl_output / xdg-output /
// fractional-scale / surface residency), update the durable memory maps,
// and bump done(serial) so other bound managers see the change.
function commitConfig(ctx: Ctx, cfg: ConfigState): void {
  const outputs = ctx.state.outputs;
  if (!outputs) return;
  let mutated = false;
  for (const ch of cfg.enabled.values()) {
    const rec = outputs.get(ch.outputId);
    if (!rec) continue;
    const durable = durableKeyOf(rec);
    if (ch.positionSet && ch.position) {
      if (rec.logicalPosition.x !== ch.position.x || rec.logicalPosition.y !== ch.position.y) {
        rec.logicalPosition = { x: ch.position.x, y: ch.position.y };
        if (durable !== "") {
          if (!ctx.state.outputPositionMemory) ctx.state.outputPositionMemory = new Map();
          ctx.state.outputPositionMemory.set(durable, { x: ch.position.x, y: ch.position.y });
        }
        mutated = true;
      }
    }
    if (ch.scaleSet && ch.scale !== undefined) {
      const newScale = snapScale(fixedToDouble(ch.scale));
      if (rec.scale !== newScale) {
        rec.scale = newScale;
        rec.logicalSize = logicalSize(rec.deviceSize.width, rec.deviceSize.height, newScale);
        if (durable !== "") {
          if (!ctx.state.outputScaleMemory) ctx.state.outputScaleMemory = new Map();
          ctx.state.outputScaleMemory.set(durable, newScale);
        }
        mutated = true;
      }
    }
    if (ch.modeSet && ch.mode) {
      // validateConfig already resolved the mode and confirmed it
      // belongs to the head. Look it up again to get dims/refresh,
      // then dispatch to the addon's async switchOutputMode. The
      // protocol's apply replies `succeeded` immediately; the actual
      // mode swap completes asynchronously and the resulting
      // OutputDescriptor re-emit drives the subsequent output.changed
      // event to bound clients.
      const resolved = resolveModeResource(ch.mode);
      if (resolved) {
        const m = resolved.entry;
        // No-op when the requested mode already matches current dims.
        if (m.width !== rec.deviceSize.width
            || m.height !== rec.deviceSize.height
            || (rec.refreshMhz > 0 && Math.abs(m.refreshMhz - rec.refreshMhz) > 100)) {
          ctx.addon.switchOutputMode(ch.outputId, m.width, m.height, m.refreshMhz);
          // Mode change is async: don't set mutated. The
          // OutputDescriptor re-emit from the GPU process will fire
          // output.changed later, which the bus subscribers handle.
        }
      }
    }
  }
  if (!mutated) return;

  // Propagate to internal layers (compositor / WM / input). Same helper
  // hotplug uses, so the order matches.
  pushOutputsToLayers({ addon: ctx.addon, state: ctx.state, compositor: ctx.state.compositor });
  ctx.state.relayout?.("output-resized");

  // Surfaces' residency / primary-output may have shifted (positions
  // changed -> different overlap; scales changed -> different
  // fractional-scale preferred value).
  updateAllSurfaceResidency(ctx.state, ctx.addon);
  reemitFractionalScale(ctx.state);

  // External clients (wl_output + xdg_output re-emit) and the manager's
  // own bus subscriber: emit output.changed per affected output.
  for (const ch of cfg.enabled.values()) {
    const rec = outputs.get(ch.outputId);
    if (!rec) continue;
    ctx.state.pluginBus?.emit("output.changed", {
      outputId: rec.id,
      name: rec.name,
      edidId: rec.edidId,
      width: rec.logicalSize.width,
      height: rec.logicalSize.height,
      scale: rec.scale,
      refreshMhz: rec.refreshMhz,
    });
  }
}

// ---- Test-only reset ----------------------------------------------------

export function _resetForTests(): void {
  managers.clear();
  currentSerial = 0;
}
