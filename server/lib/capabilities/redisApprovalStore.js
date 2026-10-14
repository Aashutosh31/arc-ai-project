'use strict';

// Redis-backed approval store for multi-instance deployments.
// Maintains the same interface as the in-memory approvalStore.
// Uses Lua scripts for atomic CAS operations.

const crypto = require('crypto');
const observability = require('./observability');
const Redis = require('ioredis');

const STATES = Object.freeze({
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    DENIED: 'DENIED',
    EXPIRED: 'EXPIRED',
    CANCELLED: 'CANCELLED',
});

const TERMINAL = Object.freeze([
    STATES.APPROVED,
    STATES.DENIED,
    STATES.EXPIRED,
    STATES.CANCELLED,
]);
const TERMINAL_SET = new Set(TERMINAL);

const EVENTS = Object.freeze({
    APPROVAL_REQUESTED: 'agent:approval:requested',
    APPROVAL_RESOLVE: 'agent:approval:resolve',
});

const DEFAULT_TTL_MS = (() => {
    const n = Number(process.env.APPROVAL_TTL_MS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30000;
})();

const genId = () => `apr-${crypto.randomBytes(9).toString('hex')}`;

const finiteNonNeg = (v, fallback) =>
    Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;

const normalizeId = (v) => (v === undefined || v === null ? undefined : String(v));

const normalizeSocketId = (v) => {
    const s = normalizeId(v);
    return typeof s === 'string' && s.trim() !== '' ? s : undefined;
};

const stateReason = (state) => {
    if (state === STATES.EXPIRED) return 'expired';
    if (TERMINAL_SET.has(state)) return 'already_resolved';
    return 'not_pending';
};

const eventFor = (state) => {
    switch (state) {
        case STATES.APPROVED: return observability.LOG_EVENTS.APPROVAL_APPROVED;
        case STATES.DENIED: return observability.LOG_EVENTS.APPROVAL_DENIED;
        case STATES.EXPIRED: return observability.LOG_EVENTS.APPROVAL_EXPIRED;
        case STATES.CANCELLED: return observability.LOG_EVENTS.APPROVAL_CANCELLED;
        default: return null;
    }
};

const emit = (event, record) => {
    try {
        observability.log(event, {
            approvalId: record.approvalId,
            executionId: record.executionId,
            capabilityId: record.capabilityId,
            toolName: record.toolName,
            source: record.source,
            workspaceId: record.workspaceId,
            risk: record.risk,
            scope: record.scope,
            state: record.state,
            decision: record.decision || null,
            reason: record.reason || null,
            durationMs: finiteNonNeg(record.resolvedAt - record.createdAt, 0),
        });
    } catch {
        // Observability must never break the approval path.
    }
};

// Redis key prefixes
const KEY_PREFIX = 'approval:';
const INDEX_PREFIX = 'approval:index:';
const TTL_PREFIX = 'approval:ttl:';

// Lua script for atomic create (setnx + expire)
const CREATE_SCRIPT = `
local key = KEYS[1]
local data = ARGV[1]
local ttl = tonumber(ARGV[2])
local result = redis.call('SET', key, data, 'EX', math.ceil(ttl / 1000), 'NX')
if result then
    redis.call('ZADD', KEYS[2], ARGV[3], key)
    return 1
else
    return 0
end
`;

// Lua script for atomic CAS transition
const TRANSITION_SCRIPT = `
local key = KEYS[1]
local index_key = KEYS[2]
local expected_state = ARGV[1]
local new_state = ARGV[2]
local decision = ARGV[3]
local resolved_at = ARGV[4]

local current = redis.call('GET', key)
if not current then
    return {0, 'unknown'}
end

local record = cjson.decode(current)
if record.state ~= expected_state then
    return {0, record.state}
end

record.state = new_state
record.decision = decision
record.resolvedAt = tonumber(resolved_at)
local new_data = cjson.encode(record)

redis.call('SET', key, new_data, 'KEEPTTL')
redis.call('ZREM', index_key, key)
return {1, new_data}
`;

// Lua script for atomic resolve with binding checks
const RESOLVE_SCRIPT = `
local key = KEYS[1]
local index_key = KEYS[2]
local approval_id = ARGV[1]
local decision = ARGV[2]
local user_id = ARGV[3]
local socket_id = ARGV[4]
local execution_id = ARGV[5]
local workspace_id = ARGV[6]
local capability_id = ARGV[7]
local now = tonumber(ARGV[8])

local current = redis.call('GET', key)
if not current then
    return {0, 'unknown', nil}
end

local record = cjson.decode(current)
if record.state ~= 'PENDING' then
    return {0, record.state, cjson.encode(record)}
end

if record.userId ~= user_id then
    return {0, 'user_mismatch', cjson.encode(record)}
end

if record._initiatingSocketId ~= socket_id then
    return {0, 'socket_mismatch', cjson.encode(record)}
end

if execution_id ~= '' and record.executionId ~= execution_id then
    return {0, 'execution_mismatch', cjson.encode(record)}
end

if workspace_id ~= '' and record.workspaceId ~= workspace_id then
    return {0, 'workspace_mismatch', cjson.encode(record)}
end

if capability_id ~= '' and record.capabilityId ~= capability_id then
    return {0, 'capability_mismatch', cjson.encode(record)}
end

if now >= record.expiresAt then
    record.state = 'EXPIRED'
    record.resolvedAt = now
    redis.call('SET', key, cjson.encode(record), 'KEEPTTL')
    redis.call('ZREM', index_key, key)
    return {0, 'expired', cjson.encode(record)}
end

local new_state = decision == 'approve' and 'APPROVED' or 'DENIED'
record.state = new_state
record.decision = decision
record.resolvedAt = now
local new_data = cjson.encode(record)

redis.call('SET', key, new_data, 'KEEPTTL')
redis.call('ZREM', index_key, key)
return {1, cjson.encode(record)}
`;

// Lua script for cancel
const CANCEL_SCRIPT = `
local key = KEYS[1]
local index_key = KEYS[2]
local approval_id = ARGV[1]
local user_id = ARGV[2]
local now = tonumber(ARGV[3])

local current = redis.call('GET', key)
if not current then
    return {0, 'unknown', nil}
end

local record = cjson.decode(current)
if record.userId ~= user_id then
    return {0, 'user_mismatch', cjson.encode(record)}
end

if record.state ~= 'PENDING' then
    return {0, record.state, cjson.encode(record)}
end

if now >= record.expiresAt then
    record.state = 'EXPIRED'
    record.resolvedAt = now
    redis.call('SET', key, cjson.encode(record), 'KEEPTTL')
    redis.call('ZREM', index_key, key)
    return {0, 'expired', cjson.encode(record)}
end

record.state = 'CANCELLED'
record.resolvedAt = now
local new_data = cjson.encode(record)

redis.call('SET', key, new_data, 'KEEPTTL')
redis.call('ZREM', index_key, key)
return {1, cjson.encode(record)}
`;

// Lua script for cleanup (prune expired terminal records)
const PRUNE_SCRIPT = `
local index_key = KEYS[1]
local ttl_ms = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

local keys = redis.call('ZRANGE', index_key, 0, limit - 1)
local deleted = 0
for i, key in ipairs(keys) do
    local data = redis.call('GET', key)
    if data then
        local record = cjson.decode(data)
        if record.state ~= 'PENDING' and (now - (record.resolvedAt or record.createdAt)) > ttl_ms then
            redis.call('DEL', key)
            redis.call('ZREM', index_key, key)
            deleted = deleted + 1
        end
    end
end
return deleted
`;

class RedisApprovalStore {
    constructor(options = {}) {
        this.redis = options.redis || new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => Math.min(times * 100, 3000),
            enableReadyCheck: true,
            lazyConnect: true,
        });
        this.connected = false;
        this.createScript = this.redis.defineCommand('approvalCreate', { numberOfKeys: 2, lua: CREATE_SCRIPT });
        this.transitionScript = this.redis.defineCommand('approvalTransition', { numberOfKeys: 2, lua: TRANSITION_SCRIPT });
        this.resolveScript = this.redis.defineCommand('approvalResolve', { numberOfKeys: 2, lua: RESOLVE_SCRIPT });
        this.cancelScript = this.redis.defineCommand('approvalCancel', { numberOfKeys: 2, lua: CANCEL_SCRIPT });
        this.pruneScript = this.redis.defineCommand('approvalPrune', { numberOfKeys: 1, lua: PRUNE_SCRIPT });
    }

    async connect() {
        if (!this.connected) {
            await this.redis.connect();
            this.connected = true;
            // Start periodic pruning
            this.pruneInterval = setInterval(() => this.prune(), DEFAULT_TTL_MS);
            if (typeof this.pruneInterval.unref === 'function') this.pruneInterval.unref();
        }
    }

    async disconnect() {
        if (this.pruneInterval) clearInterval(this.pruneInterval);
        await this.redis.quit();
        this.connected = false;
    }

    async create({
        executionId,
        userId,
        workspaceId = null,
        capabilityId,
        initiatingSocketId,
        source,
        toolName = null,
        risk = null,
        scope = null,
        reason = null,
        ttlMs = DEFAULT_TTL_MS,
    }) {
        await this.connect();

        const socketId = normalizeSocketId(initiatingSocketId);
        if (!executionId || !userId || !capabilityId || !socketId) {
            throw new Error(
                'approvalStore: executionId, userId, capabilityId and initiatingSocketId are required'
            );
        }

        const now = Date.now();
        const ttl = finiteNonNeg(ttlMs, DEFAULT_TTL_MS) || DEFAULT_TTL_MS;
        const approvalId = genId();

        const record = {
            approvalId,
            executionId: String(executionId),
            userId: String(userId),
            workspaceId: workspaceId === undefined || workspaceId === null ? null : String(workspaceId),
            capabilityId: String(capabilityId),
            source: source || null,
            toolName: toolName || null,
            risk: risk || null,
            scope: scope || null,
            reason: reason || null,
            state: STATES.PENDING,
            decision: null,
            createdAt: now,
            expiresAt: now + ttl,
            resolvedAt: null,
            _initiatingSocketId: socketId,
        };

        const data = JSON.stringify(record);
        const key = `${KEY_PREFIX}${approvalId}`;
        const indexKey = `${INDEX_PREFIX}pending`;
        const expiresAt = now + ttl;

        const result = await this.redis.approvalCreate(key, indexKey, data, ttl, expiresAt);

        if (!result) {
            throw new Error('Failed to create approval (concurrent create?)');
        }

        emit(observability.LOG_EVENTS.APPROVAL_REQUESTED, { ...record, resolvedAt: now });
        await this.prune();

        return this.snapshot(record);
    }

    async resolve({ approvalId, decision, userId, socketId, executionId, workspaceId, capabilityId }) {
        await this.connect();

        const approvalIdNorm = normalizeId(approvalId);
        if (!approvalIdNorm) return { ok: false, reason: 'unknown' };

        if (decision !== 'approve' && decision !== 'deny') {
            return { ok: false, reason: 'invalid_decision' };
        }

        const key = `${KEY_PREFIX}${approvalIdNorm}`;
        const indexKey = `${INDEX_PREFIX}pending`;
        const now = Date.now();

        const result = await this.redis.approvalResolve(
            key,
            indexKey,
            approvalIdNorm,
            decision,
            String(userId),
            String(socketId),
            executionId ? String(executionId) : '',
            workspaceId ? String(workspaceId) : '',
            capabilityId ? String(capabilityId) : '',
            now
        );

        const success = result[0] === 1;
        const reason = result[1];
        const recordData = result[2];

        if (!recordData) {
            return { ok: false, reason };
        }

        const record = JSON.parse(recordData);
        if (success) {
            emit(eventFor(record.state), record);
            return { ok: true, state: record.state, record: this.snapshot(record) };
        }
        return { ok: false, reason, state: record.state, record: this.snapshot(record) };
    }

    async cancel({ approvalId, userId }) {
        await this.connect();

        const approvalIdNorm = normalizeId(approvalId);
        if (!approvalIdNorm) return { ok: false, reason: 'unknown' };

        const key = `${KEY_PREFIX}${approvalIdNorm}`;
        const indexKey = `${INDEX_PREFIX}pending`;
        const now = Date.now();

        const result = await this.redis.approvalCancel(
            key,
            indexKey,
            approvalIdNorm,
            String(userId),
            now
        );

        const success = result[0] === 1;
        const reason = result[1];
        const recordData = result[2];

        if (!recordData) {
            return { ok: false, reason };
        }

        const record = JSON.parse(recordData);
        if (success) {
            emit(eventFor(record.state), record);
            return { ok: true, state: record.state, record: this.snapshot(record) };
        }
        return { ok: false, reason, state: record.state, record: this.snapshot(record) };
    }

    async waitForDecision(approvalId) {
        await this.connect();

        const approvalIdNorm = normalizeId(approvalId);
        const key = `${KEY_PREFIX}${approvalIdNorm}`;

        // Poll for decision (with a reasonable timeout)
        const maxWait = 35000; // Slightly longer than TTL
        const pollInterval = 500;
        const start = Date.now();

        while (Date.now() - start < maxWait) {
            const data = await this.redis.get(key);
            if (!data) {
                return { state: STATES.EXPIRED, approvalId: approvalIdNorm, reason: 'unknown' };
            }
            const record = JSON.parse(data);
            if (record.state !== STATES.PENDING) {
                return this.snapshot(record);
            }
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        // Timeout - check one last time
        const data = await this.redis.get(key);
        if (!data) {
            return { state: STATES.EXPIRED, approvalId: approvalIdNorm, reason: 'timeout' };
        }
        return this.snapshot(JSON.parse(data));
    }

    async read(approvalId) {
        await this.connect();
        const approvalIdNorm = normalizeId(approvalId);
        const key = `${KEY_PREFIX}${approvalIdNorm}`;
        const data = await this.redis.get(key);
        return data ? this.snapshot(JSON.parse(data)) : null;
    }

    async list() {
        await this.connect();
        const indexKey = `${INDEX_PREFIX}pending`;
        // Note: This only lists pending approvals. For all, we'd need a different index.
        const keys = await this.redis.zrange(indexKey, 0, -1);
        const records = [];
        for (const key of keys) {
            const data = await this.redis.get(key);
            if (data) records.push(this.snapshot(JSON.parse(data)));
        }
        return records;
    }

    async prune() {
        await this.connect();
        const indexKey = `${INDEX_PREFIX}pending`;
        const now = Date.now();
        await this.redis.approvalPrune(indexKey, DEFAULT_TTL_MS, now, 100);
    }

    snapshot(record) {
        return {
            approvalId: record.approvalId,
            executionId: record.executionId,
            userId: record.userId,
            workspaceId: record.workspaceId,
            capabilityId: record.capabilityId,
            source: record.source,
            toolName: record.toolName,
            risk: record.risk,
            scope: record.scope,
            reason: record.reason,
            state: record.state,
            decision: record.decision,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            resolvedAt: record.resolvedAt,
        };
    }

    async shutdown() {
        await this.disconnect();
    }
}

// Factory function to get the appropriate store based on configuration
let storeInstance = null;

function getStore() {
    if (storeInstance) return storeInstance;

    const useRedis = process.env.REDIS_URL || process.env.REDIS_HOST;
    if (useRedis) {
        storeInstance = new RedisApprovalStore();
    } else {
        // Fall back to in-memory store
        const memoryStore = require('./approvalStore');
        storeInstance = memoryStore;
    }
    return storeInstance;
}

// Export both implementations and the factory
module.exports = {
    STATES,
    TERMINAL,
    TERMINAL_SET,
    EVENTS,
    DEFAULT_TTL_MS,
    RedisApprovalStore,
    getStore,
    // For backwards compatibility, also export the in-memory store
    ...require('./approvalStore'),
};