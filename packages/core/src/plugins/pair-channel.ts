// In-memory paired Channels for the in-thread plugin transport. A message
// posted on side A arrives on side B's listener via a microtask hop --
// preserving the postMessage semantics the Endpoint expects (no
// synchronous reentry from postMessage into the same handler).

import type { Channel, Message } from "./protocol.js";

export interface ChannelPair {
  a: Channel;
  b: Channel;
}

export function createChannelPair(): ChannelPair {
  const listenersA: Array<(msg: Message) => void> = [];
  const listenersB: Array<(msg: Message) => void> = [];

  function deliver(listeners: Array<(msg: Message) => void>, msg: Message): void {
    // Snapshot so a listener that subscribes/unsubscribes during dispatch
    // does not affect this delivery.
    const snap = listeners.slice();
    queueMicrotask(() => {
      for (const cb of snap) {
        try { cb(msg); }
        catch (err: unknown) {
          // Surface listener throws to the host event loop instead of
          // breaking the pair; the Endpoint guards its own request-handler
          // exceptions separately.
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
