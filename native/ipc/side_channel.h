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
    FrameMark    = 'F',  // core -> gpu : first frame submitted
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

    uint32_t format = 0;       // SurfaceReady: WGPUTextureFormat
    uint32_t presentMode = 0;  // SurfaceReady: WGPUPresentMode
    uint32_t alphaMode = 0;    // SurfaceReady: WGPUCompositeAlphaMode
    uint32_t width = 0;        // HelloReply, SurfaceReady
    uint32_t height = 0;       // HelloReply, SurfaceReady

    uint32_t protocolVersion = 0;  // Hello/HelloReply
};

constexpr uint32_t kProtocolVersion = 1;

}  // namespace overdraw::ipc

#endif  // OVERDRAW_IPC_SIDE_CHANNEL_H_
