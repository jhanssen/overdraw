// overdraw core N-API addon (Node-hosted C++).
//
// The core is "C++ + Node": Node owns main()/the event loop and loads this
// addon, which holds the native side (GPU-process spawn, Dawn wire client, side
// channel, compositing). Bring-up (handshake, device/surface, dmabuf interop
// brackets, pipeline) runs blocking inside start() -- it is one-shot and brief.
// The steady-state present loop is driven by libuv: a uv_poll_t on the wire fd
// drains server->client wire traffic, and a uv_timer_t paces frames. This is
// the architectural claim under test: Node's libuv loop drives presentation
// without a hand-rolled C++ spin loop.
//
// Raw node_api.h (C API) is used deliberately: node-addon-api is exception/RTTI
// based and the project builds -fno-rtti to match Dawn.

#include <node_api.h>
#include <uv.h>

#include <cstdio>
#include <cstring>
#include <vector>

#include <fcntl.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include "dawn/wire/WireClient.h"
#include "dawn/dawn_proc.h"
#include "dawn/webgpu_cpp.h"

#include "side_channel.h"
#include "transport.h"

using namespace overdraw;

namespace {

constexpr uint32_t kDmaSize = 256;

const char* kWgsl = R"(
struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};
@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  var p = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f(1.0,  1.0));
  var uv = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0));
  var o : VsOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = uv[i];
  return o;
}
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var tex : texture_2d<f32>;
@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv);
}
)";

// Process-wide core state (one core per process; addon loaded once on the Node
// main thread). Owns the wire client, the persistent wgpu objects, and the
// libuv handles that drive the present loop.
struct Core {
    pid_t gpu = -1;
    int wireFd = -1;
    int ctrlFd = -1;
    ipc::FdSerializer* serializer = nullptr;
    dawn::wire::WireClient* client = nullptr;

    wgpu::Instance instance;
    wgpu::Device device;
    wgpu::Surface surface;
    wgpu::Texture dmaTexture;
    wgpu::RenderPipeline pipeline;
    wgpu::BindGroup bindGroup;

    uint32_t windowWidth = 0;
    uint32_t windowHeight = 0;
    bool readBracketHeld = false;

    uv_poll_t wirePoll{};
    uv_timer_t frameTimer{};
    bool loopRunning = false;
    uint64_t presented = 0;
};
Core g_core;

pid_t spawnGpuProcess(const char* binPath, int wireFd, int ctrlFd) {
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        ::fcntl(wireFd, F_SETFD, 0);
        ::fcntl(ctrlFd, F_SETFD, 0);
        char a1[16], a2[16];
        std::snprintf(a1, sizeof(a1), "%d", wireFd);
        std::snprintf(a2, sizeof(a2), "%d", ctrlFd);
        ::execl(binPath, binPath, a1, a2, static_cast<char*>(nullptr));
        _exit(127);
    }
    return pid;
}

napi_value throwError(napi_env env, const char* msg) {
    napi_throw_error(env, nullptr, msg);
    return nullptr;
}

// Pump the wire (flush outbound, drain one inbound frame, process events) until
// `done()` returns true or a bound is hit. Used only during one-shot bring-up.
template <typename Fn>
bool pumpUntil(Fn done) {
    std::vector<uint8_t> f;
    for (int i = 0; i < 1000000; ++i) {
        if (done()) return true;
        g_core.serializer->Flush();
        if (ipc::readWireFrame(g_core.wireFd, f))
            g_core.client->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
        wgpuInstanceProcessEvents(g_core.instance.Get());
        ::usleep(200);
    }
    return done();
}

bool sendAndWait(const ipc::Message& rq, ipc::Tag replyTag, ipc::Message& reply) {
    ipc::sendMessage(g_core.ctrlFd, rq);
    std::vector<uint8_t> f;
    for (int i = 0; i < 1000000; ++i) {
        g_core.serializer->Flush();
        if (ipc::readWireFrame(g_core.wireFd, f))
            g_core.client->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
        wgpuInstanceProcessEvents(g_core.instance.Get());
        ipc::Message m{};
        if (ipc::recvMessageNB(g_core.ctrlFd, m) && m.tag == replyTag) { reply = m; return true; }
        ::usleep(200);
    }
    return false;
}

// Render one frame: draw the textured quad sampling the dmabuf texture into the
// swapchain, present. Called from the libuv frame timer.
void renderFrame() {
    wgpu::SurfaceTexture st{};
    g_core.surface.GetCurrentTexture(&st);
    if (st.texture) {
        wgpu::RenderPassColorAttachment ca{};
        ca.view = st.texture.CreateView();
        ca.loadOp = wgpu::LoadOp::Clear;
        ca.storeOp = wgpu::StoreOp::Store;
        ca.clearValue = {0.0, 0.0, 0.0, 1.0};
        wgpu::RenderPassDescriptor rp{};
        rp.colorAttachmentCount = 1;
        rp.colorAttachments = &ca;
        wgpu::CommandEncoder enc = g_core.device.CreateCommandEncoder();
        wgpu::RenderPassEncoder pass = enc.BeginRenderPass(&rp);
        pass.SetPipeline(g_core.pipeline);
        pass.SetBindGroup(0, g_core.bindGroup);
        pass.Draw(4);
        pass.End();
        wgpu::CommandBuffer cb = enc.Finish();
        g_core.device.GetQueue().Submit(1, &cb);
        g_core.surface.Present();
        g_core.presented++;
    }
    g_core.serializer->Flush();
}

// libuv: wire fd readable -> drain inbound wire frames + process events.
void onWireReadable(uv_poll_t*, int status, int) {
    if (status < 0) return;
    std::vector<uint8_t> f;
    // Drain all currently-available frames (readWireFrame is non-blocking).
    for (int i = 0; i < 64 && ipc::readWireFrame(g_core.wireFd, f); ++i)
        g_core.client->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
    wgpuInstanceProcessEvents(g_core.instance.Get());
}

// libuv: frame timer -> render + present.
void onFrameTimer(uv_timer_t*) {
    renderFrame();
    wgpuInstanceProcessEvents(g_core.instance.Get());
}

// Blocking bring-up: handshake done in start() before this. Brings up adapter,
// device, surface, the dmabuf interop brackets, and the compositing pipeline.
// Returns nullptr-equivalent via the bool; sets error message.
bool bringUp(const char*& err) {
    // Reserve instance; tell the GPU process to inject the native instance.
    auto ri = g_core.client->ReserveInstance();
    {
        ipc::Message m{};
        m.tag = ipc::Tag::InstanceReserved;
        m.instance = {ri.handle.id, ri.handle.generation};
        ipc::sendMessage(g_core.ctrlFd, m);
    }
    g_core.instance = wgpu::Instance::Acquire(ri.instance);

    // Adapter over the wire.
    wgpu::Adapter adapter;
    {
        wgpu::RequestAdapterOptions ao{};
        ao.featureLevel = wgpu::FeatureLevel::Core;
        bool ready = false;
        g_core.instance.RequestAdapter(&ao, wgpu::CallbackMode::AllowProcessEvents,
            [&](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView) {
                if (s == wgpu::RequestAdapterStatus::Success) adapter = std::move(a);
                ready = true;
            });
        g_core.serializer->Flush();
        pumpUntil([&] { return ready; });
    }
    if (!adapter) { err = "no adapter over wire"; return false; }

    // Device with dmabuf + sync-fd features.
    {
        wgpu::FeatureName feats[] = {wgpu::FeatureName::SharedTextureMemoryDmaBuf,
                                     wgpu::FeatureName::SharedFenceSyncFD};
        wgpu::DeviceDescriptor dd{};
        dd.requiredFeatureCount = 2;
        dd.requiredFeatures = feats;
        dd.SetUncapturedErrorCallback(
            [](const wgpu::Device&, wgpu::ErrorType t, wgpu::StringView m) {
                std::fprintf(stderr, "[core][dawn err %d] %.*s\n", (int)t, (int)m.length, m.data);
            });
        bool ready = false;
        adapter.RequestDevice(&dd, wgpu::CallbackMode::AllowProcessEvents,
            [&](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView) {
                if (s == wgpu::RequestDeviceStatus::Success) g_core.device = std::move(d);
                ready = true;
            });
        g_core.serializer->Flush();
        pumpUntil([&] { return ready; });
    }
    if (!g_core.device) { err = "no device over wire"; return false; }

    // Reserve surface; send DeviceReady; wait SurfaceReady.
    WGPUSurfaceCapabilities emptyCaps{};
    auto rs = g_core.client->ReserveSurface(g_core.instance.Get(), &emptyCaps);
    {
        ipc::Message m{};
        m.tag = ipc::Tag::DeviceReady;
        m.instance = {ri.handle.id, ri.handle.generation};
        auto dh = g_core.client->GetWireHandle(g_core.device.Get());
        m.device = {dh.id, dh.generation};
        m.surface = {rs.handle.id, rs.handle.generation};
        ipc::sendMessage(g_core.ctrlFd, m);
    }
    ipc::Message surfReady{};
    {
        bool got = false;
        std::vector<uint8_t> f;
        for (int i = 0; i < 1000000 && !got; ++i) {
            g_core.serializer->Flush();
            if (ipc::readWireFrame(g_core.wireFd, f))
                g_core.client->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
            wgpuInstanceProcessEvents(g_core.instance.Get());
            ipc::Message m{};
            if (ipc::recvMessageNB(g_core.ctrlFd, m) && m.tag == ipc::Tag::SurfaceReady) {
                surfReady = m; got = true;
            }
            ::usleep(200);
        }
        if (!got) { err = "no SurfaceReady"; return false; }
    }

    // Reserve a dmabuf-backed texture; GPU process allocates + injects it.
    wgpu::TextureDescriptor dmaTexDesc{};
    dmaTexDesc.size = {kDmaSize, kDmaSize, 1};
    dmaTexDesc.format = wgpu::TextureFormat::BGRA8Unorm;
    dmaTexDesc.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
    auto rt = g_core.client->ReserveTexture(
        g_core.device.Get(), reinterpret_cast<const WGPUTextureDescriptor*>(&dmaTexDesc));
    {
        ipc::Message m{};
        m.tag = ipc::Tag::ReserveTex;
        m.device = {rt.deviceHandle.id, rt.deviceHandle.generation};
        m.texture = {rt.handle.id, rt.handle.generation};
        m.format = static_cast<uint32_t>(wgpu::TextureFormat::BGRA8Unorm);
        m.width = kDmaSize;
        m.height = kDmaSize;
        ipc::sendMessage(g_core.ctrlFd, m);
    }
    g_core.dmaTexture = wgpu::Texture::Acquire(rt.texture);
    {
        bool got = false;
        std::vector<uint8_t> f;
        for (int i = 0; i < 1000000 && !got; ++i) {
            g_core.serializer->Flush();
            if (ipc::readWireFrame(g_core.wireFd, f))
                g_core.client->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
            wgpuInstanceProcessEvents(g_core.instance.Get());
            ipc::Message m{};
            if (ipc::recvMessageNB(g_core.ctrlFd, m) && m.tag == ipc::Tag::TexInjected) got = true;
            ::usleep(200);
        }
        if (!got) { err = "no TexInjected"; return false; }
    }

    // Configure swapchain.
    g_core.surface = wgpu::Surface::Acquire(rs.surface);
    {
        wgpu::SurfaceConfiguration cfg{};
        cfg.device = g_core.device;
        cfg.format = static_cast<wgpu::TextureFormat>(surfReady.format);
        cfg.usage = wgpu::TextureUsage::RenderAttachment;
        cfg.width = surfReady.width;
        cfg.height = surfReady.height;
        cfg.alphaMode = static_cast<wgpu::CompositeAlphaMode>(surfReady.alphaMode);
        cfg.presentMode = static_cast<wgpu::PresentMode>(surfReady.presentMode);
        g_core.surface.Configure(&cfg);
        g_core.serializer->Flush();
    }

    // dmabuf write bracket: render green into it.
    {
        ipc::Message begin{}; begin.tag = ipc::Tag::BeginAccess; begin.initialized = 0;
        ipc::Message reply{};
        if (!sendAndWait(begin, ipc::Tag::BeginDone, reply)) { err = "no BeginDone (write)"; return false; }
        wgpu::RenderPassColorAttachment ca{};
        ca.view = g_core.dmaTexture.CreateView();
        ca.loadOp = wgpu::LoadOp::Clear;
        ca.storeOp = wgpu::StoreOp::Store;
        ca.clearValue = {0.05, 0.8, 0.1, 1.0};  // green
        wgpu::RenderPassDescriptor rp{};
        rp.colorAttachmentCount = 1;
        rp.colorAttachments = &ca;
        wgpu::CommandEncoder enc = g_core.device.CreateCommandEncoder();
        enc.BeginRenderPass(&rp).End();
        wgpu::CommandBuffer cb = enc.Finish();
        g_core.device.GetQueue().Submit(1, &cb);
        g_core.serializer->Flush();
        ipc::Message end{}; end.tag = ipc::Tag::EndAccess;
        if (!sendAndWait(end, ipc::Tag::EndDone, reply)) { err = "no EndDone (write)"; return false; }
        // Read bracket: hold open across the present loop.
        begin.initialized = 1;
        begin.oldLayout = reply.endLayout;
        if (!sendAndWait(begin, ipc::Tag::BeginDone, reply)) { err = "no BeginDone (read)"; return false; }
        g_core.readBracketHeld = true;
    }

    // Compositing pipeline.
    wgpu::Sampler sampler;
    {
        wgpu::SamplerDescriptor sd{};
        sd.magFilter = wgpu::FilterMode::Nearest;
        sd.minFilter = wgpu::FilterMode::Nearest;
        sampler = g_core.device.CreateSampler(&sd);
    }
    {
        wgpu::ShaderSourceWGSL wgslDesc{};
        wgslDesc.code = kWgsl;
        wgpu::ShaderModuleDescriptor smd{};
        smd.nextInChain = &wgslDesc;
        wgpu::ShaderModule module = g_core.device.CreateShaderModule(&smd);

        wgpu::ColorTargetState target{};
        target.format = static_cast<wgpu::TextureFormat>(surfReady.format);
        wgpu::FragmentState fs{};
        fs.module = module;
        fs.entryPoint = "fs";
        fs.targetCount = 1;
        fs.targets = &target;

        wgpu::RenderPipelineDescriptor pd{};
        pd.vertex.module = module;
        pd.vertex.entryPoint = "vs";
        pd.primitive.topology = wgpu::PrimitiveTopology::TriangleStrip;
        pd.fragment = &fs;
        g_core.pipeline = g_core.device.CreateRenderPipeline(&pd);

        wgpu::BindGroupEntry entries[2]{};
        entries[0].binding = 0;
        entries[0].sampler = sampler;
        entries[1].binding = 1;
        entries[1].textureView = g_core.dmaTexture.CreateView();
        wgpu::BindGroupDescriptor bgd{};
        bgd.layout = g_core.pipeline.GetBindGroupLayout(0);
        bgd.entryCount = 2;
        bgd.entries = entries;
        g_core.bindGroup = g_core.device.CreateBindGroup(&bgd);
    }
    g_core.serializer->Flush();
    return true;
}

// start(gpuBinPath) -> { width, height } : spawn, handshake, bring-up, then
// start the libuv-driven present loop.
napi_value Start(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "start(gpuBinPath) requires a path");

    char gpuBin[4096];
    size_t len = 0;
    if (napi_get_value_string_utf8(env, argv[0], gpuBin, sizeof(gpuBin), &len) != napi_ok)
        return throwError(env, "gpuBinPath must be a string");

    int wireFds[2], ctrlFds[2];
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, wireFds) ||
        ::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, ctrlFds))
        return throwError(env, "socketpair failed");

    pid_t gpu = spawnGpuProcess(gpuBin, wireFds[1], ctrlFds[1]);
    if (gpu < 0) return throwError(env, "fork/exec gpu process failed");
    ::close(wireFds[1]);
    ::close(ctrlFds[1]);
    g_core.gpu = gpu;
    g_core.wireFd = wireFds[0];
    g_core.ctrlFd = ctrlFds[0];

    dawnProcSetProcs(&dawn::wire::client::GetProcs());
    g_core.serializer = new ipc::FdSerializer(g_core.wireFd);
    dawn::wire::WireClientDescriptor wcd{};
    wcd.serializer = g_core.serializer;
    g_core.client = new dawn::wire::WireClient(wcd);

    // Hello handshake.
    {
        ipc::Message hello{};
        hello.tag = ipc::Tag::Hello;
        hello.protocolVersion = ipc::kProtocolVersion;
        ipc::sendMessage(g_core.ctrlFd, hello);
        ::fcntl(g_core.ctrlFd, F_SETFL, O_NONBLOCK);
        bool got = false;
        ipc::Message m{};
        for (int i = 0; i < 500000 && !got; ++i) {
            if (ipc::recvMessageNB(g_core.ctrlFd, m) && m.tag == ipc::Tag::HelloReply) got = true;
            else ::usleep(200);
        }
        if (!got) return throwError(env, "no HelloReply from gpu process");
        g_core.windowWidth = m.width;
        g_core.windowHeight = m.height;
    }

    const char* err = nullptr;
    if (!bringUp(err)) return throwError(env, err ? err : "bring-up failed");

    // Start libuv-driven steady state: poll the wire fd, pace frames.
    uv_loop_t* loop = nullptr;
    napi_get_uv_event_loop(env, &loop);
    uv_poll_init(loop, &g_core.wirePoll, g_core.wireFd);
    uv_poll_start(&g_core.wirePoll, UV_READABLE, onWireReadable);
    uv_timer_init(loop, &g_core.frameTimer);
    uv_timer_start(&g_core.frameTimer, onFrameTimer, 0, 16);  // ~60Hz
    g_core.loopRunning = true;

    napi_value result, w, h;
    napi_create_object(env, &result);
    napi_create_uint32(env, g_core.windowWidth, &w);
    napi_create_uint32(env, g_core.windowHeight, &h);
    napi_set_named_property(env, result, "width", w);
    napi_set_named_property(env, result, "height", h);
    return result;
}

// presentedCount() -> number : frames presented so far (for the JS harness).
napi_value PresentedCount(napi_env env, napi_callback_info) {
    napi_value n;
    napi_create_uint32(env, static_cast<uint32_t>(g_core.presented), &n);
    return n;
}

// stop() -> undefined : stop the libuv handles, close the read bracket, tear
// down the GPU process. Idempotent enough for the harness.
napi_value Stop(napi_env env, napi_callback_info) {
    if (g_core.loopRunning) {
        uv_timer_stop(&g_core.frameTimer);
        uv_poll_stop(&g_core.wirePoll);
        uv_close(reinterpret_cast<uv_handle_t*>(&g_core.frameTimer), nullptr);
        uv_close(reinterpret_cast<uv_handle_t*>(&g_core.wirePoll), nullptr);
        g_core.loopRunning = false;
    }
    if (g_core.readBracketHeld) {
        ipc::Message end{}; end.tag = ipc::Tag::EndAccess;
        ipc::Message reply{};
        sendAndWait(end, ipc::Tag::EndDone, reply);
        g_core.readBracketHeld = false;
    }
    if (g_core.ctrlFd >= 0) {
        ipc::Message m{}; m.tag = ipc::Tag::Shutdown;
        ipc::sendMessage(g_core.ctrlFd, m);
        if (g_core.serializer) g_core.serializer->Flush();
    }
    // Drop wgpu objects before disconnecting the wire.
    g_core.bindGroup = nullptr;
    g_core.pipeline = nullptr;
    g_core.dmaTexture = nullptr;
    g_core.surface = nullptr;
    g_core.device = nullptr;
    g_core.instance = nullptr;
    if (g_core.client) g_core.client->Disconnect();
    if (g_core.wireFd >= 0) ::close(g_core.wireFd);
    if (g_core.ctrlFd >= 0) ::close(g_core.ctrlFd);
    if (g_core.gpu > 0) {
        int status = 0;
        bool reaped = false;
        for (int i = 0; i < 500; ++i) {
            if (::waitpid(g_core.gpu, &status, WNOHANG) == g_core.gpu) { reaped = true; break; }
            ::usleep(1000);
        }
        if (!reaped) { ::kill(g_core.gpu, SIGTERM); ::waitpid(g_core.gpu, &status, 0); }
    }
    delete g_core.client; g_core.client = nullptr;
    delete g_core.serializer; g_core.serializer = nullptr;
    g_core.gpu = -1; g_core.wireFd = -1; g_core.ctrlFd = -1;

    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

napi_value Init(napi_env env, napi_value exports) {
    napi_value fnStart, fnStop, fnPresented;
    napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, nullptr, &fnStart);
    napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Stop, nullptr, &fnStop);
    napi_create_function(env, "presentedCount", NAPI_AUTO_LENGTH, PresentedCount, nullptr, &fnPresented);
    napi_set_named_property(env, exports, "start", fnStart);
    napi_set_named_property(env, exports, "stop", fnStop);
    napi_set_named_property(env, exports, "presentedCount", fnPresented);
    return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
