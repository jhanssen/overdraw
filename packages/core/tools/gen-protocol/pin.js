// Interfaces generated below the version their XML declares. The cap becomes
// the interface's advertised version (the wl_interface built at runtime from
// this metadata is what wl_global_create advertises), and every request/event
// introduced after it is dropped, so a client can neither bind nor reach a
// feature that has no implementation.
//
// An entry here is a deliberate statement that the newer version is NOT
// implemented; docs/status.md lists what each one costs. Removing an entry
// means implementing every message the XML adds above the cap.
//
// Caps apply per interface, but an unimplemented feature usually has to be
// capped across the whole object tree that reaches it: a client binding
// wl_compositor v7 would get v7 surfaces, and a v6 zwp_linux_dmabuf_v1 hands
// out v6 params objects.
export const VERSION_PINS = {
  // wl_surface v7 adds get_release: a per-commit buffer-release callback,
  // which the buffer-release lifecycle does not model.
  wl_surface: 6,
  wl_compositor: 6,
  // wl_data_device_manager v4 adds a release destructor.
  wl_data_device_manager: 3,
  // linux-dmabuf v6 adds zwp_linux_buffer_params_v1.set_sampling_device
  // (client-chosen import device) and the feedback tranche flag that goes
  // with it.
  zwp_linux_dmabuf_v1: 5,
  zwp_linux_buffer_params_v1: 5,
  zwp_linux_dmabuf_feedback_v1: 5,
};

// Drop the messages a pinned interface must not expose, and clamp its version.
// Mutates the parsed interface in place.
//
// Opcodes are positional, so the kept messages must stay at the indices the
// full table gave them. Wayland only ever appends, making the dropped set a
// suffix; verify that rather than trusting it, since a renumbered opcode would
// silently misroute every request past it.
export function applyVersionPin(iface, pins = VERSION_PINS) {
  const pin = pins[iface.name];
  if (pin === undefined) return iface;
  if (pin > iface.version) {
    throw new Error(
      `${iface.name}: pinned to v${pin} but the XML only declares v${iface.version}`,
    );
  }
  for (const kind of ['requests', 'events']) {
    const kept = iface[kind].filter((m) => m.since <= pin);
    if (iface[kind].slice(0, kept.length).some((m, i) => m !== kept[i])) {
      throw new Error(
        `${iface.name}: pinning to v${pin} would renumber ${kind} opcodes ` +
        `(a message with since > ${pin} precedes one with since <= ${pin})`,
      );
    }
    iface[kind] = kept;
  }
  iface.version = pin;
  return iface;
}
