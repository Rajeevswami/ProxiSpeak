/**
 * Peer graph (Week 2 Day 8, refactored Week 3 Day 12 behind EdgeStore).
 *
 * One instance per server process. Local socket sessions in this process register
 * in `this.rooms` so `reconcileLocalUsers()` knows which users this node owns,
 * while edge creation, generation assignment, lookup and removal are delegated
 * entirely to the injected `EdgeStore` (`MemoryEdgeStore` by default when
 * `REDIS_URL` is empty; `RedisEdgeStore` in multi-instance mode).
 */
import { performance } from 'node:perf_hooks';
import config from '../config/index.js';
import { findNearby as defaultFindNearby } from './proximityService.js';
import {
  MemoryEdgeStore,
  buildEdgeRecord,
  edgeKey,
  normalizePair,
  pickInitiator,
  validateRoomId,
  validateUserId,
} from './edgeStore.js';

export { edgeKey, pickInitiator };

const emptyDiff = () => ({ added: [], removed: [] });

const isPromise = (value) =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';

const chain = (value, onFulfilled) => (isPromise(value) ? value.then(onFulfilled) : onFulfilled(value));

export class PeerGraph {
  /**
   * @param {object} [options]
   * @param {Function} [options.findNearby] Day 7 neighbor query, injectable for tests
   * @param {number} [options.radiusPx] earshot radius; defaults to PROXIMITY_RADIUS_PX
   * @param {import('./edgeStore.js').EdgeStore} [options.edgeStore] defaults to MemoryEdgeStore
   * @param {boolean} [options.allowRemotePeers] true when peers may live on other instances
   * @param {Function} [options.resolvePeerName] optional `(roomId, peerId) => string|Promise<string>`
   * @param {object} [options.logger] optional logger for fail-safe store error reporting
   * @param {Function} [options.onEdgeAdded] called once per newly created edge
   * @param {Function} [options.onEdgeRemoved] called once per removed edge
   */
  constructor({
    findNearby = defaultFindNearby,
    radiusPx = config.proximity.radiusPx,
    dropRadiusPx = config.proximity.peerDisconnectRadiusPx ?? radiusPx + 15,
    maxPeersPerUser = config.proximity.maxPeersPerUser ?? 8,
    edgeStore = new MemoryEdgeStore(),
    allowRemotePeers = false,
    resolvePeerName = null,
    logger = null,
    onEdgeAdded,
    onEdgeRemoved,
  } = {}) {
    if (typeof findNearby !== 'function') throw new TypeError('findNearby must be a function');
    if (!Number.isFinite(radiusPx) || radiusPx < 0) {
      throw new RangeError('radiusPx must be a finite, non-negative number');
    }
    if (!Number.isFinite(dropRadiusPx) || dropRadiusPx < radiusPx) {
      throw new RangeError('dropRadiusPx must be a finite number >= radiusPx');
    }
    if (!Number.isInteger(maxPeersPerUser) || maxPeersPerUser < 0) {
      throw new RangeError('maxPeersPerUser must be a non-negative integer');
    }

    this.findNearby = findNearby;
    this.radiusPx = radiusPx;
    this.dropRadiusPx = dropRadiusPx;
    this.maxPeersPerUser = maxPeersPerUser;
    this.edgeStore = edgeStore;
    this.allowRemotePeers = Boolean(allowRemotePeers);
    this.resolvePeerName = typeof resolvePeerName === 'function' ? resolvePeerName : null;
    this.log = logger;
    this.onEdgeAdded = typeof onEdgeAdded === 'function' ? onEdgeAdded : null;
    this.onEdgeRemoved = typeof onEdgeRemoved === 'function' ? onEdgeRemoved : null;
    // One source of truth for the cap: an injected store without an explicit cap
    // inherits the graph's configured value (the server always passes both).
    if (edgeStore && edgeStore.maxPeersPerUser === null && Number.isInteger(maxPeersPerUser)) {
      edgeStore.maxPeersPerUser = maxPeersPerUser;
    }
    // Mesh optimization counters (cheap, in-memory, per instance)
    this.meshCounters = {
      edgesCreated: 0,
      edgesRemoved: 0,
      cappedRejections: 0,
      hysteresisHolds: 0,
    };

    /** roomId -> { roomId, users: Map<userId, { id, name }> } */
    this.rooms = new Map();
    /** Serialises syncs of the same user: a move can never overtake its join. */
    this.pendingSyncs = new Map();
    /** Cached display names of remote peers, bounded to active rooms/peers. */
    this.remoteNames = new Map();

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
      room = { roomId, users: new Map() };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  #findRoom(roomId) {
    return this.rooms.get(roomId) ?? null;
  }

  #dropRoomIfEmpty(room) {
    if (room.users.size !== 0) return;
    this.rooms.delete(room.roomId);
    const prefix = `${room.roomId}\u0000`;
    for (const compositeKey of [...this.remoteNames.keys()]) {
      if (compositeKey.startsWith(prefix)) this.remoteNames.delete(compositeKey);
    }
  }

  rememberPeerName(roomId, userId, name) {
    if (name && this.#findRoom(roomId)) {
      this.remoteNames.set(`${roomId}\u0000${userId}`, name);
    }
  }

  forgetPeerName(roomId, userId) {
    this.remoteNames.delete(`${roomId}\u0000${userId}`);
  }

  /**
   * Register a user in a room without querying neighbors. Idempotent, and a
   * re-registration keeps existing edges (a duplicate join is harmless).
   */
  register(roomId, userId, { name = '' } = {}) {
    const room = this.#room(roomId);
    const existing = room.users.get(userId);
    if (existing) {
      if (name) existing.name = name;
      return existing;
    }
    const state = { id: userId, name };
    room.users.set(userId, state);
    return state;
  }

  /** Remove only local registration on this node without touching EdgeStore. */
  dropLocalUser(roomId, userId) {
    if (roomId === undefined) {
      for (const id of [...this.rooms.keys()]) {
        this.dropLocalUser(id, userId);
      }
      for (const compositeKey of [...this.remoteNames.keys()]) {
        if (compositeKey.endsWith(`\u0000${userId}`)) this.remoteNames.delete(compositeKey);
      }
      return;
    }
    const room = this.#findRoom(roomId);
    this.forgetPeerName(roomId, userId);
    if (!room) return;
    room.users.delete(userId);
    this.#dropRoomIfEmpty(room);
  }

  /**
   * Join = register + sync. The user is registered before the query so a peer
   * that resolves at the same moment can create the edge from its side too; the
   * EdgeStore guarantees only one edge is created across all instances.
   */
  async join(roomId, userId, { name = '' } = {}) {
    this.register(roomId, userId, { name });
    return this.sync(roomId, userId);
  }

  /**
   * Recompute local users after Redis recovers from a mid-run drop so edges
   * missed during the outage are created and stale ones are removed.
   */
  async reconcileLocalUsers() {
    const localUsers = [];
    for (const [roomId, room] of this.rooms.entries()) {
      for (const userId of room.users.keys()) {
        localUsers.push({ roomId, userId });
      }
    }
    for (const { roomId, userId } of localUsers) {
      await this.sync(roomId, userId);
    }
  }

  /**
   * Recompute exactly this user's neighbors and diff them into the store.
   * Serialised per user so a move arriving while join is in flight cannot apply
   * out of order.
   */
  sync(roomId, userId, opts = {}) {
    const key = `${roomId}\u0000${userId}`;
    const previous = this.pendingSyncs.get(key) ?? Promise.resolve();
    const isReclaim = Boolean(opts?.isReclaim);
    const next = previous.catch(() => {}).then(() => this.#sync(roomId, userId, { isReclaim }));
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

  /**
   * Wait until every queued per-user sync (including the bounded reclaim syncs
   * a removal schedules) has finished. Used by tests and by a clean shutdown.
   */
  async drainSyncs() {
    for (let guard = 0; guard < 100 && this.pendingSyncs.size > 0; guard += 1) {
      // eslint-disable-next-line no-await-in-loop -- draining is inherently sequential
      await Promise.allSettled([...this.pendingSyncs.values()]);
    }
  }

  async #sync(roomId, userId, { isReclaim = false } = {}) {
    const room = this.#findRoom(roomId);
    const state = room?.users.get(userId);
    if (!state) return emptyDiff();

    const started = performance.now();
    let nearbyDrop;
    try {
      nearbyDrop = await this.findNearby(roomId, userId, this.dropRadiusPx);
    } catch (err) {
      this.syncFailures += 1;
      this.#recordLatency(performance.now() - started);
      throw err;
    }

    let currentEdges;
    try {
      const rawEdges = await this.edgeStore.edgesOf(userId);
      currentEdges = rawEdges.filter((edge) => edge.roomId === roomId);
    } catch (err) {
      this.syncFailures += 1;
      this.#recordLatency(performance.now() - started);
      this.log?.warn('edge store read failed during sync (failing safe):', err?.message ?? err);
      return emptyDiff();
    }

    this.syncCount += 1;
    this.#recordLatency(performance.now() - started);

    // Abort if the user left while queries were in flight.
    if (this.#findRoom(roomId)?.users.get(userId) !== state) return emptyDiff();

    // Build drop and connect sets from single hysteresis-aware query (drop radius).
    // nearbyDrop contains all peers within dropRadiusPx (including those within connect radius).
    const dropEntries = [];
    for (const neighbor of nearbyDrop ?? []) {
      const id = typeof neighbor === 'string' ? neighbor : neighbor?.id;
      if (typeof id !== 'string' || id === userId) continue;
      const dist = typeof neighbor === 'object' && Number.isFinite(neighbor.distancePx) ? neighbor.distancePx : Infinity;
      dropEntries.push({ id, distancePx: dist });
    }
    const dropMap = new Map(dropEntries.map((e) => [e.id, e.distancePx]));
    const dropSet = new Set(dropEntries.map((e) => e.id));

    // Candidates for NEW edges: only peers whose measured distance is inside the
    // CONNECT radius. An entry without a distance can never prove <= 100 px, so it
    // is never used to create a new edge (existing edges may still hold).
    const candidates = dropEntries
      .filter((e) => (Number.isFinite(e.distancePx)
        ? e.distancePx <= this.radiusPx
        // With no hysteresis band the query radius IS the connect radius, so a
        // distance-less entry from an injected source keeps its Day 12 meaning.
        : this.dropRadiusPx === this.radiusPx))
      .sort((left, right) => {
        if (left.distancePx !== right.distancePx) return left.distancePx - right.distancePx;
        return left.id.localeCompare(right.id);
      });

    const currentByPeer = new Map();
    for (const edge of currentEdges) {
      const peerId = edge.a === userId ? edge.b : edge.a;
      currentByPeer.set(peerId, edge);
    }

    const added = [];
    const removed = [];

    // First, remove edges that have drifted beyond drop radius (or peer gone).
    // Existing edges with distance between radius and drop are kept (hysteresis).
    for (const [peerId, edge] of currentByPeer) {
      if (dropSet.has(peerId)) {
        const dist = dropMap.get(peerId);
        if (Number.isFinite(dist) && dist > this.radiusPx && dist <= this.dropRadiusPx) {
          this.meshCounters.hysteresisHolds += 1;
          this.log?.debug?.(`hysteresis hold ${userId}<->${peerId} dist=${dist}`);
        }
        continue;
      }
      const result = await this.#removeSingleEdge(roomId, userId, peerId, edge);
      if (!result) continue;
      this.forgetPeerName(roomId, peerId);
      removed.push(result);
      this.meshCounters.edgesRemoved += 1;
      this.log?.debug?.(`edge removed ${result.a}<->${result.b} gen=${result.generation}`);
      this.onEdgeRemoved?.(result);
    }

    // Slot reclaim: if we just freed slots, try to fill them with nearest unconnected
    // candidates (still sorted). This is the mover's own reclaim without extra sync.
    // `currentByPeer` still holds the edges removed above (the map is built before
    // the removal pass), so the degree this sync can actually offer is the old
    // degree minus the removals plus whatever it has already created.
    const liveDegree = currentByPeer.size - removed.length;
    for (const { id: peerId } of candidates) {
      if (currentByPeer.has(peerId)) continue;
      // Our own degree is known locally: once full, no further create can win,
      // so stop instead of making the store reject every farther candidate.
      if (this.maxPeersPerUser !== 0 && liveDegree + added.length >= this.maxPeersPerUser) break;
      if (!this.allowRemotePeers && !room.users.get(peerId)) continue;

      if (!this.nameOf(roomId, peerId) && this.resolvePeerName) {
        try {
          const resolved = await this.resolvePeerName(roomId, peerId);
          if (resolved) this.rememberPeerName(roomId, peerId, resolved);
        } catch {
          /* non-fatal; empty fallback name stays valid */
        }
        if (this.#findRoom(roomId)?.users.get(userId) !== state) return { added, removed };
      }

      let outcome;
      try {
        outcome = await this.edgeStore.createEdge(roomId, userId, peerId);
      } catch (err) {
        this.syncFailures += 1;
        this.log?.warn('edge store create failed (failing safe):', err?.message ?? err);
        continue;
      }
      if (!outcome?.created) {
        if (outcome?.capped) {
          this.meshCounters.cappedRejections += 1;
          this.log?.debug?.(`cap rejected edge ${userId}<->${peerId} (capped)`);
        }
        continue;
      }

      const [a, b] = normalizePair(userId, peerId);
      const edge = buildEdgeRecord(roomId, a, b, outcome.generation);
      added.push(edge);
      this.meshCounters.edgesCreated += 1;
      this.log?.debug?.(`edge created ${a}<->${b} gen=${outcome.generation}`);
      this.onEdgeAdded?.(edge);
    }

    // Cross-endpoint reclaim: after we removed edges, the other endpoint may have
    // free slots. Trigger at most one extra sync per endpoint, without cascades
    // (isReclaim flag prevents those syncs from triggering further reclaims).
    if (!isReclaim && removed.length > 0) {
      for (const edge of removed) {
        const peerId = edge.a === userId ? edge.b : edge.a;
        if (this.#findRoom(roomId)?.users.get(peerId)) {
          // Fire-and-forget reclaim sync for the peer on this instance.
          // Do not await to keep current sync latency bounded; still serialized via pendingSyncs.
          this.sync(roomId, peerId, { isReclaim: true }).catch(() => {});
        }
      }
    }

    return { added, removed };
  }

  async #removeSingleEdge(roomId, userId, peerId, fallbackEdge) {
    try {
      if (typeof this.edgeStore.removeEdgeWithRecord === 'function') {
        const { removed, edge } = await this.edgeStore.removeEdgeWithRecord(roomId, userId, peerId);
        return removed ? (edge ?? fallbackEdge) : null;
      }
      const removed = await this.edgeStore.removeEdge(roomId, userId, peerId);
      return removed ? fallbackEdge : null;
    } catch (err) {
      this.syncFailures += 1;
      this.log?.warn('edge store remove failed (failing safe):', err?.message ?? err);
      return null;
    }
  }

  /**
   * Remove a user and every edge it owns, reporting each removal only once.
   * Synchronous when backed by MemoryEdgeStore; returns a Promise for async stores.
   * Slot reclaim: surviving peers get one extra sync to fill freed slots.
   */
  leave(roomId, userId) {
    const room = this.#findRoom(roomId);
    const hadLocal = Boolean(room?.users.get(userId));
    if (!hadLocal && !this.allowRemotePeers) return [];

    if (room) {
      room.users.delete(userId);
      this.forgetPeerName(roomId, userId);
      this.#dropRoomIfEmpty(room);
    }

    let raw;
    try {
      raw = this.edgeStore.removeUser(userId);
    } catch (err) {
      this.syncFailures += 1;
      this.log?.warn('edge store removeUser failed (failing safe):', err?.message ?? err);
      return [];
    }

    const finish = (removed) => {
      for (const edge of removed) {
        const peerId = edge.a === userId ? edge.b : edge.a;
        this.forgetPeerName(edge.roomId, peerId);
        this.meshCounters.edgesRemoved += 1;
        this.log?.debug?.(`edge removed ${edge.a}<->${edge.b} gen=${edge.generation} (leave)`);
        this.onEdgeRemoved?.(edge);
      }
      // Slot reclaim for survivors (bounded, no cascades)
      for (const edge of removed) {
        const peerId = edge.a === userId ? edge.b : edge.a;
        if (this.#findRoom(edge.roomId)?.users.get(peerId)) {
          this.sync(edge.roomId, peerId, { isReclaim: true }).catch(() => {});
        }
      }
      return removed;
    };

    if (isPromise(raw)) {
      return raw.then((removed) => finish(removed), (err) => {
        this.syncFailures += 1;
        this.log?.warn('edge store removeUser failed (failing safe):', err?.message ?? err);
        return [];
      });
    }
    return finish(raw);
  }

  /** Remove every edge of every user in one room (used by tests/tools). */
  clearRoom(roomId) {
    const room = this.#findRoom(roomId);
    this.rooms.delete(roomId);
    for (const key of [...this.remoteNames.keys()]) {
      if (key.startsWith(`${roomId}\u0000`)) this.remoteNames.delete(key);
    }

    if (typeof this.edgeStore.clearRoom === 'function') {
      return chain(this.edgeStore.clearRoom(roomId), (removed) => {
        for (const edge of removed) this.onEdgeRemoved?.(edge);
        return removed;
      });
    }
    if (!room) return [];
    return [];
  }

  // --------------------------------------------------------------- read side ---

  /** The live edge for a pair in `roomId`, or null. */
  edgeBetween(roomId, a, b) {
    try {
      validateRoomId(roomId);
      validateUserId(a);
      validateUserId(b);
    } catch {
      return null;
    }
    if (a === b) return null;

    let lookup;
    try {
      lookup = this.edgeStore.getEdge(a, b);
    } catch (err) {
      this.log?.warn('edge store getEdge failed (failing safe):', err?.message ?? err);
      return null;
    }

    const match = (edge) => (edge && edge.roomId === roomId ? { ...edge } : null);
    if (isPromise(lookup)) {
      return lookup.then(match, (err) => {
        this.log?.warn('edge store getEdge failed (failing safe):', err?.message ?? err);
        return null;
      });
    }
    return match(lookup);
  }

  /** True when the users share a live edge in this room. */
  hasEdge(roomId, a, b) {
    return chain(this.edgeBetween(roomId, a, b), Boolean);
  }

  /** Peer ids of one user in `roomId`, sorted for deterministic tests and logs. */
  neighbors(roomId, userId) {
    try {
      validateRoomId(roomId);
      validateUserId(userId);
    } catch {
      return [];
    }
    if (!this.allowRemotePeers && !this.#findRoom(roomId)?.users.get(userId)) {
      return [];
    }
    return chain(this.edgeStore.edgesOf(userId), (edges) =>
      edges
        .filter((edge) => edge.roomId === roomId)
        .map((edge) => (edge.a === userId ? edge.b : edge.a))
        .sort(),
    );
  }

  /** Every edge in a room (or all rooms), sorted by key. */
  edges(roomId) {
    if (typeof this.edgeStore.allEdges === 'function') {
      return this.edgeStore.allEdges(roomId);
    }
    return [];
  }

  /** Current display name recorded locally or cached for a remote peer. */
  nameOf(roomId, userId) {
    return (
      this.#findRoom(roomId)?.users.get(userId)?.name
      ?? this.remoteNames.get(`${roomId}\u0000${userId}`)
      ?? ''
    );
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
    const rawEdges = typeof this.edgeStore.allEdges === 'function' ? this.edgeStore.allEdges(roomId) : [];
    const finish = (edgeList) => ({
      rooms: rooms.length,
      users,
      edges: edgeList.length,
      syncs: this.syncCount,
      failures: this.syncFailures,
      generation: this.edgeStore.totalGenerations ?? 0,
      latency: this.latencySummary(),
      mesh: { ...this.meshCounters },
    });
    return chain(rawEdges, finish);
  }

  meshStats() {
    return { ...this.meshCounters };
  }

  #recordLatency(durationMs) {
    this.latencySamples.push(durationMs);
    if (this.latencySamples.length > this.maxLatencySamples) this.latencySamples.shift();
  }
}

export default PeerGraph;
