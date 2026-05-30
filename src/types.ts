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
        onInput?: ((ev: InputEvent) => void) | null): { width: number; height: number };
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
  keyUpdate(evdevKey: number, pressed: boolean): {
    modsDepressed: number; modsLatched: number; modsLocked: number; group: number;
  };

  // Surface bridge / compositor.
  commitSurfaceBuffer(id: number, poolId: number, offset: number, w: number,
                      h: number, stride: number): boolean;
  // The dmabuf fd is a WaylandFd; native takes the raw fd out of it.
  commitSurfaceDmabuf(id: number, fd: WaylandFd, w: number, h: number,
                      fourcc: number, modHi: number, modLo: number,
                      offset: number, stride: number): boolean;
  removeSurface(id: number): void;
  setSurfaceLayout(id: number, x: number, y: number, w: number, h: number): void;
  setStack(ids: number[]): void;
  surfaceReadback(id: number): Uint8Array | null;

  // shm pools. The pool fd is a WaylandFd; native takes the raw fd out of it.
  shmCreatePool(fd: WaylandFd, size: number): number;
  shmResizePool(poolId: number, size: number): void;
  shmDestroyPool(poolId: number): void;

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
