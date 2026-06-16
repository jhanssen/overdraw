#include "wire_link.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

#include <unistd.h>

#include "dawn/dawn_proc.h"

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
    if (client_) client_->Disconnect();
    // If a JS WebGPU binding (dawn.node) holds wgpu objects routed through this
    // client, their finalizers run at process exit and call into the client.
    // Deleting it here would be a use-after-free, so leak it after Disconnect
    // (the process is terminating). The serializer must also outlive it (the
    // client may flush on teardown), so leak that too in the shared case.
    if (sharedWithExternal_) {
        delete reader_;
        return;
    }
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
            std::fprintf(stderr,
                "[ipc] WireLink::drainInbound: non-Dawn frame kind=%u with no handler\n",
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

bool WireLink::pumpUntilTimeout(const std::function<bool()>& done, int maxMs) {
    int iters = (maxMs * 1000) / 200;
    for (int i = 0; i < iters; ++i) {
        if (done()) return true;
        serializer_->pumpOut();
        drainInbound();
        ::usleep(200);
    }
    return done();
}

bool WireLink::sendAndWait(const ipc::Message& req, ipc::Tag replyTag, ipc::Message& reply) {
    ipc::sendMessage(ctrlFd_, req);
    for (int i = 0; i < 1000000; ++i) {
        serializer_->pumpOut();
        drainInbound();
        ipc::Message m{};
        if (ipc::recvMessageNB(ctrlFd_, m) && m.tag == replyTag) { reply = m; return true; }
        ::usleep(200);
    }
    return false;
}

}  // namespace overdraw::core
