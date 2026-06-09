// overdraw GPU process (phase 1 nested mode).
//
// Native Dawn + wire server. Owns the host Wayland output window and creates
// the wgpu::Surface from it; the core (wire client) drives the swapchain over
// the wire. No JS. Spawned by the core with two inherited socket fds:
//   argv[1] = wire socket fd, argv[2] = side-channel socket fd.

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <chrono>
#include <functional>
#include <unordered_map>
#include <vector>

#include <dirent.h>
#include <execinfo.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#include <linux/dma-buf.h>

#include "dawn/native/DawnNative.h"
#include "dawn/wire/WireServer.h"
#include "dawn/webgpu_cpp.h"

#include "allocator.h"
#include "event_loop.h"
#include "host_window.h"
#include "side_channel.h"
#include "transport.h"
#include "wire_barrier.h"

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
        ssize_t w = ::write(fd, hdr, static_cast<size_t>(n));
        (void)w;
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

// Export a dmabuf's implicit READ-acquire fence (the producer's outstanding
// WRITE work) as a sync_file fd, so the consumer can make its GPU work wait on
// it. Returns -1 if unavailable (then there is nothing to wait on). This is the
// implicit-sync acquire a compositor must perform before sampling a client
// dmabuf that did not use explicit sync (wp_linux_drm_syncobj_v1). The returned
// fd is owned by the caller. Export the sync_file, then wait on it on the GPU
// timeline -- a CPU poll does NOT order the GPU work, so the fence must be
// imported into the access bracket.
int exportDmabufAcquireFence(int dmabufFd) {
    struct dma_buf_export_sync_file req{};
    req.flags = DMA_BUF_SYNC_READ;
    req.fd = -1;
    if (::ioctl(dmabufFd, DMA_BUF_IOCTL_EXPORT_SYNC_FILE, &req) != 0) {
        std::fprintf(stderr, "[gpu] EXPORT_SYNC_FILE failed errno=%d\n", errno);
        return -1;
    }
    return req.fd;
}

// Serialize dmabuf-feedback format_table entries into a sealed read-only memfd
// (the linux-dmabuf-v1 format_table is mmap'd by the client). Returns the fd
// (caller owns) or -1 on failure.
int buildFormatTableMemfd(const std::vector<gpu::FormatTableEntry>& entries) {
    const size_t bytes = entries.size() * sizeof(gpu::FormatTableEntry);
    int fd = ::memfd_create("overdraw-dmabuf-format-table",
                            MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0) { std::perror("[gpu] memfd_create format_table"); return -1; }
    if (bytes > 0) {
        if (::ftruncate(fd, static_cast<off_t>(bytes)) != 0) { ::close(fd); return -1; }
        void* map = ::mmap(nullptr, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (map == MAP_FAILED) { ::close(fd); return -1; }
        std::memcpy(map, entries.data(), bytes);
        ::munmap(map, bytes);
    }
    ::fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE);
    return fd;
}

int run(int wireFd, int ctrlFd, int inputFd, bool headless,
        uint32_t headlessW, uint32_t headlessH) {
    // 1) Output: in nested mode, a host Wayland output window (this process is
    //    the Wayland client of the host) whose seat forwards input over inputFd.
    //    In HEADLESS mode there is no host window/surface/seat at all -- the core
    //    renders the compositing pass into an offscreen texture and reads it back
    //    (tests). The size is fixed from argv.
    gpu::HostWindow window(inputFd);
    if (!headless) {
        if (!window.open("overdraw")) {
            std::fprintf(stderr, "[gpu] failed to open host window (no WAYLAND_DISPLAY?)\n");
            return 1;
        }
        std::printf("[gpu] host window %ux%u\n", window.width(), window.height());
    } else {
        std::printf("[gpu] HEADLESS %ux%u (no host window/surface)\n", headlessW, headlessH);
    }
    auto outW = [&] { return headless ? headlessW : window.width(); };
    auto outH = [&] { return headless ? headlessH : window.height(); };

    // 2) Native Dawn instance + wire server.
    dawn::native::Instance instance;
    ipc::FdSerializer serializer(wireFd);
    dawn::wire::WireServerDescriptor wsd{};
    wsd.procs = &dawn::native::GetProcs();
    wsd.serializer = &serializer;
    wsd.useSpontaneousCallbacks = true;
    dawn::wire::WireServer server(wsd);

    ipc::setNonBlocking(ctrlFd);
    ipc::setNonBlocking(wireFd);  // buffered FdSerializer/FrameReader require NB

    // Set once the client's device is resolved (step 5). Device/queue-level
    // async ops (buffer MapAsync, OnSubmittedWorkDone) only resolve when the
    // device's queue is advanced via DeviceTick; InstanceProcessEvents alone
    // (which drives instance-level ops like RequestDevice) is not enough. Held
    // as a raw handle so the pump lambda can tick it before it exists.
    WGPUDevice tickDev = nullptr;

    ipc::FrameReader wireReader(wireFd);

    // Read + dispatch all currently-buffered wire frames, advance Dawn, and pump
    // outbound wire bytes. Non-blocking throughout. Returns false if the core
    // closed the wire. Flush() now queues bytes and writes what fits; the event
    // loop drains the rest on EPOLLOUT.
    // Dispatch a non-Dawn (kind != 0) core-wire control frame to the matching
    // access-bracket helper. Assigned after the helpers are defined below; until
    // then no control frame can legitimately arrive (no textures/surfaces exist
    // pre-bring-up), so a non-null check guards the bring-up window.
    std::function<void(ipc::FrameKind, const std::vector<uint8_t>&)> dispatchCoreControlFrame;

    auto pumpWire = [&]() -> bool {
        bool alive = wireReader.readAvailable();
        ipc::FrameKind kind;
        std::vector<uint8_t> frame;
        while (wireReader.nextFrame(kind, frame)) {
            if (kind == ipc::FrameKind::WireBytes) {
                server.HandleCommands(reinterpret_cast<const char*>(frame.data()), frame.size());
                serializer.Flush();
            } else if (dispatchCoreControlFrame) {
                dispatchCoreControlFrame(kind, frame);
            } else {
                std::fprintf(stderr,
                    "[gpu] core wire: control frame kind=%u before dispatch ready\n",
                    static_cast<unsigned>(kind));
                std::abort();
            }
        }
        dawn::native::InstanceProcessEvents(instance.Get());
        if (tickDev) {
            // Advance the device queue so submitted work + async completions
            // (buffer map, OnSubmittedWorkDone) resolve; spontaneous wire-server
            // callbacks then queue their responses, which Flush pumps.
            dawn::native::DeviceTick(tickDev);
            serializer.Flush();
        }
        return alive;
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
        reply.width = outW();
        reply.height = outH();
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

    // 6) Native adapter (needed for the dmabuf modifier probe AND, in nested
    //    mode, for surface caps). In headless mode there is no surface.
    wgpu::Instance inst(instance.Get());
    wgpu::RequestAdapterOptions ao{};
    ao.backendType = wgpu::BackendType::Vulkan;
    ao.featureLevel = wgpu::FeatureLevel::Core;
    auto adapters = instance.EnumerateAdapters(
        reinterpret_cast<const WGPURequestAdapterOptions*>(&ao));
    if (adapters.empty()) { std::fprintf(stderr, "[gpu] no adapter\n"); return 1; }
    wgpu::Adapter adapter(adapters[0].Get());

    // Nested: create the wgpu::Surface from the host wl_surface. Headless: none.
    wgpu::Surface surface;
    if (!headless) {
        wgpu::SurfaceSourceWaylandSurface src{};
        src.display = window.display();
        src.surface = window.surface();
        wgpu::SurfaceDescriptor sd{};
        sd.nextInChain = &src;
        surface = inst.CreateSurface(&sd);
        if (!surface) { std::fprintf(stderr, "[gpu] CreateSurface failed\n"); return 1; }
    }

    // B1: GBM allocator + Dawn DRM modifier probe (persistent: the allocator
    // owns the gbm device and any allocated bo for the rest of the run).
    std::printf("[gpu] adapter DawnDrmFormatCapabilities feature: %d  SharedTextureMemoryDmaBuf: %d\n",
                adapter.HasFeature(wgpu::FeatureName::DawnDrmFormatCapabilities) ? 1 : 0,
                adapter.HasFeature(wgpu::FeatureName::SharedTextureMemoryDmaBuf) ? 1 : 0);
    gpu::Allocator alloc;
    if (!alloc.open()) { std::fprintf(stderr, "[gpu] allocator open failed\n"); return 1; }
    if (!alloc.probe(adapter)) {
        std::fprintf(stderr, "[gpu] modifier probe found nothing importable\n");
        return 1;
    }
    std::printf("[gpu] B1 probe OK (%zu usable modifiers)\n", alloc.usableModifiers().size());

    // Send dmabuf-feedback data to the core: the format_table (one entry per
    // usable modifier) as a sealed memfd via SCM_RIGHTS, plus main_device dev_t
    // and the entry count. The core relays this to the JS linux-dmabuf-v1
    // default-feedback handler. Sent before SurfaceReady so the core can stash
    // it during bring-up. Non-fatal on failure (clients fall back / warn).
    {
        std::vector<gpu::FormatTableEntry> entries = alloc.formatTable();
        int tableFd = buildFormatTableMemfd(entries);
        if (tableFd >= 0) {
            ipc::Message m{};
            m.tag = ipc::Tag::FeedbackData;
            m.mainDevice = static_cast<uint64_t>(alloc.deviceId());
            m.entryCount = static_cast<uint32_t>(entries.size());
            m.formatTableSize =
                static_cast<uint32_t>(entries.size() * sizeof(gpu::FormatTableEntry));
            int fds[1] = {tableFd};
            ipc::sendMessageFds(ctrlFd, m, fds, 1);
            ::close(tableFd);  // receiver dup'd it
            std::printf("[gpu] sent FeedbackData: main_device=0x%llx entries=%u size=%u\n",
                        static_cast<unsigned long long>(m.mainDevice),
                        m.entryCount, m.formatTableSize);
        } else {
            std::fprintf(stderr, "[gpu] format_table memfd build failed; feedback skipped\n");
        }
    }

    // 6b/7/8) Surface caps + inject + SurfaceReady -- NESTED only. Headless has
    // no surface; the core renders into an offscreen texture (no swapchain) and
    // does not wait for SurfaceReady.
    if (!headless) {
    wgpu::SurfaceCapabilities caps{};
    surface.GetCapabilities(adapter, &caps);
    // Choose a NON-sRGB swapchain format. Client buffers carry sRGB-encoded
    // bytes and the compositing shader passes them through unchanged; an sRGB
    // swapchain target would sRGB-encode the output a second time (visibly too
    // bright). Prefer the first advertised non-*Srgb format; fall back to the
    // first format, then BGRA8Unorm.
    auto isSrgb = [](uint32_t f) {
        return f == static_cast<uint32_t>(WGPUTextureFormat_RGBA8UnormSrgb) ||
               f == static_cast<uint32_t>(WGPUTextureFormat_BGRA8UnormSrgb);
    };
    uint32_t format = static_cast<uint32_t>(WGPUTextureFormat_BGRA8Unorm);
    if (caps.formatCount) {
        format = static_cast<uint32_t>(caps.formats[0]);
        for (size_t i = 0; i < caps.formatCount; ++i) {
            uint32_t f = static_cast<uint32_t>(caps.formats[i]);
            if (!isSrgb(f)) { format = f; break; }
        }
    }

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
        m.width = outW();
        m.height = outH();
        ipc::sendMessage(ctrlFd, m);
    }
    }  // if (!headless)

    // Wire-resolved core device (non-owning wrapper; addref'd by the ctor).
    wgpu::Device coreDevice(nativeDev);

    // B3: persistent dmabuf-backed texture injected at the client's reserved
    // handle. Allocated + imported on demand when the core sends ReserveTex.
    gpu::DmabufBuffer dmaBuf{};
    wgpu::SharedTextureMemory dmaMem;
    wgpu::Texture dmaTex;

    // Client dmabuf imports (linux-dmabuf-v1). Keyed by the reserved texture
    // handle id. Each holds the imported STM + texture + the owning dmabuf fd;
    // Per-frame BeginAccess/EndAccess bracket lives on the core's compositor
    // submit (see BeginClientAccess/EndClientAccess in side_channel.h). The
    // import path does NOT call BeginAccess any more -- it just imports the
    // STM and caches it; the first BeginAccess fires on the first frame that
    // samples it.
    //
    // layout: current Vulkan image layout (carried from the prior EndAccess's
    //   endState.newLayout into the next BeginAccess's oldLayout). 0=UNDEFINED.
    // accessOpen: a BeginAccess bracket is currently open on this entry
    //   (between BeginClientAccess and EndClientAccess). Invariant: never two
    //   begins without an end (mirrors Dawn's device-error rule; the GPU
    //   process side enforces it locally with a typed reject before Dawn
    //   sees it).
    // lastEndFence: the SharedFence the previous EndAccess exported, imported
    //   into the same (core) device. Chained into the next BeginAccess's
    //   fences[] so the per-access fence-chaining model Dawn requires is
    //   preserved (each Begin waits on the prior End's exported fence).
    struct ClientTex {
        wgpu::SharedTextureMemory mem;
        wgpu::Texture tex;
        int fd = -1;
        uint32_t generation = 0;  // wire handle generation, for release matching
        int32_t layout = 0;       // 0=UNDEFINED (first BeginAccess starts here)
        bool accessOpen = false;
        bool everSampled = false; // initialized=false on first Begin, =true after
        wgpu::SharedFence lastEndFence;
    };
    std::unordered_map<uint32_t, ClientTex> clientTextures;

    // Cross-channel barrier on the CORE wire reader. Used by ImportClientTex:
    // an inject at a recycled texture handle id must wait for the prior
    // UnregisterObjectCmd (and the new ReserveTexture) to have been applied on
    // the wire server, otherwise InjectTexture targets a stale handle. The
    // ctrl message carries msg.wireSerial captured AFTER the core flushed the
    // reserve; we drain the barrier each time the wire reader advances.
    //
    // Tagging: each deferred ImportClientTex action carries `tag = importFdTag(
    // texture.id)` so shutdown can pair queued entries with their captured fds
    // (held in `importPendingFds` until the action runs or shutdown sweeps).
    ipc::WireBarrier coreWireBarrier;
    // texture.id -> fd queued in a deferred ImportClientTex action. The action's
    // first step erases this entry; on shutdown any leftover fds are closed.
    // (The action also owns the fd via capture; this map exists ONLY so the
    // shutdown sweep can close fds whose actions never ran.)
    std::unordered_map<uint32_t, int> importPendingFds;
    auto importFdTag = [](uint32_t textureId) -> ipc::WireBarrier::Tag {
        return static_cast<ipc::WireBarrier::Tag>(textureId);
    };

    // 9) Service Dawn + the host window until the core requests shutdown or the
    //    host window is closed. The core drives the swapchain over the wire.
    bool shutdown = false;

    // --- Plugin wire connections (C-M2) ---------------------------------------
    // Each plugin gets its OWN wire connection (architecture.md "IPC": one
    // dawn::wire::Server per connected client). The connection's GPU-end fd is
    // delivered by the core over the side channel (AddWireConn, SCM_RIGHTS); there
    // is NO listening socket, so only the trusted core can introduce a connection.
    // Each connection has its own WireServer + serializer + reader + native
    // instance; the plugin's wire client (in its Worker) drives ReserveInstance/
    // RequestAdapter/RequestDevice over it, exactly as the core does on its own
    // connection. The native device is resolved lazily (server.GetDevice) when the
    // plugin first needs server-side work (STM import, C-M4).
    struct PluginConn {
        uint32_t connId = 0;
        int fd = -1;
        std::unique_ptr<ipc::FdSerializer> serializer;
        std::unique_ptr<ipc::FrameReader> reader;
        std::unique_ptr<dawn::native::Instance> instance;
        std::unique_ptr<dawn::wire::WireServer> server;
        WGPUDevice tickDev = nullptr;  // set once the plugin device is resolved
        bool registered = false;       // added to the event loop yet
        // Per-connection cross-channel barrier (this connection's wire reader).
        // Holds deferred ctrl ops (currently producer EndAccess, the ring's
        // AllocSurfaceBuf inject) until the plugin wire reader has consumed the
        // commands the ctrl op depends on.
        ipc::WireBarrier barrier;
        // In-band producer control-frame dispatch (kind=1/kind=2 Surface frames
        // on THIS plugin wire). Assigned after the runSurface* helpers exist;
        // until then no producer frame can arrive (no surface bufs yet).
        std::function<void(ipc::FrameKind, const std::vector<uint8_t>&)> dispatchControl;

        // Read + dispatch buffered wire frames, advance Dawn, flush outbound. NB.
        bool pump() {
            bool alive = reader->readAvailable();
            ipc::FrameKind kind;
            std::vector<uint8_t> frame;
            while (reader->nextFrame(kind, frame)) {
                if (kind == ipc::FrameKind::WireBytes) {
                    server->HandleCommands(reinterpret_cast<const char*>(frame.data()),
                                           frame.size());
                    serializer->Flush();
                } else if (dispatchControl) {
                    dispatchControl(kind, frame);
                } else {
                    std::fprintf(stderr,
                        "[gpu] plugin conn %u: control frame kind=%u before dispatch ready\n",
                        connId, static_cast<unsigned>(kind));
                    std::abort();
                }
            }
            dawn::native::InstanceProcessEvents(instance->Get());
            if (tickDev) { dawn::native::DeviceTick(tickDev); serializer->Flush(); }
            return alive;
        }
    };
    std::vector<std::unique_ptr<PluginConn>> pluginConns;

    // --- Producer/consumer surface buffers ------------------------------------
    // One GBM dmabuf shared between two devices: one writes (the "producer"),
    // one reads (the "consumer"). The cross-device fence (C-M1) is applied per
    // frame: producer EndAccess exports a sync-fd, which the consumer BeginAccess
    // waits on (and vice versa, for the next producer cycle).
    //
    // Two directions exist:
    //
    //   AllocSurfaceBuf: producerOnCore=false. PRODUCER is the plugin device
    //     (plugin renders an overlay), CONSUMER is the core device (the JS
    //     compositor samples it). Producer Begin/End ride the plugin wire;
    //     consumer Begin/End ride the core wire. Used by sdk.gpu overlays
    //     and decorations.
    //
    //   AllocComposeBuf: producerOnCore=true. PRODUCER is the core device
    //     (core's JS compositor writes a compose result), CONSUMER is the
    //     plugin device (the plugin samples the compose output). Producer
    //     Begin/End ride the core wire; consumer Begin/End ride the plugin
    //     wire. Used by sdk.compose for Worker plugins.
    //
    // producerMem/Tex/Dev always points at the producing-device side, regardless
    // of whether that's plugin or core. consumerMem/Tex/Dev points at the
    // consuming-device side. The producerOnCore flag tells the wire dispatchers
    // which socket carries which role for each surface.
    struct SurfaceBuf {
        uint32_t connId = 0;  // owning plugin connection (for wire-serial ordering)
        gpu::DmabufBuffer buf;
        bool producerOnCore = false;             // false: plugin produces; true: core produces
        wgpu::SharedTextureMemory producerMem;   // on the producing device
        wgpu::Texture producerTex;
        wgpu::Device producerDev;                // for fence import
        wgpu::SharedTextureMemory consumerMem;   // on the consuming device
        wgpu::Texture consumerTex;
        wgpu::Device consumerDev;                // for fence import
        // Per-frame fence dance state. The dmabuf's Vulkan image layout is shared
        // across both devices; each EndAccess reports the end layout, which the
        // next BeginAccess (on either side) begins from. The held fences carry
        // producer-done -> consumer-wait and consumer-done -> producer-wait.
        int32_t layout = 0;                  // current Vulkan image layout (0=UNDEFINED)
        bool everProduced = false;           // first ProducerBegin starts UNDEFINED
        bool producerOpen = false;           // a producer BeginAccess bracket is open
        bool consumerOpen = false;           // a consumer BeginAccess bracket is open
        wgpu::SharedFence producerFence;     // last producer EndAccess fence (for consumer)
        wgpu::SharedFence consumerFence;     // last consumer EndAccess fence (for producer)
    };
    std::unordered_map<uint32_t, SurfaceBuf> surfaceBufs;

    // Close a producer/consumer bracket: EndAccess, export the produced sync-fd as
    // a SharedFence held for the OTHER side's next Begin wait, record the end
    // layout. (Defined as a lambda so the deferred-producer-end path can reuse it.)
    auto runSurfaceEnd = [&](uint32_t surfaceBufId, bool producer) {
        auto it = surfaceBufs.find(surfaceBufId);
        if (it == surfaceBufs.end()) return;
        SurfaceBuf& sb = it->second;
        wgpu::SharedTextureMemory& mem = producer ? sb.producerMem : sb.consumerMem;
        wgpu::Texture& tex = producer ? sb.producerTex : sb.consumerTex;
        wgpu::SharedTextureMemoryVkImageLayoutEndState endLayout{};
        wgpu::SharedTextureMemoryEndAccessState endState{};
        endState.nextInChain = &endLayout;
        if (mem.EndAccess(tex, &endState) != wgpu::Status::Success) {
            std::fprintf(stderr, "[gpu] %sEnd: EndAccess failed (buf=%u)\n",
                         producer ? "Producer" : "Consumer", surfaceBufId);
            return;
        }
        if (producer) sb.producerOpen = false; else sb.consumerOpen = false;
        sb.layout = endLayout.newLayout;
        // producerFence (waited by consumer/core) / consumerFence (waited by
        // producer/plugin); import into the WAITING side's device.
        wgpu::SharedFence& held = producer ? sb.producerFence : sb.consumerFence;
        wgpu::Device& waiterDev = producer ? sb.consumerDev : sb.producerDev;
        held = nullptr;
        if (endState.fenceCount >= 1) {
            wgpu::SharedFenceExportInfo exp{};
            wgpu::SharedFenceSyncFDExportInfo syncExp{};
            exp.nextInChain = &syncExp;
            endState.fences[0].ExportInfo(&exp);
            if (syncExp.handle >= 0) {
                int dupFd = ::dup(syncExp.handle);
                if (dupFd >= 0) {
                    wgpu::SharedFenceSyncFDDescriptor sfd{};
                    sfd.handle = dupFd;
                    wgpu::SharedFenceDescriptor fdd{};
                    fdd.nextInChain = &sfd;
                    held = waiterDev.ImportSharedFence(&fdd);
                    ::close(dupFd);
                }
            }
        }
    };

    // Open a producer (write) or consumer (read) access bracket on the surface
    // buffer, WAITING the other side's last fence (C-M1 cross-device fence,
    // in-process here). The dmabuf's Vulkan layout continues from the last
    // EndAccess. Returns true iff the bracket opened (the ctrl-dispatch caller
    // turns this into a *BeginDone reply; in-band dispatch ignores the bool and
    // hard-fails on false). Mirrors runSurfaceEnd's (surfaceBufId, producer)
    // shape so both the ctrl branch and the future kind=1 wire dispatch can call
    // it.
    auto runSurfaceBegin = [&](uint32_t surfaceBufId, bool producer) -> bool {
        auto it = surfaceBufs.find(surfaceBufId);
        if (it == surfaceBufs.end()) {
            std::fprintf(stderr, "[gpu] %sBegin: unknown surfaceBufId=%u\n",
                         producer ? "Producer" : "Consumer", surfaceBufId);
            return false;
        }
        SurfaceBuf& sb = it->second;
        wgpu::SharedTextureMemory& mem = producer ? sb.producerMem : sb.consumerMem;
        wgpu::Texture& tex = producer ? sb.producerTex : sb.consumerTex;
        // Producer waits the consumer's last fence; consumer waits the
        // producer's last fence.
        wgpu::SharedFence& wait = producer ? sb.consumerFence : sb.producerFence;
        // First producer access begins UNDEFINED + uninitialized; all
        // else continues from the last reported layout, initialized.
        bool firstProduce = producer && !sb.everProduced;
        wgpu::SharedTextureMemoryVkImageLayoutBeginState layout{};
        layout.oldLayout = firstProduce ? 0 : sb.layout;
        layout.newLayout = 1;  // GENERAL (render + sample capable)
        wgpu::SharedTextureMemoryBeginAccessDescriptor bad{};
        bad.nextInChain = &layout;
        bad.initialized = !firstProduce;
        uint64_t signaled = 1;
        if (wait) {
            bad.fenceCount = 1;
            bad.fences = &wait;
            bad.signaledValueCount = 1;
            bad.signaledValues = &signaled;
        } else {
            bad.fenceCount = 0;
        }
        if (mem.BeginAccess(tex, &bad) != wgpu::Status::Success) {
            std::fprintf(stderr, "[gpu] %sBegin: BeginAccess failed (buf=%u)\n",
                         producer ? "Producer" : "Consumer", surfaceBufId);
            return false;
        }
        if (producer) { sb.everProduced = true; sb.producerOpen = true; }
        else sb.consumerOpen = true;
        return true;
    };

    // AllocSurfaceBuf-inject cross-channel ordering lives on each PluginConn's
    // `barrier` (ipc::WireBarrier). drainPluginBarriers below drains them after
    // each plugin-wire pump. Tag scheme:
    //   - AllocSurfaceBuf:  tag = allocSurfaceBufTag(surfaceBufId)
    // (The tag is only used by ReleaseSurfaceBuf to cancel a pending inject whose
    // serial may never arrive. Producer/consumer Begin/End no longer use the
    // barrier -- they ride the wire in-band, ordered by FIFO.)
    auto allocSurfaceBufTag = [](uint32_t bufId) -> ipc::WireBarrier::Tag {
        return (static_cast<ipc::WireBarrier::Tag>(2) << 32) |
               static_cast<ipc::WireBarrier::Tag>(bufId);
    };
    auto drainPluginBarriers = [&]() {
        for (auto& c : pluginConns)
            c->barrier.drain(c->reader->bytesConsumed());
    };

    // Import a client dmabuf (fd owned by us) and inject the texture. Sends the
    // ClientTexImported reply. Caller must ensure the wire reader has reached
    // m.wireSerial first (so the prior UnregisterObjectCmd for this recycled
    // handle id has been applied). Closes fd.
    //
    // Does NOT open a BeginAccess bracket -- the per-frame Begin/End model
    // opens one per compositing submit (BeginClientAccess). The cached entry
    // starts at layout=0 (UNDEFINED), accessOpen=false, lastEndFence=null.
    auto runImport = [&](const ipc::Message& m, int fd) {
        ipc::Message reply{};
        reply.tag = ipc::Tag::ClientTexImported;
        reply.texture = m.texture;
        reply.importOk = 0;

        gpu::DmabufBuffer cb{};
        cb.fd = fd;
        cb.modifier = m.modifier;
        cb.stride = m.planeStride;
        cb.offset = m.planeOffset;
        cb.width = m.width;
        cb.height = m.height;
        cb.bo = nullptr;

        ClientTex ct{};
        bool ok = gpu::Allocator::importTexture(coreDevice, m.drmFourcc, cb, ct.mem, ct.tex);
        if (ok && !server.InjectTexture(ct.tex.Get(),
                                        {m.texture.id, m.texture.generation},
                                        {m.device.id, m.device.generation})) {
            std::fprintf(stderr, "[gpu] ImportClientTex: InjectTexture failed\n");
            ok = false;
        }
        if (ok) {
            serializer.Flush();
            ct.fd = cb.fd;
            ct.generation = m.texture.generation;
            clientTextures[m.texture.id] = std::move(ct);
            reply.importOk = 1;
        } else {
            ::close(cb.fd);
        }
        ipc::sendMessage(ctrlFd, reply);
    };

    // Open a per-frame BeginAccess on a cached client texture. Re-exports the
    // dmabuf's implicit-sync acquire fence at THIS moment (covers all of the
    // client's writes up to now, including ones from re-commits since the last
    // sample -- this is the fix for the same-buffer re-commit flicker), and
    // chains the prior frame's EndAccess fence too. Sends BeginClientAccessDone
    // back (round-trip; the core only flushes wire sample commands after the
    // reply lands, because ctrl-after-wire is the only one-way ordering the
    // existing infrastructure provides).
    auto runBeginClientAccess = [&](uint32_t textureId, uint32_t textureGen) -> bool {
        auto it = clientTextures.find(textureId);
        if (it == clientTextures.end() || it->second.generation != textureGen) {
            std::fprintf(stderr,
                "[gpu] BeginClientAccess: unknown texture {%u,%u}\n",
                textureId, textureGen);
            return false;
        }
        ClientTex& ct = it->second;
        if (ct.accessOpen) {
            // Two begins without an end on the same texture would be a Dawn
            // device error ("is already used to access"). The state machine
            // (src/gpu/client-buffer-lifecycle.ts) enforces this too, but
            // defending here gives a typed error attribution to the bufferId
            // rather than letting Dawn fault the device.
            std::fprintf(stderr,
                "[gpu] BeginClientAccess: bracket already open on {%u,%u}\n",
                textureId, textureGen);
            return false;
        }

        // Acquire fence: the dmabuf's current implicit-sync read-acquire
        // sync_file. Covers every write the client has issued on this dmabuf
        // up to this ioctl. Re-running the ioctl per-frame is the per-commit
        // re-export the spec calls for (functionally equivalent: the latest
        // sync_file dominates any earlier one).
        int syncFd = exportDmabufAcquireFence(ct.fd);
        wgpu::SharedFence acquireFence;
        if (syncFd >= 0) {
            wgpu::SharedFenceSyncFDDescriptor sfd{};
            sfd.handle = syncFd;
            wgpu::SharedFenceDescriptor fdd{};
            fdd.nextInChain = &sfd;
            acquireFence = coreDevice.ImportSharedFence(&fdd);
            ::close(syncFd);
        }

        // Chain the prior frame's EndAccess fence (Dawn's per-access fence
        // chaining: each Begin waits on the prior End's exported fence).
        // Both the acquire fence and the chain fence go into bad.fences[].
        wgpu::SharedFence fences[2];
        uint64_t signaledValues[2] = {1, 1};
        size_t fenceCount = 0;
        if (acquireFence) fences[fenceCount++] = acquireFence;
        if (ct.lastEndFence) fences[fenceCount++] = ct.lastEndFence;

        wgpu::SharedTextureMemoryVkImageLayoutBeginState layoutBegin{};
        // First-ever Begin: oldLayout=0 (UNDEFINED) + initialized=false (the
        // first commit hasn't written via OUR access yet -- but the CLIENT did
        // write the pixels, so initialized=true is actually correct here too;
        // mirrors the prior import-time BeginAccess descriptor). Subsequent:
        // continue from the previous EndAccess's newLayout.
        layoutBegin.oldLayout = ct.everSampled ? ct.layout : 0;
        layoutBegin.newLayout = 1;  // GENERAL
        wgpu::SharedTextureMemoryBeginAccessDescriptor bad{};
        bad.nextInChain = &layoutBegin;
        bad.initialized = true;
        bad.fenceCount = fenceCount;
        bad.fences = fenceCount ? fences : nullptr;
        bad.signaledValueCount = fenceCount;
        bad.signaledValues = fenceCount ? signaledValues : nullptr;
        if (ct.mem.BeginAccess(ct.tex, &bad) != wgpu::Status::Success) {
            std::fprintf(stderr,
                "[gpu] BeginClientAccess: Dawn BeginAccess failed {%u,%u}\n",
                textureId, textureGen);
            return false;
        }
        ct.accessOpen = true;
        ct.everSampled = true;
        return true;
    };

    // Close the per-frame BeginAccess bracket. Stores the exported fence on
    // the entry for the next BeginAccess to chain. The fence stays in-process
    // (both sides of the chain are this same coreDevice), so no SCM_RIGHTS
    // fd hand-back is needed.
    auto runEndClientAccess = [&](uint32_t textureId, uint32_t textureGen) {
        auto it = clientTextures.find(textureId);
        if (it == clientTextures.end() || it->second.generation != textureGen) {
            // The cache entry was released (bufferDestroyed) between the
            // core's send of EndClientAccess and the barrier draining it.
            // Nothing to do; the entry is gone, the Begin's bracket went away
            // with the Dawn texture.
            return;
        }
        ClientTex& ct = it->second;
        if (!ct.accessOpen) {
            std::fprintf(stderr,
                "[gpu] EndClientAccess: no open bracket on {%u,%u}\n",
                textureId, textureGen);
            return;
        }
        wgpu::SharedTextureMemoryVkImageLayoutEndState endLayout{};
        wgpu::SharedTextureMemoryEndAccessState endState{};
        endState.nextInChain = &endLayout;
        if (ct.mem.EndAccess(ct.tex, &endState) != wgpu::Status::Success) {
            std::fprintf(stderr,
                "[gpu] EndClientAccess: Dawn EndAccess failed {%u,%u}\n",
                textureId, textureGen);
            ct.accessOpen = false;  // cleared even on failure -- Dawn rejects future begins anyway
            return;
        }
        ct.accessOpen = false;
        ct.layout = endLayout.newLayout;
        // Re-import the exported fence into the SAME coreDevice for the next
        // BeginAccess to chain. Mirrors runSurfaceEnd's pattern but consumer-
        // side and intra-process.
        ct.lastEndFence = nullptr;
        if (endState.fenceCount >= 1) {
            wgpu::SharedFenceExportInfo exp{};
            wgpu::SharedFenceSyncFDExportInfo syncExp{};
            exp.nextInChain = &syncExp;
            endState.fences[0].ExportInfo(&exp);
            if (syncExp.handle >= 0) {
                int dupFd = ::dup(syncExp.handle);
                if (dupFd >= 0) {
                    wgpu::SharedFenceSyncFDDescriptor sfd{};
                    sfd.handle = dupFd;
                    wgpu::SharedFenceDescriptor fdd{};
                    fdd.nextInChain = &sfd;
                    ct.lastEndFence = coreDevice.ImportSharedFence(&fdd);
                    ::close(dupFd);
                }
            }
        }
    };

    // In-band core-wire control-frame dispatch (kind=1 BeginAccess / kind=2
    // EndAccess). The frame is FIFO-ordered against the Dawn (kind=0) commands
    // around it: a kind=1 written before the sample's kind=0 batch is processed
    // first (bracket open before HandleCommands reaches the sample); a kind=2
    // written after the submit's kind=0 batch is processed after it (bracket
    // closed only once the sample commands are decoded). No ctrl round-trip, no
    // WireBarrier.
    //
    // Failure paths HARD-FAIL (abort): per the in-band design, "unknown texture"
    // / "bracket already open" / Dawn rejection are state-machine or JS-gate bugs,
    // not transient races. The old ctrl path soft-failed (reply ok=0, skip the
    // surface), which masked the bug as a silent glitch. A loud abort surfaces it.
    dispatchCoreControlFrame = [&](ipc::FrameKind kind, const std::vector<uint8_t>& frame) {
        if (frame.empty()) {
            std::fprintf(stderr, "[gpu] core wire: empty control frame\n");
            std::abort();
        }
        auto variant = static_cast<ipc::AccessVariant>(frame[0]);
        if (variant == ipc::AccessVariant::ClientTex) {
            if (frame.size() != ipc::ClientTexAccessPayload::kSize) {
                std::fprintf(stderr, "[gpu] core wire: bad ClientTex payload size %zu\n",
                             frame.size());
                std::abort();
            }
            uint32_t texId = ipc::getU32LE(frame.data() + 1);
            uint32_t texGen = ipc::getU32LE(frame.data() + 5);
            bool ok = (kind == ipc::FrameKind::BeginAccess)
                          ? runBeginClientAccess(texId, texGen)
                          : (runEndClientAccess(texId, texGen), true);
            if (!ok) {
                std::fprintf(stderr,
                    "[gpu] in-band client-texture Begin failed {%u,%u} -- "
                    "JS import gate or state-machine bug\n", texId, texGen);
                std::abort();
            }
        } else if (variant == ipc::AccessVariant::Surface) {
            if (frame.size() != ipc::SurfaceAccessPayload::kSize) {
                std::fprintf(stderr, "[gpu] core wire: bad Surface payload size %zu\n",
                             frame.size());
                std::abort();
            }
            uint32_t surfaceBufId = ipc::getU32LE(frame.data() + 1);
            bool producer = frame[5] != 0;
            // A Surface frame's role (producer vs consumer) must match the wire
            // it rode in on, per the SurfaceBuf's direction:
            //   producerOnCore=false: core wire carries CONSUMER frames only.
            //   producerOnCore=true:  core wire carries PRODUCER frames only.
            // The payload's `producer` bit is a self-consistency check.
            // Direction validation: if the surface still exists, the role
            // bit MUST match its direction. Missing surface = release race
            // (in-band End frames written before destroy can land after the
            // surface is gone); handle the same way runSurface{Begin,End}
            // did before this refactor -- log + skip for End, abort for
            // Begin (a Begin against a freed surface is a real bug).
            auto it = surfaceBufs.find(surfaceBufId);
            if (it != surfaceBufs.end()) {
                const bool expectProducer = it->second.producerOnCore;
                if (producer != expectProducer) {
                    std::fprintf(stderr, "[gpu] core wire: %s frame on core wire "
                                 "(buf=%u producerOnCore=%d) -- wrong socket\n",
                                 producer ? "producer" : "consumer",
                                 surfaceBufId, static_cast<int>(expectProducer));
                    std::abort();
                }
            }
            if (kind == ipc::FrameKind::BeginAccess) {
                if (!runSurfaceBegin(surfaceBufId, producer)) {
                    std::fprintf(stderr,
                        "[gpu] in-band %s Begin failed (buf=%u) -- "
                        "JS gate or state-machine bug\n",
                        producer ? "producer" : "consumer", surfaceBufId);
                    std::abort();
                }
            } else {
                runSurfaceEnd(surfaceBufId, producer);
            }
        } else {
            std::fprintf(stderr, "[gpu] core wire: unknown access variant %u\n",
                         static_cast<unsigned>(frame[0]));
            std::abort();
        }
    };

    // Drain the core wire barrier: any deferred ctrl op whose serial the wire
    // reader has now passed runs in FIFO order. Replaces the old hand-rolled
    // pendingImports vector + walk.
    auto drainCoreBarrier = [&]() {
        coreWireBarrier.drain(wireReader.bytesConsumed());
    };

    // Control-message dispatch. Returns false if the core requested shutdown.
    auto dispatchCtrl = [&](const ipc::Message& m, int* recvFds, int nRecvFds) -> bool {
        {
            if (m.tag == ipc::Tag::Shutdown) {
                shutdown = true;
            } else if (m.tag == ipc::Tag::AddWireConn) {
                // Register a new plugin wire connection from the fd the core sent
                // (SCM_RIGHTS). No listening socket: only the trusted core, over
                // this side channel, can introduce a connection.
                ipc::Message reply{};
                reply.tag = ipc::Tag::WireConnAdded;
                reply.connId = m.connId;
                reply.ok = 0;
                if (nRecvFds < 1) {
                    std::fprintf(stderr, "[gpu] AddWireConn: no fd received\n");
                    ipc::sendMessage(ctrlFd, reply);
                } else {
                    int connFd = recvFds[0];
                    ipc::setNonBlocking(connFd);
                    const int wb = 8 * 1024 * 1024;
                    ::setsockopt(connFd, SOL_SOCKET, SO_SNDBUF, &wb, sizeof(wb));
                    ::setsockopt(connFd, SOL_SOCKET, SO_RCVBUF, &wb, sizeof(wb));
                    auto pc = std::make_unique<PluginConn>();
                    pc->connId = m.connId;
                    pc->fd = connFd;
                    pc->serializer = std::make_unique<ipc::FdSerializer>(connFd);
                    pc->reader = std::make_unique<ipc::FrameReader>(connFd);
                    pc->instance = std::make_unique<dawn::native::Instance>();
                    dawn::wire::WireServerDescriptor wsd2{};
                    wsd2.procs = &dawn::native::GetProcs();
                    wsd2.serializer = pc->serializer.get();
                    wsd2.useSpontaneousCallbacks = true;  // RequestDevice cb over wire
                    pc->server = std::make_unique<dawn::wire::WireServer>(wsd2);
                    // In-band producer Begin/End dispatch on this plugin wire.
                    // Only producer Surface frames are valid here (the consumer
                    // rides the core wire). Hard-fail on anything else.
                    const uint32_t connId = m.connId;
                    pc->dispatchControl =
                        [&runSurfaceBegin, &runSurfaceEnd, &surfaceBufs, connId](
                            ipc::FrameKind kind, const std::vector<uint8_t>& frame) {
                        if (frame.size() != ipc::SurfaceAccessPayload::kSize ||
                            static_cast<ipc::AccessVariant>(frame[0]) != ipc::AccessVariant::Surface) {
                            std::fprintf(stderr,
                                "[gpu] plugin conn %u: non-Surface control frame\n", connId);
                            std::abort();
                        }
                        uint32_t surfaceBufId = ipc::getU32LE(frame.data() + 1);
                        bool producer = frame[5] != 0;
                        // Plugin wire's role expectation is inverted from the
                        // core wire: producerOnCore=false -> plugin produces ->
                        // plugin wire carries PRODUCER frames; producerOnCore=
                        // true (compose buf) -> plugin consumes -> plugin wire
                        // carries CONSUMER frames. Missing surface = release
                        // race -- silently skip on End, abort on Begin
                        // (matches pre-refactor behavior).
                        auto it = surfaceBufs.find(surfaceBufId);
                        if (it != surfaceBufs.end()) {
                            const bool expectProducer = !it->second.producerOnCore;
                            if (producer != expectProducer) {
                                std::fprintf(stderr,
                                    "[gpu] plugin conn %u: %s frame on plugin wire "
                                    "(buf=%u producerOnCore=%d) -- wrong socket\n",
                                    connId, producer ? "producer" : "consumer",
                                    surfaceBufId, static_cast<int>(it->second.producerOnCore));
                                std::abort();
                            }
                        }
                        if (kind == ipc::FrameKind::BeginAccess) {
                            if (!runSurfaceBegin(surfaceBufId, producer)) {
                                std::fprintf(stderr,
                                    "[gpu] in-band %s Begin failed (buf=%u) -- "
                                    "JS gate or state-machine bug\n",
                                    producer ? "producer" : "consumer", surfaceBufId);
                                std::abort();
                            }
                        } else {
                            runSurfaceEnd(surfaceBufId, producer);
                        }
                    };
                    std::printf("[gpu] AddWireConn: connId=%u fd=%d registered\n",
                                m.connId, connFd);
                    pluginConns.push_back(std::move(pc));
                    reply.ok = 1;
                    ipc::sendMessage(ctrlFd, reply);
                }
            } else if (m.tag == ipc::Tag::InjectPluginInstance) {
                // Inject the connection's native instance at the handle the
                // plugin's wire client reserved (relayed by the core). Mirrors the
                // core's own ReserveInstance/InjectInstance bring-up.
                ipc::Message reply{};
                reply.tag = ipc::Tag::PluginInstanceInjected;
                reply.connId = m.connId;
                reply.ok = 0;
                PluginConn* pc = nullptr;
                for (auto& c : pluginConns) if (c->connId == m.connId) { pc = c.get(); break; }
                if (!pc) {
                    std::fprintf(stderr, "[gpu] InjectPluginInstance: unknown connId=%u\n", m.connId);
                } else if (!pc->server->InjectInstance(pc->instance->Get(),
                                                       {m.instance.id, m.instance.generation})) {
                    std::fprintf(stderr, "[gpu] InjectPluginInstance: InjectInstance failed\n");
                } else {
                    pc->serializer->Flush();
                    std::printf("[gpu] InjectPluginInstance: connId=%u instance {%u,%u}\n",
                                m.connId, m.instance.id, m.instance.generation);
                    reply.ok = 1;
                }
                ipc::sendMessage(ctrlFd, reply);
            } else if (m.tag == ipc::Tag::SetPluginTickDevice) {
                // Resolve the plugin device + tick it each pump so its queue
                // advances (map/work-done complete). Without this the plugin
                // device's async ops never resolve.
                PluginConn* pc = nullptr;
                for (auto& c : pluginConns) if (c->connId == m.connId) { pc = c.get(); break; }
                if (pc) {
                    WGPUDevice dev = pc->server->GetDevice(m.device.id, m.device.generation);
                    if (dev) {
                        pc->tickDev = dev;
                        std::fprintf(stderr, "[gpu] SetPluginTickDevice: connId=%u dev{%u,%u} ok\n",
                                     m.connId, m.device.id, m.device.generation);
                    } else {
                        std::fprintf(stderr, "[gpu] SetPluginTickDevice: GetDevice null connId=%u\n", m.connId);
                    }
                }
            } else if (m.tag == ipc::Tag::AllocSurfaceBuf) {
                // Allocate ONE GBM dmabuf; import into the plugin (producer) and
                // core (consumer) devices; inject a texture at each side's
                // reserved handle. The producer/consumer surface buffer.
                //
                // The two InjectTextures are gated on cross-channel ordering
                // barriers: the producer-side inject must wait for the plugin
                // wire reader to have applied the new ReserveTexture (and any
                // prior UnregisterObjectCmd recycling its id); the consumer-side
                // inject likewise on the core wire reader. Either reader may
                // already be past its serial -> after() runs immediately; else
                // FIFO-queues until the drain catches up. The reply is sent only
                // after BOTH injects ran (a small shared-state struct counts).
                PluginConn* pc = nullptr;
                for (auto& c : pluginConns) if (c->connId == m.connId) { pc = c.get(); break; }
                WGPUDevice pluginNative = pc ?
                    pc->server->GetDevice(m.pluginDevice.id, m.pluginDevice.generation) : nullptr;
                WGPUDevice coreNative =
                    server.GetDevice(m.device.id, m.device.generation);
                if (!pc || !pluginNative || !coreNative) {
                    std::fprintf(stderr, "[gpu] AllocSurfaceBuf: device resolve failed "
                                 "(pc=%d plugin=%p core=%p)\n", pc ? 1 : 0,
                                 static_cast<void*>(pluginNative), static_cast<void*>(coreNative));
                    ipc::Message reply{};
                    reply.tag = ipc::Tag::SurfaceBufAllocated;
                    reply.surfaceBufId = m.surfaceBufId;
                    reply.connId = m.connId;
                    reply.ok = 0;
                    ipc::sendMessage(ctrlFd, reply);
                } else {
                    if (!pc->tickDev) pc->tickDev = pluginNative;
                    SurfaceBuf sb{};
                    wgpu::Device pluginDev(pluginNative);
                    wgpu::Device coreDev(coreNative);
                    bool ok = alloc.allocate(m.width, m.height, sb.buf);
                    if (ok) ok = gpu::Allocator::importTexture(
                        pluginDev, alloc.fourcc(), sb.buf, sb.producerMem, sb.producerTex);
                    if (ok) ok = gpu::Allocator::importTexture(
                        coreDev, alloc.fourcc(), sb.buf, sb.consumerMem, sb.consumerTex);
                    if (!ok) {
                        std::fprintf(stderr, "[gpu] AllocSurfaceBuf id=%u: alloc/import failed\n",
                                     m.surfaceBufId);
                        alloc.release(sb.buf);
                        ipc::Message reply{};
                        reply.tag = ipc::Tag::SurfaceBufAllocated;
                        reply.surfaceBufId = m.surfaceBufId;
                        reply.connId = m.connId;
                        reply.ok = 0;
                        ipc::sendMessage(ctrlFd, reply);
                    } else {
                        // Stage the SurfaceBuf NOW (its textures/STMs are imported on
                        // both devices). The deferred injects move it into surfaceBufs
                        // once both are in. The shared state below counts down the two
                        // sides; the second one that runs fires the reply.
                        sb.producerDev = pluginDev;
                        sb.consumerDev = coreDev;
                        sb.connId = m.connId;
                        struct InjectState {
                            ipc::Message msg;
                            SurfaceBuf sb;
                            int remaining = 2;
                            bool producerOk = false;
                            bool consumerOk = false;
                        };
                        auto state = std::make_shared<InjectState>();
                        state->msg = m;
                        state->sb = std::move(sb);
                        // Lambda: send the SurfaceBufAllocated reply, finalize.
                        auto finalize = [&surfaceBufs, &alloc, &serializer, ctrlFd, state]() {
                            ipc::Message reply{};
                            reply.tag = ipc::Tag::SurfaceBufAllocated;
                            reply.surfaceBufId = state->msg.surfaceBufId;
                            reply.connId = state->msg.connId;
                            const bool ok = state->producerOk && state->consumerOk;
                            reply.ok = ok ? 1 : 0;
                            if (ok) {
                                std::printf("[gpu] AllocSurfaceBuf id=%u %ux%u: imported on plugin+core, injected\n",
                                            state->msg.surfaceBufId, state->msg.width, state->msg.height);
                                surfaceBufs[state->msg.surfaceBufId] = std::move(state->sb);
                                serializer.Flush();
                            } else {
                                std::fprintf(stderr, "[gpu] AllocSurfaceBuf id=%u: inject failed (p=%d c=%d)\n",
                                             state->msg.surfaceBufId,
                                             static_cast<int>(state->producerOk),
                                             static_cast<int>(state->consumerOk));
                                state->sb.producerTex = nullptr;
                                state->sb.producerMem = nullptr;
                                state->sb.consumerTex = nullptr;
                                state->sb.consumerMem = nullptr;
                                alloc.release(state->sb.buf);
                            }
                            ipc::sendMessage(ctrlFd, reply);
                        };
                        // Producer-side InjectTexture, deferred on plugin barrier.
                        pc->barrier.after(
                            m.reservePointSerial,
                            [pc, state, finalize]() {
                                state->producerOk = pc->server->InjectTexture(
                                    state->sb.producerTex.Get(),
                                    {state->msg.pluginTexture.id, state->msg.pluginTexture.generation},
                                    {state->msg.pluginDevice.id, state->msg.pluginDevice.generation});
                                if (state->producerOk) pc->serializer->Flush();
                                if (--state->remaining == 0) finalize();
                            },
                            pc->reader->bytesConsumed(),
                            allocSurfaceBufTag(m.surfaceBufId));
                        // Consumer-side InjectTexture, deferred on core barrier.
                        coreWireBarrier.after(
                            m.wireSerial,
                            [&server, &serializer, state, finalize]() {
                                state->consumerOk = server.InjectTexture(
                                    state->sb.consumerTex.Get(),
                                    {state->msg.texture.id, state->msg.texture.generation},
                                    {state->msg.device.id, state->msg.device.generation});
                                if (state->consumerOk) serializer.Flush();
                                if (--state->remaining == 0) finalize();
                            },
                            wireReader.bytesConsumed());
                    }
                }
            } else if (m.tag == ipc::Tag::ReleaseSurfaceBuf) {
                 // Destroy a ring slot's surfaceBuf. The core sends this only after it
                 // has gated on its own GPU read completing (afterCurrentFrame), so no
                 // consumer read is in flight. End any still-open access bracket before
                 // dropping the SharedTextureMemory + textures + fences + dmabuf, or
                 // EndAccess/teardown would race an open bracket.
                 auto it = surfaceBufs.find(m.surfaceBufId);
                if (it != surfaceBufs.end()) {
                    SurfaceBuf& sb = it->second;
                    // Drop any deferred AllocSurfaceBuf inject for this buf on the
                    // owning plugin conn's barrier (its wire serial may never
                    // arrive now; a yet-to-run alloc inject would target a
                    // surfaceBuf we're tearing down). Producer/consumer End are
                    // in-band on the wire now, not deferred ctrl ops.
                    PluginConn* pc = nullptr;
                    for (auto& c : pluginConns)
                        if (c->connId == sb.connId) { pc = c.get(); break; }
                    if (pc) {
                        const auto aTag = allocSurfaceBufTag(m.surfaceBufId);
                        pc->barrier.cancel([aTag](ipc::WireBarrier::Tag t) {
                            return t == aTag;
                        });
                    }
                    if (sb.producerOpen) runSurfaceEnd(m.surfaceBufId, true);
                    if (sb.consumerOpen) runSurfaceEnd(m.surfaceBufId, false);
                    sb.producerFence = nullptr;
                    sb.consumerFence = nullptr;
                    sb.producerTex = nullptr;
                    sb.consumerTex = nullptr;
                    sb.producerMem = nullptr;
                    sb.consumerMem = nullptr;
                    alloc.release(sb.buf);     // closes the dmabuf fd + GBM bo
                    surfaceBufs.erase(it);
                }
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
            } else if (m.tag == ipc::Tag::ImportClientTex) {
                if (nRecvFds < 1) {
                    std::fprintf(stderr, "[gpu] ImportClientTex: no fd received (nRecvFds=%d)\n", nRecvFds);
                    ipc::Message reply{};
                    reply.tag = ipc::Tag::ClientTexImported;
                    reply.texture = m.texture;
                    reply.importOk = 0;
                    ipc::sendMessage(ctrlFd, reply);
                } else {
                    // Defer (or run immediately) via the core wire barrier: the
                    // inject must wait for the wire reader to have applied the
                    // prior UnregisterObjectCmd (recycling this handle id) and
                    // the new ReserveTexture. The action OWNS the fd; the side
                    // map `importPendingFds` exists ONLY for the shutdown sweep
                    // to close fds whose actions never ran.
                    const int fd = recvFds[0];
                    const ipc::Message msg = m;          // copy for the lambda
                    const uint32_t texId = m.texture.id;
                    importPendingFds[texId] = fd;
                    coreWireBarrier.after(
                        m.wireSerial,
                        [&importPendingFds, &runImport, msg, fd, texId]() {
                            importPendingFds.erase(texId);
                            runImport(msg, fd);
                        },
                        wireReader.bytesConsumed(),
                        importFdTag(texId));
                }
            } else if (m.tag == ipc::Tag::ReleaseClientTex) {
                // Release a JS-compositor dmabuf import: drop the STM + close the
                // fd, but only if the entry's generation still matches (the handle
                // id may have been recycled into a newer import).
                auto it = clientTextures.find(m.texture.id);
                if (it != clientTextures.end() && it->second.generation == m.texture.generation) {
                    ClientTex& ct = it->second;
                    // If a per-frame bracket is still open (the core released
                    // mid-frame -- typically a bug, but defensive), end it so
                    // the STM destructor doesn't run with a live access.
                    if (ct.accessOpen) {
                        wgpu::SharedTextureMemoryVkImageLayoutEndState endLayout{};
                        wgpu::SharedTextureMemoryEndAccessState endState{};
                        endState.nextInChain = &endLayout;
                        (void)ct.mem.EndAccess(ct.tex, &endState);
                        ct.accessOpen = false;
                    }
                    if (ct.fd >= 0) ::close(ct.fd);
                    clientTextures.erase(it);
                }
            }
        }
        return !shutdown;
    };

    // 9) Event-loop driven steady state. epoll over: wire fd (read always; write
    //    when outbound queued), ctrl fd (read), and the host wl_display fd (read;
    //    pump() does the prepare_read/read_events dance). A bounded timeout wakes
    //    us to advance Dawn (DeviceTick) and re-pump even when no fd is ready.
    //    Nothing here ever blocks in write(): the buffered serializer queues and
    //    the loop drains on EPOLLOUT -- this is what breaks the prior deadlock
    //    (single-threaded peer parked in write() while the other waited to read).
    auto loop = gpu::EventLoop::create();
    if (!loop) { std::fprintf(stderr, "[gpu] EventLoop create failed\n"); return 1; }

    auto armWire = [&] {
        uint32_t ev = gpu::EventLoop::kRead;
        if (serializer.hasPendingOut()) ev |= gpu::EventLoop::kWrite;
        loop->modify(wireFd, ev);
    };

    loop->add(wireFd, gpu::EventLoop::kRead, [&](uint32_t ready) {
        if (ready & gpu::EventLoop::kWrite) serializer.pumpOut();
        if (ready & gpu::EventLoop::kRead) { if (!pumpWire()) shutdown = true; }
        drainCoreBarrier();  // core wire advanced -> some deferred ctrl ops may be ready
        armWire();
    });
    loop->add(ctrlFd, gpu::EventLoop::kRead, [&](uint32_t) {
        ipc::Message m{};
        int recvFds[ipc::kMaxMsgFds];
        int nRecvFds = 0;
        while (ipc::recvMessageNBFds(ctrlFd, m, recvFds, &nRecvFds)) {
            dispatchCtrl(m, recvFds, nRecvFds);
            if (shutdown) break;
        }
        drainCoreBarrier();
        armWire();
    });
    int hostFd = window.displayFd();
    if (hostFd >= 0)
        loop->add(hostFd, gpu::EventLoop::kRead, [&](uint32_t) { window.pump(); });

    // Re-arm a plugin connection's epoll interest (write only when output queued).
    auto armPluginConn = [&](PluginConn* pc) {
        uint32_t ev = gpu::EventLoop::kRead;
        if (pc->serializer->hasPendingOut()) ev |= gpu::EventLoop::kWrite;
        loop->modify(pc->fd, ev);
    };
    // Register any plugin connection added at runtime (via AddWireConn) with the
    // event loop. Its callback pumps that connection's own WireServer + instance.
    auto registerPluginConns = [&] {
        for (auto& cptr : pluginConns) {
            if (cptr->registered) continue;
            PluginConn* pc = cptr.get();
            pc->registered = true;
            loop->add(pc->fd, gpu::EventLoop::kRead, [&, pc](uint32_t ready) {
                if (ready & gpu::EventLoop::kWrite) pc->serializer->pumpOut();
                if (ready & gpu::EventLoop::kRead) pc->pump();
                // Plugin wire reader advanced -> deferred producer-end / alloc
                // inject for this connection may now be satisfied.
                pc->barrier.drain(pc->reader->bytesConsumed());
                armPluginConn(pc);
            });
        }
    };

    while (!shutdown && (headless || !window.shouldClose())) {
        loop->runOnce(8);   // 8ms cap: also advances Dawn + host pump below
        pumpWire();          // DeviceTick + drain wire, even with no fd ready
        drainCoreBarrier();
        registerPluginConns();          // pick up connections added this iteration
        for (auto& pc : pluginConns) pc->pump();  // advance each plugin connection
        drainPluginBarriers();          // fire deferred producer-end / alloc-inject when ready
        if (!headless) window.pump();  // service host events (no window headless)
        armWire();
        for (auto& pc : pluginConns) armPluginConn(pc.get());
    }

    for (auto& [id, ct] : clientTextures) {
        if (ct.accessOpen) {
            wgpu::SharedTextureMemoryVkImageLayoutEndState endLayout{};
            wgpu::SharedTextureMemoryEndAccessState endState{};
            endState.nextInChain = &endLayout;
            (void)ct.mem.EndAccess(ct.tex, &endState);
            ct.accessOpen = false;
        }
        ct.lastEndFence = nullptr;
        ct.tex = nullptr;
        ct.mem = nullptr;
        if (ct.fd >= 0) ::close(ct.fd);
    }
    clientTextures.clear();
    // Discard any deferred ctrl ops on the core barrier (their wire serial may
    // never arrive). The action captures own no other state we need to close;
    // queued ImportClientTex fds are also tracked in `importPendingFds` so we
    // can close them here without inspecting std::function captures.
    coreWireBarrier.takePending();
    for (auto& [texId, fd] : importPendingFds) if (fd >= 0) ::close(fd);
    importPendingFds.clear();
    for (auto& [id, sb] : surfaceBufs) {
        sb.producerTex = nullptr; sb.producerMem = nullptr;
        sb.consumerTex = nullptr; sb.consumerMem = nullptr;
        alloc.release(sb.buf);
    }
    surfaceBufs.clear();
    for (auto& pc : pluginConns) {
        if (pc->registered) loop->remove(pc->fd);
        pc->barrier.takePending();  // drop deferred ops; no owned fds here
        pc->server.reset();
        pc->instance.reset();
        if (pc->fd >= 0) ::close(pc->fd);
    }
    pluginConns.clear();
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

// C-M1 verification: the two-device cross-device dmabuf-STM + sync-fd-fence
// round-trip the plugin producer/consumer primitive depends on. status.md flags
// this exact composition ("two-device cross-device sharing ... the sync-fd is
// produced but not waited on across a device boundary ... assumed to work,
// unverified"). This is the decisive in-process experiment: NO wire, NO core, NO
// Worker -- just two native wgpu::Devices sharing one GBM dmabuf, fence-gated.
//
// Flow: device A (producer) clears the dmabuf texture to a known color, EndAccess
// -> export sync-fd; device B (consumer) BeginAccess WAITING that fence, samples
// the dmabuf texture into an offscreen target, reads it back, asserts the color.
// The fence wait in B's BeginAccess is the ordering under test (producer-done-
// before-consumer-read on the GPU timeline, no CPU handshake).
//
// Reuses the proven primitives: Allocator::importTexture (per-device STM import),
// the EndAccess sync-fd export (single-device path), and the SharedFence import +
// wait-in-BeginAccess (the verified WSI implicit-sync acquire).
int selftestXDev() {
    std::printf("[gpu] selftest-xdev: two-device dmabuf STM + cross-device fence\n");

    dawn::native::Instance instance;
    wgpu::Instance inst(instance.Get());

    // A fresh adapter per device: a wgpu::Adapter creates a single device, and
    // the plugin topology gives each device its own adapter anyway. Enumerate
    // returns fresh Adapter instances per call.
    auto makeAdapter = [&]() -> wgpu::Adapter {
        wgpu::RequestAdapterOptions ao{};
        ao.backendType = wgpu::BackendType::Vulkan;
        ao.featureLevel = wgpu::FeatureLevel::Core;
        auto adapters = instance.EnumerateAdapters(
            reinterpret_cast<const WGPURequestAdapterOptions*>(&ao));
        return adapters.empty() ? wgpu::Adapter() : wgpu::Adapter(adapters[0].Get());
    };

    wgpu::Adapter probeAdapter = makeAdapter();
    if (!probeAdapter) { std::fprintf(stderr, "XDEV: FAIL (no adapter)\n"); return 1; }

    gpu::Allocator alloc;
    if (!alloc.open() || !alloc.probe(probeAdapter)) {
        std::fprintf(stderr, "XDEV: FAIL (allocator open/probe)\n"); return 1;
    }

    // Two independent native devices, each from its own adapter, each with the
    // dmabuf + sync-fd features.
    auto makeDevice = [&](const char* tag) -> wgpu::Device {
        wgpu::Adapter adapter = makeAdapter();
        if (!adapter) { std::fprintf(stderr, "[gpu] selftest: no adapter for %s\n", tag);
                        return wgpu::Device(); }
        wgpu::FeatureName feats[] = {wgpu::FeatureName::SharedTextureMemoryDmaBuf,
                                     wgpu::FeatureName::SharedFenceSyncFD};
        wgpu::DeviceDescriptor dd{};
        dd.requiredFeatureCount = 2;
        dd.requiredFeatures = feats;
        dd.SetUncapturedErrorCallback(
            [](const wgpu::Device&, wgpu::ErrorType t, wgpu::StringView m) {
                std::fprintf(stderr, "[gpu][selftest dawn err %d] %.*s\n",
                             static_cast<int>(t), static_cast<int>(m.length), m.data);
            });
        wgpu::Device dev;
        bool ready = false;
        adapter.RequestDevice(&dd, wgpu::CallbackMode::AllowProcessEvents,
            [&](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView msg) {
                if (s == wgpu::RequestDeviceStatus::Success) dev = std::move(d);
                else std::fprintf(stderr, "[gpu] selftest: RequestDevice(%s) status=%d: %.*s\n",
                                  tag, static_cast<int>(s),
                                  static_cast<int>(msg.length), msg.data);
                ready = true;
            });
        for (int i = 0; i < 100000 && !ready; ++i) {
            dawn::native::InstanceProcessEvents(instance.Get());
            usleepShort();
        }
        if (!dev) std::fprintf(stderr, "[gpu] selftest: RequestDevice(%s) failed (ready=%d)\n",
                               tag, static_cast<int>(ready));
        return dev;
    };
    wgpu::Device devA = makeDevice("producer");
    wgpu::Device devB = makeDevice("consumer");
    if (!devA || !devB) { std::fprintf(stderr, "XDEV: FAIL (device)\n"); return 1; }

    // One GBM dmabuf, imported into BOTH devices as SharedTextureMemory.
    const uint32_t W = 64, H = 64;
    gpu::DmabufBuffer buf{};
    if (!alloc.allocate(W, H, buf)) { std::fprintf(stderr, "XDEV: FAIL (allocate)\n"); return 1; }
    wgpu::SharedTextureMemory memA, memB;
    wgpu::Texture texA, texB;
    if (!gpu::Allocator::importTexture(devA, alloc.fourcc(), buf, memA, texA) ||
        !gpu::Allocator::importTexture(devB, alloc.fourcc(), buf, memB, texB)) {
        std::fprintf(stderr, "XDEV: FAIL (cross-device STM import)\n");
        alloc.release(buf); return 1;
    }

    // The known color the producer writes (BGRA8Unorm dmabuf; clearValue is RGBA
    // in linear/unorm terms -> stored bytes B,G,R,A). Use a distinct triple.
    const double R = 0.20, G = 0.40, B_ = 0.80;

    // --- Producer (device A): BeginAccess (undefined->general), clear, EndAccess.
    {
        wgpu::SharedTextureMemoryVkImageLayoutBeginState layout{};
        layout.oldLayout = 0;  // UNDEFINED
        layout.newLayout = 1;  // GENERAL
        wgpu::SharedTextureMemoryBeginAccessDescriptor bad{};
        bad.nextInChain = &layout;
        bad.initialized = false;
        bad.fenceCount = 0;
        if (memA.BeginAccess(texA, &bad) != wgpu::Status::Success) {
            std::fprintf(stderr, "XDEV: FAIL (producer BeginAccess)\n");
            alloc.release(buf); return 1;
        }
        wgpu::RenderPassColorAttachment att{};
        att.view = texA.CreateView();
        att.loadOp = wgpu::LoadOp::Clear;
        att.storeOp = wgpu::StoreOp::Store;
        att.clearValue = {R, G, B_, 1.0};
        wgpu::RenderPassDescriptor rp{};
        rp.colorAttachmentCount = 1;
        rp.colorAttachments = &att;
        wgpu::CommandEncoder enc = devA.CreateCommandEncoder();
        enc.BeginRenderPass(&rp).End();
        wgpu::CommandBuffer cb = enc.Finish();
        devA.GetQueue().Submit(1, &cb);

        wgpu::SharedTextureMemoryVkImageLayoutEndState endLayout{};
        wgpu::SharedTextureMemoryEndAccessState endState{};
        endState.nextInChain = &endLayout;
        if (memA.EndAccess(texA, &endState) != wgpu::Status::Success || endState.fenceCount < 1) {
            std::fprintf(stderr, "XDEV: FAIL (producer EndAccess; fenceCount=%zu)\n",
                         static_cast<size_t>(endState.fenceCount));
            alloc.release(buf); return 1;
        }
        // Export the producer's done-fence and dup it (the export fd is owned by
        // endState's SharedFence, freed when endState is destroyed at scope exit).
        wgpu::SharedFenceExportInfo exp{};
        wgpu::SharedFenceSyncFDExportInfo syncExp{};
        exp.nextInChain = &syncExp;
        endState.fences[0].ExportInfo(&exp);
        int producerSyncFd = (syncExp.handle >= 0) ? ::dup(syncExp.handle) : -1;
        int producerEndLayout = endLayout.newLayout;

        // --- Consumer (device B): BeginAccess WAITING the producer fence, sample.
        wgpu::SharedFence waitFence;
        if (producerSyncFd >= 0) {
            wgpu::SharedFenceSyncFDDescriptor sfd{};
            sfd.handle = producerSyncFd;
            wgpu::SharedFenceDescriptor fdd{};
            fdd.nextInChain = &sfd;
            waitFence = devB.ImportSharedFence(&fdd);
            ::close(producerSyncFd);
            if (!waitFence) { std::fprintf(stderr, "XDEV: FAIL (consumer ImportSharedFence)\n");
                              alloc.release(buf); return 1; }
        } else {
            std::fprintf(stderr, "XDEV: FAIL (no producer sync-fd to wait)\n");
            alloc.release(buf); return 1;
        }

        wgpu::SharedTextureMemoryVkImageLayoutBeginState clayout{};
        clayout.oldLayout = producerEndLayout;  // continue from producer's end layout
        clayout.newLayout = 1;                   // GENERAL
        wgpu::SharedTextureMemoryBeginAccessDescriptor cbad{};
        cbad.nextInChain = &clayout;
        cbad.initialized = true;
        uint64_t signaled = 1;
        cbad.fenceCount = 1;
        cbad.fences = &waitFence;
        cbad.signaledValueCount = 1;
        cbad.signaledValues = &signaled;
        if (memB.BeginAccess(texB, &cbad) != wgpu::Status::Success) {
            std::fprintf(stderr, "XDEV: FAIL (consumer BeginAccess+fence wait)\n");
            alloc.release(buf); return 1;
        }

        // Sample texB into an offscreen RGBA8 target (TextureBinding on the dmabuf
        // is always present; this avoids depending on CopySrc of the dmabuf). The
        // sampling submit is ordered AFTER the fence by BeginAccess.
        // textureLoad needs no sampler -> the auto layout has only the texture at
        // binding 1. Reading via textureLoad (integer coords) also sidesteps
        // filterable-vs-unfilterable float sampling on the imported format.
        const char* WGSL =
            "@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{"
            "var p=array<vec2f,3>(vec2f(-1,-3),vec2f(3,1),vec2f(-1,1));"
            "return vec4f(p[i],0,1);}"
            "@group(0) @binding(1) var t:texture_2d<f32>;"
            "@fragment fn fs(@builtin(position) c:vec4f)->@location(0) vec4f{"
            "return textureLoad(t, vec2i(i32(c.x),i32(c.y)), 0);}";
        wgpu::ShaderSourceWGSL wd{};
        wd.code = WGSL;
        wgpu::ShaderModuleDescriptor smd{};
        smd.nextInChain = &wd;
        wgpu::ShaderModule mod = devB.CreateShaderModule(&smd);

        wgpu::TextureDescriptor od{};
        od.size = {W, H, 1};
        od.format = wgpu::TextureFormat::RGBA8Unorm;
        od.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc;
        wgpu::Texture offscreen = devB.CreateTexture(&od);

        wgpu::ColorTargetState cts{};
        cts.format = wgpu::TextureFormat::RGBA8Unorm;
        wgpu::FragmentState fs{};
        fs.module = mod; fs.entryPoint = "fs"; fs.targetCount = 1; fs.targets = &cts;
        wgpu::RenderPipelineDescriptor pd{};
        pd.vertex.module = mod; pd.vertex.entryPoint = "vs";
        pd.primitive.topology = wgpu::PrimitiveTopology::TriangleList;
        pd.fragment = &fs;
        wgpu::RenderPipeline pipe = devB.CreateRenderPipeline(&pd);

        wgpu::BindGroupEntry bge[1]{};
        bge[0].binding = 1; bge[0].textureView = texB.CreateView();
        wgpu::BindGroupDescriptor bgd{};
        bgd.layout = pipe.GetBindGroupLayout(0);
        bgd.entryCount = 1; bgd.entries = bge;
        wgpu::BindGroup bg = devB.CreateBindGroup(&bgd);

        wgpu::RenderPassColorAttachment oatt{};
        oatt.view = offscreen.CreateView();
        oatt.loadOp = wgpu::LoadOp::Clear;
        oatt.storeOp = wgpu::StoreOp::Store;
        oatt.clearValue = {0, 0, 0, 1};
        wgpu::RenderPassDescriptor orp{};
        orp.colorAttachmentCount = 1; orp.colorAttachments = &oatt;

        const uint32_t bytesPerRow = 256;  // 64*4 padded to 256 (already 256)
        wgpu::BufferDescriptor rbd{};
        rbd.size = static_cast<uint64_t>(bytesPerRow) * H;
        rbd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
        wgpu::Buffer readback = devB.CreateBuffer(&rbd);

        wgpu::CommandEncoder cenc = devB.CreateCommandEncoder();
        {
            wgpu::RenderPassEncoder pe = cenc.BeginRenderPass(&orp);
            pe.SetPipeline(pipe);
            pe.SetBindGroup(0, bg);
            pe.Draw(3);
            pe.End();
        }
        wgpu::TexelCopyTextureInfo src{};
        src.texture = offscreen;
        wgpu::TexelCopyBufferInfo dst{};
        dst.buffer = readback;
        dst.layout.bytesPerRow = bytesPerRow;
        dst.layout.rowsPerImage = H;
        wgpu::Extent3D ext{W, H, 1};
        cenc.CopyTextureToBuffer(&src, &dst, &ext);
        wgpu::CommandBuffer ccb = cenc.Finish();
        devB.GetQueue().Submit(1, &ccb);

        // End the consumer access bracket before reading back (Vulkan layout
        // end-state is mandatory on this backend, as in the producer EndAccess).
        wgpu::SharedTextureMemoryVkImageLayoutEndState cEndLayout{};
        wgpu::SharedTextureMemoryEndAccessState cEnd{};
        cEnd.nextInChain = &cEndLayout;
        memB.EndAccess(texB, &cEnd);

        // Map the readback and assert the producer color (with tolerance).
        bool mapped = false; wgpu::MapAsyncStatus mapStatus{};
        readback.MapAsync(wgpu::MapMode::Read, 0, rbd.size,
            wgpu::CallbackMode::AllowProcessEvents,
            [&](wgpu::MapAsyncStatus s, wgpu::StringView) { mapStatus = s; mapped = true; });
        for (int i = 0; i < 100000 && !mapped; ++i) {
            dawn::native::DeviceTick(devB.Get());
            dawn::native::InstanceProcessEvents(instance.Get());
            usleepShort();
        }
        if (!mapped || mapStatus != wgpu::MapAsyncStatus::Success) {
            std::fprintf(stderr, "XDEV: FAIL (readback map mapped=%d status=%d)\n",
                         static_cast<int>(mapped), static_cast<int>(mapStatus));
            alloc.release(buf); return 1;
        }
        const uint8_t* px = static_cast<const uint8_t*>(
            readback.GetConstMappedRange(0, rbd.size));
        // Offscreen is RGBA8Unorm; expected bytes R,G,B,A from the producer color.
        auto u8 = [](double v) { return static_cast<int>(v * 255.0 + 0.5); };
        int eR = u8(R), eG = u8(G), eB = u8(B_);
        int gR = px[0], gG = px[1], gB = px[2], gA = px[3];
        readback.Unmap();
        alloc.release(buf);
        const int tol = 3;
        bool ok = std::abs(gR - eR) <= tol && std::abs(gG - eG) <= tol &&
                  std::abs(gB - eB) <= tol && std::abs(gA - 255) <= tol;
        std::printf("[gpu] selftest readback: got RGBA(%d,%d,%d,%d) expected (%d,%d,%d,255)\n",
                    gR, gG, gB, gA, eR, eG, eB);
        if (!ok) { std::fprintf(stderr, "XDEV: FAIL (pixel mismatch)\n"); return 1; }
    }

    std::printf("XDEV: PASS\n");
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    // Optional: redirect this process's stdout+stderr to a file (diagnostics --
    // the parent's fds may not be capturable by a test harness redirect).
    if (const char* lp = ::getenv("OVERDRAW_GPU_LOG")) {
        FILE* f = ::freopen(lp, "w", stderr);
        if (f) { ::dup2(::fileno(stderr), ::fileno(stdout)); setvbuf(stderr, nullptr, _IOLBF, 0); }
    }
    installCrashHandler();
    // C-M1 verification mode: two-device cross-device dmabuf STM + fence
    // round-trip. Self-contained (no fds, no core); prints XDEV: PASS/FAIL.
    if (argc >= 2 && std::strcmp(argv[1], "--selftest-xdev") == 0) {
        return selftestXDev();
    }
    if (argc < 3) {
        std::fprintf(stderr, "usage: %s <wireFd> <ctrlFd> [inputFd] [--headless WxH]\n", argv[0]);
        return 1;
    }
    int wireFd = std::atoi(argv[1]);
    int ctrlFd = std::atoi(argv[2]);
    // inputFd is optional: when absent (-1) the GPU process forwards no input.
    int inputFd = (argc >= 4 && argv[3][0] != '-') ? std::atoi(argv[3]) : -1;

    // Optional headless mode: "--headless WxH" anywhere after the fds. No host
    // window/surface; the core renders into an offscreen texture (tests).
    bool headless = false;
    uint32_t hw = 0, hh = 0;
    for (int i = 3; i < argc; ++i) {
        if (std::strcmp(argv[i], "--headless") == 0 && i + 1 < argc) {
            headless = true;
            std::sscanf(argv[i + 1], "%ux%u", &hw, &hh);
            ++i;
        }
    }
    if (headless && (hw == 0 || hh == 0)) { hw = 1280; hh = 720; }  // default
    return run(wireFd, ctrlFd, inputFd, headless, hw, hh);
}
