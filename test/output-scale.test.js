import { test } from "node:test";
import assert from "node:assert/strict";

import {
  snapScale, edidScaleFallback, resolveScale, logicalSize,
} from "../packages/core/dist/output/scale.js";

test("snapScale rounds to quarter steps and clamps to [1,3]", () => {
  assert.equal(snapScale(1), 1);
  assert.equal(snapScale(1.5), 1.5);
  assert.equal(snapScale(1.6), 1.5);
  assert.equal(snapScale(1.13), 1.25);
  assert.equal(snapScale(0.5), 1);      // clamp low
  assert.equal(snapScale(9), 3);        // clamp high
  assert.equal(snapScale(0), 1);        // invalid -> 1
  assert.equal(snapScale(-2), 1);       // invalid -> 1
});

test("edidScaleFallback derives from DPI (snapped)", () => {
  // 2560x1600 @ 344x215mm ~= 189 DPI -> ~1.97 -> snaps to 2.
  assert.equal(edidScaleFallback(2560, 1600, 344, 215), 2);
  // 1920x1080 @ 509x286mm ~= 96 DPI -> 1.
  assert.equal(edidScaleFallback(1920, 1080, 509, 286), 1);
  // Unknown physical size -> 1.
  assert.equal(edidScaleFallback(2560, 1600, 0, 0), 1);
});

test("edidScaleFallback: integer deadzone collapses near-1x and near-2x panels", () => {
  // 34" ultrawide 3440x1440 @ 800x335mm ~= 109 DPI -> raw ~1.14, inside the
  // deadzone of 1.0 -> 1.0 (not a pointless 1.067 fractional scale).
  assert.equal(edidScaleFallback(3440, 1440, 800, 335), 1);
  // 24" 4K 3840x2160 @ 530x300mm ~= 184 DPI -> raw ~1.92, inside the deadzone
  // of 2.0 -> a clean 2.0.
  assert.equal(edidScaleFallback(3840, 2160, 530, 300), 2);
  // A density solidly between integers keeps its exact (integer-logical)
  // fractional scale rather than being pulled to an integer: 27.5" 4K
  // @ 608x342mm ~= 160 DPI -> raw ~1.67 -> 5/3, logical 2304x1296.
  const s = edidScaleFallback(3840, 2160, 608, 342);
  assert.ok(Math.abs(s - 5 / 3) < 1e-9, `expected ~1.667, got ${s}`);
  assert.equal(3840 / s, 2304);
  assert.equal(2160 / s, 1296);
});

// 4K monitor at 1.75x raw scale: a naive quarter-step round would produce
// 1.75, but 3840/1.75 = 2194.286 (not integer). The integer-logical search
// retargets to a nearby scale that divides cleanly. 1.6 yields 2400x1350
// exact; further-away candidates like 2.0 (1920x1080) are passed over in
// favor of the closer 1.6.
test("snapScale (with device dims) avoids fractional logical pixels", () => {
  // 3840x2160 with raw 1.75 -> snap to integer-logical neighbor.
  const s = edidScaleFallback(3840, 2160, 600, 340);  // ~1.75 raw DPI
  const lw = 3840 / s;
  const lh = 2160 / s;
  assert.equal(lw, Math.round(lw), `logical width ${lw} not integer at scale ${s}`);
  assert.equal(lh, Math.round(lh), `logical height ${lh} not integer at scale ${s}`);
  // Reality check: should land within a sensible range, not jump to 1.0.
  assert.ok(s > 1.0 && s <= 2.0, `scale ${s} outside expected range`);
});

test("resolveScale: config wins, else EDID auto (gated), else 1", () => {
  // Explicit config overrides everything (snapped).
  assert.equal(resolveScale({
    configScale: 1.5, deviceWidth: 2560, deviceHeight: 1600,
    physicalWidthMm: 344, physicalHeightMm: 215, allowEdidAuto: true,
  }), 1.5);
  // No config, auto allowed -> EDID-derived.
  assert.equal(resolveScale({
    configScale: null, deviceWidth: 2560, deviceHeight: 1600,
    physicalWidthMm: 344, physicalHeightMm: 215, allowEdidAuto: true,
  }), 2);
  // No config, auto NOT allowed (nested) -> 1 even with phys size.
  assert.equal(resolveScale({
    configScale: null, deviceWidth: 2560, deviceHeight: 1600,
    physicalWidthMm: 344, physicalHeightMm: 215, allowEdidAuto: false,
  }), 1);
});

test("logicalSize divides device by scale, rounds, floors at 1", () => {
  assert.deepEqual(logicalSize(2560, 1600, 1), { width: 2560, height: 1600 });
  assert.deepEqual(logicalSize(2560, 1600, 2), { width: 1280, height: 800 });
  assert.deepEqual(logicalSize(2560, 1600, 1.5), { width: 1707, height: 1067 });
  assert.deepEqual(logicalSize(10, 10, 0), { width: 10, height: 10 }); // bad scale -> 1
});
