// Bundled plugin: applies user-declared window rules.
//
// A rule matches a window by appId/title (regex strings) or a predicate, and
// applies pre-map policy: the declarative `float` field and/or an imperative
// `apply` lambda. The plugin is in-thread, so predicate/apply function
// references from the user's config survive (same reason config.actions is
// in-thread).
//
// Placement (docs/canvas-design.md §7): a rule may also target WHERE the
// window goes -- `workspace: "name"` (created on reference if absent)
// and/or `output: "DP-1"` (the home of a created workspace, or the
// placement target by itself: "appear on that monitor, whatever it shows").
// `show: true` additionally makes the placement grab attention (the target
// workspace is shown); default is quiet. This plugin stays the MATCHING
// side: it stamps the resolved placement into the window's state bag
// (`workspace.place`) during preconfigure, and the workspace-namespace
// plugin's map handler is the placement resolver that consumes it. The
// bundled canvas plugin implements it; with plugin-workspace-default the
// hint is inert (windows place on the spawn output's shown workspace).
//
// The single seam is `window.preconfigure`: an interceptable event fired at
// the initial commit, BEFORE the window enters the draw stack, carrying the
// window's resolved appId/title (for xwayland the manage step is held until
// WM_CLASS/title land, so they're real here, not null) and a mutable
// `initialState`. The declarative `float` field flips the tiling lane; the
// `apply` lambda gets the full `state` proposal and may set any field
// (tiling, sizeMode, visible, modal, constraints, parent, layoutMode/...).
// The window maps with that state, no flicker. Rules apply in array order;
// later rules win per axis. The lambda runs after the declarative `float`.
//
// Geometry is intentionally NOT handled here. Where a floated window lands is
// the layout proposal's concern: `window.relayout` lets an interceptor
// override `newOuter`. Size/position policy belongs on that seam, not in this
// state-only hook.

import type { PluginSdkShape } from "@overdraw/plugin-sdk-types";

// Window-state shape we touch. The full WindowState has more fields; the
// interceptor preserves them by shallow-cloning and only writing `tiling`.
type Tiling = "managed" | "floating";
interface WindowStateLike {
  tiling: Tiling;
  [k: string]: unknown;
}

interface PreconfigurePayload {
  surfaceId: number;
  appId: string | null;
  title: string | null;
  xwayland: boolean;
  initialState: WindowStateLike;
}

// Read view handed to a predicate match.
interface WindowQuery {
  surfaceId: number;
  appId: string | null;
  title: string | null;
  xwayland: boolean;
}
// The apply lambda also gets `state`: the mutable pre-map proposal. It may
// assign any field (tiling, sizeMode, visible, modal, constraints, parent,
// layoutMode/layoutData); the WM validates the returned state.
interface WindowTarget extends WindowQuery {
  state: WindowStateLike;
}

type MatchClause =
  | { appId?: string; title?: string }
  | ((win: WindowQuery) => boolean);

interface RawRule {
  match: MatchClause;
  float?: boolean;
  workspace?: string;
  output?: string;
  show?: boolean;
  apply?: (win: WindowTarget) => void;
}

// A rule with its regexes compiled once at init.
interface CompiledRule {
  test: (q: WindowQuery) => boolean;
  float?: boolean;
  workspace?: string;
  output?: string;
  show?: boolean;
  apply?: (win: WindowTarget) => void;
}

// Compile one rule's match clause into a predicate over the window query.
// Regex strings are anchored as written (the user controls anchoring); an
// invalid pattern throws here, at config load, with the offending source.
function compileMatch(match: MatchClause, index: number): (q: WindowQuery) => boolean {
  if (typeof match === "function") return match;
  if (typeof match !== "object" || match === null) {
    throw new TypeError(`windowRules[${index}].match must be an object or a function`);
  }
  const { appId, title } = match;
  if (appId === undefined && title === undefined) {
    throw new TypeError(
      `windowRules[${index}].match must specify at least one of appId / title`);
  }
  let appIdRe: RegExp | null = null;
  let titleRe: RegExp | null = null;
  if (appId !== undefined) {
    if (typeof appId !== "string") {
      throw new TypeError(`windowRules[${index}].match.appId must be a regex string`);
    }
    try { appIdRe = new RegExp(appId); }
    catch (e) {
      throw new TypeError(
        `windowRules[${index}].match.appId is not a valid regex: ${(e as Error).message}`);
    }
  }
  if (title !== undefined) {
    if (typeof title !== "string") {
      throw new TypeError(`windowRules[${index}].match.title must be a regex string`);
    }
    try { titleRe = new RegExp(title); }
    catch (e) {
      throw new TypeError(
        `windowRules[${index}].match.title is not a valid regex: ${(e as Error).message}`);
    }
  }
  // Object match: every present field must match (AND). A field's regex tests
  // against a string; a null value (client never set it) never matches.
  return (q: WindowQuery): boolean => {
    if (appIdRe && (q.appId === null || !appIdRe.test(q.appId))) return false;
    if (titleRe && (q.title === null || !titleRe.test(q.title))) return false;
    return true;
  };
}

function compileRule(raw: unknown, index: number): CompiledRule {
  if (typeof raw !== "object" || raw === null) {
    throw new TypeError(`windowRules[${index}] must be an object`);
  }
  const r = raw as RawRule;
  if (!("match" in r)) {
    throw new TypeError(`windowRules[${index}] must have a 'match'`);
  }
  if (r.float !== undefined && typeof r.float !== "boolean") {
    throw new TypeError(`windowRules[${index}].float must be a boolean`);
  }
  if (r.workspace !== undefined
      && (typeof r.workspace !== "string" || r.workspace === "")) {
    throw new TypeError(`windowRules[${index}].workspace must be a non-empty string`);
  }
  if (r.output !== undefined
      && (typeof r.output !== "string" || r.output === "")) {
    throw new TypeError(`windowRules[${index}].output must be a non-empty string`);
  }
  if (r.show !== undefined) {
    if (typeof r.show !== "boolean") {
      throw new TypeError(`windowRules[${index}].show must be a boolean`);
    }
    if (r.workspace === undefined && r.output === undefined) {
      throw new TypeError(
        `windowRules[${index}].show requires a workspace or output target`);
    }
  }
  if (r.apply !== undefined && typeof r.apply !== "function") {
    throw new TypeError(`windowRules[${index}].apply must be a function`);
  }
  const compiled: CompiledRule = { test: compileMatch(r.match, index) };
  if (r.float !== undefined) compiled.float = r.float;
  if (r.workspace !== undefined) compiled.workspace = r.workspace;
  if (r.output !== undefined) compiled.output = r.output;
  if (r.show !== undefined) compiled.show = r.show;
  if (r.apply !== undefined) compiled.apply = r.apply;
  return compiled;
}

export default async function init(sdk: PluginSdkShape, rawConfig?: unknown): Promise<void> {
  if (rawConfig === undefined || rawConfig === null) return;
  if (!Array.isArray(rawConfig)) {
    throw new TypeError("config.windowRules must be an array");
  }
  const rules: CompiledRule[] = rawConfig.map((r, i) => compileRule(r, i));
  if (rules.length === 0) return;

  sdk.events.intercept("window.preconfigure", async (_name, payload): Promise<unknown> => {
    const p = payload as PreconfigurePayload | null;
    if (!p || typeof p.surfaceId !== "number"
        || typeof p.initialState !== "object" || p.initialState === null) {
      return undefined;
    }
    const query: WindowQuery = {
      surfaceId: p.surfaceId,
      appId: p.appId ?? null,
      title: p.title ?? null,
      xwayland: p.xwayland === true,
    };

    // Apply matching rules onto a single working copy of the state, lazily
    // cloned on the first match so a no-match preconfigure stays observe-only.
    let next: WindowStateLike | null = null;
    const proposal = (): WindowStateLike => (next ??= { ...p.initialState });
    // The lambda facade: read fields plus the mutable proposal (`state`). The
    // getter clones on first access so the lambda can both read and write the
    // full state.
    const target: WindowTarget = {
      ...query,
      get state(): WindowStateLike { return proposal(); },
    };

    // Placement accumulates across matches (later rules win per field).
    let place: { name?: string; output?: string; show?: boolean } | null = null;
    for (const rule of rules) {
      if (!rule.test(query)) continue;
      if (rule.float === true) proposal().tiling = "floating";
      else if (rule.float === false) proposal().tiling = "managed";
      if (rule.workspace !== undefined || rule.output !== undefined) {
        place = {
          ...(rule.workspace !== undefined ? { name: rule.workspace } : {}),
          ...(rule.output !== undefined ? { output: rule.output } : {}),
          ...(rule.show !== undefined ? { show: rule.show } : {}),
        };
      }
      if (rule.apply) {
        try {
          rule.apply(target);
        } catch (e) {
          sdk.log(`[window-rules] apply for surface ${p.surfaceId} threw: ${(e as Error).message}`);
        }
      }
    }

    // Stamp the placement into the window's state bag BEFORE the map: the
    // preconfigure intercept is awaited ahead of window.map, so the
    // workspace plugin's map handler reads a settled hint.
    if (place) {
      try {
        await sdk.windows.setState(p.surfaceId, "workspace.place", place);
      } catch (e) {
        sdk.log(`[window-rules] placement stamp for surface ${p.surfaceId} failed: ${(e as Error).message}`);
      }
    }

    if (!next) return undefined;
    return { ...p, initialState: next };
  });

  sdk.log(`loaded ${rules.length} window rule${rules.length === 1 ? "" : "s"}`);
}
