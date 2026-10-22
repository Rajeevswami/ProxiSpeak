/**
 * Distributed Redis implementation of `EdgeStore` (Week 3, Day 12).
 *
 * Redis key schema (every segment strictly validated before touching Redis;
 * pair tokens are length-prefixed `<lenA>:<a>:<lenB>:<b>` with `a < b`, making
 * delimiter collisions mathematically impossible):
 *
 *   `<prefix>:edge:<pairToken>`       HASH { roomId, a, b, generation }
 *   `<prefix>:gen:<pairToken>`        STRING integer (monotonic via Redis INCR)
 *   `<prefix>:user-edges:<userId>`    SET of `<pairToken>`s currently live
 *   `<prefix>:user-pairs:<userId>`    SET of `<pairToken>`s opened in session
 *
 * Every key carries a bounded safety TTL (`ttlSeconds`, default 3600s) and an
 * explicit deterministic removal path (`removeEdge`, `removeUser`, and
 * `SCAN`-based `sweepOrphanEdges`). `KEYS` is never used anywhere.
 */
import config from '../config/index.js';
import {
  EdgeStore,
  buildEdgeRecord,
  decodePairToken,
  normalizePair,
  validateKeyPrefix,
  validateRoomId,
  validateUserId,
} from './edgeStore.js';

const CREATE_EDGE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  local existingGen = tonumber(redis.call('HGET', KEYS[1], 'generation'))
  return { 0, existingGen, 0 }
end
local cap = tonumber(ARGV[7]) or 0
if cap > 0 then
  if redis.call('SCARD', KEYS[3]) >= cap or redis.call('SCARD', KEYS[4]) >= cap then
    return { 0, 0, 1 }
  end
end
local base = tonumber(redis.call('GET', KEYS[2]) or '0')
local floor = tonumber(ARGV[6]) or 0
if floor > base then
  base = floor
end
local gen = base + 1
local ttl = tonumber(ARGV[5])
redis.call('SET', KEYS[2], tostring(gen), 'EX', ttl)
redis.call('HSET', KEYS[1], 'roomId', ARGV[1], 'a', ARGV[2], 'b', ARGV[3], 'generation', tostring(gen))
redis.call('SADD', KEYS[3], ARGV[4])
redis.call('SADD', KEYS[4], ARGV[4])
redis.call('SADD', KEYS[5], ARGV[4])
redis.call('SADD', KEYS[6], ARGV[4])
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[3], ttl)
redis.call('EXPIRE', KEYS[4], ttl)
redis.call('EXPIRE', KEYS[5], ttl)
redis.call('EXPIRE', KEYS[6], ttl)
return { 1, gen, 0 }
`;

const REMOVE_EDGE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return { 0 }
end
local roomId = redis.call('HGET', KEYS[1], 'roomId')
if roomId ~= ARGV[1] then
  return { 0 }
end
local a = redis.call('HGET', KEYS[1], 'a')
local b = redis.call('HGET', KEYS[1], 'b')
local gen = tonumber(redis.call('HGET', KEYS[1], 'generation'))
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[3], ARGV[2])
redis.call('SREM', KEYS[4], ARGV[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return { 1, roomId, a, b, gen }
`;

const EDGES_OF_LUA = `
local prefix = ARGV[1]
local tokens = redis.call('SMEMBERS', KEYS[1])
local out = {}
for i = 1, #tokens do
  local token = tokens[i]
  local edgeKey = prefix .. ':edge:' .. token
  if redis.call('EXISTS', edgeKey) == 1 then
    out[#out + 1] = redis.call('HGET', edgeKey, 'roomId')
    out[#out + 1] = redis.call('HGET', edgeKey, 'a')
    out[#out + 1] = redis.call('HGET', edgeKey, 'b')
    out[#out + 1] = tonumber(redis.call('HGET', edgeKey, 'generation'))
  else
    redis.call('SREM', KEYS[1], token)
  end
end
return out
`;

const REMOVE_USER_LUA = `
local prefix = ARGV[1]
local userId = ARGV[2]
local out = {}
local floors = {}
local liveTokens = redis.call('SMEMBERS', KEYS[1])
for i = 1, #liveTokens do
  local token = liveTokens[i]
  local edgeKey = prefix .. ':edge:' .. token
  if redis.call('EXISTS', edgeKey) == 1 then
    local roomId = redis.call('HGET', edgeKey, 'roomId')
    local a = redis.call('HGET', edgeKey, 'a')
    local b = redis.call('HGET', edgeKey, 'b')
    local gen = tonumber(redis.call('HGET', edgeKey, 'generation'))
    redis.call('DEL', edgeKey)
    local peer = a == userId and b or a
    redis.call('SREM', prefix .. ':user-edges:' .. peer, token)
    out[#out + 1] = roomId
    out[#out + 1] = a
    out[#out + 1] = b
    out[#out + 1] = gen
    floors[#floors + 1] = peer
    floors[#floors + 1] = gen
  end
end
redis.call('DEL', KEYS[1])

local pairTokens = redis.call('SMEMBERS', KEYS[2])
for i = 1, #pairTokens do
  local token = pairTokens[i]
  local c1 = string.find(token, ':', 1, true)
  local lenA = tonumber(string.sub(token, 1, c1 - 1))
  local a = string.sub(token, c1 + 1, c1 + lenA)
  local c2 = string.find(token, ':', c1 + lenA + 2, true)
  local b = string.sub(token, c2 + 1)
  local peer = a == userId and b or a
  local genVal = tonumber(redis.call('GET', prefix .. ':gen:' .. token) or '0')
  if genVal and genVal > 0 then
    floors[#floors + 1] = peer
    floors[#floors + 1] = genVal
  end
  redis.call('SREM', prefix .. ':user-pairs:' .. peer, token)
  redis.call('DEL', prefix .. ':gen:' .. token)
end
redis.call('DEL', KEYS[2])
return { out, floors }
`;

function unpackEdgeTuples(flat) {
  const edges = [];
  for (let i = 0; i + 3 < flat.length; i += 4) {
    edges.push(buildEdgeRecord(flat[i], flat[i + 1], flat[i + 2], Number(flat[i + 3])));
  }
  return edges.sort((left, right) => left.key.localeCompare(right.key));
}

export class RedisEdgeStore extends EdgeStore {
  /**
   * @param {object} options
   * @param {import('ioredis').Redis} options.client dedicated ioredis client
   * @param {string} [options.keyPrefix] validated prefix
   * @param {number} [options.ttlSeconds] bounded safety TTL on every key
   */
  constructor({
    client,
    keyPrefix = config.redis.keyPrefix,
    ttlSeconds = config.redis.edgeTtlSeconds,
    maxPeersPerUser,
  } = {}) {
    super();
    if (!client) throw new TypeError('RedisEdgeStore requires a Redis client');
    this.client = client;
    this.keyPrefix = validateKeyPrefix(keyPrefix);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new RangeError('ttlSeconds must be a positive integer');
    }
    this.ttlSeconds = ttlSeconds;
    if (maxPeersPerUser !== undefined) {
      if (!Number.isInteger(maxPeersPerUser) || maxPeersPerUser < 0) {
        throw new RangeError('maxPeersPerUser must be a non-negative integer');
      }
      this.maxPeersPerUser = maxPeersPerUser;
    } else {
      this.maxPeersPerUser = null;
    }
    /** @type {Map<string, number>} userId -> highest generation seen on departed peers */
    this.userGenFloor = new Map();
    /** @type {Map<string, number>} pairToken -> highest generation issued in live session */
    this.pairGenFloor = new Map();
    this.totalGenerations = 0;
  }

  getMaxPeers() {
    if (Number.isInteger(this.maxPeersPerUser)) return this.maxPeersPerUser;
    try {
      if (config?.proximity?.maxPeersPerUser !== undefined) return config.proximity.maxPeersPerUser;
    } catch {}
    return 8;
  }

  recordUserFloor(userId, generation) {
    validateUserId(userId);
    if (!Number.isInteger(generation) || generation < 1) return;
    const prev = this.userGenFloor.get(userId) ?? 0;
    if (generation > prev) this.userGenFloor.set(userId, generation);
  }

  recordPairFloor(u1, u2, generation) {
    if (!Number.isInteger(generation) || generation < 1) return;
    const [a, b] = normalizePair(u1, u2);
    const token = `${a.length}:${a}:${b.length}:${b}`;
    const prev = this.pairGenFloor.get(token) ?? 0;
    if (generation > prev) this.pairGenFloor.set(token, generation);
  }

  edgeHashKey(token) {
    return `${this.keyPrefix}:edge:${token}`;
  }

  genKey(token) {
    return `${this.keyPrefix}:gen:${token}`;
  }

  userEdgesKey(userId) {
    validateUserId(userId);
    return `${this.keyPrefix}:user-edges:${userId}`;
  }

  userPairsKey(userId) {
    validateUserId(userId);
    return `${this.keyPrefix}:user-pairs:${userId}`;
  }

  async createEdge(roomId, u1, u2) {
    validateRoomId(roomId);
    const [a, b] = normalizePair(u1, u2);
    const token = `${a.length}:${a}:${b.length}:${b}`;

    const floor = Math.max(
      this.pairGenFloor.get(token) ?? 0,
      this.userGenFloor.get(a) ?? 0,
      this.userGenFloor.get(b) ?? 0,
    );
    const cap = this.getMaxPeers();
    const [createdFlag, rawGen, cappedFlag] = await this.client.eval(
      CREATE_EDGE_LUA,
      6,
      this.edgeHashKey(token),
      this.genKey(token),
      this.userEdgesKey(a),
      this.userEdgesKey(b),
      this.userPairsKey(a),
      this.userPairsKey(b),
      roomId,
      a,
      b,
      token,
      String(this.ttlSeconds),
      String(floor),
      String(cap),
    );
    const created = Number(createdFlag) === 1;
    const capped = Number(cappedFlag) === 1;
    const generation = Number(rawGen);
    if (generation > (this.pairGenFloor.get(token) ?? 0)) {
      this.pairGenFloor.set(token, generation);
    }
    if (created) this.totalGenerations += 1;
    if (capped) return { created: false, capped: true, generation: generation || 0 };
    return { created, generation };
  }

  async removeEdgeWithRecord(roomId, u1, u2) {
    validateRoomId(roomId);
    const [a, b] = normalizePair(u1, u2);
    const token = `${a.length}:${a}:${b.length}:${b}`;

    const reply = await this.client.eval(
      REMOVE_EDGE_LUA,
      4,
      this.edgeHashKey(token),
      this.genKey(token),
      this.userEdgesKey(a),
      this.userEdgesKey(b),
      roomId,
      token,
      String(this.ttlSeconds),
    );
    if (Number(reply[0]) !== 1) {
      return { removed: false, edge: null };
    }
    const edge = buildEdgeRecord(reply[1], reply[2], reply[3], Number(reply[4]));
    return { removed: true, edge: { ...edge } };
  }

  async removeEdge(roomId, u1, u2) {
    const { removed } = await this.removeEdgeWithRecord(roomId, u1, u2);
    return removed;
  }

  async getEdge(u1, u2) {
    const [a, b] = normalizePair(u1, u2);
    const token = `${a.length}:${a}:${b.length}:${b}`;
    const fields = await this.client.hgetall(this.edgeHashKey(token));
    if (!fields || !fields.roomId) return null;
    return { ...buildEdgeRecord(fields.roomId, fields.a, fields.b, Number(fields.generation)) };
  }

  async edgesOf(userId) {
    const key = this.userEdgesKey(userId);
    const flat = await this.client.eval(EDGES_OF_LUA, 1, key, this.keyPrefix);
    return unpackEdgeTuples(flat);
  }

  async removeUser(userId) {
    const liveKey = this.userEdgesKey(userId);
    const pairsKey = this.userPairsKey(userId);
    const [flat, floors = []] = await this.client.eval(
      REMOVE_USER_LUA,
      2,
      liveKey,
      pairsKey,
      this.keyPrefix,
      userId,
    );
    for (let i = 0; i + 1 < floors.length; i += 2) {
      this.recordUserFloor(floors[i], Number(floors[i + 1]));
    }
    for (const token of [...this.pairGenFloor.keys()]) {
      const { a, b } = decodePairToken(token);
      if (a === userId || b === userId) {
        const peerId = a === userId ? b : a;
        this.recordUserFloor(peerId, this.pairGenFloor.get(token) ?? 0);
        this.pairGenFloor.delete(token);
      }
    }
    this.userGenFloor.delete(userId);
    return unpackEdgeTuples(flat);
  }

  /**
   * Cursor-based SCAN helper (`KEYS` is strictly forbidden in production and tests).
   */
  async scanKeys(pattern, count = 100) {
    const found = new Set();
    let cursor = '0';
    do {
      // eslint-disable-next-line no-await-in-loop -- cursor pagination is inherently sequential
      const [nextCursor, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
      cursor = String(nextCursor);
      for (const key of batch) found.add(key);
    } while (cursor !== '0');
    return [...found].sort();
  }

  /** Count every key stored under this EdgeStore's namespace prefix via SCAN. */
  async countStoreKeys() {
    const keys = await this.scanKeys(`${this.keyPrefix}:*`);
    return keys.length;
  }

  /** Inspect all live edges via SCAN (used by orphan sweeps and diagnostics). */
  async allEdges(roomId) {
    const keys = await this.scanKeys(`${this.keyPrefix}:edge:*`);
    const edges = [];
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      const fields = await this.client.hgetall(key);
      if (!fields || !fields.roomId) continue;
      if (roomId !== undefined && fields.roomId !== roomId) continue;
      edges.push({ ...buildEdgeRecord(fields.roomId, fields.a, fields.b, Number(fields.generation)) });
    }
    return edges.sort((left, right) => left.key.localeCompare(right.key));
  }

  /** Scan user ids still holding session pair history (`<prefix>:user-pairs:<id>`). */
  async trackedPairUsers() {
    const prefixHead = `${this.keyPrefix}:user-pairs:`;
    const keys = await this.scanKeys(`${prefixHead}*`);
    const userIds = [];
    for (const key of keys) {
      const userId = key.slice(prefixHead.length);
      try {
        validateUserId(userId);
        userIds.push(userId);
      } catch {
        /* ignore malformed foreign keys */
      }
    }
    return userIds;
  }

  async clearRoom(roomId) {
    validateRoomId(roomId);
    const edges = await this.allEdges(roomId);
    const removed = [];
    for (const edge of edges) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await this.removeEdgeWithRecord(roomId, edge.a, edge.b);
      if (outcome.removed && outcome.edge) removed.push(outcome.edge);
      const token = `${edge.a.length}:${edge.a}:${edge.b.length}:${edge.b}`;
      // eslint-disable-next-line no-await-in-loop
      await this.client.del(this.genKey(token));
      // eslint-disable-next-line no-await-in-loop
      await this.client.srem(this.userPairsKey(edge.a), token);
      // eslint-disable-next-line no-await-in-loop
      await this.client.srem(this.userPairsKey(edge.b), token);
      this.pairGenFloor.delete(token);
    }
    return removed;
  }

  decodePair(token) {
    return decodePairToken(token);
  }
}

export default RedisEdgeStore;
