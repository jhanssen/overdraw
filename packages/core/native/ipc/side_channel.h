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
    ImportClientTex = 'M',  // Bridge tag only: the import request rides the WIRE
                            //   (FrameKind::ImportClientTex); the GPU process
                            //   synthesizes a Message with this tag to reuse the
                            //   shared import path. Never sent on the ctrl socket.
                            //   The reply rides the wire too
                            //   (FrameKind::ClientTexImported); its retired ctrl
                            //   letter 'm' must not be reused.
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
    // (Producer*) and 'V'/'k'/'v' (Consumer*) for the per-frame
    // brackets. The cross-device fence dance (runSurfaceBegin/
    // runSurfaceEnd in the GPU process) is driven by the wire frames.
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
    // ScanoutReserve / ScanoutReady (the scanout-ring reservation handshake)
    // ride the WIRE socket as FrameKind::ScanoutReserve / ScanoutReady
    // (transport.h) so followup ProducerBegin frames are FIFO-ordered after
    // the InjectTexture work. Retired ctrl letters (do not reuse): 'Z'
    // ScanoutReserve, 'y' ScanoutReady.
    // ScanoutPresent (the per-frame flip request) rides the WIRE socket as
    // FrameKind::ScanoutPresent (transport.h). The wire-FIFO ordering is
    // load-bearing: the flip must land AFTER the slot's render submit and
    // producer EndAccess (whose exported sync_file becomes the KMS commit's
    // IN_FENCE_FD). Retired ctrl letter (do not reuse): 'z'.
    // See architecture.md "Why wire, not ctrl".
    ScanoutFlipComplete = 'Y',  // gpu -> core: a page-flip retired a slot. The
                                //   `surfaceBufId` field carries the slot index
                                //   that just exited SCANOUT (now FREE). The core
                                //   advances its slot state machine off this.
                                //   Also doubles as the KMS frame-complete signal
                                //   for the wake/render state machine.
                                //   Safe on ctrl (no wire dependency): it only
                                //   touches the core's own slot bookkeeping and
                                //   names a slot the core itself created; the
                                //   render it triggers writes NEW wire frames,
                                //   ordered after everything already queued.
    FrameComplete = 'f',  // gpu -> core: nested mode's host wl_surface.frame
                          //   callback fired (the host compositor is ready for
                          //   the next frame). The KMS path uses
                          //   ScanoutFlipComplete for the same purpose; the two
                          //   exist as separate tags because KMS carries the
                          //   retired slot idx in its payload and nested has
                          //   no equivalent. Safe on ctrl for the same reason:
                          //   a pure wakeup, referencing no wire-introduced
                          //   resource.
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
    // ScanoutRebuild and SwitchMode ride the WIRE socket as FrameKind
    // variants (transport.h), not Tag-on-ctrl. The wire-FIFO ordering is
    // load-bearing: a SwitchMode arriving on ctrl while ProducerBegin
    // frames for the same output are still queued on wire would tear down
    // the surfaceBufs the GPU is still in the middle of accessing. See
    // multi-output-design §10.5 and architecture.md "Why wire, not ctrl".
    // The 'B' tag letter is intentionally not reused.
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

    // ScanoutFlipComplete: the ring slot index that just exited SCANOUT
    // (now FREE); the core advances its slot state machine off it.
    uint32_t surfaceBufId = 0;

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
    // workspace plugin keys its `preferredOutputs` list on this
    // when present, falling back to `outputName` -- see multi-output-design
    // §3 ("Output identity model"). Fixed 64-byte NUL-terminated buffer;
    // 64 covers `mfr3+u16+u32` with headroom to spare.
    char outputEdidId[64] = {};

    // Routing id of the output this message concerns, for every output-scoped
    // tag (OutputDescriptor, ScanoutFlipComplete). The core keys state.outputs
    // by it and the GPU process routes per-output scanout state by it.
    uint32_t outputId = 0;

    // OutputDescriptor: total number of outputs the GPU process is driving. Set
    // on every OutputDescriptor send so the core learns how many scanout rings
    // to reserve before the first descriptor's reply path proceeds. 0 means
    // unset (the core falls back to a single output).
    uint32_t outputCount = 0;

    // ScanoutFlipComplete / FrameComplete: presentation-time data for the
    // just-retired frame, used to drive wp_presentation. tv_sec is the
    // monotonic-clock seconds part of the page-flip / host frame timestamp;
    // tv_nsec is the nanoseconds part within the second. seq is the
    // hardware vsync sequence number on KMS (kernel-supplied); the nested
    // path leaves it 0 (host wl_surface.frame has no equivalent). All
    // three are 0 when the timing data was not available (legacy callers
    // / GPU process versions that did not populate them).
    uint64_t tvSec  = 0;
    uint32_t tvNsec = 0;
    uint32_t seq    = 0;
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
// i32 variants: bitcast through u32 so negative values round-trip.
inline void putI32LE(uint8_t* p, int32_t v) {
    putU32LE(p, static_cast<uint32_t>(v));
}
inline int32_t getI32LE(const uint8_t* p) {
    return static_cast<int32_t>(getU32LE(p));
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
// surfaceBufIds. Putting them on ctrl is unsafe: wire and ctrl are
// independent fds, and on a hotplug add the core writes ProducerBegin
// on wire moments after ScanoutReserve on ctrl -- the GPU process can
// drain wire first and abort on an unregistered surfaceBufId. See
// multi-output-design §4.

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

// ScanoutPresent payload (core -> gpu, FrameKind::ScanoutPresent): flip
// the scanout slot holding `surfaceBufId` on `outputId`. No fence rides
// with it: the GPU process captured the render-done sync_file from the
// slot's producer EndAccess (FIFO-earlier on the same wire) and attaches
// it as the KMS atomic commit's IN_FENCE_FD; the nested backend relies
// on the dmabuf's implicit-sync reservation instead.
struct ScanoutPresentPayload {
    uint32_t outputId;
    uint32_t surfaceBufId;
    static constexpr size_t kSize = 2 * 4;  // 8
    void encode(uint8_t* out) const {
        putU32LE(out + 0, outputId);
        putU32LE(out + 4, surfaceBufId);
    }
    static ScanoutPresentPayload decode(const uint8_t* p) {
        ScanoutPresentPayload r{};
        r.outputId     = getU32LE(p + 0);
        r.surfaceBufId = getU32LE(p + 4);
        return r;
    }
};
static_assert(ScanoutPresentPayload::kSize == 8,
              "ScanoutPresentPayload size mismatch with hand-counted layout");

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

// RegisterShmPoolPayload (core -> gpu; FrameKind::RegisterShmPool):
// the client created a wl_shm pool. The memfd rides as exactly ONE
// SCM_RIGHTS fd on the sendmsg carrying this frame. The GPU process
// mmap's the fd and stashes (poolId -> {ptr, size, fd}).
struct RegisterShmPoolPayload {
    uint32_t poolId;
    uint32_t _pad;   // explicit align: size is u64, layout is u32/u32/u64
    uint64_t size;
    static constexpr size_t kSize = 16;
    void encode(uint8_t* out) const {
        putU32LE(out + 0, poolId);
        putU32LE(out + 4, 0);
        putU64LE(out + 8, size);
    }
    static RegisterShmPoolPayload decode(const uint8_t* p) {
        RegisterShmPoolPayload r{};
        r.poolId = getU32LE(p + 0);
        r.size   = getU64LE(p + 8);
        return r;
    }
};
static_assert(RegisterShmPoolPayload::kSize == 16,
              "RegisterShmPoolPayload size mismatch with hand-counted layout");

// UnregisterShmPoolPayload (core -> gpu; FrameKind::UnregisterShmPool):
// the wl_shm pool was destroyed (or its last buffer-ref dropped). The
// GPU process munmaps + closes the cached fd.
struct UnregisterShmPoolPayload {
    uint32_t poolId;
    static constexpr size_t kSize = 4;
    void encode(uint8_t* out) const {
        putU32LE(out + 0, poolId);
    }
    static UnregisterShmPoolPayload decode(const uint8_t* p) {
        return { getU32LE(p + 0) };
    }
};
static_assert(UnregisterShmPoolPayload::kSize == 4,
              "UnregisterShmPoolPayload size mismatch with hand-counted layout");

// ResizeShmPoolPayload (core -> gpu; FrameKind::ResizeShmPool): the client
// grew the pool via wl_shm_pool.resize (pools only grow). The GPU process
// mremap's its cached mapping to the new size.
struct ResizeShmPoolPayload {
    uint32_t poolId;
    uint32_t _pad;   // explicit align: size is u64, layout is u32/u32/u64
    uint64_t size;
    static constexpr size_t kSize = 16;
    void encode(uint8_t* out) const {
        putU32LE(out + 0, poolId);
        putU32LE(out + 4, 0);
        putU64LE(out + 8, size);
    }
    static ResizeShmPoolPayload decode(const uint8_t* p) {
        ResizeShmPoolPayload r{};
        r.poolId = getU32LE(p + 0);
        r.size   = getU64LE(p + 8);
        return r;
    }
};
static_assert(ResizeShmPoolPayload::kSize == 16,
              "ResizeShmPoolPayload size mismatch with hand-counted layout");

// AllocShmTexPayload (core -> gpu; FrameKind::AllocShmTex):
// the core wire-client has ReserveTexture'd a wire handle for a
// sampleable BGRA8 texture sized to the current shm buffer. The GPU
// process creates a native wgpu::Texture on the GPU device matching
// `texture.deviceHandle` and calls WireServer::InjectTexture to fill
// the reservation, then stashes (surfaceId -> wgpu::Texture) so
// subsequent ShmUpload frames can resolve it.
struct AllocShmTexPayload {
    uint32_t surfaceId;
    uint32_t width;
    uint32_t height;
    uint32_t _pad;
    WireHandle texture;
    WireHandle device;
    static constexpr size_t kSize = 4 * 4 + 2 * 8;  // 32
    void encode(uint8_t* out) const {
        putU32LE(out + 0,  surfaceId);
        putU32LE(out + 4,  width);
        putU32LE(out + 8,  height);
        putU32LE(out + 12, 0);
        putU32LE(out + 16, texture.id);
        putU32LE(out + 20, texture.generation);
        putU32LE(out + 24, device.id);
        putU32LE(out + 28, device.generation);
    }
    static AllocShmTexPayload decode(const uint8_t* p) {
        AllocShmTexPayload r{};
        r.surfaceId          = getU32LE(p + 0);
        r.width              = getU32LE(p + 4);
        r.height             = getU32LE(p + 8);
        r.texture.id         = getU32LE(p + 16);
        r.texture.generation = getU32LE(p + 20);
        r.device.id          = getU32LE(p + 24);
        r.device.generation  = getU32LE(p + 28);
        return r;
    }
};
static_assert(AllocShmTexPayload::kSize == 32,
              "AllocShmTexPayload size mismatch with hand-counted layout");

// ShmUploadPayload (core -> gpu; FrameKind::ShmUpload):
// upload a committed shm region into a previously-AllocShmTex'd
// texture. Variable-length (damageRects suffix). Empty damageRects
// (count = 0) means "full buffer upload" -- the GPU process treats
// it as one rect covering (0,0)-(width,height).
//
// The GPU process resolves surfaceId to its native wgpu::Texture,
// memcpys the damaged bytes from the mmap'd pool into a staging
// VkBuffer, runs copyBufferToTexture, submits, and replies with
// ShmUploaded(uploadSeq). The core defers wl_buffer.release until
// that reply (a copy-then-release model).
struct ShmUploadPayload {
    uint32_t surfaceId;
    uint32_t uploadSeq;
    uint32_t poolId;
    uint32_t _pad;
    uint64_t offset;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    struct DamageRect {
        int32_t x, y;
        uint32_t w, h;
        static constexpr size_t kSize = 16;
    };
    std::vector<DamageRect> damage;
    // Fixed-field header (surfaceId..stride) ends at offset 36; the
    // damageCount u32 follows at offset 36 and damage rects start at 40.
    // kHeaderSize is "fixed header + count field"; encodedSize adds the
    // variable-length rect tail.
    static constexpr size_t kHeaderSize = 40;
    size_t encodedSize() const {
        return kHeaderSize + damage.size() * DamageRect::kSize;
    }
    void encode(uint8_t* out) const {
        putU32LE(out + 0,  surfaceId);
        putU32LE(out + 4,  uploadSeq);
        putU32LE(out + 8,  poolId);
        putU32LE(out + 12, 0);
        putU64LE(out + 16, offset);
        putU32LE(out + 24, width);
        putU32LE(out + 28, height);
        putU32LE(out + 32, stride);
        putU32LE(out + 36, static_cast<uint32_t>(damage.size()));
        size_t off = 40;
        for (const DamageRect& r : damage) {
            putI32LE(out + off + 0,  r.x);
            putI32LE(out + off + 4,  r.y);
            putU32LE(out + off + 8,  r.w);
            putU32LE(out + off + 12, r.h);
            off += DamageRect::kSize;
        }
    }
    static bool decode(const uint8_t* p, size_t len, ShmUploadPayload& out) {
        if (len < kHeaderSize) return false;
        out.surfaceId = getU32LE(p + 0);
        out.uploadSeq = getU32LE(p + 4);
        out.poolId    = getU32LE(p + 8);
        out.offset    = getU64LE(p + 16);
        out.width     = getU32LE(p + 24);
        out.height    = getU32LE(p + 28);
        out.stride    = getU32LE(p + 32);
        const uint32_t count = getU32LE(p + 36);
        if (len != kHeaderSize + count * DamageRect::kSize) return false;
        out.damage.clear();
        out.damage.reserve(count);
        size_t off = kHeaderSize;
        for (uint32_t i = 0; i < count; ++i) {
            DamageRect r{};
            r.x = getI32LE(p + off + 0);
            r.y = getI32LE(p + off + 4);
            r.w = getU32LE(p + off + 8);
            r.h = getU32LE(p + off + 12);
            out.damage.push_back(r);
            off += DamageRect::kSize;
        }
        return true;
    }
};

// ShmUploadedPayload (gpu -> core; FrameKind::ShmUploaded):
// the matching ShmUpload's vkCmdCopyBufferToImage has been submitted
// (the source bytes have been memcpy'd into the staging VkBuffer).
// The core uses uploadSeq to find the deferred wl_buffer.release and
// sends it now -- the client's shm region is safe to reuse.
struct ShmUploadedPayload {
    uint32_t uploadSeq;
    static constexpr size_t kSize = 4;
    void encode(uint8_t* out) const {
        putU32LE(out + 0, uploadSeq);
    }
    static ShmUploadedPayload decode(const uint8_t* p) {
        return { getU32LE(p + 0) };
    }
};
static_assert(ShmUploadedPayload::kSize == 4,
              "ShmUploadedPayload size mismatch with hand-counted layout");

}  // namespace overdraw::ipc

#endif  // OVERDRAW_IPC_SIDE_CHANNEL_H_
