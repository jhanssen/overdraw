// wl_compositor: factory for surfaces and regions. create_surface / create_region
// receive the already-created child resource (the trampoline creates it from the
// new_id arg and routes its requests to the registered wl_surface / wl_region
// handlers).

export default function makeCompositor(ctx) {
  return {
    create_surface(_resource, surface) {
      ctx.state.surfaces.set(surface, {
        resource: surface,
        role: null,        // 'xdg_toplevel' once assigned
        buffer: null,      // attached wl_buffer (none yet)
        pending: { buffer: undefined },
        committed: { buffer: null },
        xdgSurface: null,  // associated xdg_surface record
      });
    },
    create_region(_resource, _region) {
      // Regions track damage/opaque/input areas; no state needed for first light.
    },
  };
}
