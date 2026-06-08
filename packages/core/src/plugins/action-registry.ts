// Plugin action registry: core-side bookkeeping for sdk.actions.register /
// invoke / list (core-plugin-api.md §10). Tracks which plugin owns which
// action name. Unlike the namespace registry, actions are flat:
//   - one owner per name (duplicate registrations are errors, not priorities);
//   - no failure promotion (an action either exists or doesn't);
//   - schema is opaque to core (used by future IPC for validation/help).
//
// Pure data structure: no transport. The runtime drives it (register on
// actions.register, unregister on plugin death, query for invocation
// routing).

// JSON-Schema-ish opaque blob. Core never inspects it; the IPC layer (phase 1)
// uses it for validation. Plugins may pass undefined.
export type ActionSchema = unknown;

export interface Registration {
  // The plugin that owns this action (matches ResolvedPlugin.name).
  pluginName: string;
  // The action name (namespaced: 'workspace.show', 'window.close', ...).
  name: string;
  // Optional human-readable description (for IPC help, CLI introspection).
  description?: string;
  // Optional schema for parameter validation (consumed by the IPC layer).
  schema?: ActionSchema;
}

// Public introspection shape returned by sdk.actions.list (and the IPC's
// list-actions). Same fields as Registration minus the owning plugin (which
// is an implementation detail).
export interface ActionInfo {
  name: string;
  description?: string;
  schema?: ActionSchema;
}

export class ActionRegistry {
  private byName = new Map<string, Registration>();
  // pluginName -> set of action names it owns (for fast removal on plugin
  // death).
  private byPlugin = new Map<string, Set<string>>();

  // Register an action. Throws if `name` is already taken (collisions are
  // bugs, per core-plugin-api.md "Decided" -- the priority-chain is for
  // events, not for naming).
  register(reg: Registration): void {
    if (typeof reg.name !== "string" || reg.name.length === 0) {
      throw new TypeError("action name must be a non-empty string");
    }
    if (typeof reg.pluginName !== "string" || reg.pluginName.length === 0) {
      throw new TypeError("pluginName must be a non-empty string");
    }
    const existing = this.byName.get(reg.name);
    if (existing) {
      throw new Error(
        `action '${reg.name}' already registered by '${existing.pluginName}'`);
    }
    this.byName.set(reg.name, reg);
    const owned = this.byPlugin.get(reg.pluginName) ?? new Set<string>();
    owned.add(reg.name);
    this.byPlugin.set(reg.pluginName, owned);
  }

  // Unregister an action. Only the owning plugin may unregister; a mismatched
  // plugin is a silent no-op (idempotent / forward-compatible). Returns true
  // if a registration was removed.
  unregister(pluginName: string, name: string): boolean {
    const existing = this.byName.get(name);
    if (!existing || existing.pluginName !== pluginName) return false;
    this.byName.delete(name);
    const owned = this.byPlugin.get(pluginName);
    owned?.delete(name);
    if (owned?.size === 0) this.byPlugin.delete(pluginName);
    return true;
  }

  // Unregister every action a plugin owns (called when a plugin dies /
  // permanently fails).
  unregisterAllFor(pluginName: string): void {
    const owned = this.byPlugin.get(pluginName);
    if (!owned) return;
    // Snapshot the set; unregister() mutates byPlugin so we'd lose entries
    // mid-iteration otherwise.
    for (const name of [...owned]) this.unregister(pluginName, name);
  }

  // Lookup the owning registration for an action by name.
  lookup(name: string): Registration | null {
    return this.byName.get(name) ?? null;
  }

  // All registered actions in a stable order (alphabetical by name). Used by
  // sdk.actions.list and the IPC list-actions method.
  list(): ActionInfo[] {
    const entries = [...this.byName.values()];
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return entries.map((r) => {
      const info: ActionInfo = { name: r.name };
      if (r.description !== undefined) info.description = r.description;
      if (r.schema !== undefined) info.schema = r.schema;
      return info;
    });
  }
}
