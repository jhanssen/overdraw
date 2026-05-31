#include "compositor.h"

#include <algorithm>
#include <iterator>
#include <cstdio>
#include <vector>

#include <fcntl.h>
#include <unistd.h>

#include "gpu_process.h"
#include "side_channel.h"
#include "transport.h"

namespace overdraw::core {

Compositor::Compositor(int wireFd, int ctrlFd, pid_t gpuPid,
                       bool headless, uint32_t headlessW, uint32_t headlessH)
    : link_(std::make_unique<WireLink>(wireFd, ctrlFd)),
      gpuPid_(gpuPid), wireFd_(wireFd), ctrlFd_(ctrlFd) {
    headless_ = headless;
    if (headless_) { windowWidth_ = headlessW; windowHeight_ = headlessH; }
    // All inter-process fds are non-blocking: no write may ever park (it would
    // wedge the single-threaded GPU process and deadlock the pair). Buffered
    // writers (FdSerializer / CtrlSender) queue what the socket can't take and
    // drain on writable. ctrlFd is also set non-blocking in handshake() after
    // the first blocking Hello; set it here too for clarity/idempotence.
    ipc::setNonBlocking(wireFd_);
    ipc::setNonBlocking(ctrlFd_);
}

Compositor::~Compositor() { shutdown(); }

bool Compositor::handshake() {
    ipc::Message hello{};
    hello.tag = ipc::Tag::Hello;
    hello.protocolVersion = ipc::kProtocolVersion;
    ipc::sendMessage(ctrlFd_, hello);
    ::fcntl(ctrlFd_, F_SETFL, O_NONBLOCK);

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

    // DeviceReady; then NESTED waits for SurfaceReady (+ FeedbackData), HEADLESS
    // waits for FeedbackData only (no surface). In headless DeviceReady carries a
    // zero surface handle (the GPU process does not InjectSurface).
    WGPUSurfaceCapabilities emptyCaps{};
    dawn::wire::ReservedSurface rs{};
    if (!headless_) rs = link_->client().ReserveSurface(instance_.Get(), &emptyCaps);
    {
        ipc::Message m{};
        m.tag = ipc::Tag::DeviceReady;
        m.instance = {ri.handle.id, ri.handle.generation};
        auto dh = link_->client().GetWireHandle(device_.Get());
        m.device = {dh.id, dh.generation};
        m.surface = headless_ ? ipc::WireHandle{0, 0}
                              : ipc::WireHandle{rs.handle.id, rs.handle.generation};
        ipc::sendMessage(ctrlFd_, m);
    }

    ipc::Message surfReady{};
    bool gotFeedback = false;
    if (!link_->pumpUntil([&] {
            ipc::Message m{};
            int fds[ipc::kMaxMsgFds];
            int nfds = 0;
            if (!ipc::recvMessageNBFds(ctrlFd_, m, fds, &nfds)) return false;
            if (m.tag == ipc::Tag::FeedbackData) {
                captureFeedback(m, fds, nfds);
                gotFeedback = true;
                return headless_;  // headless: feedback is the bring-up signal
            }
            if (!headless_ && m.tag == ipc::Tag::SurfaceReady) {
                for (int i = 0; i < nfds; ++i) ::close(fds[i]);  // none expected
                surfReady = m;
                return true;
            }
            for (int i = 0; i < nfds; ++i) ::close(fds[i]);
            return false;
        })) {
        error_ = headless_ ? "no FeedbackData (headless)" : "no SurfaceReady";
        return false;
    }
    (void)gotFeedback;

    if (!headless_) {
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
    } else {
        // Headless: no swapchain. The JS compositor renders into its own
        // offscreen target; the format it samples client buffers as is BGRA8Unorm.
        renderFormat_ = wgpu::TextureFormat::BGRA8Unorm;
    }
    return true;
}

uint32_t Compositor::importDmabufForJs(int fd, uint32_t width, uint32_t height,
                                       uint32_t drmFourcc, uint64_t modifier,
                                       uint32_t offset, uint32_t stride) {
    if (!device_ || width == 0 || height == 0 || fd < 0) return 0;

    wgpu::TextureDescriptor td{};
    td.size = {width, height, 1};
    td.format = wgpu::TextureFormat::BGRA8Unorm;
    td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopySrc;
    auto rt = link_->client().ReserveTexture(
        device_.Get(), reinterpret_cast<const WGPUTextureDescriptor*>(&td));

    link_->flush();
    uint64_t wireSerial = link_->wireBytesQueued();

    ipc::Message m{};
    m.tag = ipc::Tag::ImportClientTex;
    m.wireSerial = wireSerial;
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
    if (!ipc::sendMessageFds(ctrlFd_, m, fds, 1)) {
        link_->client().ReclaimTextureReservation(rt);
        return 0;
    }
    uint32_t importId = nextJsImportId_++;
    pendingJsImports_.push_back({importId, width, height, rt});
    return importId;
}

void Compositor::releaseDmabufImport(uint32_t importId) {
    auto it = jsImportHandles_.find(importId);
    if (it == jsImportHandles_.end()) return;
    ipc::Message m{};
    m.tag = ipc::Tag::ReleaseClientTex;
    m.texture = {it->second.id, it->second.generation};
    ipc::sendMessage(ctrlFd_, m);
    jsImportHandles_.erase(it);
}

void Compositor::takeCompletedJsImports(std::vector<JsImportDone>& out) {
    out.insert(out.end(), std::make_move_iterator(completedJsImports_.begin()),
               std::make_move_iterator(completedJsImports_.end()));
    completedJsImports_.clear();
}

void Compositor::drainCtrl() {
    // Dispatch any available side-channel control messages. In steady state the
    // only message the GPU process sends unsolicited (relative to the present
    // loop) is ClientTexImported, completing an async dmabuf import.
    ipc::Message r{};
    while (ipc::recvMessageNB(ctrlFd_, r)) {
        if (r.tag != ipc::Tag::ClientTexImported) continue;
        // JS-compositor dmabuf import: report the injected texture handle to JS.
        // Match by reserved texture handle id (the reply echoes it); imports
        // complete in send order, so matching by id is exact.
        auto jit = std::find_if(pendingJsImports_.begin(), pendingJsImports_.end(),
            [&](const PendingJsImport& pi) {
                return pi.reservation.handle.id == r.texture.id;
            });
        if (jit == pendingJsImports_.end()) continue;
        if (r.importOk) {
            jsImportHandles_[jit->importId] =
                {jit->reservation.handle.id, jit->reservation.handle.generation};
            completedJsImports_.push_back(
                {jit->importId, jit->width, jit->height,
                 wgpu::Texture::Acquire(jit->reservation.texture), true});
        } else {
            std::fprintf(stderr, "[core] dmabuf JS import FAILED id=%u %ux%u\n",
                         jit->importId, jit->width, jit->height);
            link_->client().ReclaimTextureReservation(jit->reservation);
            completedJsImports_.push_back({jit->importId, 0, 0, wgpu::Texture(), false});
        }
        pendingJsImports_.erase(jit);
    }
}

WGPUTexture Compositor::acquireOutputTextureHandle() {
    if (headless_ || !surface_) return nullptr;
    wgpu::SurfaceTexture st{};
    surface_.GetCurrentTexture(&st);
    if (!st.texture) return nullptr;
    currentOutputTexture_ = st.texture;  // hold a ref until present
    return st.texture.Get();
}

void Compositor::presentOutput() {
    if (headless_ || !surface_) return;
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

void Compositor::shutdown() {
    if (shutdownDone_) return;
    shutdownDone_ = true;

    if (ctrlFd_ >= 0) {
        ipc::Message m{}; m.tag = ipc::Tag::Shutdown;
        ipc::sendMessage(ctrlFd_, m);
        link_->flush();
    }
    // Release wgpu objects before tearing down the wire link.
    for (auto& pi : pendingJsImports_)
        link_->client().ReclaimTextureReservation(pi.reservation);
    pendingJsImports_.clear();
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
