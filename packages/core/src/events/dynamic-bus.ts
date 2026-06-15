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
//
// Two subscription shapes, both keyed off the same pattern grammar:
//
//   - subscribe(): passive observation. Sees the final post-modification
//     payload after the interceptor chain settles. Never blocks the emitter.
//
//   - intercept(): active participation. May modify the payload (return a new
//     one) or defer the emitter's downstream action (return a Promise that
//     does work). Multiple interceptors run in priority order (lower first;
//     ties by registration order). See core-plugin-api.md §3.1.
//
// emit() returns Promise<unknown> that resolves to the final payload. When no
// interceptors match, observers fan out synchronously (same cost as today) and
// the returned Promise is already-resolved. Callers that don't await get
// fire-and-forget; callers that await get the post-modification payload.
//
// emitSync() runs observers only. Required for emit sites that cannot suspend
// (C++ frame timer, synchronous input handlers). Interceptors registered on a
// sync-only name are warned about so plugin authors know their return values
// will be discarded. markSyncOnly() declares a name as sync-only up front so
// the warning fires at intercept-register time.

import { log } from "../log.js";

export type DynamicListener = (name: string, payload: unknown) => void;
export type ErrorReporter = (msg: string, err: unknown) => void;

// Interceptor return contract:
//   undefined / void  -> observe-only for this interceptor; chain continues
//                        with the prior payload.
//   any other value   -> the new payload; subsequent interceptors and the
//                        observers see this value.
//   Promise<T>        -> emitter awaits before proceeding. Resolves to either
//                        of the above.
export type DynamicInterceptor =
  (name: string, payload: unknown) => unknown | Promise<unknown> | void;

export interface Subscription {
  off(): void;
}

export interface EmitOptions {
  // Per-handler timeout (ms). A handler that doesn't settle within this is
  // abandoned; the chain proceeds with the prior payload. Subsequent handlers
  // each get a fresh budget. No default; the emitter chooses per event.
  timeoutMs?: number;
}

export interface InterceptOptions {
  // Lower runs first. Ties broken by registration order. Default 0.
  priority?: number;
}

interface PatternEntry {
  pattern: string;
  prefix: string | null;  // 'workspace.*' -> 'workspace.'
  exact: string | null;
  catchAll: boolean;
  cb: DynamicListener;
}

interface InterceptEntry {
  pattern: string;
  prefix: string | null;
  exact: string | null;
  catchAll: boolean;
  priority: number;
  // Monotonic registration index; secondary sort key so equal-priority
  // interceptors run in registration order.
  seq: number;
  cb: DynamicInterceptor;
}

export class DynamicBus {
  // Exact-name subscribers: hot path for the common case (most subscribers
  // listen to a specific event, not a pattern).
  private exactSubs = new Map<string, Set<DynamicListener>>();
  // Pattern subscribers: prefix-glob and catch-all. Iterated for every emit.
  // Kept as an array so registration order is preserved on fan-out.
  private patternSubs: PatternEntry[] = [];

  // Interceptors. Stored unsorted; sorted on demand at emit time (the typical
  // shape is a small handful of interceptors per pattern, so a per-emit sort
  // is cheaper than maintaining an ordered structure on every register).
  private interceptors: InterceptEntry[] = [];
  private interceptSeq = 0;

  // Names declared sync-only by the host (frame.tick, etc.). Used to warn
  // plugin authors that their intercept handlers' return values are ignored
  // for these names.
  private syncOnlyNames = new Set<string>();
  // One warning per (pattern, syncOnlyName) pair to avoid log floods when a
  // plugin re-registers the same intercept across reloads.
  private syncWarned = new Set<string>();

  private warn: ErrorReporter;

  constructor(onError?: ErrorReporter) {
    this.warn = onError ?? ((msg, err) => { log.warn("core", "%s %o", msg, err); });
  }

  // Subscribe to an event by exact name or pattern. Returns a Subscription
  // whose off() removes this subscription. Idempotent for the same callback
  // and pattern (Set semantics for exact; pattern entries de-dup on cb+pattern).
  subscribe(pattern: string, cb: DynamicListener): Subscription {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new TypeError(`subscribe pattern must be a non-empty string`);
    }
    if (typeof cb !== "function") {
      throw new TypeError(`subscribe cb must be a function`);
    }

    if (pattern === "*") {
      const entry: PatternEntry = { pattern, prefix: null, exact: null, catchAll: true, cb };
      this.patternSubs.push(entry);
      return { off: () => { this.removePatternEntry(entry); } };
    }

    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1);
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

    const set = this.exactSubs.get(pattern) ?? new Set<DynamicListener>();
    set.add(cb);
    this.exactSubs.set(pattern, set);
    return { off: () => { set.delete(cb); if (set.size === 0) this.exactSubs.delete(pattern); } };
  }

  // Register an interceptor matching the same pattern grammar as subscribe().
  // Lower priority runs first; ties broken by registration order. The handler
  // returns the new payload, a Promise of it, or undefined/void for
  // observe-only. A throwing handler is logged and skipped (chain continues
  // with the prior payload).
  intercept(pattern: string, cb: DynamicInterceptor, opts?: InterceptOptions): Subscription {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new TypeError(`intercept pattern must be a non-empty string`);
    }
    if (typeof cb !== "function") {
      throw new TypeError(`intercept cb must be a function`);
    }
    const priority = opts?.priority ?? 0;
    if (!Number.isFinite(priority)) {
      throw new TypeError(`intercept priority must be a finite number`);
    }

    const entry = this.buildInterceptEntry(pattern, priority, cb);
    this.interceptors.push(entry);

    // Warn if this pattern matches any name declared sync-only: the
    // handler's return value will be ignored when emitSync delivers that
    // name. Fire once per (pattern, name) pair.
    for (const n of this.syncOnlyNames) {
      if (!this.interceptMatches(entry, n)) continue;
      const key = `${pattern}\0${n}`;
      if (this.syncWarned.has(key)) continue;
      this.syncWarned.add(key);
      this.warn(
        `[bus] intercept('${pattern}') matches sync-only event '${n}'; ` +
        `the handler will run for side effects but its return value will be ignored`,
        undefined,
      );
    }

    return { off: () => { this.removeInterceptEntry(entry); } };
  }

  // Declare a name as sync-only. emitSync() is the only legal dispatch for
  // these. Causes intercept() to warn immediately when a registered pattern
  // would match.
  markSyncOnly(name: string): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`markSyncOnly name must be a non-empty string`);
    }
    if (name.includes("*")) {
      throw new TypeError(`markSyncOnly name must not contain '*' (got '${name}')`);
    }
    this.syncOnlyNames.add(name);
  }

  // Emit an event. Returns a Promise resolving to the final payload (the
  // input payload when no interceptors match; otherwise the chain's output).
  //
  // Hot path: when no interceptor matches, observers fan out synchronously
  // (same cost as before interception existed) and the returned Promise is
  // already-resolved. Callers that don't await get fire-and-forget.
  //
  // Slow path: when at least one interceptor matches, the chain runs in
  // priority order. Each handler sees the prior payload, may return a new
  // one (or a Promise of one), or undefined to observe-only. After the
  // chain settles, observers receive the FINAL payload. The optional
  // timeoutMs bounds total chain time; handlers exceeding the remaining
  // budget are abandoned (chain continues with the prior payload).
  emit(name: string, payload: unknown, opts?: EmitOptions): Promise<unknown> {
    this.validateEmitName(name);

    const chain = this.matchingInterceptors(name);
    if (chain.length === 0) {
      this.fanOut(name, payload);
      return Promise.resolve(payload);
    }
    return this.runChain(name, payload, chain, opts?.timeoutMs);
  }

  // Synchronous emit. Observers fan out as today. Interceptors registered
  // on the matching name still run for side effects, but their return values
  // (including any Promise) are discarded -- the synchronous emit cannot
  // await. A name not declared via markSyncOnly() that has matching
  // interceptors triggers a one-time warning (the host either forgot to
  // declare it or used the wrong emit variant).
  emitSync(name: string, payload: unknown): void {
    this.validateEmitName(name);
    const chain = this.matchingInterceptors(name);
    if (chain.length > 0) {
      if (!this.syncOnlyNames.has(name)) {
        const key = `__emit_sync_unmarked\0${name}`;
        if (!this.syncWarned.has(key)) {
          this.syncWarned.add(key);
          this.warn(
            `[bus] emitSync('${name}') has interceptors registered but the name ` +
            `was not declared via markSyncOnly(); interceptor return values are ignored`,
            undefined,
          );
        }
      }
      for (const e of chain) {
        try {
          const r = e.cb(name, payload);
          // If the handler returned a Promise, swallow its rejection so a
          // rejected Promise from a sync-only handler doesn't surface as an
          // unhandled rejection. We deliberately discard the resolved value.
          if (r && typeof (r as Promise<unknown>).then === "function") {
            (r as Promise<unknown>).then(() => {}, (err: unknown) => {
              this.warn(`[bus] sync-only interceptor for '${name}' rejected`, err);
            });
          }
        } catch (err) {
          this.warn(`[bus] sync-only interceptor for '${name}' threw`, err);
        }
      }
    }
    this.fanOut(name, payload);
  }

  // Diagnostics: how many subscribers currently match `name`. Used by the IPC
  // layer to decide whether to skip producing an event.
  subscriberCount(name: string): number {
    let n = (this.exactSubs.get(name)?.size ?? 0);
    for (const entry of this.patternSubs) {
      if (this.matches(entry, name)) n++;
    }
    return n;
  }

  clear(): void {
    this.exactSubs.clear();
    this.patternSubs.length = 0;
    this.interceptors.length = 0;
    this.syncWarned.clear();
  }

  // ---- internals -----------------------------------------------------------

  private validateEmitName(name: string): void {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`emit name must be a non-empty string`);
    }
    if (name.includes("*")) {
      throw new TypeError(`emit name must not contain '*' (got '${name}')`);
    }
  }

  // Run the interceptor chain, then fan out to observers with the final
  // payload. timeoutMs is a per-handler budget: a slow or throwing handler
  // is skipped (chain continues with the prior payload); subsequent handlers
  // each get a fresh budget. A handler returning undefined is observe-only.
  private async runChain(
    name: string,
    initial: unknown,
    chain: InterceptEntry[],
    timeoutMs: number | undefined,
  ): Promise<unknown> {
    let payload = initial;
    for (const e of chain) {
      try {
        const result = await this.runOne(name, payload, e, timeoutMs ?? null);
        if (result !== undefined) payload = result;
      } catch (err) {
        this.warn(`[bus] intercept handler for '${name}' (pattern '${e.pattern}') failed`, err);
      }
    }
    this.fanOut(name, payload);
    return payload;
  }

  // Run one interceptor with an optional per-handler timeout. Returns the
  // handler's resolved value (which may be undefined for observe-only).
  // A timeout rejects with a marker error; the caller logs and continues.
  private runOne(
    name: string,
    payload: unknown,
    e: InterceptEntry,
    timeoutMs: number | null,
  ): Promise<unknown> {
    let result: unknown;
    try {
      result = e.cb(name, payload);
    } catch (err) {
      return Promise.reject(err);
    }
    if (!result || typeof (result as Promise<unknown>).then !== "function") {
      return Promise.resolve(result);
    }
    const promise = result as Promise<unknown>;
    if (timeoutMs === null) return promise;
    return new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`intercept handler for '${name}' (pattern '${e.pattern}') timed out`));
      }, timeoutMs);
      t.unref?.();
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (err) => { clearTimeout(t); reject(err); },
      );
    });
  }

  // Snapshot the interceptor list filtered to entries matching `name`, sorted
  // by (priority asc, seq asc). The snapshot is detached so handlers may
  // register or unregister mid-chain without disturbing this dispatch.
  private matchingInterceptors(name: string): InterceptEntry[] {
    const out: InterceptEntry[] = [];
    for (const e of this.interceptors) {
      if (this.interceptMatches(e, name)) out.push(e);
    }
    if (out.length > 1) {
      out.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));
    }
    return out;
  }

  // Observer fan-out. Exact subscribers first (registration order), then
  // pattern subscribers (registration order). A listener throwing is caught
  // and logged so one bad subscriber cannot stop the emitter or peers.
  // Iterates snapshots so a listener may subscribe/unsubscribe during
  // dispatch without disturbing this fan-out.
  private fanOut(name: string, payload: unknown): void {
    const exact = this.exactSubs.get(name);
    if (exact && exact.size > 0) {
      for (const cb of [...exact]) {
        try { cb(name, payload); }
        catch (err) { this.warn(`[bus] listener for '${name}' threw`, err); }
      }
    }
    if (this.patternSubs.length === 0) return;
    for (const entry of [...this.patternSubs]) {
      if (!this.matches(entry, name)) continue;
      try { entry.cb(name, payload); }
      catch (err) {
        this.warn(`[bus] pattern '${entry.pattern}' listener for '${name}' threw`, err);
      }
    }
  }

  private buildInterceptEntry(pattern: string, priority: number, cb: DynamicInterceptor): InterceptEntry {
    if (pattern === "*") {
      return { pattern, prefix: null, exact: null, catchAll: true, priority, seq: ++this.interceptSeq, cb };
    }
    if (pattern.endsWith(".*")) {
      return { pattern, prefix: pattern.slice(0, -1), exact: null, catchAll: false, priority, seq: ++this.interceptSeq, cb };
    }
    if (pattern.includes("*")) {
      throw new TypeError(`unsupported pattern '${pattern}' ` +
        `(only exact, 'prefix.*', or '*' are supported)`);
    }
    return { pattern, prefix: null, exact: pattern, catchAll: false, priority, seq: ++this.interceptSeq, cb };
  }

  private matches(entry: PatternEntry, name: string): boolean {
    if (entry.catchAll) return true;
    if (entry.prefix !== null) return name.startsWith(entry.prefix);
    if (entry.exact !== null) return name === entry.exact;
    return false;
  }

  private interceptMatches(entry: InterceptEntry, name: string): boolean {
    if (entry.catchAll) return true;
    if (entry.prefix !== null) return name.startsWith(entry.prefix);
    if (entry.exact !== null) return name === entry.exact;
    return false;
  }

  private removePatternEntry(target: PatternEntry): void {
    const i = this.patternSubs.indexOf(target);
    if (i >= 0) this.patternSubs.splice(i, 1);
  }

  private removeInterceptEntry(target: InterceptEntry): void {
    const i = this.interceptors.indexOf(target);
    if (i >= 0) this.interceptors.splice(i, 1);
  }
}
