// wl_compositor: factory for surfaces and regions. create_surface / create_region
// receive the already-created child resource (the trampoline creates it from the
// new_id arg and routes its requests to the registered wl_surface / wl_region
// handlers). Each surface gets a stable integer id used as the compositor key.

export default function makeCompositor(ctx) {
  return {
    create_surface(_resource, surface) {
      const id = ctx.state.serial(); // reuse the monotonic counter for surface ids
      ctx.state.surfaces.set(surface, {
        id,
        resource: surface,
        role: null,        // 'xdg_toplevel' once assigned
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
