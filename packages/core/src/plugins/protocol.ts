// Worker <-> core message protocol (architecture.md "Worker <-> core message
// protocol"). One envelope shape both directions; either side may originate any
// kind:
//
//   { kind: 'request',  id, method, params }
//   { kind: 'response', id, result }   |  { kind: 'response', id, error }
//   { kind: 'event',    name, data }
//
// Plus two control messages for the watchdog (architecture.md "Isolation":
// core pings, plugin pongs). They are deliberately OUTSIDE the request/response
// table so liveness probing never interacts with in-flight plugin requests:
//
//   { kind: 'ping', seq }   (core -> worker)
//   { kind: 'pong', seq }   (worker -> core)
//
// This module is transport-agnostic: it talks to a Channel (the MessagePort-ish
// shape worker_threads gives both ends), so it is unit-testable with a plain
// in-memory channel and reused verbatim by the in-Worker bootstrap.

// Structured-cloneable payload (the transport is postMessage, not JSON, so bigint
// is allowed -- used for 64-bit wire handles/serials). Named Json for brevity.
export type Json =
  | null | boolean | number | string | bigint
  | Json[] | { [k: string]: Json };

export interface RequestMessage { kind: "request"; id: number; method: string; params: Json; }
export interface ResponseOk { kind: "response"; id: number; result: Json; }
export interface ResponseErr { kind: "response"; id: number; error: { message: string; stack?: string }; }
export interface EventMessage { kind: "event"; name: string; data: Json; }
export interface PingMessage { kind: "ping"; seq: number; }
export interface PongMessage { kind: "pong"; seq: number; }

export type Message =
  | RequestMessage | ResponseOk | ResponseErr | EventMessage | PingMessage | PongMessage;

// The minimal port shape the Endpoint talks to. worker_threads `Worker` and
// `MessagePort` do not match this exactly (their postMessage is `(value: any)`
// and their `on` is heavily overloaded), so adapt them with `channelFor` rather
// than casting. A plain in-memory channel (tests) implements this directly.
export interface Channel {
  postMessage(msg: Message): void;
  on(event: "message", cb: (msg: Message) => void): void;
}

// The structural subset of worker_threads Worker / MessagePort we use. Both
// satisfy this without a cast (postMessage accepts any value; on() accepts a
// message listener). `channelFor` narrows it to a typed Channel.
export interface MessagePortLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): unknown;
}

// Adapt a Worker / MessagePort to a typed Channel without any cast: the inbound
// listener receives `unknown` and is narrowed to Message at the Endpoint's
// dispatch (which already switches on a known `kind`).
export function channelFor(port: MessagePortLike): Channel {
  return {
    postMessage(msg: Message): void { port.postMessage(msg); },
    on(_event: "message", cb: (msg: Message) => void): void {
      port.on("message", (value: unknown) => { cb(value as Message); });
    },
  };
}

// A handler invoked for an incoming request; its resolved value becomes the
// response result, a throw/reject becomes the response error.
export type RequestHandler = (method: string, params: Json) => Json | Promise<Json>;
// An event handler (one-way; no reply).
export type EventHandler = (name: string, data: Json) => void;
// Watchdog ping observer (core side installs this to record liveness).
export type PongHandler = (seq: number) => void;
type PingHandler = (seq: number) => void;

interface Pending { resolve: (v: Json) => void; reject: (e: Error) => void; }

// One end of the protocol. Both the core-side (per plugin) and the in-Worker end
// construct an Endpoint over their channel.
export class Endpoint {
  private ch: Channel;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private onRequest: RequestHandler | null = null;
  private onEvent: EventHandler | null = null;
  private onPong: PongHandler | null = null;
  private onPing: PingHandler | null = null;
  private closed = false;

  constructor(channel: Channel) {
    this.ch = channel;
    this.ch.on("message", (msg) => { this.dispatch(msg); });
  }

  // Register the handler for inbound requests (resolved value -> response).
  handleRequests(h: RequestHandler): void { this.onRequest = h; }
  // Register the handler for inbound one-way events.
  handleEvents(h: EventHandler): void { this.onEvent = h; }
  // Core side: observe pongs (watchdog). Worker side: auto-replies to pings
  // unless an explicit ping handler is set.
  handlePongs(h: PongHandler): void { this.onPong = h; }
  handlePings(h: PingHandler): void { this.onPing = h; }

  // Originate a request; resolves with the peer's result or rejects with its
  // error. Rejects immediately if the endpoint is closed.
  request(method: string, params: Json = null): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("endpoint closed"));
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ch.postMessage({ kind: "request", id, method, params });
    });
  }

  // Originate a one-way event.
  emit(name: string, data: Json = null): void {
    if (this.closed) return;
    this.ch.postMessage({ kind: "event", name, data });
  }

  // Core side: send a watchdog ping.
  ping(seq: number): void {
    if (this.closed) return;
    this.ch.postMessage({ kind: "ping", seq });
  }
  // Worker side: reply to a ping.
  pong(seq: number): void {
    if (this.closed) return;
    this.ch.postMessage({ kind: "pong", seq });
  }

  // Reject all in-flight requests and stop accepting new traffic. Called when the
  // peer dies (the core rejects pending plugin requests so callers don't hang).
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(reason);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private dispatch(msg: Message): void {
    switch (msg.kind) {
      case "request": this.onIncomingRequest(msg); return;
      case "response": this.onIncomingResponse(msg); return;
      case "event": this.onEvent?.(msg.name, msg.data); return;
      case "ping":
        if (this.onPing) this.onPing(msg.seq);
        else this.pong(msg.seq);   // default: auto-reply (worker liveness)
        return;
      case "pong": this.onPong?.(msg.seq); return;
    }
  }

  private onIncomingRequest(msg: RequestMessage): void {
    const h = this.onRequest;
    if (!h) {
      this.ch.postMessage({ kind: "response", id: msg.id,
        error: { message: `no request handler for method '${msg.method}'` } });
      return;
    }
    Promise.resolve()
      .then(() => h(msg.method, msg.params))
      .then(
        (result) => { this.ch.postMessage({ kind: "response", id: msg.id, result }); },
        (e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e));
          this.ch.postMessage({ kind: "response", id: msg.id,
            error: { message: err.message, stack: err.stack } });
        },
      );
  }

  private onIncomingResponse(msg: ResponseOk | ResponseErr): void {
    const p = this.pending.get(msg.id);
    if (!p) return;   // unknown id (late reply after close); ignore
    this.pending.delete(msg.id);
    if ("error" in msg) {
      const err = new Error(msg.error.message);
      if (msg.error.stack) err.stack = msg.error.stack;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }
}
