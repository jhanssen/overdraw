// wl_region: rectangular region accumulation. Not used by compositing yet;
// requests are accepted and ignored for first light.

import type { WlRegionHandler } from "#protocols-gen/wl_region.js";

export default function makeRegion(): WlRegionHandler {
  return {
    add(_resource, _x, _y, _w, _h) {},
    subtract(_resource, _x, _y, _w, _h) {},
    destroy(_resource) {},
  };
}
