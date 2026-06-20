// libdrm helpers for the KMS output backend.
//
// Connector / CRTC / plane enumeration and selection, atomic-commit helpers,
// EDID parsing (physical mm + product name), per-plane IN_FORMATS modifier
// enumeration. Vendor-neutral: all access is through libdrm + the standard
// KMS object model. No driver-specific paths.

#ifndef OVERDRAW_GPU_DRM_UTILS_H_
#define OVERDRAW_GPU_DRM_UTILS_H_

#include <cstdint>
#include <string>
#include <vector>

extern "C" {
#include <xf86drmMode.h>
}

namespace overdraw::gpu {

// One mode of a connector. Mirrors drmModeModeInfo's subset we use.
struct DrmMode {
    uint32_t hdisplay;    // active pixel width
    uint32_t vdisplay;    // active pixel height
    uint32_t vrefreshMhz; // refresh rate in mHz (Hz * 1000)
    bool     preferred;   // DRM_MODE_TYPE_PREFERRED
    drmModeModeInfo raw;  // pass straight back into drmModeAtomicAddProperty
};

// IDs + properties resolved for a working scanout configuration: one
// connector, one CRTC, one primary plane.
struct DrmTopology {
    // Connector
    uint32_t connectorId   = 0;
    std::string connectorName;       // e.g. "eDP-1" (driver+type+index)
    DrmMode  mode{};

    // CRTC
    uint32_t crtcId        = 0;

    // Primary plane for that CRTC
    uint32_t planeId       = 0;

    // Property ids cached for atomic commits. 0 = property absent on object.
    struct {
        uint32_t crtc_id = 0;       // on connector: which CRTC drives it
    } connectorProps;
    struct {
        uint32_t mode_id = 0;       // on CRTC: the mode blob id
        uint32_t active  = 0;       // on CRTC: enable bit
    } crtcProps;
    struct {
        uint32_t fb_id        = 0;   // on plane: the framebuffer to scan out
        uint32_t crtc_id      = 0;   // on plane: bound CRTC
        uint32_t src_x        = 0;
        uint32_t src_y        = 0;
        uint32_t src_w        = 0;
        uint32_t src_h        = 0;
        uint32_t crtc_x       = 0;
        uint32_t crtc_y       = 0;
        uint32_t crtc_w       = 0;
        uint32_t crtc_h       = 0;
        uint32_t in_fence_fd  = 0;   // optional; 0 means absent (commit without IN_FENCE_FD)
        uint32_t in_formats   = 0;   // optional; reading the per-plane modifier set
    } planeProps;
};

// EDID-derived display identity. Fields are best-effort: any can be empty
// or zero if the EDID didn't carry them (e.g. an internal eDP panel often
// has no Display Product Name descriptor, only a Display Product Serial).
struct EdidInfo {
    uint32_t physicalWidthMm  = 0;
    uint32_t physicalHeightMm = 0;
    std::string productName;
    // Stable durable identifier built from the EDID header bytes:
    // "<MFR>-<PRODUCT_HEX>-<SERIAL_HEX>". MFR is 3 ASCII letters encoded
    // in EDID bytes 8-9 (5 bits each, big-endian). PRODUCT_HEX is the
    // 16-bit little-endian product code (bytes 10-11), uppercase hex.
    // SERIAL_HEX is the 32-bit little-endian serial (bytes 12-15),
    // uppercase hex. Empty when the EDID is unreadable or malformed
    // (caller falls back to the connector name as durable key).
    // Two identical-model monitors with distinct factory serials produce
    // distinct stableId values; two identical monitors with no serial
    // (serial bytes = 0) alias to the same stableId, which §3 acknowledges
    // as a known limitation -- the connector-name fallback disambiguates
    // them by port at the cost of port-swap robustness.
    std::string stableId;
};

// One (format, modifier) tuple advertised by a plane's IN_FORMATS property.
struct PlaneFormatModifier {
    uint32_t fourcc;
    uint64_t modifier;
};

// Open + enable atomic + universal-planes on `drmFd`. Returns false if the
// driver does not support atomic. The fd is owned by the caller; this does
// not close it on failure.
bool enableDrmAtomicCaps(int drmFd);

// Enumerate connectors and pick the first connected one with a non-empty
// mode list. If `preferConnectorName` is non-empty AND a connector with that
// name is connected with modes, it wins. Picks the preferred mode of the
// chosen connector if marked, else mode 0.
// Returns false if no usable connector exists; out is left default.
bool pickConnector(int drmFd, const std::string& preferConnectorName,
                   uint32_t& outConnectorId, std::string& outConnectorName,
                   DrmMode& outMode);

// One connected connector with a usable mode list, for multi-output
// enumeration. Mode is the preferred one (else mode 0), same policy as
// pickConnector.
struct ConnectorInfo {
    uint32_t connectorId = 0;
    std::string name;     // e.g. "DP-1"
    DrmMode mode{};
};

// Enumerate ALL connected connectors with a non-empty mode list, in DRM
// resource order. The first entry is what pickConnector(.., "") would have
// returned. Used to report every attached monitor to the core; driving more
// than the first (CRTC assignment + modeset + scanout) is a later step.
std::vector<ConnectorInfo> enumerateConnectors(int drmFd);

// Pick a CRTC compatible with `connectorId` (walking the connector's encoders
// and their possible_crtcs masks) that is not already bound to another
// connector and not in `excludeCrtcs` (CRTCs already claimed for other outputs
// this session — the kernel's current binding doesn't reflect our own in-progress
// multi-output assignment). Returns false if no CRTC is available.
bool pickCrtc(int drmFd, uint32_t connectorId, uint32_t& outCrtcId,
              const std::vector<uint32_t>& excludeCrtcs = {});

// Pick the primary plane attached to (or attachable to) `crtcId`. Returns
// false if no primary plane is found.
bool pickPrimaryPlane(int drmFd, uint32_t crtcId, uint32_t& outPlaneId);

// Resolve and cache the property ids we need for atomic commits, for the
// connector / CRTC / plane in `topo`. Returns false if any required property
// is missing (in_fence_fd / in_formats are optional; their ids may be 0).
bool resolveProperties(int drmFd, DrmTopology& topo);

// Read the connector's EDID blob and extract physical dims + product name.
// Returns true if the EDID was readable; missing fields stay zero/empty.
bool readEdid(int drmFd, uint32_t connectorId, EdidInfo& out);

// Read the plane's IN_FORMATS property and return the (format, modifier)
// list it advertises. Returns an empty vector if the property is absent
// (older drivers) -- the caller should then fall back to LINEAR.
std::vector<PlaneFormatModifier>
readPlaneFormats(int drmFd, uint32_t planeId, uint32_t inFormatsPropId);

// Build a mode blob and return its blob id. Caller destroys with
// drmModeDestroyPropertyBlob. Returns 0 on failure.
uint32_t createModeBlob(int drmFd, const drmModeModeInfo& mode);

// Find a mode on `connectorId` whose active dims and refresh match the
// request. Width/height match exactly; refresh tolerates a small delta
// (the modeline rate computed from clock/htotal/vtotal can be off by a
// few mHz from the nominal value EDID advertises -- 60.000 Hz vs
// 59.940 Hz, 144000 mHz vs 143999 mHz are common). When refreshMhz is 0
// the caller doesn't care about refresh; pick the first matching mode.
// Returns true on match; leaves `outMode` untouched on miss.
bool findMode(int drmFd, uint32_t connectorId,
              uint32_t width, uint32_t height, uint32_t refreshMhz,
              DrmMode& outMode);

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_DRM_UTILS_H_
