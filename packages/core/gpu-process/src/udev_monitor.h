// Udev netlink monitor for DRM hotplug events.
//
// Lives in the GPU process next to libseat (same process that owns the DRM
// card fd). The monitor is filtered to the `drm` subsystem; every uevent is
// classified into one of:
//
//   kConnectorChange  -- a monitor was plugged/unplugged on the current card
//                        (action=change, HOTPLUG=1). Triggers a connector rescan.
//   kCardAdded        -- a whole DRM card appeared (action=add). Logged only.
//   kCardRemoved      -- a whole DRM card disappeared (action=remove). Logged only.
//   kIgnore           -- anything else (LEASE events, etc.).
//
// The classifier is split out into a pure helper (classifyAction) so it can
// be unit-tested without a running udev daemon.
//
// No public dependency on libudev: the header carries only the Event type
// and a forward declaration. The .cpp owns the opaque udev/udev_monitor
// handles.

#ifndef OVERDRAW_GPU_UDEV_MONITOR_H_
#define OVERDRAW_GPU_UDEV_MONITOR_H_

#include <cstdint>
#include <functional>
#include <string>
#include <sys/types.h>  // dev_t

struct udev;
struct udev_monitor;

namespace overdraw::gpu {

// Classifier output. Pure data; produced by drain() and fed to the user's
// callback.
struct UdevHotplugEvent {
    enum class Kind {
        kIgnore,
        kConnectorChange,  // action=change + HOTPLUG=1: triggers a rescan
        kCardAdded,        // action=add: logged only
        kCardRemoved,      // action=remove: logged only
    };

    Kind        kind             = Kind::kIgnore;
    dev_t       devnum           = 0;   // dev_t of the card the event concerns
    std::string sysname;                // e.g. "card0", for logging
    uint32_t    connectorIdHint  = 0;   // CONNECTOR=<id> if present, else 0
                                        //   advisory only -- the rescan still
                                        //   iterates every connector
};

// Pure classifier: given the raw udev action + property strings (any may be
// null), return the event kind. Public so tests can exercise it without a
// running udev. Note `hotplugProp` is the string value of the "HOTPLUG"
// property (typically "1"); `connectorProp` is "CONNECTOR" (decimal connector
// id). All inputs may be null.
UdevHotplugEvent::Kind classifyUdevAction(const char* action,
                                          const char* hotplugProp);

// Parse the CONNECTOR=<id> property string into a u32, returning 0 on null /
// non-numeric input. Public for the same testability reason.
uint32_t parseConnectorIdHint(const char* connectorProp);

class UdevHotplugMonitor {
  public:
    using OnEvent = std::function<void(const UdevHotplugEvent&)>;

    UdevHotplugMonitor() = default;
    ~UdevHotplugMonitor();

    UdevHotplugMonitor(const UdevHotplugMonitor&) = delete;
    UdevHotplugMonitor& operator=(const UdevHotplugMonitor&) = delete;

    // Create the udev context + netlink monitor filtered to drm; enable
    // receiving. Returns false on any failure (call error() for the reason).
    bool open();

    // The netlink fd to register with the event loop. -1 if open() didn't
    // succeed.
    int fd() const;

    // Drain every pending uevent, classify it, and fire `cb` for each.
    // Non-blocking; call from the event loop's readable-fd dispatch.
    void drain(const OnEvent& cb);

    const std::string& error() const { return error_; }

  private:
    udev*         udev_    = nullptr;
    udev_monitor* monitor_ = nullptr;
    std::string   error_;
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_UDEV_MONITOR_H_
