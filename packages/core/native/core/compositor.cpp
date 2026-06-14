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
    ipc::Message kmsDescriptor{};
    bool gotFeedback = false;
    bool gotKmsDescriptor = false;
    auto firstPhaseDone = [&] {
        if (headless_) return gotFeedback;
        if (wantSurface) return surfReady.tag == ipc::Tag::SurfaceReady;
        // kms
        return gotKmsDescriptor;
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
                kmsDescriptor = m;
                gotKmsDescriptor = true;
                // OutputDescriptor will be drained again in steady state too,
                // but during bring-up we capture it once for our own use AND
                // also push it to the steady-state queue so main.ts's
                // onOutputDescriptor callback fires normally.
                OutputDescriptorMsg msg{};
                msg.width = m.width; msg.height = m.height;
                msg.refreshMhz = m.refreshMhz; msg.scale = m.outScale;
                msg.transform = m.outTransform;
                msg.physicalWidthMm = m.physicalWidthMm;
                msg.physicalHeightMm = m.physicalHeightMm;
                auto bounded = [](const char* s, size_t cap) {
                    size_t n = ::strnlen(s, cap);
                    return std::string(s, n);
                };
                msg.name  = bounded(m.outputName,  sizeof(m.outputName));
                msg.make  = bounded(m.outputMake,  sizeof(m.outputMake));
                msg.model = bounded(m.outputModel, sizeof(m.outputModel));
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
        windowWidth_  = kmsDescriptor.width;
        windowHeight_ = kmsDescriptor.height;

        // Reserve three texture handles for the scanout ring slots, send them
        // to the GPU process, and wait for ScanoutReady.
        WGPUTextureDescriptor td{};
        td.size = { windowWidth_, windowHeight_, 1 };
        td.mipLevelCount = 1;
        td.sampleCount = 1;
        td.dimension = WGPUTextureDimension_2D;
        td.format = static_cast<WGPUTextureFormat>(renderFormat_);
        td.usage = WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_TextureBinding;
        ipc::Message rsMsg{};
        rsMsg.tag = ipc::Tag::ScanoutReserve;
        rsMsg.width = windowWidth_;
        rsMsg.height = windowHeight_;
        for (int i = 0; i < 3; ++i) {
            auto r = link_->client().ReserveTexture(device_.Get(), &td);
            scanoutSlots_[i].handleId  = r.handle.id;
            scanoutSlots_[i].handleGen = r.handle.generation;
            scanoutSlots_[i].state     = ScanoutSlotState::FREE;
            scanoutSlots_[i].tex       = r.texture;  // wire-side handle, valid pre-inject
            scanoutSlots_[i].surfaceBufId = nextSurfaceBufId_++;
            rsMsg.scanoutHandles[i]    = { r.handle.id, r.handle.generation };
            rsMsg.scanoutBufIds[i]     = scanoutSlots_[i].surfaceBufId;
        }
        // Flush the reserves into the wire before sending ScanoutReserve so the
        // GPU process's wire reader has consumed any reservation-related bytes
        // by the time it tries to InjectTexture at our handles.
        link_->flush();
        ipc::sendMessage(ctrlFd_, rsMsg);

        // Wait for ScanoutReady.
        bool ready = false;
        bool ok = false;
        if (!link_->pumpUntil([&] {
                ipc::Message m{};
                int fds[ipc::kMaxMsgFds];
                int nfds = 0;
                if (!ipc::recvMessageNBFds(ctrlFd_, m, fds, &nfds)) return false;
                for (int i = 0; i < nfds; ++i) ::close(fds[i]);
                if (m.tag == ipc::Tag::ScanoutReady) {
                    ready = true;
                    ok = m.ok != 0;
                    return true;
                }
                return false;
            })) {
            error_ = "no ScanoutReady";
            return false;
        }
        (void)ready;
        if (!ok) {
            error_ = "ScanoutReady reported failure";
            return false;
        }
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

    ipc::Message m{};
    m.tag = ipc::Tag::ImportClientTex;
    m.wireSerial = tr.wireSerial();
    m.device = {rt.deviceHandle.id, rt.deviceHandle.generation};
    m.texture = {rt.handle.id, rt.handle.generation};
    m.width = width;
    m.height = height;
    m.drmFourcc = drmFourcc;
    m.modifier = modifier;
    m.planeOffset = offset;
    m.planeStride = stride;
    m.planeCount = 1;
    int fds[1] = {fd};
    if (!ctrlSender_->send(m, fds, 1)) {
        // The peer never observed this reservation; safe to recycle the id.
        tr.discard();
        return 0;
    }
    // Ctrl message handed to the peer -> the GPU process WILL act on it (will
    // run InjectTexture, success or failure). Move the holder into the pending
    // list; final commit()/discard() happens in drainCtrl on the reply.
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

void Compositor::drainCtrl() {
    // Dispatch any available side-channel control messages. In steady state the
    // only message the GPU process sends unsolicited (relative to the present
    // loop) is ClientTexImported, completing an async dmabuf import.
    ipc::Message r{};
    while (ipc::recvMessageNB(ctrlFd_, r)) {
        if (r.tag == ipc::Tag::ScanoutFlipComplete) {
            // The GPU process flipped to slot `surfaceBufId`. Advance the
            // local state machine: that slot is now SCANOUT, the prior
            // SCANOUT slot becomes FREE.
            const int flipped = static_cast<int>(r.surfaceBufId);
            if (flipped >= 0 && flipped < 3) {
                for (int i = 0; i < 3; ++i) {
                    if (i == flipped) continue;
                    if (scanoutSlots_[i].state == ScanoutSlotState::SCANOUT) {
                        scanoutSlots_[i].state = ScanoutSlotState::FREE;
                    }
                }
                scanoutSlots_[flipped].state = ScanoutSlotState::SCANOUT;
            }
            continue;
        }
        if (r.tag == ipc::Tag::OutputDescriptor) {
            OutputDescriptorMsg msg{};
            msg.width            = r.width;
            msg.height           = r.height;
            msg.refreshMhz       = r.refreshMhz;
            msg.scale            = r.outScale;
            msg.transform        = r.outTransform;
            msg.physicalWidthMm  = r.physicalWidthMm;
            msg.physicalHeightMm = r.physicalHeightMm;
            // Bounded NUL-terminated strings on the wire; trust the source's
            // bound (the GPU process wrote with copyBounded which guarantees
            // NUL-termination within the buffer), but cap defensively.
            auto bounded = [](const char* s, size_t cap) {
                size_t n = ::strnlen(s, cap);
                return std::string(s, n);
            };
            msg.name  = bounded(r.outputName,  sizeof(r.outputName));
            msg.make  = bounded(r.outputMake,  sizeof(r.outputMake));
            msg.model = bounded(r.outputModel, sizeof(r.outputModel));
            pendingOutputDescriptors_.push_back(std::move(msg));
            continue;
        }
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
        if (r.tag != ipc::Tag::ClientTexImported) continue;
        // JS-compositor dmabuf import: report the injected texture handle to JS.
        // Match by reserved texture handle id (the reply echoes it); imports
        // complete in send order, so matching by id is exact.
        auto jit = std::find_if(pendingJsImports_.begin(), pendingJsImports_.end(),
            [&](const PendingJsImport& pi) {
                return pi.reservation.reservation().handle.id == r.texture.id;
            });
        if (jit == pendingJsImports_.end()) continue;
        // commit() on BOTH branches under the deferred-reclaim policy: success
        // means the GPU server registered the texture; failure means it tried
        // and the WireServer state at the id may be partial. Either way the id
        // must not be recycled. (The holder is destroyed when the vector entry
        // is erased; commit() suppresses the destructor's default reclaim.)
        if (r.importOk) {
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

WGPUTexture Compositor::acquireOutputTextureHandle() {
    if (headless_) return nullptr;
    if (kmsMode_) {
        if (kmsPaused_) return nullptr;  // VT-switched away; skip the frame.
        // Pick the next FREE slot. Returns nullptr (frame skipped) if all
        // three are PENDING_FLIP/SCANOUT -- the JS compositor's render path
        // already handles a null acquire. The texture handle was returned
        // by the wire-client ReserveTexture during bring-up; the GPU process
        // has InjectTexture'd at it (ScanoutReady ok=1 attests).
        //
        // Open a producer BeginAccess bracket on the slot's SharedTextureMemory.
        // Reuses the same in-band kind=1 wire frame the plugin overlay path
        // uses (SurfaceAccessPayload{surfaceBufId, producer=true}); the GPU
        // process has registered this surfaceBufId as a SurfaceBuf during
        // ScanoutReady. Without this bracket, Dawn validation rejects every
        // queue submit that uses the scanout texture with "used in a submit
        // without current access to SharedTextureMemory".
        for (int i = 0; i < 3; ++i) {
            if (scanoutSlots_[i].state != ScanoutSlotState::FREE) continue;
            currentSlot_ = i;
            writeProducerBeginAccess(scanoutSlots_[i].surfaceBufId);
            return scanoutSlots_[i].tex;
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

void Compositor::presentOutput() {
    if (headless_) return;
    if (kmsMode_) {
        if (currentSlot_ < 0) return;  // no slot was acquired this frame
        const int slot = currentSlot_;
        currentSlot_ = -1;
        scanoutSlots_[slot].state = ScanoutSlotState::PENDING_FLIP;

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
        writeProducerEndAccess(scanoutSlots_[slot].surfaceBufId);

        ipc::Message m{};
        m.tag = ipc::Tag::ScanoutPresent;
        m.surfaceBufId = scanoutSlots_[slot].surfaceBufId;
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
    // Local slot state: any in-flight present is gone. Reset to FREE so the
    // post-resume acquire starts cleanly.
    for (int i = 0; i < 3; ++i) scanoutSlots_[i].state = ScanoutSlotState::FREE;
    currentSlot_ = -1;
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
