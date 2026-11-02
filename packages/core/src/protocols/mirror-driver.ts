// Mirror driver: mints and retires mirror windows. A mirror is a
// compositor-owned surface showing a live copy of a client window's draw
// list (decoration, subsurfaces, popups), registered with the WM as a
// synthetic window so the layout places it like any other. It maps with
// role "mirror" and `mirrorOf` on window.map -- sdk.windows.onMap excludes
// it, so workspace plugins never adopt it; the plugin that created it puts
// it in an island. A mirror dies with its source (window.unmap), or on
// destroy().

import type { CompositorState } from "./ctx.js";
import type { Resource } from "../types.js";
import { WINDOW_EVENT } from "../events/types.js";
import { titleAppId } from "../query.js";
import { log } from "../log.js";

export interface MirrorDriverDeps {
  state: CompositorState;
  // Expand a window set into its full draw list (decoration + toplevel +
  // subsurfaces + popups), the same expansion scene compose uses.
  flattenWindows: (surfaceIds: ReadonlyArray<number>) => number[];
}

export interface MirrorDriver {
  // Mint a mirror of `sourceId`. Returns the mirror's surface id, or null
  // when the source is not a mapped client window (or is itself a mirror),
  // or the compositor has no mirror support.
  create(sourceId: number): number | null;
  // Tear a mirror down. Idempotent.
  destroy(mirrorId: number): void;
  sourceOf(mirrorId: number): number | undefined;
  mirrorsOf(sourceId: number): number[];
}

export function createMirrorDriver(deps: MirrorDriverDeps): MirrorDriver {
  const { state } = deps;
  const sourceByMirror = new Map<number, number>();

  // Retire every mirror of a window that unmapped.
  state.bus?.on(WINDOW_EVENT.unmap, (ev) => {
    for (const [mid, sid] of [...sourceByMirror]) {
      if (sid === ev.surfaceId) driver.destroy(mid);
    }
  });

  const driver: MirrorDriver = {
    create(sourceId) {
      const wm = state.wm;
      const comp = state.compositor;
      if (!wm || !comp.createMirror || !comp.destroyMirror) return null;
      const src = wm.getSnapshot(sourceId);
      if (!src || !src.hasContent || src.mirrorOf !== undefined) return null;
      const mirrorId = state.serial();
      const scale = src.outputId !== null
        ? (state.outputs?.get(src.outputId)?.scale ?? 1) : 1;
      const ok = comp.createMirror({
        mirrorId, sourceId, scale,
        getDrawList: () => deps.flattenWindows([sourceId]),
      });
      if (!ok) return null;
      sourceByMirror.set(mirrorId, sourceId);
      // The WM never dereferences a window's resource itself; the seat and
      // stack builders look it up in state.surfaces and find nothing, which
      // is the mirror's contract (no client tree behind it).
      const placeholder: Resource = {
        __resource: null, interfaceName: "overdraw_mirror", version: 0, destroyed: false,
      };
      wm.addWindow(mirrorId, { resource: placeholder }, { mirrorOf: sourceId });
      const ta = titleAppId(state, sourceId);
      const rect = wm.rectOf(mirrorId) ?? { x: 0, y: 0, width: 0, height: 0 };
      state.bus?.emit(WINDOW_EVENT.map, {
        surfaceId: mirrorId,
        outputId: src.outputId ?? wm.primaryOutputId(),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        appId: ta.appId, title: ta.title,
        role: "mirror",
        mirrorOf: sourceId,
      });
      wm.windowHasContent(mirrorId, { width: src.outer.width, height: src.outer.height });
      log.info("core", `mirror: created id=${mirrorId} of surfaceId=${sourceId}`);
      return mirrorId;
    },

    destroy(mirrorId) {
      const sourceId = sourceByMirror.get(mirrorId);
      if (sourceId === undefined) return;
      sourceByMirror.delete(mirrorId);
      state.bus?.emit(WINDOW_EVENT.unmap, { surfaceId: mirrorId });
      state.wm?.unmapWindow(mirrorId);
      state.compositor.destroyMirror?.(mirrorId);
      log.info("core", `mirror: destroyed id=${mirrorId} of surfaceId=${sourceId}`);
    },

    sourceOf(mirrorId) { return sourceByMirror.get(mirrorId); },

    mirrorsOf(sourceId) {
      const out: number[] = [];
      for (const [mid, sid] of sourceByMirror) if (sid === sourceId) out.push(mid);
      return out;
    },
  };
  return driver;
}
