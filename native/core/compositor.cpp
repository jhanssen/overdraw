#include "compositor.h"

#include <cstdio>
#include <vector>

#include <fcntl.h>
#include <unistd.h>

#include "gpu_process.h"
#include "side_channel.h"
#include "transport.h"

namespace overdraw::core {
namespace {

constexpr uint32_t kDmaSize = 256;

const char* kWgsl = R"(
struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};
@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  var p = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0),
    vec2f(-1.0,  1.0), vec2f(1.0,  1.0));
  var uv = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0));
  var o : VsOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
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

    // Reserve a dmabuf-backed texture; GPU process allocates + injects it.
    wgpu::TextureDescriptor dmaTexDesc{};
    dmaTexDesc.size = {kDmaSize, kDmaSize, 1};
    dmaTexDesc.format = wgpu::TextureFormat::BGRA8Unorm;
    dmaTexDesc.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
    auto rt = link_->client().ReserveTexture(
        device_.Get(), reinterpret_cast<const WGPUTextureDescriptor*>(&dmaTexDesc));
    {
        ipc::Message m{};
        m.tag = ipc::Tag::ReserveTex;
        m.device = {rt.deviceHandle.id, rt.deviceHandle.generation};
        m.texture = {rt.handle.id, rt.handle.generation};
        m.format = static_cast<uint32_t>(wgpu::TextureFormat::BGRA8Unorm);
        m.width = kDmaSize;
        m.height = kDmaSize;
        ipc::sendMessage(ctrlFd_, m);
    }
    dmaTexture_ = wgpu::Texture::Acquire(rt.texture);
    if (!link_->pumpUntil([&] {
            ipc::Message m{};
            return ipc::recvMessageNB(ctrlFd_, m) && m.tag == ipc::Tag::TexInjected;
        })) {
        error_ = "no TexInjected";
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

    // dmabuf write bracket: render green; then hold a read bracket for the loop.
    {
        ipc::Message begin{}; begin.tag = ipc::Tag::BeginAccess; begin.initialized = 0;
        ipc::Message reply{};
        if (!link_->sendAndWait(begin, ipc::Tag::BeginDone, reply)) {
            error_ = "no BeginDone (write)"; return false;
        }
        wgpu::RenderPassColorAttachment ca{};
        ca.view = dmaTexture_.CreateView();
        ca.loadOp = wgpu::LoadOp::Clear;
        ca.storeOp = wgpu::StoreOp::Store;
        ca.clearValue = {0.05, 0.8, 0.1, 1.0};  // green
        wgpu::RenderPassDescriptor rp{};
        rp.colorAttachmentCount = 1;
        rp.colorAttachments = &ca;
        wgpu::CommandEncoder enc = device_.CreateCommandEncoder();
        enc.BeginRenderPass(&rp).End();
        wgpu::CommandBuffer cb = enc.Finish();
        device_.GetQueue().Submit(1, &cb);
        link_->flush();
        ipc::Message end{}; end.tag = ipc::Tag::EndAccess;
        if (!link_->sendAndWait(end, ipc::Tag::EndDone, reply)) {
            error_ = "no EndDone (write)"; return false;
        }
        begin.initialized = 1;
        begin.oldLayout = reply.endLayout;
        if (!link_->sendAndWait(begin, ipc::Tag::BeginDone, reply)) {
            error_ = "no BeginDone (read)"; return false;
        }
        readBracketHeld_ = true;
    }

    // Compositing pipeline.
    wgpu::Sampler sampler;
    {
        wgpu::SamplerDescriptor sd{};
        sd.magFilter = wgpu::FilterMode::Nearest;
        sd.minFilter = wgpu::FilterMode::Nearest;
        sampler = device_.CreateSampler(&sd);
    }
    {
        wgpu::ShaderSourceWGSL wgslDesc{};
        wgslDesc.code = kWgsl;
        wgpu::ShaderModuleDescriptor smd{};
        smd.nextInChain = &wgslDesc;
        wgpu::ShaderModule module = device_.CreateShaderModule(&smd);

        wgpu::ColorTargetState target{};
        target.format = static_cast<wgpu::TextureFormat>(surfReady.format);
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

        wgpu::BindGroupEntry entries[2]{};
        entries[0].binding = 0;
        entries[0].sampler = sampler;
        entries[1].binding = 1;
        entries[1].textureView = dmaTexture_.CreateView();
        wgpu::BindGroupDescriptor bgd{};
        bgd.layout = pipeline_.GetBindGroupLayout(0);
        bgd.entryCount = 2;
        bgd.entries = entries;
        bindGroup_ = device_.CreateBindGroup(&bgd);
    }
    link_->flush();
    return true;
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
        pass.SetBindGroup(0, bindGroup_);
        pass.Draw(4);
        pass.End();
        wgpu::CommandBuffer cb = enc.Finish();
        device_.GetQueue().Submit(1, &cb);
        surface_.Present();
        presented_++;
    }
    link_->flush();
}

void Compositor::shutdown() {
    if (shutdownDone_) return;
    shutdownDone_ = true;

    if (readBracketHeld_) {
        ipc::Message end{}; end.tag = ipc::Tag::EndAccess;
        ipc::Message reply{};
        link_->sendAndWait(end, ipc::Tag::EndDone, reply);
        readBracketHeld_ = false;
    }
    if (ctrlFd_ >= 0) {
        ipc::Message m{}; m.tag = ipc::Tag::Shutdown;
        ipc::sendMessage(ctrlFd_, m);
        link_->flush();
    }
    // Release wgpu objects before tearing down the wire link.
    bindGroup_ = nullptr;
    pipeline_ = nullptr;
    dmaTexture_ = nullptr;
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
