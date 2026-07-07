// N-API surface for the Xwayland lifecycle. Registered into the core addon's
// exports from addon.cpp Init. Kept separate from server.cpp so the spawn logic
// stays N-API-free (and so the xcb code never mixes with napi).

#ifndef OVERDRAW_XWAYLAND_NAPI_XWAYLAND_H_
#define OVERDRAW_XWAYLAND_NAPI_XWAYLAND_H_

#include <node_api.h>

namespace overdraw::xwayland {

// Adds xwaylandStart / xwaylandStop to `exports`.
void RegisterXwayland(napi_env env, napi_value exports);

}  // namespace overdraw::xwayland

#endif  // OVERDRAW_XWAYLAND_NAPI_XWAYLAND_H_
