// Plugin-side sdk.cursor surface. The cursor system has three priority
// layers in core:
//   1. Plugin explicit override (setShape / setImage)        -- this SDK
//   2. Client cursor (wl_pointer.set_cursor / cursor-shape)  -- the seat
//   3. Plugin default (setDefault) + built-in default        -- this SDK
//
// Plus a declarative rule system (defineRule) that installs into the same
// priority-1 slot when a rule predicate matches. Explicit overrides win
// over rules.
//
// Worker-thread plugins are supported for shape rules + setShape /
// setDefault / hide / show / clearOverride (resolver-driven). setImage
// and texture-outcome rules require GPU access on the core device; for
// Worker plugins those throw a clear "not yet implemented" error. In-
// thread bundled plugins get full support including setImage.

import type { Endpoint, Json } from "./protocol.js";
import type {
  CursorAPI, CursorRuleSpec, CursorRuleHandle, CursorTexture,
} from "@overdraw/cursor-types";

export interface CursorControl {
  cursor: CursorAPI;
  release(): void;
}

export function createPluginCursor(endpoint: Endpoint): CursorControl {
  // Track rule handles so release() can unregister all of them.
  const activeRules = new Set<number>();

  const cursor: CursorAPI = {
    async setShape(name): Promise<void> {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("setShape name must be a non-empty string");
      }
      await endpoint.request("cursor.set-shape", { name });
    },

    async setImage(texture): Promise<void> {
      validateTexture(texture);
      // The handle field carries a GPUTexture (in-thread plugins) or
      // would be a Worker-side cross-device reference (rejected v1).
      // Cast through unknown so the Json union doesn't object to an
      // opaque GPUTexture object reference.
      // eslint-disable-next-line no-restricted-syntax -- opaque handle
      const handle = texture.handle as unknown as Json;
      await endpoint.request("cursor.set-image", {
        handle,
        width: texture.width,
        height: texture.height,
        hotspotX: texture.hotspotX,
        hotspotY: texture.hotspotY,
      });
    },

    async hide(): Promise<void> { await endpoint.request("cursor.hide", null); },
    async show(): Promise<void> { await endpoint.request("cursor.show", null); },
    async clearOverride(): Promise<void> {
      await endpoint.request("cursor.clear-override", null);
    },

    async setDefault(shape): Promise<void> {
      if (shape !== null && typeof shape !== "string") {
        throw new TypeError("setDefault shape must be a string or null");
      }
      await endpoint.request("cursor.set-default", { shape });
    },

    async defineRule(spec): Promise<CursorRuleHandle> {
      validateRuleSpec(spec);
      // serializeRule produces a plain object; the cast is needed
      // because Json doesn't accept GPUTexture references inside.
      // eslint-disable-next-line no-restricted-syntax -- opaque handles
      const payload = serializeRule(spec) as unknown as Json;
      const r = await endpoint.request("cursor.define-rule", payload);
      const ruleId = (r as { ruleId: number }).ruleId;
      activeRules.add(ruleId);
      return {
        unregister: async () => {
          if (!activeRules.has(ruleId)) return;
          activeRules.delete(ruleId);
          await endpoint.request("cursor.unregister-rule", { ruleId });
        },
      };
    },
  };

  return {
    cursor,
    release(): void {
      // Best-effort unregister all outstanding rules. The plugin may
      // have crashed; the broker tracks ownership by plugin name and
      // will clean up anyway, but explicit unregister gives prompt
      // teardown when the plugin exits cleanly.
      for (const id of activeRules) {
        endpoint.request("cursor.unregister-rule", { ruleId: id })
          .catch(() => { /* ignore: plugin tearing down */ });
      }
      activeRules.clear();
    },
  };
}

function validateTexture(t: CursorTexture): void {
  if (!t || typeof t !== "object") {
    throw new TypeError("setImage texture must be an object");
  }
  if (typeof t.width !== "number" || t.width <= 0) {
    throw new TypeError("setImage texture.width must be a positive number");
  }
  if (typeof t.height !== "number" || t.height <= 0) {
    throw new TypeError("setImage texture.height must be a positive number");
  }
  if (typeof t.hotspotX !== "number" || typeof t.hotspotY !== "number") {
    throw new TypeError("setImage hotspot must be numbers");
  }
}

function validateRuleSpec(s: CursorRuleSpec): void {
  if (!s || typeof s !== "object") {
    throw new TypeError("defineRule spec must be an object");
  }
  const hasShape = s.shape !== undefined;
  const hasTexture = s.texture !== undefined;
  if (hasShape === hasTexture) {
    throw new TypeError("defineRule: exactly one of shape | texture must be set");
  }
  if (hasShape && typeof s.shape !== "string") {
    throw new TypeError("defineRule: shape must be a string");
  }
  if (hasTexture) validateTexture(s.texture as CursorTexture);
  if (!s.when || typeof s.when !== "object") {
    throw new TypeError("defineRule: when must be an object");
  }
}

// Convert the rule spec to a wire-safe payload. The texture's `handle`
// field is opaque; for in-thread plugins it's a GPUTexture (which the
// broker recognizes by the loader-supplied bundle); for Worker plugins
// it would need to be a serializable identifier. The broker rejects
// texture rules from Worker callers.
function serializeRule(spec: CursorRuleSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { when: { ...spec.when } };
  if (spec.shape !== undefined) out.shape = spec.shape;
  if (spec.texture !== undefined) {
    out.texture = {
      handle: spec.texture.handle,
      width: spec.texture.width,
      height: spec.texture.height,
      hotspotX: spec.texture.hotspotX,
      hotspotY: spec.texture.hotspotY,
    };
  }
  if (spec.enlarge !== undefined) out.enlarge = spec.enlarge;
  return out;
}
