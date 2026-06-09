// Shared helpers for WM tests. The WM is layout-policy-agnostic post-Phase
// 2: it delegates to a LayoutDriver, which in production goes through the
// runtime + bundled layout plugin. WM tests inject an INLINE driver so they
// stay fast (no worker spawn) and synchronous-ish (compute() resolves on
// the next microtask).
//
// The inline driver runs the master-stack algorithm directly. It exists
// only to give WM tests a deterministic layout to assert against; the
// algorithm itself is tested in test/plugin-layout-default/.
//
// The inline driver runs the master-stack algorithm directly. It exists
// only to give WM tests a deterministic layout to assert against; the
// algorithm itself is tested in test/plugin-layout-default/.

import { createLayoutDriver } from '../packages/core/dist/wm/layout-driver.js';
import { masterStackLayout } from '../packages/plugin-layout-default/dist/master-stack.js';

// Build an inline layout driver factory that the WM tests can pass via
// WmOptions.layoutDriverFactory. The driver runs master-stack synchronously
// inside compute() (still returns a Promise per the contract; resolves on
// the next microtask).
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
