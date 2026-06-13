// libseat wrapper: own the seat for the core process.
//
// The seat is the access point for /dev/dri/card* and /dev/input/event*. The
// core opens a single seat at startup; the input backend (LibinputBackend) and
// (in later slices) the KMS output backend ask the seat to open the device
// nodes they need. The seat hands back a poll fd that the addon adds to the
// libuv loop so libseat events (enable/disable on VT switch, device revoke)
// dispatch on the Node thread.
//
// Lifecycle:
//   - construct -> open() -> ok? -> (use) -> close() -> destruct
//   - open() picks the backend libseat selects (logind on systemd hosts).
//   - The first `enable_seat` from libseat fires synchronously inside open()
//     when the session is already active; later switches fire on dispatch().
//
// Threading: single-threaded. dispatch() is called from the addon's uv_poll
// callback on the Node main thread.
//
// Ownership of device fds returned by openDevice(): the caller owns the fd
// itself (must close() it) AND must call closeDevice(deviceId) on the seat to
// release libseat's accounting. closeDevice() does not close the fd.

#ifndef OVERDRAW_CORE_SEAT_H_
#define OVERDRAW_CORE_SEAT_H_

#include <functional>
#include <string>

struct libseat;

namespace overdraw::core {

class Seat {
  public:
    using StateCb = std::function<void()>;

    Seat() = default;
    ~Seat();

    Seat(const Seat&) = delete;
    Seat& operator=(const Seat&) = delete;

    // Connect to the seat. onEnable fires when the seat becomes active (at
    // least once, on first activation, before open() returns if the session
    // is already active; again after a VT switch back). onDisable fires when
    // the seat is about to lose access (e.g. VT switch away); the caller must
    // stop using device fds promptly. Both callbacks may be null.
    //
    // Returns true on success. On failure, error() carries a description.
    bool open(StateCb onEnable, StateCb onDisable);

    void close();

    // The libseat poll fd. Add this to the event loop for UV_READABLE; call
    // dispatch() when it signals. -1 if not open.
    int pollFd() const;

    // Drain pending events; invokes the registered callbacks. Non-blocking.
    // Returns true on success (including the no-events case).
    bool dispatch();

    // Acknowledge a disable_seat event from libseat. Must be called from the
    // onDisable callback (or shortly after) so the seat provider knows we
    // released the devices.
    void ackDisable();

    // Open a device on the seat. Returns true and fills out_fd / out_deviceId
    // on success. The fd is open-on-success; caller closes it. The deviceId
    // must be passed to closeDevice() when done.
    bool openDevice(const char* path, int& outFd, int& outDeviceId);

    // Release libseat's accounting for a previously opened device. The caller
    // is responsible for closing the fd separately (this does not).
    bool closeDevice(int deviceId);

    // Name of the seat (e.g. "seat0"). Valid only while open. Empty otherwise.
    std::string name() const;

    bool isOpen() const { return seat_ != nullptr; }
    bool isActive() const { return active_; }
    const std::string& error() const { return error_; }

  private:
    // libseat listener trampolines.
    static void onEnable_(struct libseat*, void* userdata);
    static void onDisable_(struct libseat*, void* userdata);

    struct libseat* seat_ = nullptr;
    bool            active_ = false;
    StateCb         onEnable_cb_;
    StateCb         onDisable_cb_;
    std::string     error_;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_SEAT_H_
