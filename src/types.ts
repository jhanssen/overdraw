// Shared types for the handwritten JS/TS layer.
//
// These are pragmatic, hand-maintained types for the native addon surface and
// the trampoline resource wrapper. They are intentionally not exhaustive — the
// addon is a raw N-API module and the resource wrappers are dynamic — but they
// capture enough shape to type the protocol/WM layer usefully. The generated
// protocol modules are typed by their own emitted .d.ts (signature/makeEvents),
// resolved via the #protocols-gen/* subpath import.

// The trampoline resource wrapper. Single source of truth is the generated
// wayland-types module (the protocol contracts use the same Resource/ResourceOf),
// re-exported here so the handwritten layer has one import site.
import type { Resource, WaylandFd } from "#protocols-gen/wayland-types.js";
export type { Resource, ResourceOf, WaylandFd } from "#protocols-gen/wayland-types.js";

// Wayland event-sender args: wire scalars, a resource, a WaylandFd (event fd
// args like wl_keyboard.keymap), an array buffer, or null.
export type EventArg = number | string | Resource | WaylandFd | Uint8Array | null;
// One interface's generated event senders (e.g. { send_capabilities, send_name }).
export type EventSenders = Record<string, (...args: EventArg[]) => unknown>;
// The per-interface event-sender set: interfaceName -> its senders.
export type EventsByInterface = Record<string, EventSenders>;

// The native N-API addon (build/overdraw_native.node). Only the methods the
// JS layer calls are declared; add as needed.
export interface Addon {
  start(gpuBin: string, onFrame?: ((presented: number) => void) | null,
        onInput?: ((ev: InputEvent) => void) | null,
        headless?: { width: number; height: number } | null): { width: number; height: number };
  stop(): void;
  presentedCount(): number;
  startServer(): string;
  stopServer(): void;

  registerProtocols(signatures: unknown[]): void;
  registerInterface(name: string, handler: unknown): void;
  createGlobal(name: string, handler: unknown): void;
  postEvent(resource: Resource, opcode: number, args: unknown[]): void;
  clientId(resource: Resource): number;

  // Keyboard: keymap memfd (as a WaylandFd) + xkb modifier state.
  keymapInfo(): { fd: WaylandFd; format: number; size: number } | null;

  // linux-dmabuf-v1 default-feedback data sourced from the GPU process.
  // formatTableFd is a WaylandFd for the {format,pad,modifier} table memfd;
  // mainDevice/trancheFormats are pre-encoded byte arrays for the 'a' args.
  // null if the GPU process supplied no feedback (fall back to v3 events).
  dmabufFeedbackInfo(): {
    formatTableFd: WaylandFd; formatTableSize: number; entryCount: number;
    mainDevice: Uint8Array; trancheFormats: Uint8Array;
  } | null;
  keyUpdate(evdevKey: number, pressed: boolean): {
    modsDepressed: number; modsLatched: number; modsLocked: number; group: number;
  };

  // Surface bridge / compositor.
  commitSurfaceBuffer(id: number, poolId: number, offset: number, w: number,
                      h: number, stride: number): boolean;
  // The dmabuf fd is a WaylandFd; native dups it (the buffer is reused across
  // commits). bufferId identifies the buffer for release tracking.
  commitSurfaceDmabuf(id: number, fd: WaylandFd, w: number, h: number,
                      fourcc: number, modHi: number, modLo: number,
                      offset: number, stride: number, bufferId: number): boolean;
  // Surfaces that gained presentable content (commit completed) since the last
  // call, for both shm and dmabuf. Used as the single map-on-first-content
  // signal (dmabuf commits complete asynchronously, so map cannot be inferred
  // from commitSurfaceDmabuf's return).
  takeImportedSurfaces(): Array<{ id: number; width: number; height: number }>;
  // dmabuf bufferIds whose compositor GPU read has completed (safe to release).
  takeFreedBuffers(): number[];
  // Synthetic input (test seam): feed a normalized InputEvent through the same
  // sink the host seat uses, so it routes to onInput / the seat exactly as a real
  // host event would. Used by integration tests to drive focus/pointer behavior.
  injectInput(event: InputEvent): void;
  // Like injectInput, but routes through the REAL WaylandInputBackend
  // normalization (fixed-point -> output space, evdev codes) -- the layer
  // injectInput skips. Pointer x/y are logical output-space coords. Returns false
  // if no input backend is active. Supersedes the manual input-smoke path (all
  // but the GPU-process host-seat listener, which needs a real device).
  injectHostInput(event: InputEvent): boolean;
  removeSurface(id: number): void;
  setSurfaceLayout(id: number, x: number, y: number, w: number, h: number): void;
  setStack(ids: number[]): void;
  // Async test hook: starts a texture readback; cb(px|null) fires later on the
  // Node thread when the GPU map completes. Returns true if started.
  surfaceReadback(id: number, cb: (px: Uint8Array | null) => void): boolean;
  // Async readback of the COMPOSITED frame (headless offscreen target): the full
  // placed + stacked + blended output as width*height*4 BGRA bytes. cb(px|null)
  // fires on the Node thread. Returns false if not headless. Use for compositing
  // correctness tests.
  frameReadback(cb: (px: Uint8Array | null) => void): boolean;

  // shm pools. The pool fd is a WaylandFd; native takes the raw fd out of it.
  shmCreatePool(fd: WaylandFd, size: number): number;
  shmResizePool(poolId: number, size: number): void;
  shmDestroyPool(poolId: number): void;
  // Buffer lifetime: a wl_buffer keeps its pool's mapping alive past
  // wl_shm_pool.destroy (Wayland spec).
  shmBufferRef(poolId: number): void;
  shmBufferUnref(poolId: number): void;

  [key: string]: unknown; // tolerate methods not yet declared here
}

// Normalized input event delivered to the onInput callback (mirror of
// native/core/input.h InputEvent, marshaled to a plain object).
export interface InputEvent {
  type:
    | "pointerEnter" | "pointerLeave" | "pointerMotion" | "pointerButton"
    | "pointerAxis" | "pointerFrame"
    | "keyboardEnter" | "keyboardLeave" | "keyboardKey" | "keyboardModifiers";
  serial: number;
  time: number;
  x?: number;
  y?: number;
  button?: number;
  pressed?: boolean;
  horizontal?: boolean;
  value?: number;
  discrete?: number;
  key?: number;
  modsDepressed?: number;
  modsLatched?: number;
  modsLocked?: number;
  group?: number;
}
