#include "wire_link.h"

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
    delete client_;
    delete reader_;
    delete serializer_;
}

bool WireLink::drainInbound() {
    bool alive = reader_->readAvailable();  // false => peer closed
    std::vector<uint8_t> f;
    while (reader_->nextFrame(f))
        client_->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
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
