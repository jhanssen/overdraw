#include "interface_registry.h"

#include <wayland-util.h>

namespace overdraw::wayland {

void InterfaceRegistry::add(InterfaceDesc desc) {
    auto b = std::make_unique<Built>();
    b->desc = std::move(desc);
    built_[b->desc.name] = std::move(b);
}

// libwayland signature string: a leading version digit for messages introduced
// after version 1, then per-arg: '?' if nullable, then the type char. Per-arg
// since-versioning is not represented (message-level since only); this covers
// the protocols we use -- flagged as a limitation.
std::string InterfaceRegistry::buildSignature(const MessageDesc& m) const {
    std::string s;
    if (m.since > 1) s += std::to_string(m.since);
    for (const auto& a : m.args) {
        if (a.allowNull) s += '?';
        s += a.type;
    }
    return s;
}

bool InterfaceRegistry::build(std::string& err) {
    if (isBuilt_) return true;

    // Pass 1: per interface, allocate the wl_interface shell and the backing
    // storage (signatures, per-message types vectors). Reserve signatures up
    // front so the c_str() pointers handed to wl_message stay stable.
    for (auto& [name, b] : built_) {
        (void)name;
        const size_t nReq = b->desc.requests.size();
        const size_t nEv = b->desc.events.size();
        b->requests.resize(nReq);
        b->events.resize(nEv);
        b->signatures.reserve(nReq + nEv);
        b->types.reserve(nReq + nEv);
        for (const auto& m : b->desc.requests) {
            b->signatures.push_back(buildSignature(m));
            b->types.emplace_back(m.args.size(), nullptr);
        }
        for (const auto& m : b->desc.events) {
            b->signatures.push_back(buildSignature(m));
            b->types.emplace_back(m.args.size(), nullptr);
        }
        b->iface = std::make_unique<wl_interface>();
    }

    // Pass 2: every shell now exists; resolve object/new_id types[] across
    // interfaces and wire the wl_message + wl_interface fields.
    for (auto& [name, b] : built_) {
        (void)name;
        size_t sigIdx = 0;
        auto wire = [&](const std::vector<MessageDesc>& msgs,
                        std::vector<wl_message>& out) -> bool {
            for (size_t i = 0; i < msgs.size(); ++i, ++sigIdx) {
                auto& typeVec = b->types[sigIdx];
                for (size_t a = 0; a < msgs[i].args.size(); ++a) {
                    const ArgDesc& arg = msgs[i].args[a];
                    if ((arg.type == 'o' || arg.type == 'n') && !arg.interface.empty()) {
                        auto it = built_.find(arg.interface);
                        if (it == built_.end()) {
                            // Cross-protocol references to interfaces this
                            // compositor does not support land here (e.g.
                            // wp_cursor_shape_v1's get_tablet_tool_v2 refers
                            // to zwp_tablet_tool_v2). libwayland accepts a
                            // null types[] slot for an object/new_id arg
                            // (treated as generic / loosely-typed). Leave
                            // it null and continue rather than refusing to
                            // build the registry.
                            typeVec[a] = nullptr;
                            continue;
                        }
                        typeVec[a] = it->second->iface.get();
                    }
                }
                out[i].name = msgs[i].name.c_str();
                out[i].signature = b->signatures[sigIdx].c_str();
                out[i].types = typeVec.empty() ? nullptr : typeVec.data();
            }
            return true;
        };
        if (!wire(b->desc.requests, b->requests)) return false;
        if (!wire(b->desc.events, b->events)) return false;

        wl_interface* wi = b->iface.get();
        wi->name = b->desc.name.c_str();
        wi->version = b->desc.version;
        wi->method_count = static_cast<int>(b->requests.size());
        wi->methods = b->requests.empty() ? nullptr : b->requests.data();
        wi->event_count = static_cast<int>(b->events.size());
        wi->events = b->events.empty() ? nullptr : b->events.data();
    }

    isBuilt_ = true;
    return true;
}

const wl_interface* InterfaceRegistry::get(const std::string& name) const {
    auto it = built_.find(name);
    return it == built_.end() ? nullptr : it->second->iface.get();
}

bool InterfaceRegistry::isRequestDestructor(const std::string& interfaceName,
                                            uint32_t opcode) const {
    auto it = built_.find(interfaceName);
    if (it == built_.end()) return false;
    const auto& reqs = it->second->desc.requests;
    if (opcode >= reqs.size()) return false;
    return reqs[opcode].isDestructor;
}

}  // namespace overdraw::wayland
