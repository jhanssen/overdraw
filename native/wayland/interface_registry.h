// Runtime construction of wl_interface from generated signature metadata.
//
// Wayland's libwayland-server normally consumes static wl_interface tables from
// wayland-scanner-generated C. Here we build them at runtime from the JS
// generator's metadata, so no per-protocol C is needed. The built structs
// (wl_interface, wl_message[], types[], and the strings they point at) are
// owned here and live for the process; libwayland holds raw pointers into them.

#ifndef OVERDRAW_WAYLAND_INTERFACE_REGISTRY_H_
#define OVERDRAW_WAYLAND_INTERFACE_REGISTRY_H_

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <wayland-util.h>  // wl_interface, wl_message must be complete (held by value)

namespace overdraw::wayland {

// Plain model of one interface's signature (filled by the addon from the JS
// metadata, then handed to the registry to build wl_interface structs).
struct ArgDesc {
    std::string name;
    char type = 0;          // i u f s o n a h
    std::string interface;  // for object/new_id; empty if none
    bool allowNull = false;
};
struct MessageDesc {
    std::string name;
    int since = 1;
    std::vector<ArgDesc> args;
};
struct InterfaceDesc {
    std::string name;
    int version = 1;
    std::vector<MessageDesc> requests;
    std::vector<MessageDesc> events;
};

class InterfaceRegistry {
  public:
    // Register an interface's metadata. Building (resolving cross-references)
    // happens in build(); register all needed interfaces first.
    void add(InterfaceDesc desc);

    // Build all wl_interface structs and resolve object/new_id type cross-
    // references. Returns false if a referenced interface was not registered.
    bool build(std::string& err);

    // The built wl_interface for `name`, or nullptr.
    const wl_interface* get(const std::string& name) const;

  private:
    struct Built {
        InterfaceDesc desc;
        std::unique_ptr<wl_interface> iface;
        std::vector<wl_message> requests;
        std::vector<wl_message> events;
        // Backing storage the wl_message/wl_interface point into.
        std::vector<std::string> signatures;  // one per message (req then ev)
        std::vector<std::vector<const wl_interface*>> types;  // one vec per message
    };

    std::string buildSignature(const MessageDesc& m) const;

    std::unordered_map<std::string, std::unique_ptr<Built>> built_;
    bool isBuilt_ = false;
};

}  // namespace overdraw::wayland

#endif  // OVERDRAW_WAYLAND_INTERFACE_REGISTRY_H_
