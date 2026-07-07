// overdraw GPU process.
//
// Native Dawn + wire server. Owns the output backend (KMS or host wl_surface)
// and the GBM-backed scanout ring whose slots the core renders into and
// presents through. No JS. Spawned by the core with two inherited socket fds:
//   argv[1] = wire socket fd, argv[2] = side-channel socket fd.

#ifndef _GNU_SOURCE
#define _GNU_SOURCE  // MREMAP_MAYMOVE
#endif

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <chrono>
#include <functional>
#include <unordered_map>
#include <unordered_set>
#include <utility>
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
#include "udev_monitor.h"
#endif
#include "side_channel.h"
#include "transport.h"
#include "wire_barrier.h"

#include "log/log.h"
#include "log/crash_handler.h"
#include "log/ipc_sink.h"

using namespace overdraw;

namespace {

void usleepShort() { ::usleep(200); }

// Copy one output's identity into the descriptor-bearing fields of an
// ipc::Message (the ctrl-borne OutputDescriptor send).
void fillOutputMsgFromInfo(uint32_t outputId, const gpu::OutputDescriptorInfo& info,
                           ipc::Message& m) {
    m.outputId         = outputId;
    m.width            = info.width;
    m.height           = info.height;
    m.refreshMhz       = info.refreshMhz;
    m.outScale         = info.scale;
    m.outTransform     = info.transform;
    m.physicalWidthMm  = info.physicalWidthMm;
    m.physicalHeightMm = info.physicalHeightMm;
    std::memcpy(m.outputName,   info.name,   sizeof(m.outputName));
    std::memcpy(m.outputMake,   info.make,   sizeof(m.outputMake));
    std::memcpy(m.outputModel,  info.model,  sizeof(m.outputModel));
    std::memcpy(m.outputEdidId, info.edidId, sizeof(m.outputEdidId));
}

// Export a dmabuf's implicit-sync acquire fence (the producer's outstanding
// WRITE work) as a sync_file fd. A consumer that wants to wait on the
// producer's writes asks for SYNC_WRITE (the kernel returns a sync_file of
// the dmabuf's attached WRITE fences -- exactly the work the producer has
// pending that the consumer's read must happen-after). The flag is the
// inverse of what intuition suggests: SYNC_READ would return the dmabuf's
// outstanding READ fences (what a producer waits on before writing again).
// Returns -1 on failure; the returned fd is owned by the caller. Export the
// sync_file, then import into the per-frame BeginAccess so the GPU waits on
// it -- a CPU poll does NOT order the GPU work.
int exportDmabufAcquireFence(int dmabufFd) {
    struct dma_buf_export_sync_file req{};
    req.flags = DMA_BUF_SYNC_WRITE;
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
    // 1) Output: an OutputBackend brings up the display target.
    //    HostWindowOutputBackend (nested) = a host Wayland output window the
    //    GPU process is a client of, forwarding host pointer/keyboard over
    //    inputFd; KmsOutputBackend = DRM/KMS scanout, no host.
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
    } else {
        // Headless/nested: no card to match against. Prefer the first adapter
        // that advertises a DRM render node, so the GBM allocator opens on the
        // SAME GPU as the device. On a multi-GPU box, taking adapter 0 blindly
        // and then guessing the render node lands GBM on a different card than
        // the device -- buffers fail to import (cross-GPU). Fall back to
        // adapter 0 only if no adapter advertises a render node.
        for (size_t i = 0; i < adapters.size(); i++) {
            if (adapterDrm(adapters[i].Get()).hasRender) { chosenIdx = i; break; }
        }
    }

    // The GBM allocator MUST open the chosen adapter's OWN render node, so
    // allocation and the wgpu device share a GPU. Derive it from the chosen
    // adapter; only if that adapter advertises no node do we guess renderD128
    // (correct on a single-GPU box, wrong on multi-GPU -- which is why we prefer
    // a render-capable adapter above).
    std::string renderNode;
    {
        WGPUAdapterPropertiesDrm drm = adapterDrm(adapters[chosenIdx].Get());
        if (drm.hasRender) {
            renderNode = "/dev/dri/renderD" + std::to_string(drm.renderMinor);
        } else {
            renderNode = "/dev/dri/renderD128";
            std::fprintf(stderr, "[gpu] WARNING: adapter[%zu] advertises no DRM "
                         "render node; guessing %s (correct only on single-GPU)\n",
                         chosenIdx, renderNode.c_str());
        }
    }
    std::printf("[gpu] selected adapter[%zu], render node %s\n",
                chosenIdx, renderNode.c_str());
    wgpu::Adapter adapter(adapters[chosenIdx].Get());

    // Headless / KMS / nested: no Dawn WSI surface. The nested on-screen
    // present path runs through a GPU-process-owned dmabuf scanout ring
    // whose slots are attached to the host wl_surface directly (mirroring
    // KMS). Creating a wgpu::Surface would also auto-bind a
    // wp_linux_drm_syncobj_surface_v1 to our host wl_surface (Mesa's
    // Vulkan WSI does this on hosts that advertise explicit-sync), after
    // which the host raises no_acquire_point on our direct attach + commit.

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

    // Nested bring-up: SurfaceReady (size + zero surface handle, no WSI) +
    // OutputDescriptor. Headless / KMS skip this entirely.
    if (!headless && !outputKms) {
    // Nested bring-up.
    // SurfaceReady: tell the core the surface is "ready" with the window's
    // logical size. The surface handle is zero (no wgpu::Surface created;
    // see above); the core's bringUp skips WSI configuration once it sees
    // a zero handle. (The wp_linux_drm_syncobj_v1 dance Mesa would have
    // set up if we'd created the WSI surface is also skipped, which is
    // the point.)
    {
        ipc::Message m{};
        m.tag = ipc::Tag::SurfaceReady;
        m.surface = {0, 0};  // no WSI surface
        m.width = outW();
        m.height = outH();
        ipc::sendMessage(ctrlFd, m);
    }

    // OutputDescriptor: nested-window size + host-derived refresh / scale /
    // transform / physical, and overdraw-synthesized make/model/name. Sent
    // ONCE here so the core's state.outputs starts with real values; the
    // host wl_output bound during HostWindow::open() has its first done
    // burst by now (open() does the second roundtrip). The resize handler
    // below re-sends this on host-window resize.
    {
        gpu::OutputDescriptorInfo info{};
        output->describeOutput(info);
        ipc::Message m{};
        m.tag = ipc::Tag::OutputDescriptor;
        // outputId 0: the one output today; per-output when enumeration lands.
        fillOutputMsgFromInfo(0, info, m);
        ipc::sendMessage(ctrlFd, m);
        std::printf(
            "[gpu] sent OutputDescriptor: %ux%u @%u.%03uHz scale=%u xform=%u "
            "phys=%ux%umm name=%s make=%s model=%s edid=%s\n",
            info.width, info.height,
            info.refreshMhz / 1000, info.refreshMhz % 1000,
            info.scale, info.transform,
            info.physicalWidthMm, info.physicalHeightMm, info.name, info.make, info.model,
            info.edidId);
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

    // Scanout state shared by KMS and the host-window backend.
    //
    // scanoutBufIdToSlot: each scanout surfaceBufId -> {outputId, slot index
    // 0..2}. The outputId is a dense routing key (KMS: assigned by
    // KmsOutputBackend's allocator; nested host-window: always 0). Same id
    // carried on ScanoutPresent wire frames and ScanoutFlipComplete tags.
    //
    // scanoutFenceFdByBufId: surfaceBufId -> last exported sync_file fd from
    // the producer EndAccess. Owned here until consumed by the next
    // ScanoutPresent on the same buffer; KMS attaches it as the atomic
    // commit's IN_FENCE_FD. Nested does NOT populate this map -- we rely
    // on the kernel's dma-buf reservation fence (Mesa attaches it on
    // queue submit and the host honors it). NVIDIA, which does not
    // attach implicit fences, would need an explicit-sync host binding;
    // that's a separate piece of work.
    std::unordered_map<uint32_t, std::pair<uint32_t, int>> scanoutBufIdToSlot;
    std::unordered_map<uint32_t, int> scanoutFenceFdByBufId;

    // Send a ScanoutReady reply on the WIRE. The matching ScanoutReserve
    // arrived on the wire (kind=6), so the reply also rides the wire to keep
    // the handshake's two sides on the same FIFO. The core's inboundHandler
    // routes ok=0 frames to ring discard.
    auto sendScanoutReady = [&](uint32_t outputId, bool ok) {
        ipc::ScanoutReadyPayload pl{};
        pl.outputId = outputId;
        pl.ok = ok ? 1 : 0;
        uint8_t buf[ipc::ScanoutReadyPayload::kSize];
        pl.encode(buf);
        serializer.appendFrame(ipc::FrameKind::ScanoutReady, buf, sizeof(buf));
    };

    // Inject one ring's 3 slot textures at the core-reserved wire handles
    // and register them in surfaceBufs + scanoutBufIdToSlot for the
    // producer Begin/End bracket path. Backend-neutral: caller passes the
    // wgpu::SharedTextureMemory + wgpu::Texture for each slot and the
    // payload's wire handles. Returns true if all 3 InjectTexture calls
    // succeeded.
    auto injectScanoutRingSlots =
        [&](uint32_t outputId,
            const ipc::ScanoutReservePayload& p,
            const wgpu::SharedTextureMemory* mems,
            const wgpu::Texture* texs) -> bool {
        for (int i = 0; i < 3; ++i) {
            if (!server.InjectTexture(texs[i].Get(),
                                      {p.slots[i].handleId, p.slots[i].handleGeneration},
                                      {ready.device.id, ready.device.generation})) {
                std::fprintf(stderr,
                    "[gpu] InjectTexture failed for output %u scanout slot %d\n",
                    outputId, i);
                return false;
            }
            SurfaceBuf sb{};
            sb.connId = 0;  // not a plugin buf
            sb.producerOnCore = true;
            sb.producerMem = mems[i];
            sb.producerTex = texs[i];
            sb.producerDev = coreDevice;
            // Consumer side intentionally null -- kernel / host scanout
            // (no wgpu consumer device on our side).
            sb.layout = 0;
            sb.everProduced = false;
            sb.producerOpen = false;
            sb.consumerOpen = false;
            const uint32_t sbufId = p.slots[i].surfaceBufId;
            surfaceBufs.emplace(sbufId, std::move(sb));
            scanoutBufIdToSlot[sbufId] = {outputId, i};
        }
        return true;
    };

#if OVERDRAW_KMS
    // KMS-specific ScanoutReserve handler. Shared by:
    //   - the startup bring-up loop (tight-loop receive, called once per
    //     startup output), and
    //   - the runtime ctrl dispatcher (called when a ScanoutReserve arrives
    //     for an output that was added via OutputAdded mid-flight).
    //
    // The ring is expected to be already allocated by the time the
    // ScanoutReserve arrives: at startup, kms->initScanout() builds all rings
    // before the core sends its Reserves; at runtime, the udev rescan callback
    // calls kms->initScanoutForOutput() before sending OutputAdded.
    auto handleScanoutReserve = [&](const ipc::ScanoutReservePayload& p) -> bool {
        if (!kms) {
            std::fprintf(stderr,
                "[gpu] handleScanoutReserve: no kms (nested mode?) outputId=%u\n",
                p.outputId);
            return false;
        }
        const uint32_t outputId = p.outputId;
        if (!kms->hasOutput(outputId)) {
            std::fprintf(stderr,
                "[gpu] ScanoutReserve for unknown output %u\n", outputId);
            sendScanoutReady(outputId, false);
            return false;
        }
        wgpu::SharedTextureMemory mems[3];
        wgpu::Texture texs[3];
        for (int i = 0; i < 3; ++i) {
            const auto& slot = kms->scanoutSlotAt(outputId, i);
            mems[i] = slot.mem;
            texs[i] = slot.tex;
        }
        const bool injectOk = injectScanoutRingSlots(outputId, p, mems, texs);
        sendScanoutReady(outputId, injectOk);
        if (injectOk) {
            std::printf("[gpu] kms scanout ready for output %u (3 slots injected)\n",
                        outputId);
        }
        return injectOk;
    };

    // Fill the descriptor-bearing fields of an ipc::Message from one output's
    // current identity. Used for the startup OutputDescriptor burst and for
    // runtime OutputAdded emits.
    auto fillOutputMsg = [&](uint32_t outputId, ipc::Message& m) {
        if (!kms) return;
        gpu::OutputDescriptorInfo info{};
        kms->describeOutputAt(outputId, info);
        fillOutputMsgFromInfo(outputId, info, m);
    };

    // Emit OutputModes for an output. Walks the connector's mode list,
    // truncates at ipc::kMaxModesPerOutput if needed (with a warning),
    // packs into a wire frame, and appends. The frame rides the wire
    // FIFO-after the OutputAdded frame (or after the startup
    // OutputDescriptor send) so the core processes them in order;
    // wlr-output-management exposes one head.mode event per record.
    auto emitOutputModes = [&](uint32_t outputId) {
        if (!kms) return;
        auto modes = kms->enumerateModes(outputId);
        if (modes.empty()) return;
        ipc::OutputModesPayload p{};
        p.outputId = outputId;
        const size_t cap = ipc::kMaxModesPerOutput;
        if (modes.size() > cap) {
            std::fprintf(stderr,
                "[gpu] OutputModes: connector for outputId=%u has %zu modes, "
                "truncating to %zu\n", outputId, modes.size(), cap);
            modes.resize(cap);
        }
        p.modes.reserve(modes.size());
        for (const auto& m : modes) {
            ipc::ModeRecord r{};
            r.width      = m.hdisplay;
            r.height     = m.vdisplay;
            r.refreshMhz = m.vrefreshMhz;
            r.flags      = m.preferred ? ipc::kModeFlagPreferred : 0;
            p.modes.push_back(r);
        }
        std::vector<uint8_t> buf(p.encodedSize());
        p.encode(buf.data());
        serializer.appendFrame(ipc::FrameKind::OutputModes, buf.data(), buf.size());
        std::printf("[gpu] sent OutputModes outputId=%u count=%zu\n",
                    outputId, p.modes.size());
    };

    // Pack one output's identity into an OutputDescriptorPayload. Used by
    // OutputAdded sends (runtime hotplug); the still-ctrl-bound startup
    // OutputDescriptor / resize re-emit path uses fillOutputMsg above.
    auto buildOutputDescPayload = [&](uint32_t outputId,
                                       ipc::OutputDescriptorPayload& p) {
        if (!kms) return;
        gpu::OutputDescriptorInfo info{};
        kms->describeOutputAt(outputId, info);
        p.outputId         = outputId;
        p.width            = info.width;
        p.height           = info.height;
        p.refreshMhz       = info.refreshMhz;
        p.scale            = info.scale;
        p.transform        = info.transform;
        p.physicalWidthMm  = info.physicalWidthMm;
        p.physicalHeightMm = info.physicalHeightMm;
        // info.name/make/model/edidId are NUL-terminated; strnlen caps at
        // the source buffer size (64). The payload's string carries the
        // bytes without NUL.
        const size_t kCap = 64;
        p.name.assign(info.name,
            ::strnlen(info.name, kCap));
        p.make.assign(info.make,
            ::strnlen(info.make, kCap));
        p.model.assign(info.model,
            ::strnlen(info.model, kCap));
        p.edidId.assign(info.edidId,
            ::strnlen(info.edidId, kCap));
    };
#endif

#if OVERDRAW_KMS
    // KMS bring-up (analogue of the nested SurfaceReady -> swapchain Configure
    // path above). The core's bringUp expects:
    //   1) OutputDescriptor (so it knows the mode dims to reserve at)
    //   2) ScanoutReserve (with three texture handles)
    //   3) we reply ScanoutReady after building the ring + injecting
    if (outputKms && kms) {
        const std::vector<uint32_t> startupIds = kms->outputIds();
        const uint32_t nOutputs = static_cast<uint32_t>(startupIds.size());

        // Step 1: send an OutputDescriptor for every driven output (lowest id
        // first; ids are dense routing keys, see KmsOutputBackend / multi-
        // output-design §3). outputCount on every message tells the core how
        // many scanout rings to reserve before it starts replying.
        for (uint32_t outputId : startupIds) {
            ipc::Message m{};
            m.tag         = ipc::Tag::OutputDescriptor;
            m.outputCount = nOutputs;
            fillOutputMsg(outputId, m);
            ipc::sendMessage(ctrlFd, m);
            std::printf("[gpu] sent OutputDescriptor (kms output %u/%u): %ux%u @%u.%03uHz name=%s\n",
                        outputId, nOutputs, m.width, m.height,
                        m.refreshMhz / 1000, m.refreshMhz % 1000, m.outputName);
            // OutputModes rides wire (FrameKind), the descriptor above
            // rides ctrl. Different fds, but the core's startup pump
            // drains both before handing control to the JS layer, so
            // either order is fine; the JS handler ordering
            // (fireOutputDescriptors then fireOutputModes) gives modes
            // the existing OutputRecord to update.
            emitOutputModes(outputId);
        }

        // Step 2: build all N scanout rings on the core device. Done before
        // any ScanoutReserve handling so handleScanoutReserve below can
        // assume the ring is already there.
        if (!kms->initScanout(coreDevice)) {
            std::fprintf(stderr, "[gpu] KmsOutputBackend::initScanout failed\n");
            return 1;
        }

        // Step 3: wait for one ScanoutReserve per output on the WIRE. They
        // come through the FrameReader as kind=ScanoutReserve frames; we
        // install a small startup dispatcher that calls handleScanoutReserve
        // on each. (The full dispatchCoreControlFrame -- for steady-state
        // BeginAccess / ImportClientTex etc. -- is bound further down; before
        // it overwrites this one, pumpWire still won't see any non-ScanoutReserve
        // wire control frames because no client has connected yet.)
        uint32_t reservesHandled = 0;
        dispatchCoreControlFrame = [&](ipc::FrameKind kind,
                                       const std::vector<uint8_t>& frame,
                                       const int* /*fds*/, int nfds) {
            if (kind != ipc::FrameKind::ScanoutReserve) {
                std::fprintf(stderr,
                    "[gpu] startup: unexpected wire frame kind=%u (expected ScanoutReserve)\n",
                    static_cast<unsigned>(kind));
                std::abort();
            }
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] startup: ScanoutReserve with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::ScanoutReservePayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] startup: ScanoutReserve bad payload size %zu\n", frame.size());
                std::abort();
            }
            auto p = ipc::ScanoutReservePayload::decode(frame.data());
            if (!handleScanoutReserve(p)) {
                std::fprintf(stderr,
                    "[gpu] startup ScanoutReserve handling failed for output %u\n",
                    p.outputId);
                std::abort();
            }
            ++reservesHandled;
        };
        // Spin-pump until all N ScanoutReserves have been processed.
        for (int i = 0; i < 500000 && reservesHandled < nOutputs; ++i) {
            pumpWire();
            usleepShort();
        }
        if (reservesHandled < nOutputs) {
            std::fprintf(stderr, "[gpu] no ScanoutReserve (received %u/%u)\n",
                         reservesHandled, nOutputs);
            return 1;
        }
        // Reset the startup dispatcher; the full one is bound below.
        dispatchCoreControlFrame = nullptr;
    }
#endif  // OVERDRAW_KMS

    // Nested-backend ScanoutReserve handler. Mirrors KMS's
    // handleScanoutReserve in shape: walk the (already-built) ring for
    // outputId, inject each slot's texture at the reserved wire handle,
    // register the per-slot SurfaceBuf in surfaceBufs + scanoutBufIdToSlot,
    // reply ScanoutReady. Used by startup AND by the steady-state wire
    // dispatcher (the latter fires on resize, where the core sends a
    // fresh ScanoutReserve after ScanoutRebuild).
    auto handleNestedScanoutReserve =
        [&](const ipc::ScanoutReservePayload& p) -> bool {
        if (headless || outputKms) {
            std::fprintf(stderr,
                "[gpu] handleNestedScanoutReserve called without nested backend\n");
            return false;
        }
        if (p.outputId != 0) {
            std::fprintf(stderr,
                "[gpu] nested ScanoutReserve for unexpected output %u (only 0 supported)\n",
                p.outputId);
            sendScanoutReady(p.outputId, false);
            return false;
        }
        auto* hb = static_cast<gpu::HostWindowOutputBackend*>(output.get());
        auto* ring = hb->scanoutRing();
        if (!ring) {
            std::fprintf(stderr,
                "[gpu] nested ScanoutReserve: scanout ring is not built\n");
            sendScanoutReady(0, false);
            return false;
        }
        // Resize-time teardown: erase any surfaceBufs / fence-fd / slot-
        // routing entries from a PRIOR ring on this outputId. By wire-FIFO
        // ordering, every old ProducerBegin/EndAccess has already been
        // processed by the time this frame is dispatched (the core sent
        // ScanoutRebuild AFTER reading our prior ScanoutRebuild from the
        // resize handler; the GPU process's wire dispatch is sequential
        // per fd, so any old in-flight bracket frames already ran).
        // First-time bring-up: the map is empty for outputId=0, no-op.
        for (auto it = scanoutBufIdToSlot.begin();
             it != scanoutBufIdToSlot.end();) {
            if (it->second.first == 0) {
                const uint32_t bufId = it->first;
                surfaceBufs.erase(bufId);
                auto fit = scanoutFenceFdByBufId.find(bufId);
                if (fit != scanoutFenceFdByBufId.end()) {
                    if (fit->second >= 0) ::close(fit->second);
                    scanoutFenceFdByBufId.erase(fit);
                }
                it = scanoutBufIdToSlot.erase(it);
            } else {
                ++it;
            }
        }
        wgpu::SharedTextureMemory mems[3];
        wgpu::Texture texs[3];
        for (int i = 0; i < 3; ++i) {
            const auto& slot = ring->slot(i);
            mems[i] = slot.mem;
            texs[i] = slot.tex;
        }
        const bool injectOk = injectScanoutRingSlots(0, p, mems, texs);
        sendScanoutReady(0, injectOk);
        if (injectOk) {
            std::printf("[gpu] nested scanout ready for output 0 (3 slots injected)\n");
        }
        return injectOk;
    };

    // Nested scanout bring-up (analogue of the KMS block above): allocate
    // the host-attached dmabuf scanout ring on the core device, wait for
    // one ScanoutReserve from the core on the WIRE, and inject the slots
    // at the reserved wire handles. The flow mirrors KMS exactly; the
    // only differences are (a) one output instead of N, and (b) the
    // sink-specific "wl_buffer for this dmabuf" lives in
    // HostWindowOutputBackend rather than the kms kernel framebuffer id.
    if (!headless && !outputKms) {
        auto* hb = static_cast<gpu::HostWindowOutputBackend*>(output.get());
        // The scanout fourcc is BGRA8Unorm's DRM fourcc (DRM_FORMAT_ARGB8888
        // / 0x34325241). It must match the format the core advertises in
        // its ReserveTexture; the core picks BGRA8Unorm for the scanout
        // ring (see bringUp's wantSurface branch).
        constexpr uint32_t kScanoutFourcc = 0x34325241u;  // DRM_FORMAT_ARGB8888
        if (!hb->initScanout(alloc.gbm(), coreDevice, kScanoutFourcc)) {
            std::fprintf(stderr, "[gpu] HostWindowOutputBackend::initScanout failed\n");
            return 1;
        }

        // Wait for exactly one ScanoutReserve from the core for outputId=0.
        uint32_t reservesHandled = 0;
        dispatchCoreControlFrame = [&](ipc::FrameKind kind,
                                       const std::vector<uint8_t>& frame,
                                       const int* /*fds*/, int nfds) {
            if (kind != ipc::FrameKind::ScanoutReserve) {
                std::fprintf(stderr,
                    "[gpu] nested startup: unexpected wire frame kind=%u (expected ScanoutReserve)\n",
                    static_cast<unsigned>(kind));
                std::abort();
            }
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] nested startup: ScanoutReserve with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::ScanoutReservePayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] nested startup: ScanoutReserve bad payload size %zu\n", frame.size());
                std::abort();
            }
            auto p = ipc::ScanoutReservePayload::decode(frame.data());
            if (!handleNestedScanoutReserve(p)) {
                std::fprintf(stderr,
                    "[gpu] nested startup: ScanoutReserve handling failed\n");
                std::abort();
            }
            ++reservesHandled;
        };
        for (int i = 0; i < 500000 && reservesHandled < 1; ++i) {
            pumpWire();
            usleepShort();
        }
        if (reservesHandled < 1) {
            std::fprintf(stderr, "[gpu] no ScanoutReserve received (nested)\n");
            return 1;
        }
        dispatchCoreControlFrame = nullptr;

        // Wire the host's wl_buffer.release event to a ScanoutFlipComplete
        // ctrl message. This is the nested equivalent of KMS's
        // ScanoutFlipComplete: the slot just released is now FREE on our
        // side, the core advances its slot state machine, and the addon's
        // wake state machine drives the next render. surfaceBufId carries
        // the SLOT INDEX (matching the KMS encoding the core's drainCtrl
        // already handles).
        hb->setBufferReleaseListener([ctrlFd](int retiredSlotIdx) {
            ipc::Message m{};
            m.tag = ipc::Tag::ScanoutFlipComplete;
            m.outputId = 0;
            m.surfaceBufId = static_cast<uint32_t>(retiredSlotIdx);
            ipc::sendMessage(ctrlFd, m);
        });
    }

    // Host-window resize handler (NESTED only). The host fires
    // xdg_toplevel.configure(w,h) when the user resizes the overdraw window;
    // HostWindow acks it and calls onSize, which invokes this listener with
    // the new dimensions. We do three things, in order:
    //
    //   1) Erase the old ring's surfaceBufs / fence-fd / slot-routing for
    //      outputId=0 BEFORE the ring is rebuilt. The wgpu::Texture refs in
    //      surfaceBufs would otherwise keep the old slot textures alive
    //      past their dmabuf-fd-close.
    //   2) Re-init the host scanout ring at the new dimensions. This
    //      re-allocates the per-slot dmabufs + re-wraps each as a fresh
    //      host wl_buffer + re-imports each as a fresh wgpu::Texture.
    //   3) Emit ScanoutRebuild on the wire. Wire-FIFO with any in-flight
    //      ProducerBegin/End for the prior ring: those drain first, then
    //      the core's ScanoutRebuild handler runs reserveScanoutForOutput
    //      and the new ring's slots get InjectTexture'd at freshly
    //      reserved wire handles. The OutputDescriptor also rides ctrl so
    //      the JS layer reflows clients to the new size.
    if (!headless && !outputKms) {
        auto* hb = static_cast<gpu::HostWindowOutputBackend*>(output.get());
        constexpr uint32_t kScanoutFourcc = 0x34325241u;  // DRM_FORMAT_ARGB8888
        output->setResizeListener(
            [&output, &serializer, hb, &alloc, &coreDevice, ctrlFd]
            (uint32_t newW, uint32_t newH) {
                // Rebuild the ring at the new dimensions. initScanout()
                // internally clear()s the old ring -- destroying its
                // wl_buffers and closing its dmabuf fds -- BEFORE
                // allocating fresh slots. But we do NOT erase the old
                // bookkeeping (surfaceBufs / scanoutBufIdToSlot /
                // scanoutFenceFdByBufId) here: the wire socket may still
                // have queued ProducerBegin / EndAccess frames against
                // the old slot bufIds in the kernel recv buffer, and
                // dropping the SurfaceBuf entry before those drain would
                // fail Begin with "unknown surfaceBufId" and abort. The
                // teardown happens lazily inside handleNestedScanoutReserve,
                // which runs AFTER the core's ScanoutRebuild reply and
                // after any in-flight wire frames for the old ring have
                // been processed by FIFO ordering.
                if (!hb->initScanout(alloc.gbm(), coreDevice, kScanoutFourcc)) {
                    std::fprintf(stderr,
                        "[gpu] resize: HostWindowOutputBackend::initScanout(%ux%u) failed\n",
                        newW, newH);
                    return;
                }
                // Tell the core to re-reserve at the new dims. The core's
                // ScanoutRebuild handler erases its prior ScanoutOutput,
                // runs reserveScanoutForOutput, and writes a fresh
                // ScanoutReserve back. Our steady-state wire dispatcher
                // routes it to handleNestedScanoutReserve which sweeps
                // the old slot bookkeeping and injects the new slots'
                // textures.
                ipc::ScanoutRebuildPayload reply{};
                reply.outputId = 0;
                reply.width    = newW;
                reply.height   = newH;
                uint8_t reBuf[ipc::ScanoutRebuildPayload::kSize];
                reply.encode(reBuf);
                serializer.appendFrame(ipc::FrameKind::ScanoutRebuild,
                                       reBuf, sizeof(reBuf));

                // Also send a fresh OutputDescriptor on ctrl so the JS
                // layer updates state.outputs, reflows the WM, and re-
                // emits wl_output / xdg_output to bound clients.
                gpu::OutputDescriptorInfo info{};
                output->describeOutput(info);
                ipc::Message m{};
                m.tag = ipc::Tag::OutputDescriptor;
                // outputId 0: the nested backend drives one output.
                fillOutputMsgFromInfo(0, info, m);
                ipc::sendMessage(ctrlFd, m);
                std::printf("[gpu] resize -> %ux%u; rebuilt scanout ring; sent ScanoutRebuild + OutputDescriptor\n",
                            newW, newH);
                // Resize-deadlock break: after a rebuild the host won't
                // fire wl_surface.frame.done until we commit something
                // (its frame callback signals frame-actually-displayed,
                // not a free-running vblank). The JS render loop is
                // gated on FrameComplete via runFrameIfReady, so without
                // a wake nothing commits and the host never fires
                // frame.done -- deadlock. Send a one-shot FrameComplete
                // to kick the JS loop into rendering a frame at the new
                // size; that commit then resumes the normal frame.done
                // chain.
                ipc::Message kick{};
                kick.tag = ipc::Tag::FrameComplete;
                ipc::sendMessage(ctrlFd, kick);
            });
    }

    // Two host-side signals drive the present loop in nested mode:
    //
    //   (a) wl_surface.frame.done: the host is ready for the next frame.
    //       Forwarded as Tag::FrameComplete to the core, which wakes the
    //       JS compositor's render loop. Frame-callback chain self-arms
    //       inside HostWindow::onFrameCallbackDone, so priming once here
    //       is enough.
    //
    //   (b) wl_buffer.release(slot N): the host is done sampling slot N's
    //       dmabuf; the slot is reusable. Forwarded as
    //       Tag::ScanoutFlipComplete with surfaceBufId = slot index. The
    //       core flips its slot state machine: slot N -> FREE. Wired up
    //       via setBufferReleaseListener during the nested scanout
    //       bring-up above.
    //
    // Both signals are needed: (a) is the per-vblank "you may render" beat,
    // (b) is per-slot recyclability. Without (a) the loop never re-fires
    // after the first present; without (b) a slot stays PENDING forever
    // and acquireOutputTextureHandle eventually returns null.
    if (!headless && !outputKms) {
        output->setFrameDoneListener([ctrlFd](uint64_t tvSec, uint32_t tvNsec) {
            ipc::Message m{};
            m.tag = ipc::Tag::FrameComplete;
            // Host wl_surface.frame timestamp -- forwarded for
            // wp_presentation. Sequence stays 0 (the wl protocol has no
            // vsync sequence number).
            m.tvSec  = tvSec;
            m.tvNsec = tvNsec;
            m.seq    = 0;
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

    // wl_shm pools the core has registered with us. The core dups its shm fd
    // and sends it on FrameKind::RegisterShmPool; we mmap it as a read-only
    // CPU view used to stage shm-upload bytes into Vulkan staging buffers
    // (see FrameKind::ShmUpload). munmap + close on FrameKind::UnregisterShmPool.
    struct ShmPool {
        int fd = -1;
        const uint8_t* base = nullptr;
        size_t size = 0;
    };
    std::unordered_map<uint32_t, ShmPool> shmPools;

    // Per-surface textures injected via FrameKind::AllocShmTex. The core's
    // wire-client ReserveTexture'd a wire handle for a sampleable BGRA8
    // texture; we created the native wgpu::Texture and InjectTexture'd it
    // at that handle, and we keep a ref here so subsequent ShmUpload frames
    // can resolve surfaceId -> native texture (where we read the underlying
    // VkImage via WGPUTexture and do vkCmdCopyBufferToImage).
    struct ShmTex {
        wgpu::Texture tex;
        uint32_t width = 0;
        uint32_t height = 0;
    };
    std::unordered_map<uint32_t, ShmTex> shmTextures;

    // Cross-channel barrier on the CORE wire reader. Used by ReleaseClientTex
    // (ctrl, with a wire-byte serial sampled at release time): the erase must
    // wait until the wire reader has consumed past every in-band BeginAccess /
    // EndAccess frame already queued ahead of the release, otherwise a pending
    // Begin would find the texture gone. ImportClientTex rides in-band as
    // kind=3 on the wire, so it is naturally FIFO-ordered and needs no barrier.
    ipc::WireBarrier coreWireBarrier;

    // 9) Service Dawn + the host window until the core requests shutdown or the
    //    host window is closed. The core drives the swapchain over the wire.
    bool shutdown = false;

    // --- Plugin wire connections ----------------------------------------------
    // Each plugin gets its OWN wire connection (architecture.md "IPC": one
    // dawn::wire::Server per connected client). The connection's GPU-end fd is
    // delivered by the core over the side channel (AddWireConn, SCM_RIGHTS); there
    // is NO listening socket, so only the trusted core can introduce a connection.
    // Each connection has its own WireServer + serializer + reader + native
    // instance; the plugin's wire client (in its Worker) drives ReserveInstance/
    // RequestAdapter/RequestDevice over it, exactly as the core does on its own
    // connection. The native device is resolved lazily (server.GetDevice) when the
    // plugin first needs server-side work (STM import).
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
    // one reads (the "consumer"). The cross-device fence is applied per
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
    // scanoutFenceFdByBufId[surfaceBufId] for the next ScanoutPresent to
    // attach as the atomic commit's IN_FENCE_FD.
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
        // SharedTextureMemoryVkImageLayoutEndState's generated ctor does NOT
        // zero its int32_t fields (it sets sType only). EndAccess writes them
        // only when the bracket actually used the texture; a no-op bracket
        // (lastUsageSerial == kBeginningOfGPUTime in Dawn's
        // SharedResourceMemory.cpp) leaves them as uninitialized stack memory.
        // Reading that into sb.layout then feeds garbage into the NEXT Begin's
        // oldLayout, producing VUID-VkImageMemoryBarrier-oldLayout-parameter
        // ("oldLayout (N) does not fall within the begin..end range of the
        // VkImageLayout enumeration tokens"). Pre-zero + only-adopt-if-set
        // mirrors the same defensive pattern used by runEndClientAccess.
        wgpu::SharedTextureMemoryVkImageLayoutEndState endLayout{};
        endLayout.oldLayout = 0;  // VK_IMAGE_LAYOUT_UNDEFINED
        endLayout.newLayout = 0;
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
        // Only adopt the returned layout when Dawn actually wrote one (the
        // texture was used in this bracket). A 0 (UNDEFINED) return is the
        // no-work case: keep sb.layout's prior value so the next Begin's
        // oldLayout chain stays consistent with the last real End.
        if (endLayout.newLayout != 0) {
            sb.layout = endLayout.newLayout;
        }

        // Scanout producer EndAccess: a scanout SurfaceBuf has no wgpu
        // consumer device to import the fence into, so the regular
        // cross-device fence-handoff path below doesn't apply.
        //
        //   KMS: capture the raw sync_file fd; the next ScanoutPresent
        //   attaches it as the atomic commit's IN_FENCE_FD so the display
        //   engine waits on our render.
        //
        //   Nested host-window: don't capture. We don't bind
        //   wp_linux_drm_syncobj_v1 on the host connection, so we have
        //   nowhere to deliver an explicit-sync acquire point. We rely
        //   on the kernel's dma-buf reservation: Vulkan/GBM on Mesa
        //   attaches an implicit write fence to the dmabuf as part of
        //   the queue submit, and the host's display engine waits on
        //   that fence before sampling. This is correct on Mesa. It is
        //   NOT correct on the NVIDIA proprietary driver, which does
        //   not attach implicit fences; see docs/status.md "silent-gap
        //   risks" -- a follow-on commit will bind the host's
        //   wp_linux_drm_syncobj_v1 and forward the captured sync_file
        //   as an explicit acquire-timeline point.
        {
            auto sit = scanoutBufIdToSlot.find(surfaceBufId);
            if (sit != scanoutBufIdToSlot.end() && producer) {
#if OVERDRAW_KMS
                if (kms) {
                    // KMS path: capture for the next ScanoutPresent.
                    // Look up by find() -- operator[] would value-
                    // initialize the map entry to 0, which close() would
                    // then interpret as fd 0 and wedge a subsequent
                    // ioctl.
                    auto fit = scanoutFenceFdByBufId.find(surfaceBufId);
                    if (fit != scanoutFenceFdByBufId.end()) {
                        if (fit->second >= 0) ::close(fit->second);
                        scanoutFenceFdByBufId.erase(fit);
                    }
                    if (endState.fenceCount >= 1) {
                        wgpu::SharedFenceExportInfo exp{};
                        wgpu::SharedFenceSyncFDExportInfo syncExp{};
                        exp.nextInChain = &syncExp;
                        endState.fences[0].ExportInfo(&exp);
                        if (syncExp.handle >= 0) {
                            int dupFd = ::dup(syncExp.handle);
                            if (dupFd >= 0) {
                                scanoutFenceFdByBufId[surfaceBufId] = dupFd;
                            } else {
                                std::fprintf(stderr,
                                    "[gpu] scanout EndAccess: dup(syncfd=%d) failed: %s\n",
                                    syncExp.handle, std::strerror(errno));
                            }
                        }
                    }
                }
#endif
                // Nested: no capture; implicit-sync via the dmabuf
                // reservation handles the host's wait. Skip the consumer-
                // side fence import below either way.
                return;
            }
        }

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
    // buffer, WAITING the other side's last fence (cross-device fence,
    // in-process here). The dmabuf's Vulkan layout continues from the last
    // EndAccess. Returns true iff the bracket opened (the ctrl-dispatch caller
    // turns this into a *BeginDone reply; in-band dispatch ignores the bool and
    // hard-fails on false). Mirrors runSurfaceEnd's (surfaceBufId, producer)
    // shape so both the ctrl branch and the kind=1 wire dispatch can call it.
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
    // serial may never arrive. Producer/consumer Begin/End ride the wire in-band,
    // ordered by FIFO, and do not use the barrier.)
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

    // Open a per-frame BeginAccess on a cached client texture. When the core
    // passes an explicit acquire sync_file fd (>= 0) -- the wp_linux_drm_syncobj_v1
    // path -- that fd is used as the Dawn acquire fence. Otherwise the dmabuf's
    // implicit-sync acquire fence is re-exported here via EXPORT_SYNC_FILE
    // (the implicit-sync path). Either way, the prior frame's EndAccess fence
    // is also chained so Dawn waits on both.
    //
    // explicitAcquireFd, when >= 0, is owned by this function (it closes it
    // after import).
    auto runBeginClientAccess = [&](uint32_t textureId, uint32_t textureGen,
                                    int explicitAcquireFd) -> bool {
        auto it = clientTextures.find(textureId);
        if (it == clientTextures.end() || it->second.generation != textureGen) {
            std::fprintf(stderr,
                "[gpu] BeginClientAccess: unknown texture {%u,%u} (have gen %d) @wire=%zu\n",
                textureId, textureGen,
                it == clientTextures.end() ? -1 : (int)it->second.generation,
                wireReader.bytesConsumed());
            if (explicitAcquireFd >= 0) ::close(explicitAcquireFd);
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
            if (explicitAcquireFd >= 0) ::close(explicitAcquireFd);
            return false;
        }

        // Acquire fence: explicit when the core (wp_linux_drm_syncobj_v1) sent
        // a sync_file fd alongside this BeginAccess; otherwise the dmabuf's
        // current implicit-sync read-acquire sync_file. Explicit sync is
        // required for clients (e.g. the NVIDIA proprietary driver) that do
        // not attach implicit fences to their dmabufs -- their EXPORT_SYNC_FILE
        // returns an already-signaled stub fence, so without the explicit path
        // the compositor's sample races the client's pending GPU writes.
        int syncFd = explicitAcquireFd;
        if (syncFd < 0) syncFd = exportDmabufAcquireFence(ct.fd);
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
    // Helper: send a SurfaceBufAllocated reply over the wire (FIFO with the
    // outgoing Dawn injection commands the alloc just appended, so any
    // ProducerBegin / ConsumerBegin the core writes after seeing this reply
    // is FIFO-after the surfaceBufs map insert).
    auto sendSurfaceBufAllocated = [&serializer](uint32_t surfaceBufId,
                                                  uint32_t connId, bool ok) {
        ipc::SurfaceBufAllocatedPayload reply{};
        reply.surfaceBufId = surfaceBufId;
        reply.connId       = connId;
        reply.ok           = ok ? 1 : 0;
        uint8_t buf[ipc::SurfaceBufAllocatedPayload::kSize];
        reply.encode(buf);
        serializer.appendFrame(ipc::FrameKind::SurfaceBufAllocated, buf, sizeof(buf));
    };

    auto allocSurfaceBufImpl = [&](const ipc::AllocSurfaceBufPayload& m,
                                    bool producerOnCore) {
        // Identify the plugin connection that owns the plugin-side device, in
        // both directions: the surface buffer is associated with one plugin
        // (connId) regardless of which side produces.
        PluginConn* pc = nullptr;
        for (auto& c : pluginConns) if (c->connId == m.connId) { pc = c.get(); break; }

        // Resolve the producer and consumer devices according to producerOnCore.
        WGPUDevice producerNative = nullptr;
        WGPUDevice consumerNative = nullptr;
        if (producerOnCore) {
            producerNative = server.GetDevice(m.coreDevice.id, m.coreDevice.generation);
            consumerNative = pc ?
                pc->server->GetDevice(m.pluginDevice.id, m.pluginDevice.generation) : nullptr;
        } else {
            producerNative = pc ?
                pc->server->GetDevice(m.pluginDevice.id, m.pluginDevice.generation) : nullptr;
            consumerNative = server.GetDevice(m.coreDevice.id, m.coreDevice.generation);
        }
        const char* tagName = producerOnCore ? "AllocComposeBuf" : "AllocSurfaceBuf";
        if (!pc || !producerNative || !consumerNative) {
            std::fprintf(stderr, "[gpu] %s: device resolve failed "
                         "(pc=%d producer=%p consumer=%p)\n", tagName, pc ? 1 : 0,
                         static_cast<void*>(producerNative),
                         static_cast<void*>(consumerNative));
            sendSurfaceBufAllocated(m.surfaceBufId, m.connId, false);
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
            sendSurfaceBufAllocated(m.surfaceBufId, m.connId, false);
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
            ipc::AllocSurfaceBufPayload msg;
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
        auto finalize = [&surfaceBufs, &alloc, &serializer, sendSurfaceBufAllocated,
                         state, tagName]() {
            const bool ok = state->producerOk && state->consumerOk;
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
            sendSurfaceBufAllocated(state->msg.surfaceBufId, state->msg.connId, ok);
        };
        // The two injects go on the wires their target device lives on. The
        // serial each waits for is the reserve-point on that wire.
        //   producerOnCore=false: producer on plugin wire, consumer on core wire.
        //   producerOnCore=true:  producer on core wire, consumer on plugin wire.
        const uint64_t producerSerial = producerOnCore ? m.wireSerial : m.reservePointSerial;
        const uint64_t consumerSerial = producerOnCore ? m.reservePointSerial : m.wireSerial;

        auto doProducerInject = [pc, &server, &serializer, state, finalize]() {
            const auto& msg = state->msg;
            if (state->producerOnCore) {
                state->producerOk = server.InjectTexture(
                    state->sb.producerTex.Get(),
                    {msg.coreTexture.id, msg.coreTexture.generation},
                    {msg.coreDevice.id, msg.coreDevice.generation});
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
                    {msg.coreTexture.id, msg.coreTexture.generation},
                    {msg.coreDevice.id, msg.coreDevice.generation});
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
    // not transient races. A soft-fail (reply ok=0, skip the surface) would mask
    // the bug as a silent glitch; a loud abort surfaces it.
    dispatchCoreControlFrame = [&](ipc::FrameKind kind, const std::vector<uint8_t>& frame,
                                   const int* fds, int nfds) {
        if (frame.empty()) {
            std::fprintf(stderr, "[gpu] core wire: empty control frame\n");
            std::abort();
        }
        if (kind == ipc::FrameKind::ScanoutReserve) {
            // Runtime ring bring-up (KMS hotplug; nested resize). The core
            // ReserveTexture'd three wire handles + appended this
            // ScanoutReserve frame; the FIFO ordering of the wire socket
            // guarantees that by here the wire server has already
            // processed the ReserveTexture commands, so InjectTexture at
            // each handle succeeds. Any subsequent ProducerBegin frame
            // referencing the new bufIds is FIFO-after this frame and
            // will find the bufIds registered in surfaceBufs.
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] core wire: ScanoutReserve with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::ScanoutReservePayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad ScanoutReserve payload size %zu\n", frame.size());
                std::abort();
            }
            auto p = ipc::ScanoutReservePayload::decode(frame.data());
#if OVERDRAW_KMS
            if (kms) {
                (void)handleScanoutReserve(p);  // ScanoutReady (ok=0/1) emitted from inside
                return;
            }
#endif
            if (!headless && !outputKms) {
                (void)handleNestedScanoutReserve(p);
                return;
            }
            std::fprintf(stderr,
                "[gpu] core wire: ScanoutReserve with no backend to handle it (outputId=%u)\n",
                p.outputId);
            std::abort();
        }
        if (kind == ipc::FrameKind::SwitchMode) {
            // Mode change for one already-connected output. Wire-FIFO with
            // any in-flight ProducerBegin/End on this output's prior ring:
            // the brackets above us close first (their surfaceBufs entries
            // are still live), then we tear down + reallocate, then we emit
            // ScanoutRebuild on the wire. The core's reply (ScanoutReserve
            // for the new dims) lands back in this same handler later.
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] core wire: SwitchMode with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::SwitchModePayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad SwitchMode payload size %zu\n", frame.size());
                std::abort();
            }
            auto p = ipc::SwitchModePayload::decode(frame.data());
            if (!kms) {
                std::fprintf(stderr,
                    "[gpu] SwitchMode: no kms backend (nested mode?) outputId=%u\n",
                    p.outputId);
                return;
            }
            // Erase the old ring's surfaceBufs / fence-fd / slot-routing
            // entries BEFORE the ring is torn down. The wgpu::Texture refs
            // in surfaceBufs would keep the old textures alive otherwise.
            for (auto it = scanoutBufIdToSlot.begin();
                 it != scanoutBufIdToSlot.end();) {
                if (it->second.first == p.outputId) {
                    const uint32_t bufId = it->first;
                    surfaceBufs.erase(bufId);
                    auto fit = scanoutFenceFdByBufId.find(bufId);
                    if (fit != scanoutFenceFdByBufId.end()) {
                        if (fit->second >= 0) ::close(fit->second);
                        scanoutFenceFdByBufId.erase(fit);
                    }
                    it = scanoutBufIdToSlot.erase(it);
                } else {
                    ++it;
                }
            }
            if (!kms->switchMode(p.outputId, p.width, p.height, p.refreshMhz,
                                  coreDevice)) {
                // switchMode logs the cause. The output stays in outputs_ but
                // its ring is torn down, so JS-side renders for it are
                // silently dropped. Do NOT
                // emit ScanoutRebuild -- there is no new ring for the core
                // to reserve into.
                std::fprintf(stderr,
                    "[gpu] SwitchMode failed for outputId=%u (mode missing or "
                    "ring re-init failed); output is dark until a successful "
                    "switch or hotplug cycle\n", p.outputId);
                return;
            }
            // Emit ScanoutRebuild so the core releases its prior
            // ScanoutOutput bookkeeping and reserves fresh wire handles
            // at the new dims. handleScanoutReserve will run when the
            // reply lands.
            gpu::OutputDescriptorInfo info{};
            kms->describeOutputAt(p.outputId, info);
            ipc::ScanoutRebuildPayload reply{};
            reply.outputId = p.outputId;
            reply.width    = info.width;
            reply.height   = info.height;
            uint8_t buf[ipc::ScanoutRebuildPayload::kSize];
            reply.encode(buf);
            serializer.appendFrame(ipc::FrameKind::ScanoutRebuild, buf, sizeof(buf));
            // Also send an OutputDescriptor on ctrl so the core's JS-side
            // state.outputs[outputId] picks up the new device dims / refresh.
            // OutputDescriptor handler in main.ts's setOnOutputDescriptor
            // already covers the existing-rec branch (no global churn).
            ipc::Message m{};
            m.tag = ipc::Tag::OutputDescriptor;
            fillOutputMsg(p.outputId, m);
            ctrlSender.send(m);
            std::printf("[gpu] SwitchMode applied + ScanoutRebuild sent for "
                        "outputId=%u %ux%u @%u.%03uHz\n",
                        p.outputId, info.width, info.height,
                        info.refreshMhz / 1000, info.refreshMhz % 1000);
            return;
        }
        if (kind == ipc::FrameKind::ScanoutPresent) {
            // Per-frame flip. Wire-FIFO with the slot's render submit and
            // producer EndAccess: by here runSurfaceEnd has captured the
            // render-done sync_file into scanoutFenceFdByBufId, so the KMS
            // commit always carries its IN_FENCE_FD. The payload names the
            // slot by surfaceBufId, NOT slot index -- map it back to
            // {output, slot} and dispatch by which backend owns the output.
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] core wire: ScanoutPresent with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::ScanoutPresentPayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad ScanoutPresent payload size %zu\n", frame.size());
                std::abort();
            }
            auto p = ipc::ScanoutPresentPayload::decode(frame.data());
            auto sit = scanoutBufIdToSlot.find(p.surfaceBufId);
            if (sit == scanoutBufIdToSlot.end()) {
                // A flip queued before this output's ring was torn down
                // (hotplug remove, SwitchMode): drop it.
                std::fprintf(stderr,
                    "[gpu] ScanoutPresent: unknown surfaceBufId=%u\n",
                    p.surfaceBufId);
                return;
            }
            const uint32_t outputId = sit->second.first;
            const int slot = sit->second.second;
#if OVERDRAW_KMS
            if (kms) {
                int fenceFd = -1;
                auto fit = scanoutFenceFdByBufId.find(p.surfaceBufId);
                if (fit != scanoutFenceFdByBufId.end()) {
                    fenceFd = fit->second;
                    scanoutFenceFdByBufId.erase(fit);
                }
                if (!kms->presentScanoutAt(outputId, slot, fenceFd)) {
                    std::fprintf(stderr,
                        "[gpu] presentScanoutAt(output=%u, slot=%d) rejected by kernel\n",
                        outputId, slot);
                }
                if (fenceFd >= 0) ::close(fenceFd);
                return;
            }
#endif
            if (!headless && !outputKms) {
                auto* hb = static_cast<gpu::HostWindowOutputBackend*>(output.get());
                hb->presentScanout(slot);
            }
            return;
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
        if (kind == ipc::FrameKind::ReleaseClientTex) {
            // Release a JS-compositor dmabuf import: drop the STM + close
            // the fd. Wire-FIFO with the per-frame BeginAccess/EndAccess
            // brackets for this handle (also wire frames), so every
            // bracket the core wrote before this release has already been
            // decoded by here -- no wireSerial workaround needed.
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] core wire: ReleaseClientTex with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::ReleaseClientTexPayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad ReleaseClientTex payload size %zu\n",
                    frame.size());
                std::abort();
            }
            auto p = ipc::ReleaseClientTexPayload::decode(frame.data());
            auto it = clientTextures.find(p.texture.id);
            if (it == clientTextures.end() || it->second.generation != p.texture.generation) {
                return;  // already recycled into a newer import
            }
            ClientTex& ct = it->second;
            // Defensive: end a still-open bracket. Shouldn't happen now
            // that the erase waits for the wire to drain past the
            // brackets, but covers a misbehaved core.
            if (ct.accessOpen) {
                wgpu::SharedTextureMemoryVkImageLayoutEndState endLayout{};
                wgpu::SharedTextureMemoryEndAccessState endState{};
                endState.nextInChain = &endLayout;
                (void)ct.mem.EndAccess(ct.tex, &endState);
                ct.accessOpen = false;
            }
            if (ct.fd >= 0) ::close(ct.fd);
            clientTextures.erase(it);
            return;
        }
        if (kind == ipc::FrameKind::RegisterShmPool) {
            // Core registered a wl_shm pool. The memfd rides as exactly one
            // SCM_RIGHTS fd. mmap it read-only so ShmUpload can stage from it.
            if (nfds != 1) {
                std::fprintf(stderr,
                    "[gpu] core wire: RegisterShmPool expects nfds=1, got %d\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::RegisterShmPoolPayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad RegisterShmPool payload size %zu\n",
                    frame.size());
                std::abort();
            }
            auto p = ipc::RegisterShmPoolPayload::decode(frame.data());
            const int fd = fds[0];
            if (p.size == 0 || p.size > static_cast<uint64_t>(SIZE_MAX)) {
                std::fprintf(stderr,
                    "[gpu] RegisterShmPool: bad size %llu (poolId=%u)\n",
                    static_cast<unsigned long long>(p.size), p.poolId);
                ::close(fd);
                return;
            }
            void* base = ::mmap(nullptr, static_cast<size_t>(p.size),
                                PROT_READ, MAP_SHARED, fd, 0);
            if (base == MAP_FAILED) {
                std::fprintf(stderr,
                    "[gpu] RegisterShmPool: mmap failed (poolId=%u, size=%zu): %s\n",
                    p.poolId, static_cast<size_t>(p.size), std::strerror(errno));
                ::close(fd);
                return;
            }
            // Replace any existing pool with the same id (shouldn't happen --
            // poolIds are monotonic in the core's registry, never reused -- but
            // be defensive: unmap the old one if it's there).
            auto [it, inserted] = shmPools.try_emplace(p.poolId);
            if (!inserted) {
                if (it->second.base) ::munmap(const_cast<uint8_t*>(it->second.base),
                                              it->second.size);
                if (it->second.fd >= 0) ::close(it->second.fd);
            }
            it->second.fd = fd;
            it->second.base = static_cast<const uint8_t*>(base);
            it->second.size = static_cast<size_t>(p.size);
            return;
        }
        if (kind == ipc::FrameKind::UnregisterShmPool) {
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] core wire: UnregisterShmPool with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::UnregisterShmPoolPayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad UnregisterShmPool payload size %zu\n",
                    frame.size());
                std::abort();
            }
            auto p = ipc::UnregisterShmPoolPayload::decode(frame.data());
            auto it = shmPools.find(p.poolId);
            if (it == shmPools.end()) return;
            if (it->second.base) {
                ::munmap(const_cast<uint8_t*>(it->second.base), it->second.size);
            }
            if (it->second.fd >= 0) ::close(it->second.fd);
            shmPools.erase(it);
            return;
        }
        if (kind == ipc::FrameKind::ResizeShmPool) {
            // Core mirrored a wl_shm_pool.resize (pools only grow). Remap so
            // ShmUpload regions past the old size stay in bounds; wire FIFO
            // guarantees this lands before any upload that needs the growth.
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] core wire: ResizeShmPool with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::ResizeShmPoolPayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad ResizeShmPool payload size %zu\n",
                    frame.size());
                std::abort();
            }
            auto p = ipc::ResizeShmPoolPayload::decode(frame.data());
            auto it = shmPools.find(p.poolId);
            if (it == shmPools.end()) return;  // registration failed earlier; uploads
                                               // for this pool already no-op
            if (p.size <= it->second.size) return;
            void* nb = ::mremap(const_cast<uint8_t*>(it->second.base),
                                it->second.size, static_cast<size_t>(p.size),
                                MREMAP_MAYMOVE);
            if (nb == MAP_FAILED) {
                std::fprintf(stderr,
                    "[gpu] ResizeShmPool: mremap failed (poolId=%u, %zu -> %zu): %s\n",
                    p.poolId, it->second.size, static_cast<size_t>(p.size),
                    std::strerror(errno));
                return;
            }
            it->second.base = static_cast<const uint8_t*>(nb);
            it->second.size = static_cast<size_t>(p.size);
            return;
        }
        if (kind == ipc::FrameKind::AllocShmTex) {
            // Core reserved a wire texture handle for an shm surface. Create
            // a native BGRA8 texture and Inject at the reserved handle.
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] core wire: AllocShmTex with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::AllocShmTexPayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad AllocShmTex payload size %zu\n",
                    frame.size());
                std::abort();
            }
            auto p = ipc::AllocShmTexPayload::decode(frame.data());
            wgpu::TextureDescriptor td{};
            td.size = {p.width, p.height, 1};
            td.format = wgpu::TextureFormat::BGRA8Unorm;
            // Usage shape for an shm-backed surface texture: sampled + copy dst
            // (queue.WriteTexture target) + copy src (intercepts copy the client
            // texture into a dmabuf consumer).
            td.usage = wgpu::TextureUsage::TextureBinding
                     | wgpu::TextureUsage::CopyDst
                     | wgpu::TextureUsage::CopySrc;
            wgpu::Texture tex = coreDevice.CreateTexture(&td);
            if (!server.InjectTexture(tex.Get(),
                                      {p.texture.id, p.texture.generation},
                                      {p.device.id, p.device.generation})) {
                std::fprintf(stderr,
                    "[gpu] AllocShmTex: InjectTexture failed (surfaceId=%u, "
                    "handle=%u/%u)\n",
                    p.surfaceId, p.texture.id, p.texture.generation);
                return;
            }
            serializer.Flush();
            // Replace any prior texture at this surfaceId (resize: the core
            // discards the old wrapTexture'd handle and reserves a new one).
            shmTextures[p.surfaceId] = ShmTex{std::move(tex), p.width, p.height};
            return;
        }
        if (kind == ipc::FrameKind::ShmUpload) {
            // Upload an shm region into a previously-AllocShmTex'd texture.
            // queue.WriteTexture runs natively in-process; no wire bulk
            // transfer. Sends ShmUploaded back so the core can release the
            // wl_buffer to the client (copy-then-release).
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] core wire: ShmUpload with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            ipc::ShmUploadPayload p{};
            if (!ipc::ShmUploadPayload::decode(frame.data(), frame.size(), p)) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad ShmUpload payload (size %zu)\n",
                    frame.size());
                std::abort();
            }
            // Look up the destination texture + pool.
            auto tit = shmTextures.find(p.surfaceId);
            auto pit = shmPools.find(p.poolId);
            const bool haveTex = tit != shmTextures.end();
            const bool havePool = pit != shmPools.end();
            if (!haveTex || !havePool) {
                std::fprintf(stderr,
                    "[gpu] ShmUpload: missing %s%s (surfaceId=%u poolId=%u "
                    "uploadSeq=%u)\n",
                    !haveTex ? "texture" : "",
                    !havePool ? (!haveTex ? "+pool" : "pool") : "",
                    p.surfaceId, p.poolId, p.uploadSeq);
                // Still ack so the core's pending-release map doesn't leak.
            } else {
                // Bounds-check the upload region against the pool mapping.
                // The source bytes for damage rect (rx, ry, rw, rh) start at
                // pool[offset + ry*stride + rx*4] and need rh*stride - rx*4
                // bytes accessible. For the no-damage (full-buffer) case the
                // region covers offset..offset + height*stride.
                const uint8_t* base = pit->second.base;
                const size_t poolSize = pit->second.size;
                const uint64_t off = p.offset;
                const uint64_t needFull = static_cast<uint64_t>(p.stride) *
                                          static_cast<uint64_t>(p.height);
                if (off > poolSize || needFull > poolSize - off) {
                    std::fprintf(stderr,
                        "[gpu] ShmUpload: region out of pool bounds "
                        "(off=%llu need=%llu pool=%zu)\n",
                        static_cast<unsigned long long>(off),
                        static_cast<unsigned long long>(needFull),
                        poolSize);
                } else {
                    wgpu::Queue queue = coreDevice.GetQueue();
                    wgpu::TexelCopyTextureInfo dst{};
                    dst.texture = tit->second.tex;
                    dst.mipLevel = 0;
                    wgpu::TexelCopyBufferLayout layout{};
                    layout.offset = 0;
                    layout.bytesPerRow = p.stride;
                    layout.rowsPerImage = p.height;
                    auto doFull = [&]() {
                        dst.origin = {0, 0, 0};
                        wgpu::Extent3D ext{p.width, p.height, 1};
                        queue.WriteTexture(&dst, base + off,
                                           static_cast<size_t>(needFull),
                                           &layout, &ext);
                    };
                    if (p.damage.empty()) {
                        doFull();
                    } else {
                        for (const auto& r : p.damage) {
                            // Clamp the damage rect against the buffer extent.
                            // 64-bit: x/y and w/h are client-controlled, so
                            // x + w can exceed INT32_MAX (signed overflow).
                            if (r.w == 0 || r.h == 0) continue;
                            int64_t x0 = r.x, y0 = r.y;
                            if (x0 < 0) x0 = 0;
                            if (y0 < 0) y0 = 0;
                            int64_t x1 = static_cast<int64_t>(r.x) + r.w;
                            int64_t y1 = static_cast<int64_t>(r.y) + r.h;
                            if (x1 > static_cast<int64_t>(p.width))
                                x1 = static_cast<int64_t>(p.width);
                            if (y1 > static_cast<int64_t>(p.height))
                                y1 = static_cast<int64_t>(p.height);
                            if (x1 <= x0 || y1 <= y0) continue;
                            const uint32_t cw = static_cast<uint32_t>(x1 - x0);
                            const uint32_t ch = static_cast<uint32_t>(y1 - y0);
                            const uint64_t rectOff = off
                                + static_cast<uint64_t>(y0) * p.stride
                                + static_cast<uint64_t>(x0) * 4;
                            // WriteTexture from the per-row slice: bytesPerRow
                            // stays the full buffer stride so successive rows
                            // land correctly; rowsPerImage matches the rect
                            // height. The data span runs from the rect's
                            // first-row start to its last-row end inside the
                            // pool.
                            const uint64_t spanBytes =
                                static_cast<uint64_t>(ch - 1) * p.stride
                                + static_cast<uint64_t>(cw) * 4;
                            if (rectOff > poolSize || spanBytes > poolSize - rectOff) {
                                std::fprintf(stderr,
                                    "[gpu] ShmUpload: rect out of pool bounds "
                                    "(rect %d,%d,%u,%u rectOff=%llu span=%llu pool=%zu)\n",
                                    r.x, r.y, r.w, r.h,
                                    static_cast<unsigned long long>(rectOff),
                                    static_cast<unsigned long long>(spanBytes),
                                    poolSize);
                                continue;
                            }
                            dst.origin = {static_cast<uint32_t>(x0),
                                          static_cast<uint32_t>(y0), 0};
                            wgpu::Extent3D ext{cw, ch, 1};
                            queue.WriteTexture(&dst, base + rectOff,
                                               static_cast<size_t>(spanBytes),
                                               &layout, &ext);
                        }
                    }
                }
            }
            // Ack regardless of success: the core's deferred-release map must
            // not leak. The client is free to reuse its shm region now; any
            // missed pixels show up as stale content on the texture, not as
            // protocol-level wedge.
            ipc::ShmUploadedPayload rp{p.uploadSeq};
            uint8_t rbuf[ipc::ShmUploadedPayload::kSize];
            rp.encode(rbuf);
            serializer.appendFrame(ipc::FrameKind::ShmUploaded, rbuf, sizeof(rbuf));
            return;
        }
        if (kind == ipc::FrameKind::AllocSurfaceBuf
            || kind == ipc::FrameKind::AllocComposeBuf) {
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] core wire: Alloc*Buf with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::AllocSurfaceBufPayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad AllocSurfaceBuf payload size %zu\n",
                    frame.size());
                std::abort();
            }
            auto p = ipc::AllocSurfaceBufPayload::decode(frame.data());
            const bool producerOnCore = (kind == ipc::FrameKind::AllocComposeBuf);
            allocSurfaceBufImpl(p, producerOnCore);
            return;
        }
        if (kind == ipc::FrameKind::ReleaseSurfaceBuf) {
            // Destroy a surfaceBuf -- end any still-open access bracket
            // before dropping the SharedTextureMemory + textures + fences
            // + dmabuf. Wire-FIFO with the producer/consumer Begin/End
            // brackets for this buf (also wire frames), so any in-flight
            // bracket is already decoded by here.
            if (nfds != 0) {
                std::fprintf(stderr,
                    "[gpu] core wire: ReleaseSurfaceBuf with nfds=%d (must be 0)\n", nfds);
                std::abort();
            }
            if (frame.size() != ipc::ReleaseSurfaceBufPayload::kSize) {
                std::fprintf(stderr,
                    "[gpu] core wire: bad ReleaseSurfaceBuf payload size %zu\n",
                    frame.size());
                std::abort();
            }
            auto p = ipc::ReleaseSurfaceBufPayload::decode(frame.data());
            auto it = surfaceBufs.find(p.surfaceBufId);
            if (it != surfaceBufs.end()) {
                SurfaceBuf& sb = it->second;
                // Drop any deferred AllocSurfaceBuf inject for this buf on
                // the owning plugin conn's barrier (its wire serial may
                // never arrive now; a yet-to-run alloc inject would target
                // a surfaceBuf we're tearing down). Producer/consumer End
                // are wire-FIFO so they've already drained.
                PluginConn* pc = nullptr;
                for (auto& c : pluginConns)
                    if (c->connId == sb.connId) { pc = c.get(); break; }
                if (pc) {
                    const auto aTag = allocSurfaceBufTag(p.surfaceBufId);
                    pc->barrier.cancel([aTag](ipc::WireBarrier::Tag t) {
                        return t == aTag;
                    });
                }
                if (sb.producerOpen) runSurfaceEnd(p.surfaceBufId, true);
                if (sb.consumerOpen) runSurfaceEnd(p.surfaceBufId, false);
                sb.producerFence = nullptr;
                sb.consumerFence = nullptr;
                sb.producerTex = nullptr;
                sb.consumerTex = nullptr;
                sb.producerMem = nullptr;
                sb.consumerMem = nullptr;
                alloc.release(sb.buf);  // closes the dmabuf fd + GBM bo
                surfaceBufs.erase(it);
            }
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
            bool ok;
            if (kind == ipc::FrameKind::BeginAccess) {
                // Implicit-sync BeginAccess: zero fds (BeginAccessWithFence
                // carries the explicit-sync fd as kind=5 instead).
                if (nfds != 0) {
                    std::fprintf(stderr,
                        "[gpu] core wire: BeginAccess with nfds=%d (must be 0; "
                        "explicit sync uses BeginAccessWithFence)\n", nfds);
                    std::abort();
                }
                ok = runBeginClientAccess(texId, texGen, -1);
            } else if (kind == ipc::FrameKind::BeginAccessWithFence) {
                // Explicit-sync (wp_linux_drm_syncobj_v1) BeginAccess: exactly
                // one SCM_RIGHTS fd, a sync_file the GPU process passes to
                // Dawn as the acquire fence instead of EXPORT_SYNC_FILE.
                if (nfds != 1 || !fds) {
                    std::fprintf(stderr,
                        "[gpu] core wire: BeginAccessWithFence with nfds=%d (must be 1)\n",
                        nfds);
                    std::abort();
                }
                ok = runBeginClientAccess(texId, texGen, fds[0]);
            } else {
                if (nfds != 0) {
                    std::fprintf(stderr,
                        "[gpu] core wire: ClientTex End with nfds=%d (must be 0)\n", nfds);
                    std::abort();
                }
                runEndClientAccess(texId, texGen);
                ok = true;
            }
            if (!ok) {
                // A Begin can fail on a client-influenced path: a rejected
                // dmabuf import leaves no cache entry, and Dawn can refuse
                // BeginAccess on a hostile buffer. Dropping the bracket costs
                // at most a bad frame for that one surface (a render pass
                // referencing the texture fails Dawn validation, which is
                // recoverable); aborting would kill every client's session.
                std::fprintf(stderr,
                    "[gpu] in-band client-texture Begin failed {%u,%u}; "
                    "dropping bracket\n", texId, texGen);
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
            } else if (kind == ipc::FrameKind::EndAccess) {
                runSurfaceEnd(surfaceBufId, producer);
            } else {
                // BeginAccessWithFence on a Surface frame is a wire bug:
                // explicit-sync only applies to client textures.
                std::fprintf(stderr,
                    "[gpu] core wire: kind=%u on Surface variant (only client "
                    "textures support explicit-sync)\n",
                    static_cast<unsigned>(kind));
                std::abort();
            }
        } else {
            std::fprintf(stderr, "[gpu] core wire: unknown access variant %u\n",
                         static_cast<unsigned>(frame[0]));
            std::abort();
        }
    };

    // Drain the core wire barrier: any deferred ctrl op whose serial the wire
    // reader has now passed runs in FIFO order.
    auto drainCoreBarrier = [&]() {
        coreWireBarrier.drain(wireReader.bytesConsumed());
    };


    // Control-message dispatch. Returns false if the core requested shutdown.
    auto dispatchCtrl = [&](const ipc::Message& m, int* recvFds, int nRecvFds) -> void {
        {
            if (m.tag == ipc::Tag::Shutdown) {
                shutdown = true;
#if OVERDRAW_KMS
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
                    // Exactly one fd is expected; close any extras rather
                    // than leak them.
                    for (int i = 1; i < nRecvFds; ++i) ::close(recvFds[i]);
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
                        auto it = surfaceBufs.find(surfaceBufId);
                        // Missing surface = teardown race: the core released
                        // this buf (plugin unmatch / worker shutdown) on ITS
                        // wire while this bracket was in flight on the plugin
                        // wire -- two FIFOs with no cross ordering. The
                        // worker's straggler brackets are harmless: drop them.
                        // (Its render commands against the injected texture
                        // fail Dawn validation on the plugin device; the
                        // release already closed any open bracket.)
                        if (it == surfaceBufs.end()) {
                            std::fprintf(stderr,
                                "[gpu] plugin conn %u: %s %s on released buf=%u "
                                "(teardown race), dropped\n",
                                connId, producer ? "producer" : "consumer",
                                kind == ipc::FrameKind::BeginAccess ? "Begin" : "End",
                                surfaceBufId);
                            return;
                        }
                        // Plugin wire's role expectation is inverted from the
                        // core wire: producerOnCore=false -> plugin produces ->
                        // plugin wire carries PRODUCER frames; producerOnCore=
                        // true (compose buf) -> plugin consumes -> plugin wire
                        // carries CONSUMER frames.
                        const bool expectProducer = !it->second.producerOnCore;
                        if (producer != expectProducer) {
                            std::fprintf(stderr,
                                "[gpu] plugin conn %u: %s frame on plugin wire "
                                "(buf=%u producerOnCore=%d) -- wrong socket\n",
                                connId, producer ? "producer" : "consumer",
                                surfaceBufId, static_cast<int>(it->second.producerOnCore));
                            std::abort();
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
            }
            // AllocSurfaceBuf / AllocComposeBuf / ReleaseSurfaceBuf /
            // ReleaseClientTex now ride the WIRE socket as FrameKind
            // frames (transport.h); see dispatchCoreControlFrame above.
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
        kms->setFlipCompleteListener([&](uint32_t outputId, int retiredSlotIdx,
                                         uint64_t tvSec, uint32_t tvNsec, uint32_t seq) {
            // The flip-complete handler receives the slot index that JUST
            // became SCANOUT; the retiredSlotIdx parameter is the slot that
            // was previously SCANOUT and is now FREE (-1 on the first flip).
            // The CORE keeps the slot state -- we send the slot that flipped
            // (=newly SCANOUT) and let the core deduce the rest.
            (void)retiredSlotIdx;  // unused: see KmsScanoutRing for the inversion.
            ipc::Message m{};
            m.tag = ipc::Tag::ScanoutFlipComplete;
            m.outputId = outputId;
            // Kernel-supplied page-flip timestamp + vsync sequence -- carried
            // through for wp_presentation. tvSec/tvNsec are CLOCK_MONOTONIC.
            m.tvSec  = tvSec;
            m.tvNsec = tvNsec;
            m.seq    = seq;
            // KmsScanoutRing's listener semantics return the retired (now-FREE)
            // slot. The core needs the slot that just became SCANOUT for THIS
            // output -- look up that output's ring state to find it.
            for (int i = 0; i < 3; ++i) {
                if (kms->scanoutSlotAt(outputId, i).state ==
                    gpu::KmsScanoutRing::SlotState::SCANOUT) {
                    m.surfaceBufId = static_cast<uint32_t>(i);
                    break;
                }
            }
            ctrlSender.send(m);
        });
    }

    // Udev hotplug monitor (DRM subsystem). KMS-only; nested mode has no
    // connectors to plug/unplug. Registered with the event loop right next
    // to libseat / the DRM card fd -- it lives in this process because
    // libseat does. On HOTPLUG=1 the callback re-probes connectors via
    // kms->rescan() and emits per-output IPC:
    //   OutputRemoved   for every dense outputId whose connector vanished
    //   OutputAdded     for every newly-connected connector with a CRTC
    // Card-level add/remove is logged for awareness only.
    gpu::UdevHotplugMonitor udevMon;
    if (outputKms && kms) {
        if (!udevMon.open()) {
            // Not fatal: hotplug is added incrementally; the rest of the GPU
            // process still works (just no live plug/unplug). Log once.
            std::fprintf(stderr, "[gpu] udev monitor open failed: %s (hotplug disabled)\n",
                         udevMon.error().c_str());
        } else {
            const int udevFd = udevMon.fd();
            loop->add(udevFd, gpu::EventLoop::kRead, [&](uint32_t) {
                udevMon.drain([&](const gpu::UdevHotplugEvent& ev) {
                    using Kind = gpu::UdevHotplugEvent::Kind;
                    switch (ev.kind) {
                        case Kind::kConnectorChange: {
                            std::printf("[gpu] udev: connector change on %s devnum=%lu hint=%u\n",
                                        ev.sysname.c_str(),
                                        static_cast<unsigned long>(ev.devnum),
                                        ev.connectorIdHint);
                            if (!kms) break;
                            auto result = kms->rescan();

                            // Clean up main.cpp-owned per-slot state for every
                            // removed output: the surfaceBufs entries for its
                            // 3 ring slots (the textures are already gone, the
                            // ring cleared by disconnectOutput), and the
                            // bufId -> (outputId, slot) routing entries. Any
                            // late ScanoutPresent the core sends for these
                            // bufIds will then fall through as "unknown
                            // surfaceBufId" instead of dereferencing a missing
                            // output. Also drop any pending sync_file fd.
                            std::unordered_set<uint32_t> removedSet(
                                result.removed.begin(), result.removed.end());
                            for (auto it = scanoutBufIdToSlot.begin();
                                 it != scanoutBufIdToSlot.end();) {
                                if (removedSet.count(it->second.first)) {
                                    const uint32_t bufId = it->first;
                                    surfaceBufs.erase(bufId);
                                    auto fit = scanoutFenceFdByBufId.find(bufId);
                                    if (fit != scanoutFenceFdByBufId.end()) {
                                        if (fit->second >= 0) ::close(fit->second);
                                        scanoutFenceFdByBufId.erase(fit);
                                    }
                                    it = scanoutBufIdToSlot.erase(it);
                                } else {
                                    ++it;
                                }
                            }

                            // Emit OutputRemoved for every vanished id BEFORE
                            // any OutputAdded (ordering matters: the core
                            // releases CRTC-style state on removed before
                            // assigning to added).
                            for (uint32_t id : result.removed) {
                                ipc::OutputRemovedPayload p{ id };
                                uint8_t buf[ipc::OutputRemovedPayload::kSize];
                                p.encode(buf);
                                serializer.appendFrame(
                                    ipc::FrameKind::OutputRemoved, buf, sizeof(buf));
                                std::printf("[gpu] sent OutputRemoved outputId=%u\n", id);
                            }

                            // Build the ring NOW for each newly-connected
                            // output, then emit OutputAdded. The core's
                            // ScanoutReserve reply lands in
                            // dispatchCoreControlFrame, which runs
                            // handleScanoutReserve to InjectTexture the slots
                            // and send ScanoutReady. If the ring build fails
                            // the entry is already removed from outputs_ by
                            // initScanoutForOutput's fallback; skip the
                            // OutputAdded for that id.
                            for (uint32_t id : result.added) {
                                if (!kms->initScanoutForOutput(id, coreDevice)) {
                                    std::fprintf(stderr,
                                        "[gpu] OutputAdded skipped for outputId=%u (ring init failed)\n",
                                        id);
                                    continue;
                                }
                                ipc::OutputDescriptorPayload p{};
                                buildOutputDescPayload(id, p);
                                std::vector<uint8_t> buf(p.encodedSize());
                                p.encode(buf.data());
                                serializer.appendFrame(
                                    ipc::FrameKind::OutputAdded, buf.data(), buf.size());
                                std::printf("[gpu] sent OutputAdded outputId=%u %ux%u @%u.%03uHz name=%s\n",
                                            id, p.width, p.height,
                                            p.refreshMhz / 1000, p.refreshMhz % 1000,
                                            p.name.c_str());
                                // Wire-FIFO: this OutputModes lands after
                                // the OutputAdded above, so the JS handler
                                // sees the existing OutputRecord before
                                // applying modes to it.
                                emitOutputModes(id);
                            }
                            break;
                        }
                        case Kind::kCardAdded:
                            std::printf("[gpu] udev: DRM card added (%s); M9 territory, ignored\n",
                                        ev.sysname.c_str());
                            break;
                        case Kind::kCardRemoved:
                            std::printf("[gpu] udev: DRM card removed (%s); M9 territory, ignored\n",
                                        ev.sysname.c_str());
                            break;
                        case Kind::kIgnore:
                            break;
                    }
                });
                // The udev callback may have queued ctrl bytes via
                // ctrlSender. Re-arm so the loop drains them on EPOLLOUT.
                armCtrl();
            });
            std::printf("[gpu] udev hotplug monitor up (fd=%d)\n", udevFd);
        }
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

    // Batch wire output: the per-iteration appendFrame/Flush calls (Dawn
    // replies, ShmUploaded, flip/alloc acks, ...) only stage; the single
    // drainNow() at the end of each loop turn coalesces them into one write
    // instead of one per reply, so the core wakes far fewer times. Cross-channel
    // ordering is unaffected (the bytesQueued()/WireBarrier serial, not send
    // timing). Backpressure leftovers drain on EPOLLOUT via armWire().
    serializer.setDeferPump(true);
    while (!shutdown && (headless || !output->shouldClose())) {
        loop->runOnce(8);   // 8ms cap: also advances Dawn + output pump below
        pumpWire();          // DeviceTick + drain wire, even with no fd ready
        drainCoreBarrier();
        registerPluginConns();          // pick up connections added this iteration
        for (auto& pc : pluginConns) pc->pump();  // advance each plugin connection
        drainPluginBarriers();          // fire deferred producer-end / alloc-inject when ready
        if (output) output->pump();    // service output backend events
        serializer.drainNow();          // flush the turn's batched wire output once
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

// Cross-device verification: the two-device cross-device dmabuf-STM + sync-fd-fence
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

    // Open the GBM allocator on the probe adapter's OWN render node, else on a
    // multi-GPU box GBM lands on a different card than the device.
    std::string xnode = "/dev/dri/renderD128";
    {
        WGPUAdapterPropertiesDrm drm{};
        drm.chain.sType = WGPUSType_AdapterPropertiesDrm;
        WGPUAdapterInfo info{};
        info.nextInChain = &drm.chain;
        wgpuAdapterGetInfo(probeAdapter.Get(), &info);
        const bool hasRender = drm.hasRender;
        const uint32_t rmin = drm.renderMinor;
        wgpuAdapterInfoFreeMembers(info);
        if (hasRender) xnode = "/dev/dri/renderD" + std::to_string(rmin);
    }
    gpu::Allocator alloc;
    if (!alloc.open(xnode.c_str()) || !alloc.probe(probeAdapter)) {
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
    overdraw::log::installCrashHandler("/tmp/overdraw-gpu-crash.txt",
                                       "GPU process");
    // Cross-device verification mode: two-device cross-device dmabuf STM + fence
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
