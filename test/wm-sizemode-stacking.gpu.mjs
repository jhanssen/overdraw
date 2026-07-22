// Stacking follows keyboard focus across sizeMode tiers, end-to-end.
//
// A fullscreen window is not a tile member: focused it draws topmost and
// covers the glass; unfocused it drops BELOW the tiled tier and its peers
// reflow over the island -- windows mapping while it exists get real
// layout slots, can be focus-cycled to, and draw above it. Unmapping a
// tiled peer reflows the survivors over the full strip (the fullscreen
// window holds no slot). A zoom (maximized) coexists with the fullscreen
// window: the game keeps its glass-sized rect (never squeezed into a
// tile slot and never reconfigured).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, waitFor } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU";

test("exclusive dominance: newcomers get rects; dominance follows focus", { skip }, async () => {
  const c = await setupCompositor({
    config: {
      canvas: { world: true, elastic: true, arrangement: "grid", gutter: 24 },
      layout: { mode: "columns", column: 0.5, masterFraction: 0.5, gap: 10 },
      focus: { policy: "follow-pointer", focusOnMap: true },
    },
  });
  try {
    const term = c.spawnClient(
      ["--title", "term", "--app-id", "term", "--color", "FF00FF00",
       "--size", "400x300", "--fill-configured"]);
    await term.ready;
    await waitFor(c.query, (s) => s.windows.length >= 1 && s.windows[0].mapped,
      { timeoutMs: 8000, what: "terminal mapped" });
    const termId = c.query().windows[0].surfaceId;

    // Fullscreen app (wayland xdg path suffices for the layout question).
    const game = c.spawnClient(
      ["--title", "game", "--app-id", "game", "--color", "FFFF0000",
       "--size", "400x300", "--fill-configured", "--initial-state", "fullscreen"]);
    await game.ready;
    await waitFor(c.query, (s) => s.windows.length >= 2,
      { timeoutMs: 8000, what: "game mapped" });
    const gameId = c.query().windows.map((w) => w.surfaceId).find((id) => id !== termId);
    await waitFor(() => c.state.wm.state.windows.find((w) => w.surfaceId === gameId),
      (w) => w?.windowState.sizeMode === "fullscreen",
      { timeoutMs: 8000, what: "game exclusive" });

    // Launch a THIRD window while the game holds exclusive.
    const editor = c.spawnClient(
      ["--title", "editor", "--app-id", "editor", "--color", "FF0000FF",
       "--size", "400x300", "--fill-configured"]);
    await editor.ready;
    await waitFor(c.query, (s) => s.windows.length >= 3,
      { timeoutMs: 8000, what: "editor mapped" });
    await new Promise((r) => setTimeout(r, 800));

    const edId = c.query().windows.map((w) => w.surfaceId)
      .find((id) => id !== termId && id !== gameId);
    const ed = c.state.wm.state.windows.find((w) => w.surfaceId === edId);
    console.error("EDITOR:", JSON.stringify({
      outer: ed?.outer, rect: ed?.rect,
      focusOrder: c.state.wm.focusOrder(),
    }));
    assert.ok(ed?.outer && ed.outer.width > 0 && ed.outer.height > 0,
      `editor mapped under an exclusive peer must still get a layout rect; outer=${JSON.stringify(ed?.outer)}`);

    // Dominance follows focus. Record the draw stacks the WM pushes.
    const stacks = [];
    const origSetStack = c.jsCompositor.setStack.bind(c.jsCompositor);
    c.jsCompositor.setStack = (ids) => { stacks.push([...ids]); origSetStack(ids); };

    // Focused game dominates: topmost in the draw stack (covers the glass).
    c.state.seat?.applyKeyboardFocus(gameId);
    await new Promise((r) => setTimeout(r, 300));
    let last = stacks.at(-1) ?? [];
    assert.equal(last.at(-1), gameId,
      `focused game draws topmost; got ${JSON.stringify(last)}`);

    // Focus the terminal: the unfocused fullscreen game drops BELOW the
    // tiled tier -- both tiled windows draw above it, terminal (focused)
    // topmost.
    c.state.seat?.applyKeyboardFocus(termId);
    await new Promise((r) => setTimeout(r, 300));
    last = stacks.at(-1) ?? [];
    assert.equal(last.at(-1), termId,
      `focused terminal draws topmost; got ${JSON.stringify(last)}`);
    assert.ok(last.includes(edId) && last.includes(gameId),
      `editor and game remain in the stack; got ${JSON.stringify(last)}`);
    assert.ok(last.indexOf(gameId) < last.indexOf(edId)
           && last.indexOf(gameId) < last.indexOf(termId),
      `unfocused fullscreen draws below BOTH tiled windows; got ${JSON.stringify(last)}`);

    // Back to the game: it rises to the top tier again.
    c.state.seat?.applyKeyboardFocus(gameId);
    await new Promise((r) => setTimeout(r, 300));
    last = stacks.at(-1) ?? [];
    assert.equal(last.at(-1), gameId,
      `refocused game draws topmost again; got ${JSON.stringify(last)}`);

    // The game holds no layout slot: unmapping the terminal must reflow
    // the editor (now the sole tiled member) without touching the game's
    // glass-sized rect.
    const gameOuterBefore = { ...c.state.wm.state.windows
      .find((w) => w.surfaceId === gameId).outer };
    const edOuterBefore = { ...c.state.wm.state.windows
      .find((w) => w.surfaceId === edId).outer };
    term.child.kill("SIGTERM");
    await waitFor(c.query, (s) => s.windows.length === 2,
      { timeoutMs: 8000, what: "terminal unmapped" });
    await c.state.wm.settled();
    await new Promise((r) => setTimeout(r, 500));
    const gameAfter = c.state.wm.state.windows.find((w) => w.surfaceId === gameId);
    const edAfter = c.state.wm.state.windows.find((w) => w.surfaceId === edId);
    assert.deepEqual(gameAfter.outer, gameOuterBefore,
      "fullscreen rect untouched by the peer unmap");
    assert.ok(edAfter.outer.x !== edOuterBefore.x
           || edAfter.outer.width !== edOuterBefore.width,
      `editor reflowed after the peer unmap; outer=${JSON.stringify(edAfter.outer)}`);

    // Zoom the editor while the game is fullscreen: both sizeModes
    // coexist. The editor covers the workarea-scoped rect; the game
    // keeps its glass rect (it is never handed to the layout plugin, so
    // it cannot be squeezed into a tile slot).
    c.state.seat?.applyKeyboardFocus(edId);
    await c.state.wm.propose(edId, { sizeMode: "maximized" }, "user-input");
    await c.state.wm.settled();
    await new Promise((r) => setTimeout(r, 300));
    const gameZoomed = c.state.wm.state.windows.find((w) => w.surfaceId === gameId);
    const edZoomed = c.state.wm.state.windows.find((w) => w.surfaceId === edId);
    assert.equal(gameZoomed.windowState.sizeMode, "fullscreen",
      "zoom on a peer does not demote the fullscreen window");
    assert.deepEqual(gameZoomed.outer, gameOuterBefore,
      "fullscreen rect untouched by a peer zoom");
    assert.ok(edZoomed.outer.width > edOuterBefore.width,
      `zoomed editor covers the workarea-scoped rect; outer=${JSON.stringify(edZoomed.outer)}`);
    // Focused zoomed editor draws above the unfocused fullscreen game.
    last = stacks.at(-1) ?? [];
    assert.ok(last.indexOf(gameId) < last.indexOf(edId),
      `zoomed focused editor draws above the game; got ${JSON.stringify(last)}`);
  } finally {
    await c.teardown();
  }
});
