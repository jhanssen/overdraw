#include "compositor.h"

#include <algorithm>
#include <iterator>
#include <cstdio>
#include <cstring>
#include <vector>

#include <fcntl.h>
#include <unistd.h>
#include <sys/socket.h>

#include "gpu_process.h"
#include "side_channel.h"
#include "transport.h"

namespace overdraw::core {

Compositor::Compositor(int wireFd, int ctrlFd, pid_t gpuPid,
                       bool headless, uint32_t headlessW, uint32_t headlessH,
                       bool kms)
    : link_(std::make_unique<WireLink>(wireFd, ctrlFd)),
      gpuPid_(gpuPid), wireFd_(wireFd), ctrlFd_(ctrlFd) {
    headless_ = headless;
    kmsMode_ = kms && !headless;  // headless wins; kms ignored in headless tests
    if (headless_) { windowWidth_ = headlessW; windowHeight_ = headlessH; }
    // All inter-process fds are non-blocking: no write may ever park (it would
    // wedge the single-threaded GPU process and deadlock the pair). Buffered
    // writers (FdSerializer / CtrlSender) queue what the socket can't take and
    // drain on writable. The wire fd is non-blocking immediately; the ctrl fd
    // is flipped to non-blocking in handshake() after the one-shot blocking
    // Hello completes. The CtrlSender is constructed at that same point.
    ipc::setNonBlocking(wireFd_);

    // Inbound non-Dawn wire frames:
    //   ClientTexImported (kind=4) -- reply to a kind=3 ImportClientTex.
    //   ScanoutReady (kind=7)      -- runtime hotplug ring handshake
    //                                  completion (bringUp installs its own
    //                                  transient handler during startup;
    //                                  this one handles steady-state).
    link_->setInboundFrameHandler([this](ipc::FrameKind kind,
                                         const std::vector<uint8_t>& frame) {
        if (kind == ipc::FrameKind::ClientTexImported) {
            if (frame.size() != ipc::ClientTexImportedPayload::kSize) {
                std::fprintf(stderr,
                    "[core] ClientTexImported: bad payload size %zu\n", frame.size());
                return;
            }
            auto p = ipc::ClientTexImportedPayload::decode(frame.data());
            onClientTexImported(p.textureId, p.importOk != 0);
            return;
        }
        if (kind == ipc::FrameKind::ScanoutReady) {
            // Runtime hotplug: a previous reserveScanoutForOutput completed.
            // ok=1 is informational here (wire FIFO already guarantees any
            // ProducerBegin frame after the matching ScanoutReserve sees the
            // ring; we don't need to gate JS-side rendering on this). ok=0
            // is a fatal injection failure -- discard the ring so
            // acquireOutputTextureHandle returns null and no frames are
            // written for the dead output.
            if (frame.size() != ipc::ScanoutReadyPayload::kSize) {
                std::fprintf(stderr,
                    "[core] ScanoutReady: bad payload size %zu\n", frame.size());
                return;
            }
            auto p = ipc::ScanoutReadyPayload::decode(frame.data());
            if (p.ok == 0) {
                scanoutOutputs_.erase(p.outputId);
                std::fprintf(stderr,
                    "[core] ScanoutReady ok=0 for outputId=%u; ring discarded\n",
                    p.outputId);
            }
            return;
        }
        std::fprintf(stderr,
            "[core] WireLink inbound: unexpected kind=%u\n",
            static_cast<unsigned>(kind));
    });
}

Compositor::~Compositor() { shutdown(); }

void Compositor::ctrlPumpOut() {
    if (ctrlSender_) ctrlSender_->pumpOut();
}

bool Compositor::ctrlHasPendingOut() const {
    return ctrlSender_ && ctrlSender_->hasPendingOut();
}

bool Compositor::handshake() {
    // Hello is the one-shot blocking send. The peer is actively draining its
    // startup spin and the socket buffer is empty, so the brief block is safe
    // (the contract from transport.h: blocking sendMessage is for handshake
    // only). After Hello we flip the fd non-blocking and construct CtrlSender
    // for every subsequent send.
    ipc::Message hello{};
    hello.tag = ipc::Tag::Hello;
    hello.protocolVersion = ipc::kProtocolVersion;
    ipc::sendMessage(ctrlFd_, hello);
    ipc::setNonBlocking(ctrlFd_);
    ctrlSender_ = std::make_unique<ipc::CtrlSender>(ctrlFd_);

    bool got = false;
    ipc::Message m{};
    for (int i = 0; i < 500000 && !got; ++i) {
        if (ipc::recvMessageNB(ctrlFd_, m) && m.tag == ipc::Tag::HelloReply) got = true;
        else ::usleep(200);
    }
    if (!got) { error_ = "no HelloReply from gpu process"; return false; }
    windowWidth_ = m.width;
    windowHeight_ = m.height;
    return true;
}

bool Compositor::bringUp() {
    if (!handshake()) return false;

    // Reserve instance; inject it server-side.
    auto ri = link_->client().ReserveInstance();
    {
        ipc::Message m{};
        m.tag = ipc::Tag::InstanceReserved;
        m.instance = {ri.handle.id, ri.handle.generation};
        ipc::sendMessage(ctrlFd_, m);
    }
    instance_ = wgpu::Instance::Acquire(ri.instance);
    link_->setInstance(instance_.Get());

    // Adapter.
    wgpu::Adapter adapter;
    {
        wgpu::RequestAdapterOptions ao{};
        ao.featureLevel = wgpu::FeatureLevel::Core;
        bool ready = false;
        instance_.RequestAdapter(&ao, wgpu::CallbackMode::AllowProcessEvents,
            [&](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView) {
                if (s == wgpu::RequestAdapterStatus::Success) adapter = std::move(a);
                ready = true;
            });
        link_->flush();
        link_->pumpUntil([&] { return ready; });
    }
    if (!adapter) { error_ = "no adapter over wire"; return false; }

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
                if (s == wgpu::RequestDeviceStatus::Success) device_ = std::move(d);
                ready = true;
            });
        link_->flush();
        link_->pumpUntil([&] { return ready; });
    }
    if (!device_) { error_ = "no device over wire"; return false; }

    // Helper: capture a FeedbackData ctrl message (dmabuf feedback) into
    // dmabufFeedback_. The memfd rides as an SCM_RIGHTS fd. Both nested and
    // headless want this (clients may use dmabuf either way).
    auto captureFeedback = [&](const ipc::Message& m, int* fds, int nfds) {
        if (dmabufFeedback_.formatTableFd >= 0) ::close(dmabufFeedback_.formatTableFd);
        dmabufFeedback_.formatTableFd = (nfds > 0) ? fds[0] : -1;
        dmabufFeedback_.mainDevice = m.mainDevice;
        dmabufFeedback_.entryCount = m.entryCount;
        dmabufFeedback_.formatTableSize = m.formatTableSize;
        for (int i = 1; i < nfds; ++i) ::close(fds[i]);
        std::printf("[core] dmabuf feedback: main_device=0x%llx entries=%u size=%u\n",
                    static_cast<unsigned long long>(m.mainDevice),
                    m.entryCount, m.formatTableSize);
    };

    // DeviceReady; then dispatch on output mode:
    //   nested  -> wait for SurfaceReady (+ FeedbackData)
    //   kms     -> wait for ScanoutInjected (+ FeedbackData)
    //   headless-> wait for FeedbackData only (no surface).
    // KMS and headless DeviceReady carry a zero surface handle (the GPU
    // process does not InjectSurface in either case).
    WGPUSurfaceCapabilities emptyCaps{};
    dawn::wire::ReservedSurface rs{};
    const bool wantSurface = !headless_ && !kmsMode_;
    if (wantSurface) rs = link_->client().ReserveSurface(instance_.Get(), &emptyCaps);
    {
        ipc::Message m{};
        m.tag = ipc::Tag::DeviceReady;
        m.instance = {ri.handle.id, ri.handle.generation};
        auto dh = link_->client().GetWireHandle(device_.Get());
        m.device = {dh.id, dh.generation};
        m.surface = wantSurface ? ipc::WireHandle{rs.handle.id, rs.handle.generation}
                                : ipc::WireHandle{0, 0};
        ipc::sendMessage(ctrlFd_, m);
    }

    // First-phase wait: any bring-up modes wait for at least FeedbackData.
    //   nested -> additionally waits for SurfaceReady.
    //   kms    -> additionally waits for OutputDescriptor (the GPU process
    //             sends one once it has the DRM topology), then we reserve
    //             scanout texture handles and send ScanoutReserve, then we
    //             wait for ScanoutReady.
    //   headless-> FeedbackData alone is enough.
    ipc::Message surfReady{};
    ipc::Message kmsDescriptor{};  // the PRIMARY (outputId 0) descriptor
    bool gotFeedback = false;
    bool gotKmsDescriptor = false;

    // KMS multi-output: the GPU process sends one OutputDescriptor per driven
    // output, each carrying outputCount. We collect all N here (each output's
    // dims so the second phase reserves textures of the right size), keyed by
    // arrival order.
    struct KmsOutputDims { uint32_t outputId; uint32_t width; uint32_t height; };
    std::vector<KmsOutputDims> kmsOutputs;
    uint32_t kmsExpectedOutputs = 0;  // 0 until the first descriptor arrives
    auto firstPhaseDone = [&] {
        if (headless_) return gotFeedback;
        if (wantSurface) return surfReady.tag == ipc::Tag::SurfaceReady;
        // kms: all advertised outputs' descriptors have arrived.
        return gotKmsDescriptor && kmsOutputs.size() >= kmsExpectedOutputs;
    };
    if (!link_->pumpUntil([&] {
            ipc::Message m{};
            int fds[ipc::kMaxMsgFds];
            int nfds = 0;
            if (!ipc::recvMessageNBFds(ctrlFd_, m, fds, &nfds)) return false;
            if (m.tag == ipc::Tag::FeedbackData) {
                captureFeedback(m, fds, nfds);
                gotFeedback = true;
                return firstPhaseDone();
            }
            if (wantSurface && m.tag == ipc::Tag::SurfaceReady) {
                for (int i = 0; i < nfds; ++i) ::close(fds[i]);
                surfReady = m;
                return firstPhaseDone();
            }
            if (kmsMode_ && m.tag == ipc::Tag::OutputDescriptor) {
                for (int i = 0; i < nfds; ++i) ::close(fds[i]);
                // Learn the total output count from the first descriptor that
                // carries it (fallback 1 if the GPU left it unset).
                if (kmsExpectedOutputs == 0)
                    kmsExpectedOutputs = m.outputCount ? m.outputCount : 1;
                // The primary (outputId 0) descriptor drives windowWidth_/Height_.
                if (m.outputId == 0) {
                    kmsDescriptor = m;
                    gotKmsDescriptor = true;
                }
                // Record this output's dims for the second-phase reserve.
                kmsOutputs.push_back({ m.outputId, m.width, m.height });
                // OutputDescriptor will be drained again in steady state too,
                // but during bring-up we capture it for our own use AND also
                // push it to the steady-state queue so main.ts's
                // onOutputDescriptor callback fires per output.
                OutputDescriptorMsg msg{};
                msg.outputId = m.outputId;
                msg.width = m.width; msg.height = m.height;
                msg.refreshMhz = m.refreshMhz; msg.scale = m.outScale;
                msg.transform = m.outTransform;
                msg.physicalWidthMm = m.physicalWidthMm;
                msg.physicalHeightMm = m.physicalHeightMm;
                auto bounded = [](const char* s, size_t cap) {
                    size_t n = ::strnlen(s, cap);
                    return std::string(s, n);
                };
                msg.name   = bounded(m.outputName,   sizeof(m.outputName));
                msg.make   = bounded(m.outputMake,   sizeof(m.outputMake));
                msg.model  = bounded(m.outputModel,  sizeof(m.outputModel));
                msg.edidId = bounded(m.outputEdidId, sizeof(m.outputEdidId));
                pendingOutputDescriptors_.push_back(std::move(msg));
                return firstPhaseDone();
            }
            for (int i = 0; i < nfds; ++i) ::close(fds[i]);
            return false;
        })) {
        error_ = headless_ ? "no FeedbackData (headless)"
              : kmsMode_   ? "no OutputDescriptor (kms)"
                           : "no SurfaceReady";
        return false;
    }
    (void)gotFeedback;

    if (wantSurface) {
        // Configure swapchain.
        surface_ = wgpu::Surface::Acquire(rs.surface);
        renderFormat_ = static_cast<wgpu::TextureFormat>(surfReady.format);
        wgpu::SurfaceConfiguration cfg{};
        cfg.device = device_;
        cfg.format = renderFormat_;
        cfg.usage = wgpu::TextureUsage::RenderAttachment;
        cfg.width = surfReady.width;
        cfg.height = surfReady.height;
        cfg.alphaMode = static_cast<wgpu::CompositeAlphaMode>(surfReady.alphaMode);
        cfg.presentMode = static_cast<wgpu::PresentMode>(surfReady.presentMode);
        surface_.Configure(&cfg);
        link_->flush();
    } else if (kmsMode_) {
        // Scanout texture format matches the compositor's render path.
        renderFormat_ = wgpu::TextureFormat::BGRA8Unorm;
        // The primary (outputId 0) descriptor drives the window size.
        windowWidth_  = kmsDescriptor.width;
        windowHeight_ = kmsDescriptor.height;

        // Reserve a three-slot scanout ring per output. For each output:
        // ReserveTexture three wire handles, then write the ScanoutReserve
        // frame on the WIRE socket. The wire's FIFO ordering guarantees the
        // GPU process's wire reader sees the Reserve bytes before any
        // subsequent ProducerBegin frame referencing the same handles -- the
        // race that broke ctrl-delivery is eliminated by construction.
        //
        // ScanoutReady comes back on wire too; we consume it via the
        // inboundHandler that the bringUp sets up below.
        size_t readyCount = 0;
        bool readyFailed = false;
        // Snapshot the existing inbound handler (set by Compositor's ctor for
        // ClientTexImported) so we can chain to it for non-ScanoutReady frames.
        // bringUp runs before any client surfaces are imported, so this is
        // really only a defensive coding measure.
        auto priorHandler = link_->takeInboundFrameHandler();
        link_->setInboundFrameHandler([&](ipc::FrameKind kind,
                                          const std::vector<uint8_t>& frame) {
            if (kind == ipc::FrameKind::ScanoutReady) {
                if (frame.size() != ipc::ScanoutReadyPayload::kSize) {
                    error_ = "ScanoutReady wire frame: bad size";
                    readyFailed = true;
                    return;
                }
                auto p = ipc::ScanoutReadyPayload::decode(frame.data());
                if (p.ok == 0) {
                    error_ = "ScanoutReady reported failure";
                    readyFailed = true;
                    return;
                }
                ++readyCount;
                return;
            }
            if (priorHandler) priorHandler(kind, frame);
        });

        for (const auto& out : kmsOutputs) {
            WGPUTextureDescriptor td{};
            td.size = { out.width, out.height, 1 };
            td.mipLevelCount = 1;
            td.sampleCount = 1;
            td.dimension = WGPUTextureDimension_2D;
            td.format = static_cast<WGPUTextureFormat>(renderFormat_);
            td.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
            ipc::ScanoutReservePayload pl{};
            pl.outputId = out.outputId;
            pl.width = out.width;
            pl.height = out.height;
            ScanoutOutput& so = scanoutOutputs_[out.outputId];
            for (int i = 0; i < 3; ++i) {
                auto r = link_->client().ReserveTexture(device_.Get(), &td);
                so.slots[i].handleId  = r.handle.id;
                so.slots[i].handleGen = r.handle.generation;
                so.slots[i].state     = ScanoutSlotState::FREE;
                so.slots[i].tex       = r.texture;  // wire-side handle, valid pre-inject
                so.slots[i].surfaceBufId = nextSurfaceBufId_++;
                pl.slots[i] = { r.handle.id, r.handle.generation, so.slots[i].surfaceBufId };
            }
            // appendFrame flushes pending Dawn bytes (the ReserveTexture
            // commands) before the frame, so on the wire we get:
            // ReserveTexture commands -> ScanoutReserve frame -> any later
            // frames referencing these handles. The GPU process processes them
            // in that order.
            uint8_t buf[ipc::ScanoutReservePayload::kSize];
            pl.encode(buf);
            link_->appendFrame(ipc::FrameKind::ScanoutReserve, buf, sizeof(buf));
        }

        if (!link_->pumpUntil([&] {
                return readyFailed || readyCount >= kmsOutputs.size();
            })) {
            // Restore the prior handler before returning so the destructor /
            // any subsequent ctor-set handler runs cleanly. (The temporary
            // bringUp handler observes ScanoutReady; after this it would
            // observe future ScanoutReady frames as no-ops, but it also
            // overlaps with ClientTexImported, so restore.)
            link_->setInboundFrameHandler(std::move(priorHandler));
            error_ = "no ScanoutReady";
            return false;
        }
        link_->setInboundFrameHandler(std::move(priorHandler));
        if (readyFailed) return false;
    } else {
        // Headless: no swapchain. The JS compositor renders into its own
        // offscreen target; the format it samples client buffers as is BGRA8Unorm.
        renderFormat_ = wgpu::TextureFormat::BGRA8Unorm;
    }
    return true;
}

// --- TaggedReservation ------------------------------------------------------

Compositor::TaggedReservation::TaggedReservation(dawn::wire::ReservedTexture rt,
                                                 uint64_t serial,
                                                 dawn::wire::WireClient* client)
    : rt_(rt), serial_(serial), client_(client) {}

Compositor::TaggedReservation::TaggedReservation(TaggedReservation&& o) noexcept
    : rt_(o.rt_), serial_(o.serial_), client_(o.client_) {
    o.client_ = nullptr;
}

Compositor::TaggedReservation&
Compositor::TaggedReservation::operator=(TaggedReservation&& o) noexcept {
    if (this != &o) {
        // Existing reservation (if any) falls back to discard semantics.
        if (client_) client_->ReclaimTextureReservation(rt_);
        rt_ = o.rt_;
        serial_ = o.serial_;
        client_ = o.client_;
        o.client_ = nullptr;
    }
    return *this;
}

Compositor::TaggedReservation::~TaggedReservation() {
    // Default behavior: discard (reclaim id; safe IF never published). Callers
    // that DID publish must call commit() explicitly; their wire-id will then
    // be retained per the deferred-reclaim policy.
    if (client_) client_->ReclaimTextureReservation(rt_);
}

void Compositor::TaggedReservation::commit() {
    client_ = nullptr;  // suppress destructor reclaim
}

void Compositor::TaggedReservation::discard() {
    if (client_) {
        client_->ReclaimTextureReservation(rt_);
        client_ = nullptr;
    }
}

dawn::wire::ReservedTexture Compositor::TaggedReservation::commitAndTake() {
    auto out = rt_;
    client_ = nullptr;
    return out;
}

Compositor::TaggedReservation Compositor::reserveTextureTagged(
        uint32_t width, uint32_t height, wgpu::TextureUsage usage) {
    // The single chokepoint for "reserve a wire texture + capture its ordering
    // serial". CRITICAL: the bytesQueued() sample MUST happen AFTER the flush
    // that commits the reserve into the wire FdSerializer (Dawn wire batches
    // commands between Flush() calls; reading the counter before the flush
    // yields a serial below the reserve, so the GPU process catches up before
    // the reserve is actually applied -- the recycled-handle inject then fails
    // at a stale id). Putting reserve + flush + sample in one helper removes
    // the chance to get the ordering wrong at a call site.
    wgpu::TextureDescriptor td{};
    td.size = {width, height, 1};
    td.format = wgpu::TextureFormat::BGRA8Unorm;
    td.usage = usage;
    auto rt = link_->client().ReserveTexture(
        device_.Get(), reinterpret_cast<const WGPUTextureDescriptor*>(&td));
    link_->flush();
    return TaggedReservation{rt, link_->wireBytesQueued(), &link_->client()};
}

uint32_t Compositor::importDmabufForJs(int fd, uint32_t width, uint32_t height,
                                       uint32_t drmFourcc, uint64_t modifier,
                                       uint32_t offset, uint32_t stride) {
    if (!device_ || width == 0 || height == 0 || fd < 0) return 0;

    TaggedReservation tr = reserveTextureTagged(width, height,
        wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopySrc);
    const auto& rt = tr.reservation();

    // The import travels in-band on the WIRE socket as a kind=3 frame. This
    // keeps it FIFO-ordered with the surrounding wire commands -- crucial
    // because Server::Allocate rejects a texture slot whose id exceeds
    // mKnown.size(), which grows monotonically as wire commands (including
    // this InjectTexture) are processed. A later Surface::APIGetCurrentTexture
    // allocates the NEXT sequential id; if its wire command arrived before
    // ImportClientTex (as happened when ImportClientTex rode the ctrl socket),
    // the gap would silently zero the slot and the surface would render black.
    ipc::ImportClientTexPayload p{};
    p.textureId         = rt.handle.id;
    p.textureGeneration = rt.handle.generation;
    p.deviceId          = rt.deviceHandle.id;
    p.deviceGeneration  = rt.deviceHandle.generation;
    p.width             = width;
    p.height            = height;
    p.drmFourcc         = drmFourcc;
    p.modifier          = modifier;
    p.planeOffset       = offset;
    p.planeStride       = stride;
    uint8_t buf[ipc::ImportClientTexPayload::kSize];
    p.encode(buf);
    int fds[1] = {fd};
    if (!link_->appendFrameWithFds(ipc::FrameKind::ImportClientTex,
                                   buf, sizeof(buf), fds, 1)) {
        tr.discard();
        return 0;
    }
    // Wire frame queued -> the GPU process WILL act on it. Move the holder
    // into the pending list; final commit()/discard() happens on the
    // ClientTexImported reply, also arriving in-band (kind=4).
    uint32_t importId = nextJsImportId_++;
    pendingJsImports_.push_back({importId, width, height, std::move(tr)});
    return importId;
}

void Compositor::releaseDmabufImport(uint32_t importId) {
    auto it = jsImportHandles_.find(importId);
    if (it == jsImportHandles_.end()) return;
    ipc::Message m{};
    m.tag = ipc::Tag::ReleaseClientTex;
    m.texture = {it->second.id, it->second.generation};
    // Cross-channel ordering serial: the per-frame BeginClientAccess/EndAccess
    // brackets for this handle travel the WIRE; this release travels the CTRL
    // channel. A bracket may still be in the wire pipeline. Sample the wire
    // write cursor so the GPU process holds the erase until its wire reader has
    // drained past every bracket written before this release -- otherwise a
    // pending Begin would find the texture already gone. (The brackets are
    // appended frames, already counted by wireBytesQueued(); no flush needed.)
    m.wireSerial = link_->wireBytesQueued();
    ctrlSender_->send(m);
    jsImportHandles_.erase(it);
}

void Compositor::releaseSurfaceBuf(uint32_t surfaceBufId) {
    // Tell the GPU process to destroy the slot's surfaceBuf (end brackets, drop
    // STM/textures/fences, release the dmabuf). The caller (JS gpu-broker) has
    // already gated this on the consumer's GPU read completing.
    ipc::Message m{};
    m.tag = ipc::Tag::ReleaseSurfaceBuf;
    m.surfaceBufId = surfaceBufId;
    ctrlSender_->send(m);
    // The reservation was PUBLISHED to the GPU process (which InjectTexture'd
    // it server-side). commit() it -- the deferred-reclaim policy keeps the
    // wire id from being recycled even after we drop our bookkeeping. See
    // TaggedReservation in compositor.h for why.
    auto it = coreSurfaceReservations_.find(surfaceBufId);
    if (it != coreSurfaceReservations_.end()) {
        it->second.commit();
        coreSurfaceReservations_.erase(it);
    }
    surfaceBufAllocated_.erase(surfaceBufId);
}

void Compositor::takeCompletedJsImports(std::vector<JsImportDone>& out) {
    out.insert(out.end(), std::make_move_iterator(completedJsImports_.begin()),
               std::make_move_iterator(completedJsImports_.end()));
    completedJsImports_.clear();
}

void Compositor::takePendingOutputDescriptors(std::vector<OutputDescriptorMsg>& out) {
    out.insert(out.end(),
               std::make_move_iterator(pendingOutputDescriptors_.begin()),
               std::make_move_iterator(pendingOutputDescriptors_.end()));
    pendingOutputDescriptors_.clear();
}

void Compositor::takePendingOutputsAdded(std::vector<OutputDescriptorMsg>& out) {
    out.insert(out.end(),
               std::make_move_iterator(pendingOutputsAdded_.begin()),
               std::make_move_iterator(pendingOutputsAdded_.end()));
    pendingOutputsAdded_.clear();
}

void Compositor::takePendingOutputsRemoved(std::vector<uint32_t>& out) {
    out.insert(out.end(),
               pendingOutputsRemoved_.begin(), pendingOutputsRemoved_.end());
    pendingOutputsRemoved_.clear();
}

void Compositor::reserveScanoutForOutput(uint32_t outputId, uint32_t width, uint32_t height) {
    if (!kmsMode_) return;
    WGPUTextureDescriptor td{};
    td.size = { width, height, 1 };
    td.mipLevelCount = 1;
    td.sampleCount = 1;
    td.dimension = WGPUTextureDimension_2D;
    td.format = static_cast<WGPUTextureFormat>(renderFormat_);
    td.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
    ipc::ScanoutReservePayload pl{};
    pl.outputId = outputId;
    pl.width = width;
    pl.height = height;
    ScanoutOutput& so = scanoutOutputs_[outputId];
    for (int i = 0; i < 3; ++i) {
        auto r = link_->client().ReserveTexture(device_.Get(), &td);
        so.slots[i].handleId  = r.handle.id;
        so.slots[i].handleGen = r.handle.generation;
        so.slots[i].state     = ScanoutSlotState::FREE;
        so.slots[i].tex       = r.texture;
        so.slots[i].surfaceBufId = nextSurfaceBufId_++;
        pl.slots[i] = { r.handle.id, r.handle.generation, so.slots[i].surfaceBufId };
    }
    so.currentSlot = -1;
    // appendFrame flushes pending Dawn bytes first so the wire order is:
    // ReserveTexture commands -> ScanoutReserve frame -> any later
    // ProducerBegin frames referencing the new handles. Wire FIFO + the
    // GPU process's single-threaded wire dispatch guarantee the
    // ScanoutReserve handler (InjectTexture + surfaceBufs register) runs
    // BEFORE any frame referencing the new bufIds -- this is the fix for
    // the ctrl/wire cross-fd race that broke M7 step 4.
    uint8_t buf[ipc::ScanoutReservePayload::kSize];
    pl.encode(buf);
    link_->appendFrame(ipc::FrameKind::ScanoutReserve, buf, sizeof(buf));
}

void Compositor::releaseScanoutForOutput(uint32_t outputId) {
    if (!kmsMode_) return;
    scanoutOutputs_.erase(outputId);
}

void Compositor::drainCtrl() {
    // Dispatch any available side-channel control messages. In steady state the
    // only message the GPU process sends unsolicited (relative to the present
    // loop) is ClientTexImported, completing an async dmabuf import.
    ipc::Message r{};
    while (ipc::recvMessageNB(ctrlFd_, r)) {
        if (r.tag == ipc::Tag::ScanoutFlipComplete) {
            // The GPU process flipped output `outputId` to slot `surfaceBufId`
            // (the slot index). Advance that output's local state machine: that
            // slot is now SCANOUT, the prior SCANOUT slot becomes FREE.
            const int flipped = static_cast<int>(r.surfaceBufId);
            auto it = scanoutOutputs_.find(r.outputId);
            if (it != scanoutOutputs_.end() && flipped >= 0 && flipped < 3) {
                ScanoutSlot* slots = it->second.slots;
                for (int i = 0; i < 3; ++i) {
                    if (i == flipped) continue;
                    if (slots[i].state == ScanoutSlotState::SCANOUT) {
                        slots[i].state = ScanoutSlotState::FREE;
                    }
                }
                slots[flipped].state = ScanoutSlotState::SCANOUT;
            }
            frameCompleteSeen_ = true;
            flipCompletes_.push_back(r.outputId);
            continue;
        }
        if (r.tag == ipc::Tag::FrameComplete) {
            // Nested: the host wl_surface.frame listener fired (host
            // compositor is ready for the next frame). Routes to the addon's
            // wake state machine. Push the primary outputId so the per-output
            // frame-callback dispatch fires for the nested-host's single
            // output too (multi-output is KMS-only today).
            frameCompleteSeen_ = true;
            flipCompletes_.push_back(0);
            continue;
        }
        // Helper: build an OutputDescriptorMsg from the wire message's
        // descriptor-bearing fields. Shared by OutputDescriptor and OutputAdded.
        auto bounded = [](const char* s, size_t cap) {
            size_t n = ::strnlen(s, cap);
            return std::string(s, n);
        };
        auto buildDesc = [&](const ipc::Message& m) {
            OutputDescriptorMsg msg{};
            msg.outputId         = m.outputId;
            msg.width            = m.width;
            msg.height           = m.height;
            msg.refreshMhz       = m.refreshMhz;
            msg.scale            = m.outScale;
            msg.transform        = m.outTransform;
            msg.physicalWidthMm  = m.physicalWidthMm;
            msg.physicalHeightMm = m.physicalHeightMm;
            msg.name   = bounded(m.outputName,   sizeof(m.outputName));
            msg.make   = bounded(m.outputMake,   sizeof(m.outputMake));
            msg.model  = bounded(m.outputModel,  sizeof(m.outputModel));
            msg.edidId = bounded(m.outputEdidId, sizeof(m.outputEdidId));
            return msg;
        };
        if (r.tag == ipc::Tag::OutputDescriptor) {
            pendingOutputDescriptors_.push_back(buildDesc(r));
            continue;
        }
        if (r.tag == ipc::Tag::OutputAdded) {
            // Hotplug: the connector at this dense outputId is now connected
            // with a usable CRTC. The GPU process built its ring before
            // emitting; the core's JS handler creates state.outputs[outputId]
            // and replies with ScanoutReserve via reserveScanoutForOutput.
            pendingOutputsAdded_.push_back(buildDesc(r));
            continue;
        }
        if (r.tag == ipc::Tag::OutputRemoved) {
            // Hotplug: the connector vanished or was disabled. The GPU
            // process has already torn down the ring; queue the outputId for
            // the JS handler to fire output.pre-remove / removed and call
            // releaseScanoutForOutput.
            pendingOutputsRemoved_.push_back(r.outputId);
            continue;
        }
        // Note: ScanoutReady arrives on the WIRE (not ctrl) -- see the
        // inboundHandler in Compositor::Compositor and the bringUp's
        // transient handler. Keeping ctrl free of this avoids the cross-fd
        // race that broke M7 step 4.
        if (r.tag == ipc::Tag::WireConnAdded) {
            wireConnAdded_[r.connId] = r.ok ? 1 : 2;
            continue;
        }
        if (r.tag == ipc::Tag::PluginInstanceInjected) {
            pluginInstanceInjected_[r.connId] = r.ok ? 1 : 2;
            continue;
        }
        if (r.tag == ipc::Tag::SurfaceBufAllocated) {
            surfaceBufAllocated_[r.surfaceBufId] = r.ok ? 1 : 2;
            if (!r.ok) {
                // The GPU process REACHED InjectTexture and it failed. Its
                // WireServer may already have a partial registration at our
                // reserved id (Dawn's wire-server state on a failed Inject is
                // not contractually defined, so we conservatively assume the
                // slot is occupied). commit() -> the deferred-reclaim policy
                // keeps the id from being recycled into a future caller's
                // reserve, which would let an unrelated Inject collide.
                auto it = coreSurfaceReservations_.find(r.surfaceBufId);
                if (it != coreSurfaceReservations_.end()) {
                    it->second.commit();
                    coreSurfaceReservations_.erase(it);
                }
            }
            continue;
        }
        // ClientTexImported now arrives in-band on the wire (kind=4), routed
        // through onClientTexImported via the WireLink inbound handler. Any
        // other tag here is ignored.
    }
}

void Compositor::onClientTexImported(uint32_t textureId, bool importOk) {
    // JS-compositor dmabuf import: report the injected texture handle to JS.
    // Match by reserved texture handle id (the reply echoes it); imports
    // complete in send order, so matching by id is exact.
    auto jit = std::find_if(pendingJsImports_.begin(), pendingJsImports_.end(),
        [&](const PendingJsImport& pi) {
            return pi.reservation.reservation().handle.id == textureId;
        });
    if (jit == pendingJsImports_.end()) return;
    // commit() on BOTH branches under the deferred-reclaim policy: success
    // means the GPU server registered the texture; failure means it tried
    // and the WireServer state at the id may be partial. Either way the id
    // must not be recycled. (The holder is destroyed when the vector entry
    // is erased; commit() suppresses the destructor's default reclaim.)
    if (importOk) {
        const auto& rt = jit->reservation.reservation();
        jsImportHandles_[jit->importId] = {rt.handle.id, rt.handle.generation};
        // Take ownership of the wgpu::Texture handle for hand-off to JS;
        // marks the reservation as committed.
        auto taken = jit->reservation.commitAndTake();
        completedJsImports_.push_back(
            {jit->importId, jit->width, jit->height,
             wgpu::Texture::Acquire(taken.texture), true});
    } else {
        std::fprintf(stderr, "[core] dmabuf JS import FAILED id=%u %ux%u\n",
                     jit->importId, jit->width, jit->height);
        jit->reservation.commit();
        completedJsImports_.push_back({jit->importId, 0, 0, wgpu::Texture(), false});
    }
    pendingJsImports_.erase(jit);
}

Compositor::CoreSurfaceReservation Compositor::reserveCoreSurfaceTexture(
        uint32_t width, uint32_t height) {
    CoreSurfaceReservation out{0, {0, 0}, {0, 0}, 0};
    if (!device_) return out;
    const uint32_t surfaceBufId = nextSurfaceBufId_++;
    // One-call reserve + flush + serial capture. The captured serial is the
    // CORE-wire ordering serial: AllocSurfaceBuf's consumer-side InjectTexture
    // gates on the core wire reader catching up past it.
    TaggedReservation tr = reserveTextureTagged(width, height,
        wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopySrc);
    out.surfaceBufId = surfaceBufId;
    out.texture = {tr.reservation().handle.id, tr.reservation().handle.generation};
    out.device = {tr.reservation().deviceHandle.id, tr.reservation().deviceHandle.generation};
    out.coreWireSerial = tr.wireSerial();
    surfaceBufAllocated_[surfaceBufId] = 0;  // pending
    coreSurfaceReservations_.emplace(surfaceBufId, std::move(tr));
    return out;
}

Compositor::CoreSurfaceReservation Compositor::reserveCoreComposeTexture(
        uint32_t width, uint32_t height) {
    CoreSurfaceReservation out{0, {0, 0}, {0, 0}, 0};
    if (!device_) return out;
    const uint32_t surfaceBufId = nextSurfaceBufId_++;
    // Producer texture for a compose buffer: RENDER_ATTACHMENT (core writes
    // into it), TEXTURE_BINDING (re-sampleable), COPY_SRC (readback for tests).
    TaggedReservation tr = reserveTextureTagged(width, height,
        wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding
        | wgpu::TextureUsage::CopySrc);
    out.surfaceBufId = surfaceBufId;
    out.texture = {tr.reservation().handle.id, tr.reservation().handle.generation};
    out.device = {tr.reservation().deviceHandle.id, tr.reservation().deviceHandle.generation};
    out.coreWireSerial = tr.wireSerial();
    surfaceBufAllocated_[surfaceBufId] = 0;
    coreSurfaceReservations_.emplace(surfaceBufId, std::move(tr));
    return out;
}

// Shared message builder for AllocSurfaceBuf / AllocComposeBuf.
static void buildAllocMessage(ipc::Message& m, ipc::Tag tag,
                              uint32_t surfaceBufId, uint32_t connId,
                              uint32_t width, uint32_t height,
                              Compositor::ReservedHandle pluginDevice,
                              Compositor::ReservedHandle pluginTexture,
                              Compositor::ReservedHandle coreDevice,
                              Compositor::ReservedHandle coreTexture,
                              uint64_t pluginReservePointSerial,
                              uint64_t coreReservePointSerial) {
    m.tag = tag;
    m.surfaceBufId = surfaceBufId;
    m.connId = connId;
    m.width = width;
    m.height = height;
    m.pluginDevice = {pluginDevice.id, pluginDevice.generation};
    m.pluginTexture = {pluginTexture.id, pluginTexture.generation};
    m.device = {coreDevice.id, coreDevice.generation};
    m.texture = {coreTexture.id, coreTexture.generation};
    m.reservePointSerial = pluginReservePointSerial;
    m.wireSerial = coreReservePointSerial;
}

void Compositor::sendAllocSurfaceBuf(uint32_t surfaceBufId, uint32_t connId,
                                     uint32_t width, uint32_t height,
                                     ReservedHandle pluginDevice, ReservedHandle pluginTexture,
                                     ReservedHandle coreDevice, ReservedHandle coreTexture,
                                     uint64_t pluginReservePointSerial,
                                     uint64_t coreReservePointSerial) {
    ipc::Message m{};
    buildAllocMessage(m, ipc::Tag::AllocSurfaceBuf, surfaceBufId, connId,
        width, height, pluginDevice, pluginTexture, coreDevice, coreTexture,
        pluginReservePointSerial, coreReservePointSerial);
    ctrlSender_->send(m);
}

void Compositor::sendAllocComposeBuf(uint32_t surfaceBufId, uint32_t connId,
                                     uint32_t width, uint32_t height,
                                     ReservedHandle pluginDevice, ReservedHandle pluginTexture,
                                     ReservedHandle coreDevice, ReservedHandle coreTexture,
                                     uint64_t pluginReservePointSerial,
                                     uint64_t coreReservePointSerial) {
    ipc::Message m{};
    buildAllocMessage(m, ipc::Tag::AllocComposeBuf, surfaceBufId, connId,
        width, height, pluginDevice, pluginTexture, coreDevice, coreTexture,
        pluginReservePointSerial, coreReservePointSerial);
    ctrlSender_->send(m);
}

int Compositor::surfaceBufAllocated(uint32_t surfaceBufId) const {
    auto it = surfaceBufAllocated_.find(surfaceBufId);
    return it == surfaceBufAllocated_.end() ? 0 : it->second;
}

WGPUTexture Compositor::coreSurfaceTexture(uint32_t surfaceBufId) const {
    auto it = coreSurfaceReservations_.find(surfaceBufId);
    return it == coreSurfaceReservations_.end() ? nullptr
                                                : it->second.reservation().texture;
}

// Encode `payload` into a stack-allocated buffer sized by Payload::kSize and
// append it as a wire frame of `kind`. The six write* helpers below differ
// only in payload type (ClientTexAccessPayload vs SurfaceAccessPayload) and
// the kind constant; everything else is mechanical encode + appendFrame.
template <typename Payload>
void Compositor::writeAccessFrame(ipc::FrameKind kind, const Payload& payload) {
    uint8_t buf[Payload::kSize];
    payload.encode(buf);
    link_->appendFrame(kind, buf, sizeof(buf));
}

bool Compositor::writeClientTexBeginAccess(uint32_t importId) {
    auto wh = jsImportHandles_.find(importId);
    if (wh == jsImportHandles_.end()) {
        std::fprintf(stderr, "[core] writeClientTexBeginAccess: no handle for importId=%u\n",
                     importId);
        return false;
    }
    writeAccessFrame(ipc::FrameKind::BeginAccess,
                     ipc::ClientTexAccessPayload{wh->second.id, wh->second.generation});
    return true;
}

bool Compositor::writeClientTexBeginAccessWithFence(uint32_t importId, int acquireFenceFd) {
    auto wh = jsImportHandles_.find(importId);
    if (wh == jsImportHandles_.end()) {
        std::fprintf(stderr,
            "[core] writeClientTexBeginAccessWithFence: no handle for importId=%u\n",
            importId);
        if (acquireFenceFd >= 0) ::close(acquireFenceFd);
        return false;
    }
    ipc::ClientTexAccessPayload payload{wh->second.id, wh->second.generation};
    uint8_t buf[ipc::ClientTexAccessPayload::kSize];
    payload.encode(buf);
    const int fds[1] = { acquireFenceFd };
    const bool ok = link_->appendFrameWithFds(ipc::FrameKind::BeginAccessWithFence,
                                              buf, sizeof(buf), fds, 1);
    // appendFrameWithFds dups its fds into the wire queue; we always close ours.
    ::close(acquireFenceFd);
    return ok;
}

void Compositor::writeClientTexEndAccess(uint32_t importId) {
    auto wh = jsImportHandles_.find(importId);
    if (wh == jsImportHandles_.end()) {
        std::fprintf(stderr, "[core] writeClientTexEndAccess: no handle for importId=%u\n",
                     importId);
        return;
    }
    writeAccessFrame(ipc::FrameKind::EndAccess,
                     ipc::ClientTexAccessPayload{wh->second.id, wh->second.generation});
}

void Compositor::writeConsumerBeginAccess(uint32_t surfaceBufId) {
    writeAccessFrame(ipc::FrameKind::BeginAccess,
                     ipc::SurfaceAccessPayload{surfaceBufId, /*producer=*/false});
}

void Compositor::writeConsumerEndAccess(uint32_t surfaceBufId) {
    writeAccessFrame(ipc::FrameKind::EndAccess,
                     ipc::SurfaceAccessPayload{surfaceBufId, /*producer=*/false});
}

void Compositor::writeProducerBeginAccess(uint32_t surfaceBufId) {
    writeAccessFrame(ipc::FrameKind::BeginAccess,
                     ipc::SurfaceAccessPayload{surfaceBufId, /*producer=*/true});
}

void Compositor::writeProducerEndAccess(uint32_t surfaceBufId) {
    writeAccessFrame(ipc::FrameKind::EndAccess,
                     ipc::SurfaceAccessPayload{surfaceBufId, /*producer=*/true});
}

Compositor::PluginConnHandle Compositor::addWireConnection() {
    PluginConnHandle h{0, -1};
    int fds[2];
    // STREAM, like the core's own wire socket (length-prefixed framing).
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0) {
        std::perror("[core] addWireConnection socketpair");
        return h;
    }
    const int wb = 8 * 1024 * 1024;  // match the core wire socket buffers
    for (int i = 0; i < 2; ++i) {
        ::setsockopt(fds[i], SOL_SOCKET, SO_SNDBUF, &wb, sizeof(wb));
        ::setsockopt(fds[i], SOL_SOCKET, SO_RCVBUF, &wb, sizeof(wb));
    }
    // fds[0] = client end (-> the plugin Worker); fds[1] = GPU end (-> GPU proc).
    const uint32_t connId = nextConnId_++;
    ipc::Message m{};
    m.tag = ipc::Tag::AddWireConn;
    m.connId = connId;
    int sendFds[1] = {fds[1]};
    if (!ctrlSender_->send(m, sendFds, 1)) {
        std::fprintf(stderr, "[core] addWireConnection: ctrlSender send failed\n");
        ::close(fds[0]); ::close(fds[1]);
        return h;
    }
    ::close(fds[1]);                 // GPU process dup'd it via SCM_RIGHTS
    wireConnAdded_[connId] = 0;      // pending
    h.connId = connId;
    h.clientFd = fds[0];             // caller owns -> hands to the Worker
    return h;
}

void Compositor::injectPluginInstance(uint32_t connId, uint32_t instanceId,
                                      uint32_t instanceGen) {
    ipc::Message m{};
    m.tag = ipc::Tag::InjectPluginInstance;
    m.connId = connId;
    m.instance = {instanceId, instanceGen};
    pluginInstanceInjected_[connId] = 0;  // pending
    ctrlSender_->send(m);
}

void Compositor::setPluginTickDevice(uint32_t connId, uint32_t deviceId, uint32_t deviceGen) {
    ipc::Message m{};
    m.tag = ipc::Tag::SetPluginTickDevice;
    m.connId = connId;
    m.device = {deviceId, deviceGen};
    ctrlSender_->send(m);
}

int Compositor::wireConnAdded(uint32_t connId) const {
    auto it = wireConnAdded_.find(connId);
    return it == wireConnAdded_.end() ? 0 : it->second;
}

int Compositor::pluginInstanceInjected(uint32_t connId) const {
    auto it = pluginInstanceInjected_.find(connId);
    return it == pluginInstanceInjected_.end() ? 0 : it->second;
}

WGPUTexture Compositor::acquireOutputTextureHandle(uint32_t outputId) {
    if (headless_) return nullptr;
    if (kmsMode_) {
        if (kmsPaused_) return nullptr;  // VT-switched away; skip the frame.
        auto it = scanoutOutputs_.find(outputId);
        if (it == scanoutOutputs_.end()) return nullptr;  // no ring for this output
        ScanoutOutput& so = it->second;
        // Per-output flip gate: the kernel accepts only one queued page-flip
        // per CRTC. If this output already has a slot in PENDING_FLIP, the
        // next atomic commit would be rejected with EBUSY -- and even if it
        // weren't, queueing a second present before the first one is on screen
        // means the panel never displays the intermediate frame. Wait for the
        // pending flip's completion event before letting the JS compositor
        // render this output again. With different per-output refresh rates,
        // each output is independently paced: a 240Hz panel's flip-complete
        // re-triggers the loop every ~4ms but the 60Hz panel stays gated on
        // its own ~16ms flip-complete.
        for (int i = 0; i < 3; ++i) {
            if (so.slots[i].state == ScanoutSlotState::PENDING_FLIP) return nullptr;
        }
        // Pick the next FREE slot. The texture handle was returned by the
        // wire-client ReserveTexture during bring-up; the GPU process has
        // InjectTexture'd at it (ScanoutReady ok=1 attests).
        //
        // Open a producer BeginAccess bracket on the slot's SharedTextureMemory.
        // Reuses the same in-band kind=1 wire frame the plugin overlay path
        // uses (SurfaceAccessPayload{surfaceBufId, producer=true}); the GPU
        // process has registered this surfaceBufId as a SurfaceBuf during
        // ScanoutReady. Without this bracket, Dawn validation rejects every
        // queue submit that uses the scanout texture with "used in a submit
        // without current access to SharedTextureMemory".
        for (int i = 0; i < 3; ++i) {
            if (so.slots[i].state != ScanoutSlotState::FREE) continue;
            so.currentSlot = i;
            writeProducerBeginAccess(so.slots[i].surfaceBufId);
            return so.slots[i].tex;
        }
        return nullptr;  // all slots busy
    }
    if (!surface_) return nullptr;
    wgpu::SurfaceTexture st{};
    surface_.GetCurrentTexture(&st);
    if (!st.texture) return nullptr;
    currentOutputTexture_ = st.texture;  // hold a ref until present
    return st.texture.Get();
}

void Compositor::presentOutput(uint32_t outputId) {
    if (headless_) return;
    if (kmsMode_) {
        auto it = scanoutOutputs_.find(outputId);
        if (it == scanoutOutputs_.end()) return;
        ScanoutOutput& so = it->second;
        if (so.currentSlot < 0) return;  // no slot was acquired this frame
        const int slot = so.currentSlot;
        so.currentSlot = -1;
        so.slots[slot].state = ScanoutSlotState::PENDING_FLIP;

        // Close the producer access bracket on this slot's STM. The
        // EndAccess writes are in-band on the wire (kind=2), FIFO-ordered
        // after the render submit, so the GPU process EndAccess's the STM
        // AFTER the queue submit has been processed -- producing a sync_file
        // fd that we then attach to the atomic commit's IN_FENCE_FD prop.
        // The fence-fd attachment happens GPU-side: the GPU process pairs
        // each EndAccess on a scanout surfaceBufId with the next
        // ScanoutPresent on the same slot and stuffs the captured fd into
        // the atomic commit. So the core does NOT need to ship a fence fd
        // through the ScanoutPresent SCM_RIGHTS path -- it's already in the
        // GPU process's hands by then.
        writeProducerEndAccess(so.slots[slot].surfaceBufId);

        ipc::Message m{};
        m.tag = ipc::Tag::ScanoutPresent;
        m.outputId = outputId;
        m.surfaceBufId = so.slots[slot].surfaceBufId;
        ipc::sendMessage(ctrlFd_, m);
        presented_++;
        link_->flush();
        return;
    }
    if (!surface_) return;
    surface_.Present();
    presented_++;
    currentOutputTexture_ = nullptr;
    link_->flush();
}

void Compositor::renderFrame() {
    // The JS compositor records + presents the frame (over the wire, via
    // acquireOutputTextureHandle/presentOutput). This per-frame hook just flushes
    // queued wire output.
    link_->flush();
}

void Compositor::pauseOutput() {
    if (!kmsMode_) return;
    if (kmsPaused_) return;
    kmsPaused_ = true;
    // Local slot state: any in-flight present is gone. Reset every output's slots
    // to FREE so the post-resume acquire starts cleanly.
    for (auto& [id, o] : scanoutOutputs_) {
        (void)id;
        for (int i = 0; i < 3; ++i) o.slots[i].state = ScanoutSlotState::FREE;
        o.currentSlot = -1;
    }
    if (pendingScanoutFenceFd_ >= 0) {
        ::close(pendingScanoutFenceFd_);
        pendingScanoutFenceFd_ = -1;
    }
    if (ctrlSender_) {
        ipc::Message m{};
        m.tag = ipc::Tag::OutputPause;
        ctrlSender_->send(m);
    }
}

void Compositor::resumeOutput() {
    if (!kmsMode_) return;
    if (!kmsPaused_) return;
    kmsPaused_ = false;
    if (ctrlSender_) {
        ipc::Message m{};
        m.tag = ipc::Tag::OutputResume;
        ctrlSender_->send(m);
    }
}

void Compositor::shutdown() {
    if (shutdownDone_) return;
    shutdownDone_ = true;

    if (ctrlFd_ >= 0) {
        // Drain anything still queued on the CtrlSender (releaseSurfaceBuf etc.
        // emitted late in teardown) BEFORE the Shutdown message so the peer
        // sees them in order. ctrlSender_ may be null if handshake failed; the
        // Shutdown send below is then the only ctrl write needed.
        ipc::Message m{}; m.tag = ipc::Tag::Shutdown;
        if (ctrlSender_) {
            ctrlSender_->send(m);
            // Best-effort drain. If the peer is genuinely wedged the queue
            // will persist past this; we're tearing the process down either
            // way, so blocking longer would just delay the user.
            for (int i = 0; i < 50 && ctrlSender_->hasPendingOut(); ++i) {
                ctrlSender_->pumpOut();
                ::usleep(2000);
            }
        } else {
            ipc::sendMessage(ctrlFd_, m);
        }
        link_->flush();
    }
    // Release wgpu objects before tearing down the wire link. Each pending
    // import's reservation was published to the GPU process, which is being
    // torn down alongside us; commit() (deferred-reclaim policy) is the right
    // terminal action -- the wire client itself is about to be destroyed two
    // lines below, so recycling vs not is moot for THIS process, but commit()
    // keeps the type-level policy consistent.
    for (auto& pi : pendingJsImports_) pi.reservation.commit();
    pendingJsImports_.clear();
    // Also commit any live coreSurfaceReservations_ entries (their GPU-process
    // injects DID happen). They are destroyed when the map clears.
    for (auto& [bufId, tr] : coreSurfaceReservations_) { (void)bufId; tr.commit(); }
    coreSurfaceReservations_.clear();
    completedJsImports_.clear();
    currentOutputTexture_ = nullptr;
    surface_ = nullptr;
    device_ = nullptr;
    instance_ = nullptr;
    link_.reset();  // disconnects the wire client

    if (dmabufFeedback_.formatTableFd >= 0) {
        ::close(dmabufFeedback_.formatTableFd);
        dmabufFeedback_.formatTableFd = -1;
    }
    // Drop the CtrlSender before closing ctrlFd_: its destructor close()s any
    // fds dup'd into the unsent queue (they're our copies the peer never got),
    // and the underlying ctrlFd_ slot is about to be invalidated.
    ctrlSender_.reset();
    if (wireFd_ >= 0) { ::close(wireFd_); wireFd_ = -1; }
    if (ctrlFd_ >= 0) { ::close(ctrlFd_); ctrlFd_ = -1; }
    reapGpuProcess(gpuPid_);
    gpuPid_ = -1;
}

int Compositor::dupDmabufFormatTableFd() const {
    if (dmabufFeedback_.formatTableFd < 0) return -1;
    return ::fcntl(dmabufFeedback_.formatTableFd, F_DUPFD_CLOEXEC, 0);
}

}  // namespace overdraw::core
