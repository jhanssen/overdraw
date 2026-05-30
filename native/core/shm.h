// Native wl_shm pool registry. A pool is an mmap of a client-passed fd; clients
// carve wl_buffers out of it as (offset, width, height, stride, format) views.
// CPU-only: the bytes are uploaded to a GPU texture by the Compositor. Pools
// outlive individual buffers, so the mapping is held here until the pool is
// destroyed.

#ifndef OVERDRAW_CORE_SHM_H_
#define OVERDRAW_CORE_SHM_H_

#include <cstddef>
#include <cstdint>
#include <unordered_map>

namespace overdraw::core {

class ShmRegistry {
  public:
    ~ShmRegistry();

    // Map `fd` (owned by the caller; the registry dups internally is NOT done --
    // ownership of `fd` transfers here and is closed on destroyPool). Returns a
    // pool id, or 0 on failure (mmap failed / bad size).
    uint32_t createPool(int fd, size_t size);

    // Grow an existing pool's mapping to `newSize` (wl_shm_pool.resize only
    // ever grows). Returns false if the pool is unknown or remap fails.
    bool resizePool(uint32_t poolId, size_t newSize);

    // Destroy a pool: unmap and close its fd. No-op for unknown ids.
    void destroyPool(uint32_t poolId);

    // Resolve a byte region within a pool. Returns nullptr if the pool is
    // unknown or [offset, offset+len) is out of range.
    const uint8_t* view(uint32_t poolId, size_t offset, size_t len) const;

  private:
    struct Pool {
        int fd = -1;
        void* base = nullptr;
        size_t size = 0;
    };
    std::unordered_map<uint32_t, Pool> pools_;
    uint32_t nextId_ = 1;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_SHM_H_
