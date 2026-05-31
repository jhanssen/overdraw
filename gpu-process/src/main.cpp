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
#include <chrono>
#include <unordered_map>
#include <vector>

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

// Export a dmabuf's implicit READ-acquire fence (the producer's outstanding
// WRITE work) as a sync_file fd, so the consumer can make its GPU work wait on
// it. Returns -1 if unavailable (then there is nothing to wait on). This is the
// implicit-sync acquire a compositor must perform before sampling a client
// dmabuf that did not use explicit sync (wp_linux_drm_syncobj_v1). The returned
// fd is owned by the caller. (Mirrors wlroots' vulkan implicit-sync interop:
// export sync_file, then wait on it on the GPU timeline -- a CPU poll does NOT
// order the GPU work, so the fence must be imported into the access bracket.)
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
    auto pumpWire = [&]() -> bool {
        bool alive = wireReader.readAvailable();
        std::vector<uint8_t> frame;
        while (wireReader.nextFrame(frame)) {
            server.HandleCommands(reinterpret_cast<const char*>(frame.data()), frame.size());
            serializer.Flush();
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
    // a read-access bracket is begun at import so compositing can sample it.
    struct ClientTex {
        wgpu::SharedTextureMemory mem;
        wgpu::Texture tex;
        int fd = -1;
        uint32_t generation = 0;  // wire handle generation, for release matching
    };
    std::unordered_map<uint32_t, ClientTex> clientTextures;

    // ImportClientTex requests whose wireSerial the wire reader has not yet
    // reached. Held until wireReader.bytesConsumed() >= wireSerial so the prior
    // UnregisterObjectCmd (recycling this handle id) has been processed. fd owned.
    struct PendingImport { ipc::Message msg; int fd; };
    std::vector<PendingImport> pendingImports;

    // 9) Service Dawn + the host window until the core requests shutdown or the
    //    host window is closed. The core drives the swapchain over the wire.
    bool shutdown = false;

    // Import a client dmabuf (fd owned by us) and inject the texture. Sends the
    // ClientTexImported reply. Caller must ensure the wire reader has reached
    // m.wireSerial first (so the prior UnregisterObjectCmd for this recycled
    // handle id has been applied). Closes fd.
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
        if (ok) {
            int syncFd = exportDmabufAcquireFence(cb.fd);
            wgpu::SharedFence acquireFence;
            if (syncFd >= 0) {
                wgpu::SharedFenceSyncFDDescriptor sfd{};
                sfd.handle = syncFd;
                wgpu::SharedFenceDescriptor fdd{};
                fdd.nextInChain = &sfd;
                acquireFence = coreDevice.ImportSharedFence(&fdd);
                ::close(syncFd);
                if (!acquireFence) std::fprintf(stderr, "[gpu] ImportClientTex: ImportSharedFence failed\n");
            }
            wgpu::SharedTextureMemoryVkImageLayoutBeginState layout{};
            layout.oldLayout = 0;  // UNDEFINED
            layout.newLayout = 1;  // GENERAL
            wgpu::SharedTextureMemoryBeginAccessDescriptor bad{};
            bad.nextInChain = &layout;
            bad.initialized = true;
            uint64_t signaled = 1;
            if (acquireFence) {
                bad.fenceCount = 1;
                bad.fences = &acquireFence;
                bad.signaledValueCount = 1;
                bad.signaledValues = &signaled;
            } else {
                bad.fenceCount = 0;
            }
            if (ct.mem.BeginAccess(ct.tex, &bad) != wgpu::Status::Success) {
                std::fprintf(stderr, "[gpu] ImportClientTex: BeginAccess failed\n");
                ok = false;
            }
        }
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

    // Run any pending imports whose wireSerial the wire reader has now reached.
    auto drainPendingImports = [&]() {
        for (size_t i = 0; i < pendingImports.size();) {
            if (wireReader.bytesConsumed() >= pendingImports[i].msg.wireSerial) {
                runImport(pendingImports[i].msg, pendingImports[i].fd);
                pendingImports.erase(pendingImports.begin() + static_cast<long>(i));
            } else {
                ++i;
            }
        }
    };

    // Control-message dispatch. Returns false if the core requested shutdown.
    auto dispatchCtrl = [&](const ipc::Message& m, int* recvFds, int nRecvFds) -> bool {
        {
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
            } else if (m.tag == ipc::Tag::ImportClientTex) {
                if (nRecvFds < 1) {
                    std::fprintf(stderr, "[gpu] ImportClientTex: no fd received (nRecvFds=%d)\n", nRecvFds);
                    ipc::Message reply{};
                    reply.tag = ipc::Tag::ClientTexImported;
                    reply.texture = m.texture;
                    reply.importOk = 0;
                    ipc::sendMessage(ctrlFd, reply);
                } else if (wireReader.bytesConsumed() >= m.wireSerial) {
                    runImport(m, recvFds[0]);  // wire caught up: prior Unregister applied
                } else {
                    // Wire reader has not reached the serial yet; defer until it has
                    // (drainPendingImports runs after each wire pump). We own recvFds[0].
                    pendingImports.push_back({m, recvFds[0]});
                }
            } else if (m.tag == ipc::Tag::ReleaseClientTex) {
                // Release a JS-compositor dmabuf import: drop the STM + close the
                // fd, but only if the entry's generation still matches (the handle
                // id may have been recycled into a newer import).
                auto it = clientTextures.find(m.texture.id);
                if (it != clientTextures.end() && it->second.generation == m.texture.generation) {
                    if (it->second.fd >= 0) ::close(it->second.fd);
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
        drainPendingImports();  // wire advanced -> some deferred imports may be ready
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
        drainPendingImports();
        armWire();
    });
    int hostFd = window.displayFd();
    if (hostFd >= 0)
        loop->add(hostFd, gpu::EventLoop::kRead, [&](uint32_t) { window.pump(); });

    while (!shutdown && (headless || !window.shouldClose())) {
        loop->runOnce(8);   // 8ms cap: also advances Dawn + host pump below
        pumpWire();          // DeviceTick + drain wire, even with no fd ready
        drainPendingImports();
        if (!headless) window.pump();  // service host events (no window headless)
        armWire();
    }

    for (auto& [id, ct] : clientTextures) {
        ct.tex = nullptr;
        ct.mem = nullptr;
        if (ct.fd >= 0) ::close(ct.fd);
    }
    clientTextures.clear();
    for (auto& p : pendingImports) if (p.fd >= 0) ::close(p.fd);
    pendingImports.clear();
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
