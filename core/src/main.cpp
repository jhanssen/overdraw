// overdraw core (phase 1 nested mode, pure C++ stage).
//
// Spawns the GPU process and drives the compositing swapchain over the Dawn
// wire: requests adapter+device, reserves a surface (the GPU process injects
// the real Wayland-backed surface), and validates the dmabuf interop path —
// reserve a texture, have the GPU process allocate a GBM dmabuf and inject it
// as SharedTextureMemory, render into it over the wire under a BeginAccess/
// EndAccess bracket, then sample it onto a full-surface quad each tick.
//
// This is a single-device validation harness, not the final per-surface frame
// loop. No Wayland server, protocols, plugins, or two-device sharing yet. The
// Node/N-API wrapping comes later; this stage is a plain executable.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include <fcntl.h>
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

constexpr int kFrames = 240;  // bounded run so the slice self-terminates

// Spawn the GPU process, handing it the wire + side-channel socket fds.
pid_t spawnGpuProcess(const char* binPath, int wireFd, int ctrlFd) {
    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return -1; }
    if (pid == 0) {
        // Child: keep the GPU-side fds open across exec.
        ::fcntl(wireFd, F_SETFD, 0);
        ::fcntl(ctrlFd, F_SETFD, 0);
        char a1[16], a2[16];
        std::snprintf(a1, sizeof(a1), "%d", wireFd);
        std::snprintf(a2, sizeof(a2), "%d", ctrlFd);
        ::execl(binPath, binPath, a1, a2, static_cast<char*>(nullptr));
        perror("execl");
        _exit(127);
    }
    return pid;
}

int run(const char* gpuBin) {
    int wireFds[2], ctrlFds[2];
    // Wire socket: STREAM (length-prefixed framing handles boundaries).
    // Side channel: SEQPACKET so fixed-size Message structs keep their datagram
    // boundaries (STREAM coalesces/splits, desyncing the unframed control
    // protocol once traffic increases) while still supporting SCM_RIGHTS.
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, wireFds) ||
        ::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, ctrlFds)) {
        perror("socketpair");
        return 1;
    }

    pid_t gpu = spawnGpuProcess(gpuBin, wireFds[1], ctrlFds[1]);
    if (gpu < 0) return 1;
    // Parent keeps the core-side fds; close the GPU-side ends.
    ::close(wireFds[1]);
    ::close(ctrlFds[1]);
    int wireFd = wireFds[0];
    int ctrlFd = ctrlFds[0];

    // Wire client.
    dawnProcSetProcs(&dawn::wire::client::GetProcs());
    ipc::FdSerializer serializer(wireFd);
    dawn::wire::WireClientDescriptor wcd{};
    wcd.serializer = &serializer;
    dawn::wire::WireClient client(wcd);

    // Handshake: Hello -> HelloReply.
    {
        ipc::Message hello{};
        hello.tag = ipc::Tag::Hello;
        hello.protocolVersion = ipc::kProtocolVersion;
        ipc::sendMessage(ctrlFd, hello);
        ::fcntl(ctrlFd, F_SETFL, O_NONBLOCK);
        bool got = false;
        ipc::Message m{};
        for (int i = 0; i < 500000 && !got; ++i) {
            if (ipc::recvMessageNB(ctrlFd, m) && m.tag == ipc::Tag::HelloReply) got = true;
            else ::usleep(200);
        }
        if (!got) { std::fprintf(stderr, "[core] no HelloReply\n"); return 1; }
        std::printf("[core] gpu protocol v%u, window %ux%u\n",
                    m.protocolVersion, m.width, m.height);
    }

    // Reserve instance; tell the GPU process to inject the native instance there.
    auto ri = client.ReserveInstance();
    {
        ipc::Message m{};
        m.tag = ipc::Tag::InstanceReserved;
        m.instance = {ri.handle.id, ri.handle.generation};
        ipc::sendMessage(ctrlFd, m);
    }
    wgpu::Instance inst = wgpu::Instance::Acquire(ri.instance);
    std::printf("[core] reserved instance {%u,%u}\n", ri.handle.id, ri.handle.generation);

    auto pump = [&](auto&& done) {
        std::vector<uint8_t> f;
        for (int i = 0; i < 500000 && !done(); ++i) {
            serializer.Flush();
            if (ipc::readWireFrame(wireFd, f))
                client.HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
            wgpuInstanceProcessEvents(inst.Get());
            ::usleep(200);
        }
    };

    // Send a side-channel request and block (pumping the wire) until the given
    // reply tag arrives. Returns the reply, or {} on timeout. Used for the
    // BeginAccess/EndAccess bracket around the dmabuf wire render.
    auto sendAndWait = [&](const ipc::Message& rq, ipc::Tag replyTag, ipc::Message& reply) -> bool {
        ipc::sendMessage(ctrlFd, rq);
        std::vector<uint8_t> f;
        for (int i = 0; i < 1000000; ++i) {
            serializer.Flush();
            if (ipc::readWireFrame(wireFd, f))
                client.HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
            wgpuInstanceProcessEvents(inst.Get());
            ipc::Message m{};
            if (ipc::recvMessageNB(ctrlFd, m) && m.tag == replyTag) { reply = m; return true; }
            ::usleep(200);
        }
        return false;
    };

    // Adapter over the wire.
    wgpu::Adapter adapter;
    {
        wgpu::RequestAdapterOptions ao{};
        ao.featureLevel = wgpu::FeatureLevel::Core;
        bool ready = false;
        inst.RequestAdapter(&ao, wgpu::CallbackMode::AllowProcessEvents,
            [&](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView m) {
                if (s == wgpu::RequestAdapterStatus::Success) adapter = std::move(a);
                else std::fprintf(stderr, "[core] adapter fail: %.*s\n", (int)m.length, m.data);
                ready = true;
            });
        serializer.Flush();
        pump([&] { return ready; });
    }
    if (!adapter) { std::fprintf(stderr, "[core] no adapter\n"); return 1; }
    std::printf("[core] got adapter over wire\n");

    // Device over the wire. Require SharedTextureMemoryDmaBuf so the server-
    // resolved device can import dmabuf-backed textures (exposed over the wire).
    std::printf("[core] adapter SharedTextureMemoryDmaBuf over wire: %d\n",
                adapter.HasFeature(wgpu::FeatureName::SharedTextureMemoryDmaBuf) ? 1 : 0);
    wgpu::Device device;
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
            [&](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView m) {
                if (s == wgpu::RequestDeviceStatus::Success) device = std::move(d);
                else std::fprintf(stderr, "[core] device fail: %.*s\n", (int)m.length, m.data);
                ready = true;
            });
        serializer.Flush();
        pump([&] { return ready; });
    }
    if (!device) { std::fprintf(stderr, "[core] no device\n"); return 1; }
    std::printf("[core] got device over wire\n");

    // Reserve a surface handle (caps come from the GPU process in SurfaceReady).
    WGPUSurfaceCapabilities emptyCaps{};
    auto rs = client.ReserveSurface(inst.Get(), &emptyCaps);
    {
        ipc::Message m{};
        m.tag = ipc::Tag::DeviceReady;
        m.instance = {ri.handle.id, ri.handle.generation};
        auto dh = client.GetWireHandle(device.Get());
        m.device = {dh.id, dh.generation};
        m.surface = {rs.handle.id, rs.handle.generation};
        ipc::sendMessage(ctrlFd, m);
    }
    std::printf("[core] reserved surface {%u,%u}\n", rs.handle.id, rs.handle.generation);

    // Wait for SurfaceReady (surface injected + caps).
    ipc::Message surfReady{};
    {
        bool got = false;
        std::vector<uint8_t> f;
        for (int i = 0; i < 1000000 && !got; ++i) {
            serializer.Flush();
            if (ipc::readWireFrame(wireFd, f))
                client.HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
            wgpuInstanceProcessEvents(inst.Get());
            ipc::Message m{};
            if (ipc::recvMessageNB(ctrlFd, m) && m.tag == ipc::Tag::SurfaceReady) {
                surfReady = m;
                got = true;
            }
            ::usleep(200);
        }
        if (!got) { std::fprintf(stderr, "[core] no SurfaceReady\n"); return 1; }
    }
    std::printf("[core] surface ready: format=%u %ux%u\n",
                surfReady.format, surfReady.width, surfReady.height);

    // B3: reserve a texture handle and have the GPU process allocate a dmabuf,
    // import it as SharedTextureMemory on this device, and InjectTexture at the
    // reserved handle. The reserved descriptor must match the injected texture's
    // actual properties (BGRA8, size, usage). Rendering into it comes in B4/B5.
    constexpr uint32_t kDmaSize = 256;
    wgpu::TextureDescriptor dmaTexDesc{};
    dmaTexDesc.size = {kDmaSize, kDmaSize, 1};
    dmaTexDesc.format = wgpu::TextureFormat::BGRA8Unorm;
    dmaTexDesc.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
    auto rt = client.ReserveTexture(
        device.Get(), reinterpret_cast<const WGPUTextureDescriptor*>(&dmaTexDesc));
    {
        ipc::Message m{};
        m.tag = ipc::Tag::ReserveTex;
        m.device = {rt.deviceHandle.id, rt.deviceHandle.generation};
        m.texture = {rt.handle.id, rt.handle.generation};
        m.format = static_cast<uint32_t>(wgpu::TextureFormat::BGRA8Unorm);
        m.width = kDmaSize;
        m.height = kDmaSize;
        ipc::sendMessage(ctrlFd, m);
    }
    std::printf("[core] reserved texture {%u,%u} on device {%u,%u}\n",
                rt.handle.id, rt.handle.generation,
                rt.deviceHandle.id, rt.deviceHandle.generation);
    wgpu::Texture dmaTexture = wgpu::Texture::Acquire(rt.texture);

    // Wait for the GPU process to import + inject (TexInjected).
    {
        bool got = false;
        std::vector<uint8_t> f;
        for (int i = 0; i < 1000000 && !got; ++i) {
            serializer.Flush();
            if (ipc::readWireFrame(wireFd, f))
                client.HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
            wgpuInstanceProcessEvents(inst.Get());
            ipc::Message m{};
            if (ipc::recvMessageNB(ctrlFd, m) && m.tag == ipc::Tag::TexInjected) got = true;
            ::usleep(200);
        }
        if (!got) { std::fprintf(stderr, "[core] no TexInjected\n"); return 1; }
    }
    std::printf("[core] dmabuf texture injected and resolved\n");

    // Configure the swapchain over the wire.
    wgpu::Surface surface = wgpu::Surface::Acquire(rs.surface);
    {
        wgpu::SurfaceConfiguration cfg{};
        cfg.device = device;
        cfg.format = static_cast<wgpu::TextureFormat>(surfReady.format);
        cfg.usage = wgpu::TextureUsage::RenderAttachment;
        cfg.width = surfReady.width;
        cfg.height = surfReady.height;
        cfg.alphaMode = static_cast<wgpu::CompositeAlphaMode>(surfReady.alphaMode);
        cfg.presentMode = static_cast<wgpu::PresentMode>(surfReady.presentMode);
        surface.Configure(&cfg);
        serializer.Flush();
    }
    std::printf("[core] swapchain configured\n");

    // B4/B5: render into the dmabuf-backed texture over the wire, bracketed by
    // server-side BeginAccess/EndAccess, then sample it onto the swapchain quad.
    // A SharedTextureMemory texture may only be used (write OR read) while access
    // is held, so there are two brackets: a write bracket around the green render,
    // then a read bracket held open across the whole frame loop (closed after it).
    // If the window shows the colour rendered HERE (green), the dmabuf round-
    // trip is proven end-to-end.
    {
        ipc::Message begin{};
        begin.tag = ipc::Tag::BeginAccess;
        begin.initialized = 0;  // first access: contents undefined
        ipc::Message reply{};
        if (!sendAndWait(begin, ipc::Tag::BeginDone, reply)) {
            std::fprintf(stderr, "[core] no BeginDone (write)\n"); return 1;
        }
        // Wire render pass: clear the dmabuf texture to green.
        wgpu::RenderPassColorAttachment ca{};
        ca.view = dmaTexture.CreateView();
        ca.loadOp = wgpu::LoadOp::Clear;
        ca.storeOp = wgpu::StoreOp::Store;
        ca.clearValue = {0.05, 0.8, 0.1, 1.0};  // green
        wgpu::RenderPassDescriptor rp{};
        rp.colorAttachmentCount = 1;
        rp.colorAttachments = &ca;
        wgpu::CommandEncoder enc = device.CreateCommandEncoder();
        enc.BeginRenderPass(&rp).End();
        wgpu::CommandBuffer cb = enc.Finish();
        device.GetQueue().Submit(1, &cb);
        serializer.Flush();
        // The submit is flushed and ordered ahead of EndAccess on the socket;
        // sendAndWait pumps the wire so the server drains it before EndAccess.
        ipc::Message end{};
        end.tag = ipc::Tag::EndAccess;
        if (!sendAndWait(end, ipc::Tag::EndDone, reply)) {
            std::fprintf(stderr, "[core] no EndDone (write)\n"); return 1;
        }
        std::printf("[core] dmabuf write bracket done; EndAccess fenceCount=%u endLayout=%d\n",
                    reply.fenceCount, reply.endLayout);

        // Read bracket: contents now valid; begin from the layout the write
        // EndAccess reported. Hold access open for the frame loop.
        begin.initialized = 1;
        begin.oldLayout = reply.endLayout;
        if (!sendAndWait(begin, ipc::Tag::BeginDone, reply)) {
            std::fprintf(stderr, "[core] no BeginDone (read)\n"); return 1;
        }
        std::printf("[core] dmabuf read access held for compositing\n");
    }

    // Compositing pass: sample the dmabuf-backed texture onto a full-surface
    // quad. Exercises the textured-quad pipeline (shaders, sampler, bind group),
    // the design's per-surface compositing primitive.
    wgpu::Sampler sampler;
    {
        wgpu::SamplerDescriptor sd{};
        sd.magFilter = wgpu::FilterMode::Nearest;
        sd.minFilter = wgpu::FilterMode::Nearest;
        sampler = device.CreateSampler(&sd);
    }

    // Full-surface quad emitted from vertex_index (no vertex buffer).
    static const char* kWgsl = R"(
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

    wgpu::RenderPipeline pipeline;
    wgpu::BindGroup bindGroup;
    {
        wgpu::ShaderSourceWGSL wgslDesc{};
        wgslDesc.code = kWgsl;
        wgpu::ShaderModuleDescriptor smd{};
        smd.nextInChain = &wgslDesc;
        wgpu::ShaderModule module = device.CreateShaderModule(&smd);

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
        pipeline = device.CreateRenderPipeline(&pd);

        wgpu::BindGroupEntry entries[2]{};
        entries[0].binding = 0;
        entries[0].sampler = sampler;
        entries[1].binding = 1;
        // B5: sample the dmabuf-backed texture the client rendered green into,
        // proving the round-trip is visible.
        entries[1].textureView = dmaTexture.CreateView();
        wgpu::BindGroupDescriptor bgd{};
        bgd.layout = pipeline.GetBindGroupLayout(0);
        bgd.entryCount = 2;
        bgd.entries = entries;
        bindGroup = device.CreateBindGroup(&bgd);
    }
    serializer.Flush();
    std::printf("[core] compositing pipeline ready; presenting textured quad\n");

    // Frame loop: draw the textured quad, present, over the wire.
    int presented = 0;
    for (int frame = 0; frame < kFrames; ++frame) {
        wgpu::SurfaceTexture st{};
        surface.GetCurrentTexture(&st);
        if (st.texture) {
            wgpu::RenderPassColorAttachment ca{};
            ca.view = st.texture.CreateView();
            ca.loadOp = wgpu::LoadOp::Clear;
            ca.storeOp = wgpu::StoreOp::Store;
            ca.clearValue = {0.0, 0.0, 0.0, 1.0};
            wgpu::RenderPassDescriptor rp{};
            rp.colorAttachmentCount = 1;
            rp.colorAttachments = &ca;
            wgpu::CommandEncoder enc = device.CreateCommandEncoder();
            wgpu::RenderPassEncoder pass = enc.BeginRenderPass(&rp);
            pass.SetPipeline(pipeline);
            pass.SetBindGroup(0, bindGroup);
            pass.Draw(4);
            pass.End();
            wgpu::CommandBuffer cb = enc.Finish();
            device.GetQueue().Submit(1, &cb);
            surface.Present();
            presented++;
        } else if (frame < 3) {
            std::printf("[core] frame %d no texture (status=%d)\n", frame, (int)st.status);
        }
        serializer.Flush();
        std::vector<uint8_t> f;
        if (ipc::readWireFrame(wireFd, f))
            client.HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
        wgpuInstanceProcessEvents(inst.Get());
        ::usleep(16000);  // ~60Hz
    }
    std::printf("[core] presented %d/%d frames\n", presented, kFrames);

    // Close the read-access bracket held across the frame loop.
    {
        ipc::Message end{}; end.tag = ipc::Tag::EndAccess;
        ipc::Message reply{};
        if (!sendAndWait(end, ipc::Tag::EndDone, reply))
            std::fprintf(stderr, "[core] no EndDone (read close)\n");
    }

    // Clean shutdown. Signal the GPU process, disconnect the wire client, close
    // the sockets, and reap. The GPU process detects the closed wire and exits;
    // its WireServer tears down surfaces before devices (Dawn fix) so the
    // Wayland swapchain detaches cleanly.
    {
        ipc::Message m{};
        m.tag = ipc::Tag::Shutdown;
        ipc::sendMessage(ctrlFd, m);
        serializer.Flush();
    }
    client.Disconnect();
    ::close(wireFd);
    ::close(ctrlFd);
    int status = 0;
    ::waitpid(gpu, &status, 0);
    if (WIFEXITED(status)) {
        std::printf("[core] gpu exited cleanly code=%d\n", WEXITSTATUS(status));
    } else if (WIFSIGNALED(status)) {
        std::printf("[core] gpu killed by signal %d\n", WTERMSIG(status));
    }
    bool gpuClean = WIFEXITED(status) && WEXITSTATUS(status) == 0;
    std::printf("[core] RESULT: %s\n",
                (presented > 0 && gpuClean) ? "PASS" : "FAIL");
    return (presented > 0 && gpuClean) ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    // GPU-process binary path: argv[1] or env, defaulting to a sibling binary.
    const char* gpuBin = (argc > 1) ? argv[1] : std::getenv("OVERDRAW_GPU_PROCESS");
    if (!gpuBin) {
        std::fprintf(stderr,
                     "usage: %s <path-to-overdraw-gpu-process>\n"
                     "   or set OVERDRAW_GPU_PROCESS\n", argv[0]);
        return 1;
    }
    return run(gpuBin);
}
