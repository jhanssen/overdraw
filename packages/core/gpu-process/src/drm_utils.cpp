#include "drm_utils.h"

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>

extern "C" {
#include <xf86drm.h>
#include <xf86drmMode.h>
#include <drm_fourcc.h>
}

#include "log/log.h"

namespace overdraw::gpu {
namespace {

const char* connectorTypeName(uint32_t type) {
    switch (type) {
        case DRM_MODE_CONNECTOR_HDMIA:     return "HDMI-A";
        case DRM_MODE_CONNECTOR_HDMIB:     return "HDMI-B";
        case DRM_MODE_CONNECTOR_DisplayPort: return "DP";
        case DRM_MODE_CONNECTOR_eDP:       return "eDP";
        case DRM_MODE_CONNECTOR_LVDS:      return "LVDS";
        case DRM_MODE_CONNECTOR_VGA:       return "VGA";
        case DRM_MODE_CONNECTOR_DVII:      return "DVI-I";
        case DRM_MODE_CONNECTOR_DVID:      return "DVI-D";
        case DRM_MODE_CONNECTOR_DVIA:      return "DVI-A";
        case DRM_MODE_CONNECTOR_VIRTUAL:   return "Virtual";
        case DRM_MODE_CONNECTOR_DSI:       return "DSI";
        case DRM_MODE_CONNECTOR_USB:       return "USB";
        default:                           return "Unknown";
    }
}

uint32_t modeRefreshMhz(const drmModeModeInfo& m) {
    // refresh_hz = clock * 1000 / (htotal * vtotal). The mode's clock is in kHz.
    // Express as mHz (Hz * 1000) for the wl_output protocol.
    if (m.htotal == 0 || m.vtotal == 0) return 0;
    uint64_t num = static_cast<uint64_t>(m.clock) * 1'000'000ULL;  // clock kHz -> mHz
    uint64_t den = static_cast<uint64_t>(m.htotal) * static_cast<uint64_t>(m.vtotal);
    return static_cast<uint32_t>(num / den);
}

// Walk every property of `objectId` (of type `objectType`) calling `cb(name,
// value, prop)`. Returns the number of properties visited.
int walkProperties(int drmFd, uint32_t objectId, uint32_t objectType,
                   const std::function<void(const char*, uint64_t, const drmModePropertyRes*)>& cb) {
    drmModeObjectProperties* props = drmModeObjectGetProperties(drmFd, objectId, objectType);
    if (!props) return 0;
    int count = 0;
    for (uint32_t i = 0; i < props->count_props; ++i) {
        drmModePropertyRes* p = drmModeGetProperty(drmFd, props->props[i]);
        if (!p) continue;
        cb(p->name, props->prop_values[i], p);
        drmModeFreeProperty(p);
        ++count;
    }
    drmModeFreeObjectProperties(props);
    return count;
}

}  // namespace

bool enableDrmAtomicCaps(int drmFd) {
    if (drmSetClientCap(drmFd, DRM_CLIENT_CAP_ATOMIC, 1) != 0) {
        LOG_ERR(Gpu, "[drm] DRM_CLIENT_CAP_ATOMIC rejected: {}", std::strerror(errno));
        return false;
    }
    if (drmSetClientCap(drmFd, DRM_CLIENT_CAP_UNIVERSAL_PLANES, 1) != 0) {
        LOG_ERR(Gpu, "[drm] DRM_CLIENT_CAP_UNIVERSAL_PLANES rejected: {}",
                std::strerror(errno));
        return false;
    }
    return true;
}

bool pickConnector(int drmFd, const std::string& preferConnectorName,
                   uint32_t& outConnectorId, std::string& outConnectorName,
                   DrmMode& outMode) {
    drmModeRes* res = drmModeGetResources(drmFd);
    if (!res) {
        LOG_ERR(Gpu, "[drm] drmModeGetResources failed: {}", std::strerror(errno));
        return false;
    }

    auto consider = [&](uint32_t connectorId) -> bool {
        drmModeConnector* c = drmModeGetConnector(drmFd, connectorId);
        if (!c) return false;
        bool ok = false;
        if (c->connection == DRM_MODE_CONNECTED && c->count_modes > 0) {
            // Name = "<type>-<typeIndex>", e.g. "eDP-1".
            char name[64];
            std::snprintf(name, sizeof(name), "%s-%u",
                          connectorTypeName(c->connector_type),
                          c->connector_type_id);

            // Pick a mode: preferred if marked, else mode 0.
            int chosen = 0;
            for (int i = 0; i < c->count_modes; ++i) {
                if (c->modes[i].type & DRM_MODE_TYPE_PREFERRED) { chosen = i; break; }
            }
            const drmModeModeInfo& m = c->modes[chosen];
            outConnectorId = connectorId;
            outConnectorName = name;
            outMode.hdisplay    = m.hdisplay;
            outMode.vdisplay    = m.vdisplay;
            outMode.vrefreshMhz = modeRefreshMhz(m);
            outMode.preferred   = (m.type & DRM_MODE_TYPE_PREFERRED) != 0;
            outMode.raw         = m;
            ok = true;
        }
        drmModeFreeConnector(c);
        return ok;
    };

    // Pass 1: if a preferred name was requested, try to satisfy it first.
    if (!preferConnectorName.empty()) {
        for (int i = 0; i < res->count_connectors; ++i) {
            drmModeConnector* c = drmModeGetConnector(drmFd, res->connectors[i]);
            if (!c) continue;
            char name[64];
            std::snprintf(name, sizeof(name), "%s-%u",
                          connectorTypeName(c->connector_type),
                          c->connector_type_id);
            const bool matches = preferConnectorName == name;
            drmModeFreeConnector(c);
            if (matches && consider(res->connectors[i])) {
                drmModeFreeResources(res);
                return true;
            }
        }
    }

    // Pass 2: first connected.
    for (int i = 0; i < res->count_connectors; ++i) {
        if (consider(res->connectors[i])) {
            drmModeFreeResources(res);
            return true;
        }
    }

    drmModeFreeResources(res);
    LOG_ERR(Gpu, "[drm] no connected connector with modes");
    return false;
}

std::vector<ConnectorInfo> enumerateConnectors(int drmFd) {
    std::vector<ConnectorInfo> out;
    drmModeRes* res = drmModeGetResources(drmFd);
    if (!res) return out;
    for (int i = 0; i < res->count_connectors; ++i) {
        drmModeConnector* c = drmModeGetConnector(drmFd, res->connectors[i]);
        if (!c) continue;
        if (c->connection == DRM_MODE_CONNECTED && c->count_modes > 0) {
            ConnectorInfo info;
            info.connectorId = res->connectors[i];
            char name[64];
            std::snprintf(name, sizeof(name), "%s-%u",
                          connectorTypeName(c->connector_type),
                          c->connector_type_id);
            info.name = name;
            int chosen = 0;
            for (int m = 0; m < c->count_modes; ++m) {
                if (c->modes[m].type & DRM_MODE_TYPE_PREFERRED) { chosen = m; break; }
            }
            const drmModeModeInfo& m = c->modes[chosen];
            info.mode.hdisplay    = m.hdisplay;
            info.mode.vdisplay    = m.vdisplay;
            info.mode.vrefreshMhz = modeRefreshMhz(m);
            info.mode.preferred   = (m.type & DRM_MODE_TYPE_PREFERRED) != 0;
            info.mode.raw         = m;
            out.push_back(std::move(info));
        }
        drmModeFreeConnector(c);
    }
    drmModeFreeResources(res);
    return out;
}

bool pickCrtc(int drmFd, uint32_t connectorId, uint32_t& outCrtcId,
              const std::vector<uint32_t>& excludeCrtcs) {
    drmModeRes* res = drmModeGetResources(drmFd);
    if (!res) return false;
    drmModeConnector* conn = drmModeGetConnector(drmFd, connectorId);
    if (!conn) { drmModeFreeResources(res); return false; }

    // Already-bound CRTCs we should avoid (don't trample another connector).
    // Built by querying each connector's current encoder->crtc.
    auto crtcInUse = [&](uint32_t crtcId) -> bool {
        for (int i = 0; i < res->count_connectors; ++i) {
            if (res->connectors[i] == connectorId) continue;
            drmModeConnector* other = drmModeGetConnector(drmFd, res->connectors[i]);
            if (!other) continue;
            if (other->encoder_id != 0) {
                drmModeEncoder* enc = drmModeGetEncoder(drmFd, other->encoder_id);
                if (enc) {
                    if (enc->crtc_id == crtcId) {
                        drmModeFreeEncoder(enc);
                        drmModeFreeConnector(other);
                        return true;
                    }
                    drmModeFreeEncoder(enc);
                }
            }
            drmModeFreeConnector(other);
        }
        return false;
    };

    // Walk every encoder the connector lists and intersect its possible_crtcs
    // with res->crtcs. Pick the first free one.
    bool ok = false;
    for (int e = 0; e < conn->count_encoders && !ok; ++e) {
        drmModeEncoder* enc = drmModeGetEncoder(drmFd, conn->encoders[e]);
        if (!enc) continue;
        for (int c = 0; c < res->count_crtcs && !ok; ++c) {
            const uint32_t mask = 1u << c;
            if ((enc->possible_crtcs & mask) == 0) continue;
            const uint32_t crtcId = res->crtcs[c];
            if (crtcInUse(crtcId)) continue;
            if (std::find(excludeCrtcs.begin(), excludeCrtcs.end(), crtcId)
                != excludeCrtcs.end()) continue;  // already claimed this session
            outCrtcId = crtcId;
            ok = true;
        }
        drmModeFreeEncoder(enc);
    }

    drmModeFreeConnector(conn);
    drmModeFreeResources(res);
    if (!ok) LOG_ERR(Gpu, "[drm] no free CRTC for connector {}", connectorId);
    return ok;
}

bool pickPrimaryPlane(int drmFd, uint32_t crtcId, uint32_t& outPlaneId) {
    drmModeRes* res = drmModeGetResources(drmFd);
    if (!res) return false;

    // Map crtcId -> its index in res->crtcs, to evaluate plane->possible_crtcs.
    int crtcIdx = -1;
    for (int i = 0; i < res->count_crtcs; ++i) {
        if (res->crtcs[i] == crtcId) { crtcIdx = i; break; }
    }
    drmModeFreeResources(res);
    if (crtcIdx < 0) return false;

    drmModePlaneRes* planes = drmModeGetPlaneResources(drmFd);
    if (!planes) return false;
    bool ok = false;
    for (uint32_t i = 0; i < planes->count_planes && !ok; ++i) {
        drmModePlane* p = drmModeGetPlane(drmFd, planes->planes[i]);
        if (!p) continue;
        const bool reachable = (p->possible_crtcs & (1u << crtcIdx)) != 0;
        drmModeFreePlane(p);
        if (!reachable) continue;
        // The plane is reachable from the CRTC; check its type via the type
        // property (universal-planes makes this required reading).
        bool isPrimary = false;
        walkProperties(drmFd, planes->planes[i], DRM_MODE_OBJECT_PLANE,
            [&](const char* name, uint64_t value, const drmModePropertyRes*) {
                if (std::strcmp(name, "type") == 0 && value == DRM_PLANE_TYPE_PRIMARY) {
                    isPrimary = true;
                }
            });
        if (isPrimary) {
            outPlaneId = planes->planes[i];
            ok = true;
        }
    }
    drmModeFreePlaneResources(planes);
    if (!ok) LOG_ERR(Gpu, "[drm] no primary plane for CRTC {}", crtcId);
    return ok;
}

bool pickCursorPlane(int drmFd, uint32_t crtcId, uint32_t& outPlaneId,
                     const std::vector<uint32_t>& excludePlanes) {
    drmModeRes* res = drmModeGetResources(drmFd);
    if (!res) return false;

    int crtcIdx = -1;
    for (int i = 0; i < res->count_crtcs; ++i) {
        if (res->crtcs[i] == crtcId) { crtcIdx = i; break; }
    }
    drmModeFreeResources(res);
    if (crtcIdx < 0) return false;

    drmModePlaneRes* planes = drmModeGetPlaneResources(drmFd);
    if (!planes) return false;
    bool ok = false;
    for (uint32_t i = 0; i < planes->count_planes && !ok; ++i) {
        if (std::find(excludePlanes.begin(), excludePlanes.end(),
                      planes->planes[i]) != excludePlanes.end()) continue;
        drmModePlane* p = drmModeGetPlane(drmFd, planes->planes[i]);
        if (!p) continue;
        const bool reachable = (p->possible_crtcs & (1u << crtcIdx)) != 0;
        drmModeFreePlane(p);
        if (!reachable) continue;
        bool isCursor = false;
        walkProperties(drmFd, planes->planes[i], DRM_MODE_OBJECT_PLANE,
            [&](const char* name, uint64_t value, const drmModePropertyRes*) {
                if (std::strcmp(name, "type") == 0 && value == DRM_PLANE_TYPE_CURSOR) {
                    isCursor = true;
                }
            });
        if (isCursor) {
            outPlaneId = planes->planes[i];
            ok = true;
        }
    }
    drmModeFreePlaneResources(planes);
    // No log on miss: absence of a cursor plane is a normal configuration
    // (the output just uses the software cursor).
    return ok;
}

void queryCursorSizeCaps(int drmFd, uint32_t& outWidth, uint32_t& outHeight) {
    uint64_t w = 0, h = 0;
    if (drmGetCap(drmFd, DRM_CAP_CURSOR_WIDTH, &w) != 0 || w == 0) w = 64;
    if (drmGetCap(drmFd, DRM_CAP_CURSOR_HEIGHT, &h) != 0 || h == 0) h = 64;
    outWidth  = static_cast<uint32_t>(w);
    outHeight = static_cast<uint32_t>(h);
}

// Older libdrm headers predate the cap; the kernel ABI value is stable.
#ifndef DRM_CAP_ATOMIC_ASYNC_PAGE_FLIP
#define DRM_CAP_ATOMIC_ASYNC_PAGE_FLIP 0x15
#endif

bool queryAsyncPageFlipCap(int drmFd) {
    uint64_t v = 0;
    return drmGetCap(drmFd, DRM_CAP_ATOMIC_ASYNC_PAGE_FLIP, &v) == 0 && v != 0;
}

bool resolveCursorPlaneProperties(int drmFd, DrmTopology& topo) {
    if (!topo.cursorPlaneId) return false;
    walkProperties(drmFd, topo.cursorPlaneId, DRM_MODE_OBJECT_PLANE,
        [&](const char* name, uint64_t, const drmModePropertyRes* p) {
            auto& cp = topo.cursorPlaneProps;
            if (std::strcmp(name, "FB_ID")        == 0) cp.fb_id   = p->prop_id;
            else if (std::strcmp(name, "CRTC_ID") == 0) cp.crtc_id = p->prop_id;
            else if (std::strcmp(name, "SRC_X")   == 0) cp.src_x   = p->prop_id;
            else if (std::strcmp(name, "SRC_Y")   == 0) cp.src_y   = p->prop_id;
            else if (std::strcmp(name, "SRC_W")   == 0) cp.src_w   = p->prop_id;
            else if (std::strcmp(name, "SRC_H")   == 0) cp.src_h   = p->prop_id;
            else if (std::strcmp(name, "CRTC_X")  == 0) cp.crtc_x  = p->prop_id;
            else if (std::strcmp(name, "CRTC_Y")  == 0) cp.crtc_y  = p->prop_id;
            else if (std::strcmp(name, "CRTC_W")  == 0) cp.crtc_w  = p->prop_id;
            else if (std::strcmp(name, "CRTC_H")  == 0) cp.crtc_h  = p->prop_id;
        });
    const auto& cp = topo.cursorPlaneProps;
    const bool ok = cp.fb_id && cp.crtc_id && cp.src_x && cp.src_y && cp.src_w
                    && cp.src_h && cp.crtc_x && cp.crtc_y && cp.crtc_w && cp.crtc_h;
    if (!ok) {
        LOG_WARN(Gpu,
            "[drm] cursor plane {} missing required properties; using software cursor",
            topo.cursorPlaneId);
        topo.cursorPlaneId = 0;
        topo.cursorPlaneProps = {};
    }
    return ok;
}

bool resolveProperties(int drmFd, DrmTopology& topo) {
    bool okConn = false, okCrtc = false, okPlane = false;

    walkProperties(drmFd, topo.connectorId, DRM_MODE_OBJECT_CONNECTOR,
        [&](const char* name, uint64_t, const drmModePropertyRes* p) {
            if (std::strcmp(name, "CRTC_ID") == 0) { topo.connectorProps.crtc_id = p->prop_id; okConn = true; }
        });
    walkProperties(drmFd, topo.crtcId, DRM_MODE_OBJECT_CRTC,
        [&](const char* name, uint64_t, const drmModePropertyRes* p) {
            if (std::strcmp(name, "MODE_ID") == 0) topo.crtcProps.mode_id = p->prop_id;
            if (std::strcmp(name, "ACTIVE")  == 0) topo.crtcProps.active  = p->prop_id;
        });
    okCrtc = topo.crtcProps.mode_id && topo.crtcProps.active;
    walkProperties(drmFd, topo.planeId, DRM_MODE_OBJECT_PLANE,
        [&](const char* name, uint64_t, const drmModePropertyRes* p) {
            auto& pp = topo.planeProps;
            if (std::strcmp(name, "FB_ID")        == 0) pp.fb_id        = p->prop_id;
            else if (std::strcmp(name, "CRTC_ID") == 0) pp.crtc_id      = p->prop_id;
            else if (std::strcmp(name, "SRC_X")   == 0) pp.src_x        = p->prop_id;
            else if (std::strcmp(name, "SRC_Y")   == 0) pp.src_y        = p->prop_id;
            else if (std::strcmp(name, "SRC_W")   == 0) pp.src_w        = p->prop_id;
            else if (std::strcmp(name, "SRC_H")   == 0) pp.src_h        = p->prop_id;
            else if (std::strcmp(name, "CRTC_X")  == 0) pp.crtc_x       = p->prop_id;
            else if (std::strcmp(name, "CRTC_Y")  == 0) pp.crtc_y       = p->prop_id;
            else if (std::strcmp(name, "CRTC_W")  == 0) pp.crtc_w       = p->prop_id;
            else if (std::strcmp(name, "CRTC_H")  == 0) pp.crtc_h       = p->prop_id;
            else if (std::strcmp(name, "IN_FENCE_FD") == 0) pp.in_fence_fd = p->prop_id;
            else if (std::strcmp(name, "IN_FORMATS")  == 0) pp.in_formats  = p->prop_id;
        });
    auto& pp = topo.planeProps;
    okPlane = pp.fb_id && pp.crtc_id && pp.src_x && pp.src_y && pp.src_w && pp.src_h
              && pp.crtc_x && pp.crtc_y && pp.crtc_w && pp.crtc_h;

    if (!(okConn && okCrtc && okPlane)) {
        LOG_ERR(Gpu,
            "[drm] missing required properties: connector={:d} crtc={:d} plane={:d}",
            okConn, okCrtc, okPlane);
        return false;
    }
    return true;
}

bool readEdid(int drmFd, uint32_t connectorId, EdidInfo& out) {
    // Find the EDID property and its blob id.
    uint32_t edidPropId = 0;
    uint64_t edidBlobId = 0;
    walkProperties(drmFd, connectorId, DRM_MODE_OBJECT_CONNECTOR,
        [&](const char* name, uint64_t value, const drmModePropertyRes* p) {
            if (std::strcmp(name, "EDID") == 0) { edidPropId = p->prop_id; edidBlobId = value; }
        });
    if (!edidPropId || !edidBlobId) return false;

    drmModePropertyBlobRes* blob = drmModeGetPropertyBlob(drmFd, edidBlobId);
    if (!blob || !blob->data || blob->length < 128) {
        if (blob) drmModeFreePropertyBlob(blob);
        return false;
    }
    const uint8_t* edid = static_cast<const uint8_t*>(blob->data);

    // Validate EDID magic ("\x00\xff\xff\xff\xff\xff\xff\x00").
    static const uint8_t kMagic[8] = {0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00};
    if (std::memcmp(edid, kMagic, 8) != 0) {
        drmModeFreePropertyBlob(blob);
        return false;
    }

    // Build the durable stableId from the EDID header (multi-output-design §3).
    // EDID v1.x layout:
    //   bytes 8-9   manufacturer (3 5-bit ASCII letters, packed big-endian:
    //               byte8 = (l1-1)<<2 | (l2-1)>>3; byte9 = ((l2-1)&0x7)<<5 | (l3-1))
    //   bytes 10-11 product code (16-bit little-endian)
    //   bytes 12-15 serial number (32-bit little-endian; may be 0)
    {
        const uint8_t m0 = edid[8];
        const uint8_t m1 = edid[9];
        char mfr[4] = {0, 0, 0, 0};
        mfr[0] = static_cast<char>('A' + ((m0 >> 2) & 0x1f) - 1);
        mfr[1] = static_cast<char>('A' + (((m0 & 0x3) << 3) | ((m1 >> 5) & 0x7)) - 1);
        mfr[2] = static_cast<char>('A' + (m1 & 0x1f) - 1);
        // Guard against garbage: if any letter falls outside A-Z, treat the
        // whole id as absent. (Some virtual / KVM EDIDs emit zeros here.)
        bool mfrOk = (mfr[0] >= 'A' && mfr[0] <= 'Z')
                  && (mfr[1] >= 'A' && mfr[1] <= 'Z')
                  && (mfr[2] >= 'A' && mfr[2] <= 'Z');
        if (mfrOk) {
            const uint16_t product = static_cast<uint16_t>(edid[10])
                                   | (static_cast<uint16_t>(edid[11]) << 8);
            const uint32_t serial = static_cast<uint32_t>(edid[12])
                                  | (static_cast<uint32_t>(edid[13]) << 8)
                                  | (static_cast<uint32_t>(edid[14]) << 16)
                                  | (static_cast<uint32_t>(edid[15]) << 24);
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%s-%04X-%08X", mfr, product, serial);
            out.stableId = buf;
        }
    }

    // Detailed Timing Descriptor 1 starts at offset 54 (18 bytes). Physical
    // size in mm is bytes 12 (horiz low), 13 (vert low), 14 (4-bit upper
    // nibbles: hi nibble = horiz upper 4, lo nibble = vert upper 4).
    const uint8_t* dtd = edid + 54;
    if (dtd[2] || dtd[3] || dtd[4] || dtd[5] || dtd[6] || dtd[7]) {
        // It looks like a real DTD (not all-zero placeholder). Extract phys mm.
        out.physicalWidthMm  = static_cast<uint32_t>(dtd[12])
                             | (static_cast<uint32_t>(dtd[14] & 0xf0) << 4);
        out.physicalHeightMm = static_cast<uint32_t>(dtd[13])
                             | (static_cast<uint32_t>(dtd[14] & 0x0f) << 8);
    }

    // Display descriptors start at offset 54 too, but DTDs 1..4 occupy bytes
    // 54..125 in 18-byte blocks. A descriptor block is a "display descriptor"
    // (not a DTD) when bytes 0..1 are 0; in that case byte 3 is the tag:
    //   0xFC = Display Product Name (ASCII, up to 13 bytes, LF-terminated)
    for (int i = 0; i < 4; ++i) {
        const uint8_t* d = edid + 54 + 18 * i;
        if (d[0] == 0 && d[1] == 0 && d[2] == 0 && d[3] == 0xFC) {
            char name[14] = {0};
            std::memcpy(name, d + 5, 13);
            // EDID descriptors are LF-terminated or space-padded; trim.
            for (int j = 0; j < 13; ++j) {
                if (name[j] == '\n' || name[j] == '\r') { name[j] = '\0'; break; }
            }
            for (int j = 12; j >= 0; --j) {
                if (name[j] == ' ' || name[j] == '\0') name[j] = '\0';
                else break;
            }
            out.productName = name;
        }
    }

    drmModeFreePropertyBlob(blob);
    return true;
}

std::vector<PlaneFormatModifier>
readPlaneFormats(int drmFd, uint32_t planeId, uint32_t inFormatsPropId) {
    std::vector<PlaneFormatModifier> result;
    if (inFormatsPropId == 0) return result;

    // Find the IN_FORMATS blob value on the plane.
    uint64_t blobId = 0;
    walkProperties(drmFd, planeId, DRM_MODE_OBJECT_PLANE,
        [&](const char* name, uint64_t value, const drmModePropertyRes* p) {
            if (p->prop_id == inFormatsPropId || std::strcmp(name, "IN_FORMATS") == 0) {
                blobId = value;
            }
        });
    if (!blobId) return result;

    drmModePropertyBlobRes* blob = drmModeGetPropertyBlob(drmFd, blobId);
    if (!blob || !blob->data) {
        if (blob) drmModeFreePropertyBlob(blob);
        return result;
    }
    // The IN_FORMATS blob is a drm_format_modifier_blob struct (see drm_mode.h):
    //   { u32 version; u32 flags; u32 count_formats; u32 count_modifiers;
    //     u32 formats_offset; u32 modifiers_offset; ... }
    // followed by formats[count_formats] (u32 each) and
    // modifiers[count_modifiers] (drm_format_modifier each: { formats_mask u64;
    // offset u16; pad u16; modifier u64 }). Each modifier entry's formats_mask
    // bit i means "applies to formats[offset + i]".
    const auto* hdr = static_cast<const drm_format_modifier_blob*>(blob->data);
    const uint8_t* base = static_cast<const uint8_t*>(blob->data);
    const uint32_t* formats = reinterpret_cast<const uint32_t*>(base + hdr->formats_offset);
    const auto* mods = reinterpret_cast<const drm_format_modifier*>(
        base + hdr->modifiers_offset);

    for (uint32_t i = 0; i < hdr->count_modifiers; ++i) {
        const auto& m = mods[i];
        for (uint32_t b = 0; b < 64; ++b) {
            if ((m.formats & (1ULL << b)) == 0) continue;
            const uint32_t idx = m.offset + b;
            if (idx >= hdr->count_formats) continue;
            result.push_back({formats[idx], m.modifier});
        }
    }
    drmModeFreePropertyBlob(blob);
    return result;
}

uint32_t createModeBlob(int drmFd, const drmModeModeInfo& mode) {
    uint32_t id = 0;
    if (drmModeCreatePropertyBlob(drmFd, &mode, sizeof(mode), &id) != 0) {
        LOG_ERR(Gpu, "[drm] createModeBlob failed: {}", std::strerror(errno));
        return 0;
    }
    return id;
}

std::vector<DrmMode> enumerateModesForConnector(int drmFd, uint32_t connectorId) {
    std::vector<DrmMode> out;
    drmModeConnector* c = drmModeGetConnector(drmFd, connectorId);
    if (!c) return out;
    out.reserve(c->count_modes);
    for (int i = 0; i < c->count_modes; ++i) {
        const drmModeModeInfo& m = c->modes[i];
        DrmMode entry{};
        entry.hdisplay    = m.hdisplay;
        entry.vdisplay    = m.vdisplay;
        entry.vrefreshMhz = modeRefreshMhz(m);
        entry.preferred   = (m.type & DRM_MODE_TYPE_PREFERRED) != 0;
        entry.raw         = m;
        out.push_back(entry);
    }
    drmModeFreeConnector(c);
    return out;
}

int addForeignPlaneDisables(drmModeAtomicReq* req, int drmFd, uint32_t crtcId,
                            const std::vector<uint32_t>& ownedPlaneIds) {
    drmModePlaneRes* pr = drmModeGetPlaneResources(drmFd);
    if (!pr) return 0;
    int disabled = 0;
    for (uint32_t i = 0; i < pr->count_planes; ++i) {
        const uint32_t planeId = pr->planes[i];
        if (std::find(ownedPlaneIds.begin(), ownedPlaneIds.end(), planeId)
            != ownedPlaneIds.end()) {
            continue;
        }
        drmModePlane* p = drmModeGetPlane(drmFd, planeId);
        if (!p) continue;
        const bool boundHere = p->crtc_id == crtcId;
        drmModeFreePlane(p);
        if (!boundHere) continue;
        uint32_t fbProp = 0, crtcProp = 0;
        walkProperties(drmFd, planeId, DRM_MODE_OBJECT_PLANE,
                       [&](const char* name, uint64_t, const drmModePropertyRes* prop) {
            if (std::strcmp(name, "FB_ID") == 0) fbProp = prop->prop_id;
            else if (std::strcmp(name, "CRTC_ID") == 0) crtcProp = prop->prop_id;
        });
        if (!fbProp || !crtcProp) continue;
        drmModeAtomicAddProperty(req, planeId, fbProp, 0);
        drmModeAtomicAddProperty(req, planeId, crtcProp, 0);
        LOG_INFO(Gpu, "[kms] disabling foreign plane {} on crtc {} "
                 "(left latched by a previous DRM master)",
                 planeId, crtcId);
        ++disabled;
    }
    drmModeFreePlaneResources(pr);
    return disabled;
}

bool findMode(int drmFd, uint32_t connectorId,
              uint32_t width, uint32_t height, uint32_t refreshMhz,
              DrmMode& outMode) {
    drmModeConnector* c = drmModeGetConnector(drmFd, connectorId);
    if (!c) return false;
    bool found = false;
    // ~100 mHz tolerance: a real connector reports 59940 / 60000 / 60001
    // for nominal 60 Hz; an EDID-derived request may quote any of those.
    constexpr uint32_t kRefreshTolerance = 100;
    for (int i = 0; i < c->count_modes; ++i) {
        const drmModeModeInfo& m = c->modes[i];
        if (m.hdisplay != width || m.vdisplay != height) continue;
        if (refreshMhz != 0) {
            const uint32_t mr = modeRefreshMhz(m);
            const uint32_t delta = mr > refreshMhz ? mr - refreshMhz : refreshMhz - mr;
            if (delta > kRefreshTolerance) continue;
        }
        outMode.hdisplay    = m.hdisplay;
        outMode.vdisplay    = m.vdisplay;
        outMode.vrefreshMhz = modeRefreshMhz(m);
        outMode.preferred   = (m.type & DRM_MODE_TYPE_PREFERRED) != 0;
        outMode.raw         = m;
        found = true;
        break;
    }
    drmModeFreeConnector(c);
    return found;
}

}  // namespace overdraw::gpu
