import test from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';

import { MemoryEdgeStore } from '../src/services/edgeStore.js';
import { RedisEdgeStore } from '../src/services/redisEdgeStore.js';
import { PeerGraph } from '../src/services/peerGraph.js';
import {
  connectTestClient,
  createMemoryLogger,
  createSharedClusterBacking,
  startClusterNode,
  waitEvent,
} from './helpers/twoInstanceHarness.js';

const REDIS_URL_TEST = (process.env.REDIS_URL_TEST ?? '').trim();
const ROOM = 'race_room';
const RADIUS = 100;
const DROP = 115;
const RANDOM_SEED = 0x14b5eed;
const RANDOM_INTERLEAVINGS = 200;

const redisOpts = REDIS_URL_TEST
  ? {}
  : { skip: 'NOT VERIFIED — set REDIS_URL_TEST to run the real Redis stale-edge regression' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A deterministic, no-sleep gate installed after the complete proximity read. */
function gateNextRead(graph, userId) {
  const original = graph.findNearby;
  const captured = deferred();
  const release = deferred();
  let active = true;
  graph.findNearby = async (...args) => {
    const result = await original(...args);
    if (active && args[1] === userId) {
      active = false;
      captured.resolve(result);
      await release.promise;
    }
    return result;
  };
  return { captured: captured.promise, release: release.resolve };
}

async function nearbyFromPositions(store, positions, roomId, userId, radiusPx) {
  const self = positions.get(userId);
  if (!self) return [];
  const nearby = [...positions.entries()]
    .filter(([id]) => id !== userId)
    .map(([id, position]) => ({
      id,
      distancePx: Math.hypot(self.x - position.x, self.y - position.y),
    }))
    .filter((entry) => entry.distancePx <= radiusPx)
    .sort((a, b) => a.distancePx - b.distancePx || a.id.localeCompare(b.id));
  if (typeof store.getPositionRevisions !== 'function' || nearby.length === 0) return nearby;
  const revisions = await store.getPositionRevisions(nearby.map((entry) => entry.id));
  if (typeof store.ensurePositionRevision === 'function') {
    await Promise.all(nearby.filter((entry) => revisions.get(entry.id) === 0)
      .map((entry) => store.ensurePositionRevision(entry.id)));
  }
  return nearby.map((entry) => ({
    ...entry,
    positionRevision: revisions.get(entry.id) ?? 0,
  }));
}

function makeGraphPair(store, positions) {
  const findNearby = (roomId, userId, radiusPx) =>
    nearbyFromPositions(store, positions, roomId, userId, radiusPx);
  const make = () => new PeerGraph({
    findNearby,
    radiusPx: RADIUS,
    dropRadiusPx: DROP,
    maxPeersPerUser: 0,
    edgeStore: store,
    allowRemotePeers: true,
  });
  return { graphA: make(), graphB: make() };
}

async function joinPair(graphA, graphB, a, b, joinOrder = ['a', 'b']) {
  for (const side of joinOrder) {
    if (side === 'a') await graphA.join(ROOM, a, { name: 'A' });
    else await graphB.join(ROOM, b, { name: 'B' });
  }
}

/** The pre-fix base has no revision API, so it reaches the original race assertion. */
async function acceptMove(graph, positions, userId, position) {
  positions.set(userId, position);
  if (typeof graph.positionChanged === 'function') await graph.positionChanged(userId);
  await graph.sync(ROOM, userId);
}

async function cleanupPair(store, graphA, graphB, a, b) {
  await Promise.allSettled([
    graphA.leave(ROOM, a),
    graphB.leave(ROOM, b),
  ]);
  // Also clean up if an assertion failed before registration completed.
  await Promise.allSettled([store.removeUser(a), store.removeUser(b)]);
}

async function assertQuiescentWithinDrop(store, positions, context = '') {
  const edges = await store.allEdges(ROOM);
  const violations = edges.map((edge) => {
    const a = positions.get(edge.a);
    const b = positions.get(edge.b);
    return { edge, distancePx: a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity };
  }).filter((entry) => entry.distancePx > DROP);
  assert.deepEqual(violations, [], `${context} quiescent edges beyond ${DROP}px`);
}

async function runDeterministicRace(store) {
  const a = 'reader_peer';
  const b = 'moving_peer';
  const positions = new Map([[a, { x: 0, y: 0 }], [b, { x: 0, y: 0 }]]);
  const { graphA, graphB } = makeGraphPair(store, positions);
  let gate;
  try {
    await joinPair(graphA, graphB, a, b);
    assert.equal((await store.allEdges(ROOM)).length, 1, 'fixture starts connected');

    gate = gateNextRead(graphA, a);
    const staleRead = graphA.sync(ROOM, a);
    await gate.captured;

    // The mover finishes its complete sync, including removal, before the old
    // proximity result is allowed to attempt its create.
    await acceptMove(graphB, positions, b, { x: 460, y: 0 });
    assert.equal((await store.allEdges(ROOM)).length, 0, 'mover removed the old edge');

    gate.release();
    await staleRead;
    await Promise.all([graphA.drainSyncs(), graphB.drainSyncs()]);
    await assertQuiescentWithinDrop(store, positions, 'deterministic gated read/move/create:');
  } finally {
    gate?.release();
    await cleanupPair(store, graphA, graphB, a, b);
  }
}

test('[MemoryEdgeStore] deterministic gated proximity read cannot recreate an edge beyond drop radius', async () => {
  const store = new MemoryEdgeStore({ maxPeersPerUser: 0 });
  await runDeterministicRace(store);
});

test('[RedisEdgeStore] deterministic gated proximity read cannot recreate an edge beyond drop radius', redisOpts, async () => {
  const client = new Redis(REDIS_URL_TEST, { lazyConnect: true });
  await client.connect();
  const keyPrefix = `race_det_${process.pid}`;
  const store = new RedisEdgeStore({ client, keyPrefix, ttlSeconds: 120, maxPeersPerUser: 0 });
  try {
    await runDeterministicRace(store);
  } finally {
    const keys = await store.scanKeys(`${keyPrefix}:*`);
    if (keys.length) await client.del(...keys);
    await client.quit().catch(() => client.disconnect(false));
  }
});

async function runRevisionReadGapRace(store) {
  const a = 'gap_reader';
  const b = 'gap_mover';
  const positions = new Map([[a, { x: 0, y: 0 }], [b, { x: 40, y: 0 }]]);
  const { graphA, graphB } = makeGraphPair(store, positions);
  let release;
  try {
    await joinPair(graphA, graphB, a, b);
    await store.removeEdge(ROOM, a, b);
    await Promise.all([graphA.drainSyncs(), graphB.drainSyncs()]);

    const announced = [];
    graphA.onEdgeAdded = (edge) => announced.push(edge);
    const originalRevisions = store.getPositionRevisions.bind(store);
    const captured = deferred();
    const gate = deferred();
    release = gate.resolve;
    let armed = true;
    store.getPositionRevisions = async (ids) => {
      if (armed && ids.includes(b)) {
        armed = false;
        captured.resolve();
        await gate.promise;
      }
      return originalRevisions(ids);
    };

    const staleRead = graphA.sync(ROOM, a);
    await captured.promise;
    // The proximity distance was read at 40px, but the separately-read
    // revision is observed only after the mover reaches 460px and bumps.
    await acceptMove(graphB, positions, b, { x: 460, y: 0 });
    gate.resolve();
    await staleRead;
    await Promise.all([graphA.drainSyncs(), graphB.drainSyncs()]);

    assert.deepEqual(announced, [], 'a far edge must not be announced before confirmation');
    await assertQuiescentWithinDrop(store, positions, 'position/revision read gap:');
    assert.equal((await store.allEdges(ROOM)).length, 0);
  } finally {
    release?.();
    await cleanupPair(store, graphA, graphB, a, b);
  }
}

test('[MemoryEdgeStore] post-create confirmation closes the position/revision read gap', async () => {
  await runRevisionReadGapRace(new MemoryEdgeStore({ maxPeersPerUser: 0 }));
});

test('[RedisEdgeStore] post-create confirmation closes the position/revision read gap', redisOpts, async () => {
  const client = new Redis(REDIS_URL_TEST, { lazyConnect: true });
  await client.connect();
  const keyPrefix = `race_gap_${process.pid}`;
  const store = new RedisEdgeStore({ client, keyPrefix, ttlSeconds: 120, maxPeersPerUser: 0 });
  try {
    await runRevisionReadGapRace(store);
  } finally {
    const keys = await store.scanKeys(`${keyPrefix}:*`);
    if (keys.length) await client.del(...keys);
    await client.quit().catch(() => client.disconnect(false));
  }
});

test('leave during post-create confirmation cannot announce a departed local edge', async () => {
  const store = new MemoryEdgeStore({ maxPeersPerUser: 0 });
  const a = 'confirmation_leaver';
  const b = 'confirmation_peer';
  const positions = new Map([[a, { x: 0, y: 0 }], [b, { x: 40, y: 0 }]]);
  const { graphA, graphB } = makeGraphPair(store, positions);
  let release;
  try {
    await joinPair(graphA, graphB, a, b);
    await store.removeEdge(ROOM, a, b);
    await Promise.all([graphA.drainSyncs(), graphB.drainSyncs()]);
    const announced = [];
    graphA.onEdgeAdded = (edge) => announced.push(edge);

    const original = graphA.findNearby;
    const captured = deferred();
    const gate = deferred();
    release = gate.resolve;
    let reads = 0;
    graphA.findNearby = async (...args) => {
      const result = await original(...args);
      reads += 1;
      if (args[1] === a && reads === 2) {
        captured.resolve();
        await gate.promise;
      }
      return result;
    };

    const syncing = graphA.sync(ROOM, a);
    await captured.promise;
    await graphA.leave(ROOM, a);
    gate.resolve();
    await syncing;
    assert.deepEqual(announced, [], 'no peer:connect gateway callback runs after local leave');
    assert.equal((await store.allEdges(ROOM)).length, 0);
  } finally {
    release?.();
    await cleanupPair(store, graphA, graphB, a, b);
  }
});

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

async function runRandomizedInterleavings(store, label) {
  const random = randomGenerator(RANDOM_SEED);
  const violations = [];
  for (let iteration = 0; iteration < RANDOM_INTERLEAVINGS; iteration += 1) {
    const a = `reader_${iteration}`;
    const b = `mover_${iteration}`;
    const baseX = Math.floor(random() * 1000);
    const baseY = Math.floor(random() * 1000);
    const initialDistance = Math.floor(random() * (RADIUS + 1));
    const finalDistance = DROP + 1 + Math.floor(random() * 500);
    const positions = new Map([
      [a, { x: baseX, y: baseY }],
      [b, { x: baseX + initialDistance, y: baseY }],
    ]);
    const { graphA, graphB } = makeGraphPair(store, positions);
    let gate;
    try {
      await joinPair(graphA, graphB, a, b, random() < 0.5 ? ['a', 'b'] : ['b', 'a']);
      gate = gateNextRead(graphA, a);
      const staleRead = graphA.sync(ROOM, a);
      await gate.captured;
      await acceptMove(graphB, positions, b, { x: baseX + finalDistance, y: baseY });
      gate.release();
      await staleRead;
      await Promise.all([graphA.drainSyncs(), graphB.drainSyncs()]);

      for (const edge of await store.allEdges(ROOM)) {
        const pa = positions.get(edge.a);
        const pb = positions.get(edge.b);
        const distancePx = pa && pb ? Math.hypot(pa.x - pb.x, pa.y - pb.y) : Infinity;
        if (distancePx > DROP) {
          violations.push({ iteration, initialDistance, finalDistance, distancePx, edge });
        }
      }
    } finally {
      gate?.release();
      await cleanupPair(store, graphA, graphB, a, b);
    }
  }
  assert.equal(
    violations.length,
    0,
    `${label}: ${violations.length}/${RANDOM_INTERLEAVINGS} seeded interleavings left an out-of-range edge; `
      + `seed=${RANDOM_SEED}; first=${JSON.stringify(violations[0] ?? null)}`,
  );
}

test(`[MemoryEdgeStore] ${RANDOM_INTERLEAVINGS} seeded read/move/create interleavings have no quiescent edge beyond drop`, async () => {
  const store = new MemoryEdgeStore({ maxPeersPerUser: 0 });
  await runRandomizedInterleavings(store, 'MemoryEdgeStore');
});

test(`[RedisEdgeStore] ${RANDOM_INTERLEAVINGS} seeded read/move/create interleavings have no quiescent edge beyond drop`, redisOpts, async () => {
  const client = new Redis(REDIS_URL_TEST, { lazyConnect: true });
  await client.connect();
  const keyPrefix = `race_random_${process.pid}`;
  const store = new RedisEdgeStore({ client, keyPrefix, ttlSeconds: 120, maxPeersPerUser: 0 });
  try {
    await runRandomizedInterleavings(store, 'RedisEdgeStore');
  } finally {
    const keys = await store.scanKeys(`${keyPrefix}:*`);
    if (keys.length) await client.del(...keys);
    await client.quit().catch(() => client.disconnect(false));
  }
});

test('a stale create performs exactly one bounded complete re-sync', async () => {
  const store = new MemoryEdgeStore({ maxPeersPerUser: 0 });
  const a = 'retry_reader';
  const b = 'retry_mover';
  const positions = new Map([[a, { x: 0, y: 0 }], [b, { x: 0, y: 0 }]]);
  const { graphA, graphB } = makeGraphPair(store, positions);
  let gate;
  try {
    await joinPair(graphA, graphB, a, b);
    await store.removeEdge(ROOM, a, b);
    const staleBefore = graphA.meshStats().staleRejections;
    let reads = 0;
    const original = graphA.findNearby;
    graphA.findNearby = async (...args) => {
      reads += 1;
      return original(...args);
    };
    gate = gateNextRead(graphA, a);
    const syncing = graphA.sync(ROOM, a);
    await gate.captured;

    positions.set(b, { x: 10, y: 0 });
    await graphB.positionChanged(b);
    gate.release();
    await syncing;
    await Promise.all([graphA.drainSyncs(), graphB.drainSyncs()]);

    assert.equal(
      reads,
      3,
      'initial read + one bounded fresh retry + one post-create confirmation, not a retry loop',
    );
    assert.equal(graphA.meshStats().staleRejections - staleBefore, 1);
    assert.equal((await store.allEdges(ROOM)).length, 1, 'the bounded retry used the fresh revision');
  } finally {
    gate?.release();
    await cleanupPair(store, graphA, graphB, a, b);
  }
});

test('a create in the Mongo-write/revision-bump window is removed by the post-bump sync', async () => {
  const store = new MemoryEdgeStore({ maxPeersPerUser: 0 });
  const a = 'window_reader';
  const b = 'window_mover';
  const positions = new Map([[a, { x: 0, y: 0 }], [b, { x: 0, y: 0 }]]);
  const { graphA, graphB } = makeGraphPair(store, positions);
  let gate;
  try {
    await joinPair(graphA, graphB, a, b);
    gate = gateNextRead(graphA, a);
    const staleRead = graphA.sync(ROOM, a);
    await gate.captured;

    // This is the documented intermediate state: the position write is visible,
    // but the mover has not bumped its revision or started its post-bump sync.
    positions.set(b, { x: 460, y: 0 });
    gate.release();
    await staleRead;
    assert.equal((await store.allEdges(ROOM)).length, 1, 'the old-revision create won before the bump');

    await graphB.positionChanged(b);
    await graphB.sync(ROOM, b);
    await assertQuiescentWithinDrop(store, positions, 'write/bump window after mover sync:');
  } finally {
    gate?.release();
    await cleanupPair(store, graphA, graphB, a, b);
  }
});

async function joinSocket(cluster, node, name) {
  const socket = await connectTestClient(node.baseUrl);
  const errors = [];
  socket.on('error', (error) => errors.push(error));
  const joined = waitEvent(socket, 'joined');
  socket.emit('join', { roomId: cluster.room, name });
  const snapshot = await joined;
  return { socket, id: snapshot.selfId, errors };
}

async function moveSocket(member, observer, x, y) {
  const moved = waitEvent(observer.socket, 'user:moved', (payload) => payload.id === member.id, 5000);
  member.socket.emit('move', { x, y });
  return moved;
}

test('real socket moves persist Mongo position before bumping the shared revision', async () => {
  const room = `revision_order_${process.pid}`;
  const backing = createSharedClusterBacking({ roomIds: [room] });
  const node = await startClusterNode({
    instanceId: `revision-order-${process.pid}`,
    redisUrl: null,
    keyPrefix: `revision_order_${process.pid}`,
    backing,
    logger: createMemoryLogger(),
    proximity: { radiusPx: RADIUS, peerDisconnectRadiusPx: DROP, maxPeersPerUser: 0 },
  });
  const cluster = { room };
  let alice;
  let bob;
  let releaseWrite;
  try {
    alice = await joinSocket(cluster, node, 'Alice');
    bob = await joinSocket(cluster, node, 'Bob');
    const beforeRevision = await node.io.edgeStore.getPositionRevision(alice.id);
    const beforeRow = backing.rows.get(alice.id);
    const targetX = beforeRow.x > 0 ? beforeRow.x - 1 : beforeRow.x + 1;
    const written = deferred();
    const release = deferred();
    releaseWrite = release.resolve;
    const originalUpsert = backing.presence.upsertPosition;
    let armed = true;
    backing.presence.upsertPosition = async (user, ...args) => {
      const result = await originalUpsert(user, ...args);
      if (armed && user.id === alice.id) {
        armed = false;
        written.resolve();
        await release.promise;
      }
      return result;
    };

    const moved = waitEvent(bob.socket, 'user:moved', (payload) => payload.id === alice.id, 5000);
    alice.socket.emit('move', { x: targetX, y: beforeRow.y });
    await written.promise;
    assert.equal(backing.rows.get(alice.id).x, targetX, 'the new position is visible first');
    assert.equal(
      await node.io.edgeStore.getPositionRevision(alice.id),
      beforeRevision,
      'the revision has not advanced inside the write/bump window',
    );

    release.resolve();
    await moved;
    assert.equal(await node.io.edgeStore.getPositionRevision(alice.id), beforeRevision + 1);
    backing.presence.upsertPosition = originalUpsert;
    assert.deepEqual(alice.errors, []);
    assert.deepEqual(bob.errors, []);
  } finally {
    releaseWrite?.();
    alice?.socket.close();
    bob?.socket.close();
    await node.close().catch(() => {});
    backing.rooms.removeRoom(room);
  }
});

test('revision recovery cannot resurrect a departed peer key after disconnect cleanup', redisOpts, async () => {
  const room = `recovery_leave_${process.pid}`;
  const keyPrefix = `recovery_leave_${process.pid}`;
  const backing = createSharedClusterBacking({ roomIds: [room] });
  const nodeA = await startClusterNode({
    instanceId: `recovery-leave-a-${process.pid}`, redisUrl: REDIS_URL_TEST, keyPrefix, backing,
    logger: createMemoryLogger(),
    proximity: { radiusPx: RADIUS, peerDisconnectRadiusPx: DROP, maxPeersPerUser: 0 },
  });
  const nodeB = await startClusterNode({
    instanceId: `recovery-leave-b-${process.pid}`, redisUrl: REDIS_URL_TEST, keyPrefix, backing,
    logger: createMemoryLogger(),
    proximity: { radiusPx: RADIUS, peerDisconnectRadiusPx: DROP, maxPeersPerUser: 0 },
  });
  const cluster = { room };
  let alice;
  let bob;
  let release;
  try {
    alice = await joinSocket(cluster, nodeA, 'Alice');
    bob = await joinSocket(cluster, nodeB, 'Bob');
    await moveSocket(alice, bob, 500, 500);
    await moveSocket(bob, alice, 540, 500);

    const store = nodeA.io.edgeStore;
    await nodeA.redis.storeClient.del(store.positionRevisionKey(bob.id));
    const originalEnsure = store.ensurePositionRevision.bind(store);
    const captured = deferred();
    const gate = deferred();
    release = gate.resolve;
    let armed = true;
    store.ensurePositionRevision = async (id) => {
      if (armed && id === bob.id) {
        armed = false;
        captured.resolve();
        await gate.promise;
      }
      return originalEnsure(id);
    };

    alice.socket.emit('move', { x: 500, y: 500 });
    await captured.promise;
    const presenceRemoved = deferred();
    const originalRemovePresence = backing.presence.removeUser;
    backing.presence.removeUser = async (id) => {
      const result = await originalRemovePresence(id);
      if (id === bob.id) presenceRemoved.resolve();
      return result;
    };
    bob.socket.close();
    await presenceRemoved.promise;
    await nodeB.io.drainSessions();
    assert.equal(backing.rows.has(bob.id), false, 'disconnect removes presence first');

    gate.resolve();
    await Promise.all([nodeA.io.drainSessions(), nodeB.io.drainSessions()]);
    await Promise.all([nodeA.io.peerGraph.drainSyncs(), nodeB.io.peerGraph.drainSyncs()]);
    assert.equal(await store.getPositionRevision(bob.id), 0, 'late recovery is rolled back');
    assert.equal(backing.rows.has(bob.id), false);
  } finally {
    release?.();
    alice?.socket.close();
    bob?.socket.close();
    const keys = await nodeA.io.edgeStore.scanKeys(`${keyPrefix}:*`).catch(() => []);
    if (keys.length) await nodeA.redis.storeClient.del(...keys).catch(() => {});
    await nodeA.close().catch(() => {});
    await nodeB.close().catch(() => {});
    backing.rooms.removeRoom(room);
  }
});

test('two real Socket.io instances never emit peer:connect for a stale beyond-drop read', redisOpts, async () => {
  const room = `race_socket_${process.pid}`;
  const keyPrefix = `race_io_${process.pid}`;
  const backing = createSharedClusterBacking({ roomIds: [room] });
  const logger = createMemoryLogger();
  const nodeA = await startClusterNode({
    instanceId: `race-a-${process.pid}`, redisUrl: REDIS_URL_TEST, keyPrefix, backing, logger,
    proximity: { radiusPx: RADIUS, peerDisconnectRadiusPx: DROP, maxPeersPerUser: 0 },
  });
  const nodeB = await startClusterNode({
    instanceId: `race-b-${process.pid}`, redisUrl: REDIS_URL_TEST, keyPrefix, backing, logger,
    proximity: { radiusPx: RADIUS, peerDisconnectRadiusPx: DROP, maxPeersPerUser: 0 },
  });
  const cluster = { room, nodeA, nodeB };
  let alice;
  let bob;
  let readGate;
  try {
    alice = await joinSocket(cluster, nodeA, 'Alice');
    bob = await joinSocket(cluster, nodeB, 'Bob');

    // Force a known disconnected state, then establish one real edge.
    await moveSocket(alice, bob, 100, 100);
    await moveSocket(bob, alice, 1200, 1200);
    await moveSocket(bob, alice, 540, 500);
    const connected = waitEvent(alice.socket, 'peer:connect', (payload) => payload.peerId === bob.id);
    await moveSocket(alice, bob, 500, 500);
    await connected;

    const farCreates = [];
    const originalAdded = nodeB.io.peerGraph.onEdgeAdded;
    nodeB.io.peerGraph.onEdgeAdded = (edge) => {
      const a = backing.rows.get(edge.a);
      const b = backing.rows.get(edge.b);
      const distancePx = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity;
      if (distancePx > DROP) farCreates.push({ edge, distancePx });
      originalAdded?.(edge);
    };

    readGate = gateNextRead(nodeB.io.peerGraph, bob.id);
    const bobMoved = waitEvent(alice.socket, 'user:moved', (payload) => payload.id === bob.id, 5000);
    bob.socket.emit('move', { x: 545, y: 500 });
    await readGate.captured;

    await moveSocket(alice, bob, 1005, 500); // exactly 460px from Bob
    assert.equal((await nodeA.io.edgeStore.allEdges(room)).length, 0);

    readGate.release();
    await bobMoved;
    await Promise.all([nodeA.io.peerGraph.drainSyncs(), nodeB.io.peerGraph.drainSyncs()]);

    assert.deepEqual(farCreates, [], 'a stale read reached the gateway peer:connect listener');
    const edges = await nodeA.io.edgeStore.allEdges(room);
    for (const edge of edges) {
      const a = backing.rows.get(edge.a);
      const b = backing.rows.get(edge.b);
      assert.ok(a && b && Math.hypot(a.x - b.x, a.y - b.y) <= DROP);
    }
    assert.deepEqual(alice.errors, []);
    assert.deepEqual(bob.errors, []);
  } finally {
    readGate?.release();
    alice?.socket.close();
    bob?.socket.close();
    const keys = await nodeA.io.edgeStore.scanKeys(`${keyPrefix}:*`).catch(() => []);
    if (keys.length) await nodeA.redis.storeClient.del(...keys).catch(() => {});
    await nodeA.close().catch(() => {});
    await nodeB.close().catch(() => {});
    backing.rooms.removeRoom(room);
  }
});
