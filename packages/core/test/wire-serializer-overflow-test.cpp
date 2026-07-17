// Regression test for FdSerializer::GetCmdSpace batch-overflow handling.
//
// Dawn's CommandSerializer contract (dawn/wire/Wire.h):
//   "GetCmdSpace will never be called with a value larger than what
//    GetMaximumAllocationSize returns. Return nullptr to indicate a fatal
//    error."
//
// Dawn auto-chunks large commands (writeTexture / writeBuffer > 4 MiB) into
// kMaxAllocation-sized sub-commands via ChunkedCommandSerializer and calls
// GetCmdSpace once per chunk. The serializer's job is to ABSORB those calls
// across batch boundaries; the 16 MiB batch buffer is just headroom between
// flushes, not a hard cap on cumulative output.
//
// This test issues many GetCmdSpace calls whose cumulative bytes far exceed
// kCapacity (16 MiB) without an explicit Flush in between, drains the socket
// on the read side, and verifies every byte made it through.
//
// Without the fix in transport.h (auto-flush inside GetCmdSpace), this test
// fails: GetCmdSpace returns nullptr after the 16th chunk, silently dropping
// every subsequent allocation. With the fix, all bytes round-trip.
//
// Exit 0 + "PASS" on success.

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <thread>
#include <vector>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <poll.h>

#include "transport.h"

using overdraw::ipc::FdSerializer;
using overdraw::ipc::FrameKind;
using overdraw::ipc::setNonBlocking;

namespace {

// kMaxAllocation in transport.h is 1 MiB; ChunkedCommandSerializer breaks
// large commands into <=1 MiB chunks. Use a chunk just under that to exercise
// the same shape Dawn emits. 1 MiB minus a 16-byte header sentinel is safe
// against any internal framing overhead the FdSerializer adds.
constexpr size_t kChunkBytes = (1u << 20) - 1024;

// Total bytes far in excess of kCapacity = 16 MiB. 64 MiB covers 4K HDR
// canvas territory + headroom.
constexpr size_t kTotalChunks = 64;

// Drain reader: read whatever is available from `fd`, validating the wire
// framing ([len: u32 LE][kind: u8][payload]) along the way. Concatenates
// payload bytes from kind=0 (Dawn wire bytes) frames into `out`. Stops when
// it has consumed `expected` payload bytes or the writer side closes.
bool drainAndCollect(int fd, size_t expected, std::vector<uint8_t>& out) {
    std::vector<uint8_t> raw;
    raw.reserve(expected + 256 * 1024);
    uint8_t buf[256 * 1024];
    while (out.size() < expected) {
        pollfd p{fd, POLLIN, 0};
        int pr = ::poll(&p, 1, 5000);
        if (pr <= 0) {
            std::fprintf(stderr, "drainAndCollect: poll timeout (got %zu / %zu bytes payload)\n",
                         out.size(), expected);
            return false;
        }
        ssize_t n = ::read(fd, buf, sizeof(buf));
        if (n == 0) {
            std::fprintf(stderr, "drainAndCollect: EOF (got %zu / %zu)\n",
                         out.size(), expected);
            return false;
        }
        if (n < 0) {
            if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue;
            std::perror("read");
            return false;
        }
        raw.insert(raw.end(), buf, buf + n);

        // Parse as many complete frames as we have. [len: u32 LE][kind: u8][payload].
        size_t off = 0;
        while (off + 5 <= raw.size()) {
            uint32_t len;
            std::memcpy(&len, raw.data() + off, 4);
            if (off + 4 + len > raw.size()) break;  // incomplete frame
            uint8_t kind = raw[off + 4];
            // payload length = len - 1 (len counts kind + payload).
            size_t payloadLen = len - 1;
            if (kind == static_cast<uint8_t>(FrameKind::WireBytes)) {
                out.insert(out.end(),
                           raw.begin() + static_cast<long>(off + 5),
                           raw.begin() + static_cast<long>(off + 5 + payloadLen));
            }
            off += 4 + len;
        }
        // Compact: discard parsed bytes.
        if (off > 0) raw.erase(raw.begin(), raw.begin() + static_cast<long>(off));
    }
    return true;
}

}  // namespace

int main() {
    int sv[2];
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) {
        std::perror("socketpair"); return 1;
    }
    if (!setNonBlocking(sv[0])) {
        std::fprintf(stderr, "setNonBlocking writer failed\n"); return 1;
    }
    // Reader stays blocking; poll() above gates it.

    FdSerializer ser(sv[0]);

    // Reader thread: drain bytes off sv[1] as the writer issues GetCmdSpace
    // calls. The serializer's internal Flush triggered by GetCmdSpace on
    // overflow will push bytes into out_; pumpOut writes what the kernel
    // accepts. The reader drains the socket so the writer doesn't wedge on
    // EAGAIN, allowing the test to verify the WHOLE round-trip.
    std::vector<uint8_t> received;
    const size_t expectedPayloadBytes = kChunkBytes * kTotalChunks;
    bool readerOk = false;
    std::thread reader([&] {
        readerOk = drainAndCollect(sv[1], expectedPayloadBytes, received);
    });

    // Issue many chunks. Each chunk is a distinct 1-byte-per-position pattern
    // so we can spot dropped / reordered / truncated bytes in the verification
    // step. The chunk index is in chunk[0..3] (LE u32) and the rest is filled
    // with (chunkIdx ^ (positionInChunk & 0xFF)).
    //
    // CRITICAL: do NOT call Flush() between chunks. This mirrors the actual
    // Dawn auto-chunk path: ChunkedCommandSerializer::SerializeChunkedCommand
    // emits all sub-chunks of one big command back-to-back via SerializeCommand
    // without an intervening Flush(). The serializer must absorb every
    // GetCmdSpace call across batch boundaries on its own. Calling Flush()
    // every N chunks here would let pending_ reset and mask the bug.
    bool allAllocsOk = true;
    for (size_t i = 0; i < kTotalChunks; ++i) {
        uint8_t* p = static_cast<uint8_t*>(ser.GetCmdSpace(kChunkBytes));
        if (!p) {
            std::fprintf(stderr, "GetCmdSpace returned nullptr at chunk %zu "
                                 "(this is the bug -- batch overflow not handled)\n", i);
            allAllocsOk = false;
            break;
        }
        uint32_t idx = static_cast<uint32_t>(i);
        std::memcpy(p, &idx, 4);
        for (size_t j = 4; j < kChunkBytes; ++j) {
            p[j] = static_cast<uint8_t>(idx ^ (j & 0xFF));
        }
        // Opportunistic drain on the writer side -- mirrors how the real
        // server calls pumpOut on EPOLLOUT. Doesn't touch pending_; just
        // moves out_ bytes into the socket so out_ doesn't grow unboundedly.
        (void)ser.pumpOut();
    }
    // Final flush to push the last sub-batch out as a frame.
    if (!ser.Flush()) {
        std::fprintf(stderr, "final Flush failed\n");
        allAllocsOk = false;
    }
    // Push the remaining buffered bytes into the socket. The reader thread
    // may lag far behind under load (e.g. a full parallel test-suite run), so
    // gate each pump on POLLOUT and bound only the time spent with NO socket
    // headroom -- a fixed pump count gives up mid-stream and strands the
    // reader, which then reports a bogus byte shortfall.
    int stalledMs = 0;
    while (ser.hasPendingOut() && stalledMs < 20000) {
        pollfd wp{sv[0], POLLOUT, 0};
        int pr = ::poll(&wp, 1, 100);
        if (pr < 0) {
            std::perror("poll(POLLOUT)");
            break;
        }
        if (pr == 0) { stalledMs += 100; continue; }
        stalledMs = 0;
        if (!ser.pumpOut()) {
            std::fprintf(stderr, "pumpOut failed while draining\n");
            break;
        }
    }

    reader.join();

    if (!allAllocsOk) {
        std::printf("FAIL: GetCmdSpace returned nullptr (regression: batch overflow not handled)\n");
        ::close(sv[0]); ::close(sv[1]);
        return 1;
    }
    if (!readerOk) {
        std::printf("FAIL: reader did not receive expected bytes\n");
        ::close(sv[0]); ::close(sv[1]);
        return 1;
    }
    if (received.size() != expectedPayloadBytes) {
        std::printf("FAIL: received %zu bytes, expected %zu\n",
                    received.size(), expectedPayloadBytes);
        ::close(sv[0]); ::close(sv[1]);
        return 1;
    }
    // Verify pattern: each kChunkBytes-sized region carries (idx, idx^j).
    // Note that the wire stream is concatenated payloads from N frames; the
    // payload order matches GetCmdSpace order, so the byte stream is exactly
    // [chunk 0 bytes][chunk 1 bytes]...
    for (size_t i = 0; i < kTotalChunks; ++i) {
        const uint8_t* p = received.data() + i * kChunkBytes;
        uint32_t idx;
        std::memcpy(&idx, p, 4);
        if (idx != i) {
            std::printf("FAIL: chunk %zu has idx=%u\n", i, idx);
            ::close(sv[0]); ::close(sv[1]);
            return 1;
        }
        for (size_t j = 4; j < kChunkBytes; ++j) {
            uint8_t want = static_cast<uint8_t>(i ^ (j & 0xFF));
            if (p[j] != want) {
                std::printf("FAIL: chunk %zu byte %zu got 0x%02x want 0x%02x\n",
                            i, j, p[j], want);
                ::close(sv[0]); ::close(sv[1]);
                return 1;
            }
        }
    }
    std::printf("PASS\n");
    ::close(sv[0]); ::close(sv[1]);
    return 0;
}
