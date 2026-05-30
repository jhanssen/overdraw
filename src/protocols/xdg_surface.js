// xdg_surface: the role-agnostic shell surface. get_toplevel assigns the
// toplevel role and starts the configure handshake (xdg_toplevel.configure then
// xdg_surface.configure with a serial the client must ack_configure). For first
// light we send an empty toplevel state and a 0x0 configure (client picks size).

export default function makeXdgSurface(ctx) {
  const rec = (resource) => ctx.state.xdgSurfaces?.get(resource);

  return {
    get_toplevel(resource, toplevel) {
      const xs = rec(resource);
      if (!xs) return;
      xs.role = 'toplevel';
      xs.toplevel = toplevel;
      ctx.state.toplevels ||= new Map();
      ctx.state.toplevels.set(toplevel, { resource: toplevel, xdgSurface: xs, title: null, appId: null });
      if (xs.surface) xs.surface.role = 'xdg_toplevel';

      // Initial configure handshake. Send the role configure first (empty
      // states, 0x0 => client chooses its own size), then xdg_surface.configure
      // with a serial. The client renders, then ack_configures the serial.
      const states = new Uint8Array(0); // wl_array of uint32 states; none for now
      ctx.events.xdg_toplevel.send_configure(toplevel, 0, 0, states);
      const serial = ctx.state.serial();
      xs.lastConfigureSerial = serial;
      ctx.events.xdg_surface.send_configure(resource, serial);
    },
    get_popup(_resource, _popup, _parent, _positioner) {
      // Popups not implemented for first light.
    },
    set_window_geometry(resource, x, y, w, h) {
      const xs = rec(resource);
      if (xs) xs.geometry = { x, y, width: w, height: h };
    },
    ack_configure(resource, serial) {
      const xs = rec(resource);
      if (xs && serial === xs.lastConfigureSerial) xs.configured = true;
    },
    destroy(resource) {
      const xs = rec(resource);
      if (xs?.surface) xs.surface.xdgSurface = null;
      ctx.state.xdgSurfaces?.delete(resource);
    },
  };
}
