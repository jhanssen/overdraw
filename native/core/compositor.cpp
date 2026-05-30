#include "compositor.h"

#include <algorithm>
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

Compositor::Compositor(int wireFd, int ctrlFd, pid_t gpuPid)
    : link_(std::make_unique<WireLink>(wireFd, ctrlFd)),
      gpuPid_(gpuPid), wireFd_(wireFd), ctrlFd_(ctrlFd) {}

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

    // Reserve surface; DeviceReady; wait SurfaceReady.
    WGPUSurfaceCapabilities emptyCaps{};
    auto rs = link_->client().ReserveSurface(instance_.Get(), &emptyCaps);
    {
        ipc::Message m{};
        m.tag = ipc::Tag::DeviceReady;
        m.instance = {ri.handle.id, ri.handle.generation};
        auto dh = link_->client().GetWireHandle(device_.Get());
        m.device = {dh.id, dh.generation};
        m.surface = {rs.handle.id, rs.handle.generation};
        ipc::sendMessage(ctrlFd_, m);
    }
    ipc::Message surfReady{};
    if (!link_->pumpUntil([&] {
            ipc::Message m{};
            if (ipc::recvMessageNB(ctrlFd_, m) && m.tag == ipc::Tag::SurfaceReady) {
                surfReady = m; return true;
            }
            return false;
        })) {
        error_ = "no SurfaceReady";
        return false;
    }

    // Configure swapchain.
    surface_ = wgpu::Surface::Acquire(rs.surface);
    {
        wgpu::SurfaceConfiguration cfg{};
        cfg.device = device_;
        cfg.format = static_cast<wgpu::TextureFormat>(surfReady.format);
        cfg.usage = wgpu::TextureUsage::RenderAttachment;
        cfg.width = surfReady.width;
        cfg.height = surfReady.height;
        cfg.alphaMode = static_cast<wgpu::CompositeAlphaMode>(surfReady.alphaMode);
        cfg.presentMode = static_cast<wgpu::PresentMode>(surfReady.presentMode);
        surface_.Configure(&cfg);
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
        target.format = static_cast<wgpu::TextureFormat>(surfReady.format);
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
}

bool Compositor::commitSurfaceDmabuf(uint32_t id, int fd, uint32_t width, uint32_t height,
                                     uint32_t drmFourcc, uint64_t modifier,
                                     uint32_t offset, uint32_t stride) {
    if (!device_ || width == 0 || height == 0 || fd < 0) return false;

    // Reserve a texture handle on the wire; the GPU process imports the client
    // dmabuf and injects the native texture at this handle.
    wgpu::TextureDescriptor td{};
    td.size = {width, height, 1};
    td.format = wgpu::TextureFormat::BGRA8Unorm;
    td.usage = wgpu::TextureUsage::TextureBinding | wgpu::TextureUsage::CopySrc;
    auto rt = link_->client().ReserveTexture(
        device_.Get(), reinterpret_cast<const WGPUTextureDescriptor*>(&td));

    ipc::Message m{};
    m.tag = ipc::Tag::ImportClientTex;
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

    // Await the import result, pumping the wire (the inject happens server-side
    // over the wire and must be processed by the client).
    ipc::Message reply{};
    bool got = link_->pumpUntilTimeout(
        [&] {
            ipc::Message r{};
            if (ipc::recvMessageNB(ctrlFd_, r) && r.tag == ipc::Tag::ClientTexImported) {
                reply = r;
                return true;
            }
            return false;
        },
        3000);
    if (!got || !reply.importOk) {
        link_->client().ReclaimTextureReservation(rt);
        return false;
    }

    ClientSurface& cs = clientSurfaces_[id];
    cs.texture = wgpu::Texture::Acquire(rt.texture);
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
    updatePlacement(cs);
    cs.present = true;
    link_->flush();
    return true;
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
    clientSurfaces_.erase(id);
    stack_.erase(std::remove(stack_.begin(), stack_.end(), id), stack_.end());
}

void Compositor::renderFrame() {
    wgpu::SurfaceTexture st{};
    surface_.GetCurrentTexture(&st);
    if (st.texture) {
        wgpu::RenderPassColorAttachment ca{};
        ca.view = st.texture.CreateView();
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
        surface_.Present();
        presented_++;
    }
    link_->flush();
}

bool Compositor::readbackSurface(uint32_t id, std::vector<uint8_t>& out) {
    auto it = clientSurfaces_.find(id);
    if (it == clientSurfaces_.end() || !it->second.texture) return false;
    ClientSurface& cs = it->second;

    // 256-byte row alignment is required for texture->buffer copies.
    uint32_t unpadded = cs.width * 4;
    uint32_t padded = (unpadded + 255) & ~255u;
    uint64_t bufSize = static_cast<uint64_t>(padded) * cs.height;

    wgpu::BufferDescriptor bd{};
    bd.size = bufSize;
    bd.usage = wgpu::BufferUsage::CopyDst | wgpu::BufferUsage::MapRead;
    wgpu::Buffer buf = device_.CreateBuffer(&bd);

    wgpu::TexelCopyTextureInfo src{};
    src.texture = cs.texture;
    wgpu::TexelCopyBufferInfo dst{};
    dst.buffer = buf;
    dst.layout.offset = 0;
    dst.layout.bytesPerRow = padded;
    dst.layout.rowsPerImage = cs.height;
    wgpu::Extent3D extent{cs.width, cs.height, 1};
    wgpu::CommandEncoder enc = device_.CreateCommandEncoder();
    enc.CopyTextureToBuffer(&src, &dst, &extent);
    wgpu::CommandBuffer cb = enc.Finish();
    device_.GetQueue().Submit(1, &cb);
    link_->flush();

    bool done = false;
    bool ok = false;
    buf.MapAsync(wgpu::MapMode::Read, 0, bufSize, wgpu::CallbackMode::AllowProcessEvents,
                 [&](wgpu::MapAsyncStatus s, wgpu::StringView) {
                     ok = (s == wgpu::MapAsyncStatus::Success);
                     done = true;
                 });
    if (!link_->pumpUntilTimeout([&] { return done; }, 3000)) return false;
    if (!ok) return false;

    const uint8_t* mapped = static_cast<const uint8_t*>(buf.GetConstMappedRange(0, bufSize));
    if (!mapped) return false;
    out.resize(static_cast<size_t>(unpadded) * cs.height);
    for (uint32_t row = 0; row < cs.height; ++row) {
        std::copy(mapped + static_cast<size_t>(row) * padded,
                  mapped + static_cast<size_t>(row) * padded + unpadded,
                  out.data() + static_cast<size_t>(row) * unpadded);
    }
    buf.Unmap();
    return true;
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
    clientSurfaces_.clear();
    sampler_ = nullptr;
    pipeline_ = nullptr;
    surface_ = nullptr;
    device_ = nullptr;
    instance_ = nullptr;
    link_.reset();  // disconnects the wire client

    if (wireFd_ >= 0) { ::close(wireFd_); wireFd_ = -1; }
    if (ctrlFd_ >= 0) { ::close(ctrlFd_); ctrlFd_ = -1; }
    reapGpuProcess(gpuPid_);
    gpuPid_ = -1;
}

}  // namespace overdraw::core
