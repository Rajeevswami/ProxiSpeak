/**
 * Peer-edge store abstraction and default in-memory implementation.
 *
 * Interface contract (shared identically by MemoryEdgeStore and RedisEdgeStore):
 *   - createEdge(room, a, b)  -> { created: boolean, generation: number } (or Promise)
 *     Atomic and idempotent for unordered pair {a, b}. Only the caller that
 *     transitions the pair from absent -> live receives `created: true` and
 *     emits `peer:connect`; concurrent losers receive `created: false` with the
 *     winning generation. Generations increase monotonically per pair.
 *   - removeEdge(room, a, b)  -> boolean (or Promise<boolean>)
 *     Returns `true` ONLY for the caller that actually removed the live edge in
 *     `room` (only that caller emits `peer:disconnect`); `false` otherwise.
 *   - getEdge(a, b)           -> PeerEdge | null (or Promise)
 *   - edgesOf(userId)         -> PeerEdge[] (or Promise)
 *   - removeUser(userId)      -> PeerEdge[] (or Promise)
 *     Atomically removes every live edge incident to `userId`, returning only
 *     the edges actually removed by this call, and cleans up all per-user /
 *     per-pair bookkeeping so no stale entries remain.
 */

export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const KEY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export function validateRoomId(roomId) {
  if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
    throw new TypeError('roomId must match /^[a-z0-9][a-z0-9_-]{0,47}$/');
  }
  return roomId;
}

export function validateUserId(userId) {
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    throw new TypeError('userId must match /^[A-Za-z0-9_-]{1,128}$/');
  }
  return userId;
}

export function validateKeyPrefix(prefix) {
  if (typeof prefix !== 'string' || !KEY_PREFIX_PATTERN.test(prefix)) {
    throw new TypeError('keyPrefix must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/');
  }
  return prefix;
}

/** Order-independent identity of an undirected edge. */
export function edgeKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** The lexicographically smaller endpoint is always the deterministic offerer. */
export function pickInitiator(a, b) {
  return a < b ? a : b;
}

/** Validate and canonically sort a distinct pair of user ids. */
export function normalizePair(u1, u2) {
  validateUserId(u1);
  validateUserId(u2);
  if (u1 === u2) {
    throw new RangeError('self-edges are forbidden: endpoints must be distinct');
  }
  return u1 < u2 ? [u1, u2] : [u2, u1];
}

/**
 * Collision-free canonical pair encoding for Redis keys and internal maps:
 * `<lenA>:<a>:<lenB>:<b>` with `a < b` and `:` prohibited inside user ids.
 * Both length-prefixing AND alphabet disjointness make collisions impossible
 * (for example `("a_b", "c")` -> `"3:a_b:1:c"` vs `("a", "b_c")` -> `"1:a:3:b_c"`).
 */
export function encodePairToken(u1, u2) {
  const [a, b] = normalizePair(u1, u2);
  return `${a.length}:${a}:${b.length}:${b}`;
}

export function decodePairToken(token) {
  if (typeof token !== 'string') throw new TypeError('pair token must be a string');
  const firstColon = token.indexOf(':');
  if (firstColon <= 0) throw new TypeError('malformed pair token');
  const lenA = Number(token.slice(0, firstColon));
  if (!Number.isInteger(lenA) || lenA < 1) throw new TypeError('malformed pair token length');
  const aStart = firstColon + 1;
  const aEnd = aStart + lenA;
  if (token[aEnd] !== ':') throw new TypeError('malformed pair token separator');
  const a = token.slice(aStart, aEnd);
  const secondColon = token.indexOf(':', aEnd + 1);
  if (secondColon <= aEnd + 1) throw new TypeError('malformed pair token second length');
  const lenB = Number(token.slice(aEnd + 1, secondColon));
  if (!Number.isInteger(lenB) || lenB < 1) throw new TypeError('malformed pair token second length');
  const bStart = secondColon + 1;
  if (bStart + lenB !== token.length) throw new TypeError('malformed pair token tail');
  const b = token.slice(bStart);
  validateUserId(a);
  validateUserId(b);
  if (a >= b) throw new TypeError('pair token endpoints are not in canonical order');
  return { a, b };
}

export function buildEdgeRecord(roomId, a, b, generation) {
  return Object.freeze({
    key: edgeKey(a, b),
    roomId,
    a,
    b,
    generation,
    initiator: a,
  });
}

export class EdgeStore {
  createEdge() { throw new Error('EdgeStore.createEdge not implemented'); }
  removeEdge() { throw new Error('EdgeStore.removeEdge not implemented'); }
  getEdge() { throw new Error('EdgeStore.getEdge not implemented'); }
  edgesOf() { throw new Error('EdgeStore.edgesOf not implemented'); }
  removeUser() { throw new Error('EdgeStore.removeUser not implemented'); }
}

/**
 * Default process-local EdgeStore used whenever REDIS_URL is empty or at boot
 * fallback. Synchronous so single-instance operation has zero network or
 * promise overhead on the hot path.
 */
export class MemoryEdgeStore extends EdgeStore {
  constructor() {
    super();
    /** @type {Map<string, object>} pairToken -> frozen PeerEdge */
    this.edgesByToken = new Map();
    /** @type {Map<string, Set<string>>} userId -> Set<pairToken> of live edges */
    this.userEdges = new Map();
    /** @type {Map<string, number>} pairToken -> monotonic generation */
    this.pairGenerations = new Map();
    /** @type {Map<string, Set<string>>} userId -> Set<pairToken> of known pairs */
    this.userPairs = new Map();
    /** @type {Map<string, number>} userId -> highest generation seen on departed peers */
    this.userGenFloor = new Map();
    this.totalGenerations = 0;
  }

  recordUserFloor(userId, generation) {
    validateUserId(userId);
    if (!Number.isInteger(generation) || generation < 1) return;
    const prev = this.userGenFloor.get(userId) ?? 0;
    if (generation > prev) this.userGenFloor.set(userId, generation);
  }

  #addSetEntry(map, key, value) {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(value);
  }

  #deleteSetEntry(map, key, value) {
    const set = map.get(key);
    if (!set) return;
    set.delete(value);
    if (set.size === 0) map.delete(key);
  }

  createEdge(roomId, u1, u2) {
    validateRoomId(roomId);
    const [a, b] = normalizePair(u1, u2);
    const token = `${a.length}:${a}:${b.length}:${b}`;

    const existing = this.edgesByToken.get(token);
    if (existing) {
      return { created: false, generation: existing.generation };
    }

    const base = Math.max(
      this.pairGenerations.get(token) ?? 0,
      this.userGenFloor.get(a) ?? 0,
      this.userGenFloor.get(b) ?? 0,
    );
    const generation = base + 1;
    this.pairGenerations.set(token, generation);
    this.totalGenerations += 1;

    const edge = buildEdgeRecord(roomId, a, b, generation);
    this.edgesByToken.set(token, edge);
    this.#addSetEntry(this.userEdges, a, token);
    this.#addSetEntry(this.userEdges, b, token);
    this.#addSetEntry(this.userPairs, a, token);
    this.#addSetEntry(this.userPairs, b, token);

    return { created: true, generation };
  }

  removeEdgeWithRecord(roomId, u1, u2) {
    validateRoomId(roomId);
    const [a, b] = normalizePair(u1, u2);
    const token = `${a.length}:${a}:${b.length}:${b}`;

    const existing = this.edgesByToken.get(token);
    if (!existing || existing.roomId !== roomId) {
      return { removed: false, edge: null };
    }

    this.edgesByToken.delete(token);
    this.#deleteSetEntry(this.userEdges, a, token);
    this.#deleteSetEntry(this.userEdges, b, token);
    return { removed: true, edge: { ...existing } };
  }

  removeEdge(roomId, u1, u2) {
    return this.removeEdgeWithRecord(roomId, u1, u2).removed;
  }

  getEdge(u1, u2) {
    const [a, b] = normalizePair(u1, u2);
    const token = `${a.length}:${a}:${b.length}:${b}`;
    const existing = this.edgesByToken.get(token);
    return existing ? { ...existing } : null;
  }

  edgesOf(userId) {
    validateUserId(userId);
    const tokens = this.userEdges.get(userId);
    if (!tokens) return [];
    const result = [];
    for (const token of tokens) {
      const edge = this.edgesByToken.get(token);
      if (edge) result.push({ ...edge });
    }
    return result.sort((left, right) => left.key.localeCompare(right.key));
  }

  removeUser(userId) {
    validateUserId(userId);
    const removed = [];
    const liveTokens = this.userEdges.get(userId);
    if (liveTokens) {
      for (const token of [...liveTokens]) {
        const edge = this.edgesByToken.get(token);
        if (!edge) continue;
        this.edgesByToken.delete(token);
        const peerId = edge.a === userId ? edge.b : edge.a;
        this.#deleteSetEntry(this.userEdges, peerId, token);
        removed.push({ ...edge });
      }
      this.userEdges.delete(userId);
    }

    const pairTokens = this.userPairs.get(userId);
    if (pairTokens) {
      for (const token of [...pairTokens]) {
        const { a, b } = decodePairToken(token);
        const peerId = a === userId ? b : a;
        const pairGen = this.pairGenerations.get(token) ?? 0;
        if (pairGen > 0) this.recordUserFloor(peerId, pairGen);
        this.#deleteSetEntry(this.userPairs, peerId, token);
        this.pairGenerations.delete(token);
      }
      this.userPairs.delete(userId);
    }
    this.userGenFloor.delete(userId);

    return removed.sort((left, right) => left.key.localeCompare(right.key));
  }

  clearRoom(roomId) {
    validateRoomId(roomId);
    const removed = [];
    for (const [token, edge] of [...this.edgesByToken.entries()]) {
      if (edge.roomId !== roomId) continue;
      this.edgesByToken.delete(token);
      this.#deleteSetEntry(this.userEdges, edge.a, token);
      this.#deleteSetEntry(this.userEdges, edge.b, token);
      this.#deleteSetEntry(this.userPairs, edge.a, token);
      this.#deleteSetEntry(this.userPairs, edge.b, token);
      this.pairGenerations.delete(token);
      removed.push({ ...edge });
    }
    return removed.sort((left, right) => left.key.localeCompare(right.key));
  }

  allEdges(roomId) {
    const result = [];
    for (const edge of this.edgesByToken.values()) {
      if (roomId === undefined || edge.roomId === roomId) result.push({ ...edge });
    }
    return result.sort((left, right) => left.key.localeCompare(right.key));
  }

  countStoreKeys() {
    return (
      this.edgesByToken.size
      + this.userEdges.size
      + this.pairGenerations.size
      + this.userPairs.size
    );
  }

  size() {
    return {
      edges: this.edgesByToken.size,
      userEdges: this.userEdges.size,
      pairGenerations: this.pairGenerations.size,
      userPairs: this.userPairs.size,
    };
  }
}

export default MemoryEdgeStore;
