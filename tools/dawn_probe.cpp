// Minimal link/runtime probe for the Dawn wire bundle.
//
// Exercises both static libs: webgpu_dawn (native instance creation) and
// webgpu_dawn_wire (client proc table). Prints a couple of facts to confirm
// the download/extract/find_package/link path is sound. Not part of the
// compositor; delete once real native targets exist.

#include <cstdio>

#include <dawn/webgpu_cpp.h>
#include <dawn/wire/WireClient.h>

int main() {
    // From libwebgpu_dawn.a
    wgpu::InstanceDescriptor desc{};
    wgpu::Instance instance = wgpu::CreateInstance(&desc);
    std::printf("native instance created: %s\n", instance ? "yes" : "no");

    // From libwebgpu_dawn_wire.a
    const DawnProcTable& wireProcs = dawn::wire::client::GetProcs();
    std::printf("wire client proc table: %s\n",
                wireProcs.createInstance ? "available" : "missing");

    return (instance && wireProcs.createInstance) ? 0 : 1;
}
