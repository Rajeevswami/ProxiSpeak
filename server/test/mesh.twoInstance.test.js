/**
 * Day 13 cross-instance mesh tests: two REAL Socket.io servers, REAL
 * `socket.io-client` sockets, REAL `@socket.io/redis-adapter` and
 * `RedisEdgeStore`, one shared Redis. The spatial presence backing is the
 * deterministic in-memory harness from Day 12, so this suite runs without a
 * local `mongod` (the MongoDB-backed variants live in the Day 8 suite).
 *
 *   REDIS_URL_TEST="redis://127.0.0.1:6379" npm test
 *
 * Without REDIS_URL_TEST every test is reported as skipped with a loud banner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectTestClient,
  createSharedClusterBacking,
  delay,
  startClusterNode,
  waitEvent,
} from './helpers/twoInstanceHarness.js';
import { sweepOrphanEdges } from '../src/services/edgeSweep.js';

const REDIS_URL_TEST = (process.env.REDIS_URL_TEST ?? '').trim();
const CAP = 2;
const RADIUS = 100;
const DROP = 115;

if (!REDIS_URL_TEST) {
  console.error([
    '# =====================================================================',
    '#  Day 13 cross-instance mesh tests: NOT VERIFIED',
    '#  REDIS_URL_TEST is unset. Start Redis and re-run:',
    '#    REDIS_URL_TEST="redis://127.0.0.1:6379" npm test',
    '# =====================================================================',
  ].join('\n'));
}

const skipOpts = REDIS_URL_TEST
  ? {}
  : { skip: 'NOT VERIFIED — set REDIS_URL_TEST="redis://127.0.0.1:6379" to run cross-instance mesh tests' };

let suiteSeq = 0;

async function makeCluster({ cap = CAP, dropRadiusPx = DROP, roomId } = {}) {
  suiteSeq += 1;
  const keyPrefix = `day13_mesh_${process.pid}_${suiteSeq}`;
  const room = roomId ?? `meshtest_${process.pid}_${suiteSeq}`;
  const backing = createSharedClusterBacking({ roomIds: [room] });
  const nodeA = await startClusterNode({
    instanceId: `mesh-a-${suiteSeq}`,
    redisUrl: REDIS_URL_TEST,
    keyPrefix,
    backing,
    proximity: { radiusPx: RADIUS, peerDisconnectRadiusPx: dropRadiusPx, maxPeersPerUser: cap },
  });
  const nodeB = await startClusterNode({
    instanceId: `mesh-b-${suiteSeq}`,
    redisUrl: REDIS_URL_TEST,
    keyPrefix,
    backing,
    proximity: { radiusPx: RADIUS, peerDisconnectRadiusPx: dropRadiusPx, maxPeersPerUser: cap },
  });
  return {
    keyPrefix,
    room,
    backing,
    nodeA,
    nodeB,
    urls: [nodeA.baseUrl, nodeB.baseUrl],
    async close() {
      const keys = await nodeA.io.edgeStore.scanKeys(`${keyPrefix}:*`).catch(() => []);
      if (keys.length) await nodeA.redis.storeClient.del(...keys).catch(() => {});
      await nodeA.close().catch(() => {});
      await nodeB.close().catch(() => {});
      backing.rooms.removeRoom(room);
    },
  };
}

async function joinOn(cluster, nodeIndex, roomId, name) {
  const socket = await connectTestClient(cluster.urls[nodeIndex]);
  const errors = [];
  socket.on('error', (error) => errors.push(error));
  const joined = waitEvent(socket, 'joined');
  socket.emit('join', { roomId, name });
  const snapshot = await joined;
  return { socket, id: snapshot.selfId, joined: snapshot, errors };
}

/** Move to an absolute pixel and wait until the server broadcasts it to us. */
async function moveTo(member, observer, x, y) {
  const moved = waitEvent(observer.socket, 'user:moved', (payload) => payload.id === member.id, 5000)
    .catch((err) => {
      throw new Error(`${err.message} (mover errors: ${JSON.stringify(member.errors ?? [])}, observer errors: ${JSON.stringify(observer.errors ?? [])})`);
    });
  member.socket.emit('move', { x, y });
  return moved;
}

const degreeInRedis = async (cluster, userId) =>
  Number(await cluster.nodeA.redis.storeClient.scard(`${cluster.keyPrefix}:user-edges:${userId}`));

test('the joined payload carries maxPeers and peerDisconnectRadiusPx from the server config', skipOpts, async (t) => {
  const cluster = await makeCluster();
  t.after(() => cluster.close());
  try {
    const hub = await joinOn(cluster, 0, cluster.room, 'Hub');
    assert.equal(hub.joined.maxPeers, CAP);
    assert.equal(hub.joined.peerDisconnectRadiusPx, DROP);
    assert.equal(hub.joined.proximityRadiusPx, RADIUS);
  } finally {
    // t.after handles the teardown
  }
});

test('the cap is enforced in the shared store: a hub with peers on BOTH instances gets at most 2 edges', skipOpts, async () => {
  const cluster = await makeCluster();
  const peers = [];
  try {
    const hub = await joinOn(cluster, 0, cluster.room, 'Hub');
    // Five peers, alternating instances, all within 100 px of the hub.
    const positions = [
      { x: 560, y: 500 },
      { x: 440, y: 500 },
      { x: 500, y: 420 },
      { x: 500, y: 580 },
      { x: 540, y: 460 },
    ];
    for (let index = 0; index < positions.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      peers.push({
        ...(await joinOn(cluster, index % 2 === 0 ? 1 : 0, cluster.room, `Peer${index}`)),
        connects: [],
        disconnects: [],
        target: positions[index],
      });
    }
    for (const peer of peers) {
      peer.socket.on('peer:connect', (event) => peer.connects.push(event));
      peer.socket.on('peer:disconnect', (event) => peer.disconnects.push(event));
    }

    const hubConnects = [];
    const hubDisconnects = [];
    hub.socket.on('peer:connect', (event) => hubConnects.push(event));
    hub.socket.on('peer:disconnect', (event) => hubDisconnects.push(event));

    await moveTo(hub, peers[0], 500, 500);
    await moveTo(peers[0], hub, positions[0].x, positions[0].y);
    // Race the remaining four into range from both instances at once.
    for (const peer of peers) peer.socket.emit('move', peer.target);
    await delay(250);
    // Re-issue once so every client's last sync ran with the final positions.
    for (const peer of peers) peer.socket.emit('move', peer.target);
    await delay(1200);

    assert.equal((await degreeInRedis(cluster, hub.id)), CAP, 'the shared user-edge set holds exactly the cap');
    const hubPeerIds = new Set(hubConnects.map((event) => event.peerId));
    assert.equal(hubPeerIds.size, CAP, `hub received connects for ${hubPeerIds.size} peers`);
    assert.ok(hubConnects.every((event) => peers.some((peer) => peer.id === event.peerId)));

    // The refused pairs are silent: no peer:connect for the hub on either side,
    // and no hub<->peer edge in the shared store (peers may still connect to
    // each other — every one of them is under its own cap).
    for (const peer of peers) {
      if (hubPeerIds.has(peer.id)) continue;
      assert.equal(peer.connects.some((event) => event.peerId === hub.id), false, `${peer.joined.selfId.slice(0, 5)} must stay capped`);
      const peerEdges = await cluster.nodeA.io.edgeStore.edgesOf(peer.id);
      assert.equal(
        peerEdges.some((edge) => edge.a === hub.id || edge.b === hub.id),
        false,
        'a capped pair leaves no Redis edge record',
      );
    }

    // Counters on the instance that refused a create are visible at debug level.
    const counters = [cluster.nodeA.io.peerGraph.meshStats(), cluster.nodeB.io.peerGraph.meshStats()];
    assert.ok(counters.some((entry) => entry.cappedRejections > 0), 'cappedRejections counted on at least one instance');
  } finally {
    for (const peer of peers) peer.socket.close();
    await cluster.close();
  }
});

test('removing a cross-instance edge frees the hub slot and the survivor reclaims it on the other instance', skipOpts, async () => {
  const cluster = await makeCluster();
  const peers = [];
  try {
    const hub = await joinOn(cluster, 0, cluster.room, 'Hub');
    // p1/p2 are the nearest, p3 the spare. Distances 60/70/90; the peers are
    // >100 px apart from each other, so every potential edge is hub<->peer.
    const layout = [
      { x: 560, y: 500 },
      { x: 430, y: 500 },
      { x: 500, y: 410 },
    ];
    for (let index = 0; index < layout.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      peers.push({
        ...(await joinOn(cluster, index === 1 ? 0 : 1, cluster.room, `Peer${index}`)),
        connects: [],
        disconnects: [],
        target: layout[index],
      });
    }
    for (const peer of peers) {
      peer.socket.on('peer:connect', (event) => peer.connects.push(event));
      peer.socket.on('peer:disconnect', (event) => peer.disconnects.push(event));
    }
    const hubDisconnects = [];
    hub.socket.on('peer:disconnect', (event) => hubDisconnects.push(event));

    await moveTo(hub, peers[0], 500, 500);
    for (let index = 0; index < peers.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await moveTo(peers[index], hub, peers[index].target.x, peers[index].target.y);
    }
    // Wait for the hub to reach the cap.
    const deadline = Date.now() + 8000;
    while ((await degreeInRedis(cluster, hub.id)) < CAP && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await delay(100);
    }
    const connectedIds = new Set(
      (await cluster.nodeA.io.edgeStore.edgesOf(hub.id)).map((edge) => (edge.a === hub.id ? edge.b : edge.a)),
    );
    assert.equal(connectedIds.size, CAP);
    const leaving = peers.find((peer) => connectedIds.has(peer.id));
    const waiting = peers.find((peer) => !connectedIds.has(peer.id));
    assert.ok(leaving && waiting, 'one peer is connected and one is waiting for a slot');

    // Walk the connected peer far away: exactly one disconnect per endpoint.
    // Listen BEFORE the move: peer:disconnect is emitted during the sync, i.e.
    // before the user:moved broadcast that moveTo() waits for.
    const gonePromise = waitEvent(hub.socket, 'peer:disconnect', (event) => event.peerId === leaving.id, 6000);
    const reclaimedPromise = waitEvent(hub.socket, 'peer:connect', (event) => event.peerId === waiting.id, 10000);
    await moveTo(leaving, hub, 1600, 500);
    const gone = await gonePromise;
    assert.ok(Number.isInteger(gone.generation));
    await delay(1200);
    assert.equal(hubDisconnects.filter((event) => event.peerId === leaving.id).length, 1, 'one disconnect, never two');

    // The hub is on instance A, the removal happened on B (the moving peer's
    // node): the cross-instance reclaim must still fill the freed slot.
    const reclaimed = await reclaimedPromise;
    assert.ok(reclaimed.generation >= 1);
    assert.equal((await degreeInRedis(cluster, hub.id)), CAP, 'the hub is back at the cap across instances');
  } finally {
    for (const peer of peers) peer.socket.close();
    await cluster.close();
  }
});

test('the whole run leaves zero Redis keys behind', skipOpts, async () => {
  const cluster = await makeCluster();
  try {
    const hub = await joinOn(cluster, 0, cluster.room, 'Hub');
    const peer = await joinOn(cluster, 1, cluster.room, 'Peer');
    await moveTo(hub, peer, 500, 500);
    const connected = waitEvent(hub.socket, 'peer:connect', (event) => event.peerId === peer.id, 6000);
    await moveTo(peer, hub, 550, 500);
    await connected;
    assert.ok((await degreeInRedis(cluster, hub.id)) >= 1);

    hub.socket.close();
    peer.socket.close();
    await delay(600);
    const keys = await cluster.nodeA.io.edgeStore.scanKeys(`${cluster.keyPrefix}:*`);
    assert.deepEqual(keys, [], 'every edge / generation / user set key is removed on disconnect');
  } finally {
    await cluster.close();
  }
});

test('orphan sweep and reconcile respect the cap and the drop radius across instances', skipOpts, async () => {
  const cluster = await makeCluster();
  const members = [];
  try {
    const hub = await joinOn(cluster, 0, cluster.room, 'Hub');
    members.push(hub);
    const layout = [
      { x: 560, y: 500 },
      { x: 430, y: 500 },
      { x: 500, y: 410 },
    ];
    for (let index = 0; index < layout.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      const member = await joinOn(cluster, 1, cluster.room, `P${index}`);
      member.target = layout[index];
      members.push(member);
    }

    await moveTo(hub, members[1], 500, 500);
    for (const member of members.slice(1)) {
      // eslint-disable-next-line no-await-in-loop
      await moveTo(member, hub, member.target.x, member.target.y);
    }
    await delay(1200);

    // Pick a peer that really holds an edge to the hub and "kill -9" it: the
    // presence row disappears without any disconnect handler running.
    const hubEdges = await cluster.nodeA.io.edgeStore.edgesOf(hub.id);
    const victimId = hubEdges.length ? (hubEdges[0].a === hub.id ? hubEdges[0].b : hubEdges[0].a) : null;
    assert.ok(victimId, 'the hub holds at least one edge');
    cluster.backing.rows.delete(victimId);

    const swept = await sweepOrphanEdges(cluster.nodeA.io, {
      edgeStore: cluster.nodeA.io.edgeStore,
      presenceModel: cluster.backing.presenceModel,
    });
    assert.ok(swept.removedEdges >= 1, 'the dead peer\'s edges were removed');
    const afterSweep = await cluster.nodeA.io.edgeStore.edgesOf(hub.id);
    assert.equal(afterSweep.some((edge) => edge.a === victimId || edge.b === victimId), false);

    // Reconcile on both instances must not create a beyond-cap or out-of-range edge.
    await cluster.nodeA.io.peerGraph.reconcileLocalUsers();
    await cluster.nodeB.io.peerGraph.reconcileLocalUsers();
    await cluster.nodeA.io.peerGraph.drainSyncs();
    await cluster.nodeB.io.peerGraph.drainSyncs();

    const allEdges = await cluster.nodeA.io.edgeStore.allEdges(cluster.room);
    for (const edge of allEdges) {
      const a = cluster.backing.rows.get(edge.a);
      const b = cluster.backing.rows.get(edge.b);
      if (!a || !b) continue;
      assert.ok(
        Math.hypot(a.x - b.x, a.y - b.y) <= DROP,
        `reconcile kept/created an edge beyond the drop radius: ${a.sessionId.slice(0, 5)}<->${b.sessionId.slice(0, 5)}`,
      );
    }
    for (const member of members) {
      if (member.id === victimId) continue;
      // eslint-disable-next-line no-await-in-loop
      const degree = (await cluster.nodeA.io.edgeStore.edgesOf(member.id)).length;
      assert.ok(degree <= CAP, `${member.joined.selfId.slice(0, 5)} degree ${degree} exceeds cap ${CAP}`);
    }
  } finally {
    for (const member of members) member.socket.close();
    await cluster.close();
  }
});
