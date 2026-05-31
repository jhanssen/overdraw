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
    ReserveTex   = 'R',  // core -> gpu : reserved texture+device handle + size/format
    TexInjected  = 't',  // gpu  -> core: dmabuf imported + texture injected (+ modifier)
    ImportClientTex = 'M',  // core -> gpu : import a CLIENT dmabuf fd (SCM_RIGHTS) into
                            //              a texture at the reserved handle
    ClientTexImported = 'm',  // gpu -> core: client dmabuf imported + injected (or failed)
    ReleaseClientTex = 'r',   // core -> gpu : release a client-dmabuf import (texture =
                              //              {id,generation}); GPU drops the STM + fd if
                              //              the entry's generation still matches.
    BeginAccess  = 'B',  // core -> gpu : begin access on the STM (before wire render)
    BeginDone    = 'b',  // gpu  -> core: BeginAccess applied + flushed
    EndAccess    = 'E',  // core -> gpu : end access on the STM (after wire render)
    EndDone      = 'e',  // gpu  -> core: EndAccess applied; sync-fd exported (fenceCount)
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
    // Per-frame producer/consumer fence dance on a surface buffer (C-M4 step 3),
    // reusing the C-M1 cross-device fence. Both STMs live in the GPU process (the
    // two imports of one dmabuf), so the sync-fds never cross a process boundary;
    // these messages just drive the access brackets in the right order on the GPU
    // timeline. `surfaceBufId` names the buffer. Each Begin has a *Done reply so
    // the core/plugin only proceeds once the bracket (and its fence wait) is in.
    ProducerBegin = 'G',  // core->gpu: producer BeginAccess (write). Waits the
                          //   previous consumer fence (don't clobber a buffer the
                          //   core is still reading).
    ProducerBeginDone = 'q',  // gpu->core: producer bracket open (plugin may render)
    ProducerEnd   = 'g',  // core->gpu: producer EndAccess (after plugin render).
                          //   GPU holds the produced sync-fd for the consumer wait.
    ConsumerBegin = 'V',  // core->gpu: consumer BeginAccess (read). Waits the
                          //   producer fence (producer-done-before-read).
    ConsumerBeginDone = 'k',  // gpu->core: consumer bracket open (core may sample)
    ConsumerEnd   = 'v',  // core->gpu: consumer EndAccess (after sampling). GPU
                          //   holds the produced sync-fd for the next ProducerBegin.
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
    WireHandle device;     // DeviceReady, SurfaceReady, ReserveTex
    WireHandle surface;    // DeviceReady, SurfaceReady
    WireHandle texture;    // ReserveTex, TexInjected

    uint32_t format = 0;       // SurfaceReady, ReserveTex: WGPUTextureFormat
    uint32_t presentMode = 0;  // SurfaceReady: WGPUPresentMode
    uint32_t alphaMode = 0;    // SurfaceReady: WGPUCompositeAlphaMode
    uint32_t width = 0;        // HelloReply, SurfaceReady, ReserveTex
    uint32_t height = 0;       // HelloReply, SurfaceReady, ReserveTex

    uint64_t modifier = 0;     // TexInjected: DRM modifier the dmabuf was allocated with

    uint32_t fenceCount = 0;   // EndDone: number of SharedFence sync-fds produced
    uint32_t initialized = 0;  // BeginAccess: 1 if texture contents are already valid
    int32_t  oldLayout = 0;    // BeginAccess: Vulkan image layout to begin from
    int32_t  endLayout = 0;    // EndDone: Vulkan image layout the texture ended in

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
    uint64_t wireSerial = 0;
};

constexpr uint32_t kProtocolVersion = 1;

}  // namespace overdraw::ipc

#endif  // OVERDRAW_IPC_SIDE_CHANNEL_H_
