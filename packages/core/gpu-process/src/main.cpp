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
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#include <string>

#include <linux/dma-buf.h>

#include "dawn/native/DawnNative.h"
#include "dawn/wire/WireServer.h"
#include "dawn/webgpu_cpp.h"

#include "allocator.h"
#include "event_loop.h"
#include "output_backend.h"
#include "output_host_window.h"
#if OVERDRAW_KMS
#include "kms_output.h"
#endif
#include "side_channel.h"
#include "transport.h"
#include "wire_barrier.h"

#include "log/log.h"
#include "log/ipc_sink.h"

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
        uint32_t headlessW, uint32_t headlessH, bool outputKms) {
    LOG_INFO(Gpu, "overdraw-gpu-process up: pid={} headless={} output={}",
             ::getpid(), headless ? "yes" : "no",
             headless ? "none" : (outputKms ? "kms" : "nested"));
    // 1) Output: in nested mode, an OutputBackend brings up the display target
    //    (HostWindowOutputBackend in phase 1 = a host Wayland output window the
    //    GPU process is a client of, forwarding host pointer/keyboard over
    //    inputFd; KmsOutputBackend in phase 2 = DRM/KMS scanout, no host).
    //    HEADLESS mode has no output target at all -- the core renders into an
    //    offscreen texture and reads it back (tests). The size is fixed from
    //    argv. `output` is null in headless mode.
    //
    //    KMS mode needs the DRM card fd from the core BEFORE open() can run.
    //    The core sends ipc::Tag::SetDrmFd (with the fd via SCM_RIGHTS) before
    //    Hello -- we receive it here, then construct + open the backend.
    std::unique_ptr<gpu::OutputBackend> output;
    // Borrowed (non-owning) pointer to the KMS-typed subclass, when KMS is
    // active. Used for KMS-specific calls (initScanout, presentScanout)
    // that aren't on the OutputBackend interface. nullptr in nested/headless.
    gpu::KmsOutputBackend* kms = nullptr;

    if (!headless) {
        if (outputKms) {
#if OVERDRAW_KMS
            // Wait for SetDrmFd ctrl msg.
            int drmFd = -1;
            {
                ipc::Message m{};
                int fds[ipc::kMaxMsgFds];
                int nfds = 0;
                for (int i = 0; i < 500000 && drmFd < 0; ++i) {
                    if (ipc::recvMessageNBFds(ctrlFd, m, fds, &nfds)
                        && m.tag == ipc::Tag::SetDrmFd) {
                        if (nfds >= 1) {
                            drmFd = fds[0];
                            for (int j = 1; j < nfds; ++j) ::close(fds[j]);
                        } else {
                            std::fprintf(stderr, "[gpu] SetDrmFd had no fd\n");
                            return 1;
                        }
                        break;
                    }
                    usleepShort();
                }
                if (drmFd < 0) {
                    std::fprintf(stderr, "[gpu] no SetDrmFd (kms requested)\n");
                    return 1;
                }
            }
            auto kmsUp = std::make_unique<gpu::KmsOutputBackend>(drmFd);
            if (!kmsUp->open("overdraw")) {
                std::fprintf(stderr, "[gpu] KmsOutputBackend::open failed\n");
                return 1;
            }
            const gpu::OutputSize sz = kmsUp->size();
            std::printf("[gpu] kms output %ux%u\n", sz.width, sz.height);
            kms = kmsUp.get();  // borrowed view
            output = std::move(kmsUp);  // OutputBackend takes ownership
#else
            std::fprintf(stderr, "[gpu] --output=kms requested but OVERDRAW_KMS=OFF at build\n");
            return 1;
#endif
        } else {
            output = std::make_unique<gpu::HostWindowOutputBackend>(inputFd);
            if (!output->open("overdraw")) {
                std::fprintf(stderr, "[gpu] failed to open host window (no WAYLAND_DISPLAY?)\n");
                return 1;
            }
            const gpu::OutputSize sz = output->size();
            std::printf("[gpu] host window %ux%u\n", sz.width, sz.height);
        }
    } else {
        std::printf("[gpu] HEADLESS %ux%u (no host window/surface)\n", headlessW, headlessH);
    }
    auto outW = [&] { return headless ? headlessW : output->size().width; };
    auto outH = [&] { return headless ? headlessH : output->size().height; };

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

    // Buffered non-blocking sender for steady-state ctrl replies. The core side
    // briefly stops draining whenever its Node thread is busy (frame render, JS
    // GC, etc.); a peer that backs up cannot wedge us as long as we never park
    // in a write. Bringup-phase sends (HelloReply, SurfaceReady, FeedbackData)
    // stay on blocking sendMessage by the contract in transport.h: the core is
    // actively recv-spinning for them so the buffer cannot fill, and the
    // recv-spin loop in this function does not pump CtrlSender, so queueing
    // wouldn't help anyway.
    ipc::CtrlSender ctrlSender(ctrlFd);

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
    // pre-bring-up), so a non-null check guards the bring-up window. The fds
    // pointer is non-null only for fd-bearing frames (ImportClientTex); the
    // dispatcher takes ownership of those fds.
    std::function<void(ipc::FrameKind, const std::vector<uint8_t>&,
                       const int*, int)> dispatchCoreControlFrame;

    auto pumpWire = [&]() -> bool {
        bool alive = wireReader.readAvailable();
        ipc::FrameKind kind;
        std::vector<uint8_t> frame;
        int recvFds[ipc::kMaxMsgFds];
        int nRecvFds = 0;
        while (wireReader.nextFrame(kind, frame, recvFds, &nRecvFds)) {
            if (kind == ipc::FrameKind::WireBytes) {
                server.HandleCommands(reinterpret_cast<const char*>(frame.data()), frame.size());
                serializer.Flush();
            } else if (dispatchCoreControlFrame) {
                dispatchCoreControlFrame(kind, frame, nRecvFds ? recvFds : nullptr, nRecvFds);
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

    // Read an adapter's DRM node numbers (WGPUAdapterPropertiesDrm chained on
    // GetInfo). has* is false when the backend exposes no DRM node (e.g. a CPU
    // adapter). Uses the C API on the borrowed handle to avoid touching refs.
    auto adapterDrm = [](WGPUAdapter h) {
        WGPUAdapterPropertiesDrm drm{};
        drm.chain.sType = WGPUSType_AdapterPropertiesDrm;
        WGPUAdapterInfo info{};
        info.nextInChain = &drm.chain;
        wgpuAdapterGetInfo(h, &info);
        wgpuAdapterInfoFreeMembers(info);
        return drm;
    };

    // Pick the adapter to drive the device. In KMS mode it must be the GPU
    // that owns the scanout card, otherwise GBM buffers allocated on that card
    // can't be imported into the device (cross-GPU). Match by the card's DRM
    // primary node. In nested/headless mode there is no card; take the first.
    size_t chosenIdx = 0;
    if (kms) {
        struct stat cst{};
        if (::fstat(kms->drmFd(), &cst) != 0) {
            std::perror("[gpu] fstat drm card fd");
            return 1;
        }
        const uint64_t wantMajor = major(cst.st_rdev);
        const uint64_t wantMinor = minor(cst.st_rdev);
        int found = -1;
        for (size_t i = 0; i < adapters.size(); i++) {
            WGPUAdapterPropertiesDrm drm = adapterDrm(adapters[i].Get());
            if (drm.hasPrimary && drm.primaryMajor == wantMajor
                && drm.primaryMinor == wantMinor) { found = (int)i; break; }
        }
        if (found < 0) {
            std::fprintf(stderr,
                "[gpu] no Vulkan adapter matches scanout card %llu:%llu "
                "(cross-GPU scanout is unsupported)\n",
                (unsigned long long)wantMajor, (unsigned long long)wantMinor);
            return 1;
        }
        chosenIdx = static_cast<size_t>(found);
    }

    // Open the GBM allocator on the chosen adapter's render node so allocation
    // and the device share a GPU. Falls back to renderD128 when the adapter
    // advertises no render node.
    std::string renderNode = "/dev/dri/renderD128";
    {
        WGPUAdapterPropertiesDrm drm = adapterDrm(adapters[chosenIdx].Get());
        if (drm.hasRender)
            renderNode = "/dev/dri/renderD" + std::to_string(drm.renderMinor);
    }
    std::printf("[gpu] selected adapter[%zu], render node %s\n",
                chosenIdx, renderNode.c_str());
    wgpu::Adapter adapter(adapters[chosenIdx].Get());

    // Nested: create the wgpu::Surface for this output from the backend.
    // Headless or KMS: no wgpu::Surface (KMS scans out via SharedTextureMemory
    // textures dual-imported from GBM, not via Dawn WSI). The KMS backend's
    // createWgpuSurface returns null intentionally; only the nested
    // HostWindowOutputBackend returns a real surface.
    wgpu::Surface surface;
    if (!headless && !outputKms) {
        surface = output->createWgpuSurface(inst);
        if (!surface) { std::fprintf(stderr, "[gpu] CreateSurface failed\n"); return 1; }
    }

    // B1: GBM allocator + Dawn DRM modifier probe (persistent: the allocator
    // owns the gbm device and any allocated bo for the rest of the run).
    std::printf("[gpu] adapter DawnDrmFormatCapabilities feature: %d  SharedTextureMemoryDmaBuf: %d\n",
                adapter.HasFeature(wgpu::FeatureName::DawnDrmFormatCapabilities) ? 1 : 0,
                adapter.HasFeature(wgpu::FeatureName::SharedTextureMemoryDmaBuf) ? 1 : 0);
    gpu::Allocator alloc;
    if (!alloc.open(renderNode.c_str())) { std::fprintf(stderr, "[gpu] allocator open failed\n"); return 1; }
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
    //
    // The swapchain config triple (format/presentMode/alphaMode) is cached in
    // outer scope so the resize handler can re-apply Configure with the same
    // values when the host window changes size.
    uint32_t surfaceFormat = static_cast<uint32_t>(WGPUTextureFormat_BGRA8Unorm);
    uint32_t surfacePresentMode = static_cast<uint32_t>(wgpu::PresentMode::Fifo);
    constexpr uint32_t kSurfaceAlphaMode = static_cast<uint32_t>(WGPUCompositeAlphaMode_Opaque);
    if (!headless && !outputKms) {
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
    if (caps.formatCount) {
        surfaceFormat = static_cast<uint32_t>(caps.formats[0]);
        for (size_t i = 0; i < caps.formatCount; ++i) {
            uint32_t f = static_cast<uint32_t>(caps.formats[i]);
            if (!isSrgb(f)) { surfaceFormat = f; break; }
        }
    }

    // Prefer Mailbox: GetCurrentTexture is a blocking wire call on the server's
    // single command thread, and FIFO blocks it whenever the host compositor
    // isn't consuming frames (e.g. the nested window is unviewed) -- which
    // stalls all other wire work behind it (buffer map, etc.). Mailbox never
    // blocks the acquire (it replaces the unpresented frame). Fall back to the
    // first advertised mode if Mailbox is unsupported.
    bool haveMailbox = false;
    for (size_t i = 0; i < caps.presentModeCount; ++i)
        if (caps.presentModes[i] == wgpu::PresentMode::Mailbox) haveMailbox = true;
    if (haveMailbox) surfacePresentMode = static_cast<uint32_t>(wgpu::PresentMode::Mailbox);
    else if (caps.presentModeCount) surfacePresentMode = static_cast<uint32_t>(caps.presentModes[0]);

    // 7) Inject the surface at the client's reserved handle.
    if (!server.InjectSurface(surface.Get(),
                              {ready.surface.id, ready.surface.generation},
                              {ready.instance.id, ready.instance.generation})) {
        std::fprintf(stderr, "[gpu] InjectSurface failed\n");
        return 1;
    }
    std::printf("[gpu] injected surface; format=%u\n", surfaceFormat);

    // 8) Tell the core the surface is ready (caps + size).
    {
        ipc::Message m{};
        m.tag = ipc::Tag::SurfaceReady;
        m.surface = ready.surface;
        m.format = surfaceFormat;
        m.presentMode = surfacePresentMode;
        m.alphaMode = kSurfaceAlphaMode;
        m.width = outW();
        m.height = outH();
        ipc::sendMessage(ctrlFd, m);
    }

    // 8b) Output descriptor: nested-window size + host-derived
    // refresh/scale/transform/physical, and overdraw-synthesized make/model/
    // name. Sent ONCE here so the core's state.outputs starts with real
    // values; the host wl_output bound during HostWindow::open() has its
    // first done burst by now (open() does the second roundtrip). A future
    // re-emit path (slice 3b) sends this again on host-window resize.
    {
        gpu::OutputDescriptorInfo info{};
        output->describeOutput(info);
        ipc::Message m{};
        m.tag = ipc::Tag::OutputDescriptor;
        m.outputId         = 0;  // the one output today; per-output when enumeration lands
        m.width            = info.width;
        m.height           = info.height;
        m.refreshMhz       = info.refreshMhz;
        m.outScale         = info.scale;
        m.outTransform     = info.transform;
        m.physicalWidthMm  = info.physicalWidthMm;
        m.physicalHeightMm = info.physicalHeightMm;
        std::memcpy(m.outputName,  info.name,  sizeof(m.outputName));
        std::memcpy(m.outputMake,  info.make,  sizeof(m.outputMake));
        std::memcpy(m.outputModel, info.model, sizeof(m.outputModel));
        ipc::sendMessage(ctrlFd, m);
        std::printf(
            "[gpu] sent OutputDescriptor: %ux%u @%umHz scale=%u xform=%u "
            "phys=%ux%umm name=%s make=%s model=%s\n",
            info.width, info.height, info.refreshMhz, info.scale, info.transform,
            info.physicalWidthMm, info.physicalHeightMm, info.name, info.make, info.model);
    }
    }  // if (!headless && !outputKms)

    // Wire-resolved core device (non-owning wrapper; addref'd by the ctor).
    wgpu::Device coreDevice(nativeDev);

    // --- Surface-buffer machinery (used by plugin overlays AND KMS scanout) ---
    // The full struct definition + helper lambdas live further down (search for
    // "Producer/consumer surface buffers"); only the forward declaration moves
    // up here so the KMS bring-up below can populate the map before the
    // lambdas exist. The lambdas operate on the same `surfaceBufs` map and
    // see entries seeded by KMS bring-up.
    struct SurfaceBuf {
        uint32_t connId = 0;
        gpu::DmabufBuffer buf;
        bool producerOnCore = false;
        wgpu::SharedTextureMemory producerMem;
        wgpu::Texture producerTex;
        wgpu::Device producerDev;
        wgpu::SharedTextureMemory consumerMem;
        wgpu::Texture consumerTex;
        wgpu::Device consumerDev;
        int32_t layout = 0;
        bool everProduced = false;
        bool producerOpen = false;
        bool consumerOpen = false;
        wgpu::SharedFence producerFence;
        wgpu::SharedFence consumerFence;
    };
    std::unordered_map<uint32_t, SurfaceBuf> surfaceBufs;

#if OVERDRAW_KMS
    // KMS scanout: maps surfaceBufId -> slot index (0..2) and slot -> last
    // exported sync_file fd from EndAccess (handed to atomic commit as
    // IN_FENCE_FD). The sync fd is owned here until consumed by the next
    // ScanoutPresent for the same slot.
    std::unordered_map<uint32_t, int> scanoutBufIdToSlot;
    int scanoutSlotFenceFd[3] = {-1, -1, -1};
#endif

#if OVERDRAW_KMS
    // KMS bring-up (analogue of the nested SurfaceReady -> swapchain Configure
    // path above). The core's bringUp expects:
    //   1) OutputDescriptor (so it knows the mode dims to reserve at)
    //   2) ScanoutReserve (with three texture handles)
    //   3) we reply ScanoutReady after building the ring + injecting
    if (outputKms && kms) {
        // Step 1: send OutputDescriptor.
        gpu::OutputDescriptorInfo info{};
        kms->describeOutput(info);
        {
            ipc::Message m{};
            m.tag = ipc::Tag::OutputDescriptor;
            m.outputId         = 0;  // the one output today; per-output when enumeration lands
            m.width            = info.width;
            m.height           = info.height;
            m.refreshMhz       = info.refreshMhz;
            m.outScale         = info.scale;
            m.outTransform     = info.transform;
            m.physicalWidthMm  = info.physicalWidthMm;
            m.physicalHeightMm = info.physicalHeightMm;
            std::memcpy(m.outputName,  info.name,  sizeof(m.outputName));
            std::memcpy(m.outputMake,  info.make,  sizeof(m.outputMake));
            std::memcpy(m.outputModel, info.model, sizeof(m.outputModel));
            ipc::sendMessage(ctrlFd, m);
            std::printf("[gpu] sent OutputDescriptor (kms): %ux%u @%umHz\n",
                        info.width, info.height, info.refreshMhz);
        }

        // Step 2: build the scanout ring on the core device.
        if (!kms->initScanout(coreDevice)) {
            std::fprintf(stderr, "[gpu] KmsOutputBackend::initScanout failed\n");
            return 1;
        }

        // Step 3: wait for ScanoutReserve.
        ipc::Message reserveMsg{};
        {
            bool got = false;
            for (int i = 0; i < 500000 && !got; ++i) {
                ipc::Message m{};
                if (ipc::recvMessageNB(ctrlFd, m) && m.tag == ipc::Tag::ScanoutReserve) {
                    reserveMsg = m;
                    got = true;
                    break;
                }
                pumpWire();  // keep wire flowing during the wait
                usleepShort();
            }
            if (!got) {
                std::fprintf(stderr, "[gpu] no ScanoutReserve\n");
                return 1;
            }
        }

        // Step 4: InjectTexture at each reserved handle AND register the
        // slot as a SurfaceBuf so the existing in-band BeginAccess/EndAccess
        // machinery (originally for plugin overlays) handles scanout brackets
        // too. Each scanout SurfaceBuf is one-sided: producer side is the
        // core's wgpu device + the slot's STM/Texture; consumer side is
        // empty (the kernel consumes via fb_id, not wgpu).
        bool injectOk = true;
        for (int i = 0; i < 3; ++i) {
            const auto& slot = kms->scanoutSlot(i);
            if (!server.InjectTexture(slot.tex.Get(),
                                      {reserveMsg.scanoutHandles[i].id,
                                       reserveMsg.scanoutHandles[i].generation},
                                      {ready.device.id, ready.device.generation})) {
                std::fprintf(stderr, "[gpu] InjectTexture failed for scanout slot %d\n", i);
                injectOk = false;
                break;
            }
            // Register the SurfaceBuf for this slot.
            SurfaceBuf sb{};
            sb.connId = 0;  // not a plugin buf
            sb.producerOnCore = true;
            sb.producerMem = slot.mem;
            sb.producerTex = slot.tex;
            sb.producerDev = coreDevice;
            // Consumer side intentionally null -- kernel scanout, no wgpu.
            sb.layout = 0;
            sb.everProduced = false;
            sb.producerOpen = false;
            sb.consumerOpen = false;
            const uint32_t sbufId = reserveMsg.scanoutBufIds[i];
            surfaceBufs.emplace(sbufId, std::move(sb));
            // Remember the mapping slot -> surfaceBufId so ScanoutPresent's
            // surfaceBufId can route to the right scanout slot.
            scanoutBufIdToSlot[sbufId] = i;
        }

        // Step 5: tell the core we're done.
        {
            ipc::Message m{};
            m.tag = ipc::Tag::ScanoutReady;
            m.outputId = reserveMsg.outputId;  // echo the reserved output
            m.ok = injectOk ? 1 : 0;
            ipc::sendMessage(ctrlFd, m);
        }
        if (!injectOk) return 1;
        std::printf("[gpu] kms scanout ready (3 slots injected as SurfaceBufs)\n");
    }
#endif  // OVERDRAW_KMS

    // Host-window resize handler (NESTED only). The host fires
    // xdg_toplevel.configure(w,h) when the user resizes the overdraw window;
    // HostWindow acks it and calls onSize, which invokes this listener with
    // the new dimensions. We do TWO things synchronously here, in order:
    //
    //   1) Re-Configure the wgpu::Surface at the new size. This is a native
    //      Dawn call -- no wire round-trip, no core involvement. By the
    //      time the next wire GetCurrentTexture request from the core
    //      arrives at the wire server, the surface is already at the new
    //      size. The host's "next attached frame must be at the acked size"
    //      contract is met without a frame at the wrong size.
    //
    //   2) Send a fresh OutputDescriptor over ctrl with the new dimensions.
    //      The core's drainCtrl picks it up; main.ts's onOutputDescriptor
    //      callback updates state.outputs, reflows the WM, and re-emits
    //      wl_output / xdg_output to bound clients (slice 3b).
    //
    // The two steps are independent: (1) is purely GPU-process-local and
    // (2) is a one-way ctrl message. There's no acknowledgement back from
    // the core; the next time the JS compositor queries the output, it has
    // the updated state.outputs and the swapchain delivers correctly sized
    // textures.
    if (!headless && !outputKms) {
        output->setResizeListener(
            [&surface, &coreDevice, &surfaceFormat, &surfacePresentMode, &output, ctrlFd]
            (uint32_t newW, uint32_t newH) {
                if (!surface) return;
                wgpu::SurfaceConfiguration cfg{};
                cfg.device      = coreDevice;
                cfg.format      = static_cast<wgpu::TextureFormat>(surfaceFormat);
                cfg.usage       = wgpu::TextureUsage::RenderAttachment;
                cfg.width       = newW;
                cfg.height      = newH;
                cfg.alphaMode   = static_cast<wgpu::CompositeAlphaMode>(kSurfaceAlphaMode);
                cfg.presentMode = static_cast<wgpu::PresentMode>(surfacePresentMode);
                surface.Configure(&cfg);

                gpu::OutputDescriptorInfo info{};
                output->describeOutput(info);
                ipc::Message m{};
                m.tag              = ipc::Tag::OutputDescriptor;
                m.outputId         = 0;  // the one output today; per-output when enumeration lands
                m.width            = info.width;
                m.height           = info.height;
                m.refreshMhz       = info.refreshMhz;
                m.outScale         = info.scale;
                m.outTransform     = info.transform;
                m.physicalWidthMm  = info.physicalWidthMm;
                m.physicalHeightMm = info.physicalHeightMm;
                std::memcpy(m.outputName,  info.name,  sizeof(m.outputName));
                std::memcpy(m.outputMake,  info.make,  sizeof(m.outputMake));
                std::memcpy(m.outputModel, info.model, sizeof(m.outputModel));
                ipc::sendMessage(ctrlFd, m);
                std::printf("[gpu] resize -> %ux%u; reconfigured surface; sent OutputDescriptor\n",
                            newW, newH);
            });
    }

    // Nested-mode frame-done plumbing (drm-design.md "Frame clock"): the host
    // wl_surface.frame callback fires when the host compositor is ready for
    // the next frame; the GPU process forwards that as ipc::Tag::FrameComplete
    // to the core, where the addon's wake state machine drives the next
    // render. KMS uses ScanoutFlipComplete for the same role (see further
    // below). The callback is one-shot per host vsync; HostWindow re-arms it
    // inside `done`, plus we arm one here at startup to prime the chain.
    if (!headless && !outputKms) {
        output->setFrameDoneListener([ctrlFd]() {
            ipc::Message m{};
            m.tag = ipc::Tag::FrameComplete;
            ipc::sendMessage(ctrlFd, m);
        });
        output->armFrameCallback();
    }

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

    // Cross-channel barrier on the CORE wire reader. Used by ReleaseClientTex
    // (ctrl, with a wire-byte serial sampled at release time): the erase must
    // wait until the wire reader has consumed past every in-band BeginAccess /
    // EndAccess frame already queued ahead of the release, otherwise a pending
    // Begin would find the texture gone. ImportClientTex no longer rides ctrl
    // (it's in-band kind=3 on the wire now, so naturally FIFO-ordered).
    ipc::WireBarrier coreWireBarrier;

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
    // Two directions exist for plugin overlays / compose buffers:
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
    // A third direction exists for KMS scanout (one-sided): producerOnCore=
    // true, consumer side empty. PRODUCER is the core device (renders into
    // the scanout slot's STM); CONSUMER is the kernel display engine (reads
    // the underlying dmabuf via fb_id). Producer Begin/End ride the core
    // wire; there are no consumer Begin/End frames. runSurfaceEnd's KMS
    // branch captures the producer EndAccess's sync_file fd into
    // scanoutSlotFenceFd[slot] for the next ScanoutPresent to attach as
    // the atomic commit's IN_FENCE_FD.
    //
    // producerMem/Tex/Dev always points at the producing-device side, regardless
    // of whether that's plugin or core. consumerMem/Tex/Dev points at the
    // consuming-device side (empty for scanout). The producerOnCore flag tells
    // the wire dispatchers which socket carries which role for each surface.
    //
    // The SurfaceBuf struct + surfaceBufs map + KMS-scanout maps are forward-
    // declared earlier in run() (search for "Surface-buffer machinery") so
    // KMS bring-up can populate them before this section's helper lambdas
    // exist; the helpers are defined here over the same data.

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
            // A failed End leaves nothing for the peer to wait on. Clear any
            // stale fence from the previous successful End so the peer's next
            // Begin doesn't wait on an obsolete fence.
            (producer ? sb.producerFence : sb.consumerFence) = nullptr;
            return;
        }
        if (producer) sb.producerOpen = false; else sb.consumerOpen = false;
        sb.layout = endLayout.newLayout;

#if OVERDRAW_KMS
        // KMS scanout: producer EndAccess on a scanout SurfaceBuf has no
        // wgpu consumer device to import the fence into. Capture the raw
        // sync_file fd instead -- it goes straight to the next ScanoutPresent
        // as IN_FENCE_FD.
        {
            auto sit = scanoutBufIdToSlot.find(surfaceBufId);
            if (sit != scanoutBufIdToSlot.end() && producer) {
                int& slotFenceFd = scanoutSlotFenceFd[sit->second];
                if (slotFenceFd >= 0) { ::close(slotFenceFd); slotFenceFd = -1; }
                if (endState.fenceCount >= 1) {
                    wgpu::SharedFenceExportInfo exp{};
                    wgpu::SharedFenceSyncFDExportInfo syncExp{};
                    exp.nextInChain = &syncExp;
                    endState.fences[0].ExportInfo(&exp);
                    if (syncExp.handle >= 0) {
                        slotFenceFd = ::dup(syncExp.handle);
                        if (slotFenceFd < 0) {
                            std::fprintf(stderr, "[gpu] scanout EndAccess: dup(syncfd) failed\n");
                        }
                    }
                }
                return;  // skip the consumer-side fence import below
            }
        }
#endif

        // Plugin overlay path: producerFence (waited by consumer/core) /
        // consumerFence (waited by producer/plugin); import into the WAITING
        // side's device.
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
        // CROSS-WIRE FENCE ORDERING (consumer Begin only).
        //
        // The consumer Begin rides the CORE wire while the matching producer
        // End rides the PLUGIN wire -- two independent FIFOs. The event loop
        // pumps the core wire before each plugin connection, so when both
        // frames are buffered at the start of one iteration, the consumer
        // Begin is decoded first. That opens the bracket with no fence wait
        // AND a UNDEFINED -> GENERAL image-layout transition, which Vulkan is
        // allowed to discard the image contents on. Result: a corrupt or
        // empty consumer sample on that slot until the next cycle heals it.
        //
        // SAFE BY CONSTRUCTION: the worker writes producer End to its socket
        // BEFORE sending the surface.present IPC that triggers the consumer
        // Begin. So whenever we see a consumer Begin with the producer's
        // bracket still open on this buf, the producer End is already in the
        // kernel recv buffer for the owning plugin connection. A single
        // non-blocking drain of that connection picks it up before we open
        // the consumer bracket. No poll, no event-loop stall.
        if (!producer && (sb.producerOpen || !sb.everProduced)) {
            PluginConn* owner = nullptr;
            for (auto& c : pluginConns) if (c->connId == sb.connId) { owner = c.get(); break; }
            if (owner) {
                owner->pump();
                owner->barrier.drain(owner->reader->bytesConsumed());
                if (sb.producerOpen || !sb.everProduced) {
                    std::fprintf(stderr,
                        "[gpu] ConsumerBegin buf=%u: producer End not yet decoded after pump "
                        "(producerOpen=%d everProduced=%d). Proceeding with no fence wait; "
                        "this slot may sample stale/zeroed contents.\n",
                        surfaceBufId,
                        sb.producerOpen ? 1 : 0, sb.everProduced ? 1 : 0);
                }
            }
        }
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
        wgpu::Status ba = mem.BeginAccess(tex, &bad);
        if (ba != wgpu::Status::Success) {
            std::fprintf(stderr, "[gpu] %sBegin: BeginAccess failed (buf=%u)\n",
                         producer ? "Producer" : "Consumer", surfaceBufId);
            return false;
        }
        if (producer) { sb.everProduced = true; sb.producerOpen = true; }
        else sb.consumerOpen = true;
        return true;
    };

    // AllocSurfaceBuf / AllocComposeBuf inject cross-channel ordering lives on
    // each PluginConn's `barrier` (ipc::WireBarrier). drainPluginBarriers below
    // drains them after each plugin-wire pump. Tag scheme:
    //   - AllocSurfaceBuf / AllocComposeBuf:  tag = allocSurfaceBufTag(surfaceBufId)
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
    // ClientTexImported reply (in-band kind=4 on the core wire, FIFO-ordered
    // with the InjectTexture's effect on the wire server's mKnown). Closes fd
    // on failure.
    //
    // Does NOT open a BeginAccess bracket -- the per-frame Begin/End model
    // opens one per compositing submit (BeginClientAccess). The cached entry
    // starts at layout=0 (UNDEFINED), accessOpen=false, lastEndFence=null.
    auto runImport = [&](const ipc::Message& m, int fd) {
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
        } else {
            ::close(cb.fd);
        }

        // Reply on the core wire as kind=4. FIFO-ordered after the wire bytes
        // that this InjectTexture's effect on mKnown enables -- the core's
        // pendingJsImports list matches by texture id.
        ipc::ClientTexImportedPayload rp{};
        rp.textureId = m.texture.id;
        rp.textureGeneration = m.texture.generation;
        rp.importOk = ok ? 1 : 0;
        uint8_t rbuf[ipc::ClientTexImportedPayload::kSize];
        rp.encode(rbuf);
        serializer.appendFrame(ipc::FrameKind::ClientTexImported, rbuf, sizeof(rbuf));
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
                "[gpu] BeginClientAccess: unknown texture {%u,%u} (have gen %d) @wire=%zu\n",
                textureId, textureGen,
                it == clientTextures.end() ? -1 : (int)it->second.generation,
                wireReader.bytesConsumed());
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
        // Begin/End hand-off pattern (matches Dawn's own SharedTextureMemoryTests):
        // echo the prior End's newLayout straight back as the next Begin's pair so
        // Dawn's queue-family-transfer barrier and any subsequent sample-path
        // transition agree on the texture's current layout. First-ever Begin:
        // oldLayout=UNDEFINED (the texture has no prior internal layout from this
        // device's perspective); newLayout=SHADER_READ_ONLY_OPTIMAL since the very
        // next thing Dawn does is transition for sampling.
        layoutBegin.oldLayout = ct.everSampled ? ct.layout : 0;
        layoutBegin.newLayout = ct.everSampled ? ct.layout : 5;  // SHADER_READ_ONLY_OPTIMAL
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
        // SharedTextureMemoryVkImageLayoutEndState's default ctor does NOT
        // value-initialize oldLayout/newLayout (they are int32_t fields after a
        // user-provided ctor in the generated header). If EndAccess returns
        // without Dawn's backend writing them -- which happens when the access
        // bracket did NOT use the texture (lastUsageSerial == kBeginningOfGPUTime
        // skips EndAccessImpl in src/dawn/native/SharedResourceMemory.cpp) -- we
        // would read uninitialized stack memory and cache garbage into ct.layout,
        // poisoning every subsequent Begin's oldLayout. Initialize to a known
        // sentinel (UNDEFINED=0) so a no-op End leaves the entry's layout sane.
        wgpu::SharedTextureMemoryVkImageLayoutEndState endLayout{};
        endLayout.oldLayout = 0;  // VK_IMAGE_LAYOUT_UNDEFINED
        endLayout.newLayout = 0;
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
        // Only adopt the returned layout if Dawn actually wrote one (i.e. the
        // texture was used in this access bracket). A 0 (UNDEFINED) return is
        // the no-work case: keep the prior layout so the next Begin's chain
        // (oldLayout = ct.layout) stays consistent with the last real End.
        if (endLayout.newLayout != 0) {
            ct.layout = endLayout.newLayout;
        }
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
    dispatchCoreControlFrame = [&](ipc::FrameKind kind, const std::vector<uint8_t>& frame,
                                   const int* fds, int nfds) {
        if (frame.empty()) {
            std::fprintf(stderr, "[gpu] core wire: empty control frame\n");
            std::abort();
        }
        if (kind == ipc::FrameKind::ImportClientTex) {
            // In-band dmabuf import: FIFO-ordered with surrounding wire commands
            // so the just-Reserved texture slot at handle.id (which grew the wire
            // client's id allocator one past anything prior) is server-allocated
            // BEFORE any subsequent wire command tries to allocate id+1.
            if (frame.size() != ipc::ImportClientTexPayload::kSize) {
                std::fprintf(stderr, "[gpu] core wire: bad ImportClientTex payload size %zu\n",
                             frame.size());
                std::abort();
            }
            if (nfds != 1 || !fds) {
                std::fprintf(stderr, "[gpu] core wire: ImportClientTex with nfds=%d\n", nfds);
                std::abort();
            }
            auto p = ipc::ImportClientTexPayload::decode(frame.data());
            // Bridge the in-band payload into the existing runImport (which
            // expects ipc::Message + a single fd). Synthesize an ipc::Message.
            ipc::Message m{};
            m.tag = ipc::Tag::ImportClientTex;
            m.texture = {p.textureId, p.textureGeneration};
            m.device  = {p.deviceId, p.deviceGeneration};
            m.width = p.width;
            m.height = p.height;
            m.drmFourcc = p.drmFourcc;
            m.modifier = p.modifier;
            m.planeOffset = p.planeOffset;
            m.planeStride = p.planeStride;
            m.planeCount = 1;
            runImport(m, fds[0]);
            return;
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

    // Shared AllocSurfaceBuf / AllocComposeBuf handler. Allocates ONE GBM dmabuf;
    // imports it as SharedTextureMemory on both the plugin device and the core
    // device; injects a wire texture at each side's reserved handle; replies
    // SurfaceBufAllocated.
    //
    // The two directions:
    //   producerOnCore=false (AllocSurfaceBuf):
    //     pluginDevice/pluginTexture = producer (on plugin wire)
    //     device/texture             = consumer (on core wire)
    //     reservePointSerial gates the producer inject on the plugin wire;
    //     wireSerial gates the consumer inject on the core wire.
    //
    //   producerOnCore=true (AllocComposeBuf):
    //     device/texture             = producer (on core wire)
    //     pluginDevice/pluginTexture = consumer (on plugin wire)
    //     wireSerial gates the producer inject on the core wire;
    //     reservePointSerial gates the consumer inject on the plugin wire.
    //
    // The barrier serials use the same fields in both directions; only their
    // role labels swap. The producer always rides the producer-device's wire
    // and the consumer always rides the consumer-device's wire, by definition.
    auto allocSurfaceBufImpl = [&](const ipc::Message& m, bool producerOnCore) {
        // Identify the plugin connection that owns the plugin-side device, in
        // both directions: the surface buffer is associated with one plugin
        // (connId) regardless of which side produces.
        PluginConn* pc = nullptr;
        for (auto& c : pluginConns) if (c->connId == m.connId) { pc = c.get(); break; }

        // Resolve the producer and consumer devices according to producerOnCore.
        WGPUDevice producerNative = nullptr;
        WGPUDevice consumerNative = nullptr;
        if (producerOnCore) {
            producerNative = server.GetDevice(m.device.id, m.device.generation);
            consumerNative = pc ?
                pc->server->GetDevice(m.pluginDevice.id, m.pluginDevice.generation) : nullptr;
        } else {
            producerNative = pc ?
                pc->server->GetDevice(m.pluginDevice.id, m.pluginDevice.generation) : nullptr;
            consumerNative = server.GetDevice(m.device.id, m.device.generation);
        }
        const char* tagName = producerOnCore ? "AllocComposeBuf" : "AllocSurfaceBuf";
        if (!pc || !producerNative || !consumerNative) {
            std::fprintf(stderr, "[gpu] %s: device resolve failed "
                         "(pc=%d producer=%p consumer=%p)\n", tagName, pc ? 1 : 0,
                         static_cast<void*>(producerNative),
                         static_cast<void*>(consumerNative));
            ipc::Message reply{};
            reply.tag = ipc::Tag::SurfaceBufAllocated;
            reply.surfaceBufId = m.surfaceBufId;
            reply.connId = m.connId;
            reply.ok = 0;
            ctrlSender.send(reply);
            return;
        }
        // The plugin connection always needs a ticked device (its own queue
        // advances mapAsync / onSubmittedWorkDone there). For the consumer-on-
        // plugin direction, the plugin's device still needs ticking because
        // BeginAccess/EndAccess on the consumer side rides its queue.
        if (!pc->tickDev) {
            pc->tickDev = producerOnCore ? consumerNative : producerNative;
        }

        SurfaceBuf sb{};
        wgpu::Device producerDev(producerNative);
        wgpu::Device consumerDev(consumerNative);
        bool ok = alloc.allocate(m.width, m.height, sb.buf);
        if (ok) ok = gpu::Allocator::importTexture(
            producerDev, alloc.fourcc(), sb.buf, sb.producerMem, sb.producerTex);
        if (ok) ok = gpu::Allocator::importTexture(
            consumerDev, alloc.fourcc(), sb.buf, sb.consumerMem, sb.consumerTex);
        if (!ok) {
            std::fprintf(stderr, "[gpu] %s id=%u: alloc/import failed\n",
                         tagName, m.surfaceBufId);
            alloc.release(sb.buf);
            ipc::Message reply{};
            reply.tag = ipc::Tag::SurfaceBufAllocated;
            reply.surfaceBufId = m.surfaceBufId;
            reply.connId = m.connId;
            reply.ok = 0;
            ctrlSender.send(reply);
            return;
        }
        // Stage the SurfaceBuf NOW (its textures/STMs are imported on both
        // devices). The deferred injects move it into surfaceBufs once both
        // are in. The shared state below counts down the two sides; the
        // second one that runs fires the reply.
        sb.producerOnCore = producerOnCore;
        sb.producerDev = producerDev;
        sb.consumerDev = consumerDev;
        sb.connId = m.connId;
        struct InjectState {
            ipc::Message msg;
            bool producerOnCore = false;
            SurfaceBuf sb;
            int remaining = 2;
            bool producerOk = false;
            bool consumerOk = false;
        };
        auto state = std::make_shared<InjectState>();
        state->msg = m;
        state->producerOnCore = producerOnCore;
        state->sb = std::move(sb);
        auto finalize = [&surfaceBufs, &alloc, &serializer, &ctrlSender, state, tagName]() {
            ipc::Message reply{};
            reply.tag = ipc::Tag::SurfaceBufAllocated;
            reply.surfaceBufId = state->msg.surfaceBufId;
            reply.connId = state->msg.connId;
            const bool ok = state->producerOk && state->consumerOk;
            reply.ok = ok ? 1 : 0;
            if (ok) {
                std::printf("[gpu] %s id=%u %ux%u: imported on producer+consumer, injected\n",
                            tagName, state->msg.surfaceBufId,
                            state->msg.width, state->msg.height);
                surfaceBufs[state->msg.surfaceBufId] = std::move(state->sb);
                serializer.Flush();
            } else {
                std::fprintf(stderr, "[gpu] %s id=%u: inject failed (p=%d c=%d)\n",
                             tagName, state->msg.surfaceBufId,
                             static_cast<int>(state->producerOk),
                             static_cast<int>(state->consumerOk));
                state->sb.producerTex = nullptr;
                state->sb.producerMem = nullptr;
                state->sb.consumerTex = nullptr;
                state->sb.consumerMem = nullptr;
                alloc.release(state->sb.buf);
            }
            ctrlSender.send(reply);
        };
        // The two injects go on the wires their target device lives on. The
        // serial each waits for is the reserve-point on that wire.
        //   producerOnCore=false: producer on plugin wire, consumer on core wire.
        //   producerOnCore=true:  producer on core wire, consumer on plugin wire.
        const uint32_t producerSerial = producerOnCore ? m.wireSerial : m.reservePointSerial;
        const uint32_t consumerSerial = producerOnCore ? m.reservePointSerial : m.wireSerial;

        auto doProducerInject = [pc, &server, &serializer, state, finalize]() {
            const auto& msg = state->msg;
            if (state->producerOnCore) {
                state->producerOk = server.InjectTexture(
                    state->sb.producerTex.Get(),
                    {msg.texture.id, msg.texture.generation},
                    {msg.device.id, msg.device.generation});
                if (state->producerOk) serializer.Flush();
            } else {
                state->producerOk = pc->server->InjectTexture(
                    state->sb.producerTex.Get(),
                    {msg.pluginTexture.id, msg.pluginTexture.generation},
                    {msg.pluginDevice.id, msg.pluginDevice.generation});
                if (state->producerOk) pc->serializer->Flush();
            }
            if (--state->remaining == 0) finalize();
        };
        auto doConsumerInject = [pc, &server, &serializer, state, finalize]() {
            const auto& msg = state->msg;
            if (state->producerOnCore) {
                state->consumerOk = pc->server->InjectTexture(
                    state->sb.consumerTex.Get(),
                    {msg.pluginTexture.id, msg.pluginTexture.generation},
                    {msg.pluginDevice.id, msg.pluginDevice.generation});
                if (state->consumerOk) pc->serializer->Flush();
            } else {
                state->consumerOk = server.InjectTexture(
                    state->sb.consumerTex.Get(),
                    {msg.texture.id, msg.texture.generation},
                    {msg.device.id, msg.device.generation});
                if (state->consumerOk) serializer.Flush();
            }
            if (--state->remaining == 0) finalize();
        };

        // Schedule injects on each side's barrier.
        if (producerOnCore) {
            coreWireBarrier.after(
                producerSerial, doProducerInject, wireReader.bytesConsumed());
            pc->barrier.after(
                consumerSerial, doConsumerInject,
                pc->reader->bytesConsumed(), allocSurfaceBufTag(m.surfaceBufId));
        } else {
            pc->barrier.after(
                producerSerial, doProducerInject,
                pc->reader->bytesConsumed(), allocSurfaceBufTag(m.surfaceBufId));
            coreWireBarrier.after(
                consumerSerial, doConsumerInject, wireReader.bytesConsumed());
        }
    };

    // Control-message dispatch. Returns false if the core requested shutdown.
    auto dispatchCtrl = [&](const ipc::Message& m, int* recvFds, int nRecvFds) -> void {
        {
            if (m.tag == ipc::Tag::Shutdown) {
                shutdown = true;
#if OVERDRAW_KMS
            } else if (m.tag == ipc::Tag::ScanoutPresent) {
                // m.surfaceBufId is the scanout slot's surfaceBufId, NOT the
                // slot index. Map it back to the slot, and pick up the
                // sync_file fd captured at EndAccess time (stashed in
                // scanoutSlotFenceFd[slot]).
                if (kms) {
                    auto sit = scanoutBufIdToSlot.find(m.surfaceBufId);
                    if (sit == scanoutBufIdToSlot.end()) {
                        std::fprintf(stderr,
                            "[gpu] ScanoutPresent: unknown surfaceBufId=%u\n",
                            m.surfaceBufId);
                    } else {
                        const int slot = sit->second;
                        int& fenceFd = scanoutSlotFenceFd[slot];
                        if (!kms->presentScanout(slot, fenceFd)) {
                            std::fprintf(stderr,
                                "[gpu] presentScanout(slot=%d) rejected by kernel\n", slot);
                        }
                        if (fenceFd >= 0) { ::close(fenceFd); fenceFd = -1; }
                    }
                }
                for (int i = 0; i < nRecvFds; ++i) ::close(recvFds[i]);
            } else if (m.tag == ipc::Tag::OutputPause) {
                if (kms) kms->pause();
                for (int i = 0; i < nRecvFds; ++i) ::close(recvFds[i]);
            } else if (m.tag == ipc::Tag::OutputResume) {
                if (kms) kms->resume();
                for (int i = 0; i < nRecvFds; ++i) ::close(recvFds[i]);
#endif
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
                    ctrlSender.send(reply);
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
                    ctrlSender.send(reply);
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
                ctrlSender.send(reply);
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
                // Plugin produces, core consumes. See allocSurfaceBufImpl above
                // for the shared shape; this just picks the direction.
                allocSurfaceBufImpl(m, /*producerOnCore=*/false);
            } else if (m.tag == ipc::Tag::AllocComposeBuf) {
                // Core produces (sdk.compose result), plugin consumes. Same
                // allocate-and-import machinery as AllocSurfaceBuf but with
                // producer/consumer roles swapped.
                allocSurfaceBufImpl(m, /*producerOnCore=*/true);
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
            } else if (m.tag == ipc::Tag::ReleaseClientTex) {
                // Release a JS-compositor dmabuf import: drop the STM + close the
                // fd. The per-frame BeginClientAccess/EndAccess brackets for this
                // handle travel the WIRE; this release came over the CTRL channel,
                // so a bracket may still be unread in the wire pipeline. Gate the
                // erase on the core wire reader catching up past m.wireSerial (the
                // write cursor the core sampled at release time) so a pending Begin
                // still finds the texture. If the reader is already past it, the
                // barrier runs the erase synchronously (the common case).
                const ipc::WireHandle tex = m.texture;
                coreWireBarrier.after(
                    m.wireSerial,
                    [&clientTextures, tex]() {
                        auto it = clientTextures.find(tex.id);
                        if (it == clientTextures.end() || it->second.generation != tex.generation) {
                            return;  // already recycled into a newer import
                        }
                        ClientTex& ct = it->second;
                        // Defensive: end a still-open bracket so the STM destructor
                        // doesn't run with a live access (should not happen now that
                        // the erase waits for the wire to drain past the brackets).
                        if (ct.accessOpen) {
                            wgpu::SharedTextureMemoryVkImageLayoutEndState endLayout{};
                            wgpu::SharedTextureMemoryEndAccessState endState{};
                            endState.nextInChain = &endLayout;
                            (void)ct.mem.EndAccess(ct.tex, &endState);
                            ct.accessOpen = false;
                        }
                        if (ct.fd >= 0) ::close(ct.fd);
                        clientTextures.erase(it);
                    },
                    wireReader.bytesConsumed());
            }
        }
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

    auto armCtrl = [&] {
        uint32_t ev = gpu::EventLoop::kRead;
        if (ctrlSender.hasPendingOut()) ev |= gpu::EventLoop::kWrite;
        loop->modify(ctrlFd, ev);
    };

    loop->add(wireFd, gpu::EventLoop::kRead, [&](uint32_t ready) {
        if (ready & gpu::EventLoop::kWrite) serializer.pumpOut();
        if (ready & gpu::EventLoop::kRead) { if (!pumpWire()) shutdown = true; }
        drainCoreBarrier();  // core wire advanced -> some deferred ctrl ops may be ready
        armWire();
        armCtrl();          // drainCoreBarrier ran deferred ops that may have queued ctrl replies
    });
    loop->add(ctrlFd, gpu::EventLoop::kRead, [&](uint32_t ready) {
        if (ready & gpu::EventLoop::kWrite) ctrlSender.pumpOut();
        if (ready & gpu::EventLoop::kRead) {
            ipc::Message m{};
            int recvFds[ipc::kMaxMsgFds];
            int nRecvFds = 0;
            while (ipc::recvMessageNBFds(ctrlFd, m, recvFds, &nRecvFds)) {
                dispatchCtrl(m, recvFds, nRecvFds);
                if (shutdown) break;
            }
            drainCoreBarrier();
            armWire();      // dispatchCtrl may have flushed wire output
        }
        armCtrl();
    });
    const int outputFd = output ? output->eventFd() : -1;
    if (outputFd >= 0)
        loop->add(outputFd, gpu::EventLoop::kRead, [&](uint32_t) { output->pump(); });

#if OVERDRAW_KMS
    // Page-flip → ScanoutFlipComplete: when KMS flips to a new slot, the
    // backend's listener fires synchronously from drmHandleEvent (called
    // from output->pump()). We send the retired slot index to the core so
    // it advances its scanout state machine.
    if (kms) {
        kms->setFlipCompleteListener([&](int retiredSlotIdx) {
            // The flip-complete handler receives the slot index that JUST
            // became SCANOUT; the retiredSlotIdx parameter is the slot that
            // was previously SCANOUT and is now FREE (-1 on the first flip).
            // The CORE keeps the slot state -- we send the slot that flipped
            // (=newly SCANOUT) and let the core deduce the rest.
            (void)retiredSlotIdx;  // unused: see KmsScanoutRing for the inversion.
            ipc::Message m{};
            m.tag = ipc::Tag::ScanoutFlipComplete;
            m.outputId = 0;  // the one output today; per-output when enumeration lands
            // KmsScanoutRing's listener semantics return retired (now-FREE)
            // slot. The core needs to know which slot just became SCANOUT
            // -- look up the ring state to find it.
            for (int i = 0; i < 3; ++i) {
                if (kms->scanoutSlot(i).state == gpu::KmsScanoutRing::SlotState::SCANOUT) {
                    m.surfaceBufId = static_cast<uint32_t>(i);
                    break;
                }
            }
            ctrlSender.send(m);
        });
    }
#endif

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

    while (!shutdown && (headless || !output->shouldClose())) {
        loop->runOnce(8);   // 8ms cap: also advances Dawn + output pump below
        pumpWire();          // DeviceTick + drain wire, even with no fd ready
        drainCoreBarrier();
        registerPluginConns();          // pick up connections added this iteration
        for (auto& pc : pluginConns) pc->pump();  // advance each plugin connection
        drainPluginBarriers();          // fire deferred producer-end / alloc-inject when ready
        if (output) output->pump();    // service output backend events
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
    // never arrive). Action captures own no fds we need to close; ReleaseClientTex
    // (the only barrier user now) captures no fds.
    coreWireBarrier.takePending();
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
    std::printf("[gpu] shutting down (shutdown=%d outputClosed=%d)\n",
                static_cast<int>(shutdown),
                static_cast<int>(output ? output->shouldClose() : 0));

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
    // Output-backend selector: "--output=kms" or "--output=nested" (default).
    // Headless ignores this (no output backend exists in headless mode).
    bool outputKms = false;
    int logFd = -1;
    for (int i = 3; i < argc; ++i) {
        if (std::strcmp(argv[i], "--headless") == 0 && i + 1 < argc) {
            headless = true;
            std::sscanf(argv[i + 1], "%ux%u", &hw, &hh);
            ++i;
        } else if (std::strcmp(argv[i], "--output=kms") == 0) {
            outputKms = true;
        } else if (std::strcmp(argv[i], "--output=nested") == 0) {
            outputKms = false;
        } else if (std::strncmp(argv[i], "--log-fd=", 9) == 0) {
            logFd = std::atoi(argv[i] + 9);
        }
    }
    if (headless && (hw == 0 || hh == 0)) { hw = 1280; hh = 720; }  // default

    // Route every LOG_* through the IPC sink. Until --log-fd is set the sink
    // buffers in a bounded ring (kRingCapacity); records flush in order once
    // the fd is attached. logInit() registers a logger per area against this
    // sink so logger(Area) returns the right thing.
    auto ipcSink = std::make_shared<overdraw::log::IpcSink>();
    if (logFd >= 0) ipcSink->setFd(logFd);
    {
        overdraw::log::Config cfg{};
        cfg.defaultLevel = spdlog::level::trace;
        cfg.senderSink = ipcSink;
        overdraw::log::logInit(cfg);
    }
    return run(wireFd, ctrlFd, inputFd, headless, hw, hh, outputKms);
}
