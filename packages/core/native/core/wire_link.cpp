#include "wire_link.h"

#include <cstdlib>
#include <vector>

#include <unistd.h>

#include "dawn/dawn_proc.h"
#include "log/log.h"

namespace overdraw::core {

WireLink::WireLink(int wireFd, int ctrlFd) : wireFd_(wireFd), ctrlFd_(ctrlFd) {
    dawnProcSetProcs(&dawn::wire::client::GetProcs());
    serializer_ = new ipc::FdSerializer(wireFd_);
    reader_ = new ipc::FrameReader(wireFd_);
    dawn::wire::WireClientDescriptor wcd{};
    wcd.serializer = serializer_;
    client_ = new dawn::wire::WireClient(wcd);
}

WireLink::~WireLink() {
    // If a JS WebGPU binding (dawn.node) holds wgpu objects routed through
    // this client, two hazards apply at teardown:
    //   - Disconnect() completes every in-flight tracked event, firing the
    //     binding's callbacks into a JS env that is mid-teardown (observed
    //     abort: Client::Disconnect -> TrackedEvent::Complete ->
    //     Napi::CallbackScope -> node fatal error). Skip it.
    //   - The binding's finalizers run at process exit and call into the
    //     client; deleting it here would be a use-after-free. Leak the
    //     client, and the serializer it may still flush through (the
    //     process is terminating).
    if (sharedWithExternal_) {
        delete reader_;
        return;
    }
    if (client_) client_->Disconnect();
    delete client_;
    delete reader_;
    delete serializer_;
}

bool WireLink::drainInbound() {
    bool alive = reader_->readAvailable();  // false => peer closed
    ipc::FrameKind kind;
    std::vector<uint8_t> f;
    while (reader_->nextFrame(kind, f)) {
        if (kind == ipc::FrameKind::WireBytes) {
            client_->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
        } else if (inboundHandler_) {
            inboundHandler_(kind, f);
        } else {
            LOG_CRIT(Ipc, "WireLink::drainInbound: non-Dawn frame kind={} with no handler",
                     static_cast<unsigned>(kind));
            std::abort();
        }
    }
    if (instance_) wgpuInstanceProcessEvents(instance_);
    return alive;
}

bool WireLink::pumpUntil(const std::function<bool()>& done) {
    for (int i = 0; i < 1000000; ++i) {
        if (done()) return true;
        serializer_->pumpOut();
        drainInbound();
        ::usleep(200);
    }
    return done();
}

}  // namespace overdraw::core
