// overdraw plugin Worker addon (overdraw_plugin_native.node).
//
// Loaded INSIDE a plugin Worker isolate (NOT the core). Context-aware (per-
// instance data, no process-global singleton) so it is safe to load in a Worker
// alongside the core addon in the main isolate. Exposes ONLY the plugin's Dawn
// wire client (WorkerWireClient): open on a core-provided fd, bring up a device,
// reserve producer textures, pump. ALL side-channel control (connection setup,
// instance injection, surface allocation, fence brackets) stays in the CORE; the
// Worker reaches it via postMessage. The Worker loads dawn.node separately for
// wrapDevice/wrapTexture + WebGPU.

#include <cstdint>
#include <memory>
#include <vector>

#include <node_api.h>

#include "worker_wire.h"

using overdraw::plugin::WorkerWireClient;

namespace {

// Per-isolate state (context-aware): the Worker's wire clients, indexed by id.
struct Instance {
    std::vector<std::unique_ptr<WorkerWireClient>> clients;
    WorkerWireClient* get(uint32_t id) {
        return (id < clients.size()) ? clients[id].get() : nullptr;
    }
};

Instance* self(napi_env env) {
    void* data = nullptr;
    napi_get_instance_data(env, &data);
    return static_cast<Instance*>(data);
}

napi_value throwErr(napi_env env, const char* msg) {
    napi_throw_error(env, nullptr, msg);
    return nullptr;
}

uint32_t u32(napi_env env, napi_value v) { uint32_t o = 0; napi_get_value_uint32(env, v, &o); return o; }
int32_t i32(napi_env env, napi_value v) { int32_t o = 0; napi_get_value_int32(env, v, &o); return o; }

napi_value handleObj(napi_env env, WorkerWireClient::Handle h) {
    napi_value o, id, gen;
    napi_create_object(env, &o);
    napi_create_uint32(env, h.id, &id);
    napi_create_uint32(env, h.generation, &gen);
    napi_set_named_property(env, o, "id", id);
    napi_set_named_property(env, o, "generation", gen);
    return o;
}

// openWireClient(fd) -> clientId (uint)
napi_value OpenWireClient(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    int fd = i32(env, argv[0]);
    if (fd < 0) return throwErr(env, "openWireClient(fd): bad fd");
    auto* st = self(env);
    uint32_t id = static_cast<uint32_t>(st->clients.size());
    st->clients.push_back(std::make_unique<WorkerWireClient>(fd));
    st->clients.back()->markSharedWithJs();  // dawn.node objects outlive the client
    napi_value out; napi_create_uint32(env, id, &out);
    return out;
}

// reserveInstance(clientId) -> { id, generation }
napi_value ReserveInstance(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "reserveInstance: bad clientId");
    return handleObj(env, c->reserveInstance());
}

// startDevice(clientId) -> undefined (call after the core injects the instance)
napi_value StartDevice(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "startDevice: bad clientId");
    c->startDevice();
    return nullptr;
}

// pump(clientId) -> { ready, failed }  (Worker calls from a timer until ready)
napi_value Pump(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "pump: bad clientId");
    c->pump();
    napi_value o, ready, failed;
    napi_create_object(env, &o);
    napi_get_boolean(env, c->deviceReady(), &ready);
    napi_get_boolean(env, c->failed(), &failed);
    napi_set_named_property(env, o, "ready", ready);
    napi_set_named_property(env, o, "failed", failed);
    return o;
}

// instanceHandle(clientId) / deviceHandle(clientId) -> bigint (for wrapDevice)
napi_value InstanceHandle(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "instanceHandle: bad clientId");
    napi_value out;
    napi_create_bigint_uint64(env, reinterpret_cast<uint64_t>(c->instanceHandle()), &out);
    return out;
}
napi_value DeviceHandle(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "deviceHandle: bad clientId");
    napi_value out;
    napi_create_bigint_uint64(env, reinterpret_cast<uint64_t>(c->deviceHandle()), &out);
    return out;
}

// deviceWireHandle(clientId) -> { id, generation } (for SetPluginTickDevice via core)
napi_value DeviceWireHandle(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "deviceWireHandle: bad clientId");
    return handleObj(env, c->deviceWireHandle());
}

// reserveProducerTexture(clientId, surfaceBufId, w, h)
//   -> { texture: {id,gen}, device: {id,gen} }
napi_value ReserveProducerTexture(napi_env env, napi_callback_info info) {
    size_t argc = 4; napi_value argv[4];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "reserveProducerTexture: bad clientId");
    auto r = c->reserveProducerTexture(u32(env, argv[1]), u32(env, argv[2]), u32(env, argv[3]));
    if (!r.ok) return throwErr(env, "reserveProducerTexture: failed");
    napi_value o;
    napi_create_object(env, &o);
    napi_set_named_property(env, o, "texture", handleObj(env, r.texture));
    napi_set_named_property(env, o, "device", handleObj(env, r.device));
    return o;
}

// producerTexture(clientId, surfaceBufId) -> bigint (wrapTexture handle)
napi_value ProducerTexture(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "producerTexture: bad clientId");
    napi_value out;
    napi_create_bigint_uint64(env,
        reinterpret_cast<uint64_t>(c->producerTexture(u32(env, argv[1]))), &out);
    return out;
}

// releaseProducerTexture(clientId, resKey): reclaim a producer reservation on
// surface teardown so the wire-client handle map does not leak.
napi_value ReleaseProducerTexture(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "releaseProducerTexture: bad clientId");
    c->releaseProducerTexture(u32(env, argv[1]));
    return nullptr;
}

// flush(clientId) -> undefined
napi_value Flush(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (c) c->flush();
    return nullptr;
}

// wireBytesQueued(clientId) -> bigint (the cross-channel ordering serial)
napi_value WireBytesQueued(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "wireBytesQueued: bad clientId");
    napi_value out;
    napi_create_bigint_uint64(env, c->wireBytesQueued(), &out);
    return out;
}

void cleanup(napi_env, void* data, void*) { delete static_cast<Instance*>(data); }

napi_value Init(napi_env env, napi_value exports) {
    auto* st = new Instance();
    napi_set_instance_data(env, st, cleanup, nullptr);

    auto reg = [&](const char* name, napi_callback fn) {
        napi_value f; napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, nullptr, &f);
        napi_set_named_property(env, exports, name, f);
    };
    reg("openWireClient", OpenWireClient);
    reg("reserveInstance", ReserveInstance);
    reg("startDevice", StartDevice);
    reg("pump", Pump);
    reg("instanceHandle", InstanceHandle);
    reg("deviceHandle", DeviceHandle);
    reg("deviceWireHandle", DeviceWireHandle);
    reg("reserveProducerTexture", ReserveProducerTexture);
    reg("releaseProducerTexture", ReleaseProducerTexture);
    reg("producerTexture", ProducerTexture);
    reg("flush", Flush);
    reg("wireBytesQueued", WireBytesQueued);
    return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
