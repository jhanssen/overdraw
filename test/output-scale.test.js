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
