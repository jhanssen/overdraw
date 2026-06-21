// The core compositor: owns the wire link, the wgpu objects, and the
// presentation logic. Brings up the device/surface over the wire, then renders
// the textured-quad compositing pass per frame, sampling client-surface
// textures uploaded via commitSurfaceShm.
//
// This class holds no libuv/N-API concerns; the addon drives renderFrame() and
// drainWire() from libuv handles and owns the GPU-process lifecycle handoff.

#ifndef OVERDRAW_CORE_COMPOSITOR_H_
#define OVERDRAW_CORE_COMPOSITOR_H_

#include <sys/types.h>  // dev_t, pid_t

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "dawn/webgpu_cpp.h"

#include "wire_link.h"

namespace overdraw::ipc {
class CtrlSender;
enum class FrameKind : uint8_t;
}

namespace overdraw::core {

class Compositor {
  public:
    // `headless` (with a fixed width/height) brings up with NO swapchain: the
    // compositing pass renders into an owned offscreen texture (read back via
    // readbackFrame) instead of a surface, and nothing is presented. Used by
    // tests; the GPU process must also be spawned with matching --headless WxH.
    //
    // `kms` selects the bare-metal output path: no wgpu::Surface, three
    // scanout textures injected by the GPU process at GPU-chosen wire handles
    // (received via ipc::Tag::ScanoutInjected during bring-up), atomic-commit
    // driven by side-channel ScanoutPresent / ScanoutFlipComplete messages.
    // Mutually exclusive with `headless`. Default false (nested mode).
    Compositor(int wireFd, int ctrlFd, pid_t gpuPid,
               bool headless = false, uint32_t headlessW = 0, uint32_t headlessH = 0,
               bool kms = false);
    ~Compositor();

    Compositor(const Compositor&) = delete;
    Compositor& operator=(const Compositor&) = delete;

    // Hello handshake + bring-up (adapter, device, surface, compositing
    // pipeline). Blocking, one-shot. Returns false and sets error() on failure.
    bool bringUp();
    const std::string& error() const { return error_; }

    uint32_t windowWidth() const { return windowWidth_; }
    uint32_t windowHeight() const { return windowHeight_; }
    uint64_t presented() const { return presented_; }

    // Raw wire-client handles for the core's compositing instance + device, so a
    // JS WebGPU binding (wire-retargeted dawn.node) can wrap them and issue
    // WebGPU commands over the same wire connection. Valid only after bringUp().
    WGPUInstance instanceHandle() const { return instance_.Get(); }
    WGPUDevice deviceHandle() const { return device_.Get(); }

    // Reserve a wire texture AND capture the cross-channel ordering serial in
    // one call. The serial is sampled from the wire FdSerializer's bytesQueued()
    // AFTER the flush that committed the reserve into the wire's out-queue --
    // doing this in one place makes "captured too early" structurally impossible
    // at call sites. Callers should use the embedded `wireSerial` to tag any
    // side-channel message that depends on the reserve being applied by the wire
    // server (the recycled-handle hazard: see ipc::WireBarrier).
    //
    // OWNERSHIP MODEL (TaggedReservation as a policy primitive). The reservation
    // is held by a move-only RAII-ish holder with TWO explicit terminal actions:
    //
    //   - commit(): the reservation has been (or will be) published to a peer
    //     via a ctrl message that the peer will act on (e.g. ImportClientTex,
    //     AllocSurfaceBuf). The wire-id is now considered "in use" by the
    //     server's WireServer object table -- per the deferred-reclaim policy
    //     for the recycled-handle hazard, it MUST NOT be reclaimed even after
    //     the resource is later released. commit() relinquishes ownership; the
    //     destructor will not reclaim.
    //
    //   - discard(): the reservation died BEFORE any peer could observe it
    //     (e.g. ctrl send fatally failed, or this is teardown). The id was never
    //     published; it is safe to call ReclaimTextureReservation on it.
    //     discard() returns the id to the wire-client pool.
    //
    // Default behavior (destructor without commit/discard) is discard. Callers
    // MUST call one of the two explicitly at every exit path -- the holder is
    // designed so the choice is impossible to forget without a leak.
    //
    // EMPIRICAL CAVEAT (from test/wire-serial-regression.gpu.mjs): in this Dawn
    // build, ReserveTexture itself does NOT emit wire bytes, and Reclaim does
    // NOT emit UnregisterObjectCmd. So Reclaim is a pure client-side id-pool
    // operation; the wire-server WireServer is never told. That is precisely
    // why "Reclaim after publish" is unsafe (the server still believes the slot
    // is in use; a future reserve at id-gen+1 would let an unrelated caller's
    // Inject collide with it). commit() encodes that policy in the type.
    class TaggedReservation {
      public:
        TaggedReservation() = default;
        TaggedReservation(dawn::wire::ReservedTexture rt, uint64_t serial,
                          dawn::wire::WireClient* client);
        TaggedReservation(TaggedReservation&&) noexcept;
        TaggedReservation& operator=(TaggedReservation&&) noexcept;
        TaggedReservation(const TaggedReservation&) = delete;
        TaggedReservation& operator=(const TaggedReservation&) = delete;
        ~TaggedReservation();

        // Accessors. Valid until commit() or discard() is called.
        const dawn::wire::ReservedTexture& reservation() const { return rt_; }
        uint64_t wireSerial() const { return serial_; }
        // For C++ callers that need to take ownership of the wgpu::Texture
        // produced by the reservation (e.g. wrap it for JS handoff). The
        // texture pointer remains valid; only the right-to-reclaim moves.
        // The reservation is treated as "committed" (no Reclaim on destruction).
        dawn::wire::ReservedTexture commitAndTake();

        // The reservation has been published (a ctrl message naming the wire id
        // was sent and will be acted on by the peer). The destructor will NOT
        // reclaim.
        void commit();

        // The reservation never reached a peer (synchronous send failure /
        // teardown before any publish). Reclaim is safe; do it now.
        void discard();

      private:
        dawn::wire::ReservedTexture rt_{};
        uint64_t serial_ = 0;
        dawn::wire::WireClient* client_ = nullptr;  // null = empty/committed
    };
    TaggedReservation reserveTextureTagged(uint32_t width, uint32_t height,
                                           wgpu::TextureUsage usage);

    // Declare that the wire client is now shared with a JS WebGPU binding so its
    // wgpu objects (whose finalizers run at process exit) outlive the client.
    void markWireSharedWithJs() { link_->markSharedWithExternal(); }

    // Import a client dmabuf as a wire texture FOR THE JS COMPOSITOR: reserve a
    // texture handle, send ImportClientTex (fd via SCM_RIGHTS), and return an
    // importId. Unlike commitSurfaceDmabuf, this builds NO native compositing
    // state -- on completion the injected texture's wire HANDLE is reported via
    // takeCompletedJsImports() for JS to wrap (dawn.node wrapTexture). Returns 0
    // if the request could not be sent.
    uint32_t importDmabufForJs(int fd, uint32_t width, uint32_t height,
                               uint32_t drmFourcc, uint64_t modifier,
                               uint32_t offset, uint32_t stride);

    // A completed JS dmabuf import. `tex` owns one ref to the injected texture;
    // the caller hands `tex.Get()` to JS (which AddRefs via wrapTexture) and then
    // lets `tex` drop, leaving JS as the owner. `ok=false` => import failed.
    struct JsImportDone { uint32_t importId; uint32_t width; uint32_t height;
                          wgpu::Texture tex; bool ok; };
    void takeCompletedJsImports(std::vector<JsImportDone>& out);

    // OutputDescriptor delivery: the GPU process sends one of these after
    // surface bring-up and again on any change worth re-emitting (host-window
    // resize in slice 3b; KMS mode change later). Each received descriptor is
    // queued here and drained by the addon, which fires the JS onOutput
    // callback per entry. Fields mirror ipc::Tag::OutputDescriptor.
    struct OutputDescriptorMsg {
        uint32_t outputId         = 0;
        uint32_t width            = 0;
        uint32_t height           = 0;
        uint32_t refreshMhz       = 0;
        uint32_t scale            = 1;
        uint32_t transform        = 0;
        uint32_t physicalWidthMm  = 0;
        uint32_t physicalHeightMm = 0;
        std::string name;
        std::string make;
        std::string model;
        // Stable durable identifier from EDID (mfr-product-serial). Empty
        // when the connector has no usable EDID; the JS layer falls back
        // to `name` as the durable key in that case.
        std::string edidId;
    };
    void takePendingOutputDescriptors(std::vector<OutputDescriptorMsg>& out);

    // OutputAdded / OutputRemoved delivery (multi-output hotplug, M7). The GPU
    // process sends OutputAdded with the same descriptor fields as
    // OutputDescriptor when a connector transitions to connected with a usable
    // CRTC; OutputRemoved carries only the dense outputId of the vanished
    // connector. drainCtrl queues these and the addon fires per-message JS
    // callbacks (setOnOutputAdded / setOnOutputRemoved). The JS handler for
    // added must call reserveScanoutForOutput to complete the runtime
    // bring-up handshake (the GPU process emitted OutputAdded BEFORE the
    // ScanoutReserve reply path; the core's standard bringUp path runs only
    // for startup outputs).
    void takePendingOutputsAdded(std::vector<OutputDescriptorMsg>& out);
    void takePendingOutputsRemoved(std::vector<uint32_t>& out);

    // OutputModes delivery (gpu -> core; FrameKind::OutputModes). The GPU
    // process emits one frame per output's full mode list right after
    // OutputAdded (or its startup equivalent). wlr-output-management
    // surfaces these as `head.mode` events.
    struct OutputModesMsg {
        uint32_t outputId = 0;
        struct Mode {
            uint32_t width;       // hdisplay
            uint32_t height;      // vdisplay
            uint32_t refreshMhz;  // Hz * 1000
            bool     preferred;   // DRM_MODE_TYPE_PREFERRED
        };
        std::vector<Mode> modes;
    };
    void takePendingOutputModes(std::vector<OutputModesMsg>& out);

    // Send ScanoutReserve for a runtime-added output. Reserves three wire
    // texture handles + three surfaceBufIds at the given dims and writes the
    // ScanoutReserve message; the GPU process replies ScanoutReady, which is
    // consumed by drainCtrl (the ring slot's state stays FREE on success;
    // an ok=0 reply leaves the entry torn down so acquireOutputTextureHandle
    // returns null). KMS only; nested/headless are no-ops. Idempotent against
    // double-call for the same outputId only when called after the prior ring
    // was released via releaseScanoutForOutput.
    void reserveScanoutForOutput(uint32_t outputId, uint32_t width, uint32_t height);

    // Drop the per-output scanout state on output removal. The GPU process
    // has already released the ring's GBM bo's / dmabuf fds / mode blob; the
    // core just discards its slot bookkeeping so a future OutputAdded at the
    // same outputId can build a fresh ring. KMS only; nested/headless are
    // no-ops.
    void releaseScanoutForOutput(uint32_t outputId);

    // Request a mode swap on `outputId`. Width/height/refreshMhz must
    // match a mode the underlying KMS connector advertises (no custom-mode
    // validation in v1). KMS only; nested / headless are no-ops.
    //
    // Sends a SwitchMode wire frame to the GPU process, which tears down
    // the affected output's ring + mode blob, allocates a fresh ring at the
    // new dims, and replies with a ScanoutRebuild wire frame. The
    // ScanoutRebuild handler in drainCtrl issues the matching
    // ScanoutReserve so the new ring's textures get InjectTexture'd at
    // freshly-reserved wire handles. The output's wl_output global is NOT
    // recreated -- clients see a mode-event burst, not global_remove/global.
    // See multi-output-design §10.5.
    //
    // Asynchronous: returns immediately after appending the wire frame.
    // The caller observes completion via the next OutputDescriptor for
    // this outputId (which carries the new dims) and/or via the JS-side
    // output.changed bus subscriber.
    void switchOutputMode(uint32_t outputId,
                          uint32_t width, uint32_t height,
                          uint32_t refreshMhz);

    // --- KMS scanout path (slice 4) -------------------------------------------
    //
    // In KMS mode the wire `wgpu::Surface` is absent. Instead the GPU process
    // owns three scanout textures (one per ring slot) injected at GPU-chosen
    // wire handles and reported via ipc::Tag::ScanoutInjected during bring-up.
    // The core tracks per-slot state locally and dispatches:
    //   acquireOutputTextureHandle() -> returns the next FREE slot's texture
    //     handle, or nullptr if no slot is currently free.
    //   presentOutput() -> sends ScanoutPresent { slotIdx, fenceFd } and marks
    //     the slot PENDING_FLIP.
    // The GPU process's flip-complete handler sends ScanoutFlipComplete back;
    // drainCtrl advances the local state machine on receipt.

    // True if this compositor is in KMS mode (bring-up received ScanoutInjected
    // instead of SurfaceReady). When false: WSI / headless paths.
    bool kmsMode() const { return kmsMode_; }

    // Set the fence fd to attach to the next ScanoutPresent. Caller transfers
    // ownership; the compositor will close it after sending. Pass -1 to send
    // a present with no fence (test paths). Called by the JS render path
    // right before presentOutput().
    void setPendingScanoutFenceFd(int fd) { pendingScanoutFenceFd_ = fd; }

    // VT-switch lifecycle (drm-design.md "Seat / VT lifecycle"). The libseat
    // disable_seat / enable_seat callbacks land in the addon; the addon then
    // calls pauseOutput() (immediately, before ackDisable) and resumeOutput()
    // (right after enable_seat fires). Both are KMS-only (nested path is a
    // no-op).
    //
    // pauseOutput: send OutputPause to the GPU process and reset every
    // local scanout slot to FREE -- the kernel revoked DRM master, any
    // in-flight flip is gone, and the next acquire after resume must start
    // from scratch. Sets a `kmsPaused_` flag so the JS compositor's per-frame
    // acquireOutputTextureHandle() returns null (skips the frame) until
    // resume.
    //
    // resumeOutput: clear the pause flag and send OutputResume to the GPU
    // process. The GPU process's didInitialCommit_ was cleared on pause so
    // the next ScanoutPresent re-runs the ALLOW_MODESET commit path. No
    // explicit modeset retrigger here -- the next render naturally drives
    // it. Idempotent.
    void pauseOutput();
    void resumeOutput();
    bool kmsPaused() const { return kmsPaused_; }

    // KMS state machine -- exposed for testing / introspection only. Production
    // paths use acquireOutputTextureHandle / presentOutput.
    enum class ScanoutSlotState : uint8_t { FREE, PENDING_FLIP, SCANOUT };
    ScanoutSlotState scanoutSlotState(uint32_t outputId, int idx) const {
        auto it = scanoutOutputs_.find(outputId);
        if (it == scanoutOutputs_.end() || idx < 0 || idx >= 3)
            return ScanoutSlotState::SCANOUT;
        return it->second.slots[idx].state;
    }
    // True iff at least one slot is PENDING_FLIP (an atomic commit is queued
    // with the kernel, awaiting page-flip). The frame trigger uses this to
    // avoid rendering a second frame while one is already in flight (the
    // kernel only accepts one queued flip per CRTC). KMS-only; nested mode
    // always returns false (the nested backend has no equivalent gate
    // exposed; it relies on inFrame + the host frame callback).
    bool flipPending() const {
        if (!kmsMode_) return false;
        for (const auto& [id, o] : scanoutOutputs_) {
            (void)id;
            for (int i = 0; i < 3; ++i)
                if (o.slots[i].state == ScanoutSlotState::PENDING_FLIP) return true;
        }
        return false;
    }

    // Set inside drainCtrl when a frame-complete signal arrives from the GPU
    // process (KMS: ScanoutFlipComplete; nested: FrameComplete from the host
    // wl_surface.frame listener). The addon's poll handler reads + clears it
    // and routes to its wake state machine. The signal is coalesced (the flag
    // is just a bool); multiple flips between addon polls trigger one frame.
    bool takeFrameComplete() {
        bool v = frameCompleteSeen_;
        frameCompleteSeen_ = false;
        return v;
    }

    // Pop the queued KMS flip-completes (one outputId per ScanoutFlipComplete
    // since the last call). Empty in nested/headless modes; the addon dispatches
    // per-output frame-callback work using this. Distinct from takeFrameComplete
    // because callers need the SPECIFIC output that flipped to know which
    // surfaces should receive wl_callback.done this tick. Coalescing by output
    // (one entry per outputId per call) is the caller's responsibility.
    std::vector<uint32_t> takeFlipCompletes() {
        std::vector<uint32_t> out;
        out.swap(flipCompletes_);
        return out;
    }

    // Release a JS dmabuf import: tells the GPU process to drop the imported STM +
    // dmabuf fd for this importId (generation-matched, so a recycled handle id is
    // not freed by mistake). Called when the JS compositor frees the buffer (its
    // last sampling frame completed) or the surface is removed. No-op if unknown.
    void releaseDmabufImport(uint32_t importId);
    // Destroy a plugin ring slot's surfaceBuf on the GPU process + reclaim the
    // core-side reservation/status. Caller gates on the consumer GPU read completing.
    void releaseSurfaceBuf(uint32_t surfaceBufId);

    // linux-dmabuf-v1 default-feedback data captured from the GPU process during
    // bring-up. `formatTableFd` is an owned read-only memfd of 16-byte
    // {format,pad,modifier} records (mmap by the client); -1 if none was sent.
    // `mainDevice` is the DRM device dev_t; `entryCount`/`formatTableSize`
    // describe the table. The fd ownership transfers to the caller of
    // takeDmabufFormatTableFd(); other fields are copyable accessors.
    struct DmabufFeedback {
        int formatTableFd = -1;
        uint64_t mainDevice = 0;
        uint32_t entryCount = 0;
        uint32_t formatTableSize = 0;
    };
    const DmabufFeedback& dmabufFeedback() const { return dmabufFeedback_; }
    // A fresh dup of the format_table memfd (caller owns/closes). -1 if none.
    int dupDmabufFormatTableFd() const;

    int wireFd() const { return link_->wireFd(); }
    int ctrlFd() const { return ctrlFd_; }

    // --- Plugin wire connections (C-M2) ---------------------------------------
    // Create a new plugin wire connection: socketpair, send the GPU-end fd to the
    // GPU process over the side channel (AddWireConn, SCM_RIGHTS), and return the
    // CLIENT-end fd (owned by the caller -> handed to the plugin's Worker) plus
    // an opaque connId. The GPU-process registration completes asynchronously;
    // poll wireConnAdded(connId). Returns clientFd=-1 on failure.
    struct PluginConnHandle { uint32_t connId; int clientFd; };
    PluginConnHandle addWireConnection();
    // Relay the instance handle the plugin's wire client reserved so the GPU
    // process injects its native instance at that handle. Completion is async;
    // poll pluginInstanceInjected(connId).
    void injectPluginInstance(uint32_t connId, uint32_t instanceId, uint32_t instanceGen);
    // Tell the GPU process the plugin's device handle so it DeviceTick's it each
    // pump (the plugin device's queue must advance for map/work-done to resolve).
    void setPluginTickDevice(uint32_t connId, uint32_t deviceId, uint32_t deviceGen);
    // Async-completion polls (driven by drainCtrl): 0=pending, 1=ok, 2=failed.
    int wireConnAdded(uint32_t connId) const;
    int pluginInstanceInjected(uint32_t connId) const;

    // --- Plugin producer/consumer surface buffer (C-M4 step 2) ----------------
    // Reserve a CORE-device texture (the consumer side: TextureBinding|CopySrc)
    // for a plugin surface buffer, returning its wire handle + the surfaceBufId
    // to use. Holds the reservation alive (keyed by surfaceBufId). The plugin
    // (producer) reserves its own texture on its wire client; the caller then
    // calls sendAllocSurfaceBuf with both handles.
    struct ReservedHandle { uint32_t id; uint32_t generation; };
    struct CoreSurfaceReservation {
        uint32_t surfaceBufId;
        ReservedHandle texture;   // core reserved texture handle
        ReservedHandle device;    // core device wire handle
        // Core-wire ordering serial sampled by reserveTextureTagged AFTER the
        // flush that committed the reserve. AllocSurfaceBuf must carry this so
        // the GPU process can gate the core-side InjectTexture on the core wire
        // reader catching up past it (recycled-handle hazard).
        uint64_t coreWireSerial;
    };
    CoreSurfaceReservation reserveCoreSurfaceTexture(uint32_t width, uint32_t height);
    // Reserve a CORE-device texture for a COMPOSE buffer (phase 5b). Same as
    // reserveCoreSurfaceTexture but with RENDER_ATTACHMENT | TEXTURE_BINDING |
    // COPY_SRC usage -- the core is the producer (it renders into the dmabuf)
    // and may also re-sample / read back. The plugin (consumer) reserves a
    // TextureBinding|CopySrc texture on its own wire.
    CoreSurfaceReservation reserveCoreComposeTexture(uint32_t width, uint32_t height);

    // Send AllocSurfaceBuf (one GBM dmabuf imported into plugin+core devices,
    // injected at both reserved handles). Completion async; poll
    // surfaceBufAllocated(surfaceBufId).
    //
    // `pluginReservePointSerial` is the PLUGIN-wire bytesQueued sampled by the
    // worker AFTER the flush that committed the producer-texture reserve;
    // `coreReservePointSerial` is the CORE-wire equivalent (from
    // reserveCoreSurfaceTexture).  Both ride on the message; the GPU process
    // gates each side's InjectTexture on its respective wire reader catching up.
    void sendAllocSurfaceBuf(uint32_t surfaceBufId, uint32_t connId,
                             uint32_t width, uint32_t height,
                             ReservedHandle pluginDevice, ReservedHandle pluginTexture,
                             ReservedHandle coreDevice, ReservedHandle coreTexture,
                             uint64_t pluginReservePointSerial,
                             uint64_t coreReservePointSerial);
    // Send AllocComposeBuf (phase 5b): SAME machinery as AllocSurfaceBuf but
    // the GPU process imports the dmabuf with the core device as PRODUCER and
    // the plugin device as CONSUMER. Wire field shape is identical -- the
    // pluginDevice/pluginTexture name the plugin-side handle (consumer) and
    // coreDevice/coreTexture name the core-side handle (producer).
    void sendAllocComposeBuf(uint32_t surfaceBufId, uint32_t connId,
                             uint32_t width, uint32_t height,
                             ReservedHandle pluginDevice, ReservedHandle pluginTexture,
                             ReservedHandle coreDevice, ReservedHandle coreTexture,
                             uint64_t pluginReservePointSerial,
                             uint64_t coreReservePointSerial);
    int surfaceBufAllocated(uint32_t surfaceBufId) const;
    // The core's wrapped texture handle for a successfully-allocated surface buf
    // (the consumer texture the JS compositor wraps + samples for the plugin-
    // produces direction; the producer texture for compose buffers). 0 if
    // unknown.
    WGPUTexture coreSurfaceTexture(uint32_t surfaceBufId) const;

    // --- In-band per-frame BeginAccess/EndAccess on cached CLIENT dmabuf textures
    // (Layer C of docs/client-buffer-lifecycle.md.) The compositor opens a
    // per-frame Begin bracket on each dmabuf surface it samples and closes it
    // after submit; the GPU process re-exports the dmabuf's implicit-sync
    // acquire fence per Begin (fixing the same-buffer re-commit flicker).
    //
    // In-band per-frame BeginAccess/EndAccess on a cached client texture:
    // write a kind=1/kind=2 control frame on the WIRE socket (not ctrl). The
    // frame is FIFO-ordered against the Dawn sample commands around it, so the
    // GPU process opens the bracket before HandleCommands reaches the sample
    // (Begin, written before the sample's batch) and closes it after (End,
    // written after the submit's batch). No ctrl round-trip, no WireBarrier.
    // appendFrame flushes staged Dawn bytes first, so the caller does NOT flush
    // explicitly. Resolves importId -> {textureId, generation} via
    // jsImportHandles_; returns false (no frame written) if the import is
    // unknown -- the JS side gates Begin on the import being live, so a miss is
    // a JS-gate bug the caller should surface.
    bool writeClientTexBeginAccess(uint32_t importId);
    // Same as writeClientTexBeginAccess, but additionally attaches a sync_file
    // fd as SCM_RIGHTS on the BeginAccess frame. The GPU process uses that fd
    // as the Dawn acquire fence INSTEAD of running EXPORT_SYNC_FILE on the
    // dmabuf (the implicit-sync path). Driven by wp_linux_drm_syncobj_v1:
    // the JS layer exports the sync_file from the client's acquire timeline
    // point and hands it here. Takes ownership of acquireFenceFd (closes it on
    // failure; on success the wire serializer dups it for in-flight retention).
    bool writeClientTexBeginAccessWithFence(uint32_t importId, int acquireFenceFd);
    void writeClientTexEndAccess(uint32_t importId);

    // In-band consumer Begin/End on a plugin surface buffer: write a kind=1/
    // kind=2 Surface frame (producer=false) on the CORE wire socket. The
    // consumer device is the core's, so these ride the core wire; the GPU
    // process dispatches them to runSurfaceBegin/runSurfaceEnd(_, false).
    // Replaces the ConsumerBegin/ConsumerEnd ctrl round-trips. Begin's FIFO
    // position before the compositor's next sample batch keeps the bracket open
    // before HandleCommands reaches the sample; End's caller still gates the
    // write on GPU-read completion (afterCurrentFrame) for execution ordering.
    void writeConsumerBeginAccess(uint32_t surfaceBufId);
    void writeConsumerEndAccess(uint32_t surfaceBufId);
    // In-band producer Begin/End on a compose buffer (phase 5b): write a
    // kind=1/kind=2 Surface frame (producer=true) on the CORE wire socket.
    // For compose buffers the core IS the producer, so producer Begin/End
    // ride the core wire (inverted from sdk.gpu overlay buffers where the
    // producer is the plugin and producer Begin/End ride the plugin wire).
    // FIFO-ordered with the core's render commands the same way consumer
    // Begin/End are with its sample commands.
    void writeProducerBeginAccess(uint32_t surfaceBufId);
    void writeProducerEndAccess(uint32_t surfaceBufId);

    // The JS compositor drives every frame: it acquires the output texture,
    // renders into it over the wire, and presents. The C++ Compositor no longer
    // has a compositing pass -- it provides WSI (surface/acquire/present), dmabuf
    // import, and the wire link.
    //
    // Acquire the render target for `outputId`. In KMS mode returns the next FREE
    // scanout slot's texture for that output (or null if all busy / paused). In
    // nested mode returns the host swapchain's current texture (the outputId is
    // the single output). Holds a ref until presentOutput(); JS wraps it
    // (dawn.node wrapTexture) as the render target.
    WGPUTexture acquireOutputTextureHandle(uint32_t outputId);
    // Present the previously-acquired target for `outputId` and drop the held ref.
    // No-op headless.
    void presentOutput(uint32_t outputId);
    // The swapchain's texture format (the JS pipeline's color-target format must
    // match). Valid after bringUp().
    wgpu::TextureFormat outputFormat() const { return renderFormat_; }

    // Steady-state hooks (called from libuv handles in the addon).
    void drainWire() { link_->drainInbound(); }
    // Drain the outbound wire queue when the wire fd is writable.
    void wirePumpOut() { link_->pumpOut(); }
    // True if wire bytes are queued awaiting a writable socket (the addon then
    // arms UV_WRITABLE on the wire poll).
    bool wireHasPendingOut() const { return link_->hasPendingOut(); }
    // Commit any staged Dawn wire commands into the outbound queue (cheap
    // no-op when nothing is staged). Driven every libuv iteration so a
    // device-async op issued OUTSIDE the (event-driven) frame loop -- e.g. a
    // headless readback's buffer mapAsync with no client commit or flip to
    // trigger a render -- still reaches the GPU process instead of sitting
    // un-flushed in the serializer.
    void flushWire() { link_->flush(); }
    // Per-frame hook from the addon's frame loop: flush queued wire output. The
    // JS compositor records + presents the frame; this just drains the wire.
    void renderFrame();

    // Steady-state hook: drain and dispatch any pending side-channel control
    // messages (ClientTexImported, finishing async JS dmabuf imports).
    // Non-blocking. Driven from a libuv poll on the ctrl fd in the addon.
    void drainCtrl();

    // Drain the outbound ctrl queue when the ctrl fd is writable. Mirrors
    // wirePumpOut: every steady-state ctrl send is buffered through CtrlSender
    // so a peer that briefly stops draining never wedges this side; the addon's
    // libuv poll calls this on UV_WRITABLE to flush what the socket can now
    // accept.
    void ctrlPumpOut();
    // True if ctrl bytes are queued awaiting a writable socket (the addon then
    // arms UV_WRITABLE on the ctrl poll).
    bool ctrlHasPendingOut() const;

    // True if running headless (no host window/surface; the JS compositor renders
    // into its own offscreen target).
    bool headless() const { return headless_; }

    // Stop presenting and release GPU/wire resources; signal + reap the GPU
    // process. Idempotent.
    void shutdown();

  private:
    bool handshake();

    // Handle one inbound ClientTexImported (in-band kind=4 on the wire): match
    // the texture id against pendingJsImports_ and finalize the reservation.
    // Wire-frame inbound handler in the ctor calls this.
    void onClientTexImported(uint32_t textureId, bool importOk);

    // Encode a wire-frame payload into a stack buffer sized by Payload::kSize
    // and append it as `kind`. The six write*Access helpers above differ only
    // in payload type + frame kind; this collapses the boilerplate.
    template <typename Payload>
    void writeAccessFrame(ipc::FrameKind kind, const Payload& payload);

    // Shared encode + appendFrame for AllocSurfaceBuf / AllocComposeBuf:
    // identical payload, different FrameKind. Called by sendAllocSurfaceBuf
    // and sendAllocComposeBuf.
    void appendAllocFrame(ipc::FrameKind kind,
                          uint32_t surfaceBufId, uint32_t connId,
                          uint32_t width, uint32_t height,
                          ReservedHandle pluginDevice, ReservedHandle pluginTexture,
                          ReservedHandle coreDevice, ReservedHandle coreTexture,
                          uint64_t pluginReservePointSerial,
                          uint64_t coreReservePointSerial);

    std::unique_ptr<WireLink> link_;
    pid_t gpuPid_ = -1;
    int wireFd_ = -1;  // owned by Compositor; closed in shutdown()
    int ctrlFd_ = -1;  // owned by Compositor; closed in shutdown()
    bool shutdownDone_ = false;

    // Buffered non-blocking sender for steady-state ctrl messages. A peer that
    // briefly stops draining (e.g. GPU process inside a DRM fence wait) cannot
    // wedge this side: send() queues on EAGAIN, the addon's UV_WRITABLE arm
    // drains it via ctrlPumpOut(). Constructed only after handshake() (which
    // does the one-shot blocking Hello). Shutdown still uses blocking
    // sendMessage -- both sides are tearing down, brief blocking is acceptable.
    std::unique_ptr<ipc::CtrlSender> ctrlSender_;

    // Plugin wire connections: async-completion status keyed by connId
    // (0=pending, 1=ok, 2=failed), updated by drainCtrl.
    uint32_t nextConnId_ = 1;
    std::unordered_map<uint32_t, int> wireConnAdded_;
    std::unordered_map<uint32_t, int> pluginInstanceInjected_;

    // Plugin surface buffers: the core-side reservation (held alive) + alloc
    // status, keyed by surfaceBufId.
    uint32_t nextSurfaceBufId_ = 1;
    // The held reservation for each in-flight or live surfaceBufId. Owned via
    // TaggedReservation so the deferred-reclaim policy is enforced by type:
    // releaseSurfaceBuf commit()s (the GPU process accepted the alloc and may
    // have published a server-side object at the id -- never recycle); a
    // SurfaceBufAllocated reply with ok=0 discard()s (the inject failed before
    // any server-side state was published -- safe to reclaim).
    std::unordered_map<uint32_t, TaggedReservation> coreSurfaceReservations_;
    std::unordered_map<uint32_t, int> surfaceBufAllocated_;

    bool headless_ = false;
    wgpu::Texture currentOutputTexture_;  // held between acquire + present
    wgpu::Instance instance_;
    wgpu::Device device_;
    wgpu::Surface surface_;            // nested only
    wgpu::TextureFormat renderFormat_ = wgpu::TextureFormat::BGRA8Unorm;

    // JS-compositor dmabuf imports (importDmabufForJs): reserve a texture, send
    // ImportClientTex, hold the reservation until the GPU replies, then hand the
    // injected handle to JS. Completion reports the texture handle to JS instead
    // of building native compositing state.
    //
    // The reservation is owned via TaggedReservation -- callers must terminate
    // it explicitly with commit() (the GPU process accepted the import; never
    // recycle the id) or discard() (the import was never observed by a peer;
    // safe to reclaim). The destructor falls back to discard, so a leaked
    // entry returns the id to the pool rather than leaking forever.
    struct PendingJsImport {
        uint32_t importId;
        uint32_t width;
        uint32_t height;
        TaggedReservation reservation;
    };
    std::vector<PendingJsImport> pendingJsImports_;
    std::vector<JsImportDone> completedJsImports_;
    std::vector<OutputDescriptorMsg> pendingOutputDescriptors_;
    // Hotplug deliveries drained alongside OutputDescriptor (M7). Added carries
    // the full descriptor body (same struct reused); removed carries only the
    // dense outputId.
    std::vector<OutputDescriptorMsg> pendingOutputsAdded_;
    std::vector<uint32_t> pendingOutputsRemoved_;
    std::vector<OutputModesMsg> pendingOutputModes_;

    // KMS scanout state. Populated on receipt of ipc::Tag::ScanoutInjected
    // during bring-up. Each slot holds the wire handle id+generation (resolved
    // to a WGPUTexture via WireClient::GetTextureHandle later) and the local
    // state machine bit. `currentSlot_` is the slot acquired in this frame's
    // acquireOutputTextureHandle, used by presentOutput to know which to flip.
    struct ScanoutSlot {
        uint32_t handleId   = 0;
        uint32_t handleGen  = 0;
        uint32_t surfaceBufId = 0;  // for in-band BeginAccess/EndAccess brackets
        ScanoutSlotState state = ScanoutSlotState::FREE;
        WGPUTexture tex     = nullptr;  // resolved from (handleId, handleGen) at first use
    };
    bool kmsMode_ = false;
    bool kmsPaused_ = false;  // VT-switch disable_seat; cleared on enable_seat
    bool frameCompleteSeen_ = false;  // set in drainCtrl on ScanoutFlipComplete / FrameComplete
    // KMS-only queue of outputIds whose ScanoutFlipComplete arrived since the
    // last takeFlipCompletes(). Drained by the addon to dispatch per-output
    // wl_callback.done. Nested/headless never push here.
    std::vector<uint32_t> flipCompletes_;
    // Per-output scanout state, keyed by outputId. Each output owns a 3-slot ring
    // and the slot acquired by its in-flight frame. One entry today (the primary,
    // outputId 0); per-output rings populate this as each output's scanout is
    // reserved.
    struct ScanoutOutput {
        ScanoutSlot slots[3] = {};
        int currentSlot = -1;  // slot acquired by the current frame; -1 if none
    };
    std::unordered_map<uint32_t, ScanoutOutput> scanoutOutputs_;
    int pendingScanoutFenceFd_ = -1;  // attached to next presentOutput, then closed
    uint32_t nextJsImportId_ = 1;
    // importId -> the injected texture's wire handle {id,generation}, kept so a
    // later releaseDmabufImport can address the GPU-side entry. Erased on release.
    struct WireHandleId { uint32_t id; uint32_t generation; };
    std::unordered_map<uint32_t, WireHandleId> jsImportHandles_;

    uint32_t windowWidth_ = 0;
    uint32_t windowHeight_ = 0;
    uint64_t presented_ = 0;
    DmabufFeedback dmabufFeedback_;  // formatTableFd owned; closed in shutdown()
    std::string error_;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_COMPOSITOR_H_
