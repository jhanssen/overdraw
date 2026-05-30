// Generic protocol trampoline: registers runtime-built interfaces as Wayland
// globals and dispatches incoming client requests to JS handlers.
//
// On bind, a wl_resource is created and given a generic dispatcher. The
// dispatcher decodes the wl_argument array (per the message signature) into a
// typed tuple and calls the interface's JS handler method. new_id args cause a
// child wl_resource to be created and handed to JS.
//
// N-API-coupled (calls into JS), so it lives with the addon's binding code. The
// dispatcher runs during wl_event_loop_dispatch on the Node thread, so direct
// napi calls are safe (no threadsafe function needed).

#ifndef OVERDRAW_WAYLAND_TRAMPOLINE_H_
#define OVERDRAW_WAYLAND_TRAMPOLINE_H_

#include <node_api.h>

#include <memory>
#include <string>
#include <unordered_map>

#include "interface_registry.h"

struct wl_display;
struct wl_client;
struct wl_resource;
struct wl_message;
union wl_argument;

namespace overdraw::wayland {

class Trampoline {
  public:
    Trampoline(napi_env env, wl_display* display, InterfaceRegistry* registry);
    ~Trampoline();

    // Create a global for `interfaceName` (must be built in the registry) and
    // route its requests to `handler` (a JS object with a method per request).
    // Returns false if the interface is unknown.
    bool createGlobal(const std::string& interfaceName, napi_value handler);

    // Post an event to a client: encode the JS args per the event's signature
    // and call wl_resource_post_event_array. `resourceHandle` is a wrapped
    // resource (from wrapResource); `opcode` is the event index; `argsArray` is
    // a JS array of the event's typed args. Returns false on error (message set
    // via napi exception by the caller path).
    bool postEvent(napi_value resourceHandle, uint32_t opcode, napi_value argsArray);

    // Drop a cached wrapper + mark the JS handle destroyed. Called from the
    // per-resource destroy listener.
    void forgetResource(wl_resource* resource);

  private:
    struct InterfaceState {
        std::string name;
        const wl_interface* iface = nullptr;
        napi_ref handler = nullptr;
        Trampoline* owner = nullptr;
    };

    static void onBind(wl_client* client, void* data, uint32_t version, uint32_t id);
    static int onDispatch(const void* implData, void* target, uint32_t opcode,
                          const wl_message* msg, wl_argument* args);

    // Return the JS resource handle for `resource`, creating and caching it on
    // first use so JS sees a stable object per resource. `ifaceName` is used
    // only when creating.
    napi_value wrapResource(wl_resource* resource, const std::string& ifaceName);

    napi_env env_;
    wl_display* display_;
    InterfaceRegistry* registry_;
    std::unordered_map<std::string, std::unique_ptr<InterfaceState>> interfaces_;
    // Stable JS wrapper per wl_resource (napi_ref keeps it alive while the
    // resource lives). Cleared on resource destroy.
    std::unordered_map<wl_resource*, napi_ref> wrappers_;
};

}  // namespace overdraw::wayland

#endif  // OVERDRAW_WAYLAND_TRAMPOLINE_H_
