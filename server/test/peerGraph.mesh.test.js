/**
 * Day 13 mesh policy tests (no MongoDB, no sockets).
 *
 * `findNearby` is a deterministic in-memory stand-in that mirrors the real
 * geospatial query contract ({ id, distancePx } sorted nearest-first), so the
 * graph's own rules are proven without a database:
 *   - nearest-first, deterministic tie-breaking
 *   - hysteresis: connect at <=100 px, hold at 101..115 px, drop above 115 px
 *   - the symmetric degree cap (enforced by the EdgeStore, reported as `capped`)
 *   - slot reclaim after a removal, bounded (no cascades)
 *   - the star no-thrash scenario from the Day 13 brief
 *   - reconcile / stats respect the cap and the radii
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PeerGraph } from '../src/services/peerGraph.js';
import { MemoryEdgeStore, edgeKey } from '../src/services/edgeStore.js';

const RADIUS = 100;
const DROP = 115;

/** Mutable pixel world + the `findNearby` contract. */
function createWorld() {
  const rows = new Map(); // `${room}/${id}` -> { id, room, x, y }
  const calls = [];

  const findNearby = async (roomId, userId, radiusPx) => {
    calls.push({ roomId, userId, radiusPx });
    const self = rows.get(`${roomId}/${userId}`);
    if (!self) return [];
    return [...rows.values()]
      .filter((row) => row.room === roomId && row.id !== userId)
      .map((row) => ({ id: row.id, distancePx: Math.hypot(row.x - self.x, row.y - self.y) }))
      .filter((neighbor) => neighbor.distancePx <= radiusPx)
      .sort((left, right) => left.distancePx - right.distancePx || left.id.localeCompare(right.id));
  };

  return {
    rows,
    calls,
    findNearby,
    place(id, x, y, room = 'room') {
      rows.set(`${room}/${id}`, { id, room, x, y });
    },
    move(id, x, y, room = 'room') {
      const row = rows.get(`${room}/${id}`);
      if (!row) throw new Error(`unknown user ${id}`);
      row.x = x;
      row.y = y;
    },
  };
}

function makeGraph(world, { radiusPx = RADIUS, dropRadiusPx = DROP, maxPeersPerUser = 8 } = {}) {
  const added = [];
  const removed = [];
  const store = new MemoryEdgeStore({ maxPeersPerUser });
  const graph = new PeerGraph({
    findNearby: world.findNearby,
    radiusPx,
    dropRadiusPx,
    maxPeersPerUser,
    edgeStore: store,
    onEdgeAdded: (edge) => added.push(edge),
    onEdgeRemoved: (edge) => removed.push(edge),
  });
  return { graph, store, added, removed };
}

/** Register both the graph room membership and the pixel row. */
function seat(graph, world, id, x, y, room = 'room') {
  world.place(id, x, y, room);
  graph.register(room, id);
}

const degrees = async (graph, room, ids) => {
  const result = {};
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    result[id] = (await graph.neighbors(room, id)).length;
  }
  return result;
};

// ------------------------------------------------------------------- tests ---

test('nearest candidates win the slots, distance ties break by user id, results are reproducible', async () => {
  const world = createWorld();
  const first = makeGraph(world, { maxPeersPerUser: 2 });
  seat(first.graph, world, 'self', 0, 0);
  seat(first.graph, world, 'zeta', 10, 0); // distance 10
  seat(first.graph, world, 'alpha', 0, 10); // distance 10 (tie)
  seat(first.graph, world, 'mid', 40, 0); // distance 40

  await first.graph.join('room', 'self');
  await first.graph.drainSyncs();
  assert.deepEqual(await first.graph.neighbors('room', 'self'), ['alpha', 'zeta'], 'tie goes to the smaller id, then the nearest');
  assert.equal((await first.graph.edges('room')).length, 2);
  assert.equal(first.graph.meshStats().edgesCreated, 2);

  // Same layout, independently constructed graph: identical result.
  const second = makeGraph(world, { maxPeersPerUser: 2 });
  for (const id of ['self', 'zeta', 'alpha', 'mid']) {
    seat(second.graph, world, id, world.rows.get(`room/${id}`).x, world.rows.get(`room/${id}`).y);
  }
  await second.graph.join('room', 'self');
  await second.graph.drainSyncs();
  assert.deepEqual(await second.graph.neighbors('room', 'self'), ['alpha', 'zeta']);

  // NO EVICTION: a closer newcomer does not displace an existing edge.
  world.move('mid', 5, 0); // now the nearest of all
  await first.graph.sync('room', 'self');
  await first.graph.drainSyncs();
  assert.deepEqual(
    await first.graph.neighbors('room', 'self'),
    ['alpha', 'zeta'],
    'existing edges are kept even though a closer peer is free',
  );
  assert.equal(first.graph.meshStats().edgesCreated, 2, 'no extra edge was created');
});

test('hysteresis: create <= 100 px, hold at 101..115 px, drop above 115 px, never re-create in the band', async () => {
  const world = createWorld();
  const { graph, added, removed } = makeGraph(world);
  seat(graph, world, 'ada', 0, 0);
  seat(graph, world, 'bob', 90, 0);

  await graph.join('room', 'ada');
  await graph.join('room', 'bob');
  await graph.drainSyncs();
  assert.equal((await graph.neighbors('room', 'ada')).length, 1);
  assert.equal(added.length, 1);
  assert.equal(graph.edgeBetween('room', 'ada', 'bob').generation, 1);

  // 101 px: outside the connect radius, inside the drop radius -> held.
  world.move('bob', 101, 0);
  await graph.sync('room', 'ada');
  await graph.drainSyncs();
  assert.deepEqual(await graph.neighbors('room', 'ada'), ['bob'], 'the edge survives at 101 px');
  assert.equal(removed.length, 0);
  assert.ok(graph.meshStats().hysteresisHolds >= 1, 'the hold is counted');
  assert.equal(added.length, 1, 'no new edge was created at 101 px');

  // 115 px is still inside the drop radius (inclusive).
  world.move('bob', 115, 0);
  await graph.sync('room', 'ada');
  await graph.drainSyncs();
  assert.deepEqual(await graph.neighbors('room', 'ada'), ['bob'], 'exactly at the drop radius the edge is kept');

  // 116 px: dropped.
  world.move('bob', 116, 0);
  await graph.sync('room', 'ada');
  await graph.drainSyncs();
  assert.deepEqual(await graph.neighbors('room', 'ada'), []);
  assert.equal(removed.length, 1);
  assert.equal(graph.meshStats().edgesRemoved, 1);

  // 105 px: inside the drop band again, but no NEW edge may be created there.
  world.move('bob', 105, 0);
  await graph.sync('room', 'ada');
  await graph.drainSyncs();
  assert.deepEqual(await graph.neighbors('room', 'ada'), [], 'a new offer is forbidden beyond 100 px');
  assert.equal(added.length, 1);

  // 99 px: a fresh edge is allowed and gets a higher generation.
  world.move('bob', 99, 0);
  await graph.sync('room', 'ada');
  await graph.drainSyncs();
  assert.deepEqual(await graph.neighbors('room', 'ada'), ['bob']);
  assert.equal(added.length, 2);
  assert.ok(graph.edgeBetween('room', 'ada', 'bob').generation > 1);
});

test('a removed edge frees a slot and the survivors refill it with the nearest unconnected peer', async () => {
  const world = createWorld();
  const { graph, added } = makeGraph(world, { maxPeersPerUser: 2 });
  seat(graph, world, 'self', 0, 0);
  seat(graph, world, 'alpha', 10, 0); // 10 px
  seat(graph, world, 'bob', 20, 0); // 20 px
  seat(graph, world, 'carol', 30, 0); // 30 px

  await graph.join('room', 'self');
  await graph.drainSyncs();
  assert.deepEqual(await graph.neighbors('room', 'self'), ['alpha', 'bob'], 'cap 2 keeps the nearest two');
  assert.equal(await graph.hasEdge('room', 'self', 'carol'), false, 'carol was refused: both endpoints need a free slot');

  const createdBefore = added.length;
  await graph.leave('room', 'bob');
  await graph.drainSyncs();

  assert.deepEqual(await graph.neighbors('room', 'self'), ['alpha', 'carol'], 'the freed slot went to the nearest free peer');
  assert.equal(added.length, createdBefore + 1, 'exactly one reclaim edge was created (no cascade)');
  assert.equal((await graph.edges('room')).length, 2);
});

test('a user at the cap refills its OWN freed slots in the same sync (no waiting for the next move)', async () => {
  const world = createWorld();
  const { graph, added } = makeGraph(world, { maxPeersPerUser: 4 });
  seat(graph, world, 'hub', 500, 500);
  for (let i = 1; i <= 4; i += 1) seat(graph, world, `old${i}`, 500 + i * 10, 500);

  const everyone = ['hub', 'old1', 'old2', 'old3', 'old4'];
  for (const id of everyone) {
    // eslint-disable-next-line no-await-in-loop
    await graph.sync('room', id);
  }
  await graph.drainSyncs();
  assert.deepEqual(await graph.neighbors('room', 'hub'), ['old1', 'old2', 'old3', 'old4'], 'hub is at the cap');

  // All four held peers walk out of the drop radius at once; a fresh peer is 20 px away.
  for (let i = 1; i <= 4; i += 1) world.move(`old${i}`, 1500, 500);
  seat(graph, world, 'fresh', 500, 520);

  const createdBefore = added.length;
  await graph.sync('room', 'hub');
  await graph.drainSyncs();

  assert.deepEqual(
    await graph.neighbors('room', 'hub'),
    ['fresh'],
    'the freed slot is filled by the same sync that removed the stale edges',
  );
  assert.equal(added.length, createdBefore + 1, 'exactly one new edge, no duplicate create');
});

test('star scenario: 8 users at (100,100) + outsider Z at (180,100), cap 4, 100 rounds of sync = zero churn', async () => {
  const world = createWorld();
  const { graph, added, removed } = makeGraph(world, { maxPeersPerUser: 4 });
  const stars = Array.from({ length: 8 }, (_, index) => `star_${index}`);
  for (const id of stars) seat(graph, world, id, 100, 100);
  seat(graph, world, 'z', 180, 100); // 80 px from every star

  const everyone = [...stars, 'z'];
  for (const id of everyone) {
    // eslint-disable-next-line no-await-in-loop
    await graph.sync('room', id);
  }
  await graph.drainSyncs();

  const settledEdges = (await graph.edges('room')).map((edge) => edge.key).sort();
  const settledAdded = added.length;
  const settledRemoved = removed.length;
  const settledDegrees = await degrees(graph, 'room', everyone);
  for (const id of everyone) {
    assert.ok(settledDegrees[id] <= 4, `${id} has ${settledDegrees[id]} peers (cap 4)`);
  }
  assert.ok(settledEdges.length > 0, 'the star really formed edges');

  const orders = [
    everyone,
    [...everyone].reverse(),
    ['z', ...stars],
    [...stars].reverse().concat('z'),
  ];
  for (let round = 0; round < 100; round += 1) {
    const order = orders[round % orders.length];
    for (const id of order) {
      // eslint-disable-next-line no-await-in-loop
      await graph.sync('room', id);
    }
    // eslint-disable-next-line no-await-in-loop
    await graph.drainSyncs();
  }

  assert.equal(added.length, settledAdded, `no connect churn over 100 rounds (saw ${added.length - settledAdded})`);
  assert.equal(removed.length, settledRemoved, `no disconnect churn over 100 rounds (saw ${removed.length - settledRemoved})`);
  assert.deepEqual((await graph.edges('room')).map((edge) => edge.key).sort(), settledEdges);
  assert.deepEqual(await degrees(graph, 'room', everyone), settledDegrees);
});

test('reconcile respects the cap and the drop radius; it never creates an edge beyond 100 px', async () => {
  const world = createWorld();
  const { graph } = makeGraph(world, { maxPeersPerUser: 2 });
  seat(graph, world, 'self', 0, 0);
  seat(graph, world, 'in_1', 20, 0); // 20 px
  seat(graph, world, 'in_2', 40, 0); // 40 px
  seat(graph, world, 'in_3', 60, 0); // 60 px
  seat(graph, world, 'held', 110, 0); // inside the drop band, outside connect
  // All are local users of this instance, so reconcileLocalUsers() syncs each.
  await graph.reconcileLocalUsers();
  await graph.drainSyncs();

  const edges = await graph.edges('room');
  const degree = await degrees(graph, 'room', ['self', 'in_1', 'in_2', 'in_3', 'held']);
  for (const [id, value] of Object.entries(degree)) {
    assert.ok(value <= 2, `${id} degree ${value} exceeds the cap`);
  }
  for (const edge of edges) {
    const a = world.rows.get(`room/${edge.a}`);
    const b = world.rows.get(`room/${edge.b}`);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= RADIUS, `reconcile created an edge beyond 100 px: ${edgeKey(edge.a, edge.b)}`);
  }
  // 'held' is 110 px from self (never connected to it), but may legitimately be
  // within 100 px of in_2/in_3 — the per-edge distance loop above is the check.
  assert.equal(await graph.hasEdge('room', 'self', 'held'), false, 'no new self<->held edge at 110 px');
});

test('a capped create is counted and emits nothing to clients', async () => {
  const world = createWorld();
  const { graph, added, removed } = makeGraph(world, { maxPeersPerUser: 1 });
  seat(graph, world, 'self', 0, 0);
  seat(graph, world, 'first', 10, 0);
  seat(graph, world, 'second', 20, 0);

  await graph.join('room', 'self');
  await graph.join('room', 'first');
  await graph.join('room', 'second');
  await graph.drainSyncs();

  const stats = graph.meshStats();
  assert.ok(stats.cappedRejections >= 1, 'the refused pair incremented cappedRejections');
  assert.equal(stats.edgesCreated, added.length);
  assert.equal(stats.edgesRemoved, removed.length);
  assert.equal((await graph.neighbors('room', 'self')).length, 1, 'never more than one edge for self');
  assert.equal(graph.stats('room').mesh.cappedRejections, stats.cappedRejections, 'stats() exposes the counters');
});

test('neighbor entries without a proven distance never create an edge', async () => {
  const graph = new PeerGraph({
    findNearby: async () => ['ghost'],
    radiusPx: RADIUS,
    dropRadiusPx: DROP,
    maxPeersPerUser: 8,
    edgeStore: new MemoryEdgeStore({ maxPeersPerUser: 8 }),
  });
  graph.register('room', 'self');
  await graph.sync('room', 'self');
  await graph.drainSyncs();
  assert.deepEqual(await graph.neighbors('room', 'self'), []);
});

test('MAX_PEERS_PER_USER=0 with drop == radius behaves exactly like Day 12', async () => {
  const world = createWorld();
  const { graph } = makeGraph(world, { radiusPx: RADIUS, dropRadiusPx: RADIUS, maxPeersPerUser: 0 });
  for (const [id, x, y] of [['a', 0, 0], ['b', 60, 0], ['c', 0, 60]]) {
    seat(graph, world, id, x, y);
  }
  await graph.join('room', 'a');
  await graph.join('room', 'b');
  await graph.join('room', 'c');
  await graph.drainSyncs();

  const edges = await graph.edges('room');
  assert.equal(edges.length, 3, 'a complete triangle: unlimited peers, every in-range pair connected');
  assert.equal((await graph.neighbors('room', 'a')).length, 2);

  // Day 12 semantics: one pixel beyond the radius disconnects.
  world.move('b', 101, 0);
  await graph.sync('room', 'b');
  await graph.drainSyncs();
  assert.equal(await graph.hasEdge('room', 'a', 'b'), false, 'Day 12: 101 px drops the edge');
  assert.equal(await graph.hasEdge('room', 'b', 'c'), false, 'b is now >100 px from c as well');
  assert.equal(await graph.hasEdge('room', 'a', 'c'), true, 'the untouched a<->c edge survives');
  assert.equal(graph.meshStats().hysteresisHolds, 0, 'no hold band when drop == radius');
});
