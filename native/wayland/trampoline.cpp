#include "trampoline.h"

#include <cstdio>
#include <cstring>
#include <vector>

#include <unistd.h>

#include <wayland-server-core.h>
#include <wayland-util.h>

namespace overdraw::wayland {
namespace {

// Per-resource destroy listener: embeds wl_listener so we can recover the
// Trampoline + resource via wl_container_of in the notify, then free it.
struct DestroyListener {
    wl_listener listener;
    Trampoline* self;
    wl_resource* resource;
};

void onResourceDestroyNotify(wl_listener* l, void* /*data*/) {
    DestroyListener* dl;
    dl = wl_container_of(l, dl, listener);
    dl->self->forgetResource(dl->resource);
    delete dl;
}

}  // namespace

Trampoline::Trampoline(napi_env env, wl_display* display, InterfaceRegistry* registry)
    : env_(env), display_(display), registry_(registry) {}

Trampoline::~Trampoline() {
    for (auto& [name, st] : interfaces_) {
        if (st->handler) napi_delete_reference(env_, st->handler);
    }
    for (auto& [handle, fd] : fds_) {
        if (fd >= 0) ::close(fd);
    }
}

Trampoline::InterfaceState* Trampoline::ensureInterface(
    const std::string& interfaceName, napi_value handler) {
    const wl_interface* iface = registry_->get(interfaceName);
    if (!iface) return nullptr;

    auto st = std::make_unique<InterfaceState>();
    st->name = interfaceName;
    st->iface = iface;
    st->owner = this;
    napi_create_reference(env_, handler, 1, &st->handler);

    InterfaceState* raw = st.get();
    interfaces_[interfaceName] = std::move(st);
    return raw;
}

bool Trampoline::registerInterface(const std::string& interfaceName, napi_value handler) {
    return ensureInterface(interfaceName, handler) != nullptr;
}

bool Trampoline::createGlobal(const std::string& interfaceName, napi_value handler) {
    InterfaceState* st = ensureInterface(interfaceName, handler);
    if (!st) return false;
    wl_global_create(display_, st->iface, st->iface->version, st, &Trampoline::onBind);
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
    // Return the cached wrapper if this resource already has one.
    auto it = wrappers_.find(resource);
    if (it != wrappers_.end()) {
        napi_value cached;
        if (napi_get_reference_value(env_, it->second, &cached) == napi_ok && cached) return cached;
    }

    napi_value obj;
    napi_create_object(env_, &obj);
    napi_value ext, name;
    napi_create_external(env_, resource, nullptr, nullptr, &ext);
    napi_create_string_utf8(env_, ifaceName.c_str(), NAPI_AUTO_LENGTH, &name);
    napi_set_named_property(env_, obj, "__resource", ext);
    napi_set_named_property(env_, obj, "interfaceName", name);

    napi_ref ref;
    napi_create_reference(env_, obj, 1, &ref);
    wrappers_[resource] = ref;

    // Invalidate + drop the wrapper when the resource is destroyed. The listener
    // is heap-allocated per resource and freed in the notify.
    auto* dl = new DestroyListener{};
    dl->listener.notify = &onResourceDestroyNotify;
    dl->self = this;
    dl->resource = resource;
    wl_resource_add_destroy_listener(resource, &dl->listener);
    return obj;
}

uint32_t Trampoline::registerFd(int fd) {
    uint32_t handle = nextFd_++;
    fds_[handle] = fd;
    return handle;
}

int Trampoline::takeFd(uint32_t handle) {
    auto it = fds_.find(handle);
    if (it == fds_.end()) return -1;
    int fd = it->second;
    fds_.erase(it);  // ownership transfers to caller; table no longer closes it
    return fd;
}

bool Trampoline::closeFd(uint32_t handle) {
    auto it = fds_.find(handle);
    if (it == fds_.end()) return false;
    if (it->second >= 0) ::close(it->second);
    fds_.erase(it);
    return true;
}

void Trampoline::forgetResource(wl_resource* resource) {
    auto it = wrappers_.find(resource);
    if (it == wrappers_.end()) return;
    // Runs from a wl_resource destroy listener invoked during
    // wl_event_loop_dispatch (a libuv callback), not inside a napi callback, so
    // there is no ambient handle scope -- open one explicitly.
    napi_handle_scope scope;
    napi_open_handle_scope(env_, &scope);
    napi_value obj;
    if (napi_get_reference_value(env_, it->second, &obj) == napi_ok && obj) {
        napi_value t; napi_get_boolean(env_, true, &t);
        napi_set_named_property(env_, obj, "destroyed", t);
    }
    napi_delete_reference(env_, it->second);
    napi_close_handle_scope(env_, scope);
    wrappers_.erase(it);
}

bool Trampoline::postEvent(napi_value resourceHandle, uint32_t opcode, napi_value argsArray) {
    napi_env env = env_;
    // Unwrap wl_resource* from the handle's __resource external.
    napi_value ext;
    if (napi_get_named_property(env, resourceHandle, "__resource", &ext) != napi_ok) return false;
    void* ptr = nullptr;
    if (napi_get_value_external(env, ext, &ptr) != napi_ok || !ptr) return false;
    auto* resource = static_cast<wl_resource*>(ptr);

    // Resolve the resource's interface (for the event signature) via its class.
    const char* className = wl_resource_get_class(resource);
    const wl_interface* wi = registry_->get(className ? className : "");
    if (!wi || static_cast<int>(opcode) >= wi->event_count) return false;
    const wl_message* ev = &wi->events[opcode];

    // Encode args per the event signature. String storage must outlive the
    // post call (libwayland copies into the wire buffer there).
    uint32_t n = 0;
    napi_get_array_length(env, argsArray, &n);
    std::vector<wl_argument> wargs(n);
    std::vector<std::string> strKeep;
    strKeep.reserve(n);
    // wl_array storage must outlive the post call. Reserve so element addresses
    // stay stable as we append.
    std::vector<wl_array> arrKeep;
    arrKeep.reserve(n);
    int ai = 0;
    for (const char* p = ev->signature; *p && ai < static_cast<int>(n); ++p) {
        if (*p >= '0' && *p <= '9') continue;
        if (*p == '?') { ++p; if (!*p) break; }
        napi_value v; napi_get_element(env, argsArray, ai, &v);
        switch (*p) {
            case 'i': { int32_t x = 0; napi_get_value_int32(env, v, &x); wargs[ai].i = x; break; }
            case 'u': { uint32_t x = 0; napi_get_value_uint32(env, v, &x); wargs[ai].u = x; break; }
            case 'f': { double d = 0; napi_get_value_double(env, v, &d); wargs[ai].f = wl_fixed_from_double(d); break; }
            case 's': {
                napi_valuetype t; napi_typeof(env, v, &t);
                if (t == napi_string) {
                    size_t len = 0; napi_get_value_string_utf8(env, v, nullptr, 0, &len);
                    std::string s(len, '\0'); napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
                    strKeep.push_back(std::move(s));
                    wargs[ai].s = strKeep.back().c_str();
                } else {
                    wargs[ai].s = nullptr;
                }
                break;
            }
            case 'o': {
                napi_valuetype t; napi_typeof(env, v, &t);
                void* p2 = nullptr;
                if (t == napi_object) {
                    napi_value e2;
                    if (napi_get_named_property(env, v, "__resource", &e2) == napi_ok)
                        napi_get_value_external(env, e2, &p2);
                }
                wargs[ai].o = reinterpret_cast<wl_object*>(p2);
                break;
            }
            case 'n': { uint32_t x = 0; napi_get_value_uint32(env, v, &x); wargs[ai].n = x; break; }
            case 'a': {
                // Uint8Array (or any typed array / arraybuffer) -> wl_array. The
                // backing bytes belong to the JS value, which is live for this
                // call; point wl_array at them (post copies into the wire buffer).
                wl_array a{};
                bool isTyped = false;
                napi_is_typedarray(env, v, &isTyped);
                if (isTyped) {
                    napi_typedarray_type tt; size_t len; void* data; napi_value ab; size_t off;
                    napi_get_typedarray_info(env, v, &tt, &len, &data, &ab, &off);
                    a.data = data;
                    a.size = len;  // element size 1 for uint8; bytes for others handled by len*?
                    a.alloc = len;
                } else {
                    bool isAb = false; napi_is_arraybuffer(env, v, &isAb);
                    if (isAb) {
                        void* data; size_t len;
                        napi_get_arraybuffer_info(env, v, &data, &len);
                        a.data = data; a.size = len; a.alloc = len;
                    }
                }
                arrKeep.push_back(a);
                wargs[ai].a = &arrKeep.back();
                break;
            }
            case 'h': wargs[ai].h = -1; break;       // fd events: later
            default: wargs[ai].u = 0; break;
        }
        ++ai;
    }

    wl_resource_post_event_array(resource, opcode, wargs.data());
    return true;
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
            case 'o': {
                // Existing object: libwayland resolved the client's object id to
                // a wl_resource (we registered the proper types[]). Wrap it (or
                // null if absent/nullable).
                auto* objRes = reinterpret_cast<wl_resource*>(args[argIndex].o);
                if (objRes) {
                    const char* cn = wl_resource_get_class(objRes);
                    v = self->wrapResource(objRes, cn ? cn : "");
                } else {
                    napi_get_null(env, &v);
                }
                break;
            }
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
            case 'a': {
                // wl_array -> Uint8Array (copy of the bytes).
                auto* arr = reinterpret_cast<wl_array*>(args[argIndex].a);
                size_t sz = arr ? arr->size : 0;
                void* abData = nullptr;
                napi_value ab;
                napi_create_arraybuffer(env, sz, &abData, &ab);
                if (sz) std::memcpy(abData, arr->data, sz);
                napi_create_typedarray(env, napi_uint8_array, sz, ab, 0, &v);
                break;
            }
            case 'h': {
                // libwayland hands us the demarshalled fd for this dispatch.
                // Its ownership across dispatch is version-dependent, so dup()
                // immediately into our table -- correct whether libwayland keeps
                // or closes the original. JS gets an opaque integer handle; the
                // raw fd stays native-owned (it is handed to native import APIs,
                // e.g. shm/dmabuf, not operated on in JS).
                int rawFd = args[argIndex].h;
                int dupFd = rawFd >= 0 ? ::dup(rawFd) : -1;
                uint32_t handle = self->registerFd(dupFd);
                napi_create_uint32(env, handle, &v);
                break;
            }
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
