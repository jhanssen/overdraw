#include "shm.h"

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <sys/mman.h>
#include <unistd.h>

namespace overdraw::core {

ShmRegistry::~ShmRegistry() {
    for (auto& [id, p] : pools_) {
        if (p.base && p.base != MAP_FAILED) ::munmap(p.base, p.size);
        if (p.fd >= 0) ::close(p.fd);
    }
}

uint32_t ShmRegistry::createPool(int fd, size_t size) {
    if (fd < 0 || size == 0) return 0;
    void* base = ::mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (base == MAP_FAILED) {
        ::close(fd);
        return 0;
    }
    uint32_t id = nextId_++;
    pools_[id] = Pool{fd, base, size};
    return id;
}

bool ShmRegistry::resizePool(uint32_t poolId, size_t newSize) {
    auto it = pools_.find(poolId);
    if (it == pools_.end()) return false;
    Pool& p = it->second;
    if (newSize <= p.size) return true;  // shm pools only grow; nothing to do
    void* nb = ::mremap(p.base, p.size, newSize, MREMAP_MAYMOVE);
    if (nb == MAP_FAILED) return false;
    p.base = nb;
    p.size = newSize;
    return true;
}

void ShmRegistry::freePool(uint32_t poolId) {
    auto it = pools_.find(poolId);
    if (it == pools_.end()) return;
    Pool& p = it->second;
    if (p.base && p.base != MAP_FAILED) ::munmap(p.base, p.size);
    if (p.fd >= 0) ::close(p.fd);
    pools_.erase(it);
}

bool ShmRegistry::destroyPool(uint32_t poolId) {
    auto it = pools_.find(poolId);
    if (it == pools_.end()) return false;
    // Spec: buffers outlive the pool. Defer the unmap until no buffers remain.
    it->second.destroyed = true;
    if (it->second.bufferRefs == 0) {
        freePool(poolId);
        return true;
    }
    return false;
}

void ShmRegistry::addBufferRef(uint32_t poolId) {
    auto it = pools_.find(poolId);
    if (it != pools_.end()) it->second.bufferRefs++;
}

bool ShmRegistry::releaseBufferRef(uint32_t poolId) {
    auto it = pools_.find(poolId);
    if (it == pools_.end()) return false;
    if (it->second.bufferRefs > 0) it->second.bufferRefs--;
    if (it->second.destroyed && it->second.bufferRefs == 0) {
        freePool(poolId);
        return true;
    }
    return false;
}

const uint8_t* ShmRegistry::view(uint32_t poolId, size_t offset, size_t len) const {
    auto it = pools_.find(poolId);
    if (it == pools_.end()) return nullptr;
    const Pool& p = it->second;
    if (offset > p.size || len > p.size - offset) return nullptr;
    return static_cast<const uint8_t*>(p.base) + offset;
}

uint8_t* ShmRegistry::mapWritable(uint32_t poolId, size_t offset, size_t len,
                                  void** out_mmap_base, size_t* out_mmap_size) {
    if (out_mmap_base) *out_mmap_base = nullptr;
    if (out_mmap_size) *out_mmap_size = 0;
    auto it = pools_.find(poolId);
    if (it == pools_.end()) return nullptr;
    const Pool& p = it->second;
    if (p.fd < 0) return nullptr;
    if (offset > p.size || len > p.size - offset) return nullptr;
    // mmap offset must be page-aligned; widen the window to the surrounding
    // page boundary and return a pointer that points at the requested byte.
    const size_t pageSize = static_cast<size_t>(::sysconf(_SC_PAGESIZE));
    const size_t pageMask = pageSize - 1;
    const size_t aligned = offset & ~pageMask;
    const size_t inset = offset - aligned;
    const size_t mapLen = inset + len;
    void* base = ::mmap(nullptr, mapLen, PROT_READ | PROT_WRITE, MAP_SHARED,
                        p.fd, static_cast<off_t>(aligned));
    if (base == MAP_FAILED) return nullptr;
    if (out_mmap_base) *out_mmap_base = base;
    if (out_mmap_size) *out_mmap_size = mapLen;
    return static_cast<uint8_t*>(base) + inset;
}

}  // namespace overdraw::core
