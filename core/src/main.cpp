// overdraw core (phase 1 nested mode, pure C++ stage).
//
// Spawns the GPU process and drives the compositing swapchain over the Dawn
// wire: requests adapter+device, reserves a surface (the GPU process injects
// the real Wayland-backed surface), configures it, and presents a cleared
// red frame each tick. No Wayland server, protocols, or plugins yet.
//
// The Node/N-API wrapping comes later; this stage is a plain executable.

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
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, wireFds) ||
        ::socketpair(AF_UNIX, SOCK_STREAM, 0, ctrlFds)) {
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

    // Device over the wire.
    wgpu::Device device;
    {
        wgpu::DeviceDescriptor dd{};
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
    std::printf("[core] swapchain configured; presenting red\n");

    // Frame loop: clear to red, present, over the wire.
    int presented = 0;
    for (int frame = 0; frame < kFrames; ++frame) {
        wgpu::SurfaceTexture st{};
        surface.GetCurrentTexture(&st);
        if (st.texture) {
            wgpu::RenderPassColorAttachment ca{};
            ca.view = st.texture.CreateView();
            ca.loadOp = wgpu::LoadOp::Clear;
            ca.storeOp = wgpu::StoreOp::Store;
            ca.clearValue = {0.85, 0.05, 0.05, 1.0};  // red
            wgpu::RenderPassDescriptor rp{};
            rp.colorAttachmentCount = 1;
            rp.colorAttachments = &ca;
            wgpu::CommandEncoder enc = device.CreateCommandEncoder();
            enc.BeginRenderPass(&rp).End();
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
