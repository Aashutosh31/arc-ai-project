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
const authorizationPolicy = require('./authorizationPolicy');
const operatorPolicy = require('./operatorPolicy');
const { CapabilityRegistry, buildCapabilityRegistry } = require('./capabilityRegistry');
const executionEnvelope = require('./executionEnvelope');
const envelopeClassification = require('./envelopeClassification');
const observability = require('./observability');
const idempotency = require('./idempotency');
const idempotencyKey = require('./idempotencyKey');
const idempotencyStore = require('./idempotencyStore');

module.exports = {
  capabilityTypes,
  risk,
  ...discover,
  CapabilityRegistry,
  buildCapabilityRegistry,
  // Slice 4A: server-authoritative authorization policy (pure verdict engine).
  authorizationPolicy,
  // Slice 4B: process-wide operator policy base read at the execution boundary.
  operatorPolicy,
  // Slice 2: execution-envelope + lifecycle-observability surface (additive).
  ExecutionEnvelope: executionEnvelope.ExecutionEnvelope,
  createExecutionEnvelope: executionEnvelope.createExecutionEnvelope,
  resolveExecutionCapability: executionEnvelope.resolveCapability,
  envelopeClassification,
  observability,
  // Slice 3: idempotency + duplicate-side-effect protection surface.
  idempotency,
  idempotencyKey,
  idempotencyStore,
};