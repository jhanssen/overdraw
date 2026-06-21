// org_kde_kwin_server_decoration_manager + org_kde_kwin_server_decoration:
// the older SSD-negotiation protocol (predating zxdg_decoration_manager_v1).
// GTK4 in particular binds this protocol when present and uses its mode
// reply to decide whether to suppress its own client-side decorations
// (the 28x29 GTK shadow band that overflows every window when the
// compositor doesn't claim SSD); GTK only consults zxdg_decoration when
// this protocol is unavailable. Mirror that protocol's policy here:
// always reply Server mode so the client suppresses CSD; the actual
// drawing of server-side chrome is decoupled and lives in the
// decoration broker (packages/core/src/decorations.ts).
//
// Two interfaces, four messages total:
//   - manager.create(id, surface): create a per-surface decoration.
//     Server immediately emits `mode(Server)` and the bind-time
//     `default_mode(Server)`.
//   - manager: emits `default_mode(Server)` once at bind so clients
//     that don't even call create() see the SSD signal.
//   - decoration.request_mode(mode): client preference; we ignore and
//     re-emit `mode(Server)`.
//   - decoration.release: destructor.
//
// Silent-drop convention applies (no wl_resource_post_error wired): a
// repeated create() on the same surface, an out-of-range request_mode,
// etc. just no-op.

import { signature as decoSig } from "#protocols-gen/org_kde_kwin_server_decoration.js";
import type { OrgKdeKwinServerDecorationManagerHandler }
  from "#protocols-gen/org_kde_kwin_server_decoration_manager.js";
import type { OrgKdeKwinServerDecorationHandler }
  from "#protocols-gen/org_kde_kwin_server_decoration.js";

import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

// mode enum: None=0, Client=1, Server=2.
const MODE = decoSig.enums.mode.entries;

// Per-surface state, so a second create() on the same wl_surface can be
// dropped per the protocol's implicit one-per-surface invariant.
const decoratedSurfaces = new WeakSet<Resource>();

type ManagerHandler = OrgKdeKwinServerDecorationManagerHandler & {
  bind(resource: Resource): void;
};

export default function makeKdeDecorationManager(ctx: Ctx): ManagerHandler {
  return {
    // Bind-time event: announce SSD as the default so clients that
    // never call create() (some toolkits inspect the announcement and
    // skip the per-surface dance) still see the signal.
    bind(resource) {
      ctx.events.org_kde_kwin_server_decoration_manager.send_default_mode(
        resource, MODE.Server);
    },
    create(_resource, id, surface) {
      // Idempotent per (implicit) one-decoration-per-surface invariant.
      if (decoratedSurfaces.has(surface)) return;
      decoratedSurfaces.add(surface);
      // Immediately report the server's chosen mode.
      ctx.events.org_kde_kwin_server_decoration.send_mode(id, MODE.Server);
    },
  };
}

export function makeKdeDecoration(ctx: Ctx): OrgKdeKwinServerDecorationHandler {
  return {
    request_mode(resource, _mode) {
      // Client preference is ignored; the compositor's policy is SSD.
      // A well-behaved client suppresses its CSD upon receiving Server
      // here regardless of what it asked for.
      ctx.events.org_kde_kwin_server_decoration.send_mode(resource, MODE.Server);
    },
    release(_resource) {
      // Destructor: trampoline tears the resource down. The
      // decoratedSurfaces entry would be cleaned up when the
      // wl_surface itself is destroyed (WeakSet auto-purges); no
      // explicit removal needed here since the protocol allows a new
      // decoration on the same surface only after this one releases,
      // and a client that races create+release+create on the same
      // surface would just silent-drop the second create -- benign.
    },
  };
}
