/**
 * Real Socket.io tests for room layout live sync (Week 4 - Room Persistence).
 *
 * Tests:
 *  - Two clients in the same room receive room:layout after a save.
 *  - A client in another room receives nothing.
 *  - A client joining after the save gets the new obstacles and layoutRevision in `joined`.
 *  - Two real server instances with real Redis: a save through instance A reaches clients on
 *    instance B and B's cache is invalidated.
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
import { notifyLayoutBroadcast } from '../src/services/roomService.js';

const REDIS_URL_TEST = (process.env.REDIS_URL_TEST ?? '').trim();

let testSeq = 0;

test('two clients in the same room receive room:layout, client in other room receives nothing, and subsequent join gets updated layout', async () => {
  testSeq += 1;
  const roomA = `sync_room_a_${testSeq}`;
  const roomB = `sync_room_b_${testSeq}`;
  const backing = createSharedClusterBacking({ roomIds: [roomA, roomB] });

  const node = await startClusterNode({
    instanceId: `node-single-${testSeq}`,
    backing,
  });

  const client1 = await connectTestClient(node.baseUrl);
  const client2 = await connectTestClient(node.baseUrl);
  const clientOther = await connectTestClient(node.baseUrl);

  // Client 1 & 2 join room A
  client1.emit('join', { roomId: roomA, name: 'Alice' });
  const joined1 = await waitEvent(client1, 'joined');
  assert.equal(joined1.room.roomId, roomA);
  assert.equal(joined1.room.layoutRevision, 1);

  client2.emit('join', { roomId: roomA, name: 'Bob' });
  const joined2 = await waitEvent(client2, 'joined');
  assert.equal(joined2.room.roomId, roomA);
  assert.equal(joined2.room.layoutRevision, 1);

  // Client Other joins room B
  clientOther.emit('join', { roomId: roomB, name: 'Charlie' });
  await waitEvent(clientOther, 'joined');

  // Track events
  let otherReceived = null;
  clientOther.on('room:layout', (payload) => {
    otherReceived = payload;
  });

  const newObstacles = [
    {
      id: 'custom-wall-sync',
      type: 'wall',
      x: 100,
      y: 100,
      w: 80,
      h: 20,
      blocksAudio: true,
      attenuation: 0.15,
    },
  ];

  // Perform save layout on room A
  const p1 = waitEvent(client1, 'room:layout');
  const p2 = waitEvent(client2, 'room:layout');

  const saved = await backing.rooms.saveLayout(
    roomA,
    { expectedRevision: 1, obstacles: newObstacles },
    { io: node.io },
  );
  assert.equal(saved.layoutRevision, 2);

  const [ev1, ev2] = await Promise.all([p1, p2]);

  assert.equal(ev1.roomId, roomA);
  assert.equal(ev1.layoutRevision, 2);
  assert.deepEqual(ev1.obstacles, newObstacles);

  assert.equal(ev2.roomId, roomA);
  assert.equal(ev2.layoutRevision, 2);
  assert.deepEqual(ev2.obstacles, newObstacles);

  // Give short grace period to verify clientOther received nothing
  await delay(100);
  assert.equal(otherReceived, null, 'Client in another room must receive nothing');

  // Client 3 joins room A after the save
  const client3 = await connectTestClient(node.baseUrl);
  client3.emit('join', { roomId: roomA, name: 'Dave' });
  const joined3 = await waitEvent(client3, 'joined');

  assert.equal(joined3.room.roomId, roomA);
  assert.equal(joined3.room.layoutRevision, 2);
  assert.deepEqual(joined3.room.obstacles, newObstacles);

  client1.close();
  client2.close();
  client3.close();
  clientOther.close();
  await node.close();
});

const skipRedis = REDIS_URL_TEST
  ? {}
  : { skip: 'NOT VERIFIED — set REDIS_URL_TEST="redis://127.0.0.1:6379" to run cross-instance Redis layout sync test' };

test(
  'two real server instances with real Redis: save through instance A reaches clients on instance B and B cache is invalidated',
  skipRedis,
  async () => {
    testSeq += 1;
    const keyPrefix = `redis_layout_${process.pid}_${testSeq}`;
    const roomId = `redis_room_${testSeq}`;
    const backing = createSharedClusterBacking({ roomIds: [roomId] });

    let bInvalidated = false;
    backing.rooms.invalidateCache = (id) => {
      if (id === roomId) bInvalidated = true;
    };

    const nodeA = await startClusterNode({
      instanceId: `node-a-${testSeq}`,
      redisUrl: REDIS_URL_TEST,
      keyPrefix,
      backing,
    });

    const nodeB = await startClusterNode({
      instanceId: `node-b-${testSeq}`,
      redisUrl: REDIS_URL_TEST,
      keyPrefix,
      backing,
    });

    // Client connects to instance B
    const clientOnB = await connectTestClient(nodeB.baseUrl);
    clientOnB.emit('join', { roomId, name: 'PeerOnB' });
    const joinedOnB = await waitEvent(clientOnB, 'joined');
    assert.equal(joinedOnB.room.layoutRevision, 1);

    const newObstacles = [
      {
        id: 'cross-node-wall',
        type: 'wall',
        x: 50,
        y: 50,
        w: 60,
        h: 30,
        blocksAudio: true,
        attenuation: 0.2,
      },
    ];

    const layoutPromise = waitEvent(clientOnB, 'room:layout');

    // Save layout through instance A!
    await backing.rooms.saveLayout(
      roomId,
      { expectedRevision: 1, obstacles: newObstacles },
      { io: nodeA.io },
    );

    // Client on instance B receives broadcast via Redis adapter!
    const broadcastReceived = await layoutPromise;
    assert.equal(broadcastReceived.roomId, roomId);
    assert.equal(broadcastReceived.layoutRevision, 2);
    assert.deepEqual(broadcastReceived.obstacles, newObstacles);

    // Give time for serverSideEmit to propagate to node B
    await delay(150);
    assert.equal(bInvalidated, true, "Instance B's cache should be invalidated");

    // A fresh client joins on node B after save: gets new revision 2
    const clientLate = await connectTestClient(nodeB.baseUrl);
    clientLate.emit('join', { roomId, name: 'LatePeerOnB' });
    const joinedLate = await waitEvent(clientLate, 'joined');
    assert.equal(joinedLate.room.layoutRevision, 2);
    assert.deepEqual(joinedLate.room.obstacles, newObstacles);

    clientOnB.close();
    clientLate.close();
    await nodeA.close();
    await nodeB.close();
  },
);
