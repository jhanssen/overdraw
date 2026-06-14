// Side-channel protocol between the core and the GPU process.
//
// v1 encoding: 1-byte tag + fixed-size POD payload, sent over a unix socket
// via sendmsg/recvmsg (so SCM_RIGHTS fd passing can be added later without
// changing the framing). The architecture doc specifies flatbuffers here;
// plain structs are used until the message set stabilizes.
//
// This header is shared by both processes (core wire-client side and
// GPU-process wire-server side). It must not pull in Dawn or Wayland.

#ifndef OVERDRAW_IPC_SIDE_CHANNEL_H_
#define OVERDRAW_IPC_SIDE_CHANNEL_H_

#include <cstdint>

namespace overdraw::ipc {

// Wire-bytes go on a separate socket; the side channel carries only control.
enum class Tag : uint8_t {
    Hello        = 'H',  // core -> gpu : handshake
    HelloReply   = 'h',  // gpu  -> core: handshake reply (+ window size)
    InstanceReserved = 'I',  // core -> gpu : reserved instance handle
    DeviceReady  = 'S',  // core -> gpu : device handle + reserved surface handle
    SurfaceReady = 'C',  // gpu  -> core: surface injected + caps + size
    FeedbackData = 'F',  // gpu  -> core: dmabuf-feedback data (main_device dev_t +
                         //              format_table entry count); the format_table
                         //              memfd rides as SCM_RIGHTS on the same msg
    ImportClientTex = 'M',  // core -> gpu : import a CLIENT dmabuf fd (SCM_RIGHTS) into
                            //              a texture at the reserved handle
    ClientTexImported = 'm',  // gpu -> core: client dmabuf imported + injected (or failed)
    ReleaseClientTex = 'r',   // core -> gpu : release a client-dmabuf import (texture =
                              //              {id,generation}); GPU drops the STM + fd if
                              //              the entry's generation still matches.
    // The per-frame CLIENT-dmabuf BeginAccess/EndAccess bracket is multiplexed
    // in-band on the WIRE socket as a kind=1/kind=2 frame (see transport.h
    // FrameKind + ClientTexAccessPayload below), FIFO-ordered against the Dawn
    // sample commands -- no ctrl round-trip, no WireBarrier.
    AddWireConn  = 'W',  // core -> gpu : register a NEW wire connection for a plugin.
                         //   The plugin's wire socket (GPU end) rides as SCM_RIGHTS
                         //   on this message; `connId` names it for later messages.
                         //   The GPU process creates a per-connection WireServer +
                         //   native instance and adds the fd to its event loop. The
                         //   plugin's Worker drives ReserveInstance/RequestDevice
                         //   over its own wire-client end (no listening socket: only
                         //   the trusted core, over this side channel, can introduce
                         //   a connection). See architecture.md "IPC".
    WireConnAdded = 'w', // gpu -> core: AddWireConn registered (or failed: ok=0)
    InjectPluginInstance = 'P',  // core -> gpu : inject conn `connId`'s native
                                 //   instance at the handle the plugin's wire
                                 //   client reserved (relayed via the Worker).
                                 //   After this the plugin drives RequestAdapter/
                                 //   RequestDevice over its own wire.
    PluginInstanceInjected = 'p', // gpu -> core: InjectInstance done (ok)
    SetPluginTickDevice = 'T',  // core -> gpu : the plugin device (resolved over
                                //   the wire) so the GPU process DeviceTick's it
                                //   each pump -- without this the plugin device's
                                //   queue never advances (map/work-done never
                                //   complete). connId + device handle.
    AllocSurfaceBuf = 'A',  // core -> gpu : allocate ONE GBM dmabuf and import it
                            //   into BOTH the plugin device (producer) and the
                            //   core device (consumer), injecting a texture at
                            //   each side's reserved handle. This is the
                            //   producer/consumer surface buffer (architecture.md
                            //   "Dmabuf-backed surfaces"). connId names the plugin
                            //   connection; pluginDevice/pluginTexture are on the
                            //   plugin wire, device/texture (core fields) on the
                            //   core wire. width/height/format describe the buffer.
    SurfaceBufAllocated = 'a',  // gpu -> core: allocated + imported + injected on
                                //   both devices (ok=1), or failed (ok=0). Carries
                                //   the surfaceBufId the core uses for later
                                //   Begin/EndAccess on this buffer.
    AllocComposeBuf = 'c',  // core -> gpu : SAME as AllocSurfaceBuf, but the
                            //   producer is the CORE device and the consumer
                            //   is the plugin device (sdk.compose Worker
                            //   transport, phase 5b). Wire fields are the
                            //   same shape -- device/texture name the CORE
                            //   (producer) side; pluginDevice/pluginTexture
                            //   name the PLUGIN (consumer) side. Reply is
                            //   SurfaceBufAllocated like AllocSurfaceBuf.
                            //   The resulting SurfaceBuf has producerOnCore=
                            //   true; producer Begin/End ride the CORE wire
                            //   and consumer Begin/End ride the OWNING plugin
                            //   wire (inverted from AllocSurfaceBuf).
    // NOTE: the per-frame producer/consumer fence-dance brackets on a surface
    // buffer also no longer ride ctrl. Consumer Begin/End ride the CORE wire and
    // producer Begin/End ride the owning PLUGIN wire, both as in-band kind=1/
    // kind=2 Surface frames (SurfaceAccessPayload), FIFO-ordered against the
    // render/sample commands on the same wire. The former tags ('G'/'q'/'g'
    // Producer*, 'V'/'k'/'v' Consumer*) are retired; do not reuse those letters
    // without checking no in-flight build still emits them. The cross-device
    // fence dance itself is unchanged (runSurfaceBegin/runSurfaceEnd in the GPU
    // process); only the trigger moved from ctrl to the wire.
    ReleaseSurfaceBuf = 'D',  // core->gpu: destroy a ring slot's surfaceBuf -- end any
                          //   open access bracket, drop the SharedTextureMemory/textures/
                          //   fences, release the GBM dmabuf. Fire-and-forget (the core
                          //   has already gated this on its own GPU read completing).
    OutputDescriptor = 'O',  // gpu -> core: the output's identity + geometry. Sent
                             //   once after surface bring-up and again whenever the
                             //   GPU process detects a change (host-window resize in
                             //   nested mode; a future KMS mode change). The core's
                             //   state.outputs is updated from this and re-emits to
                             //   bound wl_output / xdg_output resources. See
                             //   docs/drm-design.md "Output configuration".
    SetDrmFd     = 'R',  // core -> gpu: hand off the DRM card fd (opened by the core
                         //   via libseat) for the KMS output backend. The fd rides as
                         //   SCM_RIGHTS on the same sendmsg. Sent during bring-up
                         //   BEFORE Hello when --output=kms; the GPU process refuses
                         //   to start the output backend until it arrives.
                         //   See drm-design.md "Seat / VT lifecycle".
    ScanoutReserve  = 'Z',  // core -> gpu: the core has ReserveTexture'd three wire
                            //   handles (sent as `scanoutHandles[3]` on this msg).
                            //   The GPU process completes its DRM/GBM/STM bring-up
                            //   and InjectTexture's the three scanout-ring textures
                            //   at the matching handles. width/height carry the
                            //   scanout dims (chosen by the connector's mode).
    ScanoutReady    = 'y',  // gpu -> core: the scanout ring is built and injected
                            //   at the three reserved handles. ok=1 success, 0 failure.
                            //   Sent once during bring-up.
    ScanoutPresent  = 'z',  // core -> gpu: the JS compositor finished rendering
                            //   into slot `surfaceBufId` (the slot index, 0..2).
                            //   The GPU process runs drmModeAtomicCommit with
                            //   IN_FENCE_FD set to the attached sync_file fd (via
                            //   SCM_RIGHTS) so the kernel waits for GPU work to
                            //   complete. fence fd may be absent (no SCM_RIGHTS
                            //   payload) -- then no IN_FENCE_FD is added.
    ScanoutFlipComplete = 'Y',  // gpu -> core: a page-flip retired a slot. The
                                //   `surfaceBufId` field carries the slot index
                                //   that just exited SCANOUT (now FREE). The core
                                //   advances its slot state machine off this.
    OutputPause  = 'q',  // core -> gpu: VT-switch-away (libseat disable_seat).
                         //   GPU process stops atomic commits, clears any pending
                         //   flip wait, resets the scanout ring's per-slot state
                         //   to FREE, and clears didInitialCommit_ so the next
                         //   ScanoutPresent after resume runs the ALLOW_MODESET
                         //   commit path. Idempotent. See drm-design.md "Seat /
                         //   VT lifecycle".
    OutputResume = 'Q',  // core -> gpu: VT-switch-back (libseat enable_seat).
                         //   Today this is informational on the GPU side: the
                         //   first ScanoutPresent after pause will re-run modeset
                         //   because didInitialCommit_ was cleared on Pause. The
                         //   message exists so the GPU can log + assert state
                         //   invariants on resume, and so a future change can
                         //   trigger a forced modeset without waiting for the
                         //   next render.
    Shutdown     = 'X',  // core -> gpu : clean termination request
};

// Wire object handle {id, generation}, matching dawn::wire::Handle layout.
struct WireHandle {
    uint32_t id = 0;
    uint32_t generation = 0;
};

// Single fixed payload covering all v1 messages (union-by-convention; each tag
// uses the subset of fields it needs). Keeps framing trivial for the slice.
struct Message {
    Tag tag;
    uint8_t _pad[3] = {0, 0, 0};

    WireHandle instance;   // Hello*, InstanceReserved, DeviceReady, SurfaceReady
    WireHandle device;     // DeviceReady, SurfaceReady
    WireHandle surface;    // DeviceReady, SurfaceReady
    WireHandle texture;    // ImportClientTex, ClientTexImported, ReleaseClientTex

    uint32_t format = 0;       // SurfaceReady: WGPUTextureFormat
    uint32_t presentMode = 0;  // SurfaceReady: WGPUPresentMode
    uint32_t alphaMode = 0;    // SurfaceReady: WGPUCompositeAlphaMode
    uint32_t width = 0;        // HelloReply, SurfaceReady
    uint32_t height = 0;       // HelloReply, SurfaceReady

    uint64_t modifier = 0;     // ImportClientTex: DRM modifier of the client dmabuf

    uint32_t protocolVersion = 0;  // Hello/HelloReply

    // ImportClientTex: client-supplied dmabuf parameters (single plane v1). The
    // dmabuf fd rides as SCM_RIGHTS ancillary data on the same sendmsg.
    uint32_t drmFourcc = 0;    // DRM fourcc (e.g. ARGB8888) the client declared
    uint32_t planeOffset = 0;  // plane 0 byte offset within the dmabuf
    uint32_t planeStride = 0;  // plane 0 row stride
    uint32_t planeCount = 0;   // number of planes (1 supported today)
    uint32_t importOk = 0;     // ClientTexImported: 1 = injected, 0 = import failed

    // FeedbackData: dmabuf-feedback default-feedback data. mainDevice is the DRM
    // device dev_t; entryCount is the number of 16-byte format_table records in
    // the memfd passed alongside (SCM_RIGHTS). formatTableSize is its byte size.
    uint64_t mainDevice = 0;
    uint32_t entryCount = 0;
    uint32_t formatTableSize = 0;

    // AddWireConn / WireConnAdded: opaque per-plugin connection id (assigned by
    // the core; echoed in the reply). `ok` is the reply's success flag.
    uint32_t connId = 0;
    uint32_t ok = 0;

    // AllocSurfaceBuf: the plugin (producer) device + reserved texture handle, on
    // the plugin wire connection (`connId`). The core (consumer) device + reserved
    // texture handle use the `device`/`texture` fields above. `width`/`height`/
    // `format` describe the buffer.
    WireHandle pluginDevice;
    WireHandle pluginTexture;
    // SurfaceBufAllocated: an id naming this server-allocated surface buffer, for
    // the core's later Begin/EndAccess (which side, plugin vs core, is implied by
    // the access message). Assigned by the core in the request; echoed back.
    uint32_t surfaceBufId = 0;

    // ImportClientTex: cross-channel ordering serial. The GPU process must not
    // act on this request until its wire reader has consumed at least this many
    // framed wire bytes (so all wire commands the inject depends on -- the prior
    // texture's UnregisterObjectCmd that recycled this handle id, object creates,
    // etc. -- have been handed to the wire server). Sampled by the core from
    // FdSerializer::bytesQueued() right after flushing the reserve.
    //
    // For AllocSurfaceBuf this names the CORE wire reader (the core reserved the
    // consumer texture); for ProducerEnd, the PLUGIN wire reader (plugin render
    // commands ride that wire). See `reservePointSerial` for the PLUGIN-wire side
    // of AllocSurfaceBuf (the producer texture).
    uint64_t wireSerial = 0;

    // AllocSurfaceBuf: cross-channel ordering serial on the PLUGIN wire connection.
    // The plugin worker sampled its own FdSerializer::bytesQueued() right after
    // flushing the producer-texture reserve; the GPU process must not InjectTexture
    // at the producer handle until its plugin-conn wire reader has consumed at
    // least this many framed bytes (so the prior UnregisterObjectCmd that recycled
    // this id has been applied and the new ReserveTexture is in). Independent of
    // `wireSerial` above, which is the CORE-wire serial for the consumer texture.
    uint64_t reservePointSerial = 0;

    // OutputDescriptor: the output's identity + geometry. Width/height (above,
    // shared with HelloReply/SurfaceReady) carry the logical pixel size of the
    // output. Refresh is in mHz (wl_output.mode units: Hz * 1000). Scale is the
    // integer wl_output v1-style scale (HiDPI multiplier; future fractional
    // scale carries the same integer ceiling here and a separate fractional
    // hint protocol surface). Transform is the wl_output.transform enum value
    // (normal=0, 90=1, 180=2, 270=3, flipped=4..). Physical dims in millimeters
    // (0 = unknown). Make/model/name are fixed-size NUL-terminated buffers; the
    // protocol-level strings are derived from these on the core side (e.g.
    // wl_output.geometry's make/model; xdg_output's description).
    uint32_t refreshMhz       = 0;
    uint32_t outScale         = 1;
    uint32_t outTransform     = 0;
    uint32_t physicalWidthMm  = 0;
    uint32_t physicalHeightMm = 0;
    char outputName [64] = {};
    char outputMake [64] = {};
    char outputModel[64] = {};

    // ScanoutReserve: the three texture wire handles (id+generation) the core
    // ReserveTexture'd for the KMS scanout ring slots, plus the three
    // surfaceBufId values the core assigned for in-band access brackets on
    // them. The GPU process InjectTexture's each ring slot's wgpu::Texture
    // at the matching handle AND registers each surfaceBufId as a SurfaceBuf
    // (producerOnCore=true, consumer side null) so the existing in-band
    // BeginAccess/EndAccess machinery covers scanout brackets too. Width/
    // height (above) carry the scanout dims.
    WireHandle scanoutHandles[3] = {};
    uint32_t   scanoutBufIds[3]  = {};
};

constexpr uint32_t kProtocolVersion = 1;

// ---------------------------------------------------------------------------
// In-band access-bracket frame payloads (FrameKind::BeginAccess / EndAccess).
//
// These ride the WIRE socket as kind != 0 frames (see transport.h FrameKind),
// not the ctrl socket. The frame payload begins with a 1-byte variant
// discriminating which Begin/End pair it is, since the three pairs key on
// different server-side identifiers. Layouts (little-endian, packed by the
// helpers below; no struct padding assumptions cross the socket):
//
//   variant=ClientTex : [variant:u8][textureId:u32][textureGeneration:u32]
//   variant=Surface   : [variant:u8][surfaceBufId:u32][producer:u8]
//
// Begin and End use the SAME payload shape per variant (client-texture keys on
// the (id,generation) wire handle for both; surface keys on surfaceBufId +
// producer bit for both). Encoded/decoded only through these helpers so the
// two processes cannot disagree on the byte layout.
enum class AccessVariant : uint8_t {
    ClientTex = 0,  // per-frame client dmabuf texture bracket (core wire)
    Surface = 1,    // producer/consumer surface-buffer bracket (core/plugin wire)
};

// Append a u32 little-endian to a byte buffer.
inline void putU32LE(uint8_t* p, uint32_t v) {
    p[0] = static_cast<uint8_t>(v);
    p[1] = static_cast<uint8_t>(v >> 8);
    p[2] = static_cast<uint8_t>(v >> 16);
    p[3] = static_cast<uint8_t>(v >> 24);
}
inline uint32_t getU32LE(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) | (static_cast<uint32_t>(p[3]) << 24);
}

// Client-texture Begin/End payload: variant + (id, generation). 9 bytes.
struct ClientTexAccessPayload {
    uint32_t textureId;
    uint32_t textureGeneration;
    static constexpr size_t kSize = 1 + 4 + 4;
    void encode(uint8_t* out) const {
        out[0] = static_cast<uint8_t>(AccessVariant::ClientTex);
        putU32LE(out + 1, textureId);
        putU32LE(out + 5, textureGeneration);
    }
};

// Surface (producer/consumer) Begin/End payload: variant + surfaceBufId +
// producer bit. 6 bytes. Used by the consumer (core wire) and producer (plugin
// wire) paths.
struct SurfaceAccessPayload {
    uint32_t surfaceBufId;
    bool producer;
    static constexpr size_t kSize = 1 + 4 + 1;
    void encode(uint8_t* out) const {
        out[0] = static_cast<uint8_t>(AccessVariant::Surface);
        putU32LE(out + 1, surfaceBufId);
        out[5] = producer ? 1 : 0;
    }
};

}  // namespace overdraw::ipc

#endif  // OVERDRAW_IPC_SIDE_CHANNEL_H_
