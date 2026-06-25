// zxdg_exporter_v2 + zxdg_importer_v2 + zxdg_exported_v2 + zxdg_imported_v2
// (xdg-foreign-unstable-v2): cross-process surface handoff.
//
// One client exports a wl_surface (its main toplevel) and receives an
// opaque ASCII handle string. It sends that string (typically over
// D-Bus) to another client (a portal, a file chooser). The recipient
// imports the handle, getting an opaque zxdg_imported_v2, and uses
// set_parent_of to mark one of ITS own toplevels as a transient child
// of the original surface.
//
// The portal file-chooser flow that GIMP uses works like this:
//   1. GIMP gets a zxdg_exporter_v2 global.
//   2. GIMP.export_toplevel(its-main-wl_surface).
//   3. Compositor mints a handle string, sends it back via
//      zxdg_exported_v2.handle.
//   4. GIMP forwards the handle to xdg-desktop-portal over D-Bus.
//   5. Portal binds zxdg_importer_v2 and calls import_toplevel(handle).
//   6. Portal calls zxdg_imported_v2.set_parent_of(its-file-chooser-surface).
//   7. Compositor routes that into wm.propose({ parent: gimpSurfaceId }) for
//      the portal's surface.
//
// Effects of the parent relationship are entirely owned by the WM (see
// wm/index.ts assignZForMap and raiseStackedDescendants): the child raises
// with the parent under the raise-with rule, and -- if the importing client
// also sets the dialog as modal via xdg_dialog_v1 -- focus + input gating
// engage too. xdg_foreign itself only establishes the parent edge.
//
// Lifecycle:
//   - zxdg_exported_v2 lives as long as the exporter wants the handle to
//     be importable. When destroyed, every outstanding zxdg_imported_v2
//     based on its handle receives `destroyed` and ceases to function.
//   - If the EXPORTER'S wl_surface is destroyed first, the handle stays
//     mappable in the registry but resolves to no live surface; an in-
//     flight import_toplevel on the handle still mints a zxdg_imported_v2
//     for spec compliance (the client gets an immediate `destroyed` event
//     before any further use).

import { randomBytes } from "node:crypto";

import type { ZxdgExporterV2Handler } from "#protocols-gen/zxdg_exporter_v2.js";
import type { ZxdgImporterV2Handler } from "#protocols-gen/zxdg_importer_v2.js";
import type { ZxdgExportedV2Handler } from "#protocols-gen/zxdg_exported_v2.js";
import type { ZxdgImportedV2Handler } from "#protocols-gen/zxdg_imported_v2.js";
import { ZxdgExporterV2_Error } from "#protocols-gen/zxdg_exporter_v2.js";

import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

// Module-local registry: handle string -> exporter wl_surface id + the
// zxdg_exported_v2 resource that minted it. A given exporter surface may
// be exported multiple times (each export gets its own handle and its
// own exported resource, per spec). When the exported resource is
// destroyed, the handle is invalidated and every dependent imported is
// notified.
interface ExportEntry {
  handle: string;
  surfaceId: number;
  exported: Resource;
  // Every zxdg_imported_v2 resource minted from this handle. Used to
  // fire `destroyed` on each when the export goes away.
  imports: Set<Resource>;
}

const exportsByHandle = new Map<string, ExportEntry>();
const exportByResource = new WeakMap<Resource, ExportEntry>();

// Per-imported state. importToExport tracks which export an imported
// resource was minted from (so destroy() can deregister); importedTarget
// tracks the child wl_surface set via set_parent_of so a subsequent
// destroy() can clear the parent on the child's WindowState.
interface ImportEntry {
  export: ExportEntry;
  // The child surfaceId whose `parent` was set via set_parent_of, or
  // null if set_parent_of hasn't been called yet (or was called with a
  // surface we can't resolve).
  childSurfaceId: number | null;
}
const imports = new WeakMap<Resource, ImportEntry>();

// 32 hex chars. Cryptographically random so handles can't be guessed by
// a malicious unrelated client (a sandbox-escape vector if guessable).
function mintHandle(): string {
  return randomBytes(16).toString("hex");
}

// Resolve a wl_surface resource to its surface id. The wl_surface
// handler stashes its id on the SurfaceRecord; we look it up via
// state.surfaces. Returns null when the surface is unknown.
function surfaceIdOf(ctx: Ctx, surface: Resource): number | null {
  const rec = ctx.state.surfaces?.get(surface);
  return rec?.id ?? null;
}

// Resolve a wl_surface to its xdg_toplevel role (the surface must have
// been get_toplevel'd). Returns true iff it's a toplevel-role surface.
function isXdgToplevel(ctx: Ctx, surface: Resource): boolean {
  const rec = ctx.state.surfaces?.get(surface);
  return rec?.role === "xdg_toplevel";
}

export default function makeExporter(ctx: Ctx): ZxdgExporterV2Handler {
  return {
    destroy(_resource) {
      // Destructor; outstanding zxdg_exported_v2 resources survive.
    },
    export_toplevel(resource, id, surface) {
      if (!isXdgToplevel(ctx, surface)) {
        ctx.addon.postError(resource, ZxdgExporterV2_Error.invalid_surface,
          "exported surface is not an xdg_toplevel");
        return;
      }
      const surfaceId = surfaceIdOf(ctx, surface);
      if (surfaceId === null) return; // gone between role-assignment and now
      const handle = mintHandle();
      const entry: ExportEntry = {
        handle, surfaceId, exported: id, imports: new Set(),
      };
      exportsByHandle.set(handle, entry);
      exportByResource.set(id, entry);
      // Send the handle immediately. The spec is explicit:
      // "xdg_exported.handle will be sent immediately".
      ctx.events.zxdg_exported_v2.send_handle(id, handle);
    },
  };
}

export function makeExported(_ctx: Ctx): ZxdgExportedV2Handler {
  return {
    destroy(resource) {
      const entry = exportByResource.get(resource);
      if (!entry) return;
      // Notify every dependent import that the handle is now invalid.
      // We don't tear down the imported resources here -- the client
      // owns their lifetime via xdg_imported.destroy. Just signal.
      for (const imported of entry.imports) {
        // Spec: "any relationship set up has been invalidated. This may
        // happen ... if the exported surface or the exported surface
        // handle has been destroyed."
        _ctx.events.zxdg_imported_v2.send_destroyed(imported);
        // Clear the parent edge on the child (if any) so the WM's
        // stacking semantics don't keep a dangling parent reference.
        const importEntry = imports.get(imported);
        if (importEntry && importEntry.childSurfaceId !== null) {
          void _ctx.state.wm?.propose(importEntry.childSurfaceId,
            { parent: null }, "client-request");
          importEntry.childSurfaceId = null;
        }
      }
      exportsByHandle.delete(entry.handle);
      exportByResource.delete(resource);
    },
  };
}

export function makeImporter(ctx: Ctx): ZxdgImporterV2Handler {
  return {
    destroy(_resource) {
      // Destructor; outstanding zxdg_imported_v2 resources survive.
    },
    import_toplevel(_resource, id, handle) {
      const entry = exportsByHandle.get(handle);
      if (!entry) {
        // Spec: an unknown handle still mints a valid imported resource
        // but the client should immediately receive `destroyed`.
        ctx.events.zxdg_imported_v2.send_destroyed(id);
        return;
      }
      entry.imports.add(id);
      imports.set(id, { export: entry, childSurfaceId: null });
    },
  };
}

export function makeImported(ctx: Ctx): ZxdgImportedV2Handler {
  return {
    destroy(resource) {
      const entry = imports.get(resource);
      if (!entry) return;
      entry.export.imports.delete(resource);
      // Clear the parent edge on the child if one was set.
      if (entry.childSurfaceId !== null) {
        void ctx.state.wm?.propose(entry.childSurfaceId,
          { parent: null }, "client-request");
      }
      imports.delete(resource);
    },
    set_parent_of(resource, surface) {
      const entry = imports.get(resource);
      if (!entry) return;
      if (!isXdgToplevel(ctx, surface)) {
        ctx.addon.postError(resource,
          // zxdg_imported_v2 has its own invalid_surface error (value 0).
          // Inline the value rather than importing the const to avoid
          // a cross-protocol dependency.
          0,
          "child surface is not an xdg_toplevel");
        return;
      }
      const childId = surfaceIdOf(ctx, surface);
      if (childId === null || !ctx.state.wm) return;
      entry.childSurfaceId = childId;
      // The exporter's surfaceId is the parent. xdg-foreign-unstable-v2
      // is explicit: "the same stacking and positioning semantics as
      // xdg_toplevel.set_parent." So this is a regular parent edge --
      // modal-ness is a separate concern (xdg_dialog.set_modal).
      void ctx.state.wm.propose(childId,
        { parent: entry.export.surfaceId }, "client-request");
    },
  };
}

// Test-only reset hook. The module-level registry persists across
// installProtocols() calls; integration tests that build multiple
// compositors in one process clear it between them.
export function _resetForTests(): void {
  exportsByHandle.clear();
}
