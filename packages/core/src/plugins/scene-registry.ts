// Core-side registry that gives every SceneHandle (in-thread or Worker)
// an integer id that survives the SDK boundary. Used by:
//
//   - compose-sdk (in-thread): registers on SceneHandle construction;
//     unregisters on SceneHandle.release().
//   - gpu-broker (Worker compose.snapshot / compose.live): registers on
//     dmabuf alloc; unregisters on compose.release.
//   - transitions-broker: looks up the core-side texture by id when
//     installing a transition; pins the entry while the transition is
//     active so the handle's release() can refuse / be deferred.
//
// The id space is process-local (compositor-wide), monotonic, never
// reused. ids cross postMessage as plain integers; the entries
// themselves NEVER cross the boundary (they hold GPUTextures + sync
// callbacks that don't structured-clone).
//
// Note this is core-side state. The registry lives in the SAME process
// as the JsCompositor + the gpu-broker; the Worker plugin holds only
// the integer id.

export type SceneId = number;

// What the transitions broker (or any future consumer) needs from a
// registered scene. resolveTextures is for the Worker-live case: the
// underlying ring rotates each frame, so a stable .texture would point
// at a single slot whose contents change between frames. Returning a
// per-frame callback lets the compositor re-pick which slot to sample.
// Stable cases (in-thread snapshot/live, Worker snapshot) set it to
// undefined; the texture field is used directly.
export interface SceneEntry {
  // outW/outH are the scene's output dims. The transition pipeline
  // assumes input dims match the on-screen output; the broker
  // validates this at install time.
  readonly outW: number;
  readonly outH: number;
  // Stable handle for the simple cases. For Worker-live, this is the
  // representative slot-0 texture (so a one-shot read returns something
  // valid); per-frame consumers should prefer resolveTextures().
  readonly texture: GPUTexture;
  // Per-frame texture pick. Null means "no texture available this
  // frame" (e.g. the ring has nothing PRESENTED yet); the compositor's
  // transition pass falls back to opaque-black for that frame.
  readonly resolveTexture?: () => GPUTexture | null;
  // Called when the FIRST pin attaches; returns a release closure
  // called when the LAST pin drops. Used to open/close access brackets
  // on shared-texture-memory-backed scenes (Worker compose snapshot
  // and live) so consumers like the transitions broker can sample
  // safely. For non-STM scenes (in-thread compose) this is undefined
  // -- the texture is core-owned and always sampleable.
  //
  // The registry guarantees acquireForSampling fires exactly once on
  // the 0 -> 1 pin edge and the returned release fires exactly once
  // on the 1 -> 0 pin edge (or on unregister if the producer side
  // tears down first).
  readonly acquireForSampling?: () => () => void;
}

// Internal storage: a slot in the registry. pinned is a refcount the
// transitions broker increments while a transition holds the scene;
// unregister() defers the entry's removal callback until pinned == 0,
// which prevents a buggy plugin's handle.release() from yanking the
// texture out from under an in-flight transition.
interface Slot {
  entry: SceneEntry;
  pinned: number;
  // Called when the LAST unregister fires AND the slot is unpinned.
  // The producer (compose-sdk / gpu-broker) supplies this so the
  // registry doesn't need to know which underlying resource to free.
  onTeardown: () => void;
  // True once unregister() has been called; final teardown is gated
  // on unpinned.
  removing: boolean;
  // Release closure produced by acquireForSampling on the 0 -> 1
  // pin edge. Called on the 1 -> 0 pin edge (or on final teardown
  // if pins are still held when removal happens, which is a
  // producer bug we surface but don't crash on). null when no
  // acquireForSampling was set.
  release: (() => void) | null;
}

export interface SceneRegistry {
  // Allocate a fresh id + record the entry. The producer must call
  // unregister() exactly once when its handle is released. onTeardown
  // fires after the LAST pin drops; that's when the underlying
  // resource (in-thread compose texture, Worker dmabuf, etc.) is
  // actually freed.
  register(entry: SceneEntry, onTeardown: () => void): SceneId;
  // Drop the producer's ownership. If no consumers (transitions
  // broker, etc.) have pinned, fires onTeardown synchronously. Else
  // defers until the last pin drops.
  unregister(id: SceneId): void;
  // Look up a scene. Returns null if the id was never registered or
  // already fully torn down. Note: consumers that hold a ref ACROSS
  // frames must pin() to keep the entry alive.
  lookup(id: SceneId): SceneEntry | null;
  // Pin the entry (refcount++). Throws if the id is unknown OR if the
  // entry is in the "removing" phase (the producer already released
  // and the entry is just waiting for the last pin to drop) -- a new
  // consumer cannot start using a scene whose lifetime is already
  // expiring.
  pin(id: SceneId): void;
  // Unpin (refcount--). If this was the last pin AND unregister was
  // already called, fires onTeardown.
  unpin(id: SceneId): void;
  // Diagnostics for tests.
  pinnedCount(id: SceneId): number | null;
  size(): number;
}

export function createSceneRegistry(): SceneRegistry {
  const slots = new Map<SceneId, Slot>();
  let next: SceneId = 1;

  function maybeFinalize(id: SceneId, slot: Slot): void {
    if (!slot.removing) return;
    if (slot.pinned > 0) return;
    // Defensive: if a release closure is still set, the unpin path
    // somehow didn't fire it. Fire it now before onTeardown so the
    // bracket close orders before the resource free.
    if (slot.release) {
      try { slot.release(); }
      catch (e) { console.error(`[scene-registry] release(${id}) threw:`, e); }
      slot.release = null;
    }
    slots.delete(id);
    try { slot.onTeardown(); }
    catch (e) { console.error(`[scene-registry] onTeardown(${id}) threw:`, e); }
  }

  return {
    register(entry, onTeardown) {
      const id = next++;
      slots.set(id, { entry, pinned: 0, onTeardown, removing: false, release: null });
      return id;
    },
    unregister(id) {
      const slot = slots.get(id);
      if (!slot) return;  // double-unregister tolerated
      if (slot.removing) return;
      slot.removing = true;
      maybeFinalize(id, slot);
    },
    lookup(id) {
      const slot = slots.get(id);
      if (!slot) return null;
      return slot.entry;
    },
    pin(id) {
      const slot = slots.get(id);
      if (!slot) throw new Error(`scene ${id}: unknown id (already torn down?)`);
      if (slot.removing) {
        throw new Error(`scene ${id}: cannot pin -- entry is being torn down`);
      }
      slot.pinned++;
      // First pin: open the producer's sampling bracket if it has one.
      // The release closure is stashed on the slot for the eventual
      // 1 -> 0 transition.
      if (slot.pinned === 1 && slot.entry.acquireForSampling) {
        slot.release = slot.entry.acquireForSampling();
      }
    },
    unpin(id) {
      const slot = slots.get(id);
      if (!slot) return;  // best-effort; pinned-after-teardown is a producer bug
      if (slot.pinned > 0) {
        slot.pinned--;
        // Last pin: close the bracket BEFORE running finalize (which
        // may free the underlying resources). Order matters -- the
        // bracket close fires producer End on the wire, which must
        // come before pluginReleaseSurfaceBuffer destroys the STM.
        if (slot.pinned === 0 && slot.release) {
          try { slot.release(); }
          catch (e) {
            console.error(`[scene-registry] release(${id}) threw:`, e);
          }
          slot.release = null;
        }
      }
      maybeFinalize(id, slot);
    },
    pinnedCount(id) {
      const slot = slots.get(id);
      return slot ? slot.pinned : null;
    },
    size() { return slots.size; },
  };
}
