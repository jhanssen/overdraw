#include "udev_monitor.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>

extern "C" {
#include <libudev.h>
}

namespace overdraw::gpu {

UdevHotplugEvent::Kind classifyUdevAction(const char* action,
                                          const char* hotplugProp) {
    if (!action) return UdevHotplugEvent::Kind::kIgnore;
    if (std::strcmp(action, "change") == 0) {
        if (hotplugProp && std::strcmp(hotplugProp, "1") == 0) {
            return UdevHotplugEvent::Kind::kConnectorChange;
        }
        return UdevHotplugEvent::Kind::kIgnore;  // LEASE / unknown
    }
    if (std::strcmp(action, "add") == 0)    return UdevHotplugEvent::Kind::kCardAdded;
    if (std::strcmp(action, "remove") == 0) return UdevHotplugEvent::Kind::kCardRemoved;
    return UdevHotplugEvent::Kind::kIgnore;
}

uint32_t parseConnectorIdHint(const char* connectorProp) {
    if (!connectorProp || !*connectorProp) return 0;
    char* end = nullptr;
    errno = 0;
    unsigned long v = std::strtoul(connectorProp, &end, 10);
    if (errno != 0 || end == connectorProp) return 0;
    return static_cast<uint32_t>(v);
}

UdevHotplugMonitor::~UdevHotplugMonitor() {
    if (monitor_) udev_monitor_unref(monitor_);
    if (udev_)    udev_unref(udev_);
}

bool UdevHotplugMonitor::open() {
    if (udev_) {
        error_ = "udev monitor already open";
        return false;
    }
    udev_ = udev_new();
    if (!udev_) {
        error_ = "udev_new failed";
        return false;
    }
    monitor_ = udev_monitor_new_from_netlink(udev_, "udev");
    if (!monitor_) {
        error_ = std::string("udev_monitor_new_from_netlink failed: ")
               + std::strerror(errno);
        udev_unref(udev_);
        udev_ = nullptr;
        return false;
    }
    if (udev_monitor_filter_add_match_subsystem_devtype(monitor_, "drm", nullptr) < 0) {
        error_ = "udev_monitor_filter_add_match_subsystem_devtype(drm) failed";
        udev_monitor_unref(monitor_);
        udev_unref(udev_);
        monitor_ = nullptr;
        udev_ = nullptr;
        return false;
    }
    if (udev_monitor_enable_receiving(monitor_) < 0) {
        error_ = std::string("udev_monitor_enable_receiving failed: ")
               + std::strerror(errno);
        udev_monitor_unref(monitor_);
        udev_unref(udev_);
        monitor_ = nullptr;
        udev_ = nullptr;
        return false;
    }
    return true;
}

int UdevHotplugMonitor::fd() const {
    return monitor_ ? udev_monitor_get_fd(monitor_) : -1;
}

void UdevHotplugMonitor::drain(const OnEvent& cb) {
    if (!monitor_) return;
    for (;;) {
        udev_device* dev = udev_monitor_receive_device(monitor_);
        if (!dev) return;  // would block; netlink queue empty

        const char* action     = udev_device_get_action(dev);
        const char* sysname    = udev_device_get_sysname(dev);
        const char* hotplugVal = udev_device_get_property_value(dev, "HOTPLUG");
        const char* connVal    = udev_device_get_property_value(dev, "CONNECTOR");

        UdevHotplugEvent ev{};
        ev.kind   = classifyUdevAction(action, hotplugVal);
        ev.devnum = udev_device_get_devnum(dev);
        if (sysname) ev.sysname = sysname;
        ev.connectorIdHint = parseConnectorIdHint(connVal);

        if (cb) cb(ev);

        udev_device_unref(dev);
    }
}

}  // namespace overdraw::gpu
