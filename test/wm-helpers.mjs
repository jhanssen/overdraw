// An inline layout driver factory for WM tests: runs master-stack
// synchronously inside compute() (still returns a Promise per the
// contract, resolving on the next microtask). Skips the runtime + Worker
// spawn so WM tests stay fast and deterministic. The algorithm itself is
// tested in test/plugin-layout-default/.

import { createLayoutDriver } from '../packages/core/dist/wm/layout-driver.js';
import { masterStackLayout } from '../packages/plugin-layout-default/dist/master-stack.js';

export function inlineMasterStackDriverFactory(target, snapshot) {
  return createLayoutDriver({
    target,
    snapshot,
    compute: async (inputs) => {
      const rects = masterStackLayout(
        inputs.windows.length,
        { width: inputs.output.rect.width, height: inputs.output.rect.height },
      );
      return {
        rects: inputs.windows.map((w, i) => ({
          id: w.id,
          outer: {
            x: rects[i].x + inputs.output.rect.x,
            y: rects[i].y + inputs.output.rect.y,
            width: rects[i].width,
            height: rects[i].height,
          },
        })),
      };
    },
  });
}
