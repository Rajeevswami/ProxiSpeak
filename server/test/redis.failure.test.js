/**
 * Redis resilience, security redaction, TLS (`rediss://`), boot fallback,
 * mid-run outage (`scaleMode: "redis-degraded"`), and automatic recovery
 * reconciliation tests (Week 3, Day 12).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { connectRedis, createScaleState, redactRedisUrl } from '../src/db/redis.js';
import { redactEndpointUrl, scrubUrlsInText } from '../scripts/scale-check.js';
import {
  connectTestClient,
  createMemoryLogger,
  createSharedClusterBacking,
  delay,
  getFreePort,
  spawnEphemeralRedisServer,
  startClusterNode,
  startRedisTlsTunnel,
  waitEvent,
} from './helpers/twoInstanceHarness.js';

const REDIS_URL_TEST = (process.env.REDIS_URL_TEST ?? '').trim();
const skipWithoutRedis = REDIS_URL_TEST
  ? false
  : 'NOT VERIFIED — set REDIS_URL_TEST="redis://127.0.0.1:6379" to run live Redis TLS & crash/recovery tests';

test('credential redaction strips usernames, passwords and tokens across redis://, rediss://, http:// and malformed URLs', () => {
  assert.equal(redactRedisUrl(''), '<empty>');
  assert.equal(
    redactRedisUrl('redis://:s3cr3tPass!@redis-internal.local:6379/2'),
    'redis://:***@redis-internal.local:6379/2',
  );
  assert.equal(
    redactRedisUrl('rediss://default:TopSecretToken_99@upstash.example.io:6380?password=abc'),
    'rediss://***:***@upstash.example.io:6380?password=***',
  );
  assert.equal(
    redactRedisUrl('redis://svc:MyPass@not-a-valid[host'),
    'redis://***:***@not-a-valid[host',
  );
  assert.equal(
    redactEndpointUrl('https://deploy:token_xyz@node-a.example.com:3001?secret=1'),
    'https://***:***@node-a.example.com:3001',
  );
  assert.equal(
    scrubUrlsInText('Failed reaching http://u:secret42@127.0.0.1:3001/health today'),
    'Failed reaching http://***:***@127.0.0.1:3001/health today',
  );
});

test('empty REDIS_URL keeps pure single-instance mode without instantiating any Redis client', async () => {
  let factoryCalls = 0;
  const scaleState = createScaleState('solo-node', 'single');
  const log = createMemoryLogger();

  const handle = await connectRedis({
    url: '   ',
    scaleState,
    logger: log,
    clientFactory: () => {
      factoryCalls += 1;
      throw new Error('must never construct a Redis client when REDIS_URL is empty');
    },
  });

  assert.equal(factoryCalls, 0);
  assert.equal(handle.enabled, false);
  assert.equal(handle.fallback, false);
  assert.equal(scaleState.mode, 'single');
  assert.equal(log.entries.length, 0);
});

test('unreachable REDIS_URL at boot logs ONE loud redacted warning, never loops, and falls back to working single-instance mode', async (t) => {
  const unusedPort = await getFreePort();
  const secret = 'UltraSecretPassword_NeverLogMe!';
  const memLog = createMemoryLogger();
  const backing = createSharedClusterBacking();

  const node = await startClusterNode({
    instanceId: 'fallback-node-1',
    redisUrl: `redis://admin:${secret}@127.0.0.1:${unusedPort}/0`,
    connectTimeoutMs: 300,
    backing,
    logger: memLog,
  });
  t.after(() => node.close());

  // 1. Check warning count, absence of credentials, and zero background reconnect loops
  const redisWarnings = memLog.entries.filter(
    (e) => e.level === 'warn' && e.scope.includes('redis'),
  );
  assert.equal(redisWarnings.length, 1, 'logs a single loud warning on unreachable Redis at boot');
  await delay(250);
  assert.equal(
    memLog.entries.filter((e) => e.level === 'warn' && e.scope.includes('redis')).length,
    1,
    'does not loop reconnection warnings after boot fallback',
  );
  for (const entry of memLog.entries) {
    assert.equal(entry.text.includes(secret), false, `log leaked secret: ${entry.text}`);
  }

  // 2. /health reports single-instance fallback cleanly
  const health = await (await fetch(`${node.baseUrl}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.instanceId, 'fallback-node-1');
  assert.equal(health.scaleMode, 'single');

  // 3. Single-instance proximity & signaling work end-to-end
  const c1 = await connectTestClient(node.baseUrl);
  const c2 = await connectTestClient(node.baseUrl);
  t.after(() => {
    c1.close();
    c2.close();
  });

  const j1 = waitEvent(c1, 'joined');
  c1.emit('join', { roomId: 'lobby', name: 'LocalOne' });
  await j1;

  const j2 = waitEvent(c2, 'joined');
  c2.emit('join', { roomId: 'lobby', name: 'LocalTwo' });
  const joined2 = await j2;

  const p1 = waitEvent(c1, 'peer:connect');
  const p2 = waitEvent(c2, 'peer:connect');
  c1.emit('move', { x: 400, y: 400 });
  c2.emit('move', { x: 440, y: 400 });
  const [edge1, edge2] = await Promise.all([p1, p2]);
  assert.equal(edge1.generation, 1);
  assert.equal(edge2.generation, 1);
  assert.notEqual(edge1.initiator, edge2.initiator);

  const sig = waitEvent(c2, 'signal');
  c1.emit('signal', {
    to: joined2.selfId,
    generation: 1,
    data: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' },
  });
  assert.equal((await sig).data.type, 'offer');
});

test('rediss:// connects over real TLS 1.3 and executes atomic RedisEdgeStore operations cleanly', { skip: skipWithoutRedis }, async (t) => {
  const targetPort = Number(new URL(REDIS_URL_TEST).port || 6379);
  const tunnel = await startRedisTlsTunnel(targetPort);

  const backing = createSharedClusterBacking();
  const node = await startClusterNode({
    instanceId: 'tls-node-1',
    redisUrl: tunnel.url,
    keyPrefix: `tls_${process.pid}`,
    tlsOptions: { ca: tunnel.caCert },
    backing,
  });
  t.after(async () => {
    await node.close();
    await tunnel.close();
  });

  const health = await (await fetch(`${node.baseUrl}/health`)).json();
  assert.equal(health.scaleMode, 'redis');

  const created = await node.io.edgeStore.createEdge('lobby', 'tls_alice', 'tls_bob');
  assert.deepEqual(created, { created: true, generation: 1 });
  const removed = await node.io.edgeStore.removeUser('tls_alice');
  assert.equal(removed.length, 1);
  assert.equal(await node.io.edgeStore.countStoreKeys(), 0);
});

test('mid-run Redis kill enters "redis-degraded", never drops sockets, and automatically reconciles missed edges on Redis restart', { skip: skipWithoutRedis }, async (t) => {
  const redisPort = await getFreePort();
  let redisDaemon = await spawnEphemeralRedisServer(redisPort);

  const backing = createSharedClusterBacking();
  const keyPrefix = `outage_${process.pid}`;
  const nodeA = await startClusterNode({
    instanceId: 'outage-a',
    redisUrl: `redis://127.0.0.1:${redisPort}`,
    keyPrefix,
    backing,
  });
  const nodeB = await startClusterNode({
    instanceId: 'outage-b',
    redisUrl: `redis://127.0.0.1:${redisPort}`,
    keyPrefix,
    backing,
  });
  t.after(async () => {
    await nodeA.close();
    await nodeB.close();
    await redisDaemon.killHard().catch(() => {});
  });

  const alice = await connectTestClient(nodeA.baseUrl);
  const carol = await connectTestClient(nodeA.baseUrl);
  const bob = await connectTestClient(nodeB.baseUrl);
  const dan = await connectTestClient(nodeB.baseUrl);
  t.after(() => {
    for (const s of [alice, carol, bob, dan]) s.close();
  });

  let anyDisconnected = false;
  for (const s of [alice, carol, bob, dan]) {
    s.on('disconnect', () => {
      anyDisconnected = true;
    });
  }

  // Join all 4 users
  const [jAlice, jCarol, jBob, jDan] = await Promise.all([
    (alice.emit('join', { roomId: 'lobby', name: 'Alice' }), waitEvent(alice, 'joined')),
    (carol.emit('join', { roomId: 'lobby', name: 'Carol' }), waitEvent(carol, 'joined')),
    (bob.emit('join', { roomId: 'lobby', name: 'Bob' }), waitEvent(bob, 'joined')),
    (dan.emit('join', { roomId: 'lobby', name: 'Dan' }), waitEvent(dan, 'joined')),
  ]);

  // Alice & Bob start close together (edge established BEFORE outage);
  // Carol & Dan start far apart (900 px apart).
  const abConnect = Promise.all([
    waitEvent(alice, 'peer:connect', (c) => c.peerId === jBob.selfId),
    waitEvent(bob, 'peer:connect', (c) => c.peerId === jAlice.selfId),
  ]);
  alice.emit('move', { x: 100, y: 100 });
  bob.emit('move', { x: 140, y: 100 });
  carol.emit('move', { x: 100, y: 800 });
  dan.emit('move', { x: 1000, y: 800 });
  await abConnect;
  await delay(80);

  const carolConnects = [];
  const danConnects = [];
  carol.on('peer:connect', (e) => {
    if (e.peerId === jDan.selfId) carolConnects.push(e);
  });
  dan.on('peer:connect', (e) => {
    if (e.peerId === jCarol.selfId) danConnects.push(e);
  });

  // KILL REDIS MID-RUN!
  await redisDaemon.killHard();

  // Wait for both nodes' cached /health liveness to transition to "redis-degraded"
  const degradeDeadline = Date.now() + 3000;
  let healthA;
  let healthB;
  while (Date.now() < degradeDeadline) {
    // eslint-disable-next-line no-await-in-loop
    healthA = await (await fetch(`${nodeA.baseUrl}/health`)).json();
    // eslint-disable-next-line no-await-in-loop
    healthB = await (await fetch(`${nodeB.baseUrl}/health`)).json();
    if (healthA.scaleMode === 'redis-degraded' && healthB.scaleMode === 'redis-degraded') break;
    // eslint-disable-next-line no-await-in-loop
    await delay(40);
  }
  assert.equal(healthA.status, 'ok', '/health stays 200 ok when Redis is down');
  assert.equal(healthA.scaleMode, 'redis-degraded');
  assert.equal(healthB.scaleMode, 'redis-degraded');

  // Move Carol & Dan within 40 px WHILE Redis is completely dead:
  // neither server crashes, no socket drops, and no partial edge forms yet.
  carol.emit('move', { x: 500, y: 800 });
  dan.emit('move', { x: 540, y: 800 });
  await delay(150);
  assert.equal(anyDisconnected, false, 'zero sockets disconnect during Redis outage');
  assert.equal(carolConnects.length, 0, 'no cross-instance edge formed while Redis is dead');
  assert.equal(danConnects.length, 0);

  // RESTART REDIS ON THE SAME PORT -> automatic reconnect + reconcileLocalUsers()!
  const reconciledConnect = Promise.all([
    waitEvent(carol, 'peer:connect', (c) => c.peerId === jDan.selfId, 6000),
    waitEvent(dan, 'peer:connect', (c) => c.peerId === jCarol.selfId, 6000),
  ]);
  redisDaemon = await spawnEphemeralRedisServer(redisPort);

  const [cEdge, dEdge] = await reconciledConnect;
  await delay(100);

  assert.equal(anyDisconnected, false, 'zero sockets disconnected across outage + recovery');
  assert.equal(carolConnects.length, 1, 'reconcile emitted peer:connect once to Carol');
  assert.equal(danConnects.length, 1, 'reconcile emitted peer:connect once to Dan');
  assert.equal(cEdge.generation, dEdge.generation);
  assert.notEqual(cEdge.initiator, dEdge.initiator);

  const recoveredA = await (await fetch(`${nodeA.baseUrl}/health`)).json();
  const recoveredB = await (await fetch(`${nodeB.baseUrl}/health`)).json();
  assert.equal(recoveredA.scaleMode, 'redis');
  assert.equal(recoveredB.scaleMode, 'redis');
});
