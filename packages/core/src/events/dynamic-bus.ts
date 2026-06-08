// A pattern-subscribable, string-keyed event bus. The primary fan-out
// mechanism for plugin-visible events (window.*, output.*, workspace.*, any
// plugin-defined name). core-plugin-api.md §3.
//
// Why a separate bus from TypedBus: TypedBus is generic over a build-time event
// map; plugin-emitted event names are not known at core build time
// (workspace.shown, notification.posted, anything plugins introduce). This bus
// keys subscribers by string name and supports glob patterns, so the same
// instance hosts both core-emitted events (window.map, etc.) and plugin-emitted
// events (workspace.shown, etc.).
//
// Pattern grammar (deliberately small):
//   - exact:       'window.map'         matches that name only
//   - prefix-glob: 'workspace.*'        matches any name starting with 'workspace.'
//   - catch-all:   '*'                  matches any name
// No deeper globbing (no 'a.b.*', no '*.shown', no character classes). Add only
// when a real use case demands it.

export type DynamicListener = (name: string, payload: unknown) => void;
export type ErrorReporter = (msg: string, err: unknown) => void;

// A subscription handle; `off()` removes the subscription.
export interface Subscription {
  off(): void;
}

interface PatternEntry {
  pattern: string;        // original pattern string (for diagnostics)
  prefix: string | null;  // for prefix-glob 'workspace.*' -> 'workspace.'; null for exact/'*'
  exact: string | null;   // for exact-match patterns
  catchAll: boolean;      // true iff pattern === '*'
  cb: DynamicListener;
}

export class DynamicBus {
  // Exact-name subscribers: hot path for the common case (most subscribers
  // listen to a specific event, not a pattern).
  private exactSubs = new Map<string, Set<DynamicListener>>();
  // Pattern subscribers: prefix-glob and catch-all. Iterated for every emit.
  // Kept as an array so registration order is preserved on fan-out.
  private patternSubs: PatternEntry[] = [];
  private warn: ErrorReporter;

  constructor(onError?: ErrorReporter) {
    this.warn = onError ?? ((msg, err) => { console.warn(msg, err); });
  }

  // Subscribe to an event by exact name or pattern. Returns a Subscription
  // whose `off()` removes this subscription. Idempotent for the same callback
  // and pattern (Set semantics for exact; pattern entries de-dup on cb+pattern).
  subscribe(pattern: string, cb: DynamicListener): Subscription {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new TypeError(`subscribe pattern must be a non-empty string`);
    }
    if (typeof cb !== "function") {
      throw new TypeError(`subscribe cb must be a function`);
    }

    // Catch-all '*'
    if (pattern === "*") {
      const entry: PatternEntry = { pattern, prefix: null, exact: null, catchAll: true, cb };
      this.patternSubs.push(entry);
      return { off: () => { this.removePatternEntry(entry); } };
    }

    // Prefix-glob 'prefix.*' (terminal '*' only)
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1);  // 'workspace.' (keep the dot)
      const entry: PatternEntry = { pattern, prefix, exact: null, catchAll: false, cb };
      this.patternSubs.push(entry);
      return { off: () => { this.removePatternEntry(entry); } };
    }

    // Reject other forms (e.g. 'workspace.*.shown', '*.shown'); cleaner to
    // throw early than to silently no-match.
    if (pattern.includes("*")) {
      throw new TypeError(`unsupported pattern '${pattern}' ` +
        `(only exact, 'prefix.*', or '*' are supported)`);
    }

    // Exact match.
    const set = this.exactSubs.get(pattern) ?? new Set<DynamicListener>();
    set.add(cb);
    this.exactSubs.set(pattern, set);
    return { off: () => { set.delete(cb); if (set.size === 0) this.exactSubs.delete(pattern); } };
  }

  // Emit an event by name. Fan-out to all matching subscribers, synchronously,
  // in this order: exact-name subscribers (registration order), then pattern
  // subscribers (registration order). A listener that throws is caught + logged
  // so it cannot break the emitter or other listeners. Iterates a snapshot so
  // a listener may subscribe/unsubscribe during dispatch without disturbing
  // this fan-out.
  emit(name: string, payload: unknown): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`emit name must be a non-empty string`);
    }
    // Disallow names containing '*' (would be confusing alongside patterns).
    if (name.includes("*")) {
      throw new TypeError(`emit name must not contain '*' (got '${name}')`);
    }

    // Exact-name subscribers.
    const exact = this.exactSubs.get(name);
    if (exact && exact.size > 0) {
      for (const cb of [...exact]) {
        try { cb(name, payload); }
        catch (err) { this.warn(`[bus] listener for '${name}' threw`, err); }
      }
    }

    // Pattern subscribers: iterate the snapshot, check each.
    if (this.patternSubs.length === 0) return;
    for (const entry of [...this.patternSubs]) {
      if (!this.matches(entry, name)) continue;
      try { entry.cb(name, payload); }
      catch (err) {
        this.warn(`[bus] pattern '${entry.pattern}' listener for '${name}' threw`, err);
      }
    }
  }

  // Diagnostics: how many subscribers currently match `name`? Used by tests and
  // by the IPC layer to decide whether to skip producing an event.
  subscriberCount(name: string): number {
    let n = (this.exactSubs.get(name)?.size ?? 0);
    for (const entry of this.patternSubs) {
      if (this.matches(entry, name)) n++;
    }
    return n;
  }

  // Remove every subscription (test teardown / shutdown).
  clear(): void {
    this.exactSubs.clear();
    this.patternSubs.length = 0;
  }

  private matches(entry: PatternEntry, name: string): boolean {
    if (entry.catchAll) return true;
    if (entry.prefix !== null) return name.startsWith(entry.prefix);
    if (entry.exact !== null) return name === entry.exact;
    return false;
  }

  private removePatternEntry(target: PatternEntry): void {
    const i = this.patternSubs.indexOf(target);
    if (i >= 0) this.patternSubs.splice(i, 1);
  }
}
