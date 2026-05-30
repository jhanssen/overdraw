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
    ReserveTex   = 'R',  // core -> gpu : reserved texture+device handle + size/format
    TexInjected  = 't',  // gpu  -> core: dmabuf imported + texture injected (+ modifier)
    BeginAccess  = 'B',  // core -> gpu : begin access on the STM (before wire render)
    BeginDone    = 'b',  // gpu  -> core: BeginAccess applied + flushed
    EndAccess    = 'E',  // core -> gpu : end access on the STM (after wire render)
    EndDone      = 'e',  // gpu  -> core: EndAccess applied; sync-fd exported (fenceCount)
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
};

constexpr uint32_t kProtocolVersion = 1;

}  // namespace overdraw::ipc

#endif  // OVERDRAW_IPC_SIDE_CHANNEL_H_
