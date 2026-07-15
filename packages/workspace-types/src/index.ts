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
  // Urgency flag. True when the workspace has been marked urgent (typically
  // by a plugin reacting to a window requesting attention while not on the
  // shown workspace). Cleared automatically when the workspace becomes the
  // shown one on its output.
  urgent: boolean;
  // Dynamic-workspace lifetime. A non-persistent workspace evaporates
  // (auto-destroys, with the usual workspace.destroyed / renumbered
  // events) once it is empty AND not the shown workspace on its output.
  // Persistent workspaces only die via an explicit destroy().
  persistent: boolean;
}

export interface WorkspaceCreateSpec {
  name?: string;
  // Defaults to OUTPUT_DEFAULT (0) when omitted.
  outputId?: number;
  // Optional durable preferred-output list, most-preferred first. Entries
  // are stable output identifiers (the wl_output.name string, e.g. "DP-1").
  // When supplied, the workspace will reclaim a returning output that
  // appears in this list ahead of any output it has fallen back to. Omitted
  // -> the live boot output's name becomes the sole entry, so a workspace
  // still tracks where it was born.
  preferredOutputs?: ReadonlyArray<string>;
  // Opt out of dynamic-workspace evaporation: a persistent workspace
  // survives becoming empty and hidden. Default false (dynamic).
  persistent?: boolean;
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

  /**
   * Reorder a window within its current workspace's member list. The
   * workspace's members IS the per-workspace master-stack order the
   * layout-driver consumes; reordering it directly changes which window
   * is master / where each window sits in the stack. Returns true when the
   * order changed (and a layout pass is scheduled), false when the
   * requested op was a no-op (e.g. promote on a window already at master,
   * swap-next on the tail).
   */
  reorder(surfaceId: number, op: "promote" | "swap-next" | "swap-prev"): Promise<boolean>;

  /**
   * Idempotently ensure `outputId` has at least one workspace. If a workspace
   * already exists there, returns the currently-shown one; otherwise creates
   * workspace 1 and shows it. Returns the shown workspace's snapshot.
   * Used by callers that need to land a window on an output that has had
   * no windows of its own (so the workspace plugin hasn't auto-created any
   * workspaces there yet).
   */
  ensureOutput(outputId: number): Promise<WorkspaceSnapshot>;

  /**
   * Set or clear the urgent flag on the workspace at `index` on outputId
   * (default OUTPUT_DEFAULT). Idempotent: setting urgent to its current
   * value is a no-op (no event emitted). Becomes-shown auto-clears urgent;
   * callers don't have to clear it themselves on focus.
   *
   * Emits 'workspace.urgency-changed' (see WorkspaceUrgencyChangedPayload)
   * on the plugin bus when the flag actually changes.
   */
  setUrgent(index: WorkspaceIndex, urgent: boolean, outputId?: number): Promise<void>;
}

// Payload of the 'workspace.urgency-changed' plugin-bus event. Emitted by
// the workspace plugin when a workspace's urgent flag transitions (either
// direction). Carries the durable WorkspaceHandle so subscribers caching
// ids don't break across destroys of other workspaces.
export interface WorkspaceUrgencyChangedPayload {
  workspaceId: WorkspaceHandle;
  urgent: boolean;
  outputId: number;
}
