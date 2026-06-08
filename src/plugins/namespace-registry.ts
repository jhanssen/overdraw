// Plugin namespace registry: core-side bookkeeping for sdk.registerPlugin /
// sdk.plugin (core-plugin-api.md §11). Tracks which plugin owns which
// namespace under what priority, picks the highest-priority claim as the
// active winner, demotes to the next-highest on failure ("priority chain
// failure recovery" from customization.md).
//
// Pure data structure: no transport, no async, no Worker. The runtime drives
// it (register on plugin.register event, unregister on plugin death, query
// for invocation routing). Same registry is used regardless of whether
// a plugin runs in-thread (bundled) or in a Worker (external); the registry
// records only "who claimed what at what priority".

export interface Registration {
  // The plugin that owns this registration (matches ResolvedPlugin.name).
  pluginName: string;
  // The namespace claimed (e.g. 'workspace', 'layout').
  namespace: string;
  // Higher wins. Bundled plugins register at 0; user plugins default to 100.
  priority: number;
  // The method names the plugin exposes for this namespace. Method calls on
  // sdk.plugin(namespace) check this set; unknown methods reject.
  methods: ReadonlySet<string>;
}

// Snapshot of what changed when the registry mutates. The runtime emits an
// internal event so any sdk.plugin() consumers can refresh their proxy's
// current target. (Not a public event; just an internal callback.)
export type ActiveChangeListener = (
  namespace: string,
  prev: Registration | null,
  next: Registration | null,
) => void;

export class NamespaceRegistry {
  // namespace -> all registrations, sorted by priority descending. The head
  // (index 0) is the active winner; the rest are dormant fallbacks.
  private byNamespace = new Map<string, Registration[]>();
  // pluginName -> set of namespaces it currently claims (for fast removal on
  // plugin death).
  private byPlugin = new Map<string, Set<string>>();
  private listeners = new Set<ActiveChangeListener>();

  // Register a plugin's claim on a namespace. Returns true if the registration
  // changed the active winner (i.e. this new registration's priority is now
  // the highest in that namespace). Throws if the same (plugin, namespace)
  // pair is already registered -- a plugin may not double-register one name.
  register(reg: Registration): boolean {
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
    const prevActive = list[0] ?? null;
    // Insert maintaining priority-desc order. On ties, earlier-registered
    // wins (stable: insertion order among ties means the first registrant
    // at a given priority keeps the slot).
    let i = 0;
    while (i < list.length && list[i].priority >= reg.priority) i++;
    list.splice(i, 0, reg);
    this.byNamespace.set(reg.namespace, list);

    const claims = this.byPlugin.get(reg.pluginName) ?? new Set<string>();
    claims.add(reg.namespace);
    this.byPlugin.set(reg.pluginName, claims);

    const nextActive = list[0];
    const activeChanged = prevActive !== nextActive;
    if (activeChanged) this.fireChange(reg.namespace, prevActive, nextActive);
    return activeChanged;
  }

  // Unregister a (plugin, namespace) claim. If the unregistered registration
  // was the active winner, the next-highest takes over (failure promotion).
  // Returns true if the active winner changed. Idempotent: unregistering a
  // claim that doesn't exist is a silent no-op.
  unregister(pluginName: string, namespace: string): boolean {
    const list = this.byNamespace.get(namespace);
    if (!list) return false;
    const idx = list.findIndex((r) => r.pluginName === pluginName);
    if (idx < 0) return false;
    const wasActive = idx === 0;
    const prevActive = list[0];
    list.splice(idx, 1);
    if (list.length === 0) this.byNamespace.delete(namespace);
    const claims = this.byPlugin.get(pluginName);
    claims?.delete(namespace);
    if (claims?.size === 0) this.byPlugin.delete(pluginName);

    if (wasActive) {
      const nextActive = list[0] ?? null;
      this.fireChange(namespace, prevActive, nextActive);
      return true;
    }
    return false;
  }

  // Unregister every namespace a plugin owns (called when a plugin dies /
  // permanently fails). Fires one active-changed event per namespace where
  // the active winner moved.
  unregisterAllFor(pluginName: string): void {
    const claims = this.byPlugin.get(pluginName);
    if (!claims) return;
    // Snapshot the set; unregister() mutates byPlugin so we'd lose entries
    // mid-iteration otherwise.
    for (const ns of [...claims]) this.unregister(pluginName, ns);
  }

  // The currently-active registration for a namespace (the highest-priority
  // claim), or null if no plugin claims that name.
  active(namespace: string): Registration | null {
    const list = this.byNamespace.get(namespace);
    return list && list.length > 0 ? list[0] : null;
  }

  // All registrations for a namespace in priority-descending order. Used by
  // diagnostics and tests; the runtime usually only cares about the active
  // one.
  registrations(namespace: string): ReadonlyArray<Registration> {
    return this.byNamespace.get(namespace) ?? [];
  }

  // All namespaces currently claimed by at least one plugin.
  namespaces(): ReadonlyArray<string> {
    return [...this.byNamespace.keys()];
  }

  // Subscribe to active-changed notifications. The listener fires when the
  // active registration for a namespace changes (register that beats the
  // current top; unregister of the current top promotes the next).
  onActiveChange(cb: ActiveChangeListener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private fireChange(
    namespace: string,
    prev: Registration | null,
    next: Registration | null,
  ): void {
    for (const cb of [...this.listeners]) {
      try { cb(namespace, prev, next); }
      catch { /* listener errors are isolated; the registry is sync + simple */ }
    }
  }
}
