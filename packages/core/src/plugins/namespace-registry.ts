// Plugin namespace registry: core-side bookkeeping for sdk.registerPlugin /
// sdk.plugin (core-plugin-api.md §11). Tracks which plugin claims which
// namespace at what priority, and which claim is ACTIVATED. A claim is
// inert bookkeeping; activation is what runs the claimant's init and makes
// it the routing target. The runtime drives both: it records claims as
// plugin.register events arrive, selects the highest-priority claim for
// activation (at load-batch end, or immediately for post-load claims on an
// inactive namespace), and re-activates the next-highest claim when the
// activated one goes away ("priority chain failure recovery" from
// customization.md).
//
// Pure data structure: no transport, no async, no Worker. Same registry is
// used regardless of whether a plugin runs in-thread (bundled) or in a
// Worker (external).

export interface Registration {
  // The plugin that owns this registration (matches ResolvedPlugin.name).
  pluginName: string;
  // The namespace claimed (e.g. 'workspace', 'layout').
  namespace: string;
  // Higher wins. Bundled plugins register at 0; user plugins default to 100.
  priority: number;
  // The method names the plugin exposes for this namespace. Unknown until
  // activation runs the claimant's init and reports the API surface; null
  // for a claim that has never been activated. Method calls on
  // sdk.plugin(namespace) check this set; unknown methods reject.
  methods: ReadonlySet<string> | null;
}

// Registry topology changes, delivered to onChange listeners. The runtime
// uses these to drive activation: a claim added to an inactive namespace
// and the removal of the activated claim both warrant an activation pass.
export type RegistryChange =
  | { kind: "claim-added"; registration: Registration }
  | { kind: "claim-removed"; registration: Registration; wasActivated: boolean }
  | { kind: "activated"; registration: Registration };

export type ChangeListener = (namespace: string, change: RegistryChange) => void;

export class NamespaceRegistry {
  // namespace -> all claims, sorted by priority descending. On ties,
  // earlier-registered wins (stable insertion).
  private byNamespace = new Map<string, Registration[]>();
  // pluginName -> set of namespaces it currently claims (for fast removal on
  // plugin death).
  private byPlugin = new Map<string, Set<string>>();
  // namespace -> pluginName of the ACTIVATED claim. Absent = no activation
  // (never activated, or the activated claim was removed).
  private activatedBy = new Map<string, string>();
  private listeners = new Set<ChangeListener>();

  // Record a plugin's claim on a namespace. Claims are inert: recording one
  // has no effect on routing until the runtime activates it. Throws if the
  // same (plugin, namespace) pair is already registered -- a plugin may not
  // double-register one name.
  register(reg: Registration): void {
    if (typeof reg.namespace !== "string" || reg.namespace.length === 0) {
      throw new TypeError("namespace must be a non-empty string");
    }
    if (typeof reg.pluginName !== "string" || reg.pluginName.length === 0) {
      throw new TypeError("pluginName must be a non-empty string");
    }
    if (!Number.isFinite(reg.priority)) {
      throw new TypeError("priority must be a finite number");
    }

    const list = this.byNamespace.get(reg.namespace) ?? [];
    if (list.some((r) => r.pluginName === reg.pluginName)) {
      throw new Error(
        `plugin '${reg.pluginName}' already registered for namespace '${reg.namespace}'`);
    }
    let i = 0;
    while (i < list.length && list[i].priority >= reg.priority) i++;
    list.splice(i, 0, reg);
    this.byNamespace.set(reg.namespace, list);

    const claims = this.byPlugin.get(reg.pluginName) ?? new Set<string>();
    claims.add(reg.namespace);
    this.byPlugin.set(reg.pluginName, claims);

    this.fireChange(reg.namespace, { kind: "claim-added", registration: reg });
  }

  // Remove a (plugin, namespace) claim. If it was the activated claim, the
  // activation is cleared -- the change event carries wasActivated so the
  // runtime can activate the next-highest claim. Idempotent: removing a
  // claim that doesn't exist is a silent no-op. Returns true if a claim was
  // removed.
  unregister(pluginName: string, namespace: string): boolean {
    const list = this.byNamespace.get(namespace);
    if (!list) return false;
    const idx = list.findIndex((r) => r.pluginName === pluginName);
    if (idx < 0) return false;
    const [removed] = list.splice(idx, 1);
    if (list.length === 0) this.byNamespace.delete(namespace);
    const claims = this.byPlugin.get(pluginName);
    claims?.delete(namespace);
    if (claims?.size === 0) this.byPlugin.delete(pluginName);

    const wasActivated = this.activatedBy.get(namespace) === pluginName;
    if (wasActivated) this.activatedBy.delete(namespace);
    this.fireChange(namespace, { kind: "claim-removed", registration: removed, wasActivated });
    return true;
  }

  // Remove every claim a plugin owns (called when a plugin dies /
  // permanently fails). Fires one claim-removed event per namespace.
  unregisterAllFor(pluginName: string): void {
    const claims = this.byPlugin.get(pluginName);
    if (!claims) return;
    // Snapshot the set; unregister() mutates byPlugin so we'd lose entries
    // mid-iteration otherwise.
    for (const ns of [...claims]) this.unregister(pluginName, ns);
  }

  // Mark a claim activated and record the API surface its init reported.
  // Throws if the claim doesn't exist or another claim is already activated
  // for the namespace (the runtime never preempts a live activation).
  markActivated(namespace: string, pluginName: string, methods: readonly string[]): void {
    const current = this.activatedBy.get(namespace);
    if (current !== undefined && current !== pluginName) {
      throw new Error(
        `namespace '${namespace}' already activated by '${current}'`);
    }
    const reg = this.byNamespace.get(namespace)?.find((r) => r.pluginName === pluginName);
    if (!reg) {
      throw new Error(
        `markActivated: no claim by '${pluginName}' on '${namespace}'`);
    }
    reg.methods = new Set(methods);
    this.activatedBy.set(namespace, pluginName);
    this.fireChange(namespace, { kind: "activated", registration: reg });
  }

  // The ACTIVATED registration for a namespace, or null when no claim has
  // been activated. This is the routing target: invocations, wait-for-active,
  // and driver predicates (hasPluginHandler) all key off activation, never
  // off raw claims.
  active(namespace: string): Registration | null {
    const name = this.activatedBy.get(namespace);
    if (name === undefined) return null;
    return this.byNamespace.get(namespace)?.find((r) => r.pluginName === name) ?? null;
  }

  // The highest-priority claim for a namespace (activated or not), or null
  // when nothing claims it. The runtime's activation pass selects this.
  topClaim(namespace: string): Registration | null {
    const list = this.byNamespace.get(namespace);
    return list && list.length > 0 ? list[0] : null;
  }

  // All claims for a namespace in priority-descending order. Used by
  // diagnostics and tests.
  registrations(namespace: string): ReadonlyArray<Registration> {
    return this.byNamespace.get(namespace) ?? [];
  }

  // All namespaces currently claimed by at least one plugin, in first-claim
  // order. Load order is claim order, so iterating this for activation
  // preserves the bundled-plugin ordering constraints (layout before
  // workspace, etc.).
  namespaces(): ReadonlyArray<string> {
    return [...this.byNamespace.keys()];
  }

  // Subscribe to registry topology changes (claims added/removed,
  // activations). Returns an unsubscribe function.
  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private fireChange(namespace: string, change: RegistryChange): void {
    for (const cb of [...this.listeners]) {
      try { cb(namespace, change); }
      catch { /* listener errors are isolated; the registry is sync + simple */ }
    }
  }
}
