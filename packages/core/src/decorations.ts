// Decoration-provider registry (core, GPU-free). Piece 1 of the decoration
// milestone (architecture.md "First decoration milestone"): a plugin registers an
// app_id pattern; when a mapped window's app_id matches, the first-registered
// matching provider is ASSIGNED that window and notified. No insets, no surface,
// no drawing yet -- that is pieces 2/3. This is pure bookkeeping + one event.
//
// Matching happens at window.map AND on window.change (the app_id may arrive after
// first content -- see the window-state stream). Match-once: once a window is
// assigned, it stays with that provider for its lifetime (reassignment on later
// app_id change is deferred -- flagged).

import type { CompositorBus } from "./events/window-bus.js";
import {
  WINDOW_EVENT,
} from "./events/types.js";
import type {
  WindowMapEvent, WindowChangeEvent, WindowUnmapEvent,
  DecorationAssignedEvent, WindowRect,
} from "./events/types.js";

// One registered provider: the plugin and its compiled app_id matcher.
interface Provider {
  pluginName: string;
  // Source pattern (for diagnostics) + the compiled RegExp used to test app_id.
  source: string;
  regex: RegExp;
}

export interface DecorationRegistry {
  // Register `pluginName` as a decoration provider for app_ids matching `pattern`
  // (a RegExp source string + optional flags). Throws on an invalid pattern.
  // Registration order is significant: first match wins.
  register(pluginName: string, pattern: string, flags?: string): void;
  // Drop all providers for a plugin (plugin teardown, or a timed-out provider).
  unregisterPlugin(pluginName: string): void;
  // Push the WM's post-relayout outer rect for a window. The registry holds
  // tentative matches whose map-time rect was the placeholder (-1,-1) and
  // fires onAssigned only when the first valid outer rect arrives. The
  // broker calls this on window.relayout (plugin-bus event).
  notifyRelayout(surfaceId: number, newOuter: WindowRect): void;
  // Introspection (tests).
  assignmentOf(surfaceId: number): string | undefined;
}

// Fired when a window is assigned to a provider (match-once). The broker reacts:
// notify the plugin, gate the window's content, arm the first-frame timeout.
export type OnAssigned = (ev: DecorationAssignedEvent, pluginName: string) => void;
// Fired when a tracked window unmaps. The broker releases its gate + state.
export type OnUnmapped = (surfaceId: number) => void;

export function createDecorationRegistry(
  bus: CompositorBus, onAssigned: OnAssigned, onUnmapped: OnUnmapped,
): DecorationRegistry {
  const providers: Provider[] = [];
  // surfaceId -> pluginName it is assigned to (match-once).
  const assignments = new Map<number, string>();
  // surfaceId -> its rect, recorded at map. window.change does not carry a rect, so
  // a late-app_id-change assignment reuses the last-known geometry from here.
  const lastRect = new Map<number, WindowRect>();

  // Pending tentative assignments: window matched a provider but the WM's
  // outer rect is still the placeholder (-1,-1). We hold these here and
  // fire onAssigned only when window.relayout lands a real outer rect.
  // The decoration broker's first-frame timer doesn't start until
  // onAssigned fires, so this defers the 500ms gate to "real-rect time"
  // instead of "window.map time", eliminating the placeholder allocation
  // + teardown race in the decoration plugin.
  interface Pending { appId: string; title: string | null; pluginName: string; }
  const pending = new Map<number, Pending>();

  function isValidRect(r: WindowRect): boolean {
    return r.width > 0 && r.height > 0;
  }

  // Try to assign a window to the first registered provider whose regex matches its
  // app_id. No-op if already assigned (match-once) or app_id is null/unmatched.
  // If the rect is the placeholder, the assignment is parked until
  // window.relayout fires with a real outer rect.
  function tryAssign(surfaceId: number, appId: string | null, title: string | null,
                     rect: WindowRect): void {
    if (assignments.has(surfaceId)) return;   // match-once
    if (pending.has(surfaceId)) return;       // already waiting on a real rect
    if (appId === null) return;                // no app_id yet -> wait for window.change
    for (const p of providers) {
      if (p.regex.test(appId)) {
        if (isValidRect(rect)) {
          assignments.set(surfaceId, p.pluginName);
          onAssigned({ surfaceId, appId, title, rect }, p.pluginName);
        } else {
          pending.set(surfaceId, { appId, title, pluginName: p.pluginName });
        }
        return;   // first match wins
      }
    }
  }

  bus.on(WINDOW_EVENT.map, (ev: WindowMapEvent) => {
    lastRect.set(ev.surfaceId, ev.rect);
    tryAssign(ev.surfaceId, ev.appId, ev.title, ev.rect);
  });

  bus.on(WINDOW_EVENT.change, (ev: WindowChangeEvent) => {
    // Re-evaluate only when app_id (re)appears in the change set; the late-app_id
    // case (set_app_id after first content) is exactly what makes match-on-change
    // necessary. window.change has no rect -> reuse the map-time rect.
    if (!ev.changed.includes("appId")) return;
    const rect = lastRect.get(ev.surfaceId);
    if (!rect) return;   // not mapped yet / unknown geometry
    tryAssign(ev.surfaceId, ev.appId, ev.title, rect);
  });

  bus.on(WINDOW_EVENT.unmap, (ev: WindowUnmapEvent) => {
    lastRect.delete(ev.surfaceId);
    assignments.delete(ev.surfaceId);
    pending.delete(ev.surfaceId);
    onUnmapped(ev.surfaceId);
  });

  return {
    register(pluginName, pattern, flags) {
      // Compile here so an invalid pattern fails the register request (the plugin
      // sees the rejection) rather than silently never matching.
      const regex = new RegExp(pattern, flags);
      providers.push({ pluginName, source: pattern, regex });
    },
    unregisterPlugin(pluginName) {
      for (let i = providers.length - 1; i >= 0; i--) {
        if (providers[i].pluginName === pluginName) providers.splice(i, 1);
      }
      // Leave existing assignments; a torn-down/timed-out plugin's windows simply
      // lose their (already-delivered) provider.
    },
    notifyRelayout(surfaceId, newOuter) {
      // First valid outer rect for a deferred match -> deliver onAssigned now.
      lastRect.set(surfaceId, newOuter);
      const p = pending.get(surfaceId);
      if (!p) return;
      if (!isValidRect(newOuter)) return;
      pending.delete(surfaceId);
      assignments.set(surfaceId, p.pluginName);
      onAssigned({ surfaceId, appId: p.appId, title: p.title,
                   rect: newOuter }, p.pluginName);
    },
    assignmentOf(surfaceId) { return assignments.get(surfaceId); },
  };
}
