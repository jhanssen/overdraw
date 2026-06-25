// xdg_wm_dialog_v1 + xdg_dialog_v1 (staging): lets a client tell the
// compositor that an xdg_toplevel is a dialog relative to its parent
// (xdg_toplevel.set_parent) and optionally that it is modal.
//
// set_modal / unset_modal route through wm.propose with
// clientRequests.wantsModal so the decision goes through the policy
// seam (resolveDecisions). Default policy honors the wish; a window-
// rules plugin may override at window.proposed.
//
// Spec error handling:
//   - already_used: a second get_xdg_dialog on the same xdg_toplevel is
//     a fatal protocol error.

import type { XdgWmDialogV1Handler } from "#protocols-gen/xdg_wm_dialog_v1.js";
import type { XdgDialogV1Handler } from "#protocols-gen/xdg_dialog_v1.js";
import { XdgWmDialogV1_Error } from "#protocols-gen/xdg_wm_dialog_v1.js";

import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

// xdg_toplevel resources that have already been turned into a dialog.
// Enforces the one-dialog-per-toplevel invariant from the spec.
const dialogedToplevels = new WeakSet<Resource>();

// xdg_dialog_v1 resource -> the xdg_toplevel it decorates, so the
// dialog's set_modal / unset_modal / destroy can look up the surfaceId.
const toplevelOfDialog = new WeakMap<Resource, Resource>();

function surfaceIdOfToplevel(ctx: Ctx, toplevel: Resource): number | null {
  const rec = ctx.state.toplevels?.get(toplevel);
  return rec?.xdgSurface?.surface?.id ?? null;
}

export default function makeWmDialog(ctx: Ctx): XdgWmDialogV1Handler {
  return {
    destroy(_resource) {
      // Destructor: trampoline tears the resource down. Existing
      // xdg_dialog_v1 children survive per spec.
    },
    get_xdg_dialog(resource, id, toplevel) {
      if (dialogedToplevels.has(toplevel)) {
        ctx.addon.postError(resource, XdgWmDialogV1_Error.already_used,
          "xdg_toplevel already has a dialog object");
        return;
      }
      dialogedToplevels.add(toplevel);
      toplevelOfDialog.set(id, toplevel);
      // No initial event -- the dialog state is implicit (not modal
      // until set_modal). The compositor's "hint that the surface is a
      // dialog" is itself unused today; the toplevel's `parent`
      // already drives the dialog-floating policy.
    },
  };
}

export function makeXdgDialog(ctx: Ctx): XdgDialogV1Handler {
  return {
    destroy(resource) {
      // Per spec: "If this object is destroyed before the related
      // xdg_toplevel, the compositor should unapply its effects."
      // I.e. clear the modal hint. The toplevel may continue to live
      // with its existing parent/state otherwise.
      const toplevel = toplevelOfDialog.get(resource);
      if (toplevel) {
        const id = surfaceIdOfToplevel(ctx, toplevel);
        if (id !== null && ctx.state.wm) {
          void ctx.state.wm.propose(id,
            { clientRequests: { wantsModal: false } }, "client-request");
        }
        dialogedToplevels.delete(toplevel);
        toplevelOfDialog.delete(resource);
      }
    },
    set_modal(resource) {
      const toplevel = toplevelOfDialog.get(resource);
      if (!toplevel) return;
      const id = surfaceIdOfToplevel(ctx, toplevel);
      if (id === null || !ctx.state.wm) return;
      void ctx.state.wm.propose(id,
        { clientRequests: { wantsModal: true } }, "client-request");
    },
    unset_modal(resource) {
      const toplevel = toplevelOfDialog.get(resource);
      if (!toplevel) return;
      const id = surfaceIdOfToplevel(ctx, toplevel);
      if (id === null || !ctx.state.wm) return;
      void ctx.state.wm.propose(id,
        { clientRequests: { wantsModal: false } }, "client-request");
    },
  };
}
