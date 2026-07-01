#pragma once

#include <node_api.h>

namespace overdraw::core {

// Registers spawnChild / reapChildren on the addon exports. spawnChild launches
// a client process that dies with the compositor (PR_SET_PDEATHSIG), so a
// spawned GUI client is never orphaned holding GPU memory across a compositor
// exit; reapChildren clears any that have since exited.
void RegisterSpawn(napi_env env, napi_value exports);

}  // namespace overdraw::core
