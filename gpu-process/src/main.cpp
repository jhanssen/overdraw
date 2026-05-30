// overdraw GPU process (phase 1 nested mode).
//
// Native Dawn + wire server. Owns the host Wayland output window and creates
// the wgpu::Surface from it; the core (wire client) drives the swapchain over
// the wire. No JS. Spawned by the core with two inherited socket fds:
//   argv[1] = wire socket fd, argv[2] = side-channel socket fd.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include <execinfo.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

#include "dawn/native/DawnNative.h"
#include "dawn/wire/WireServer.h"
#include "dawn/webgpu_cpp.h"

#include "allocator.h"
#include "host_window.h"
#include "side_channel.h"
#include "transport.h"

using namespace overdraw;

namespace {

// Crash handler: dump a native backtrace to a file (async-signal-safe-ish:
// backtrace/backtrace_symbols_fd are commonly used here) then re-raise.
void crashHandler(int sig) {
    const char* path = "/tmp/overdraw-gpu-crash.txt";
    int fd = ::open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) {
        char hdr[64];
        int n = std::snprintf(hdr, sizeof(hdr), "GPU process caught signal %d\n", sig);
        ::write(fd, hdr, static_cast<size_t>(n));
        void* frames[64];
        int got = ::backtrace(frames, 64);
        ::backtrace_symbols_fd(frames, got, fd);
        ::close(fd);
    }
    ::signal(sig, SIG_DFL);
    ::raise(sig);
}

void installCrashHandler() {
    ::signal(SIGSEGV, crashHandler);
    ::signal(SIGABRT, crashHandler);
    ::signal(SIGBUS, crashHandler);
    ::signal(SIGILL, crashHandler);
    ::signal(SIGFPE, crashHandler);
}

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

    // Set once the client's device is resolved (step 5). Device/queue-level
    // async ops (buffer MapAsync, OnSubmittedWorkDone) only resolve when the
    // device's queue is advanced via DeviceTick; InstanceProcessEvents alone
    // (which drives instance-level ops like RequestDevice) is not enough. Held
    // as a raw handle so the pump lambda can tick it before it exists.
    WGPUDevice tickDev = nullptr;

    // Process at most `maxFrames` wire frames per call so the side channel is
    // not starved while the wire is busy. <=0 means drain fully (startup use).
    auto pumpWireN = [&](int maxFrames) {
        std::vector<uint8_t> frame;
        int n = 0;
        while ((maxFrames <= 0 || n < maxFrames) && ipc::readWireFrame(wireFd, frame)) {
            server.HandleCommands(reinterpret_cast<const char*>(frame.data()), frame.size());
            serializer.Flush();
            ++n;
        }
        dawn::native::InstanceProcessEvents(instance.Get());
        if (tickDev) {
            // Advance the device queue so submitted work + async completions
            // (e.g. buffer map, OnSubmittedWorkDone) resolve, then flush any
            // responses the wire-server's spontaneous callbacks wrote back.
            dawn::native::DeviceTick(tickDev);
            serializer.Flush();
        }
    };
    auto pumpWire = [&] { pumpWireN(0); };

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
    tickDev = nativeDev;  // pump now ticks the device queue (map/work-done)
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

    // B1: GBM allocator + Dawn DRM modifier probe (persistent: the allocator
    // owns the gbm device and any allocated bo for the rest of the run).
    std::printf("[gpu] adapter DawnDrmFormatCapabilities feature: %d  SharedTextureMemoryDmaBuf: %d\n",
                adapter.HasFeature(wgpu::FeatureName::DawnDrmFormatCapabilities) ? 1 : 0,
                adapter.HasFeature(wgpu::FeatureName::SharedTextureMemoryDmaBuf) ? 1 : 0);
    gpu::Allocator alloc;
    if (!alloc.open()) { std::fprintf(stderr, "[gpu] allocator open failed\n"); return 1; }
    if (!alloc.probe(adapter, wgpu::TextureFormat::BGRA8Unorm)) {
        std::fprintf(stderr, "[gpu] modifier probe found nothing importable\n");
        return 1;
    }
    std::printf("[gpu] B1 probe OK (%zu usable modifiers)\n", alloc.usableModifiers().size());

    wgpu::SurfaceCapabilities caps{};
    surface.GetCapabilities(adapter, &caps);
    uint32_t format = caps.formatCount
                          ? static_cast<uint32_t>(caps.formats[0])
                          : static_cast<uint32_t>(WGPUTextureFormat_BGRA8Unorm);

    // Prefer Mailbox: GetCurrentTexture is a blocking wire call on the server's
    // single command thread, and FIFO blocks it whenever the host compositor
    // isn't consuming frames (e.g. the nested window is unviewed) -- which
    // stalls all other wire work behind it (buffer map, etc.). Mailbox never
    // blocks the acquire (it replaces the unpresented frame). Fall back to the
    // first advertised mode if Mailbox is unsupported.
    uint32_t presentMode = static_cast<uint32_t>(wgpu::PresentMode::Fifo);
    bool haveMailbox = false;
    for (size_t i = 0; i < caps.presentModeCount; ++i)
        if (caps.presentModes[i] == wgpu::PresentMode::Mailbox) haveMailbox = true;
    if (haveMailbox) presentMode = static_cast<uint32_t>(wgpu::PresentMode::Mailbox);
    else if (caps.presentModeCount) presentMode = static_cast<uint32_t>(caps.presentModes[0]);

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
        m.presentMode = presentMode;
        m.alphaMode = static_cast<uint32_t>(WGPUCompositeAlphaMode_Opaque);
        m.width = window.width();
        m.height = window.height();
        ipc::sendMessage(ctrlFd, m);
    }

    // Wire-resolved core device (non-owning wrapper; addref'd by the ctor).
    wgpu::Device coreDevice(nativeDev);

    // B3: persistent dmabuf-backed texture injected at the client's reserved
    // handle. Allocated + imported on demand when the core sends ReserveTex.
    gpu::DmabufBuffer dmaBuf{};
    wgpu::SharedTextureMemory dmaMem;
    wgpu::Texture dmaTex;

    // 9) Service Dawn + the host window until the core requests shutdown or the
    //    host window is closed. The core drives the swapchain over the wire.
    bool shutdown = false;
    while (!shutdown && !window.shouldClose()) {
        pumpWireN(8);  // bounded so the side channel below is not starved
        window.pump();
        ipc::Message m{};
        if (ipc::recvMessageNB(ctrlFd, m)) {
            if (m.tag == ipc::Tag::Shutdown) {
                shutdown = true;
            } else if (m.tag == ipc::Tag::BeginAccess) {
                // Begin access so the core's wire render commands may target the
                // dmabuf texture. Vulkan layout state is mandatory on this
                // backend. First access: undefined -> general.
                wgpu::SharedTextureMemoryVkImageLayoutBeginState layout{};
                // First (write) access begins from UNDEFINED; subsequent access
                // begins from the layout the previous EndAccess reported (sent
                // back by the core in oldLayout). newLayout is GENERAL so the
                // texture is usable for both render and sample.
                layout.oldLayout = m.initialized ? m.oldLayout : 0;  // 0=UNDEFINED
                layout.newLayout = 1;                                // GENERAL
                wgpu::SharedTextureMemoryBeginAccessDescriptor bad{};
                bad.nextInChain = &layout;
                bad.initialized = m.initialized != 0;
                bad.fenceCount = 0;
                if (dmaMem.BeginAccess(dmaTex, &bad) != wgpu::Status::Success) {
                    std::fprintf(stderr, "[gpu] BeginAccess failed\n");
                    return 1;
                }
                serializer.Flush();
                std::printf("[gpu] BeginAccess OK\n");
                ipc::Message reply{};
                reply.tag = ipc::Tag::BeginDone;
                ipc::sendMessage(ctrlFd, reply);
            } else if (m.tag == ipc::Tag::EndAccess) {
                wgpu::SharedTextureMemoryVkImageLayoutEndState endLayout{};
                wgpu::SharedTextureMemoryEndAccessState endState{};
                endState.nextInChain = &endLayout;
                if (dmaMem.EndAccess(dmaTex, &endState) != wgpu::Status::Success) {
                    std::fprintf(stderr, "[gpu] EndAccess failed\n");
                    return 1;
                }
                // Export the produced sync-fd (proves the fence mechanism). The
                // single-device path does not consume it cross-process; passing
                // it over SCM_RIGHTS to the core is the two-device (B6) need.
                uint32_t fenceCount = static_cast<uint32_t>(endState.fenceCount);
                int syncFd = -1;
                if (endState.fenceCount >= 1) {
                    wgpu::SharedFenceExportInfo exp{};
                    wgpu::SharedFenceSyncFDExportInfo syncExp{};
                    exp.nextInChain = &syncExp;
                    endState.fences[0].ExportInfo(&exp);
                    syncFd = syncExp.handle;
                }
                std::printf("[gpu] EndAccess OK; fenceCount=%u syncFd=%d endLayout(old=%d new=%d)\n",
                            fenceCount, syncFd, endLayout.oldLayout, endLayout.newLayout);
                // The fd from ExportInfo is owned by the SharedFence (freed when
                // endState is destroyed); do NOT close it here. A consumer that
                // needs to keep it must dup() it (the B6 cross-process path).
                ipc::Message reply{};
                reply.tag = ipc::Tag::EndDone;
                reply.fenceCount = fenceCount;
                reply.endLayout = endLayout.newLayout;
                ipc::sendMessage(ctrlFd, reply);
            } else if (m.tag == ipc::Tag::ReserveTex) {
                // Allocate a dmabuf, import it on the wire-resolved core device,
                // create the texture, and inject it at the client's reserved
                // handle so the client's ReserveTexture proxy now resolves.
                if (!alloc.allocate(m.width, m.height, dmaBuf)) {
                    std::fprintf(stderr, "[gpu] ReserveTex: allocate failed\n");
                    return 1;
                }
                if (!gpu::Allocator::importTexture(coreDevice, alloc.fourcc(),
                                                   dmaBuf, dmaMem, dmaTex)) {
                    std::fprintf(stderr, "[gpu] ReserveTex: import failed\n");
                    return 1;
                }
                if (!server.InjectTexture(dmaTex.Get(),
                                          {m.texture.id, m.texture.generation},
                                          {m.device.id, m.device.generation})) {
                    std::fprintf(stderr, "[gpu] InjectTexture failed\n");
                    return 1;
                }
                serializer.Flush();
                std::printf("[gpu] injected dmabuf texture at {%u,%u} on device {%u,%u}\n",
                            m.texture.id, m.texture.generation,
                            m.device.id, m.device.generation);
                ipc::Message reply{};
                reply.tag = ipc::Tag::TexInjected;
                reply.texture = m.texture;
                reply.modifier = dmaBuf.modifier;
                ipc::sendMessage(ctrlFd, reply);
            }
        }
        // Detect core closing the wire socket.
        uint32_t probe;
        if (::recv(wireFd, &probe, 4, MSG_DONTWAIT | MSG_PEEK) == 0) shutdown = true;
        usleepShort();
    }
    dmaTex = nullptr;
    dmaMem = nullptr;
    alloc.release(dmaBuf);
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
    installCrashHandler();
    if (argc < 3) {
        std::fprintf(stderr, "usage: %s <wireFd> <ctrlFd>\n", argv[0]);
        return 1;
    }
    int wireFd = std::atoi(argv[1]);
    int ctrlFd = std::atoi(argv[2]);
    return run(wireFd, ctrlFd);
}
