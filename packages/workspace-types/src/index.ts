// Canonical types for the 'workspace' plugin namespace. Type-only; the .d.ts
// is the contract any plugin claiming 'workspace' implements.
//
// Two ids per workspace:
//
//   WorkspaceHandle  -- stable internal identity. Monotonic; never reused.
//                       Stored in the per-window state bag under the key
//                       'workspace.id'. Survives destruction of other
//                       workspaces. Event payloads carry it.
//
//   WorkspaceIndex   -- 1-based position in the workspace list. Dense; shifts
//                       down on destroy. What hotkeys, CLI ("workspace.show 2"),
//                       and status bars use. NOT stable across destroys.
//
// Methods that take user input (CLI / hotkey-driven actions) accept an Index
// and resolve it to a handle at the boundary. The state bag and event payloads
// carry the Handle so subscribers caching ids don't break when other
// workspaces are destroyed.

export type WorkspaceHandle = number & { __brand: "WorkspaceHandle" };
export type WorkspaceIndex = number & { __brand: "WorkspaceIndex" };

export interface WorkspaceSnapshot {
  handle: WorkspaceHandle;
  index: WorkspaceIndex;
  // Undefined means "no explicit name set"; consumers (status bars, etc.)
  // display the index as the label in that case. setName(idx, undefined)
  // clears a previously-set name.
  name?: string;
  outputId: number;
  // surfaceIds in this workspace, back-to-front draw order.
  members: number[];
}

export interface WorkspaceCreateSpec {
  name?: string;
  // Defaults to OUTPUT_DEFAULT (0) when omitted.
  outputId?: number;
}

// Transition spec accepted by show() / moveWindow() to animate the swap.
// kind + duration are the same shape sdk.transitions.run takes (core-
// plugin-api.md §8); the easing field is passed through verbatim.
export interface WorkspaceTransitionSpec {
  kind: "crossfade" | "slide-left" | "slide-right"
      | "slide-up" | "slide-down" | "scale";
  duration: number;            // ms; must be > 0
  easing?: unknown;            // EasingSpec from @overdraw/animation-types
}

export interface WorkspaceAPI {
  /**
   * Append a new workspace at the end of the position list for outputId
   * (default OUTPUT_DEFAULT). Allocates a fresh handle (monotonic, never
   * reused). Does NOT auto-show the new workspace. Returns the snapshot;
   * its index is the new last position.
   */
  create(spec?: WorkspaceCreateSpec): Promise<WorkspaceSnapshot>;

  /**
   * Destroy the workspace at the given position on outputId (default
   * OUTPUT_DEFAULT). Everything to its right shifts down by 1 index.
   *
   * Member relocation: if the destroyed workspace had members, they move
   * to the workspace that takes its position. If the destroyed workspace
   * was the last and non-empty, members move to the new-last (previous
   * lower-index) workspace.
   *
   * Always-at-least-one invariant: if destroying the only workspace,
   * a fresh handle is allocated for the new index 1 before the destroy
   * completes (the new workspace has no name and no members).
   *
   * If the destroyed workspace was the shown one on its output, the
   * workspace at the same position post-destroy (or the new last one if
   * the destroyed was at the end) becomes shown.
   */
  destroy(index: WorkspaceIndex, outputId?: number): Promise<void>;

  /**
   * Make the workspace at `index` the visible one on outputId (default
   * OUTPUT_DEFAULT). Pushes the workspace's members to that output's
   * stack; the previously-shown workspace's windows are no longer
   * composited there.
   *
   * When `transition` is set, the swap is animated: the plugin captures
   * scene snapshots of the FROM and TO stacks via sdk.compose.scene
   * and runs sdk.transitions.run between them, applying the new
   * stack atomically with completion (no glitch frame). Requires the
   * runtime to have wired sdk.compose + sdk.transitions; throws
   * otherwise. Omit `transition` for an instant swap.
   */
  show(index: WorkspaceIndex, outputId?: number,
       transition?: WorkspaceTransitionSpec): Promise<void>;

  /**
   * Move a window into the workspace at `index` on outputId (default
   * OUTPUT_DEFAULT). Removes from whatever workspace it was on (any
   * output). Updates the window's 'workspace.id' state-bag entry to the
   * target workspace's handle.
   */
  moveWindow(surfaceId: number, index: WorkspaceIndex, outputId?: number): Promise<void>;

  /**
   * Set or clear a workspace's display name. Passing `undefined` clears
   * the name (consumers fall back to displaying the index).
   */
  setName(index: WorkspaceIndex, name: string | undefined, outputId?: number): Promise<void>;

  /**
   * All workspaces on outputId (default OUTPUT_DEFAULT), sorted by index.
   */
  list(outputId?: number): Promise<WorkspaceSnapshot[]>;

  /**
   * The currently-shown workspace on outputId (default OUTPUT_DEFAULT).
   * Null only in transient states (no workspaces exist yet, before
   * init); steady state always has one.
   */
  current(outputId?: number): Promise<WorkspaceSnapshot | null>;
}
