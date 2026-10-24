/**
 * Two-instance Redis scaling integration, race, sweep, crash-recovery, leak,
 * CLI scale-check, and 50-user overhead benchmark suite (Week 3, Day 12).
 *
 * Runs against a real `redis-server` process via `REDIS_URL_TEST`:
 *   REDIS_URL_TEST="redis://127.0.0.1:6379" npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { cleanupOnBoot, cleanupStale } from '../src/services/presenceCleanup.js';
import { sweepOrphanEdges } from '../src/services/edgeSweep.js';
import { runScaleCheck } from '../scripts/scale-check.js';
import {
  connectTestClient,
  createMemoryLogger,
  createSharedClusterBacking,
  delay,
  startClusterNode,
  waitEvent,
} from './helpers/twoInstanceHarness.js';

const REDIS_URL_TEST = (process.env.REDIS_URL_TEST ?? '').trim();

if (!REDIS_URL_TEST) {
  console.error([
    '# =====================================================================',
    '#  Day 12 two-instance Redis integration suite: NOT VERIFIED',
    '#  REDIS_URL_TEST is unset. Start Redis and re-run:',
    '#    REDIS_URL_TEST="redis://127.0.0.1:6379" npm test',
    '# =====================================================================',
  ].join('\n'));
}

const skipOpts = REDIS_URL_TEST
  ? {}
  : { skip: 'NOT VERIFIED — set REDIS_URL_TEST="redis://127.0.0.1:6379" to run two-instance suite' };

let suiteSeq = 0;
async function makeTwoNodeCluster() {
  suiteSeq += 1;
  const keyPrefix = `day12_int_${process.pid}_${suiteSeq}`;
  const backing = createSharedClusterBacking();
  const nodeA = await startClusterNode({
    instanceId: `node-a-${suiteSeq}`,
    redisUrl: REDIS_URL_TEST,
    keyPrefix,
    backing,
  });
  const nodeB = await startClusterNode({
    instanceId: `node-b-${suiteSeq}`,
    redisUrl: REDIS_URL_TEST,
    keyPrefix,
    backing,
  });
  return {
    keyPrefix,
    backing,
    nodeA,
    nodeB,
    async close() {
      const keys = await nodeA.io.edgeStore.scanKeys(`${keyPrefix}:*`).catch(() => []);
      if (keys.length) await nodeA.redis.storeClient.del(...keys).catch(() => {});
      await nodeA.close();
      await nodeB.close();
    },
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

test('two-instance live runScaleCheck passes all 8 checks and exits cleanly', skipOpts, async (t) => {
  const cluster = await makeTwoNodeCluster();
  t.after(() => cluster.close());

  const report = await runScaleCheck({
    urlA: cluster.nodeA.baseUrl,
    urlB: cluster.nodeB.baseUrl,
    roomId: 'lobby',
    logger: createMemoryLogger(),
  });
  assert.equal(report.ok, true, report.lines.join('\n'));
  assert.equal(report.checks.length, 8);
  assert.ok(report.checks.every((c) => c.ok));
  assert.match(report.checks[4].detail, /candidate/, 'scale-check must await a valid cross-instance ICE candidate');
});

test('cross-instance signal validation refuses unjoined, unknown/far peer, stale generation, spoofed sender, oversized SDP, and rate flood without dropping socket', skipOpts, async (t) => {
  const cluster = await makeTwoNodeCluster();
  t.after(() => cluster.close());

  const unjoined = await connectTestClient(cluster.nodeA.baseUrl);
  const alice = await connectTestClient(cluster.nodeA.baseUrl);
  const bob = await connectTestClient(cluster.nodeB.baseUrl);
  const farPeer = await connectTestClient(cluster.nodeB.baseUrl);
  t.after(() => {
    for (const s of [unjoined, alice, bob, farPeer]) s.close();
  });

  // 1. Unjoined sender rejected with `not_joined`
  const unjoinedErr = waitEvent(unjoined, 'error');
  unjoined.emit('signal', {
    to: 'someone',
    generation: 1,
    data: { type: 'offer', sdp: 'v=0\r\n' },
  });
  assert.equal((await unjoinedErr).code, 'not_joined');

  const [jAlice, jBob, jFar] = await Promise.all([
    (alice.emit('join', { roomId: 'lobby', name: 'Alice' }), waitEvent(alice, 'joined')),
    (bob.emit('join', { roomId: 'lobby', name: 'Bob' }), waitEvent(bob, 'joined')),
    (farPeer.emit('join', { roomId: 'lobby', name: 'Far' }), waitEvent(farPeer, 'joined')),
  ]);

  const edgeConnect = Promise.all([
    waitEvent(alice, 'peer:connect', (c) => c.peerId === jBob.selfId),
    waitEvent(bob, 'peer:connect', (c) => c.peerId === jAlice.selfId),
  ]);
  alice.emit('move', { x: 200, y: 200 });
  bob.emit('move', { x: 240, y: 200 });
  farPeer.emit('move', { x: 1500, y: 1500 });
  const [aEdge] = await edgeConnect;
  await delay(60);

  // 2. Far peer with no edge refused with `no_peer_edge`
  const farErr = waitEvent(alice, 'error');
  alice.emit('signal', {
    to: jFar.selfId,
    generation: 1,
    data: { type: 'offer', sdp: 'v=0\r\n' },
  });
  assert.equal((await farErr).code, 'no_peer_edge');

  // 3. Spoofed `from` field refused with `invalid_payload`
  const spoofErr = waitEvent(alice, 'error');
  alice.emit('signal', {
    from: jFar.selfId,
    to: jBob.selfId,
    generation: aEdge.generation,
    data: { type: 'offer', sdp: 'v=0\r\n' },
  });
  assert.equal((await spoofErr).code, 'invalid_payload');

  // 4. Stale generation refused with `stale_generation`
  const staleErr = waitEvent(alice, 'error');
  alice.emit('signal', {
    to: jBob.selfId,
    generation: aEdge.generation + 1,
    data: { type: 'offer', sdp: 'v=0\r\n' },
  });
  assert.equal((await staleErr).code, 'stale_generation');

  // 5. Oversized SDP refused without killing socket
  const hugeErr = waitEvent(alice, 'error');
  alice.emit('signal', {
    to: jBob.selfId,
    generation: aEdge.generation,
    data: { type: 'offer', sdp: `v=0\r\n${'a'.repeat(70_000)}` },
  });
  assert.equal((await hugeErr).code, 'invalid_payload');
  assert.equal(alice.connected, true);

  // 6. Cross-instance ICE candidate still delivers cleanly after all refusals
  const iceDelivered = waitEvent(bob, 'signal', (s) => s.from === jAlice.selfId);
  alice.emit('signal', {
    to: jBob.selfId,
    generation: aEdge.generation,
    data: {
      type: 'candidate',
      candidate: { candidate: 'candidate:1 1 UDP 2122252543 10.0.0.1 54000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    },
  });
  const gotIce = await iceDelivered;
  assert.equal(gotIce.generation, aEdge.generation);
});

test('200 simultaneous cross-instance boundary crossings emit ONE peer:connect per side with deterministic initiator and matching generation', skipOpts, async (t) => {
  const cluster = await makeTwoNodeCluster();
  t.after(() => cluster.close());

  const pairs = [];
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const left = await connectTestClient(cluster.nodeA.baseUrl);
    // eslint-disable-next-line no-await-in-loop
    const right = await connectTestClient(cluster.nodeB.baseUrl);
    const leftEvents = [];
    const rightEvents = [];
    const leftDiscs = [];
    const rightDiscs = [];
    left.on('peer:connect', (e) => leftEvents.push(e));
    right.on('peer:connect', (e) => rightEvents.push(e));
    left.on('peer:disconnect', (e) => leftDiscs.push(e));
    right.on('peer:disconnect', (e) => rightDiscs.push(e));

    // eslint-disable-next-line no-await-in-loop
    const [jl, jr] = await Promise.all([
      (left.emit('join', { roomId: 'lobby', name: `L${i}` }), waitEvent(left, 'joined')),
      (right.emit('join', { roomId: 'lobby', name: `R${i}` }), waitEvent(right, 'joined')),
    ]);
    // Ten real, unclamped lanes in the 1080px world. 120px separation is
    // beyond the 115px drop radius, so pairs cannot interfere via hysteresis.
    const laneY = i * 120;
    left.emit('move', { x: 100, y: laneY });
    right.emit('move', { x: 500, y: laneY });
    pairs.push({ i, laneY, left, right, idL: jl.selfId, idR: jr.selfId, leftEvents, rightEvents, leftDiscs, rightDiscs });
  }
  t.after(() => {
    for (const p of pairs) {
      p.left.close();
      p.right.close();
    }
  });
  await delay(120);
  for (const p of pairs) {
    p.leftEvents.length = 0;
    p.rightEvents.length = 0;
  }

  // Move all 10 pairs into range at once AND fire 200 concurrent sync calls across BOTH instances!
  for (const p of pairs) {
    p.left.emit('move', { x: 260, y: p.laneY });
    p.right.emit('move', { x: 300, y: p.laneY });
  }
  await delay(40);
  await Promise.all(
    Array.from({ length: 200 }, (_, k) => {
      const p = pairs[k % pairs.length];
      return k % 2 === 0
        ? cluster.nodeA.io.peerGraph.sync('lobby', p.idL)
        : cluster.nodeB.io.peerGraph.sync('lobby', p.idR);
    }),
  );
  await delay(120);

  for (const p of pairs) {
    const lForR = p.leftEvents.filter((e) => e.peerId === p.idR);
    const rForL = p.rightEvents.filter((e) => e.peerId === p.idL);
    assert.equal(lForR.length, 1, `pair ${p.i} left received ${lForR.length} connects`);
    assert.equal(rForL.length, 1, `pair ${p.i} right received ${rForL.length} connects`);
    assert.equal(lForR[0].generation, 1);
    assert.equal(rForL[0].generation, 1);
    const expectedInitiator = p.idL < p.idR ? p.idL : p.idR;
    assert.equal(lForR[0].initiator, p.idL === expectedInitiator);
    assert.equal(rForL[0].initiator, p.idR === expectedInitiator);
  }

  // Now move apart simultaneously across both instances -> 1 peer:disconnect per side!
  for (const p of pairs) {
    p.left.emit('move', { x: 80, y: p.laneY });
    p.right.emit('move', { x: 600, y: p.laneY });
  }
  await delay(40);
  await Promise.all(
    Array.from({ length: 200 }, (_, k) => {
      const p = pairs[k % pairs.length];
      return k % 2 === 0
        ? cluster.nodeA.io.peerGraph.sync('lobby', p.idL)
        : cluster.nodeB.io.peerGraph.sync('lobby', p.idR);
    }),
  );
  await delay(120);

  for (const p of pairs) {
    assert.equal(p.leftDiscs.filter((e) => e.peerId === p.idR).length, 1);
    assert.equal(p.rightDiscs.filter((e) => e.peerId === p.idL).length, 1);
  }
});

test('cross-instance presence sweep expires remote socket via raw transport close, emits once, auto-reconnects, and rejoins cleanly', skipOpts, async (t) => {
  const cluster = await makeTwoNodeCluster();
  t.after(() => cluster.close());

  // Verify cleanupOnBoot deletes ONLY its own instanceId rows
  const clientU = await connectTestClient(cluster.nodeA.baseUrl, { reconnection: true, reconnectionDelay: 30 });
  const clientV = await connectTestClient(cluster.nodeB.baseUrl);
  t.after(() => {
    clientU.close();
    clientV.close();
  });

  const [ju1, jv] = await Promise.all([
    (clientU.emit('join', { roomId: 'lobby', name: 'SweepUserU' }), waitEvent(clientU, 'joined')),
    (clientV.emit('join', { roomId: 'lobby', name: 'SurvivorV' }), waitEvent(clientV, 'joined')),
  ]);

  await cleanupOnBoot('other-crashed-node', {
    presenceModel: cluster.backing.presenceModel,
    multiInstance: true,
  });
  assert.equal(cluster.backing.rows.size, 2, 'boot cleanup never deletes another live instance rows');

  // Connect U & V within 40 px across instances
  const initialConnect = Promise.all([
    waitEvent(clientU, 'peer:connect', (c) => c.peerId === jv.selfId),
    waitEvent(clientV, 'peer:connect', (c) => c.peerId === ju1.selfId),
  ]);
  clientU.emit('move', { x: 300, y: 300 });
  clientV.emit('move', { x: 340, y: 300 });
  await initialConnect;

  const vLeftEvents = [];
  const vDiscEvents = [];
  clientV.on('user:left', (e) => vLeftEvents.push(e));
  clientV.on('peer:disconnect', (e) => vDiscEvents.push(e));

  const disconnectReasonPromise = new Promise((resolve) => {
    clientU.once('disconnect', (reason) => resolve(reason));
  });
  const autoReconnectedPromise = waitEvent(clientU, 'connect', () => true, 4000);

  // Age U's lastSeen past timeout and run cleanupStale CONCURRENTLY on BOTH instances!
  cluster.backing.rows.get(ju1.selfId).lastSeen = new Date(Date.now() - 120_000);
  await Promise.all([
    cleanupStale(cluster.nodeA.io, {
      instanceId: cluster.nodeA.instanceId,
      presenceModel: cluster.backing.presenceModel,
      timeoutMs: 30_000,
    }),
    cleanupStale(cluster.nodeB.io, {
      instanceId: cluster.nodeB.instanceId,
      presenceModel: cluster.backing.presenceModel,
      timeoutMs: 30_000,
    }),
  ]);

  const disconnectReason = await disconnectReasonPromise;
  assert.equal(
    disconnectReason,
    'transport close',
    'remote expiry closed raw Engine.IO transport (never socket.disconnect(true))',
  );

  // Client U automatically reconnects and recovers session by re-emitting join
  await autoReconnectedPromise;
  const rejoinConnectOnV = waitEvent(clientV, 'peer:connect', (c) => c.name === 'SweepUserU');
  const ju2Promise = waitEvent(clientU, 'joined');
  clientU.emit('join', { roomId: 'lobby', name: 'SweepUserU' });
  const ju2 = await ju2Promise;
  clientU.emit('move', { x: 310, y: 300 });
  await rejoinConnectOnV;
  await delay(100);

  assert.notEqual(ju2.selfId, ju1.selfId, 'reconnected socket receives a fresh session selfId');
  assert.equal(vLeftEvents.filter((e) => e.id === ju1.selfId).length, 1, 'user:left emitted ONCE');
  assert.equal(vDiscEvents.filter((e) => e.peerId === ju1.selfId).length, 1, 'peer:disconnect emitted ONCE');
  assert.equal(cluster.backing.rows.size, 2, 'zero duplicate presence documents after rejoin');
});

test('hard crash (kill -9) orphan edges are swept via SCAN (never KEYS), notifying survivor ONCE and leaving 0 orphan keys', skipOpts, async () => {
  suiteSeq += 1;
  const keyPrefix = `day12_crash_${process.pid}_${suiteSeq}`;
  const backing = createSharedClusterBacking();
  const nodeCrash = await startClusterNode({
    instanceId: 'crash-node',
    redisUrl: REDIS_URL_TEST,
    keyPrefix,
    backing,
  });
  const nodeSurvive1 = await startClusterNode({
    instanceId: 'survive-1',
    redisUrl: REDIS_URL_TEST,
    keyPrefix,
    backing,
  });
  const nodeSurvive2 = await startClusterNode({
    instanceId: 'survive-2',
    redisUrl: REDIS_URL_TEST,
    keyPrefix,
    backing,
  });

  // Instrument store clients to forbid `KEYS` at runtime
  let keysCalls = 0;
  let scanCalls = 0;
  for (const node of [nodeSurvive1, nodeSurvive2]) {
    const origKeys = node.redis.storeClient.keys.bind(node.redis.storeClient);
    node.redis.storeClient.keys = (...args) => {
      keysCalls += 1;
      return origKeys(...args);
    };
    const origScan = node.redis.storeClient.scan.bind(node.redis.storeClient);
    node.redis.storeClient.scan = (...args) => {
      scanCalls += 1;
      return origScan(...args);
    };
  }

  const doomed = await connectTestClient(nodeCrash.baseUrl);
  const survivor = await connectTestClient(nodeSurvive1.baseUrl);

  try {
    const [jDoomed, jSurvivor] = await Promise.all([
      (doomed.emit('join', { roomId: 'lobby', name: 'Doomed' }), waitEvent(doomed, 'joined')),
      (survivor.emit('join', { roomId: 'lobby', name: 'Survivor' }), waitEvent(survivor, 'joined')),
    ]);

    const connected = Promise.all([
      waitEvent(doomed, 'peer:connect', (c) => c.peerId === jSurvivor.selfId),
      waitEvent(survivor, 'peer:connect', (c) => c.peerId === jDoomed.selfId),
    ]);
    doomed.emit('move', { x: 400, y: 400 });
    survivor.emit('move', { x: 430, y: 400 });
    await connected;

    const survivorDiscs = [];
    survivor.on('peer:disconnect', (d) => survivorDiscs.push(d));

    // Simulate OS `kill -9` on `nodeCrash` + boot cleanup of `crash-node` presence
    await nodeCrash.killAbruptly();
    doomed.close();
    await cleanupOnBoot('crash-node', { presenceModel: backing.presenceModel, multiInstance: true });

    assert.equal((await nodeSurvive1.io.edgeStore.allEdges()).length, 1, 'orphan edge remains in Redis right after SIGKILL');

    // Run orphan sweep concurrently across BOTH surviving nodes!
    await Promise.all([
      sweepOrphanEdges(nodeSurvive1.io, { presenceModel: backing.presenceModel }),
      sweepOrphanEdges(nodeSurvive2.io, { presenceModel: backing.presenceModel }),
    ]);
    await delay(100);

    assert.equal(keysCalls, 0, 'Redis KEYS command was never invoked');
    assert.ok(scanCalls > 0, 'Redis SCAN command was used to discover orphan keys');
    assert.equal(
      survivorDiscs.filter((d) => d.peerId === jDoomed.selfId).length,
      1,
      'surviving peer notified ONCE of crashed peer removal',
    );
    // The live survivor legitimately owns a position-revision key. Leave before
    // asserting that the whole namespace is empty, not merely orphan-free.
    survivor.close();
    await delay(100);
    assert.equal(await nodeSurvive1.io.edgeStore.countStoreKeys(), 0, 'zero Redis keys remain after both users leave');
  } finally {
    doomed.close();
    survivor.close();
    await nodeSurvive1.close();
    await nodeSurvive2.close();
  }
});

test('50 cross-instance join/connect/signal/leave cycles leave ZERO leaked Redis keys, sockets, rooms, or caches', skipOpts, async (t) => {
  const cluster = await makeTwoNodeCluster();
  t.after(() => cluster.close());

  for (let cycle = 0; cycle < 50; cycle += 1) {
    // eslint-disable-next-line no-await-in-loop
    const cA = await connectTestClient(cluster.nodeA.baseUrl);
    // eslint-disable-next-line no-await-in-loop
    const cB = await connectTestClient(cluster.nodeB.baseUrl);

    // eslint-disable-next-line no-await-in-loop
    const [jA, jB] = await Promise.all([
      (cA.emit('join', { roomId: 'lobby', name: `CycleA_${cycle}` }), waitEvent(cA, 'joined')),
      (cB.emit('join', { roomId: 'lobby', name: `CycleB_${cycle}` }), waitEvent(cB, 'joined')),
    ]);

    const connected = Promise.all([
      waitEvent(cA, 'peer:connect', (c) => c.peerId === jB.selfId),
      waitEvent(cB, 'peer:connect', (c) => c.peerId === jA.selfId),
    ]);
    cA.emit('move', { x: 250, y: 250 });
    cB.emit('move', { x: 280, y: 250 });
    // eslint-disable-next-line no-await-in-loop
    const [edgeA] = await connected;

    const relayed = waitEvent(cB, 'signal', (s) => s.from === jA.selfId);
    cA.emit('signal', {
      to: jB.selfId,
      generation: edgeA.generation,
      data: { type: 'offer', sdp: 'v=0\r\n' },
    });
    // eslint-disable-next-line no-await-in-loop
    await relayed;

    cA.disconnect();
    cB.disconnect();
    // eslint-disable-next-line no-await-in-loop
    await Promise.all([cluster.nodeA.io.drainSessions(), cluster.nodeB.io.drainSessions()]);
  }
  await delay(80);

  const counts = {
    cycles: 50,
    redisStoreKeys: await cluster.nodeA.io.edgeStore.countStoreKeys(),
    presenceRows: cluster.backing.rows.size,
    nodeASockets: cluster.nodeA.io.sockets.sockets.size,
    nodeBSockets: cluster.nodeB.io.sockets.sockets.size,
    nodeAPeerRooms: cluster.nodeA.io.peerGraph.rooms.size,
    nodeBPeerRooms: cluster.nodeB.io.peerGraph.rooms.size,
    nodeARemoteNames: cluster.nodeA.io.peerGraph.remoteNames.size,
    nodeBRemoteNames: cluster.nodeB.io.peerGraph.remoteNames.size,
    nodeAPendingSyncs: cluster.nodeA.io.peerGraph.pendingSyncs.size,
    nodeBPendingSyncs: cluster.nodeB.io.peerGraph.pendingSyncs.size,
  };
  t.diagnostic(`50-cycle leak audit counts: ${JSON.stringify(counts)}`);

  assert.equal(counts.redisStoreKeys, 0);
  assert.equal(counts.presenceRows, 0);
  assert.equal(counts.nodeASockets, 0);
  assert.equal(counts.nodeBSockets, 0);
  assert.equal(counts.nodeAPeerRooms, 0);
  assert.equal(counts.nodeBPeerRooms, 0);
  assert.equal(counts.nodeARemoteNames, 0);
  assert.equal(counts.nodeBRemoteNames, 0);
  assert.equal(counts.nodeAPendingSyncs, 0);
  assert.equal(counts.nodeBPendingSyncs, 0);
});

test('50-user single-instance vs two-instance Redis move & signal round-trip latency benchmark', skipOpts, async (t) => {
  async function measureScenario(mode) {
    const backing = createSharedClusterBacking();
    const keyPrefix = `bench_${process.pid}_${mode}`;
    const node1 = await startClusterNode({
      instanceId: `${mode}-1`,
      redisUrl: mode === 'redis' ? REDIS_URL_TEST : '',
      keyPrefix,
      backing,
    });
    const node2 = mode === 'redis'
      ? await startClusterNode({
          instanceId: `${mode}-2`,
          redisUrl: REDIS_URL_TEST,
          keyPrefix,
          backing,
        })
      : null;

    const clients = [];
    try {
      // Spawn 50 real WebSocket avatars distributed across the active server(s)
      for (let i = 0; i < 50; i += 1) {
        const target = node2 && i % 2 === 1 ? node2.baseUrl : node1.baseUrl;
        // eslint-disable-next-line no-await-in-loop
        const sock = await connectTestClient(target);
        // eslint-disable-next-line no-await-in-loop
        const joined = await (sock.emit('join', { roomId: 'lobby', name: `U${i}` }), waitEvent(sock, 'joined'));
        const col = i % 10;
        const row = Math.floor(i / 10);
        sock.emit('move', { x: 100 + col * 150, y: 100 + row * 150 });
        clients.push({ sock, id: joined.selfId, x: 100 + col * 150, y: 100 + row * 150 });
      }
      await delay(150);

      // Pair clients[0] (node1) and clients[1] (node2 in redis mode) within 40 px
      const pairConnect = Promise.all([
        waitEvent(clients[0].sock, 'peer:connect', (c) => c.peerId === clients[1].id),
        waitEvent(clients[1].sock, 'peer:connect', (c) => c.peerId === clients[0].id),
      ]);
      clients[0].sock.emit('move', { x: 100, y: 100 });
      clients[1].sock.emit('move', { x: 140, y: 100 });
      const [edge0] = await pairConnect;

      // Measure 60 end-to-end `move -> user:moved` round-trips in a 50-user room
      const moveSamples = [];
      for (let step = 0; step < 60; step += 1) {
        const mover = clients[step % 20];
        const observer = clients[1];
        if (mover.id === observer.id) continue;
        const nextX = mover.x + (step % 2 === 0 ? 12 : -12);
        mover.x = nextX;
        const t0 = performance.now();
        const delivered = waitEvent(observer.sock, 'user:moved', (m) => m.id === mover.id);
        mover.sock.emit('move', { x: nextX, y: mover.y });
        // eslint-disable-next-line no-await-in-loop
        await delivered;
        moveSamples.push(performance.now() - t0);
      }

      // Measure 60 end-to-end WebRTC `signal -> signal` relays between client[0] & client[1]
      const signalSamples = [];
      for (let s = 0; s < 60; s += 1) {
        const t0 = performance.now();
        const got = waitEvent(clients[1].sock, 'signal', (ev) => ev.from === clients[0].id);
        clients[0].sock.emit('signal', {
          to: clients[1].id,
          generation: edge0.generation,
          data: {
            type: 'candidate',
            candidate: { candidate: `candidate:${s} 1 UDP 2122252543 10.0.0.2 ${50000 + s} typ host`, sdpMid: '0', sdpMLineIndex: 0 },
          },
        });
        // eslint-disable-next-line no-await-in-loop
        await got;
        signalSamples.push(performance.now() - t0);
      }

      moveSamples.sort((a, b) => a - b);
      signalSamples.sort((a, b) => a - b);
      return {
        move: {
          p50: Number(percentile(moveSamples, 50).toFixed(3)),
          p95: Number(percentile(moveSamples, 95).toFixed(3)),
          max: Number(moveSamples[moveSamples.length - 1].toFixed(3)),
        },
        signal: {
          p50: Number(percentile(signalSamples, 50).toFixed(3)),
          p95: Number(percentile(signalSamples, 95).toFixed(3)),
          max: Number(signalSamples[signalSamples.length - 1].toFixed(3)),
        },
      };
    } finally {
      for (const c of clients) c.sock.close();
      if (node2) {
        const keys = await node1.io.edgeStore.scanKeys(`${keyPrefix}:*`).catch(() => []);
        if (keys.length) await node1.redis.storeClient.del(...keys).catch(() => {});
        await node2.close();
      }
      await node1.close();
    }
  }

  const single = await measureScenario('single');
  const redis = await measureScenario('redis');
  const summary = {
    users: 50,
    single,
    redis,
    overheadMs: {
      moveP50: Number((redis.move.p50 - single.move.p50).toFixed(3)),
      moveP95: Number((redis.move.p95 - single.move.p95).toFixed(3)),
      signalP50: Number((redis.signal.p50 - single.signal.p50).toFixed(3)),
      signalP95: Number((redis.signal.p95 - single.signal.p95).toFixed(3)),
    },
  };
  t.diagnostic(`50-user benchmark results: ${JSON.stringify(summary)}`);

  assert.ok(redis.move.p95 < 100, `expected 50-user Redis move p95 < 100ms, got ${redis.move.p95}ms`);
  assert.ok(redis.signal.p95 < 50, `expected 50-user Redis signal p95 < 50ms, got ${redis.signal.p95}ms`);
});
