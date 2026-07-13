// wp_commit_timing_manager_v1 / wp_commit_timer_v1: per-surface commit
// timing constraints. set_timestamp attaches a target presentation time to
// the surface's NEXT commit; that commit's content update must not be
// latched (and so not presented) before the target time. Timestamps are in
// the wp_presentation clock domain -- CLOCK_MONOTONIC here (wp_presentation
// advertises clock_id 1 on bind).
//
// This module only validates requests and stamps pending.commitTimestamp;
// the deferred-latch queue lives in wl_surface.ts's commit path, which owns
// pending-state semantics (see pumpTimedCommits there).

import { WpCommitTimingManagerV1_Error } from "#protocols-gen/wp_commit_timing_manager_v1.js";
import type { WpCommitTimingManagerV1Handler } from "#protocols-gen/wp_commit_timing_manager_v1.js";
import { WpCommitTimerV1_Error } from "#protocols-gen/wp_commit_timer_v1.js";
import type { WpCommitTimerV1Handler } from "#protocols-gen/wp_commit_timer_v1.js";

import type { Ctx } from "./ctx.js";

const NSEC_PER_SEC = 1_000_000_000n;

export default function makeCommitTimingManager(ctx: Ctx): WpCommitTimingManagerV1Handler {
  return {
    destroy(_resource) {
      // Destructor. Existing wp_commit_timer_v1 objects survive (per spec).
    },
    get_timer(manager, id, surface) {
      const s = ctx.state.surfaces.get(surface);
      if (!s) return;
      if (s.hasCommitTimer) {
        ctx.addon.postError(manager, WpCommitTimingManagerV1_Error.commit_timer_exists,
          "wl_surface already has a wp_commit_timer_v1");
        return;
      }
      s.hasCommitTimer = true;
      (ctx.state.commitTimers ??= new Map()).set(id, surface);
    },
  };
}

export function makeCommitTimer(ctx: Ctx): WpCommitTimerV1Handler {
  return {
    set_timestamp(resource, tvSecHi, tvSecLo, tvNsec) {
      const surf = ctx.state.commitTimers?.get(resource);
      if (!surf) return;
      const s = ctx.state.surfaces.get(surf);
      if (surf.destroyed || !s) {
        ctx.addon.postError(resource, WpCommitTimerV1_Error.surface_destroyed,
          "wp_commit_timer_v1.set_timestamp: the associated wl_surface was destroyed");
        return;
      }
      if (tvNsec >= 1_000_000_000) {
        ctx.addon.postError(resource, WpCommitTimerV1_Error.invalid_timestamp,
          `wp_commit_timer_v1.set_timestamp: invalid tv_nsec ${tvNsec}`);
        return;
      }
      if (s.pending.commitTimestamp !== undefined) {
        ctx.addon.postError(resource, WpCommitTimerV1_Error.timestamp_exists,
          "wp_commit_timer_v1.set_timestamp: a timestamp is already set for the next commit");
        return;
      }
      const sec = (BigInt(tvSecHi >>> 0) << 32n) | BigInt(tvSecLo >>> 0);
      s.pending.commitTimestamp = sec * NSEC_PER_SEC + BigInt(tvNsec >>> 0);
    },
    destroy(resource) {
      // Existing timing constraints (a pending timestamp or already-queued
      // timed commits) are unaffected per spec; only the one-timer-per-
      // surface slot frees up.
      const surf = ctx.state.commitTimers?.get(resource);
      ctx.state.commitTimers?.delete(resource);
      if (!surf) return;
      const s = ctx.state.surfaces.get(surf);
      if (s) s.hasCommitTimer = false;
    },
  };
}
