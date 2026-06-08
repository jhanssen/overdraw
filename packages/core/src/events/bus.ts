// A small typed event bus. Generic over an event map ({ name: payload }); on()
// and emit() are fully type-checked against it (no `any`, no string-keyed casts).
//
// Why not node:events EventEmitter: it is untyped (listeners take `...args: any[]`)
// and treats a thrown listener on 'error' as a process-fatal. This bus is typed and
// isolates listener throws (one bad subscriber must not break the per-frame sweep
// or the other subscribers).
//
// emit() is synchronous and fan-out in registration order. on() returns an
// unsubscribe function (cleaner than removeListener + holding the reference).

export type Listener<T> = (ev: T) => void;

// Bus instances are parameterized by an event map ({ name: payload }). No
// `extends Record<string, unknown>` constraint: an `interface` map (which lacks an
// implicit index signature) would not satisfy it, and the generic only needs
// `keyof M` indexing, which works for any object type.
export class TypedBus<M> {
  private listeners: { [K in keyof M]?: Set<Listener<M[K]>> } = {};
  private warn: (msg: string, err: unknown) => void;

  // `onError` lets the host route listener exceptions (default: console.warn).
  constructor(onError?: (msg: string, err: unknown) => void) {
    this.warn = onError ?? ((msg, err) => { console.warn(msg, err); });
  }

  // Subscribe to an event. Returns an unsubscribe function. Subscribing the same
  // function twice for the same event is idempotent (Set semantics).
  on<K extends keyof M>(name: K, cb: Listener<M[K]>): () => void {
    const set = (this.listeners[name] ??= new Set<Listener<M[K]>>());
    set.add(cb);
    return () => { this.listeners[name]?.delete(cb); };
  }

  // Emit an event to all current subscribers, synchronously, in registration
  // order. A listener that throws is caught + logged so it cannot break the
  // emitter or other listeners. Iterates a snapshot so a listener may
  // subscribe/unsubscribe during dispatch without disturbing this fan-out.
  emit<K extends keyof M>(name: K, ev: M[K]): void {
    const set = this.listeners[name];
    if (!set || set.size === 0) return;
    for (const cb of [...set]) {
      try { cb(ev); }
      catch (err) { this.warn(`[bus] listener for '${String(name)}' threw`, err); }
    }
  }

  // Remove all listeners for one event, or (no arg) for every event. Used at
  // teardown so stale subscribers do not fire after the producer is gone.
  clear<K extends keyof M>(name?: K): void {
    if (name === undefined) this.listeners = {};
    else this.listeners[name]?.clear();
  }
}
