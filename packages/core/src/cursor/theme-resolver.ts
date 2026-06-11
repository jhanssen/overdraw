// XCursor theme resolver. Thin wrapper over the native addon's
// resolveCursorShape() with an LRU cache so repeated lookups of the same
// (name, sizePx, scale) tuple don't re-walk the filesystem each time.

import type { Addon } from "../types.js";

export interface ResolvedShape {
  readonly width: number;
  readonly height: number;
  readonly hotspotX: number;
  readonly hotspotY: number;
  // BGRA8, tightly packed (width*height*4 bytes). Premultiplied alpha
  // (XCursor authoring tools save premultiplied; the compositor's blend
  // path expects premultiplied).
  readonly rgba: Uint8Array;
}

export interface CursorThemeResolver {
  resolveShape(name: string, sizePx: number, scale: number): ResolvedShape | null;
  reload(): void;
}

const DEFAULT_CACHE_LIMIT = 64;

export function createCursorThemeResolver(
  addon: Pick<Addon, "resolveCursorShape">,
  opts?: { cacheLimit?: number },
): CursorThemeResolver {
  const limit = Math.max(1, opts?.cacheLimit ?? DEFAULT_CACHE_LIMIT);
  // Map preserves insertion order; treating it as an LRU by delete+set on hit.
  const cache = new Map<string, ResolvedShape | null>();

  const key = (n: string, s: number, sc: number) => `${n}|${s}|${sc}`;

  return {
    resolveShape(name, sizePx, scale) {
      const k = key(name, sizePx, scale);
      const cached = cache.get(k);
      if (cached !== undefined) {
        // Touch (LRU): move to end.
        cache.delete(k);
        cache.set(k, cached);
        return cached;
      }
      const res = addon.resolveCursorShape(name, sizePx, scale);
      cache.set(k, res);
      while (cache.size > limit) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return res;
    },
    reload() {
      cache.clear();
    },
  };
}
