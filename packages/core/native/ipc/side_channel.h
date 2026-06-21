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
#include <cstring>
#include <string>
#include <vector>

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
    // The per-frame CLIENT-dmabuf BeginAccess/EndAccess bracket is multiplexed
    // in-band on the WIRE socket as a kind=1/kind=2 frame (see transport.h
    // FrameKind + ClientTexAccessPayload below), FIFO-ordered against the Dawn
    // sample commands -- no ctrl round-trip, no WireBarrier.
    //
    // Likewise the surface-buffer alloc/release and client-texture release tags
    // now ride the WIRE socket (FrameKind::AllocSurfaceBuf / AllocComposeBuf /
    // SurfaceBufAllocated / ReleaseSurfaceBuf / ReleaseClientTex). The retired
    // letters 'A' / 'a' / 'c' / 'D' / 'r' are intentionally not reused -- do
    // not assign them to new tags without checking no in-flight build still
    // emits them. See architecture.md "Why wire, not ctrl".
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
    // Surface-buffer alloc / release rides the WIRE socket as FrameKind
    // AllocSurfaceBuf / AllocComposeBuf / SurfaceBufAllocated /
    // ReleaseSurfaceBuf (transport.h). The per-frame producer/consumer
    // fence-dance brackets on a surface buffer also ride wire as kind=1/
    // kind=2 Surface frames (SurfaceAccessPayload), FIFO-ordered against
    // the render/sample commands on the same wire. Retired ctrl letters
    // (do not reuse): 'A' AllocSurfaceBuf, 'a' SurfaceBufAllocated,
    // 'c' AllocComposeBuf, 'D' ReleaseSurfaceBuf, plus 'G'/'q'/'g'
    // (Producer*) and 'V'/'k'/'v' (Consumer*) from the prior per-frame
    // ctrl brackets. The cross-device fence dance itself is unchanged
    // (runSurfaceBegin/runSurfaceEnd in the GPU process); only the
    // trigger moved from ctrl to the wire.
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
                                //   Also doubles as the KMS frame-complete signal
                                //   for the wake/render state machine.
    FrameComplete = 'f',  // gpu -> core: nested mode's host wl_surface.frame
                          //   callback fired (the host compositor is ready for
                          //   the next frame). The KMS path uses
                          //   ScanoutFlipComplete for the same purpose; the two
                          //   exist as separate tags because KMS carries the
                          //   retired slot idx in its payload and nested has
                          //   no equivalent.
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
    // OutputAdded / OutputRemoved ride the WIRE socket as FrameKind
    // frames (transport.h FrameKind::OutputAdded / OutputRemoved). The
    // wire-FIFO ordering is load-bearing: the core's reaction to
    // OutputAdded is reserveScanoutForOutput, which writes a
    // ScanoutReserve wire frame -- having OutputAdded on ctrl while
    // ScanoutReserve rides wire created a cross-fd window. Retired
    // ctrl letters (do not reuse): 'N' OutputAdded, 'n' OutputRemoved.
    // See architecture.md "Why wire, not ctrl".
    // ScanoutRebuild and SwitchMode now ride the WIRE socket as FrameKind
    // variants (transport.h), not Tag-on-ctrl. The wire-FIFO ordering is
    // load-bearing: a SwitchMode arriving on ctrl while ProducerBegin
    // frames for the same output are still queued on wire would tear down
    // the surfaceBufs the GPU is still in the middle of accessing. See
    // multi-output-design §10.5 and the M7 step 4 cross-fd race fix
    // (commit 447a905). The 'B' tag letter is intentionally not reused.
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
    // Stable durable identifier derived from EDID (manufacturer + product
    // code + serial). Empty when the connector has no usable EDID. The
    // workspace plugin (M7 step 5) keys its `preferredOutputs` list on this
    // when present, falling back to `outputName` -- see multi-output-design
    // §3 ("Output identity model"). Fixed 64-byte NUL-terminated buffer;
    // 64 covers `mfr3+u16+u32` plus headroom for a future format change.
    char outputEdidId[64] = {};

    // Routing id of the output this message concerns, for every output-scoped
    // tag: OutputDescriptor, ScanoutReserve, ScanoutReady, ScanoutPresent,
    // ScanoutFlipComplete. The core keys state.outputs by it and the GPU process
    // routes per-output scanout state by it. 0 is the first output; one output
    // exists today, so it is always 0 until multi-output enumeration lands.
    uint32_t outputId = 0;

    // OutputDescriptor: total number of outputs the GPU process is driving. Set
    // on every OutputDescriptor send so the core learns how many scanout rings
    // to reserve before the first descriptor's reply path proceeds. 0 means
    // unset (the core falls back to a single output).
    uint32_t outputCount = 0;

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
inline void putU64LE(uint8_t* p, uint64_t v) {
    putU32LE(p + 0, static_cast<uint32_t>(v));
    putU32LE(p + 4, static_cast<uint32_t>(v >> 32));
}
inline uint64_t getU64LE(const uint8_t* p) {
    return static_cast<uint64_t>(getU32LE(p))
         | (static_cast<uint64_t>(getU32LE(p + 4)) << 32);
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

// ---------------------------------------------------------------------------
// In-band ImportClientTex (kind=3, core -> gpu) and ClientTexImported (kind=4,
// gpu -> core) frame payloads. See FrameKind in transport.h for the FIFO-
// ordering rationale.

// ImportClientTex payload: the reserved CORE-wire texture+device handle the
// GPU process should InjectTexture at, plus single-plane dmabuf parameters.
// The dmabuf fd rides as SCM_RIGHTS on the sendmsg that carried this frame.
struct ImportClientTexPayload {
    uint32_t textureId;
    uint32_t textureGeneration;
    uint32_t deviceId;
    uint32_t deviceGeneration;
    uint32_t width;
    uint32_t height;
    uint32_t drmFourcc;
    uint64_t modifier;
    uint32_t planeOffset;
    uint32_t planeStride;
    static constexpr size_t kSize = 9 * 4 + 8;  // 9 u32 + 1 u64 = 44 bytes
    void encode(uint8_t* out) const {
        putU32LE(out +  0, textureId);
        putU32LE(out +  4, textureGeneration);
        putU32LE(out +  8, deviceId);
        putU32LE(out + 12, deviceGeneration);
        putU32LE(out + 16, width);
        putU32LE(out + 20, height);
        putU32LE(out + 24, drmFourcc);
        // u64 LE: low then high
        putU32LE(out + 28, static_cast<uint32_t>(modifier));
        putU32LE(out + 32, static_cast<uint32_t>(modifier >> 32));
        putU32LE(out + 36, planeOffset);
        putU32LE(out + 40, planeStride);
    }
    static ImportClientTexPayload decode(const uint8_t* p) {
        ImportClientTexPayload r{};
        r.textureId         = getU32LE(p +  0);
        r.textureGeneration = getU32LE(p +  4);
        r.deviceId          = getU32LE(p +  8);
        r.deviceGeneration  = getU32LE(p + 12);
        r.width             = getU32LE(p + 16);
        r.height            = getU32LE(p + 20);
        r.drmFourcc         = getU32LE(p + 24);
        r.modifier          = static_cast<uint64_t>(getU32LE(p + 28)) |
                              (static_cast<uint64_t>(getU32LE(p + 32)) << 32);
        r.planeOffset       = getU32LE(p + 36);
        r.planeStride       = getU32LE(p + 40);
        return r;
    }
};
static_assert(ImportClientTexPayload::kSize == 44,
              "ImportClientTexPayload size mismatch with hand-counted layout");

// ClientTexImported payload (no fd): echo the texture handle and the
// import-ok flag. The core matches replies to its pendingJsImports list by
// texture id (imports complete in send order on a single wire).
struct ClientTexImportedPayload {
    uint32_t textureId;
    uint32_t textureGeneration;
    uint8_t  importOk;
    static constexpr size_t kSize = 4 + 4 + 1;  // 9 bytes
    void encode(uint8_t* out) const {
        putU32LE(out + 0, textureId);
        putU32LE(out + 4, textureGeneration);
        out[8] = importOk;
    }
    static ClientTexImportedPayload decode(const uint8_t* p) {
        ClientTexImportedPayload r{};
        r.textureId         = getU32LE(p + 0);
        r.textureGeneration = getU32LE(p + 4);
        r.importOk          = p[8];
        return r;
    }
};
static_assert(ClientTexImportedPayload::kSize == 9,
              "ClientTexImportedPayload size mismatch with hand-counted layout");

// ---------------------------------------------------------------------------
// In-band ScanoutReserve (kind=6, core -> gpu) and ScanoutReady (kind=7,
// gpu -> core) frame payloads. Reserves a 3-slot scanout ring per output;
// the GPU process InjectTextures at the reserved handles and replies ready.
//
// These ride the WIRE socket so they are FIFO-ordered with the
// per-frame Begin/End access frames that reference the same
// surfaceBufIds. Putting them on ctrl (as M7 step 4 originally did) is
// unsafe: wire and ctrl are independent fds, and on a hotplug add the
// core writes ProducerBegin on wire moments after ScanoutReserve on
// ctrl -- the GPU process can drain wire first and abort on an
// unregistered surfaceBufId. See multi-output-design §4 / the M7
// step 5 follow-up.

// ScanoutReserve payload: outputId, scanout dims, plus 3 (handleId,
// handleGeneration, surfaceBufId) tuples. The core has already
// ReserveTexture'd each handle on the wire BEFORE this frame is appended
// (appendFrame flushes pending Dawn bytes first), so the GPU process's
// wire reader has consumed the reservation bytes by the time it sees
// this frame -- InjectTexture at each handle then succeeds.
struct ScanoutReservePayload {
    uint32_t outputId;
    uint32_t width;
    uint32_t height;
    struct Slot { uint32_t handleId; uint32_t handleGeneration; uint32_t surfaceBufId; };
    Slot slots[3];
    static constexpr size_t kSize = 4 + 4 + 4 + 3 * (4 + 4 + 4);  // 48
    void encode(uint8_t* out) const {
        putU32LE(out + 0,  outputId);
        putU32LE(out + 4,  width);
        putU32LE(out + 8,  height);
        for (int i = 0; i < 3; ++i) {
            putU32LE(out + 12 + i * 12 + 0, slots[i].handleId);
            putU32LE(out + 12 + i * 12 + 4, slots[i].handleGeneration);
            putU32LE(out + 12 + i * 12 + 8, slots[i].surfaceBufId);
        }
    }
    static ScanoutReservePayload decode(const uint8_t* p) {
        ScanoutReservePayload r{};
        r.outputId = getU32LE(p + 0);
        r.width    = getU32LE(p + 4);
        r.height   = getU32LE(p + 8);
        for (int i = 0; i < 3; ++i) {
            r.slots[i].handleId         = getU32LE(p + 12 + i * 12 + 0);
            r.slots[i].handleGeneration = getU32LE(p + 12 + i * 12 + 4);
            r.slots[i].surfaceBufId     = getU32LE(p + 12 + i * 12 + 8);
        }
        return r;
    }
};
static_assert(ScanoutReservePayload::kSize == 48,
              "ScanoutReservePayload size mismatch with hand-counted layout");

// SwitchMode payload (core -> gpu, FrameKind::SwitchMode): swap the
// named output to a new mode. Width/height are in device pixels; refreshMhz
// is in mHz (Hz * 1000, same units as wl_output.mode). The GPU process
// must match these against the connector's mode list -- v1 has no
// support for custom modes (DRM mode validation is its own piece of
// work; see multi-output-design §10.5). When no matching mode exists,
// the GPU logs a warning and skips the switch (the output stays on its
// current mode; the client receives no protocol-level error today).
struct SwitchModePayload {
    uint32_t outputId;
    uint32_t width;
    uint32_t height;
    uint32_t refreshMhz;
    static constexpr size_t kSize = 4 * 4;  // 16
    void encode(uint8_t* out) const {
        putU32LE(out + 0,  outputId);
        putU32LE(out + 4,  width);
        putU32LE(out + 8,  height);
        putU32LE(out + 12, refreshMhz);
    }
    static SwitchModePayload decode(const uint8_t* p) {
        SwitchModePayload r{};
        r.outputId   = getU32LE(p + 0);
        r.width      = getU32LE(p + 4);
        r.height     = getU32LE(p + 8);
        r.refreshMhz = getU32LE(p + 12);
        return r;
    }
};
static_assert(SwitchModePayload::kSize == 16,
              "SwitchModePayload size mismatch with hand-counted layout");

// ScanoutRebuild payload (gpu -> core, FrameKind::ScanoutRebuild): the
// GPU has torn down the named output's ring and the new dims are
// width/height. The core releases the prior bookkeeping (the old
// surfaceBufIds will not be referenced again) and then runs the
// per-output ScanoutReserve handshake exactly as for OutputAdded --
// fresh wire handles, fresh surfaceBufIds. The GPU process meanwhile has
// already allocated the new ring's wgpu::Textures at the new dims;
// handleScanoutReserve InjectTextures them.
struct ScanoutRebuildPayload {
    uint32_t outputId;
    uint32_t width;
    uint32_t height;
    static constexpr size_t kSize = 3 * 4;  // 12
    void encode(uint8_t* out) const {
        putU32LE(out + 0, outputId);
        putU32LE(out + 4, width);
        putU32LE(out + 8, height);
    }
    static ScanoutRebuildPayload decode(const uint8_t* p) {
        ScanoutRebuildPayload r{};
        r.outputId = getU32LE(p + 0);
        r.width    = getU32LE(p + 4);
        r.height   = getU32LE(p + 8);
        return r;
    }
};
static_assert(ScanoutRebuildPayload::kSize == 12,
              "ScanoutRebuildPayload size mismatch with hand-counted layout");

// ScanoutReady payload: outputId + ok. The GPU process emits this AFTER
// InjectTexture'ing all three slots for the named outputId; ok=0 signals a
// fatal injection failure (the bringup path aborts; runtime hotplug logs and
// abandons the output -- it stays in scanoutOutputs_ but acquireOutputTextureHandle
// returns null so no frames are written for it).
struct ScanoutReadyPayload {
    uint32_t outputId;
    uint8_t  ok;
    static constexpr size_t kSize = 4 + 1;  // 5 bytes
    void encode(uint8_t* out) const {
        putU32LE(out + 0, outputId);
        out[4] = ok;
    }
    static ScanoutReadyPayload decode(const uint8_t* p) {
        ScanoutReadyPayload r{};
        r.outputId = getU32LE(p + 0);
        r.ok       = p[4];
        return r;
    }
};
static_assert(ScanoutReadyPayload::kSize == 5,
              "ScanoutReadyPayload size mismatch with hand-counted layout");

// AllocSurfaceBufPayload (core -> gpu; FrameKind::AllocSurfaceBuf or
// FrameKind::AllocComposeBuf -- the FrameKind discriminates which side
// produces, the payload shape is identical). Carries the surfaceBufId
// the core picked, the plugin connection (connId), the buffer dims,
// the producer/consumer wire device + texture handles already reserved
// on each side's wire, and the cross-wire ordering serials each inject
// must wait for. See multi-output-design + architecture.md "Why wire,
// not ctrl".
//
// Layout (little-endian, 48 bytes total):
//   [0..3]   surfaceBufId   u32
//   [4..7]   connId         u32
//   [8..11]  width          u32
//   [12..15] height         u32
//   [16..19] pluginDeviceId u32
//   [20..23] pluginDeviceGen u32
//   [24..27] pluginTexId    u32
//   [28..31] pluginTexGen   u32
//   [32..35] coreDeviceId   u32
//   [36..39] coreDeviceGen  u32
//   [40..43] coreTexId      u32
//   [44..47] coreTexGen     u32
//   [48..55] reservePointSerial u64  (plugin-wire reserve point)
//   [56..63] wireSerial         u64  (core-wire reserve point)
struct AllocSurfaceBufPayload {
    uint32_t surfaceBufId;
    uint32_t connId;
    uint32_t width;
    uint32_t height;
    WireHandle pluginDevice;
    WireHandle pluginTexture;
    WireHandle coreDevice;
    WireHandle coreTexture;
    uint64_t reservePointSerial;
    uint64_t wireSerial;
    static constexpr size_t kSize = 4 * 4 + 4 * 8 + 2 * 8;  // 64
    void encode(uint8_t* out) const {
        putU32LE(out + 0,  surfaceBufId);
        putU32LE(out + 4,  connId);
        putU32LE(out + 8,  width);
        putU32LE(out + 12, height);
        putU32LE(out + 16, pluginDevice.id);
        putU32LE(out + 20, pluginDevice.generation);
        putU32LE(out + 24, pluginTexture.id);
        putU32LE(out + 28, pluginTexture.generation);
        putU32LE(out + 32, coreDevice.id);
        putU32LE(out + 36, coreDevice.generation);
        putU32LE(out + 40, coreTexture.id);
        putU32LE(out + 44, coreTexture.generation);
        putU64LE(out + 48, reservePointSerial);
        putU64LE(out + 56, wireSerial);
    }
    static AllocSurfaceBufPayload decode(const uint8_t* p) {
        AllocSurfaceBufPayload r{};
        r.surfaceBufId            = getU32LE(p + 0);
        r.connId                  = getU32LE(p + 4);
        r.width                   = getU32LE(p + 8);
        r.height                  = getU32LE(p + 12);
        r.pluginDevice.id         = getU32LE(p + 16);
        r.pluginDevice.generation = getU32LE(p + 20);
        r.pluginTexture.id        = getU32LE(p + 24);
        r.pluginTexture.generation = getU32LE(p + 28);
        r.coreDevice.id           = getU32LE(p + 32);
        r.coreDevice.generation   = getU32LE(p + 36);
        r.coreTexture.id          = getU32LE(p + 40);
        r.coreTexture.generation  = getU32LE(p + 44);
        r.reservePointSerial      = getU64LE(p + 48);
        r.wireSerial              = getU64LE(p + 56);
        return r;
    }
};
static_assert(AllocSurfaceBufPayload::kSize == 64,
              "AllocSurfaceBufPayload size mismatch with hand-counted layout");

// SurfaceBufAllocatedPayload (gpu -> core; FrameKind::SurfaceBufAllocated):
// the alloc + inject sequence on both sides completed (ok=1) or failed
// (ok=0). The surfaceBufs map entry is INSERTED on the GPU side BEFORE
// this frame is written, so the next ProducerBegin / ConsumerBegin the
// core writes is FIFO-ordered after that insert -- the GPU's wire reader
// will dispatch it against a populated map.
struct SurfaceBufAllocatedPayload {
    uint32_t surfaceBufId;
    uint32_t connId;
    uint8_t  ok;
    static constexpr size_t kSize = 4 + 4 + 1;  // 9
    void encode(uint8_t* out) const {
        putU32LE(out + 0, surfaceBufId);
        putU32LE(out + 4, connId);
        out[8] = ok;
    }
    static SurfaceBufAllocatedPayload decode(const uint8_t* p) {
        SurfaceBufAllocatedPayload r{};
        r.surfaceBufId = getU32LE(p + 0);
        r.connId       = getU32LE(p + 4);
        r.ok           = p[8];
        return r;
    }
};
static_assert(SurfaceBufAllocatedPayload::kSize == 9,
              "SurfaceBufAllocatedPayload size mismatch with hand-counted layout");

// ReleaseSurfaceBufPayload (core -> gpu; FrameKind::ReleaseSurfaceBuf):
// destroy a surfaceBuf. Wire-FIFO ordering means any still-pending
// ProducerEnd / ConsumerEnd for this buf has already been decoded by
// the GPU's wire reader before this frame runs -- no teardown-vs-open-
// bracket race possible.
struct ReleaseSurfaceBufPayload {
    uint32_t surfaceBufId;
    static constexpr size_t kSize = 4;
    void encode(uint8_t* out) const { putU32LE(out, surfaceBufId); }
    static ReleaseSurfaceBufPayload decode(const uint8_t* p) {
        return { getU32LE(p) };
    }
};
static_assert(ReleaseSurfaceBufPayload::kSize == 4,
              "ReleaseSurfaceBufPayload size mismatch with hand-counted layout");

// OutputDescriptorPayload (gpu -> core; FrameKind::OutputAdded).
// Carries one output's full identity + geometry. Layout (little-endian):
//
//   [0..3]   outputId          u32
//   [4..7]   width             u32 (device pixels)
//   [8..11]  height            u32
//   [12..15] refreshMhz        u32 (Hz * 1000)
//   [16..19] scale             u32 (integer wl_output scale)
//   [20..23] transform         u32 (wl_output.transform enum value)
//   [24..27] physicalWidthMm   u32
//   [28..31] physicalHeightMm  u32
//   [32..35] nameLen           u32
//   [36..36+nameLen]            name  bytes (no NUL terminator)
//   [...]   makeLen u32 + makeLen bytes
//   [...]   modelLen u32 + modelLen bytes
//   [...]   edidIdLen u32 + edidIdLen bytes
//
// Strings cap at 63 bytes each (the source buffers are 64 bytes
// NUL-terminated). Variable-length so the on-wire size is exactly
// what's needed, no padding.
struct OutputDescriptorPayload {
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
    std::string edidId;

    // Compute the encoded byte length WITHOUT allocating.
    size_t encodedSize() const {
        return 8 * 4
             + 4 + name.size()
             + 4 + make.size()
             + 4 + model.size()
             + 4 + edidId.size();
    }

    void encode(uint8_t* out) const {
        putU32LE(out + 0,  outputId);
        putU32LE(out + 4,  width);
        putU32LE(out + 8,  height);
        putU32LE(out + 12, refreshMhz);
        putU32LE(out + 16, scale);
        putU32LE(out + 20, transform);
        putU32LE(out + 24, physicalWidthMm);
        putU32LE(out + 28, physicalHeightMm);
        size_t off = 32;
        for (const std::string* s : { &name, &make, &model, &edidId }) {
            putU32LE(out + off, static_cast<uint32_t>(s->size()));
            off += 4;
            std::memcpy(out + off, s->data(), s->size());
            off += s->size();
        }
    }

    // Decode from a payload of `len` bytes. Returns true on success;
    // returns false (output untouched) on truncated / malformed input.
    static bool decode(const uint8_t* p, size_t len, OutputDescriptorPayload& out) {
        if (len < 8 * 4) return false;
        out.outputId         = getU32LE(p + 0);
        out.width            = getU32LE(p + 4);
        out.height           = getU32LE(p + 8);
        out.refreshMhz       = getU32LE(p + 12);
        out.scale            = getU32LE(p + 16);
        out.transform        = getU32LE(p + 20);
        out.physicalWidthMm  = getU32LE(p + 24);
        out.physicalHeightMm = getU32LE(p + 28);
        size_t off = 32;
        std::string* fields[] = { &out.name, &out.make, &out.model, &out.edidId };
        for (std::string* s : fields) {
            if (off + 4 > len) return false;
            const uint32_t slen = getU32LE(p + off);
            off += 4;
            if (off + slen > len) return false;
            s->assign(reinterpret_cast<const char*>(p + off), slen);
            off += slen;
        }
        return off == len;
    }
};

// One mode record carried in OutputModesPayload. Mirrors the subset of
// drmModeModeInfo wlr-output-management exposes per zwlr_output_mode_v1.
struct ModeRecord {
    uint32_t width;       // hdisplay (device pixels)
    uint32_t height;      // vdisplay
    uint32_t refreshMhz;  // Hz * 1000
    uint32_t flags;       // bit 0 = preferred; remaining bits reserved (zero).
    static constexpr size_t kSize = 4 * 4;  // 16
};
static_assert(ModeRecord::kSize == 16,
              "ModeRecord size mismatch with hand-counted layout");

// Flag bits for ModeRecord::flags.
inline constexpr uint32_t kModeFlagPreferred = 1u << 0;

// OutputModesPayload (gpu -> core; FrameKind::OutputModes): the full
// advertised mode list for one output. Layout:
//   [0..3]   outputId           u32
//   [4..7]   modeCount          u32   (cap kMaxModesPerOutput = 64)
//   [8..]    modes[modeCount]   ModeRecord (16 bytes each)
inline constexpr uint32_t kMaxModesPerOutput = 64;
struct OutputModesPayload {
    uint32_t outputId = 0;
    std::vector<ModeRecord> modes;
    size_t encodedSize() const {
        return 8 + modes.size() * ModeRecord::kSize;
    }
    void encode(uint8_t* out) const {
        putU32LE(out + 0, outputId);
        putU32LE(out + 4, static_cast<uint32_t>(modes.size()));
        size_t off = 8;
        for (const ModeRecord& m : modes) {
            putU32LE(out + off + 0,  m.width);
            putU32LE(out + off + 4,  m.height);
            putU32LE(out + off + 8,  m.refreshMhz);
            putU32LE(out + off + 12, m.flags);
            off += ModeRecord::kSize;
        }
    }
    static bool decode(const uint8_t* p, size_t len, OutputModesPayload& out) {
        if (len < 8) return false;
        out.outputId = getU32LE(p + 0);
        const uint32_t count = getU32LE(p + 4);
        if (count > kMaxModesPerOutput) return false;
        if (len != 8 + count * ModeRecord::kSize) return false;
        out.modes.clear();
        out.modes.reserve(count);
        size_t off = 8;
        for (uint32_t i = 0; i < count; ++i) {
            ModeRecord r{};
            r.width      = getU32LE(p + off + 0);
            r.height     = getU32LE(p + off + 4);
            r.refreshMhz = getU32LE(p + off + 8);
            r.flags      = getU32LE(p + off + 12);
            out.modes.push_back(r);
            off += ModeRecord::kSize;
        }
        return true;
    }
};

// OutputRemovedPayload (gpu -> core; FrameKind::OutputRemoved):
// just the outputId. Symmetric pair to OutputAdded.
struct OutputRemovedPayload {
    uint32_t outputId;
    static constexpr size_t kSize = 4;
    void encode(uint8_t* out) const { putU32LE(out, outputId); }
    static OutputRemovedPayload decode(const uint8_t* p) {
        return { getU32LE(p) };
    }
};
static_assert(OutputRemovedPayload::kSize == 4,
              "OutputRemovedPayload size mismatch with hand-counted layout");

// ReleaseClientTexPayload (core -> gpu; FrameKind::ReleaseClientTex):
// release a JS-compositor dmabuf import. FIFO-ordered with the
// per-frame BeginAccess/EndAccess brackets for this handle (also on
// wire), so the GPU's wire reader is guaranteed to have decoded every
// in-flight bracket before the release runs. No wireSerial workaround.
struct ReleaseClientTexPayload {
    WireHandle texture;
    static constexpr size_t kSize = 8;
    void encode(uint8_t* out) const {
        putU32LE(out + 0, texture.id);
        putU32LE(out + 4, texture.generation);
    }
    static ReleaseClientTexPayload decode(const uint8_t* p) {
        return { { getU32LE(p + 0), getU32LE(p + 4) } };
    }
};
static_assert(ReleaseClientTexPayload::kSize == 8,
              "ReleaseClientTexPayload size mismatch with hand-counted layout");

}  // namespace overdraw::ipc

#endif  // OVERDRAW_IPC_SIDE_CHANNEL_H_
