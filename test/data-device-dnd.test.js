// Pins the CURRENT (intentionally incomplete) drag-and-drop behavior on the
// data-device interfaces: the DnD requests are LOUD no-ops (warn once), NOT
// silent. This is the explicit "tested gap" for DnD -- clipboard is implemented;
// DnD is the next slice. When DnD is implemented, this test changes to assert the
// real behavior. GPU-free: calls the handler factories directly with a stub ctx.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeDataDevice, makeDataOffer, makeDataSource } from "../dist/protocols/wl_data_device_manager.js";

// Minimal ctx stub: the DnD no-ops only touch console.warn (not state/events).
function stubCtx() {
  return {
    events: {},
    addon: { clientId: () => 1 },
    state: {},
  };
}

// Capture console.warn for the duration of fn.
function captureWarn(fn) {
  const orig = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  try { fn(); } finally { console.warn = orig; }
  return warnings;
}

test("DnD requests are loud no-ops (not silent), pinned until DnD is implemented", () => {
  const ctx = stubCtx();
  const device = makeDataDevice(ctx);
  const source = makeDataSource(ctx);
  const offer = makeDataOffer(ctx);

  const warnings = captureWarn(() => {
    // None of these should throw; each is a DnD entry point we have not built.
    device.start_drag({}, null, {}, null, 0);
    source.set_actions({}, 0);
    offer.accept({}, 0, "text/plain");
    offer.finish({});
    offer.set_actions({}, 0, 0);
  });

  // At least one warning must have been emitted (warn-once: exactly one here,
  // since warnedDnd latches). The point is it is NOT silent.
  assert.ok(warnings.length >= 1, "DnD requests warn rather than silently no-op");
  assert.match(warnings.join("\n"), /drag-and-drop is not implemented/i,
    "warning names the unimplemented DnD gap");
});
