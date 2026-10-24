/**
 * Regression test for the onEdgeRemoved name cache bug.
 *
 * When an edge A-B is removed, the socket gateway's onEdgeRemoved handler
 * previously called forgetPeerName for BOTH endpoints unconditionally. This
 * caused unnecessary cache evictions: if A still has edges to C and D, A's
 * name should NOT be forgotten because C and D still need it for display.
 *
 * This test verifies that after an edge removal, names of users who still
 * have other edges remain in the cache.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerGraph } from '../src/services/peerGraph.js';
import { MemoryEdgeStore } from '../src/services/edgeStore.js';

function createWorld() {
  const rows = new Map();
  const findNearby = async (roomId, userId, radiusPx) => {
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

test('peer names are not evicted from cache when an edge is removed but the user still has other edges', async () => {
  const world = createWorld();
  const store = new MemoryEdgeStore({ maxPeersPerUser: 8 });
  const graph = new PeerGraph({
    findNearby: world.findNearby,
    radiusPx: 100,
    dropRadiusPx: 115,
    maxPeersPerUser: 8,
    edgeStore: store,
    allowRemotePeers: false,
  });

  // Place A at origin, B and C within 50px (well within connect radius).
  world.place('A', 0, 0);
  world.place('B', 50, 0);
  world.place('C', 0, 50);

  // Register all users and remember their names.
  graph.register('room', 'A', { name: 'Alice' });
  graph.register('room', 'B', { name: 'Bob' });
  graph.register('room', 'C', { name: 'Carol' });
  graph.rememberPeerName('room', 'B', 'Bob');
  graph.rememberPeerName('room', 'C', 'Carol');

  // Sync A: creates edges A-B and A-C.
  await graph.sync('room', 'A');
  const edgesBefore = await graph.edges('room');
  assert.equal(edgesBefore.length, 2, 'A should have edges to both B and C');

  // Move B far away (beyond drop radius) so the A-B edge is removed.
  world.move('B', 500, 500);
  await graph.sync('room', 'A');

  const edgesAfter = await graph.edges('room');
  assert.equal(edgesAfter.length, 1, 'A should only have edge to C after B moves away');
  assert.equal(edgesAfter[0].b, 'C', 'the remaining edge should be A-C');

  // C's name should still be in the cache because A still has an edge to C.
  const cName = graph.nameOf('room', 'C');
  assert.equal(cName, 'Carol', 'C\'s name should remain cached while the A-C edge exists');
});
