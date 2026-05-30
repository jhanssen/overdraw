// wl_region: rectangular region accumulation. Not used by compositing yet;
// requests are accepted and ignored for first light.

import type { Resource } from "../types.js";

export default function makeRegion() {
  return {
    add(_resource: Resource, _x: number, _y: number, _w: number, _h: number) {},
    subtract(_resource: Resource, _x: number, _y: number, _w: number, _h: number) {},
    destroy(_resource: Resource) {},
  };
}
