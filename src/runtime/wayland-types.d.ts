// Shared types referenced by all generated protocol .d.ts files.
//
// A Resource is an opaque, C++-owned wl_resource; JS holds a weak handle. The
// runtime value is a token; the brand is compile-time only and gives per-
// interface type safety (a wl_surface resource is not assignable to a
// wl_buffer parameter).

declare const __iface: unique symbol;

export interface Resource {
  /** The interface name this resource implements, e.g. 'wl_surface'. */
  readonly interfaceName: string;
  /** True once the underlying wl_resource has been destroyed. */
  readonly destroyed: boolean;
}

export type ResourceOf<Iface extends string> = Resource & {
  readonly [__iface]: Iface;
};

// A live file descriptor handed up from the trampoline (data-transfer pipes,
// keymap fds, etc.). Holds the real fd so Node fs/net can use it; throws on use
// after the underlying resource/request that owned it is gone. Buffer/GPU fds
// (dmabuf, shm) are NOT surfaced as WaylandFd -- they stay native-owned.
export interface WaylandFd {
  /** The raw fd, for net.Socket({ fd }) / fs streams. Throws if closed. */
  readonly fd: number;
  /** True once closed or invalidated by the owning resource's teardown. */
  readonly closed: boolean;
  readAll(): Promise<Uint8Array>;
  write(data: Uint8Array): Promise<number>;
  /** Take ownership of the raw fd; the wrapper is consumed afterwards. */
  takeRawFd(): number;
  close(): void;
}
