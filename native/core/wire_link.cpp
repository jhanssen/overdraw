#include "wire_link.h"

#include <vector>

#include <unistd.h>

#include "dawn/dawn_proc.h"

namespace overdraw::core {

WireLink::WireLink(int wireFd, int ctrlFd) : wireFd_(wireFd), ctrlFd_(ctrlFd) {
    dawnProcSetProcs(&dawn::wire::client::GetProcs());
    serializer_ = new ipc::FdSerializer(wireFd_);
    dawn::wire::WireClientDescriptor wcd{};
    wcd.serializer = serializer_;
    client_ = new dawn::wire::WireClient(wcd);
}

WireLink::~WireLink() {
    if (client_) client_->Disconnect();
    delete client_;
    delete serializer_;
}

void WireLink::drainInbound() {
    std::vector<uint8_t> f;
    for (int i = 0; i < 64 && ipc::readWireFrame(wireFd_, f); ++i)
        client_->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
    if (instance_) wgpuInstanceProcessEvents(instance_);
}

bool WireLink::pumpUntil(const std::function<bool()>& done) {
    std::vector<uint8_t> f;
    for (int i = 0; i < 1000000; ++i) {
        if (done()) return true;
        serializer_->Flush();
        if (ipc::readWireFrame(wireFd_, f))
            client_->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
        if (instance_) wgpuInstanceProcessEvents(instance_);
        ::usleep(200);
    }
    return done();
}

bool WireLink::pumpUntilTimeout(const std::function<bool()>& done, int maxMs) {
    std::vector<uint8_t> f;
    int iters = (maxMs * 1000) / 200;
    for (int i = 0; i < iters; ++i) {
        if (done()) return true;
        serializer_->Flush();
        if (ipc::readWireFrame(wireFd_, f))
            client_->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
        if (instance_) wgpuInstanceProcessEvents(instance_);
        ::usleep(200);
    }
    return done();
}

bool WireLink::sendAndWait(const ipc::Message& req, ipc::Tag replyTag, ipc::Message& reply) {
    ipc::sendMessage(ctrlFd_, req);
    std::vector<uint8_t> f;
    for (int i = 0; i < 1000000; ++i) {
        serializer_->Flush();
        if (ipc::readWireFrame(wireFd_, f))
            client_->HandleCommands(reinterpret_cast<const char*>(f.data()), f.size());
        if (instance_) wgpuInstanceProcessEvents(instance_);
        ipc::Message m{};
        if (ipc::recvMessageNB(ctrlFd_, m) && m.tag == replyTag) { reply = m; return true; }
        ::usleep(200);
    }
    return false;
}

}  // namespace overdraw::core
