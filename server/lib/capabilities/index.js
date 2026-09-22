'use strict';

// JARVIS Action Substrate — read-only capability facade (slice 1).
//
// Everything outside server/lib/capabilities should import from HERE, never
// from the internal modules. The facade exposes:
//
//   capabilityTypes      normalized contract + validation
//   risk                 pure scope/risk classification metadata
//   discoverNative()     native capabilities from the live native registry
//   discoverMcp(opts)    MCP capabilities from the live MCP source
//   discoverAll(opts)    combined capability array
//   CapabilityRegistry   immutable normalized aggregate view
//   buildCapabilityRegistry(opts)  async helper -> aggregated registry
//
// Slice 1 is strictly architectural inventory/normalization: NO execution,
// NO policy behavior, NO TaskExecutor/MCP/voice/planner changes.

const capabilityTypes = require('./capabilityTypes');
const risk = require('./risk');
const discover = require('./discover');
const { CapabilityRegistry, buildCapabilityRegistry } = require('./capabilityRegistry');

module.exports = {
  capabilityTypes,
  risk,
  ...discover,
  CapabilityRegistry,
  buildCapabilityRegistry,
};