/**
 * Peer graph unit tests (Week 2, Day 8) — no MongoDB, no sockets.
 *
 * A tiny in-memory neighbor source stands in for the Day 7 `$near` query, so
 * the graph's own contract (one edge per pair, deterministic initiator,
 * monotonic generations, per-user diffing, leave-while-querying) is proven
 * deterministically. The real `$near` path is covered by
 * peerGraph.integration.test.js against MongoDB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerGraph, edgeKey, pickInitiator } from '../src/services/peerGraph.js';

/** Mutable world + a call log, mirroring findNearby's contract. */
function createWorld(users = []) {
  const rows = new Map(users.map((user) => [`${user.roomId}/${user.id}`, user]));
  const calls = [];
  const findNearby = async (roomId, userId, radiusPx) => {
    calls.push({ roomId, userId, radiusPx });
    const self = rows.get(`${roomId}/${userId}`);
    if (!self) return [];
    return [...rows.values()]
      .filter((user) => user.roomId === roomId && user.id !== userId)
      .map((user) => ({ id: user.id, distancePx: Math.hypot(user.x - self.x, user.y - self.y) }))
      .filter((user) => user.distancePx <= radiusPx)
      .sort((left, right) => left.distancePx - right.distancePx || left.id.localeCompare(right.id));
  };
  return {
    rows, calls, findNearby,
    place(id, x, y, roomId = 'room') {
      rows.set(`${roomId}/${id}`, { id, roomId, x, y });
    },
    remove(id, roomId = 'room') { rows.delete(`${roomId}/${id}`); },
    callsFor(userId) { return calls.filter((call) => call.userId === userId); },
  };
}

test('one edge per pair, deterministic initiator and monotonic generations', async () => {
  const world = createWorld();
  const added = [], removed = [];
  const graph = new PeerGraph({ findNearby: world.findNearby, onEdgeAdded: (e) => added.push(e), onEdgeRemoved: (e) => removed.push(e) });
  world.place('a', 100, 100);
  world.place('b', 150, 100);

  await graph.join('room', 'a', { name: 'Ada' });
  await graph.join('room', 'b', { name: 'Bob' });
  await graph.sync('room', 'b'); // unchanged: must not emit a duplicate

  assert.equal(graph.stats('room').edges, 1);
  assert.equal(added.length, 1, 'exactly one connect callback for the pair');
  assert.equal(removed.length, 0);
  assert.deepEqual(graph.neighbors('room', 'a'), ['b']);
  assert.deepEqual(graph.neighbors('room', 'b'), ['a']);

  const edge = graph.edgeBetween('room', 'a', 'b');
  assert.equal(edge.generation, 1);
  assert.equal(edge.a, pickInitiator('a', 'b'));
  assert.equal(edge.initiator, 'a');
  assert.equal(graph.edgeBetween('room', 'b', 'a').generation, edge.generation, 'lookup is order-independent');

  world.place('b', 400, 100); // 300 px away
  const diff = await graph.sync('room', 'b');
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.added.length, 0);
  assert.equal(graph.stats('room').edges, 0);
  assert.equal(removed[0].generation, edge.generation);

  world.place('b', 160, 100);
  await graph.sync('room', 'b');
  const recreated = graph.edgeBetween('room', 'a', 'b');
  assert.ok(recreated.generation > edge.generation, 'a re-created edge gets a new generation');
  assert.equal(added.length, 2);
});

test('a sync queries only the moving user', async () => {
  const world = createWorld();
  const graph = new PeerGraph({ findNearby: world.findNearby });
  ['a', 'b', 'c'].forEach((id, index) => world.place(id, index * 60, 0));
  for (const id of ['a', 'b', 'c']) await graph.join('room', id);
  const before = world.calls.length;

  world.place('b', 60, 10);
  await graph.sync('room', 'b');

  assert.equal(world.calls.length - before, 1, 'exactly one neighbor query for one accepted move');
  assert.equal(world.calls.at(-1).userId, 'b');
  assert.equal(world.calls.at(-1).radiusPx, graph.radiusPx);
});

test('same pixel is a valid edge, a user never connects to itself, rooms never mix', async () => {
  const world = createWorld();
  const graph = new PeerGraph({ findNearby: world.findNearby });
  world.place('a', 200, 200);
  world.place('b', 200, 200);
  world.place('other', 200, 200, 'room-2');

  await graph.join('room', 'a');
  await graph.join('room', 'b');
  await graph.join('room-2', 'other');

  assert.equal(graph.stats('room').edges, 1, 'distance 0 is inside the radius');
  assert.equal(graph.stats('room-2').edges, 0, 'different rooms never share an edge');
  assert.deepEqual(graph.neighbors('room', 'a'), ['b']);
  assert.equal(graph.edgeBetween('room', 'a', 'a'), null, 'no self edge');

  // Even a source that wrongly returns the user itself must not self-connect.
  const buggy = new PeerGraph({ findNearby: async () => [{ id: 'solo', distancePx: 0 }] });
  await buggy.join('room', 'solo');
  assert.equal(buggy.stats('room').edges, 0);
});

test('a peer that is not registered yet cannot create an orphan edge', async () => {
  const world = createWorld();
  const added = [];
  const graph = new PeerGraph({ findNearby: world.findNearby, onEdgeAdded: (e) => added.push(e) });
  world.place('a', 100, 100);
  world.place('b', 150, 100);

  // B has a presence row but has not joined the graph yet.
  await graph.register('room', 'a');
  await graph.sync('room', 'a');
  assert.equal(graph.stats('room').edges, 0);
  assert.equal(added.length, 0);

  // B's own join creates the edge exactly once, and notifies both sides.
  await graph.join('room', 'b');
  assert.equal(graph.stats('room').edges, 1);
  assert.equal(added.length, 1);
  assert.equal(added[0].roomId, 'room');
  assert.deepEqual(graph.neighbors('room', 'b'), ['a']);
});

test('leave removes every edge once and is idempotent', async () => {
  const world = createWorld();
  const removed = [];
  const graph = new PeerGraph({ findNearby: world.findNearby, onEdgeRemoved: (e) => removed.push(e) });
  world.place('hub', 100, 100);
  world.place('x', 150, 100);
  world.place('y', 100, 190); // 90 px from hub, 103 px from x
  for (const id of ['hub', 'x', 'y']) await graph.join('room', id);
  assert.equal(graph.stats('room').edges, 2);

  const edges = graph.leave('room', 'hub');
  assert.equal(edges.length, 2);
  assert.equal(removed.length, 2);
  assert.equal(graph.stats('room').edges, 0);
  assert.equal(graph.isRegistered('room', 'hub'), false);
  assert.deepEqual(graph.neighbors('room', 'x'), []);

  assert.deepEqual(graph.leave('room', 'hub'), [], 'second leave is a no-op');
  assert.equal(removed.length, 2, 'no duplicate disconnect callbacks');
});

test('a leave during an in-flight query aborts the sync without recreating edges', async () => {
  const world = createWorld();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const graph = new PeerGraph({
    findNearby: async (...args) => { calls += 1; await gate; return world.findNearby(...args); },
  });
  world.place('a', 100, 100);
  world.place('b', 150, 100);
  graph.register('room', 'a');
  graph.register('room', 'b');

  const pending = graph.sync('room', 'a');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);

  graph.leave('room', 'a');
  release();
  const diff = await pending;
  assert.deepEqual(diff, { added: [], removed: [] });
  assert.equal(graph.stats('room').edges, 0);
  assert.equal(graph.isRegistered('room', 'a'), false);
  assert.equal(graph.isRegistered('room', 'b'), true);
});

test('syncs for one user are serialized, so a move cannot overtake its join', async () => {
  const world = createWorld();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let first = true;
  const graph = new PeerGraph({
    findNearby: async (roomId, userId, radiusPx) => {
      order.push(userId);
      if (first) { first = false; await firstGate; }
      return world.findNearby(roomId, userId, radiusPx);
    },
  });
  world.place('a', 100, 100);
  world.place('b', 150, 100);
  graph.register('room', 'a');
  graph.register('room', 'b');

  const joinSync = graph.sync('room', 'a');
  const moveSync = graph.sync('room', 'a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['a'], 'the second query waits for the first');

  releaseFirst();
  await Promise.all([joinSync, moveSync]);
  assert.deepEqual(order, ['a', 'a']);
  assert.equal(graph.stats('room').edges, 1, 'the pair is still stored exactly once');
});

test('edge keys and initiators are order-independent; timings are recorded', async () => {
  assert.equal(edgeKey('x', 'y'), edgeKey('y', 'x'));
  assert.notEqual(edgeKey('x', 'y'), edgeKey('x', 'z'));
  assert.equal(pickInitiator('z', 'a'), 'a');
  assert.equal(pickInitiator('a', 'a'), 'a');

  const world = createWorld();
  const graph = new PeerGraph({ findNearby: world.findNearby });
  world.place('a', 0, 0);
  world.place('b', 50, 0);
  await graph.join('room', 'a');
  await graph.join('room', 'b');
  await graph.sync('room', 'b');

  const summary = graph.latencySummary();
  assert.ok(summary.samples >= 3);
  assert.ok(summary.p50 >= 0 && summary.p95 >= summary.p50);
  assert.equal(graph.stats('room').syncs, 3);
});
