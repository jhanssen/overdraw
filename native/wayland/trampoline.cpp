#include "trampoline.h"

#include <cstdio>
#include <cstring>
#include <vector>

#include <wayland-server-core.h>
#include <wayland-util.h>

namespace overdraw::wayland {

Trampoline::Trampoline(napi_env env, wl_display* display, InterfaceRegistry* registry)
    : env_(env), display_(display), registry_(registry) {}

Trampoline::~Trampoline() {
    for (auto& [name, st] : interfaces_) {
        if (st->handler) napi_delete_reference(env_, st->handler);
    }
}

bool Trampoline::createGlobal(const std::string& interfaceName, napi_value handler) {
    const wl_interface* iface = registry_->get(interfaceName);
    if (!iface) return false;

    auto st = std::make_unique<InterfaceState>();
    st->name = interfaceName;
    st->iface = iface;
    st->owner = this;
    napi_create_reference(env_, handler, 1, &st->handler);

    wl_global_create(display_, iface, iface->version, st.get(), &Trampoline::onBind);
    interfaces_[interfaceName] = std::move(st);
    return true;
}

void Trampoline::onBind(wl_client* client, void* data, uint32_t version, uint32_t id) {
    auto* st = static_cast<InterfaceState*>(data);
    wl_resource* res = wl_resource_create(client, st->iface, static_cast<int>(version), id);
    if (!res) { wl_client_post_no_memory(client); return; }
    // Generic dispatcher; implementation pointer carries the InterfaceState.
    wl_resource_set_dispatcher(res, &Trampoline::onDispatch, st, st, nullptr);
    std::printf("[wl] bind %s v%u id=%u\n", st->name.c_str(), version, id);
}

napi_value Trampoline::wrapResource(wl_resource* resource, const std::string& ifaceName) {
    napi_value obj;
    napi_create_object(env_, &obj);
    // Store the wl_resource* as an external; expose interfaceName for JS.
    napi_value ext, name;
    napi_create_external(env_, resource, nullptr, nullptr, &ext);
    napi_create_string_utf8(env_, ifaceName.c_str(), NAPI_AUTO_LENGTH, &name);
    napi_set_named_property(env_, obj, "__resource", ext);
    napi_set_named_property(env_, obj, "interfaceName", name);
    return obj;
}

int Trampoline::onDispatch(const void* implData, void* target, uint32_t opcode,
                           const wl_message* msg, wl_argument* args) {
    auto* st = const_cast<InterfaceState*>(static_cast<const InterfaceState*>(implData));
    Trampoline* self = st->owner;
    napi_env env = self->env_;
    auto* resource = static_cast<wl_resource*>(target);
    wl_client* client = wl_resource_get_client(resource);

    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);

    napi_value handler;
    napi_get_reference_value(env, st->handler, &handler);

    // Look up the handler method named after the request.
    napi_value method;
    napi_get_named_property(env, handler, msg->name, &method);
    napi_valuetype mt;
    napi_typeof(env, method, &mt);
    if (mt != napi_function) {
        std::fprintf(stderr, "[wl] no handler for %s.%s\n", st->name.c_str(), msg->name);
        napi_close_handle_scope(env, scope);
        return 0;
    }

    // Decode args per the signature. First JS arg is the bound resource.
    std::vector<napi_value> jsArgs;
    jsArgs.push_back(self->wrapResource(resource, st->name));

    const char* sig = msg->signature;
    int argIndex = 0;
    for (const char* p = sig; *p; ++p) {
        // Skip version digits and the nullable marker.
        if (*p >= '0' && *p <= '9') continue;
        bool nullable = false;
        if (*p == '?') { nullable = true; ++p; if (!*p) break; }

        napi_value v = nullptr;
        const wl_interface* argIface =
            (msg->types && msg->types[argIndex]) ? msg->types[argIndex] : nullptr;
        switch (*p) {
            case 'i': napi_create_int32(env, args[argIndex].i, &v); break;
            case 'u': napi_create_uint32(env, args[argIndex].u, &v); break;
            case 'f': {  // fixed 24.8 -> number
                double d = wl_fixed_to_double(args[argIndex].f);
                napi_create_double(env, d, &v);
                break;
            }
            case 's':
                if (args[argIndex].s) napi_create_string_utf8(env, args[argIndex].s, NAPI_AUTO_LENGTH, &v);
                else napi_get_null(env, &v);
                break;
            case 'o':
                // Existing object: pass null for now (resource lookup is later
                // work; the slice's create_surface has no object args).
                napi_get_null(env, &v);
                break;
            case 'n': {
                // new_id: create the child resource on the referenced interface
                // and hand a wrapped resource to JS.
                uint32_t newId = args[argIndex].n;
                int version = wl_resource_get_version(resource);
                wl_resource* child = wl_resource_create(client, argIface, version, newId);
                if (!child) { wl_client_post_no_memory(client); napi_close_handle_scope(env, scope); return 0; }
                // Route the child's requests back through this trampoline if the
                // interface has a registered handler.
                auto it = self->interfaces_.find(argIface->name);
                if (it != self->interfaces_.end())
                    wl_resource_set_dispatcher(child, &Trampoline::onDispatch, it->second.get(), it->second.get(), nullptr);
                v = self->wrapResource(child, argIface->name);
                break;
            }
            case 'a': napi_get_null(env, &v); break;  // array: later
            case 'h': napi_get_null(env, &v); break;  // fd: later (WaylandFd)
            default: napi_get_undefined(env, &v); break;
        }
        if (nullable && v == nullptr) napi_get_null(env, &v);
        jsArgs.push_back(v);
        ++argIndex;
    }

    napi_value result;
    napi_status s = napi_call_function(env, handler, method, jsArgs.size(), jsArgs.data(), &result);
    if (s != napi_ok) {
        napi_value ex;
        if (napi_get_and_clear_last_exception(env, &ex) == napi_ok) {
            std::fprintf(stderr, "[wl] handler %s.%s threw\n", st->name.c_str(), msg->name);
        }
    }
    napi_close_handle_scope(env, scope);
    return 0;
}

}  // namespace overdraw::wayland
