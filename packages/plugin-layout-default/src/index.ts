// Bundled master-stack layout plugin. Registers in the 'layout' namespace
// at priority 0 (the floor; bundled default). A user-installed third-party
// layout plugin claiming the same namespace at a higher priority displaces
// this one at runtime; if that plugin fails, the priority-chain promotes
// this one back.
//
// The SDK passed to init() comes from the plugin Worker's bootstrap. The
// plugin's only responsibility is to call sdk.registerPlugin('layout', ...);
// core's layout driver invokes compute() via sdk.plugin('layout').compute(...)
// (in the driver's case: directly via runtime.invokeNamespace).

import type {
  LayoutAPI, LayoutInputs, LayoutResult, LayoutParamUpdate, LayoutParamSnapshot,
} from "@overdraw/layout-types";
import type { PluginSdkShape } from "@overdraw/plugin-sdk-types";
import { masterStackLayout, DEFAULT_LAYOUT, type LayoutParams } from "./master-stack.js";

// Master-fraction bounds; matches the clamp masterStackLayout applies.
const MASTER_MIN = 0.05;
const MASTER_MAX = 0.95;

// Validate the raw config. Returns a populated LayoutParams; throws on
// schema deviation. Missing fields take the DEFAULT_LAYOUT values.
function validateConfig(raw: unknown): LayoutParams {
  if (raw === null || raw === undefined) return { ...DEFAULT_LAYOUT };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`layout config must be an object (got ${typeof raw})`);
  }
  const o = raw as { [k: string]: unknown };
  const out: LayoutParams = { ...DEFAULT_LAYOUT };
  if (o.masterFraction !== undefined) {
    if (typeof o.masterFraction !== "number"
        || !Number.isFinite(o.masterFraction)
        || o.masterFraction < MASTER_MIN || o.masterFraction > MASTER_MAX) {
      throw new TypeError(
        `layout.masterFraction must be a finite number in [${MASTER_MIN}, ${MASTER_MAX}]`);
    }
    out.masterFraction = o.masterFraction;
  }
  if (o.gap !== undefined) {
    if (typeof o.gap !== "number" || !Number.isFinite(o.gap) || o.gap < 0) {
      throw new TypeError(`layout.gap must be a non-negative finite number`);
    }
    out.gap = o.gap;
  }
  return out;
}

export default async function init(sdk: PluginSdkShape, rawConfig?: unknown): Promise<void> {
  const params: LayoutParams = validateConfig(rawConfig);

  const api: LayoutAPI = {
    async compute(inputs: LayoutInputs): Promise<LayoutResult> {
      // Master-stack only consumes window count + the working rect.
      // layoutMode, layoutData, currentRect are ignored. Tiles are
      // placed within `tileRegion` (the island's rect; for the implicit
      // per-output island that is the output minus reserved zones); the
      // core resolver dispatched non-managed presentations before we
      // were called.
      const region = inputs.tileRegion;
      const rects = masterStackLayout(
        inputs.windows.length,
        { width: region.width, height: region.height },
        params,
      );
      return {
        rects: inputs.windows.map((w, i) => ({
          id: w.id,
          outer: {
            // Translate the algorithm's region-local rect into compositor
            // coordinates by adding the tile region's origin.
            x: rects[i].x + region.x,
            y: rects[i].y + region.y,
            width: rects[i].width,
            height: rects[i].height,
          },
        })),
      };
    },

    async setParams(update: LayoutParamUpdate): Promise<LayoutParamSnapshot> {
      if (typeof update?.masterFractionDelta === "number"
          && Number.isFinite(update.masterFractionDelta)) {
        params.masterFraction = Math.min(MASTER_MAX, Math.max(MASTER_MIN,
          params.masterFraction + update.masterFractionDelta));
      }
      if (typeof update?.gapDelta === "number"
          && Number.isFinite(update.gapDelta)) {
        params.gap = Math.max(0, params.gap + update.gapDelta);
      }
      return { masterFraction: params.masterFraction, gap: params.gap };
    },
  };

  // Priority 0 is the bundled-plugin floor (set by the runtime when
  // ResolvedPlugin.bundled is true). Pass undefined here so the runtime's
  // default applies; an explicit value would shadow the bundled marker.
  await sdk.registerPlugin("layout", () => api);
  sdk.log(`master-stack layout registered (masterFraction=${params.masterFraction}, gap=${params.gap})`);
}

// Re-export the user-facing config type so plugin authors can
// `satisfies LayoutPluginConfig` from a single import.
export type { LayoutPluginConfig } from "@overdraw/layout-types";
