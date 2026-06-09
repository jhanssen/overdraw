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
//   -> { texture: {id,gen}, device: {id,gen}, wireSerial: bigint }
// `wireSerial` is the cross-channel ordering serial sampled by the native helper
// AFTER the flush that committed the reserve into the plugin wire's FdSerializer.
// JS callers MUST forward it to pluginAllocSurfaceBufferW so the GPU process can
// gate its plugin-side InjectTexture on the plugin wire reader catching up.
napi_value ReserveProducerTexture(napi_env env, napi_callback_info info) {
    size_t argc = 4; napi_value argv[4];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "reserveProducerTexture: bad clientId");
    auto r = c->reserveProducerTexture(u32(env, argv[1]), u32(env, argv[2]), u32(env, argv[3]));
    if (!r.ok) return throwErr(env, "reserveProducerTexture: failed");
    napi_value o, ws;
    napi_create_object(env, &o);
    napi_set_named_property(env, o, "texture", handleObj(env, r.texture));
    napi_set_named_property(env, o, "device", handleObj(env, r.device));
    napi_create_bigint_uint64(env, r.wireSerial, &ws);
    napi_set_named_property(env, o, "wireSerial", ws);
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

// forgetProducerReservation(clientId, resKey): forget the slot on surface
// teardown (per deferred-reclaim policy: does NOT recycle the wire id; the
// id remains allocated so future reserves don't collide with the GPU-process
// WireServer's still-live entry there). See WorkerWireClient::
// forgetProducerReservation for the full reasoning.
napi_value ForgetProducerReservation(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "forgetProducerReservation: bad clientId");
    c->forgetProducerReservation(u32(env, argv[1]));
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

// wireBytesQueued(clientId) -> bigint. The plugin wire's cumulative framed-byte
// counter. NOT dead after the in-band move: reserveProducerTexture still samples
// it INTERNALLY (worker_wire.cpp) to capture `reservePointSerial`, which gates
// the GPU process's producer-side AllocSurfaceBuf InjectTexture (recycled-handle
// hazard, still a ctrl path -- the inject carries the reserve). This JS export
// is retained as the observation seam for the wire-serial-regression test, which
// pins that the internal flush commits prior wire traffic.
napi_value WireBytesQueued(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "wireBytesQueued: bad clientId");
    napi_value out;
    napi_create_bigint_uint64(env, c->wireBytesQueued(), &out);
    return out;
}

// writeBeginAccess(clientId, surfaceBufId) / writeEndAccess(clientId, surfaceBufId):
// in-band producer Begin/End on the plugin wire. Synchronous frame writes (the
// FIFO wire ordering replaces the prior ctrl ProducerBegin round-trip / the
// ProducerEnd WireBarrier deferral). The Worker writes Begin as it claims a
// slot and End after its render submit.
napi_value WriteBeginAccess(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "writeBeginAccess: bad clientId");
    c->writeBeginAccess(u32(env, argv[1]));
    return nullptr;
}
napi_value WriteEndAccess(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "writeEndAccess: bad clientId");
    c->writeEndAccess(u32(env, argv[1]));
    return nullptr;
}

// Phase 5b: reserveConsumerTexture(clientId, surfaceBufId, w, h) -> same shape
// as ReserveProducerTexture. The plugin is the CONSUMER for a compose buffer.
napi_value ReserveConsumerTexture(napi_env env, napi_callback_info info) {
    size_t argc = 4; napi_value argv[4];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "reserveConsumerTexture: bad clientId");
    auto r = c->reserveConsumerTexture(u32(env, argv[1]), u32(env, argv[2]), u32(env, argv[3]));
    if (!r.ok) return throwErr(env, "reserveConsumerTexture: failed");
    napi_value o, ws;
    napi_create_object(env, &o);
    napi_set_named_property(env, o, "texture", handleObj(env, r.texture));
    napi_set_named_property(env, o, "device", handleObj(env, r.device));
    napi_create_bigint_uint64(env, r.wireSerial, &ws);
    napi_set_named_property(env, o, "wireSerial", ws);
    return o;
}

napi_value ConsumerTexture(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "consumerTexture: bad clientId");
    napi_value out;
    napi_create_bigint_uint64(env,
        reinterpret_cast<uint64_t>(c->consumerTexture(u32(env, argv[1]))), &out);
    return out;
}

napi_value ForgetConsumerReservation(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "forgetConsumerReservation: bad clientId");
    c->forgetConsumerReservation(u32(env, argv[1]));
    return nullptr;
}

// Phase 5b: in-band consumer Begin/End on the plugin wire (compose buffers
// where the plugin is the consumer). Inverted from sdk.gpu overlay surfaces
// where the plugin is the producer.
napi_value WriteConsumerBegin(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "writeConsumerBegin: bad clientId");
    c->writeConsumerBeginAccess(u32(env, argv[1]));
    return nullptr;
}
napi_value WriteConsumerEnd(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto* c = self(env)->get(u32(env, argv[0]));
    if (!c) return throwErr(env, "writeConsumerEnd: bad clientId");
    c->writeConsumerEndAccess(u32(env, argv[1]));
    return nullptr;
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
    reg("forgetProducerReservation", ForgetProducerReservation);
    reg("producerTexture", ProducerTexture);
    reg("reserveConsumerTexture", ReserveConsumerTexture);
    reg("forgetConsumerReservation", ForgetConsumerReservation);
    reg("consumerTexture", ConsumerTexture);
    reg("flush", Flush);
    reg("wireBytesQueued", WireBytesQueued);
    reg("writeBeginAccess", WriteBeginAccess);
    reg("writeEndAccess", WriteEndAccess);
    reg("writeConsumerBegin", WriteConsumerBegin);
    reg("writeConsumerEnd", WriteConsumerEnd);
    return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
