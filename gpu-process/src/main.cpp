// overdraw GPU process (phase 1 nested mode).
//
// Native Dawn + wire server. Owns the host Wayland output window and creates
// the wgpu::Surface from it; the core (wire client) drives the swapchain over
// the wire. No JS. Spawned by the core with two inherited socket fds:
//   argv[1] = wire socket fd, argv[2] = side-channel socket fd.

#include <cstdio>
#include <cstdlib>
#include <vector>

#include <fcntl.h>
#include <unistd.h>

#include "dawn/native/DawnNative.h"
#include "dawn/wire/WireServer.h"
#include "dawn/webgpu_cpp.h"

#include "host_window.h"
#include "side_channel.h"
#include "transport.h"

using namespace overdraw;

namespace {

void usleepShort() { ::usleep(200); }

int run(int wireFd, int ctrlFd) {
    // 1) Host output window (this process is the Wayland client of the host).
    gpu::HostWindow window;
    if (!window.open("overdraw")) {
        std::fprintf(stderr, "[gpu] failed to open host window (no WAYLAND_DISPLAY?)\n");
        return 1;
    }
    std::printf("[gpu] host window %ux%u\n", window.width(), window.height());

    // 2) Native Dawn instance + wire server.
    dawn::native::Instance instance;
    ipc::FdSerializer serializer(wireFd);
    dawn::wire::WireServerDescriptor wsd{};
    wsd.procs = &dawn::native::GetProcs();
    wsd.serializer = &serializer;
    wsd.useSpontaneousCallbacks = true;
    dawn::wire::WireServer server(wsd);

    ::fcntl(ctrlFd, F_SETFL, O_NONBLOCK);

    auto pumpWire = [&] {
        std::vector<uint8_t> frame;
        while (ipc::readWireFrame(wireFd, frame)) {
            server.HandleCommands(reinterpret_cast<const char*>(frame.data()), frame.size());
            serializer.Flush();
        }
        dawn::native::InstanceProcessEvents(instance.Get());
    };

    // 3) Handshake: Hello -> HelloReply(size).
    {
        bool gotHello = false;
        ipc::Message m{};
        for (int i = 0; i < 500000 && !gotHello; ++i) {
            if (ipc::recvMessageNB(ctrlFd, m) && m.tag == ipc::Tag::Hello) gotHello = true;
            else usleepShort();
        }
        if (!gotHello) { std::fprintf(stderr, "[gpu] no Hello\n"); return 1; }
        ipc::Message reply{};
        reply.tag = ipc::Tag::HelloReply;
        reply.protocolVersion = ipc::kProtocolVersion;
        reply.width = window.width();
        reply.height = window.height();
        ipc::sendMessage(ctrlFd, reply);
    }

    // 4) Inject native instance at the client's reserved handle.
    {
        bool got = false;
        ipc::Message m{};
        for (int i = 0; i < 500000 && !got; ++i) {
            if (ipc::recvMessageNB(ctrlFd, m) && m.tag == ipc::Tag::InstanceReserved) got = true;
            else usleepShort();
        }
        if (!got) { std::fprintf(stderr, "[gpu] no InstanceReserved\n"); return 1; }
        if (!server.InjectInstance(instance.Get(), {m.instance.id, m.instance.generation})) {
            std::fprintf(stderr, "[gpu] InjectInstance failed\n");
            return 1;
        }
        std::printf("[gpu] injected instance {%u,%u}\n", m.instance.id, m.instance.generation);
    }

    // 5) Pump until the client has its device + reserved surface (DeviceReady).
    ipc::Message ready{};
    {
        bool got = false;
        for (int i = 0; i < 1000000 && !got; ++i) {
            pumpWire();
            ipc::Message m{};
            if (ipc::recvMessageNB(ctrlFd, m) && m.tag == ipc::Tag::DeviceReady) {
                ready = m;
                got = true;
            }
            usleepShort();
        }
        if (!got) { std::fprintf(stderr, "[gpu] no DeviceReady\n"); return 1; }
    }
    WGPUDevice nativeDev = server.GetDevice(ready.device.id, ready.device.generation);
    if (!nativeDev) { std::fprintf(stderr, "[gpu] GetDevice null\n"); return 1; }
    std::printf("[gpu] client device {%u,%u} resolved; surface {%u,%u}\n",
                ready.device.id, ready.device.generation,
                ready.surface.id, ready.surface.generation);

    // 6) Create the wgpu::Surface natively from the host wl_surface, query caps.
    wgpu::Instance inst(instance.Get());
    wgpu::SurfaceSourceWaylandSurface src{};
    src.display = window.display();
    src.surface = window.surface();
    wgpu::SurfaceDescriptor sd{};
    sd.nextInChain = &src;
    wgpu::Surface surface = inst.CreateSurface(&sd);
    if (!surface) { std::fprintf(stderr, "[gpu] CreateSurface failed\n"); return 1; }

    wgpu::RequestAdapterOptions ao{};
    ao.backendType = wgpu::BackendType::Vulkan;
    ao.featureLevel = wgpu::FeatureLevel::Core;
    auto adapters = instance.EnumerateAdapters(
        reinterpret_cast<const WGPURequestAdapterOptions*>(&ao));
    if (adapters.empty()) { std::fprintf(stderr, "[gpu] no adapter\n"); return 1; }
    wgpu::Adapter adapter(adapters[0].Get());

    wgpu::SurfaceCapabilities caps{};
    surface.GetCapabilities(adapter, &caps);
    uint32_t format = caps.formatCount
                          ? static_cast<uint32_t>(caps.formats[0])
                          : static_cast<uint32_t>(WGPUTextureFormat_BGRA8Unorm);

    // 7) Inject the surface at the client's reserved handle.
    if (!server.InjectSurface(surface.Get(),
                              {ready.surface.id, ready.surface.generation},
                              {ready.instance.id, ready.instance.generation})) {
        std::fprintf(stderr, "[gpu] InjectSurface failed\n");
        return 1;
    }
    std::printf("[gpu] injected surface; format=%u\n", format);

    // 8) Tell the core the surface is ready (caps + size).
    {
        ipc::Message m{};
        m.tag = ipc::Tag::SurfaceReady;
        m.surface = ready.surface;
        m.format = format;
        m.presentMode = static_cast<uint32_t>(WGPUPresentMode_Fifo);
        m.alphaMode = static_cast<uint32_t>(WGPUCompositeAlphaMode_Opaque);
        m.width = window.width();
        m.height = window.height();
        ipc::sendMessage(ctrlFd, m);
    }

    // 9) Service Dawn + the host window until the core requests shutdown or the
    //    host window is closed. The core drives the swapchain over the wire.
    bool shutdown = false;
    while (!shutdown && !window.shouldClose()) {
        pumpWire();
        window.pump();
        ipc::Message m{};
        if (ipc::recvMessageNB(ctrlFd, m) && m.tag == ipc::Tag::Shutdown) shutdown = true;
        // Detect core closing the wire socket.
        uint32_t probe;
        if (::recv(wireFd, &probe, 4, MSG_DONTWAIT | MSG_PEEK) == 0) shutdown = true;
        usleepShort();
    }
    std::printf("[gpu] shutting down (shutdown=%d windowClosed=%d)\n",
                static_cast<int>(shutdown), static_cast<int>(window.shouldClose()));

    // Drain the wire until the core closes it, then exit.
    for (int i = 0; i < 4000; ++i) {
        pumpWire();
        uint32_t probe;
        if (::recv(wireFd, &probe, 4, MSG_DONTWAIT | MSG_PEEK) == 0) break;  // core closed wire
        usleepShort();
    }
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    if (argc < 3) {
        std::fprintf(stderr, "usage: %s <wireFd> <ctrlFd>\n", argv[0]);
        return 1;
    }
    int wireFd = std::atoi(argv[1]);
    int ctrlFd = std::atoi(argv[2]);
    return run(wireFd, ctrlFd);
}
