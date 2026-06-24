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

    // Mark a pool destroyed (wl_shm_pool.destroy). Per the Wayland spec, buffers
    // created from the pool remain valid after the pool is destroyed, so the
    // mapping is freed only once destroyed AND no buffers still reference it.
    // Returns true iff the mmap was unmapped + fd closed by this call (i.e.
    // no live buffers were holding it) so the caller can mirror that
    // teardown to a peer (the GPU process's matching mmap).
    bool destroyPool(uint32_t poolId);

    // Buffer lifetime refcounting: a wl_buffer carved from a pool keeps the
    // mapping alive. create_buffer -> addRef; wl_buffer.destroy -> releaseRef.
    // releaseBufferRef returns true iff dropping this ref triggered the
    // pool teardown (same mirroring contract as destroyPool).
    void addBufferRef(uint32_t poolId);
    bool releaseBufferRef(uint32_t poolId);

    // Resolve a byte region within a pool. Returns nullptr if the pool is
    // unknown or [offset, offset+len) is out of range.
    const uint8_t* view(uint32_t poolId, size_t offset, size_t len) const;

    // Mapped size of a pool, or 0 if unknown. (Debug/diagnostics.)
    size_t poolSize(uint32_t poolId) const;

    // Allocate an independent writable mmap (PROT_READ|PROT_WRITE, MAP_SHARED)
    // covering [offset, offset+len) of the pool's fd. The returned pointer is
    // the START of [offset, ...) (the caller does not see the page-alignment
    // padding); `out_mmap_base` and `out_mmap_size` receive the actual mmap
    // base + size so the caller can munmap when done. The default `view()`
    // mapping (MAP_PRIVATE, PROT_READ) is unaffected.
    //
    // Capture-destination buffers need this: a client carves a wl_buffer out
    // of its shm pool, attaches it to an ext_image_copy_capture_frame_v1, and
    // expects the compositor to WRITE captured pixels into the underlying
    // file/memfd. The default read-only private mapping cannot serve that:
    // PROT_READ disallows writes outright, and MAP_PRIVATE writes wouldn't
    // propagate back to the client. Returns nullptr on out-of-range, unknown
    // pool, or mmap failure.
    uint8_t* mapWritable(uint32_t poolId, size_t offset, size_t len,
                         void** out_mmap_base, size_t* out_mmap_size);

  private:
    struct Pool {
        int fd = -1;
        void* base = nullptr;
        size_t size = 0;
        bool destroyed = false;  // wl_shm_pool.destroy seen
        uint32_t bufferRefs = 0; // live wl_buffers carved from this pool
    };
    std::unordered_map<uint32_t, Pool> pools_;
    uint32_t nextId_ = 1;

    // Unmap + close + erase a pool. Called when destroyed && bufferRefs == 0.
    void freePool(uint32_t poolId);
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_SHM_H_
