#include "trampoline.h"

#include <cstdio>
#include <cstring>
#include <vector>

#include <unistd.h>

#include <wayland-server-core.h>
#include <wayland-util.h>

#include "wayland_fd.h"

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
    for (auto& [key, st] : outputGlobals_) {
        if (st->handler) napi_delete_reference(env_, st->handler);
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

bool Trampoline::createGlobalForOutput(const std::string& interfaceName,
                                       uint32_t outputId, napi_value handler) {
    const wl_interface* iface = registry_->get(interfaceName);
    if (!iface) return false;
    // Allocate a fresh InterfaceState whose handler is the per-output JS
    // object. Stored in outputGlobals_ keyed by "<name>:<outputId>" so it
    // survives the call and the destructor can drop the napi_ref.
    auto st = std::make_unique<InterfaceState>();
    st->name = interfaceName;
    st->iface = iface;
    st->owner = this;
    napi_create_reference(env_, handler, 1, &st->handler);
    InterfaceState* raw = st.get();
    std::string key = interfaceName + ":" + std::to_string(outputId);
    // Remember the wl_global so destroyGlobalForOutput can tear it down on
    // hotplug remove (M7). createGlobal (non-per-output) doesn't keep the
    // pointer; those globals live for the process.
    raw->global = wl_global_create(display_, raw->iface, raw->iface->version,
                                   raw, &Trampoline::onBind);
    outputGlobals_[key] = std::move(st);
    return true;
}

bool Trampoline::destroyGlobalForOutput(const std::string& interfaceName,
                                        uint32_t outputId) {
    std::string key = interfaceName + ":" + std::to_string(outputId);
    auto it = outputGlobals_.find(key);
    if (it == outputGlobals_.end()) {
        // Already removed (or never created) -- treat as a successful no-op so
        // the JS handler is idempotent across pre-remove / removed firings.
        return true;
    }
    if (it->second->global) {
        wl_global_destroy(it->second->global);
        it->second->global = nullptr;
    }
    if (it->second->handler) {
        napi_delete_reference(env_, it->second->handler);
        it->second->handler = nullptr;
    }
    outputGlobals_.erase(it);
    return true;
}

void Trampoline::onBind(wl_client* client, void* data, uint32_t version, uint32_t id) {
    auto* st = static_cast<InterfaceState*>(data);
    wl_resource* res = wl_resource_create(client, st->iface, static_cast<int>(version), id);
    if (!res) { wl_client_post_no_memory(client); return; }
    // Generic dispatcher; implementation pointer carries the InterfaceState.
    wl_resource_set_dispatcher(res, &Trampoline::onDispatch, st, st, nullptr);
    std::printf("[wl] bind %s v%u id=%u\n", st->name.c_str(), version, id);

    // Optional on-bind hook: if the handler has a `bind` method, call it with
    // the freshly-bound resource so it can send initial events (e.g.
    // wl_shm.format advertisements). Runs on the Node thread.
    Trampoline* self = st->owner;
    napi_env env = self->env_;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value handler;
    napi_get_reference_value(env, st->handler, &handler);
    napi_value bindFn;
    if (napi_get_named_property(env, handler, "bind", &bindFn) == napi_ok) {
        napi_valuetype t;
        napi_typeof(env, bindFn, &t);
        if (t == napi_function) {
            napi_value arg = self->wrapResource(res, st->name);
            napi_value result;
            if (napi_call_function(env, handler, bindFn, 1, &arg, &result) != napi_ok)
                napi_get_and_clear_last_exception(env, &result);
        }
    }
    napi_close_handle_scope(env, scope);
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
    napi_value ext, name, ver;
    napi_create_external(env_, resource, nullptr, nullptr, &ext);
    napi_create_string_utf8(env_, ifaceName.c_str(), NAPI_AUTO_LENGTH, &name);
    napi_create_uint32(env_, static_cast<uint32_t>(wl_resource_get_version(resource)), &ver);
    napi_set_named_property(env_, obj, "__resource", ext);
    napi_set_named_property(env_, obj, "interfaceName", name);
    // The version the client bound this resource at. Handlers must gate
    // version-since events on this (sending a too-new event aborts the client).
    napi_set_named_property(env_, obj, "version", ver);

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

bool Trampoline::destroyResource(napi_value resourceHandle) {
    napi_value ext;
    if (napi_get_named_property(env_, resourceHandle, "__resource", &ext) != napi_ok)
        return false;
    void* ptr = nullptr;
    if (napi_get_value_external(env_, ext, &ptr) != napi_ok || !ptr) return false;
    auto* resource = static_cast<wl_resource*>(ptr);
    // Skip if our wrapper map no longer has it (a destroy listener already
    // ran -- the libwayland resource is gone). Avoids calling
    // wl_resource_destroy on a dangling pointer.
    if (wrappers_.find(resource) == wrappers_.end()) return true;
    wl_resource_destroy(resource);
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

uint64_t Trampoline::clientIdOf(napi_value resourceHandle) {
    napi_env env = env_;
    napi_value ext;
    if (napi_get_named_property(env, resourceHandle, "__resource", &ext) != napi_ok) return 0;
    void* ptr = nullptr;
    if (napi_get_value_external(env, ext, &ptr) != napi_ok || !ptr) return 0;
    auto* resource = static_cast<wl_resource*>(ptr);
    // Destroyed resource (client gone) while JS holds a stale wrapper: the
    // external still points at freed memory. Treat a wrappers_ miss as "no
    // client" rather than dereferencing the dangling pointer.
    if (wrappers_.find(resource) == wrappers_.end()) return 0;
    return reinterpret_cast<uint64_t>(wl_resource_get_client(resource));
}

bool Trampoline::postError(napi_value resourceHandle, uint32_t code, const std::string& message) {
    napi_env env = env_;
    napi_value ext;
    if (napi_get_named_property(env, resourceHandle, "__resource", &ext) != napi_ok) return false;
    void* ptr = nullptr;
    if (napi_get_value_external(env, ext, &ptr) != napi_ok || !ptr) return false;
    auto* resource = static_cast<wl_resource*>(ptr);
    // The wl_resource may already be destroyed (client died) while JS holds the
    // wrapper -- same use-after-free guard as postEvent. Posting an error to a
    // dead client is a no-op.
    if (wrappers_.find(resource) == wrappers_.end()) return true;
    // "%s" so client/handler-supplied text is never interpreted as a format.
    wl_resource_post_error(resource, code, "%s", message.c_str());
    return true;
}

bool Trampoline::postEvent(napi_value resourceHandle, uint32_t opcode, napi_value argsArray,
                           napi_value* minted) {
    napi_env env = env_;
    // Unwrap wl_resource* from the handle's __resource external.
    napi_value ext;
    if (napi_get_named_property(env, resourceHandle, "__resource", &ext) != napi_ok) return false;
    void* ptr = nullptr;
    if (napi_get_value_external(env, ext, &ptr) != napi_ok || !ptr) return false;
    auto* resource = static_cast<wl_resource*>(ptr);

    // The wl_resource may already be destroyed (its client died) while JS still
    // holds the wrapper: an external's stored pointer is immutable, so it keeps
    // pointing at freed memory. wrappers_ tracks live resources -- the destroy
    // listener erases the entry before libwayland frees the resource -- so a
    // miss means dereferencing `resource` here would be a use-after-free. The
    // target is gone; drop the event as a no-op (posting to a dead client is one
    // in wayland too) rather than reporting failure to JS.
    if (wrappers_.find(resource) == wrappers_.end()) return true;

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
    // Fds extracted for 'h' args: kept valid through the post call, then closed
    // (wl_resource_post_event_array dups into the wire; we still own ours).
    std::vector<int> fdKeep;
    // If the event carries a server-minted new_id, the created resource wrapper is
    // returned to JS so it can immediately send events on it.
    napi_value mintedResource = nullptr;
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
            case 'n': {
                // Server-minted new_id in an EVENT (e.g. wl_data_device.data_offer).
                // The server creates the wl_resource; libwayland marshals a sent
                // new_id from the .o (wl_object*) slot (see wl_argument_from_va_list
                // 'n' -> .o). JS passes a non-numeric value (e.g. {} or null) to
                // signal "mint here"; we create the resource on the event target's
                // client + the arg's interface, route its requests to the registered
                // handler, and return the wrapped resource to JS (so it can send
                // events on it, e.g. data_offer.offer). If JS DID pass a number,
                // honor it as a raw id (legacy/explicit) for completeness.
                napi_valuetype t; napi_typeof(env, v, &t);
                if (t == napi_number) {
                    uint32_t x = 0; napi_get_value_uint32(env, v, &x); wargs[ai].n = x;
                    break;
                }
                const wl_interface* ni = (ev->types && ev->types[ai]) ? ev->types[ai] : nullptr;
                if (!ni) { wargs[ai].o = nullptr; break; }
                wl_client* cl = wl_resource_get_client(resource);
                int version = wl_resource_get_version(resource);
                wl_resource* child = wl_resource_create(cl, ni, version, 0);  // 0 = server allocates id
                if (!child) { wl_client_post_no_memory(cl); break; }
                auto it = interfaces_.find(ni->name);
                if (it != interfaces_.end())
                    wl_resource_set_dispatcher(child, &Trampoline::onDispatch,
                                               it->second.get(), it->second.get(), nullptr);
                mintedResource = wrapResource(child, ni->name);
                wargs[ai].o = reinterpret_cast<wl_object*>(child);
                break;
            }
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
            case 'h': {
                // Outgoing fd arg (e.g. wl_keyboard.keymap). JS passes a
                // WaylandFd; take the raw fd out and hand it to libwayland, which
                // dups it into the wire connection on post. We then own (and
                // close) our copy after the post.
                int fd = takeWaylandFd(env, v);
                fdKeep.push_back(fd);
                wargs[ai].h = fd;
                break;
            }
            default: wargs[ai].u = 0; break;
        }
        ++ai;
    }

    wl_resource_post_event_array(resource, opcode, wargs.data());

    // libwayland dup'd any fd args into the wire; close our copies.
    for (int fd : fdKeep) if (fd >= 0) ::close(fd);
    if (minted) *minted = mintedResource;
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
                // libwayland transfers ownership of the demarshalled request fd
                // to the dispatcher and does NOT close it after dispatch -- the
                // callee owns it. Wrap it directly; the WaylandFd closes it on
                // close()/finalize, or a native consumer takes it out
                // (takeWaylandFd). Duping and leaving the original open would
                // leak one fd per request that carries one (e.g. every dmabuf
                // plane add).
                v = makeWaylandFd(env, args[argIndex].h);
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
            // Surface the actual error: prefer the stack (message + trace),
            // fall back to coercing the thrown value to a string.
            auto toStr = [&](napi_value v) -> std::string {
                napi_value str;
                if (napi_coerce_to_string(env, v, &str) != napi_ok) {
                    napi_value pending;
                    napi_get_and_clear_last_exception(env, &pending);
                    return "";
                }
                size_t len = 0;
                napi_get_value_string_utf8(env, str, nullptr, 0, &len);
                std::string out;
                out.resize(len);
                size_t got = 0;
                napi_get_value_string_utf8(env, str, out.data(), len + 1, &got);
                return out;
            };
            std::string detail;
            napi_value stack;
            napi_valuetype t = napi_undefined;
            if (napi_get_named_property(env, ex, "stack", &stack) == napi_ok) {
                napi_typeof(env, stack, &t);
                if (t == napi_string) detail = toStr(stack);
            }
            if (detail.empty()) detail = toStr(ex);
            std::fprintf(stderr, "[wl] handler %s.%s threw: %s\n",
                         st->name.c_str(), msg->name, detail.c_str());
        }
    }
    napi_close_handle_scope(env, scope);

    // For destructor requests (XML type="destructor": wl_buffer.destroy,
    // wl_surface.destroy, wl_pointer.release, etc.) the protocol contract is
    // that this resource is gone. The per-protocol JS handler did its
    // bookkeeping (TS map deletes, lifecycle dispatches); now release the
    // libwayland-side resource so the wl_resource and its napi_ref aren't
    // leaked for the client's lifetime. forgetResource (via the destroy
    // listener) drops the cached wrapper and flips destroyed=true on the JS
    // handle, so any stale JS reference is harmless.
    if (self->registry_->isRequestDestructor(st->name, opcode)) {
        wl_resource_destroy(resource);
    }
    return 0;
}

}  // namespace overdraw::wayland
