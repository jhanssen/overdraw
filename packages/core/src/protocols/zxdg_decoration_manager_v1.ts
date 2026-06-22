// zxdg_decoration_manager_v1 + zxdg_toplevel_decoration_v1: lets a client
// know whether decorations are drawn client-side (CSD) or server-side (SSD).
//
// This compositor always replies SERVER_SIDE: the request is acknowledged,
// the client's set_mode preference is ignored, and the configure event
// signals SSD on first construction and on every subsequent set_mode /
// unset_mode. The actual drawing of decorations is decoupled from the
// protocol -- it lives in the decoration broker (packages/core/src/
// decorations.ts) which matches per-app_id-regex plugins. A client that
// binds this protocol gets the signal to suppress its own CSD; a client
// that doesn't bind it continues to self-decorate (so an app_id with no
// matching decoration plugin shows its CSD).
//
// Spec error handling:
//   - already_constructed (a second get_toplevel_decoration on the same
//     xdg_toplevel) is posted as a fatal protocol error.
//   - unconfigured_buffer / orphaned are commit-/lifetime-ordering errors the
//     xdg_toplevel itself already orders (first-configure-then-buffer), so they
//     don't arise on this path. set_mode takes a typed `mode` enum arg with no
//     spec error for out-of-range values, so it stays a no-op.

import { signature as decoSig } from "#protocols-gen/zxdg_toplevel_decoration_v1.js";
import { ZxdgToplevelDecorationV1_Error } from "#protocols-gen/zxdg_toplevel_decoration_v1.js";
import type { ZxdgDecorationManagerV1Handler } from "#protocols-gen/zxdg_decoration_manager_v1.js";
import type { ZxdgToplevelDecorationV1Handler } from "#protocols-gen/zxdg_toplevel_decoration_v1.js";

import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

const MODE = decoSig.enums.mode.entries;   // { client_side: 1, server_side: 2 }

// xdg_toplevel resources that already have a decoration object. Enforces
// the one-decoration-per-toplevel invariant from the spec. Entries are
// dropped when the matching decoration is destroyed.
const decoratedToplevels = new WeakSet<Resource>();

// zxdg_toplevel_decoration_v1 resource -> xdg_toplevel it decorates, so
// the destructor can find which toplevel to release.
const toplevelOfDecoration = new WeakMap<Resource, Resource>();

export default function makeDecorationManager(ctx: Ctx): ZxdgDecorationManagerV1Handler {
  return {
    destroy(_resource) {
      // Destructor: trampoline tears the resource down. Existing
      // decoration objects survive (per spec).
    },
    get_toplevel_decoration(resource, id, toplevel) {
      if (decoratedToplevels.has(toplevel)) {
        ctx.addon.postError(resource, ZxdgToplevelDecorationV1_Error.already_constructed,
          "xdg_toplevel already has a decoration object");
        return;
      }
      decoratedToplevels.add(toplevel);
      toplevelOfDecoration.set(id, toplevel);
      // Initial configure: send SERVER_SIDE up-front, before the client
      // calls set_mode. Clients that look at the first configure to decide
      // whether to draw CSD get the right answer immediately.
      ctx.events.zxdg_toplevel_decoration_v1.send_configure(id, MODE.server_side);
    },
  };
}

export function makeToplevelDecoration(ctx: Ctx): ZxdgToplevelDecorationV1Handler {
  return {
    destroy(resource) {
      // Drop the toplevel->decoration mapping so the client may create a
      // new decoration on the same toplevel after this one is gone. Per
      // spec, destroying the decoration switches back to "a mode without
      // server-side decorations at the next commit" -- this compositor
      // doesn't toggle decoration drawing based on the protocol state
      // (the decoration broker decides per-app_id, independent of this
      // protocol). A client that was suppressing its CSD because of the
      // SSD configure will re-engage CSD if it watches its decoration
      // resource lifetime.
      const toplevel = toplevelOfDecoration.get(resource);
      if (toplevel) {
        decoratedToplevels.delete(toplevel);
        toplevelOfDecoration.delete(resource);
      }
    },
    set_mode(resource, _mode) {
      // The client requests a mode. We ignore it and always reply SSD --
      // the compositor's policy is "decorations are server-side". A
      // client that prefers CSD gets the signal that the compositor
      // disagrees; well-behaved clients then suppress their CSD.
      // invalid_mode (out-of-range enum value) is silent-dropped along
      // with the rest.
      ctx.events.zxdg_toplevel_decoration_v1.send_configure(resource, MODE.server_side);
    },
    unset_mode(resource) {
      // Client defers to the compositor. Same answer: SSD.
      ctx.events.zxdg_toplevel_decoration_v1.send_configure(resource, MODE.server_side);
    },
  };
}
