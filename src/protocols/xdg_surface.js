// xdg_surface: the role-agnostic shell surface. get_toplevel assigns the
// toplevel role and starts the configure handshake (xdg_toplevel.configure then
// xdg_surface.configure with a serial the client must ack_configure). The
// configure sends 0x0 (client picks size) and a states wl_array; for a lone
// window we mark it activated.

import { signature as toplevelSig } from '../protocols-gen/xdg_toplevel.js';

const STATE = toplevelSig.enums.state.entries; // { maximized:1, activated:4, ... }

// Pack a list of xdg_toplevel state values into the wl_array wire form: a
// contiguous run of host-endian uint32 (libwayland copies the bytes verbatim;
// the client reads them back as uint32). Returned as a Uint8Array.
function packStates(states) {
  const buf = new ArrayBuffer(states.length * 4);
  new Uint32Array(buf).set(states);
  return new Uint8Array(buf);
}

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

      // Initial configure handshake. Send the role configure first (0x0 =>
      // client chooses its own size; states marks the lone window activated),
      // then xdg_surface.configure with a serial. The client renders, then
      // ack_configures the serial.
      const states = packStates([STATE.activated]);
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
