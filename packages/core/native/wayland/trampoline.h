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
struct wl_global;
union wl_argument;

namespace overdraw::wayland {

class Trampoline {
  public:
    Trampoline(napi_env env, wl_display* display, InterfaceRegistry* registry);
    ~Trampoline();

    // Register a request handler for `interfaceName` (must be built in the
    // registry) without advertising a global. Used for interfaces that are
    // created via requests (new_id), e.g. xdg_surface, xdg_toplevel, wl_region:
    // child resources created over the wire find their handler here. Returns
    // false if the interface is unknown.
    bool registerInterface(const std::string& interfaceName, napi_value handler);

    // Register a handler (as registerInterface) and additionally advertise the
    // interface as a Wayland global so clients can bind it. Returns false if
    // the interface is unknown.
    bool createGlobal(const std::string& interfaceName, napi_value handler);

    // Like createGlobal, but tags the global with an outputId so multiple
    // globals can be advertised for the same interface -- one per output --
    // each with its own JS bind handler. wl_output is the only consumer
    // today: a client binding the wl_output for output 1 reaches output 1's
    // handler, which emits output 1's geometry. Returns false if the
    // interface is unknown.
    bool createGlobalForOutput(const std::string& interfaceName,
                               uint32_t outputId, napi_value handler);

    // Destroy a previously-advertised per-output global. Clients see
    // wl_registry.global_remove for the global's name, then existing
    // resources continue to exist until the client destroys them (libwayland
    // delivers the destroy on the next display flush). Callers must emit
    // any protocol-level "leave" events (e.g. wl_surface.leave) BEFORE
    // calling this -- once the global is gone, clients cannot identify the
    // wl_output the leave referenced. Returns false if no global is
    // registered at (interfaceName, outputId); idempotent re-call is a no-op
    // (returns true on the second call because the map miss is treated as
    // already-removed).
    bool destroyGlobalForOutput(const std::string& interfaceName,
                                uint32_t outputId);

    // Post an event to a client: encode the JS args per the event's signature
    // and call wl_resource_post_event_array. `resourceHandle` is a wrapped
    // resource (from wrapResource); `opcode` is the event index; `argsArray` is
    // a JS array of the event's typed args. Returns false on error (message set
    // via napi exception by the caller path). If the event carries a server-minted
    // new_id (e.g. wl_data_device.data_offer), `*minted` is set to the wrapped new
    // resource so JS can send events on it; pass nullptr if not needed.
    bool postEvent(napi_value resourceHandle, uint32_t opcode, napi_value argsArray,
                   napi_value* minted = nullptr);

    // Post a fatal protocol error on a client resource (wl_resource_post_error):
    // sends the error event and flags the client for disconnection after the
    // current dispatch. `code` is the interface's error enum value; `message` is
    // a human-readable diagnostic. Returns true (no-op) if the resource is
    // already gone, false only on a malformed handle.
    bool postError(napi_value resourceHandle, uint32_t code, const std::string& message);

    // Return a stable per-client id (the wl_client pointer as a uint64) for a
    // wrapped resource, or 0 on error. Lets JS associate resources created by
    // the same client (e.g. route input to the wl_pointer of the client owning
    // the focused wl_surface) without exposing wl_client to JS.
    uint64_t clientIdOf(napi_value resourceHandle);
    // Peer process id of the client owning `resourceHandle`'s connection
    // (SO_PEERCRED via wl_client_get_credentials). 0 on error.
    int32_t clientPidOf(napi_value resourceHandle);

    // Drop a cached wrapper + mark the JS handle destroyed. Called from the
    // per-resource destroy listener.
    void forgetResource(wl_resource* resource);

    // Destroy a server-initiated resource (e.g. wl_callback after its done
    // event was sent: the protocol says the callback IS the event and the
    // resource has no more uses afterward). Unwraps the JS Resource handle
    // and calls wl_resource_destroy; the existing destroy listener then
    // forgets the wrapper. Idempotent over a JS handle whose `destroyed`
    // flag is already true (the underlying wl_resource is gone -- our
    // wrapper map no longer has it -- the call is silently a no-op).
    // Returns false if the handle is not a wrapped Resource.
    bool destroyResource(napi_value resourceHandle);

  private:
    struct InterfaceState {
        std::string name;
        const wl_interface* iface = nullptr;
        napi_ref handler = nullptr;
        Trampoline* owner = nullptr;
        // Owning wl_global pointer (set for entries in outputGlobals_; null for
        // entries in interfaces_, which use either createGlobal's anonymous
        // global creation or no global at all). Used to wl_global_destroy on
        // per-output removal.
        wl_global* global = nullptr;
    };

    // Build + store an InterfaceState for `interfaceName`, taking a strong ref
    // on `handler`. Returns the stored state (owned by interfaces_) or nullptr
    // if the interface is unknown. Shared by registerInterface + createGlobal.
    InterfaceState* ensureInterface(const std::string& interfaceName, napi_value handler);

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
    // Per-output globals (today: wl_output, one per dense outputId). Each entry
    // owns its own InterfaceState (separate JS bind handler ref) so the bind
    // routes to the right output's handler. Keyed by "<interfaceName>:<outputId>".
    std::unordered_map<std::string, std::unique_ptr<InterfaceState>> outputGlobals_;
    // Stable JS wrapper per wl_resource (napi_ref keeps it alive while the
    // resource lives). Cleared on resource destroy.
    std::unordered_map<wl_resource*, napi_ref> wrappers_;
};

}  // namespace overdraw::wayland

#endif  // OVERDRAW_WAYLAND_TRAMPOLINE_H_
