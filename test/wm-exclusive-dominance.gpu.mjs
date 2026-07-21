// Exclusive dominance follows focus.
//
// A fullscreen (exclusive) window dominates its island -- topmost in the
// draw stack, peers suppressed -- only WHILE IT HOLDS KEYBOARD FOCUS.
// Unfocused, it keeps its exclusive state and glass rect but stacks like
// a normal window, so the rest of the island stays visible and usable:
// windows mapping under it still get their layout rect (suppression is a
// stacking concern, not geometry), can be focus-cycled to, and draw
// above it when focused.
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
      (w) => w?.windowState.exclusive === "fullscreen",
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

    // Focus the terminal: dominance drops; the terminal draws above the
    // (still-fullscreen) game and the editor stays in the stack.
    c.state.seat?.applyKeyboardFocus(termId);
    await new Promise((r) => setTimeout(r, 300));
    last = stacks.at(-1) ?? [];
    assert.equal(last.at(-1), termId,
      `focused terminal draws above the unfocused fullscreen; got ${JSON.stringify(last)}`);
    assert.ok(last.includes(edId) && last.includes(gameId),
      `editor and game remain in the stack; got ${JSON.stringify(last)}`);

    // Back to the game: dominance re-engages.
    c.state.seat?.applyKeyboardFocus(gameId);
    await new Promise((r) => setTimeout(r, 300));
    last = stacks.at(-1) ?? [];
    assert.equal(last.at(-1), gameId,
      `refocused game draws topmost again; got ${JSON.stringify(last)}`);
  } finally {
    await c.teardown();
  }
});
