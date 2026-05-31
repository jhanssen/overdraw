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
namespace {

const char* kWgsl = R"(
struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};
// Per-surface placement: rect in NORMALIZED output coords [0,1], origin
// top-left. xy = top-left position, zw = size. The full-output default is
// (0,0,1,1). The compositor writes this each frame from the surface's
// pixel rect and the output size.
struct Rect { r : vec4f, };
@group(0) @binding(2) var<uniform> placement : Rect;
@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  // Unit quad in [0,1] (top-left origin) before placement.
  var q = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0));
  var uv = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0));
  // Place the unit quad into the surface's normalized rect, then map the
  // [0,1] top-left-origin space to NDC ([-1,1], y up).
  let placed = placement.r.xy + q[i] * placement.r.zw;  // normalized output coords
  let ndc = vec2f(placed.x * 2.0 - 1.0, 1.0 - placed.y * 2.0);
  var o : VsOut;
  o.pos = vec4f(ndc, 0.0, 1.0);
  o.uv = uv[i];
  return o;
}
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var tex : texture_2d<f32>;
@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv);
}
)";

}  // namespace

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
        // Headless: an owned offscreen render target (no swapchain). BGRA8Unorm
        // matches the client-buffer byte order and the readback BGRA convention.
        renderFormat_ = wgpu::TextureFormat::BGRA8Unorm;
        wgpu::TextureDescriptor td{};
        td.size = {windowWidth_, windowHeight_, 1};
        td.format = renderFormat_;
        td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::CopySrc;
        captureTex_ = device_.CreateTexture(&td);
        link_->flush();
    }

    // Compositing pipeline + sampler. Client-surface textures bind into this at
    // commit time; with no client surface present the frame loop just clears.
    {
        wgpu::SamplerDescriptor sd{};
        sd.magFilter = wgpu::FilterMode::Nearest;
        sd.minFilter = wgpu::FilterMode::Nearest;
        sampler_ = device_.CreateSampler(&sd);
    }
    {
        wgpu::ShaderSourceWGSL wgslDesc{};
        wgslDesc.code = kWgsl;
        wgpu::ShaderModuleDescriptor smd{};
        smd.nextInChain = &wgslDesc;
        wgpu::ShaderModule module = device_.CreateShaderModule(&smd);

        // Premultiplied-alpha blending (architecture: premultiplied throughout):
        // out = src + dst*(1-srcA). Opaque clients (A=1) fully replace; this is
        // correct for overlapping surfaces.
        wgpu::BlendState blend{};
        blend.color.srcFactor = wgpu::BlendFactor::One;
        blend.color.dstFactor = wgpu::BlendFactor::OneMinusSrcAlpha;
        blend.color.operation = wgpu::BlendOperation::Add;
        blend.alpha.srcFactor = wgpu::BlendFactor::One;
        blend.alpha.dstFactor = wgpu::BlendFactor::OneMinusSrcAlpha;
        blend.alpha.operation = wgpu::BlendOperation::Add;

        wgpu::ColorTargetState target{};
        target.format = renderFormat_;
        target.blend = &blend;
        wgpu::FragmentState fs{};
        fs.module = module;
        fs.entryPoint = "fs";
        fs.targetCount = 1;
        fs.targets = &target;

        wgpu::RenderPipelineDescriptor pd{};
        pd.vertex.module = module;
        pd.vertex.entryPoint = "vs";
        pd.primitive.topology = wgpu::PrimitiveTopology::TriangleStrip;
        pd.fragment = &fs;
        pipeline_ = device_.CreateRenderPipeline(&pd);
    }
    link_->flush();
    return true;
}

void Compositor::updatePlacement(ClientSurface& cs) {
    if (!cs.placementBuf || windowWidth_ == 0 || windowHeight_ == 0) return;
    // Normalized output rect [0,1], origin top-left. Layout size of 0 falls back
    // to the surface's content size (so a surface placed before sizing still
    // shows at its natural size).
    uint32_t w = cs.layoutW ? cs.layoutW : cs.width;
    uint32_t h = cs.layoutH ? cs.layoutH : cs.height;
    float rect[4] = {
        static_cast<float>(cs.x) / static_cast<float>(windowWidth_),
        static_cast<float>(cs.y) / static_cast<float>(windowHeight_),
        static_cast<float>(w) / static_cast<float>(windowWidth_),
        static_cast<float>(h) / static_cast<float>(windowHeight_),
    };
    device_.GetQueue().WriteBuffer(cs.placementBuf, 0, rect, sizeof(rect));
}

void Compositor::commitSurfaceShm(uint32_t id, uint32_t width, uint32_t height,
                                  uint32_t stride, const uint8_t* pixels) {
    if (!device_ || width == 0 || height == 0 || !pixels) return;
    ClientSurface& cs = clientSurfaces_[id];

    // (Re)create the texture if the size changed (or first commit).
    if (!cs.texture || cs.width != width || cs.height != height) {
        wgpu::TextureDescriptor td{};
        td.size = {width, height, 1};
        td.format = wgpu::TextureFormat::BGRA8Unorm;
        td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopyDst |
                   wgpu::TextureUsage::CopySrc;  // CopySrc for readback test hook
        cs.texture = device_.CreateTexture(&td);
        cs.width = width;
        cs.height = height;

        if (!cs.placementBuf) {
            wgpu::BufferDescriptor pbd{};
            pbd.size = 16;  // vec4f
            pbd.usage = wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst;
            cs.placementBuf = device_.CreateBuffer(&pbd);
        }

        wgpu::BindGroupEntry entries[3]{};
        entries[0].binding = 0;
        entries[0].sampler = sampler_;
        entries[1].binding = 1;
        entries[1].textureView = cs.texture.CreateView();
        entries[2].binding = 2;
        entries[2].buffer = cs.placementBuf;
        entries[2].size = 16;
        wgpu::BindGroupDescriptor bgd{};
        bgd.layout = pipeline_.GetBindGroupLayout(0);
        bgd.entryCount = 3;
        bgd.entries = entries;
        cs.bindGroup = device_.CreateBindGroup(&bgd);
    }
    updatePlacement(cs);  // content size may have changed -> refresh fallback rect

    // Upload the pixels. WriteTexture serializes the payload over the wire
    // (no shared-memory MemoryTransferService configured) -- functional, with a
    // per-upload copy cost that is not yet measured on this hardware.
    wgpu::TexelCopyTextureInfo dst{};
    dst.texture = cs.texture;
    wgpu::TexelCopyBufferLayout layout{};
    layout.offset = 0;
    layout.bytesPerRow = stride;
    layout.rowsPerImage = height;
    wgpu::Extent3D extent{width, height, 1};
    device_.GetQueue().WriteTexture(&dst, pixels, static_cast<size_t>(stride) * height,
                                    &layout, &extent);
    cs.present = true;
    link_->flush();
    reportImported(id, width, height);  // single map-on-first-content signal
}

bool Compositor::commitSurfaceDmabuf(uint32_t id, int fd, uint32_t width, uint32_t height,
                                     uint32_t drmFourcc, uint64_t modifier,
                                     uint32_t offset, uint32_t stride, uint64_t bufferId) {
    if (!device_ || width == 0 || height == 0 || fd < 0) return false;

    // Reserve a texture handle on the wire; the GPU process imports the client
    // dmabuf and injects the native texture at this handle.
    wgpu::TextureDescriptor td{};
    td.size = {width, height, 1};
    td.format = wgpu::TextureFormat::BGRA8Unorm;
    td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopySrc;
    auto rt = link_->client().ReserveTexture(
        device_.Get(), reinterpret_cast<const WGPUTextureDescriptor*>(&td));

    // Cross-channel ordering: InjectTexture (server-side, triggered by the CTRL
    // ImportClientTex below) reuses a wire handle id that may have just been
    // recycled when a prior texture was dropped -- that drop sent an
    // UnregisterObjectCmd over the WIRE. If the ctrl message overtakes that
    // still-queued wire command, the server slot has a stale generation and the
    // inject fails. Rather than block, flush the wire and sample the byte serial;
    // the GPU defers the inject until its wire reader has consumed past it.
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
        return false;
    }

    // NON-BLOCKING: record the in-flight reservation and return. The GPU process
    // imports + injects asynchronously (deferring until its wire reader passes
    // wireSerial) and replies ClientTexImported; drainCtrl() finishes the import
    // on this (Node) thread. The reservation is held here -- neither Acquired nor
    // Reclaimed -- so its handle id cannot be recycled while in flight.
    pendingImports_.push_back({id, bufferId, width, height, rt});
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

void Compositor::finishImport(const PendingImport& pi) {
    ClientSurface& cs = clientSurfaces_[pi.surfaceId];

    // Retire the buffer this commit supersedes: it has been sampled by every
    // frame up to and including the latest submit (submitSerial_). It becomes
    // free once that submit completes on the GPU. Keep its texture alive until
    // then (the GPU may still be reading it).
    if (cs.currentBufferId != 0 && cs.currentBufferId != pi.bufferId && cs.texture) {
        retiring_.push_back({cs.currentBufferId, submitSerial_, cs.texture});
    }
    cs.currentBufferId = pi.bufferId;

    cs.texture = wgpu::Texture::Acquire(pi.reservation.texture);
    cs.width = pi.width;
    cs.height = pi.height;

    if (!cs.placementBuf) {
        wgpu::BufferDescriptor pbd{};
        pbd.size = 16;  // vec4f
        pbd.usage = wgpu::BufferUsage::Uniform | wgpu::BufferUsage::CopyDst;
        cs.placementBuf = device_.CreateBuffer(&pbd);
    }

    wgpu::BindGroupEntry entries[3]{};
    entries[0].binding = 0;
    entries[0].sampler = sampler_;
    entries[1].binding = 1;
    entries[1].textureView = cs.texture.CreateView();
    entries[2].binding = 2;
    entries[2].buffer = cs.placementBuf;
    entries[2].size = 16;
    wgpu::BindGroupDescriptor bgd{};
    bgd.layout = pipeline_.GetBindGroupLayout(0);
    bgd.entryCount = 3;
    bgd.entries = entries;
    cs.bindGroup = device_.CreateBindGroup(&bgd);
    updatePlacement(cs);
    cs.present = true;
    link_->flush();
    reportImported(pi.surfaceId, pi.width, pi.height);
}

void Compositor::drainCtrl() {
    // Dispatch any available side-channel control messages. In steady state the
    // only message the GPU process sends unsolicited (relative to the present
    // loop) is ClientTexImported, completing an async dmabuf import.
    ipc::Message r{};
    while (ipc::recvMessageNB(ctrlFd_, r)) {
        if (r.tag != ipc::Tag::ClientTexImported) continue;
        // Match by reserved texture handle id (the reply echoes it). Imports for
        // a given surface complete in send order; matching by id is exact.
        auto it = std::find_if(pendingImports_.begin(), pendingImports_.end(),
            [&](const PendingImport& pi) {
                return pi.reservation.handle.id == r.texture.id;
            });
        if (it != pendingImports_.end()) {
            if (r.importOk) {
                finishImport(*it);
            } else {
                std::fprintf(stderr, "[core] dmabuf import FAILED id=%u %ux%u\n",
                             it->surfaceId, it->width, it->height);
                link_->client().ReclaimTextureReservation(it->reservation);
            }
            pendingImports_.erase(it);
            continue;
        }
        // JS-compositor import: report the injected texture handle to JS.
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

void Compositor::reportImported(uint32_t id, uint32_t width, uint32_t height) {
    importedSurfaces_.push_back({id, width, height});
}

void Compositor::takeImportedSurfaces(std::vector<ImportedSurface>& out) {
    out.insert(out.end(), importedSurfaces_.begin(), importedSurfaces_.end());
    importedSurfaces_.clear();
}

void Compositor::setSurfaceLayout(uint32_t id, int32_t x, int32_t y,
                                  uint32_t w, uint32_t h) {
    ClientSurface& cs = clientSurfaces_[id];  // lazily create; rect applies once committed
    cs.x = x;
    cs.y = y;
    cs.layoutW = w;
    cs.layoutH = h;
    updatePlacement(cs);  // no-op until placementBuf exists (first commit)
}

void Compositor::setStack(const std::vector<uint32_t>& ids) {
    stack_ = ids;
}

void Compositor::removeSurface(uint32_t id) {
    auto it = clientSurfaces_.find(id);
    if (it != clientSurfaces_.end()) {
        // The surface's current buffer is no longer referenced after this frame;
        // retire it so the client gets its release (e.g. on unmap/destroy).
        if (it->second.currentBufferId != 0 && it->second.texture)
            retiring_.push_back({it->second.currentBufferId, submitSerial_, it->second.texture});
        clientSurfaces_.erase(it);
    }
    // Drop any in-flight imports for this surface: their completion would
    // otherwise re-create the surface. Reclaim the held reservations.
    for (auto pit = pendingImports_.begin(); pit != pendingImports_.end();) {
        if (pit->surfaceId == id) {
            link_->client().ReclaimTextureReservation(pit->reservation);
            pit = pendingImports_.erase(pit);
        } else {
            ++pit;
        }
    }
    stack_.erase(std::remove(stack_.begin(), stack_.end(), id), stack_.end());
}

void Compositor::reapRetiredBuffers() {
    if (retiring_.empty()) return;
    std::vector<RetiringBuffer> still;
    still.reserve(retiring_.size());
    for (auto& rb : retiring_) {
        if (rb.retireSerial <= completedSerial_) {
            freed_.push_back(rb.bufferId);  // texture ref drops here -> GPU memory recyclable
        } else {
            still.push_back(std::move(rb));
        }
    }
    retiring_.swap(still);
}

void Compositor::takeFreedBuffers(std::vector<uint64_t>& out) {
    out.insert(out.end(), freed_.begin(), freed_.end());
    freed_.clear();
}

void Compositor::renderFrame() {
    // Acquire the render target: the swapchain's current texture (nested) or the
    // owned offscreen capture texture (headless).
    wgpu::SurfaceTexture st{};
    wgpu::TextureView targetView;
    if (headless_) {
        if (captureTex_) targetView = captureTex_.CreateView();
    } else {
        surface_.GetCurrentTexture(&st);
        if (st.texture) targetView = st.texture.CreateView();
    }
    if (targetView) {
        wgpu::RenderPassColorAttachment ca{};
        ca.view = targetView;
        ca.loadOp = wgpu::LoadOp::Clear;
        ca.storeOp = wgpu::StoreOp::Store;
        ca.clearValue = {0.0, 0.0, 0.0, 1.0};
        wgpu::RenderPassDescriptor rp{};
        rp.colorAttachmentCount = 1;
        rp.colorAttachments = &ca;
        wgpu::CommandEncoder enc = device_.CreateCommandEncoder();
        wgpu::RenderPassEncoder pass = enc.BeginRenderPass(&rp);
        pass.SetPipeline(pipeline_);

        // Draw committed surfaces in JS-owned stack order (back-to-front), each
        // placed into its layout rect with alpha blending. Surfaces not in the
        // stack are not drawn. With an empty stack the pass just clears (black).
        for (uint32_t id : stack_) {
            auto it = clientSurfaces_.find(id);
            if (it == clientSurfaces_.end()) continue;  // not committed yet
            ClientSurface& cs = it->second;
            if (cs.present && cs.bindGroup) {
                pass.SetBindGroup(0, cs.bindGroup);
                pass.Draw(4);
            }
        }
        pass.End();
        wgpu::CommandBuffer cb = enc.Finish();
        device_.GetQueue().Submit(1, &cb);

        // This submit sampled every surface's current buffer. Tag it with a
        // serial and mark that serial complete on GPU work-done; retiring
        // buffers whose retireSerial <= completedSerial_ are then safe to free.
        // The callback fires on this (Node) thread via the wire pump -- no
        // cross-thread marshaling needed.
        uint64_t serial = ++submitSerial_;
        device_.GetQueue().OnSubmittedWorkDone(
            wgpu::CallbackMode::AllowProcessEvents,
            [this, serial](wgpu::QueueWorkDoneStatus, wgpu::StringView) {
                if (serial > completedSerial_) completedSerial_ = serial;
            });

        if (!headless_) surface_.Present();
        presented_++;
    }
    reapRetiredBuffers();
    link_->flush();
}

bool Compositor::readbackTexture(const wgpu::Texture& tex, uint32_t width,
                                 uint32_t height, ReadbackCb cb) {
    if (!tex || width == 0 || height == 0) return false;

    // 256-byte row alignment is required for texture->buffer copies.
    uint32_t unpadded = width * 4;
    uint32_t padded = (unpadded + 255) & ~255u;
    uint64_t bufSize = static_cast<uint64_t>(padded) * height;

    wgpu::BufferDescriptor bd{};
    bd.size = bufSize;
    bd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
    wgpu::Buffer buf = device_.CreateBuffer(&bd);

    wgpu::TexelCopyTextureInfo src{};
    src.texture = tex;
    wgpu::TexelCopyBufferInfo dst{};
    dst.buffer = buf;
    dst.layout.offset = 0;
    dst.layout.bytesPerRow = padded;
    dst.layout.rowsPerImage = height;
    wgpu::Extent3D extent{width, height, 1};
    wgpu::CommandEncoder enc = device_.CreateCommandEncoder();
    enc.CopyTextureToBuffer(&src, &dst, &extent);
    wgpu::CommandBuffer cmd = enc.Finish();
    device_.GetQueue().Submit(1, &cmd);
    link_->flush();

    // ASYNCHRONOUS: the map completes later, processed on the Node thread by the
    // wire pump (drainWire -> wgpuInstanceProcessEvents). The captured `buf` keeps
    // the staging buffer alive until the callback fires; `cb` is invoked then.
    buf.MapAsync(wgpu::MapMode::Read, 0, bufSize, wgpu::CallbackMode::AllowProcessEvents,
                 [buf, cb = std::move(cb), bufSize, padded, unpadded, height]
                 (wgpu::MapAsyncStatus s, wgpu::StringView) {
                     std::vector<uint8_t> out;
                     bool ok = (s == wgpu::MapAsyncStatus::Success);
                     if (ok) {
                         const uint8_t* mapped =
                             static_cast<const uint8_t*>(buf.GetConstMappedRange(0, bufSize));
                         if (mapped) {
                             out.resize(static_cast<size_t>(unpadded) * height);
                             for (uint32_t row = 0; row < height; ++row) {
                                 std::copy(mapped + static_cast<size_t>(row) * padded,
                                           mapped + static_cast<size_t>(row) * padded + unpadded,
                                           out.data() + static_cast<size_t>(row) * unpadded);
                             }
                             const_cast<wgpu::Buffer&>(buf).Unmap();
                         } else {
                             ok = false;
                         }
                     }
                     cb(ok, std::move(out));
                 });
    link_->flush();
    return true;
}

bool Compositor::readbackSurface(uint32_t id, ReadbackCb cb) {
    auto it = clientSurfaces_.find(id);
    if (it == clientSurfaces_.end() || !it->second.texture) return false;
    ClientSurface& cs = it->second;
    return readbackTexture(cs.texture, cs.width, cs.height, std::move(cb));
}

bool Compositor::readbackFrame(ReadbackCb cb) {
    if (!captureTex_) return false;  // headless-only (the composited offscreen target)
    return readbackTexture(captureTex_, windowWidth_, windowHeight_, std::move(cb));
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
    for (auto& pi : pendingImports_)
        link_->client().ReclaimTextureReservation(pi.reservation);
    pendingImports_.clear();
    clientSurfaces_.clear();
    sampler_ = nullptr;
    pipeline_ = nullptr;
    captureTex_ = nullptr;
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
