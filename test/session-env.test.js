import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionEnvAssignments, SESSION_ENV_NAMES } from "../packages/core/dist/session-env.js";

test("assignments carry explicit values, not process env", () => {
  const prev = process.env.XDG_CURRENT_DESKTOP;
  process.env.XDG_CURRENT_DESKTOP = "testdesk";
  try {
    const a = sessionEnvAssignments("wayland-9", ":51");
    assert.deepEqual(a, [
      "WAYLAND_DISPLAY=wayland-9",
      "XDG_CURRENT_DESKTOP=testdesk",
      "XDG_SESSION_TYPE=wayland",
      "DISPLAY=:51",
    ]);
  } finally {
    if (prev === undefined) delete process.env.XDG_CURRENT_DESKTOP;
    else process.env.XDG_CURRENT_DESKTOP = prev;
  }
});

test("DISPLAY omitted without xwayland", () => {
  const a = sessionEnvAssignments("wayland-0", null);
  assert.equal(a.some((v) => v.startsWith("DISPLAY=")), false);
});

test("every assigned var is covered by the unset list", () => {
  const assigned = sessionEnvAssignments("wayland-0", ":50")
    .map((v) => v.split("=")[0]);
  for (const name of assigned) assert.ok(SESSION_ENV_NAMES.includes(name));
});
