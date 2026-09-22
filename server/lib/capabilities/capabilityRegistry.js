'use strict';

// Normalized capability aggregate view.
//
// Builds an immutable, queryable registry from the discovery sources. This
// class has NO execution behavior: it is a metadata index only. IDs are
// stable and unique (native:<tool> / mcp.<slug>.<tool>) and deterministic
// for a given source state. The underlying native/MCP registries remain
// authoritative — this aggregate is a read-only projection.

const { SOURCE_NATIVE, SOURCE_MCP } = require('./capabilityTypes');
const { discoverNative, discoverMcp } = require('./discover');

class CapabilityRegistry {
  // Entries is an array of capability objects (already discovered).
  constructor(entries = []) {
    this._byId = new Map();
    this._entries = [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
      // Stable uniqueness: first writer wins; later duplicates are dropped
      // rather than silently overwriting (deterministic for a given source).
      if (this._byId.has(entry.id)) continue;
      this._byId.set(entry.id, entry);
      this._entries.push(entry);
    }
    this._entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    Object.freeze(this._entries);
  }

  get size() {
    return this._entries.length;
  }

  // Full sorted array (frozen).
  all() {
    return this._entries;
  }

  byId(id) {
    return this._byId.get(id) || null;
  }

  bySource(source) {
    if (source !== SOURCE_NATIVE && source !== SOURCE_MCP) return [];
    return this._entries.filter((c) => c.source === source);
  }

  native() {
    return this.bySource(SOURCE_NATIVE);
  }

  mcp() {
    return this.bySource(SOURCE_MCP);
  }

  byScope(scope) {
    return this._entries.filter((c) => c.scope === scope);
  }

  byRisk(risk) {
    return this._entries.filter((c) => c.risk === risk);
  }

  // Unique IDs must hold for the whole aggregate regardless of source.
  ids() {
    return this._entries.map((c) => c.id);
  }

  // Source counts / metadata summary.
  summary() {
    const counts = { total: this.size, native: 0, mcp: 0 };
    for (const c of this._entries) {
      if (c.source === SOURCE_NATIVE) counts.native += 1;
      else if (c.source === SOURCE_MCP) counts.mcp += 1;
    }
    return counts;
  }
}

// Async convenience: discover both sources and build the aggregate.
const buildCapabilityRegistry = async ({ workspaceId = null, isGuest = false } = {}) => {
  const native = discoverNative();
  const mcp = await discoverMcp({ workspaceId, isGuest });
  return new CapabilityRegistry([...native, ...mcp]);
};

module.exports = {
  CapabilityRegistry,
  buildCapabilityRegistry,
};