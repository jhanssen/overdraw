// Log socket protocol (GPU process -> core, SOCK_SEQPACKET).
//
// One log record may span multiple datagrams. Each datagram begins with a
// fixed-size LogPacketHeader followed by up to kLogFragBytes of message bytes.
// Receiver concatenates fragments by (seq, fragIdx) and dispatches the assembled
// record when fragIdx == fragCount - 1.
//
// Same-sender datagrams on a SOCK_SEQPACKET unix socket arrive in order, so no
// out-of-order handling is required.

#ifndef OVERDRAW_LOG_LOG_WIRE_H_
#define OVERDRAW_LOG_LOG_WIRE_H_

#include <cstddef>
#include <cstdint>

namespace overdraw::log {

constexpr size_t kLogFragBytes = 480;  // payload bytes per datagram

struct LogPacketHeader {
    uint8_t  level;       // matches spdlog::level::level_enum (trace=0..off=6)
    uint8_t  area;        // matches overdraw::log::Area
    uint16_t fragCount;   // total fragments for this record
    uint16_t fragIdx;     // 0-based index of this fragment
    uint16_t _pad;        // align next u64
    uint32_t seq;         // monotonic per-sender record id
    uint32_t totalLen;    // total message bytes (sum of all fragments' fragLen)
    uint16_t fragLen;     // bytes used in this packet's payload buffer
    uint16_t _pad2;
    uint64_t monotonicNs; // sender's CLOCK_MONOTONIC at record emission
};

struct LogPacket {
    LogPacketHeader hdr;
    char payload[kLogFragBytes];
};

static_assert(sizeof(LogPacket) == sizeof(LogPacketHeader) + kLogFragBytes,
              "LogPacket must be packed header + payload");

}  // namespace overdraw::log

#endif  // OVERDRAW_LOG_LOG_WIRE_H_
