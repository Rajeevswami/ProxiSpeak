/**
 * In-memory peer graph (Week 2, Day 8).
 *
 * One instance per server process, one sub-graph per room. A vertex is a live
 * user (the Socket.IO session id, which is also the public user id) and an edge
 * means "these two users are within earshot right now" — the same exact pixel
 * radius the Day 7 `findNearby` service applies.
 *
 * The graph is deliberately *not* a second source of truth for positions:
 * MongoDB stays authoritative. On join, accepted move, disconnect and presence
 * expiry the gateway asks this module to re-sync ONE user; the module runs the
 * existing `findNearby` query for that user and diffs the result against the
 * edges it already holds. The rest of the room is never recomputed.
 *
 * Rules:
 *  - edge key = the two user ids sorted, so a pair has exactly one edge no
 *    matter which side notices it first;
 *  - every edge is created with a monotonically increasing `generation`, so a
 *    delayed offer/answer/candidate for an older incarnation of the edge can be
 *    recognised and dropped;
 *  - the initiator is always the lexicographically smaller user id, so two
 *    peers can never both believe they should send the offer;
 *  - `leave` removes every edge of a user and reports each removal, which is
 *    what turns into `peer:disconnect` for the remaining peers.
 *
 * Everything is process-local by design. Multi-instance edge sharing (Redis)
 * is Week 3 work; nothing here reads or writes Redis.
 */
import { performance } from 'node:perf_hooks';
import config from '../config/index.js';
import { findNearby as defaultFindNearby } from './proximityService.js';

/** Order-independent identity of an undirected edge. */
export function edgeKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** The lexicographically smaller endpoint is the deterministic offerer. */
export function pickInitiator(a, b) {
  return a < b ? a : b;
}

const emptyDiff = () => ({ added: [], removed: [] });

/**
 * @typedef {object} PeerEdge
 * @property {string} key order-independent pair key
 * @property {string} roomId
 * @property {string} a smaller id (the initiator)
 * @property {string} b larger id
 * @property {number} generation monotonically increasing per process
 * @property {string} initiator === a
 */

export class PeerGraph {
  /**
   * @param {object} [options]
   * @param {Function} [options.findNearby] Day 7 neighbor query, injectable for tests
   * @param {number} [options.radiusPx] earshot radius; defaults to PROXIMITY_RADIUS_PX
   * @param {Function} [options.onEdgeAdded] called once per newly created edge
   * @param {Function} [options.onEdgeRemoved] called once per removed edge
   */
  constructor({
    findNearby = defaultFindNearby,
    radiusPx = config.proximity.radiusPx,
    onEdgeAdded,
    onEdgeRemoved,
  } = {}) {
    if (typeof findNearby !== 'function') throw new TypeError('findNearby must be a function');
    if (!Number.isFinite(radiusPx) || radiusPx < 0) {
      throw new RangeError('radiusPx must be a finite, non-negative number');
    }

    this.findNearby = findNearby;
    this.radiusPx = radiusPx;
    this.onEdgeAdded = typeof onEdgeAdded === 'function' ? onEdgeAdded : null;
    this.onEdgeRemoved = typeof onEdgeRemoved === 'function' ? onEdgeRemoved : null;

    /** roomId -> { roomId, users: Map<userId, state>, edges: Map<key, edge> } */
    this.rooms = new Map();
    /** Serialises syncs of the same user: a move can never overtake its join. */
    this.pendingSyncs = new Map();
    this.generationCounter = 0;

    this.syncCount = 0;
    this.syncFailures = 0;
    this.maxLatencySamples = 2048;
    this.latencySamples = [];
  }

  /** Replace the edge listeners (the gateway owns delivery to sockets). */
  setListeners({ onEdgeAdded, onEdgeRemoved } = {}) {
    this.onEdgeAdded = typeof onEdgeAdded === 'function' ? onEdgeAdded : null;
    this.onEdgeRemoved = typeof onEdgeRemoved === 'function' ? onEdgeRemoved : null;
  }

  // ------------------------------------------------------------- room state ---

  #room(roomId) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { roomId, users: new Map(), edges: new Map() };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  #findRoom(roomId) {
    return this.rooms.get(roomId) ?? null;
  }

  #dropRoomIfEmpty(room) {
    if (room.users.size === 0 && room.edges.size === 0) this.rooms.delete(room.roomId);
  }

  /**
   * Register a user in a room without querying neighbors. Idempotent, and a
   * re-registration keeps the existing edges (a duplicate join is harmless).
   */
  register(roomId, userId, { name = '' } = {}) {
    const room = this.#room(roomId);
    const existing = room.users.get(userId);
    if (existing) {
      if (name) existing.name = name;
      return existing;
    }
    const state = { id: userId, name, neighbors: new Map() };
    room.users.set(userId, state);
    return state;
  }

  /**
   * Join = register + sync. The user is registered before the query so a peer
   * that resolves the same moment can create the edge from its side too; the
   * pair key guarantees only one edge is stored either way.
   */
  async join(roomId, userId, { name = '' } = {}) {
    this.register(roomId, userId, { name });
    return this.sync(roomId, userId);
  }

  /**
   * Recompute exactly this user's neighbors and diff them into the graph.
   * Returns the edge descriptors that were added/removed. The whole operation
   * is serialised per user, so a move that arrives while the join query is
   * still in flight cannot be applied out of order.
   */
  sync(roomId, userId) {
    const key = `${roomId}\u0000${userId}`;
    const previous = this.pendingSyncs.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.#sync(roomId, userId));
    this.pendingSyncs.set(key, next);
    next.then(
      () => {
        if (this.pendingSyncs.get(key) === next) this.pendingSyncs.delete(key);
      },
      () => {
        if (this.pendingSyncs.get(key) === next) this.pendingSyncs.delete(key);
      },
    );
    return next;
  }

  async #sync(roomId, userId) {
    const room = this.#findRoom(roomId);
    const state = room?.users.get(userId);
    // The user left (disconnect/expiry) before this sync could run.
    if (!state) return emptyDiff();

    const started = performance.now();
    let nearby;
    try {
      nearby = await this.findNearby(roomId, userId, this.radiusPx);
    } catch (err) {
      this.syncFailures += 1;
      this.#recordLatency(performance.now() - started);
      throw err;
    }
    this.syncCount += 1;
    this.#recordLatency(performance.now() - started);

    // The user may have left while the query was in flight. Never recreate a
    // vertex (or an edge) for a session that is gone.
    if (this.#findRoom(roomId)?.users.get(userId) !== state) return emptyDiff();

    const next = new Set();
    for (const neighbor of nearby ?? []) {
      const id = typeof neighbor === 'string' ? neighbor : neighbor?.id;
      // `findNearby` already excludes self; this is belt-and-braces so a buggy
      // or custom source can never create a self-edge.
      if (typeof id !== 'string' || id === userId) continue;
      next.add(id);
    }

    const added = [];
    const removed = [];

    for (const peerId of next) {
      if (state.neighbors.has(peerId)) continue;
      const edge = this.#createEdge(room, state, peerId);
      if (!edge) continue;
      added.push(edge);
      this.onEdgeAdded?.(edge);
    }

    for (const [peerId, edge] of [...state.neighbors]) {
      if (next.has(peerId)) continue;
      this.#removeEdge(room, edge);
      removed.push(edge);
      this.onEdgeRemoved?.(edge);
    }

    return { added, removed };
  }

  /**
   * Create the one edge for a pair, unless it already exists. `edge` is only
   * created when the peer is registered too: a presence row can be written a
   * few milliseconds before that user is added to the graph, and the peer's own
   * join sync will create the edge then.
   */
  #createEdge(room, state, peerId) {
    const peer = room.users.get(peerId);
    if (!peer) return null;

    const key = edgeKey(state.id, peerId);
    const existing = room.edges.get(key);
    if (existing) {
      // Repair both adjacency maps without emitting a duplicate event.
      state.neighbors.set(peerId, existing);
      peer.neighbors.set(state.id, existing);
      return null;
    }

    this.generationCounter += 1;
    const a = pickInitiator(state.id, peerId);
    const b = a === state.id ? peerId : state.id;
    const edge = Object.freeze({
      key,
      roomId: room.roomId,
      a,
      b,
      generation: this.generationCounter,
      initiator: a,
    });

    room.edges.set(key, edge);
    state.neighbors.set(peerId, edge);
    peer.neighbors.set(state.id, edge);
    return edge;
  }

  #removeEdge(room, edge) {
    room.edges.delete(edge.key);
    room.users.get(edge.a)?.neighbors.delete(edge.b);
    room.users.get(edge.b)?.neighbors.delete(edge.a);
  }

  /**
   * Remove a user and every edge it owns, reporting each removal. Safe to call
   * more than once (disconnect after expiry cleanup is a no-op).
   * @returns {PeerEdge[]} removed edges
   */
  leave(roomId, userId) {
    const room = this.#findRoom(roomId);
    const state = room?.users.get(userId);
    if (!room || !state) return [];

    const removed = [...state.neighbors.values()];
    for (const edge of removed) this.#removeEdge(room, edge);
    room.users.delete(userId);
    this.#dropRoomIfEmpty(room);

    for (const edge of removed) this.onEdgeRemoved?.(edge);
    return removed;
  }

  /** Remove every edge of every user in one room (used by tests/tools). */
  clearRoom(roomId) {
    const room = this.#findRoom(roomId);
    if (!room) return [];
    const removed = [...room.edges.values()];
    this.rooms.delete(roomId);
    for (const edge of removed) this.onEdgeRemoved?.(edge);
    return removed;
  }

  // --------------------------------------------------------------- read side ---

  /** The live edge for a pair, or null. The returned object is a copy. */
  edgeBetween(roomId, a, b) {
    const edge = this.#findRoom(roomId)?.edges.get(edgeKey(a, b));
    return edge ? { ...edge } : null;
  }

  /** True when the users share a live edge in this room. */
  hasEdge(roomId, a, b) {
    return Boolean(this.#findRoom(roomId)?.edges.get(edgeKey(a, b)));
  }

  /** Peer ids of one user, sorted for deterministic tests and logs. */
  neighbors(roomId, userId) {
    const state = this.#findRoom(roomId)?.users.get(userId);
    return state ? [...state.neighbors.keys()].sort() : [];
  }

  /** Every edge in a room (or all rooms), sorted by key. */
  edges(roomId) {
    const rooms = roomId === undefined ? [...this.rooms.values()] : [this.#findRoom(roomId)].filter(Boolean);
    return rooms.flatMap((room) => [...room.edges.values()].map((edge) => ({ ...edge })))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  /** Current display name recorded at join time, if still present. */
  nameOf(roomId, userId) {
    return this.#findRoom(roomId)?.users.get(userId)?.name ?? '';
  }

  isRegistered(roomId, userId) {
    return Boolean(this.#findRoom(roomId)?.users.get(userId));
  }

  /** p50/p95 of the measured recompute (findNearby + diff) durations. */
  latencySummary() {
    const samples = [...this.latencySamples].sort((a, b) => a - b);
    if (samples.length === 0) return { samples: 0, p50: 0, p95: 0 };
    const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * (samples.length - 1)))];
    return { samples: samples.length, p50: at(0.5), p95: at(0.95) };
  }

  /** Counts for diagnostics/tests; never contains user payloads. */
  stats(roomId) {
    const rooms = roomId === undefined ? [...this.rooms.values()] : [this.#findRoom(roomId)].filter(Boolean);
    const users = rooms.reduce((sum, room) => sum + room.users.size, 0);
    const edges = rooms.reduce((sum, room) => sum + room.edges.size, 0);
    return {
      rooms: rooms.length,
      users,
      edges,
      syncs: this.syncCount,
      failures: this.syncFailures,
      generation: this.generationCounter,
      latency: this.latencySummary(),
    };
  }

  #recordLatency(durationMs) {
    this.latencySamples.push(durationMs);
    if (this.latencySamples.length > this.maxLatencySamples) this.latencySamples.shift();
  }
}

export default PeerGraph;
