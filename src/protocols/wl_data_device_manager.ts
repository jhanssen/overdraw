// wl_data_device_manager / wl_data_device: clipboard + drag-and-drop. Clients
// like foot require the *manager* global to exist (foot aborts without it).
//
// LIMITATION: clipboard/DnD is NOT implemented. We satisfy the protocol shape
// (create data sources and per-seat data devices that accept requests) but no
// selection or transfer actually happens. This is enough to get clients past
// startup; real clipboard is future work (and needs the WaylandFd data-transfer
// path for the pipe fds).

import type { WlDataDeviceManagerHandler } from "#protocols-gen/wl_data_device_manager.js";
import type { WlDataDeviceHandler } from "#protocols-gen/wl_data_device.js";
import type { WlDataSourceHandler } from "#protocols-gen/wl_data_source.js";

export default function makeDataDeviceManager(): WlDataDeviceManagerHandler {
  return {
    create_data_source(_resource, _id) {},
    get_data_device(_resource, _id, _seat) {},
  };
}

export function makeDataDevice(): WlDataDeviceHandler {
  return {
    start_drag(_resource, _source, _origin, _icon, _serial) {},
    set_selection(_resource, _source, _serial) {},
    release(_resource) {},
  };
}

export function makeDataSource(): WlDataSourceHandler {
  return {
    offer(_resource, _mimeType) {},
    destroy(_resource) {},
    set_actions(_resource, _dndActions) {},
  };
}
