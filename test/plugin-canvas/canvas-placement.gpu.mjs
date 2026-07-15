// GPU integration: placement rules targeting workspaces (canvas world mode
// + plugin-window-rules). A rule's `workspace` field routes a matching
// client to that named workspace at map time -- created on reference,
// quiet by default (the shown workspace and camera stay put) -- and
// `show: true` makes the placement grab attention instead. End-to-end:
// real client with --app-id, the rules plugin's preconfigure stamp, the
// canvas plugin's placement resolver.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches, settled } from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const FILL = "--fill-configured";

function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}

async function readUntil(c, pred, { timeoutMs = 3000 } = {}) {
  return await settled(() => c.frameReadback(),
    (px) => px && pred(px),
    { timeoutMs, intervalMs: 16, what: "frame readback" });
}

test("placement rules: quiet routing to a named workspace; show grabs attention", { skip }, async () => {
  const c = await setupCompositor({
    headless: OUT,
    config: {
      canvas: { world: true },
      windowRules: [
        { match: { appId: "^chat$" }, workspace: "comms" },
        { match: { appId: "^player$" }, workspace: "media", show: true },
      ],
    },
  });
  try {
    const cA = 0xff3030c0;   // blue-ish: unruled anchor on ws1
    const cB = 0xff30c030;   // green-ish: ruled quiet -> "comms"
    const cC = 0xffc03030;   // red-ish: ruled show -> "media"
    const bgraA = argbToBgra(cA);

    const a = c.spawnClient([FILL, "--color", cA.toString(16)]);
    await a.ready;
    const s1 = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "A mapped" });
    const aId = s1.windows[0].surfaceId;
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), bgraA, 4));

    // Quiet placement: chat lands on "comms" (created on reference,
    // hidden); the view never changes and A keeps the screen.
    const b = c.spawnClient([FILL, "--color", cB.toString(16), "--app-id", "chat"]);
    await b.ready;
    const s2 = await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "chat mapped" });
    const bId = s2.windows.find((w) => w.surfaceId !== aId).surfaceId;
    const wsList = await settled(
      () => c.runtime.invokeAction("workspace.list", {}),
      (l) => l.some((w) => w.name === "comms"),
      { what: "comms created" });
    const comms = wsList.find((w) => w.name === "comms");
    assert.deepEqual(comms.members, [bId], "chat routed to comms");
    let cur = await c.runtime.invokeAction("workspace.current", {});
    assert.equal(cur.index, 1, "shown workspace untouched by quiet placement");
    assert.equal(c.query().outputs[0].cameraX, 0, "camera never moved");
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), bgraA, 4));

    // Attention placement: player lands on "media" and shows it -- the
    // camera docks on the new workspace's slot and the client composites.
    const d = c.spawnClient([FILL, "--color", cC.toString(16), "--app-id", "player"]);
    await d.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 3, { what: "player mapped" });
    cur = await settled(
      () => c.runtime.invokeAction("workspace.current", {}),
      (w) => w?.name === "media",
      { what: "media shown" });
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x > 0, { what: "camera docked on media's slot" });
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), argbToBgra(cC), 4));

    // Switching to comms by name reaches the quietly-placed window.
    await c.runtime.invokeAction("workspace.show", { name: "comms" });
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), argbToBgra(cB), 4));
  } finally {
    await c.teardown();
  }
});
