// In-memory paired Channels. Two endpoints connected back-to-back: a message
// posted on side A arrives on side B's listener (and vice versa), via a
// queueMicrotask hop so the call returns synchronously and the listener fires
// on the next microtask -- preserving the postMessage semantics the Endpoint
// expects (no synchronous reentry from postMessage into the same handler).
//
// Used by the in-thread bundled-plugin transport (inthread-plugin.ts) so the
// same SDK construction code that runs over a worker_threads MessagePort runs
// unchanged over a paired Channel on the main thread. The Endpoint is
// transport-agnostic; this is what makes that promise concrete for the
// in-thread case.

import type { Channel, Message } from "./protocol.js";

export interface ChannelPair {
  a: Channel;
  b: Channel;
}

// Create a connected pair. Either end's postMessage delivers to the other
// end's "message" listener on the next microtask.
//
// Multiple listeners per side are supported (each .on("message", ...) adds
// to the listener set); messages fan out to all of them. In practice the
// Endpoint registers one listener per side, but the underlying contract is
// what worker_threads MessagePort provides (an event-emitter shape).
export function createChannelPair(): ChannelPair {
  const listenersA: Array<(msg: Message) => void> = [];
  const listenersB: Array<(msg: Message) => void> = [];

  function deliver(listeners: Array<(msg: Message) => void>, msg: Message): void {
    // Snapshot the listener list at delivery time so a listener that
    // unsubscribes itself (or adds another) does not affect this delivery.
    const snap = listeners.slice();
    queueMicrotask(() => {
      for (const cb of snap) {
        try { cb(msg); }
        catch (err: unknown) {
          // A listener throwing must not break the pair. Surface to the host
          // event loop so it's not silently swallowed (the Endpoint guards
          // its own request-handler exceptions; this catches anything else).
          queueMicrotask(() => { throw err; });
        }
      }
    });
  }

  const a: Channel = {
    postMessage(msg) { deliver(listenersB, msg); },
    on(_ev, cb) { listenersA.push(cb); },
  };
  const b: Channel = {
    postMessage(msg) { deliver(listenersA, msg); },
    on(_ev, cb) { listenersB.push(cb); },
  };

  return { a, b };
}
