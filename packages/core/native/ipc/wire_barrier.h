// Cross-channel ordering barrier for the side channel (ctrl) <-> wire pair.
//
// PROBLEM. Dawn wire object handles are {id, generation} and ids are RECYCLED:
// after ReclaimTextureReservation emits an UnregisterObjectCmd on the wire, the
// next ReserveTexture reuses the id at generation+1. A texture is *reserved* on
// the wire but *injected/imported/released* over the side channel (ctrl). For an
// inject at a recycled id to succeed, the wire server must already have applied
// the prior UnregisterObjectCmd and the new ReserveTexture; if the ctrl op runs
// first, it targets a stale/occupied handle and fails.
//
// SOLUTION. The sender samples its wire FdSerializer::bytesQueued() AFTER the
// flush that committed the reserve, and tags the ctrl message with that serial.
// The receiver compares its FrameReader::bytesConsumed() against the serial; if
// the wire reader has not caught up, the ctrl op is held until it does.
//
// THIS CLASS. One WireBarrier per WIRE READER (one for the core wire reader; one
// per plugin connection). It is the single place ctrl ops gate on wire progress:
//
//   barrier.after(msg.wireSerial, [=]{ runOp(msg, fd); }, reader.bytesConsumed());
//   ...
//   // when the reader advances (after wire pump):
//   barrier.drain(reader.bytesConsumed());
//
// If the reader is already past `serial`, after() runs the action SYNCHRONOUSLY
// (the common case: no deferral). Otherwise it FIFO-queues it. cancel(pred)
// drops matching deferred entries (e.g. a surface destroyed before its deferred
// op fires; the spec for the old pendingProducerEnds did this by surfaceBufId).
// drainAll() runs every still-pending action (used at shutdown after the action
// owns its fd, so the action can close it as part of running -- not for the
// case where the wire never caught up; that case calls takePending()).
//
// FD OWNERSHIP. Actions are std::function<void()>; the caller owns whatever
// resources the action captures. For an action that owns an fd, the caller MUST
// guarantee the fd is closed even if the action never runs: either run it via
// drainAll() (so the action itself closes it on the failure branch), or call
// takePending() at shutdown and close manually. WireBarrier never closes fds.
//
// THREADING. Not thread-safe. All call sites in this codebase run on the GPU
// process's single event-loop thread.

#ifndef OVERDRAW_IPC_WIRE_BARRIER_H_
#define OVERDRAW_IPC_WIRE_BARRIER_H_

#include <cstdint>
#include <cstddef>
#include <functional>
#include <utility>
#include <vector>

namespace overdraw::ipc {

class WireBarrier {
  public:
    // An opaque per-action tag, used by cancel(). Zero means "untagged".
    using Tag = uint64_t;

    WireBarrier() = default;
    WireBarrier(const WireBarrier&) = delete;
    WireBarrier& operator=(const WireBarrier&) = delete;

    // Run `action` once the reader has consumed >= `serial`. If `consumedNow` is
    // already >= `serial`, runs immediately (synchronously, inside this call).
    // Otherwise FIFO-queues it with the given tag (0 = untagged).
    void after(uint64_t serial, std::function<void()> action,
               uint64_t consumedNow, Tag tag = 0) {
        if (consumedNow >= serial) { action(); return; }
        pending_.push_back({serial, tag, std::move(action)});
    }

    // The reader advanced to `consumedNow`. Run every now-satisfied deferred
    // action in FIFO order. Re-checks after each run (an action may itself
    // queue new actions; new ones go on the tail and are visited on the next
    // pass).
    void drain(uint64_t consumedNow) {
        // Single-pass FIFO: walk from the front, run satisfied actions, erase.
        // Actions queued by an action go on the tail and are visited next loop.
        while (!pending_.empty() && pending_.front().serial <= consumedNow) {
            auto act = std::move(pending_.front().action);
            pending_.erase(pending_.begin());
            act();
        }
    }

    // Drop deferred actions whose tag matches `pred`. Returns the number dropped.
    // Used when a resource is destroyed before its deferred op fired: the op may
    // reference state about to be freed, and its wire serial may never arrive.
    size_t cancel(const std::function<bool(Tag)>& pred) {
        size_t n = 0;
        for (size_t i = 0; i < pending_.size();) {
            if (pred(pending_[i].tag)) {
                pending_.erase(pending_.begin() + static_cast<long>(i));
                ++n;
            } else {
                ++i;
            }
        }
        return n;
    }

    // Run every still-pending action regardless of serial (shutdown sweep when
    // each action is responsible for closing whatever it owns). After this the
    // barrier is empty.
    void drainAll() {
        while (!pending_.empty()) {
            auto act = std::move(pending_.front().action);
            pending_.erase(pending_.begin());
            act();
        }
    }

    // Take ownership of every still-pending entry, leaving the barrier empty.
    // Used at shutdown when the caller wants to inspect tags (e.g. to release a
    // captured fd it tracks externally) before discarding the actions.
    struct Entry { uint64_t serial; Tag tag; std::function<void()> action; };
    std::vector<Entry> takePending() {
        std::vector<Entry> out;
        out.swap(pending_);
        return out;
    }

    size_t pendingCount() const { return pending_.size(); }
    bool empty() const { return pending_.empty(); }

  private:
    std::vector<Entry> pending_;
};

}  // namespace overdraw::ipc

#endif  // OVERDRAW_IPC_WIRE_BARRIER_H_
